//! Lists (`@paginated`, PROTOCOL.md 10): pages fetched as needed, following `nextCursor` to the last page, or one page.

use std::collections::VecDeque;

use crate::request::{BoxFuture, CallOptions};

type Fetch<P, Er> = Box<dyn FnMut(Option<String>, CallOptions) -> BoxFuture<'static, Result<(P, Option<String>), Er>> + Send>;

/// The pages of a list, from the starting cursor (normally none) to the last page.
pub struct Pages<P, Er> {
    fetch: Fetch<P, Er>,
    cursor: Option<String>,
    opts: CallOptions,
    started: bool,
    done: bool,
}

impl<P, Er> Pages<P, Er> {
    /// `fetch` gets one page for a cursor and returns it with the next cursor.
    pub fn new(
        start: Option<String>,
        fetch: impl FnMut(Option<String>, CallOptions) -> BoxFuture<'static, Result<(P, Option<String>), Er>> + Send + 'static,
    ) -> Self {
        Pages {
            fetch: Box::new(fetch),
            cursor: start,
            opts: CallOptions::default(),
            started: false,
            done: false,
        }
    }

    /// Call options for every page request (cancellation, typically).
    pub fn options(mut self, opts: CallOptions) -> Self {
        self.opts = opts;
        self
    }

    /// The next page, or `None` after the last one. An error ends the list.
    pub async fn next(&mut self) -> Option<Result<P, Er>> {
        if self.done {
            return None;
        }
        self.started = true;
        match (self.fetch)(self.cursor.take(), self.opts.clone()).await {
            Ok((page, next)) => {
                match next.filter(|c| !c.is_empty()) {
                    Some(c) => self.cursor = Some(c),
                    None => self.done = true,
                }
                Some(Ok(page))
            }
            Err(e) => {
                self.done = true;
                Some(Err(e))
            }
        }
    }

    /// The first page, from the starting cursor: exactly one request. `None` only if the list gave no page, which a
    /// list never does.
    pub async fn first(mut self) -> Option<Result<P, Er>> {
        self.next().await
    }

    /// Every page.
    pub async fn collect(mut self) -> Result<Vec<P>, Er> {
        let mut out = Vec::new();
        while let Some(p) = self.next().await {
            out.push(p?);
        }
        Ok(out)
    }
}

/// The items of a list, across pages.
pub struct Items<P, T, Er> {
    pages: Pages<P, Er>,
    items: fn(P) -> Vec<T>,
    buf: VecDeque<T>,
}

impl<P, T, Er> Items<P, T, Er> {
    pub fn new(pages: Pages<P, Er>, items: fn(P) -> Vec<T>) -> Self {
        Items {
            pages,
            items,
            buf: VecDeque::new(),
        }
    }

    /// Call options for every page request.
    pub fn options(mut self, opts: CallOptions) -> Self {
        self.pages = self.pages.options(opts);
        self
    }

    /// The next item, fetching the next page when needed; `None` after the last item.
    pub async fn next(&mut self) -> Option<Result<T, Er>> {
        loop {
            if let Some(t) = self.buf.pop_front() {
                return Some(Ok(t));
            }
            match self.pages.next().await? {
                Ok(p) => self.buf.extend((self.items)(p)),
                Err(e) => return Some(Err(e)),
            }
        }
    }

    /// Every item.
    pub async fn collect(mut self) -> Result<Vec<T>, Er> {
        let mut out = Vec::new();
        while let Some(t) = self.next().await {
            out.push(t?);
        }
        Ok(out)
    }

    /// The pages instead of the items.
    pub fn pages(self) -> Pages<P, Er> {
        self.pages
    }
}

type ReadNext<P, Er> = std::sync::Arc<dyn Fn() -> BoxFuture<'static, Result<P, Er>> + Send + Sync>;

/// How a page of a list reads the page after it (`next_page()`, PROTOCOL.md 10): the same request from the page's
/// `next_cursor`. Empty on the last page and on a page built in code. It is never serialised, and pages compare equal
/// whatever it holds.
pub struct NextPage<P, Er>(Option<ReadNext<P, Er>>);

impl<P, Er> NextPage<P, Er> {
    /// `read` makes the one request for the next page.
    pub fn new(read: impl Fn() -> BoxFuture<'static, Result<P, Er>> + Send + Sync + 'static) -> Self {
        NextPage(Some(std::sync::Arc::new(read)))
    }

    /// The next page, or `None` when there is no way to it (the last page, or a page built in code).
    pub async fn read(&self) -> Option<Result<P, Er>> {
        match &self.0 {
            Some(read) => Some(read().await),
            None => None,
        }
    }
}

impl<P, Er> Default for NextPage<P, Er> {
    fn default() -> Self {
        NextPage(None)
    }
}

impl<P, Er> Clone for NextPage<P, Er> {
    fn clone(&self) -> Self {
        NextPage(self.0.clone())
    }
}

impl<P, Er> std::fmt::Debug for NextPage<P, Er> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(if self.0.is_some() { "NextPage(..)" } else { "NextPage(None)" })
    }
}

impl<P, Er> PartialEq for NextPage<P, Er> {
    fn eq(&self, _: &Self) -> bool {
        true
    }
}
