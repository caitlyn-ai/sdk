//! Server-sent event streams (PROTOCOL.md section 5): typed events, `id:` de-duplication, the final event,
//! failure events as typed errors, and resuming with `Last-Event-ID` after a dropped connection or a clean end
//! before the final event.

use std::collections::HashSet;
use std::pin::Pin;
use std::sync::Arc;

use bytes::Bytes;
use chrono::{DateTime, Utc};
use futures_util::{Stream as FutStream, StreamExt};
use tokio_util::sync::CancellationToken;

use crate::client::random_u64;
use crate::error::{problem_from_body, Error};
use crate::request::{BoxFuture, Response};

const MAX_RECONNECTS: u32 = 3;

/// A connection that stayed open at least this long before it ended restarts the reconnect count (PROTOCOL.md 5.6).
pub const LONG_CONNECTION: std::time::Duration = std::time::Duration::from_secs(60);

/// A replacement for the clock that times each connection: a reading in time since any fixed start.
type ClockFn = Box<dyn FnMut() -> std::time::Duration + Send>;
static CLOCK: std::sync::Mutex<Option<ClockFn>> = std::sync::Mutex::new(None);

/// The clock that times each connection, for the rule above: the time since the first reading, unless replaced.
fn stream_clock() -> std::time::Duration {
    static START: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();
    let mut clock = CLOCK.lock().unwrap_or_else(|e| e.into_inner());
    match clock.as_mut() {
        Some(f) => f(),
        None => START.get_or_init(std::time::Instant::now).elapsed(),
    }
}

/// Replaces the clock that times each stream connection, or puts the real one back with `None`. For tests only: the
/// conformance cases step it so that a connection lasts an hour, or under a minute, without waiting.
#[doc(hidden)]
pub fn set_stream_clock(clock: Option<ClockFn>) {
    *CLOCK.lock().unwrap_or_else(|e| e.into_inner()) = clock;
}

/// What a generated decoder makes of one SSE event.
pub enum Decoded<E> {
    Event(E),
    /// The union's failure member (`message.failed`): on a stream with a final event the runtime raises its problem
    /// as a typed error; on a watch it is delivered as the event it carries (PROTOCOL.md 5.5).
    Failure(E),
    /// An event name this SDK does not know: skipped.
    Skip,
}

/// How long after a batch's deadline its watch reads it, if it is still open (PROTOCOL.md 16). Fixed: not an option.
pub const DEADLINE_GRACE: std::time::Duration = std::time::Duration::from_secs(30);

const BATCH_FINAL: &[&str] = &["succeeded", "completed_with_failures", "failed", "cancelled"];

/// A batch's deadline (PROTOCOL.md 16): its `uploadsExpireAt`, while the batch is open. None once it has ended. The one
/// place each stream that reads a batch at its deadline asks.
pub fn batch_deadline(status: &str, uploads_expire_at: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    if BATCH_FINAL.contains(&status) {
        return None;
    }
    uploads_expire_at
}

/// Reads a batch and makes a snapshot event of it, from the snapshot it replaces, if any.
type ReadFn<E, Er> = dyn Fn(Option<E>) -> BoxFuture<'static, Result<E, Er>> + Send + Sync;

/// How a batch's watch reads the batch again once its deadline has passed (PROTOCOL.md 16). Generated code makes one
/// from the batch scope's `get` and the watch's event type; the `sync` helper makes its own for its JSON events.
pub struct Reread<E, Er> {
    /// Reads the batch and makes a snapshot of it: in place of the snapshot given (one that arrived past its due time,
    /// whose jobs and progress it keeps), or with no jobs and no progress.
    read: Arc<ReadFn<E, Er>>,
    /// The deadline an event shows: `None` for an event that does not show the batch, `Some(None)` for a batch with no
    /// deadline (see [`batch_deadline`]).
    deadline: fn(&E) -> Option<Option<DateTime<Utc>>>,
}

