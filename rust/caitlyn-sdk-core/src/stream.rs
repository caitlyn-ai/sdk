//! Server-sent event streams (PROTOCOL.md section 5): typed events, `id:` de-duplication, the final event,
//! failure events as typed errors, and resuming with `Last-Event-ID` after a dropped connection or a clean end
//! before the final event.

use std::collections::HashSet;
use std::pin::Pin;

use bytes::Bytes;
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
        };
        s.attach(resp);
        s
    }

    fn attach(&mut self, resp: Response) {
        self.opened_at = Some(stream_clock());
        self.on_connection = 0;
        self.body = Some(Box::pin(resp.inner.bytes_stream()));
        self.buf.clear();
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
                    if let Err(e) = self.reconnect(cause).await {
                        return self.fail(e);
                    }
                    continue;
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

    async fn reconnect(&mut self, cause: Option<reqwest::Error>) -> Result<(), Error> {
        self.body = None;
        // A connection that stayed open a minute or more starts the count again, like a new event: the server ends every
        // stream within an hour, and a quiet watch must outlive that (PROTOCOL.md 5.6).
        if let Some(opened_at) = self.opened_at.take() {
            if stream_clock().saturating_sub(opened_at) >= LONG_CONNECTION {
                self.attempts = 0;
            }
        }
        let mut cause: Option<Box<dyn std::error::Error + Send + Sync>> = cause.map(|e| Box::new(e) as _);
        loop {
            if self.attempts >= MAX_RECONNECTS {
                return Err(Error::sdk("STREAM_LOST", "The stream was lost and could not be resumed", cause));
            }
            self.reconnects += 1;
            self.attempts += 1;
            let pause = tokio::time::sleep(reconnect_delay(self.attempts));
            match self.cancel.clone() {
                Some(t) => tokio::select! {
                    biased;
                    _ = t.cancelled() => return Err(Error::Cancelled),
                    _ = pause => {}
                },
                None => pause.await,
            }
            let resume = self.spec.resume.as_ref().expect("resume checked by the caller");
            if self.spec.fresh {
                // No cursor: the new connection starts again from a snapshot, whose ids may repeat the last one's.
                self.seen.clear();
                self.last_id = None;
            }
            match resume(self.last_id.clone().unwrap_or_default()).await {
                Ok(resp) => {
                    self.attach(resp);
                    return Ok(());
                }
                Err(Error::Cancelled) => return Err(Error::Cancelled),
                // The thing is gone (PROTOCOL.md 16): the watch ends at once, with no further reconnect.
                Err(e) if e.status() == Some(404) => return Err(e),
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
