//! Server-sent event streams (PROTOCOL.md section 5): typed events, `id:` de-duplication, the final event,
//! failure events as typed errors, and resuming with `Last-Event-ID` after a dropped connection or a clean end
//! before the final event.

use std::collections::HashSet;
use std::pin::Pin;

use bytes::Bytes;
use futures_util::{Stream as FutStream, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::error::{problem_from_body, Error};
use crate::request::{BoxFuture, Response};

const MAX_RECONNECTS: u32 = 3;

/// What a generated decoder makes of one SSE event.
pub enum Decoded<E> {
    Event(E),
    /// The union's failure member (`message.failed`): the runtime raises its problem as a typed error.
    Failure,
    /// An event name this SDK does not know: skipped.
    Skip,
}

/// Reopens a stream from the event after `last_event_id` (the model's `resumeWith` operation).
pub type Resume = Box<dyn Fn(String) -> BoxFuture<'static, Result<Response, Error>> + Send + Sync>;

/// Decodes one SSE event: its name, its `id:` and its `data:`.
pub type DecodeFn<E> = fn(name: &str, id: Option<&str>, data: &[u8]) -> Result<Decoded<E>, serde_json::Error>;

/// How a generated stream decodes its events. Generated code fills one in per operation.
pub struct StreamSpec<E, F, Er> {
    pub decode: DecodeFn<E>,
    /// The final event's single member, when `ev` is the final event.
    pub final_of: Option<fn(&E) -> Option<F>>,
    /// Maps runtime errors to the generated crate's typed errors.
    pub map_err: fn(Error) -> Er,
    pub resume: Option<Resume>,
}

type Body = Pin<Box<dyn FutStream<Item = Result<Bytes, reqwest::Error>> + Send>>;

/// A stream of typed events. Call [`Stream::next`] until it returns `None`, or [`Stream::final_message`].
/// Dropping it closes the connection.
pub struct Stream<E, F, Er> {
    spec: StreamSpec<E, F, Er>,
    body: Option<Body>,
    buf: Vec<u8>,
    cancel: Option<CancellationToken>,
    seen: HashSet<String>,
    last_id: Option<String>,
    reconnects: u32,
    final_: Option<F>,
    done: bool,
    request_id: Option<String>,
    api_version: Option<String>,
    /// SSE events (known or not) the current response has carried.
    on_response: usize,
}

impl<E, F, Er> std::fmt::Debug for Stream<E, F, Er> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Stream")
            .field("request_id", &self.request_id)
            .field("done", &self.done)
            .finish_non_exhaustive()
    }
}

impl<E, F: Clone, Er> Stream<E, F, Er> {
    /// Opens a stream over a 2xx `text/event-stream` response.
    pub fn open(resp: Response, spec: StreamSpec<E, F, Er>) -> Self {
        let request_id = resp.header("caitlyn-request-id");
        let api_version = resp.header("caitlyn-api-version");
        let cancel = resp.cancel.clone();
        let mut s = Stream {
            spec,
            body: None,
            buf: Vec::new(),
            cancel,
            seen: HashSet::new(),
            last_id: None,
            reconnects: 0,
            final_: None,
            done: false,
            request_id,
            api_version,
            on_response: 0,
        };
        s.attach(resp);
        s
    }

    fn attach(&mut self, resp: Response) {
        self.body = Some(Box::pin(resp.inner.bytes_stream()));
        self.buf.clear();
        self.on_response = 0;
    }

    /// The first response's `Caitlyn-Request-Id`.
    pub fn request_id(&self) -> Option<&str> {
        self.request_id.as_deref()
    }

    /// The first response's `Caitlyn-Api-Version`.
    pub fn api_version(&self) -> Option<&str> {
        self.api_version.as_deref()
    }

    /// Closes the connection. Later calls to `next` return `None`.
    pub fn close(&mut self) {
        self.done = true;
        self.body = None;
    }

    fn fail(&mut self, e: Error) -> Option<Result<E, Er>> {
        self.close();
        Some(Err((self.spec.map_err)(e)))
    }