impl<E, Er> Reread<E, Er> {
    pub fn new(
        read: impl Fn(Option<E>) -> BoxFuture<'static, Result<E, Er>> + Send + Sync + 'static,
        deadline: fn(&E) -> Option<Option<DateTime<Utc>>>,
    ) -> Self {
        Reread {
            read: Arc::new(read),
            deadline,
        }
    }
}

impl<E, Er> Clone for Reread<E, Er> {
    fn clone(&self) -> Self {
        Reread {
            read: self.read.clone(),
            deadline: self.deadline,
        }
    }
}

impl<E, Er> std::fmt::Debug for Reread<E, Er> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Reread")
    }
}

/// When a batch's read is due, from what was last seen of it; each deadline is read once.
struct Deadline<E, Er> {
    reread: Reread<E, Er>,
    done: HashSet<DateTime<Utc>>,
    deadline: Option<DateTime<Utc>>,
    due: Option<DateTime<Utc>>,
}

impl<E, Er> Deadline<E, Er> {
    fn new(reread: Reread<E, Er>) -> Self {
        Deadline {
            reread,
            done: HashSet::new(),
            deadline: None,
            due: None,
        }
    }

    /// Takes in an event: true when it showed the batch.
    fn see(&mut self, ev: &E) -> bool {
        let Some(deadline) = (self.reread.deadline)(ev) else { return false };
        self.deadline = deadline;
        self.due = self
            .deadline
            .filter(|d| !self.done.contains(d))
            .map(|d| d + chrono::Duration::from_std(DEADLINE_GRACE).unwrap_or_default());
        true
    }

    fn reading(&mut self) {
        if let Some(d) = self.deadline {
            self.done.insert(d);
        }
        self.due = None;
    }

    /// How long until the read is due (zero when it already is), or `None` when none is.
    fn wait(&self) -> Option<std::time::Duration> {
        self.due.map(|due| (due - Utc::now()).to_std().unwrap_or_default())
    }
}

/// Sleeps until the deadline's read is due; never, when none is.
async fn due(wait: Option<std::time::Duration>) {
    match wait {
        Some(d) => tokio::time::sleep(d).await,
        None => std::future::pending().await,
    }
}

/// What a stream's next read came to: an event read, the deadline's read falling due, or cancellation.
enum Next<T> {
    Read(T),
    Due,
    Cancelled,
}

/// The pause before the nth reconnect in a row (PROTOCOL.md 5.6): an exponential backoff with jitter, 0.25-0.5 s,
/// then 0.5-1 s, then 1-2 s, so each pause is longer than the last.
pub fn reconnect_delay(attempt: u32) -> std::time::Duration {
    let ceil_ms: u64 = 500u64.checked_shl(attempt.saturating_sub(1).min(10)).unwrap_or(8_000).min(8_000);
    std::time::Duration::from_millis(ceil_ms / 2 + random_u64() % (ceil_ms / 2 + 1))
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
    /// The stream reconnects with no cursor and starts again from a snapshot (a knowledge base's watch, PROTOCOL.md
    /// 16): each reconnect forgets the ids seen, and only an event after a connection's first counts as progress.
    pub fresh: bool,
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
    /// Reconnects since the last event: at most `MAX_RECONNECTS` in a row (PROTOCOL.md 5.6).
    attempts: u32,
    /// When the current connection's response arrived, on the stream clock; `None` between connections.
    opened_at: Option<std::time::Duration>,
    /// Events read on the current connection.
    on_connection: u32,
    final_: Option<F>,
    done: bool,
    request_id: Option<String>,
    api_version: Option<String>,
    /// A batch's watch: reads the batch again once its deadline has passed (PROTOCOL.md 16).
    deadline: Option<Deadline<E, Er>>,
    /// When the pause before a reconnect ends, while the deadline's read has cut that pause short.
    paused_until: Option<tokio::time::Instant>,
    /// An event's partial lines, kept across reads, so that a read given up for the deadline loses nothing.
    partial: (String, Option<String>, Vec<u8>, bool),
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
            attempts: 0,
            opened_at: None,
            on_connection: 0,
            final_: None,
            done: false,
            request_id,
            api_version,
            deadline: None,
            paused_until: None,
            partial: Default::default(),
        };
        s.attach(resp);
        s
    }

    /// A batch's watch (PROTOCOL.md 16): the server ends a batch whose deadline has passed only when the batch is next
    /// read, so its watch can stay silent. Each time the batch is seen (a snapshot, or a read), the read is due at its
    /// deadline plus [`DEADLINE_GRACE`]; if nothing has shown the batch again by then, `read` is called and its batch
    /// yielded as a `snapshot` with no jobs and no progress. A snapshot that arrives already past its due time has its
    /// batch read at once, and is yielded with the read's batch in its place. A deadline is read once: a read that
    /// returns the same deadline schedules nothing more.
    pub fn reread_at_deadline(&mut self, reread: Reread<E, Er>) {
        self.deadline = Some(Deadline::new(reread));
    }

    fn attach(&mut self, resp: Response) {
        self.opened_at = Some(stream_clock());
        self.on_connection = 0;
        self.body = Some(Box::pin(resp.inner.bytes_stream()));
        self.buf.clear();
        self.partial = Default::default();
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
            let wait = self.deadline.as_ref().and_then(Deadline::wait);
            let next = {
                let cancel = self.cancel.clone();
                let cancelled = async {
                    match &cancel {
                        Some(t) => t.cancelled().await,
                        None => std::future::pending().await,
                    }
                };
                tokio::select! {
                    biased;
                    _ = cancelled => Next::Cancelled,
                    _ = due(wait) => Next::Due,
                    r = self.read_event() => Next::Read(r),
                }
            };
            let read = match next {
                Next::Read(r) => r,
                Next::Cancelled => return self.fail(Error::Cancelled),
                Next::Due => return self.reread(None).await,
            };
            let (name, id, data) = match read {
                Ok(Some(ev)) => ev,
                end => {
                    let cause = end.err();
                    let clean = cause.is_none();
                    // A clean end is the end of a stream that has its final event, or that cannot resume and has
                    // none. Otherwise it reconnects: a proxy cut it short of its final event, or a server shutting
                    // down ended a watch (PROTOCOL.md 5.6, 5.7).
                    if clean && (self.final_.is_some() || (self.spec.resume.is_none() && self.spec.final_of.is_none())) {
                        self.close();
                        return None;
                    }
                    if self.spec.resume.is_none() {
                        return self.fail(match cause {
                            None => Error::sdk("NO_FINAL_EVENT", "The stream ended without its final event", None),
                            Some(e) => Error::sdk("STREAM_LOST", "The stream was lost", Some(Box::new(e))),
                        });
                    }
                    match self.reconnect(cause).await {
                        Ok(true) => continue,
                        // The deadline's read fell due during the pause: the pause carries on at the next call.
                        Ok(false) => return self.reread(None).await,
                        Err(e) => return self.fail(e),
                    }
                }
            };
            if let Some(id) = &id {
                if !self.seen.insert(id.clone()) {
                    continue;
                }
                self.last_id = Some(id.clone());
                if !self.spec.fresh {
                    self.attempts = 0; // only a new event counts as progress (PROTOCOL.md 5.6)
                }
            }
            if self.spec.fresh && self.on_connection > 0 {
                // A connection's first event is its snapshot; what follows it is progress (PROTOCOL.md 16).
                self.attempts = 0;
            }
            self.on_connection += 1;
            let name = if name.is_empty() { "message".to_owned() } else { name };
            match (self.spec.decode)(&name, id.as_deref(), &data) {
                Err(e) => return self.fail(Error::sdk("DECODE_FAILED", "An event could not be decoded", Some(Box::new(e)))),
                Ok(Decoded::Skip) => continue,
                Ok(Decoded::Failure(_)) if self.spec.final_of.is_some() => {
                    return self.fail(Error::Api(Box::new(problem_from_body(0, &data))));
                }
                Ok(Decoded::Failure(ev)) => return Some(Ok(ev)),
                Ok(Decoded::Event(ev)) => {
                    if let Some(d) = self.deadline.as_mut() {
                        if d.see(&ev) && d.wait() == Some(std::time::Duration::ZERO) {
                            return self.reread(Some(ev)).await;
                        }
                    }
                    if let Some(f) = self.spec.final_of.and_then(|final_of| final_of(&ev)) {
                        self.final_ = Some(f);
                        self.close();
                    } else if self.spec.final_of.is_some() && name == "stream.reset" && self.reconnects > 0 {
                        // PROTOCOL.md 5.9: the answer finished while the stream was disconnected, and its final
                        // event went to the earlier connection. The stream ends at the reset, with no error.
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

    /// Reconnects after a pause (PROTOCOL.md 5.6). `Ok(false)`: a batch's deadline read fell due during the pause, which
    /// the next call carries on with, without counting another reconnect.
    async fn reconnect(&mut self, cause: Option<reqwest::Error>) -> Result<bool, Error> {
        if self.paused_until.is_none() {
            self.body = None;
            // A connection that stayed open a minute or more starts the count again, like a new event: the server ends
            // every stream within an hour, and a quiet watch must outlive that (PROTOCOL.md 5.6).
            if let Some(opened_at) = self.opened_at.take() {
                if stream_clock().saturating_sub(opened_at) >= LONG_CONNECTION {
                    self.attempts = 0;
                }
            }
        }
        let mut cause: Option<Box<dyn std::error::Error + Send + Sync>> = cause.map(|e| Box::new(e) as _);
        loop {
            let until = match self.paused_until {
                Some(until) => until,
                None => {
                    if self.attempts >= MAX_RECONNECTS {
                        return Err(Error::sdk("STREAM_LOST", "The stream was lost and could not be resumed", cause));
                    }
                    self.reconnects += 1;
                    self.attempts += 1;
                    let until = tokio::time::Instant::now() + reconnect_delay(self.attempts);
                    self.paused_until = Some(until);
                    until
                }
            };
            let wait = self.deadline.as_ref().and_then(Deadline::wait);
            let cancel = self.cancel.clone();
            let cancelled = async {
                match &cancel {
                    Some(t) => t.cancelled().await,
                    None => std::future::pending().await,
                }
            };
            tokio::select! {
                biased;
                _ = cancelled => return Err(Error::Cancelled),
                _ = due(wait) => return Ok(false),
                _ = tokio::time::sleep_until(until) => {}
            }
            self.paused_until = None;
            let resume = self.spec.resume.as_ref().expect("resume checked by the caller");
            if self.spec.fresh {
                // No cursor: the new connection starts again from a snapshot, whose ids may repeat the last one's.
                self.seen.clear();
                self.last_id = None;
            }
            match resume(self.last_id.clone().unwrap_or_default()).await {
                Ok(resp) => {
                    self.attach(resp);
                    return Ok(true);
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                // The thing is gone (PROTOCOL.md 16): the watch ends at once, with no further reconnect.
                Err(e) if e.status() == Some(404) => return Err(e),
                Err(e) => cause = Some(Box::new(e)),
            }
        }
    }

    /// Reads the batch for its deadline, and returns it as a snapshot: in place of `base` (a snapshot that arrived past
    /// its due time, whose jobs and progress it keeps), or as one of its own, with no jobs and no progress.
    async fn reread(&mut self, base: Option<E>) -> Option<Result<E, Er>> {
        let d = self.deadline.as_mut()?;
        d.reading();
        let read = (d.reread.read)(base);
        let got = match self.cancel.clone() {
            Some(t) => tokio::select! {
                biased;
                _ = t.cancelled() => return self.fail(Error::Cancelled),
                r = read => r,
            },
            None => read.await,
        };
        match got {
            Ok(ev) => {
                if let Some(d) = self.deadline.as_mut() {
                    d.see(&ev);
                }
                Some(Ok(ev))
            }
            Err(e) => {
                self.close();
                Some(Err(e))
            }
        }
    }

    /// Reads one event: `Ok(None)` at a clean end of stream. The lines read so far are kept on the stream, so a read
    /// given up part way (for a batch's deadline) carries on where it stopped.
    async fn read_event(&mut self) -> Result<Option<(String, Option<String>, Vec<u8>)>, reqwest::Error> {
        loop {
            let Some(line) = self.read_line().await? else { return Ok(None) };
            let (name, id, data, has_data) = &mut self.partial;
            if line.is_empty() {
                if !*has_data && name.is_empty() {
                    continue;
                }
                let (name, id, data, _) = std::mem::take(&mut self.partial);
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
                "event" => *name = value.to_owned(),
                "data" => {
                    if *has_data {
                        data.push(b'\n');
                    }
                    data.extend_from_slice(value.as_bytes());
                    *has_data = true;
                }
                "id" => *id = Some(value.to_owned()),
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

/// An event union whose answer arrives as text deltas (the conversation's `text.delta`): the generated crate
/// implements it, and [`Stream::text`] reads only those.
pub trait TextDeltas {
    /// The event's text, when it is a text delta.
    fn text_delta(&self) -> Option<&str>;
}

/// Only the text of an answer, in order: what [`Stream::text`] returns.
pub struct Text<E, F, Er> {
    stream: Stream<E, F, Er>,
}

impl<E: TextDeltas, F: Clone, Er> Text<E, F, Er> {
    /// The next piece of the answer's text, `None` at the answer's end, or the error that ended the stream.
    pub async fn next(&mut self) -> Option<Result<String, Er>> {
        loop {
            match self.stream.next().await? {
                Ok(ev) => {
                    if let Some(t) = ev.text_delta() {
                        return Some(Ok(t.to_owned()));
                    }
                }
                Err(e) => return Some(Err(e)),
            }
        }
    }

    /// The rest of the answer's text, joined.
    pub async fn collect(mut self) -> Result<String, Er> {
        let mut out = String::new();
        while let Some(t) = self.next().await {
            out.push_str(&t?);
        }
        Ok(out)
    }

    /// The final event's member (the complete message), draining the rest of the stream.
    pub async fn final_message(&mut self) -> Result<F, Er> {
        self.stream.final_message().await
    }
}

impl<E: TextDeltas, F: Clone, Er> Stream<E, F, Er> {
    /// Only the answer's text deltas, in order; the stream ends at the answer's end.
    pub fn text(self) -> Text<E, F, Er> {
        Text { stream: self }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(s: &str) -> Option<DateTime<Utc>> {
        DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
    }

    /// A stand-in event: the deadline it shows, if it shows the batch.
    type Ev = Option<Option<DateTime<Utc>>>;

    #[test]
    fn each_deadline_is_read_once() {
        let mut d: Deadline<Ev, Error> = Deadline::new(Reread::new(|_| Box::pin(async { Ok(None) }), |ev| *ev));
        let first = at("2026-11-17T10:00:00Z");
        assert!(d.see(&Some(first)));
        assert_eq!(d.due, first.map(|t| t + chrono::Duration::seconds(30)));
        d.reading();
        // A read that returns the same deadline schedules nothing more.
        d.see(&Some(first));
        assert_eq!(d.due, None);
        // A renewed deadline is read in its turn; an event that does not show the batch changes nothing.
        d.see(&Some(at("2026-11-17T10:30:00Z")));
        assert!(d.due.is_some());
        assert!(!d.see(&None));
        assert!(d.due.is_some());
    }

    #[test]
    fn which_deadline() {
        let u = at("2026-11-17T11:00:00Z");
        assert_eq!(batch_deadline("running", u), u);
        assert_eq!(batch_deadline("running", None), None);
        assert_eq!(batch_deadline("completed_with_failures", u), None);
    }
}