    /// The next event, `None` at the end of the stream, or the error that ended it (a failure event, a
    /// connection that could not be resumed, cancellation).
    pub async fn next(&mut self) -> Option<Result<E, Er>> {
        loop {
            if self.done {
                return None;
            }
            let read = match self.cancel.clone() {
                Some(t) => {
                    let r = tokio::select! {
                        biased;
                        _ = t.cancelled() => None,
                        r = self.read_event() => Some(r),
                    };
                    match r {
                        Some(r) => r,
                        None => return self.fail(Error::Cancelled),
                    }
                }
                None => self.read_event().await,
            };
            let (name, id, data) = match read {
                Ok(Some(ev)) => ev,
                end => {
                    let cause = end.err();
                    let clean = cause.is_none();
                    // A response that ends cleanly without any event means the answer had already finished: the
                    // stream ends, without an error and without reconnecting (PROTOCOL.md 5.6).
                    if clean && (self.spec.final_of.is_none() || self.final_.is_some() || self.on_response == 0) {
                        self.close();
                        return None;
                    }
                    if self.spec.resume.is_none() {
                        return self.fail(match cause {
                            None => Error::sdk("NO_FINAL_EVENT", "The stream ended without its final event", None),
                            Some(e) => Error::sdk("STREAM_LOST", "The stream was lost", Some(Box::new(e))),
                        });
                    }
                    if let Err(e) = self.reconnect(cause).await {
                        return self.fail(e);
                    }
                    continue;
                }
            };
            self.on_response += 1;
            if let Some(id) = &id {
                if !self.seen.insert(id.clone()) {
                    continue;
                }
                self.last_id = Some(id.clone());
            }
            let name = if name.is_empty() { "message".to_owned() } else { name };
            match (self.spec.decode)(&name, id.as_deref(), &data) {
                Err(e) => return self.fail(Error::sdk("DECODE_FAILED", "An event could not be decoded", Some(Box::new(e)))),
                Ok(Decoded::Skip) => continue,
                Ok(Decoded::Failure) => return self.fail(Error::Api(Box::new(problem_from_body(0, &data)))),
                Ok(Decoded::Event(ev)) => {
                    if let Some(f) = self.spec.final_of.and_then(|final_of| final_of(&ev)) {
                        self.final_ = Some(f);
                        self.close();
                    }
                    return Some(Ok(ev));
                }
            }
        }
    }

    /// Drains the stream if needed and returns the final event's member.
    pub async fn final_message(&mut self) -> Result<F, Er> {
        while let Some(r) = self.next().await {
            r?;
        }
        self.final_
            .clone()
            .ok_or_else(|| (self.spec.map_err)(Error::sdk("NO_FINAL_EVENT", "The stream ended without its final event", None)))
    }

    /// The events as a `futures` stream.
    pub fn into_stream(self) -> impl FutStream<Item = Result<E, Er>> + Send
    where
        E: Send,
        F: Send,
        Er: Send,
    {
        futures_util::stream::unfold(self, |mut s| async move { s.next().await.map(|r| (r, s)) })
    }

    async fn reconnect(&mut self, cause: Option<reqwest::Error>) -> Result<(), Error> {
        self.body = None;
        let mut cause: Option<Box<dyn std::error::Error + Send + Sync>> = cause.map(|e| Box::new(e) as _);
        loop {
            if self.reconnects >= MAX_RECONNECTS {
                return Err(Error::sdk("STREAM_LOST", "The stream was lost and could not be resumed", cause));
            }
            self.reconnects += 1;
            let resume = self.spec.resume.as_ref().expect("resume checked by the caller");
            match resume(self.last_id.clone().unwrap_or_default()).await {
                Ok(resp) => {
                    self.attach(resp);
                    return Ok(());
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                Err(e) => cause = Some(Box::new(e)),
            }
        }
    }

    /// Reads one event: `Ok(None)` at a clean end of stream.
    async fn read_event(&mut self) -> Result<Option<(String, Option<String>, Vec<u8>)>, reqwest::Error> {
        let (mut name, mut id, mut data, mut has_data) = (String::new(), None, Vec::new(), false);
        loop {
            let Some(line) = self.read_line().await? else { return Ok(None) };
            if line.is_empty() {
                if !has_data && name.is_empty() {
                    continue;
                }
                return Ok(Some((name, id, data)));
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f, v.strip_prefix(' ').unwrap_or(v)),
                None => (line.as_str(), ""),
            };
            match field {
                "event" => name = value.to_owned(),
                "data" => {
                    if has_data {
                        data.push(b'\n');
                    }
                    data.extend_from_slice(value.as_bytes());
                    has_data = true;
                }
                "id" => id = Some(value.to_owned()),
                _ => {}
            }
        }
    }

    /// One line without its terminator; `None` at the end of the body (a final unterminated line is dropped,
    /// as an event without its blank line is incomplete).
    async fn read_line(&mut self) -> Result<Option<String>, reqwest::Error> {
        loop {
            if let Some(i) = self.buf.iter().position(|b| *b == b'\n') {
                let mut line: Vec<u8> = self.buf.drain(..=i).collect();
                line.pop();
                if line.last() == Some(&b'\r') {
                    line.pop();
                }
                return Ok(Some(String::from_utf8_lossy(&line).into_owned()));
            }
            let Some(body) = self.body.as_mut() else { return Ok(None) };
            match body.next().await {
                Some(Ok(chunk)) => self.buf.extend_from_slice(&chunk),
                Some(Err(e)) => return Err(e),
                None => return Ok(None),
            }
        }
    }
}
