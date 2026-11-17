//! Files (PROTOCOL.md 14): one [`UploadFile`] for a path, bytes or a reader; its SHA-256 known before anything is
//! sent; a one-shot reader spooled while it is hashed; the 2 GB limit; a path that changes after hashing; the shared
//! content-type table; and the presigned `PUT` (PROTOCOL.md 10), retried as a retry-safe call.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

use base64::Engine as _;
use bytes::Bytes;
use sha2::{Digest, Sha256};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWriteExt};
use tracing::Instrument;

use crate::client::Client;
use crate::error::{Error, InputError};
use crate::request::CallOptions;

/// The largest file the API takes: 2 GB (2,147,483,648 bytes).
pub const MAX_FILE_SIZE: u64 = 2_147_483_648;
/// A one-shot reader is spooled to memory up to this size (8 MiB), and past it to a temporary file.
pub const SPOOL_MEMORY_LIMIT: usize = 8 * 1024 * 1024;
const CHUNK: usize = 64 * 1024;

/// A file for any call that takes one: `core().uploads().send`, an operation's file field (such as
/// `CreateDocumentInput::file`) and `knowledge_bases().ingest`.
///
/// Make one with [`from_path`](Self::from_path), [`from_bytes`](Self::from_bytes) or [`from_reader`](Self::from_reader).
/// The content type comes from [`content_type`](Self::content_type) when you set it, otherwise from the name's
/// extension ([`content_type_for`]). Clones share the source, so a reader is still read only once.
#[derive(Clone)]
pub struct UploadFile {
    name: String,
    content_type: Option<String>,
    hints: Option<serde_json::Value>,
    source: Arc<Source>,
}

enum Source {
    Path(PathBuf),
    Bytes(Bytes),
    Reader(Mutex<Option<Box<dyn AsyncRead + Send + Unpin>>>),
}

impl std::fmt::Debug for UploadFile {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let source = match &*self.source {
            Source::Path(p) => format!("path {}", p.display()),
            Source::Bytes(b) => format!("{} bytes", b.len()),
            Source::Reader(_) => "a reader".to_owned(),
        };
        f.debug_struct("UploadFile")
            .field("name", &self.name)
            .field("content_type", &self.content_type)
            .field("source", &source)
            .finish()
    }
}

/// Two values are equal when they are clones of one file.
impl PartialEq for UploadFile {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.source, &other.source) && self.name == other.name && self.content_type == other.content_type
    }
}

impl UploadFile {
    /// A file on disk, named after its last path component. It fails at once when the path is not a readable file.
    /// The file is hashed with streaming reads when the call runs, and checked again before its bytes are sent.
    pub fn from_path(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref();
        let meta = std::fs::metadata(path)?;
        if !meta.is_file() {
            return Err(std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("{} is not a file", path.display()),
            ));
        }
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
        Ok(UploadFile {
            name,
            content_type: None,
            hints: None,
            source: Arc::new(Source::Path(path.to_path_buf())),
        })
    }

    /// Bytes in memory, with the file name to give them.
    pub fn from_bytes(name: impl Into<String>, data: impl Into<Bytes>) -> Self {
        UploadFile {
            name: name.into(),
            content_type: None,
            hints: None,
            source: Arc::new(Source::Bytes(data.into())),
        }
    }

    /// A reader that can be read once (a download, a pipe), with the file name to give it. It is copied while it is
    /// hashed: into memory up to 8 MiB, past that into a temporary file only its owner can read, deleted when the
    /// call ends. Its size is counted as it is read.
    pub fn from_reader(name: impl Into<String>, reader: impl AsyncRead + Send + Unpin + 'static) -> Self {
        UploadFile {
            name: name.into(),
            content_type: None,
            hints: None,
            source: Arc::new(Source::Reader(Mutex::new(Some(Box::new(reader))))),
        }
    }

    /// Sets the content type, instead of the one the name's extension gives.
    pub fn content_type(mut self, content_type: impl Into<String>) -> Self {
        self.content_type = Some(content_type.into());
        self
    }

    /// Hints about the file (an `IngestionHints`: its pages, text, graphic and scanned pages, media seconds…) that an
    /// estimate sends as the file's `hints`, to price it more closely. Upload and ingestion never send them; a file
    /// with none is estimated from its name, content type and size alone.
    pub fn hints(mut self, hints: impl serde::Serialize) -> Self {
        self.hints = serde_json::to_value(hints)
            .ok()
            .filter(|v| v.as_object().is_some_and(|o| !o.is_empty()));
        self
    }

    /// The hints set with [`hints`](Self::hints), as JSON.
    pub fn hints_json(&self) -> Option<&serde_json::Value> {
        self.hints.as_ref()
    }

    /// Sets the file name.
    pub fn name(mut self, name: impl Into<String>) -> Self {
        self.name = name.into();
        self
    }

    /// The file name sent with the file.
    pub fn file_name(&self) -> &str {
        &self.name
    }

    /// The content type sent with the file: the one set, or the one the name's extension gives.
    pub fn resolved_content_type(&self) -> String {
        self.content_type.clone().unwrap_or_else(|| content_type_for(&self.name).to_owned())
    }

    /// The path, for a file made with [`from_path`](Self::from_path).
    pub fn path(&self) -> Option<&Path> {
        match &*self.source {
            Source::Path(p) => Some(p),
            _ => None,
        }
    }
}

impl UploadFile {
    /// A file on disk, checked only when the call reads it (an unreadable path fails the call with
    /// `FILE_UNREADABLE`). This is what a path given in place of a file becomes.
    pub fn path_unchecked(path: impl Into<PathBuf>) -> Self {
        let path = path.into();
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned();
        UploadFile {
            name,
            content_type: None,
            hints: None,
            source: Arc::new(Source::Path(path)),
        }
    }
}

/// A path, wherever a file is taken (`kb.documents().create("./leave-policy.pdf")`).
impl From<&str> for UploadFile {
    fn from(path: &str) -> Self {
        UploadFile::path_unchecked(path)
    }
}

impl From<String> for UploadFile {
    fn from(path: String) -> Self {
        UploadFile::path_unchecked(path)
    }
}

impl From<&Path> for UploadFile {
    fn from(path: &Path) -> Self {
        UploadFile::path_unchecked(path)
    }
}

impl From<PathBuf> for UploadFile {
    fn from(path: PathBuf) -> Self {
        UploadFile::path_unchecked(path)
    }
}

impl From<&PathBuf> for UploadFile {
    fn from(path: &PathBuf) -> Self {
        UploadFile::path_unchecked(path.clone())
    }
}

/// Bytes with the file name to give them: `("notes.md", bytes)`.
impl<N: Into<String>> From<(N, Vec<u8>)> for UploadFile {
    fn from((name, data): (N, Vec<u8>)) -> Self {
        UploadFile::from_bytes(name, data)
    }
}

impl<N: Into<String>> From<(N, Bytes)> for UploadFile {
    fn from((name, data): (N, Bytes)) -> Self {
        UploadFile::from_bytes(name, data)
    }
}

impl<N: Into<String>> From<(N, &'static [u8])> for UploadFile {
    fn from((name, data): (N, &'static [u8])) -> Self {
        UploadFile::from_bytes(name, data)
    }
}

/// The content type for a file name, from its extension, by the table every Caitlyn SDK shares (PROTOCOL.md 14);
/// `application/octet-stream` for an extension not in it.
pub fn content_type_for(name: &str) -> &'static str {
    let ext = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    match ext.as_str() {
        "csv" => "text/csv",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "eml" => "message/rfc822",
        "flac" => "audio/flac",
        "gif" => "image/gif",
        "htm" => "text/html",
        "html" => "text/html",
        "jpeg" => "image/jpeg",
        "jpg" => "image/jpeg",
        "json" => "application/json",
        "m4a" => "audio/mp4",
        "markdown" => "text/markdown",
        "md" => "text/markdown",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "mp4" => "video/mp4",
        "odt" => "application/vnd.oasis.opendocument.text",
        "ogg" => "audio/ogg",
        "pdf" => "application/pdf",
        "png" => "image/png",
        "ppt" => "application/vnd.ms-powerpoint",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "rtf" => "application/rtf",
        "svg" => "image/svg+xml",
        "tif" => "image/tiff",
        "tiff" => "image/tiff",
        "txt" => "text/plain",
        "wav" => "audio/wav",
        "webm" => "video/webm",
        "webp" => "image/webp",
        "xls" => "application/vnd.ms-excel",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "xml" => "application/xml",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// The SHA-256 as standard base64, as bodies and headers carry it (44 characters, with `=`).
pub fn sha256_base64(digest: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(digest)
}

/// A standard-base64 SHA-256 in its URL-safe form, for object keys: `-` and `_` for `+` and `/`, no padding.
pub fn sha256_url_safe(standard: &str) -> String {
    standard.trim_end_matches('=').replace('+', "-").replace('/', "_")
}

/// A file read and hashed, ready to send: its name, content type, size and SHA-256, and where its bytes are. A
/// spooled copy on disk is deleted when this is dropped, so it lives exactly as long as the call.
#[derive(Debug)]
pub struct PreparedFile {
    name: String,
    content_type: String,
    size: u64,
    sha256: String,
    body: Body,
}

#[derive(Debug)]
enum Body {
    Path {
        path: PathBuf,
        len: u64,
        modified: Option<SystemTime>,
    },
    Memory(Bytes),
    Spooled(SpoolFile),
}

/// A temporary file readable only by its owner, removed when dropped.
#[derive(Debug)]
struct SpoolFile {
    path: PathBuf,
}

impl Drop for SpoolFile {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

impl SpoolFile {
    async fn create(dir: &Path) -> std::io::Result<(SpoolFile, tokio::fs::File)> {
        for _ in 0..8 {
            let path = dir.join(format!("caitlyn-upload-{}.part", uuid::Uuid::new_v4()));
            let mut o = std::fs::OpenOptions::new();
            o.write(true).read(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                o.mode(0o600);
            }
            match o.open(&path) {
                Ok(f) => return Ok((SpoolFile { path }, tokio::fs::File::from_std(f))),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e),
            }
        }
        Err(std::io::Error::new(
            std::io::ErrorKind::AlreadyExists,
            "no free temporary file name",
        ))
    }
}

fn too_large(name: &str, size: Option<u64>) -> Error {
    let what = match size {
        Some(s) => format!("{name} is {s} bytes; files are at most 2 GB (2,147,483,648 bytes)"),
        None => format!("{name} is larger than 2 GB (2,147,483,648 bytes), the most a file may be"),
    };
    Error::sdk("FILE_TOO_LARGE", &what, None)
}

fn unreadable(name: &str, e: std::io::Error) -> Error {
    Error::sdk("FILE_UNREADABLE", &format!("{name} could not be read"), Some(Box::new(e)))
}

impl PreparedFile {
    pub fn name(&self) -> &str {
        &self.name
    }

    pub fn content_type(&self) -> &str {
        &self.content_type
    }

    /// The size in bytes.
    pub fn size(&self) -> u64 {
        self.size
    }

    /// The SHA-256 as standard base64.
    pub fn sha256(&self) -> &str {
        &self.sha256
    }

    /// The SHA-256 as URL-safe base64 without padding, for object keys.
    pub fn sha256_url_safe(&self) -> String {
        sha256_url_safe(&self.sha256)
    }

    /// Reads and hashes `file`. Paths and readers are read in chunks, never whole; a reader is spooled.
    pub async fn read(file: &UploadFile, spool_dir: &Path) -> Result<PreparedFile, Error> {
        Self::read_inner(file, spool_dir, true).await
    }

    /// Makes `file` ready to send without hashing it, with the SHA-256 the batch item already carries
    /// (`batch.upload`, PROTOCOL.md 15): a path's size is its metadata's and it is read only when sent; bytes are
    /// used as they are; a reader is spooled, as `read` does, to count its size.
    pub async fn unhashed(file: &UploadFile, spool_dir: &Path, sha256: String) -> Result<PreparedFile, Error> {
        let mut p = Self::read_inner(file, spool_dir, false).await?;
        p.sha256 = sha256;
        Ok(p)
    }

    async fn read_inner(file: &UploadFile, spool_dir: &Path, hash: bool) -> Result<PreparedFile, Error> {
        let content_type = file.resolved_content_type();
        let name = file.name.clone();
        match &*file.source {
            Source::Bytes(b) => {
                if b.len() as u64 > MAX_FILE_SIZE {
                    return Err(too_large(&name, Some(b.len() as u64)));
                }
                Ok(PreparedFile {
                    sha256: if hash { sha256_base64(&Sha256::digest(b)) } else { String::new() },
                    size: b.len() as u64,
                    name,
                    content_type,
                    body: Body::Memory(b.clone()),
                })
            }
            Source::Path(path) => {
                let meta = tokio::fs::metadata(path).await.map_err(|e| unreadable(&name, e))?;
                if meta.len() > MAX_FILE_SIZE {
                    return Err(too_large(&name, Some(meta.len())));
                }
                if !hash {
                    return Ok(PreparedFile {
                        name,
                        content_type,
                        size: meta.len(),
                        sha256: String::new(),
                        body: Body::Path {
                            path: path.clone(),
                            len: meta.len(),
                            modified: meta.modified().ok(),
                        },
                    });
                }
                let mut f = tokio::fs::File::open(path).await.map_err(|e| unreadable(&name, e))?;
                let mut hasher = Sha256::new();
                let mut buf = vec![0u8; CHUNK];
                let mut size = 0u64;
                loop {
                    let n = f.read(&mut buf).await.map_err(|e| unreadable(&name, e))?;
                    if n == 0 {
                        break;
                    }
                    size += n as u64;
                    hasher.update(&buf[..n]);
                }
                let prepared = PreparedFile {
                    name,
                    content_type,
                    size,
                    sha256: sha256_base64(&hasher.finalize()),
                    body: Body::Path {
                        path: path.clone(),
                        len: meta.len(),
                        modified: meta.modified().ok(),
                    },
                };
                // A file that grew or shrank while it was read is caught here, before any request.
                prepared.check_unchanged().await?;
                if size != meta.len() {
                    return Err(changed(&prepared.name));
                }
                Ok(prepared)
            }
            Source::Reader(slot) => {
                let reader = slot.lock().expect("upload reader lock").take();
                let Some(mut reader) = reader else {
                    return Err(Error::Input(InputError {
                        operation: "UploadFile".to_owned(),
                        member: name,
                        reason: "is a reader that was already read; make a new UploadFile for each call".to_owned(),
                    }));
                };
                let mut hasher = Sha256::new();
                let mut memory: Vec<u8> = Vec::new();
                let mut spool: Option<(SpoolFile, tokio::fs::File)> = None;
                let mut buf = vec![0u8; CHUNK];
                let mut size = 0u64;
                loop {
                    let n = reader.read(&mut buf).await.map_err(|e| unreadable(&name, e))?;
                    if n == 0 {
                        break;
                    }
                    size += n as u64;
                    if size > MAX_FILE_SIZE {
                        return Err(too_large(&name, None));
                    }
                    if hash {
                        hasher.update(&buf[..n]);
                    }
                    match &mut spool {
                        Some((_, f)) => f.write_all(&buf[..n]).await.map_err(|e| unreadable(&name, e))?,
                        None if memory.len() + n <= SPOOL_MEMORY_LIMIT => memory.extend_from_slice(&buf[..n]),
                        None => {
                            let (sf, mut f) = SpoolFile::create(spool_dir).await.map_err(|e| unreadable(&name, e))?;
                            f.write_all(&memory).await.map_err(|e| unreadable(&name, e))?;
                            f.write_all(&buf[..n]).await.map_err(|e| unreadable(&name, e))?;
                            memory = Vec::new();
                            spool = Some((sf, f));
                        }
                    }
                }
                let body = match spool {
                    Some((sf, mut f)) => {
                        f.flush().await.map_err(|e| unreadable(&name, e))?;
                        drop(f);
                        Body::Spooled(sf)
                    }
                    None => Body::Memory(Bytes::from(memory)),
                };
                Ok(PreparedFile {
                    name,
                    content_type,
                    size,
                    sha256: sha256_base64(&hasher.finalize()),
                    body,
                })
            }
        }
    }

    /// For a path: fails with `FILE_CHANGED` when its size or modification time is not what it was when it was
    /// hashed (PROTOCOL.md 14). Other sources cannot change.
    pub async fn check_unchanged(&self) -> Result<(), Error> {
        if let Body::Path { path, len, modified } = &self.body {
            let now = tokio::fs::metadata(path).await.map_err(|_| changed(&self.name))?;
            if now.len() != *len || now.modified().ok() != *modified {
                return Err(changed(&self.name));
            }
        }
        Ok(())
    }

    /// The bytes as a request body, read in chunks from disk for a path or a spooled copy.
    pub async fn body(&self) -> Result<reqwest::Body, Error> {
        match &self.body {
            Body::Memory(b) => Ok(reqwest::Body::from(b.clone())),
            Body::Path { path, .. } => self.file_body(path).await,
            Body::Spooled(sf) => self.file_body(&sf.path).await,
        }
    }

    /// The bytes as a stream of chunks, for a body that wraps them (a form upload).
    pub async fn stream(&self) -> Result<futures_util::stream::BoxStream<'static, std::io::Result<Bytes>>, Error> {
        use futures_util::StreamExt;
        match &self.body {
            Body::Memory(b) => Ok(futures_util::stream::once(std::future::ready(Ok(b.clone()))).boxed()),
            Body::Path { path, .. } | Body::Spooled(SpoolFile { path }) => {
                let f = tokio::fs::File::open(path).await.map_err(|e| unreadable(&self.name, e))?;
                Ok(tokio_util::io::ReaderStream::with_capacity(f, CHUNK).boxed())
            }
        }
    }

    async fn file_body(&self, path: &Path) -> Result<reqwest::Body, Error> {
        let f = tokio::fs::File::open(path).await.map_err(|e| unreadable(&self.name, e))?;
        Ok(reqwest::Body::wrap_stream(tokio_util::io::ReaderStream::with_capacity(f, CHUNK)))
    }
}

fn changed(name: &str) -> Error {
    Error::sdk(
        "FILE_CHANGED",
        &format!("{name} changed after it was hashed (its size or modification time is different); nothing more was sent"),
        None,
    )
}

/// What an upload to storage ended with, when it did not succeed.
pub(crate) enum ExternalFailure {
    /// The last response, a status of 300 or above.
    Status(Box<reqwest::Response>),
    /// No response arrived.
    NoResponse(reqwest::Error),
    Other(Error),
}

/// What an estimate is told of a file (PROTOCOL.md 10): its name, content type and size. Nothing is hashed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileDescription {
    pub name: String,
    pub content_type: String,
    pub size: u64,
    /// The caller's hints ([`UploadFile::hints`]), sent as the description's `hints`.
    pub hints: Option<serde_json::Value>,
}

impl FileDescription {
    /// Describes `file` without hashing it: a path's size comes from its metadata and bytes' from their length; a
    /// reader is read to its end, only to count its bytes, and cannot be used again.
    pub async fn of(file: &UploadFile) -> Result<FileDescription, Error> {
        let name = file.name.clone();
        let content_type = file.resolved_content_type();
        let size = match &*file.source {
            Source::Bytes(b) => b.len() as u64,
            Source::Path(path) => tokio::fs::metadata(path).await.map_err(|e| unreadable(&name, e))?.len(),
            Source::Reader(slot) => {
                let reader = slot.lock().expect("upload reader lock").take();
                let Some(mut reader) = reader else {
                    return Err(Error::Input(InputError {
                        operation: "UploadFile".to_owned(),
                        member: name,
                        reason: "is a reader that was already read; make a new UploadFile for each call".to_owned(),
                    }));
                };
                let mut buf = vec![0u8; CHUNK];
                let mut size = 0u64;
                loop {
                    let n = reader.read(&mut buf).await.map_err(|e| unreadable(&name, e))?;
                    if n == 0 {
                        break;
                    }
                    size += n as u64;
                }
                size
            }
        };
        if size > MAX_FILE_SIZE {
            return Err(too_large(&name, Some(size)));
        }
        Ok(FileDescription {
            name,
            content_type,
            size,
            hints: file.hints.clone(),
        })
    }
}

impl Client {
    /// Describes `file` for an estimate (name, content type and size) without hashing it. Cancelling the call stops
    /// the reading of a reader.
    pub async fn describe_file(&self, file: &UploadFile, opts: &CallOptions) -> Result<FileDescription, Error> {
        tokio::select! {
            biased;
            _ = opts.cancelled() => Err(Error::Cancelled),
            r = FileDescription::of(file) => r,
        }
    }

    /// Makes `file` ready to send under a batch item's checksum, without hashing it ([`PreparedFile::unhashed`]).
    pub async fn prepare_unhashed(&self, file: &UploadFile, sha256: String, opts: &CallOptions) -> Result<PreparedFile, Error> {
        let dir = self.spool_dir();
        tokio::select! {
            biased;
            _ = opts.cancelled() => Err(Error::Cancelled),
            r = PreparedFile::unhashed(file, &dir, sha256) => r,
        }
    }

    /// Reads and hashes `file` (PROTOCOL.md 14), spooling a reader into the client's spool directory. Cancelling the
    /// call stops the reading.
    pub async fn prepare_file(&self, file: &UploadFile, opts: &CallOptions) -> Result<PreparedFile, Error> {
        let dir = self.spool_dir();
        tokio::select! {
            biased;
            _ = opts.cancelled() => Err(Error::Cancelled),
            r = PreparedFile::read(file, &dir) => r,
        }
    }

    /// Sends a request to storage (a presigned URL, an upload policy's form), retried as a retry-safe call
    /// (PROTOCOL.md 6.4, 14): at most `max_attempts`, on 429, 503 or no response, after `Retry-After` or the backoff,
    /// paid from the retry budget. `build` makes each attempt's request. A non-success response is returned for the
    /// caller to judge.
    pub(crate) async fn send_to_storage<F, Fut>(&self, build: F, opts: &CallOptions) -> Result<reqwest::Response, ExternalFailure>
    where
        F: Fn() -> Fut,
        Fut: std::future::Future<Output = Result<reqwest::RequestBuilder, Error>>,
    {
        let mut attempt = 0u32;
        let mut last_retry_cost = None;
        loop {
            let rb = build().await.map_err(ExternalFailure::Other)?;
            let sent = tokio::select! {
                biased;
                _ = opts.cancelled() => return Err(ExternalFailure::Other(Error::Cancelled)),
                r = rb.send() => r,
            };
            let (failure, cost, retry_after) = match sent {
                Ok(resp) if resp.status().is_success() => {
                    self.budget().release(last_retry_cost);
                    return Ok(resp);
                }
                Ok(resp) => {
                    let s = resp.status().as_u16();
                    if s != 429 && s != 503 {
                        return Err(ExternalFailure::Status(Box::new(resp)));
                    }
                    let ra = crate::error::header(resp.headers(), "retry-after").and_then(|v| v.trim().parse::<u64>().ok());
                    (ExternalFailure::Status(Box::new(resp)), crate::budget::RETRY_COST, ra)
                }
                Err(e) => (ExternalFailure::NoResponse(e), crate::budget::NO_RESPONSE_RETRY_COST, None),
            };
            if attempt + 1 >= self.max_attempts() {
                return Err(failure);
            }
            let delay = match retry_after {
                Some(s) if Duration::from_secs(s) > self.max_retry_delay() => return Err(failure),
                Some(s) => Duration::from_secs(s),
                None => crate::client::backoff(attempt),
            };
            if !self.budget().acquire(cost) {
                return Err(failure);
            }
            last_retry_cost = Some(cost);
            drop(failure);
            tokio::select! {
                biased;
                _ = opts.cancelled() => return Err(ExternalFailure::Other(Error::Cancelled)),
                _ = tokio::time::sleep(delay) => {}
            }
            attempt += 1;
        }
    }

    /// Sends a prepared file to a presigned URL with exactly the required headers (no Caitlyn credentials go there),
    /// retried as a retry-safe call. A path that changed since it was hashed fails with `FILE_CHANGED` before
    /// anything is sent; bytes the URL does not take, after retries, with `UPLOAD_PUT_FAILED`.
    pub async fn put_presigned(
        &self,
        method: &str,
        url: &str,
        headers: &BTreeMap<String, String>,
        file: &PreparedFile,
        opts: &CallOptions,
    ) -> Result<(), Error> {
        let fail = |title: &str, e: Option<Box<dyn std::error::Error + Send + Sync>>| Error::sdk("UPLOAD_PUT_FAILED", title, e);
        let method = http::Method::from_bytes(if method.is_empty() { b"PUT" } else { method.as_bytes() })
            .map_err(|e| fail("The upload method is not valid", Some(Box::new(e))))?;
        let (server_address, url_full) = crate::telemetry::http_target(url);
        let span = tracing::info_span!(
            "caitlyn.upload",
            otel.name = "caitlyn.upload",
            otel.kind = "client",
            otel.status_code = tracing::field::Empty,
            otel.status_message = tracing::field::Empty,
            http.request.method = method.as_str(),
            server.address = server_address.as_str(),
            url.full = url_full.as_str(),
            http.response.status_code = tracing::field::Empty,
            error.type = tracing::field::Empty,
            caitlyn.error.code = tracing::field::Empty,
        );
        let record = span.clone();
        let send = async {
            let build = || async {
                file.check_unchanged().await?;
                let mut rb = self.http().request(method.clone(), url).body(file.body().await?);
                let mut has_length = false;
                for (k, v) in headers {
                    has_length |= k.eq_ignore_ascii_case("content-length");
                    rb = rb.header(k, v);
                }
                if !has_length {
                    rb = rb.header(http::header::CONTENT_LENGTH, file.size());
                }
                Ok(rb)
            };
            match self.send_to_storage(build, opts).await {
                Ok(resp) => {
                    record.record("http.response.status_code", resp.status().as_u16());
                    Ok(())
                }
                Err(ExternalFailure::Status(resp)) => {
                    record.record("http.response.status_code", resp.status().as_u16());
                    Err(fail(
                        "The upload URL refused the bytes",
                        Some(format!("HTTP {}", resp.status().as_u16()).into()),
                    ))
                }
                Err(ExternalFailure::NoResponse(e)) => Err(fail("The bytes could not be sent", Some(Box::new(e)))),
                Err(ExternalFailure::Other(e)) => Err(e),
            }
        };
        let r = send.instrument(span.clone()).await;
        if let Err(e) = &r {
            crate::telemetry::record_failure(&span, e, &[]);
        }
        r
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_types_come_from_the_shared_table() {
        assert_eq!(content_type_for("a.PDF"), "application/pdf");
        assert_eq!(
            content_type_for("b.docx"),
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        );
        assert_eq!(content_type_for("c.md"), "text/markdown");
        assert_eq!(content_type_for("d.unknown"), "application/octet-stream");
        assert_eq!(content_type_for("noext"), "application/octet-stream");
    }

    #[test]
    fn checksums_have_two_encodings() {
        let std = sha256_base64(&Sha256::digest(b"hello world, this is caitlyn"));
        assert_eq!(std.len(), 44);
        let url = sha256_url_safe(&std);
        assert!(!url.contains(['+', '/', '=']));
        assert_eq!(url.len(), 43);
    }

    #[tokio::test]
    async fn every_source_gives_the_same_hash_and_a_spooled_copy_is_removed() {
        let dir = std::env::temp_dir().join(format!("caitlyn-spool-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let data: Vec<u8> = (0..(SPOOL_MEMORY_LIMIT + 1000)).map(|i| (i % 251) as u8).collect();
        let path = dir.join("big.bin");
        std::fs::write(&path, &data).unwrap();
        let spool = dir.join("spool");
        std::fs::create_dir_all(&spool).unwrap();
        let a = PreparedFile::read(&UploadFile::from_path(&path).unwrap(), &spool).await.unwrap();
        let b = PreparedFile::read(&UploadFile::from_bytes("big.bin", data.clone()), &spool)
            .await
            .unwrap();
        let c = PreparedFile::read(&UploadFile::from_reader("big.bin", std::io::Cursor::new(data.clone())), &spool)
            .await
            .unwrap();
        assert_eq!((a.sha256(), a.size()), (b.sha256(), b.size()));
        assert_eq!((a.sha256(), a.size()), (c.sha256(), c.size()));
        assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 1);
        drop(c);
        assert_eq!(std::fs::read_dir(&spool).unwrap().count(), 0);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

/// One document a message carries (PROTOCOL.md 16, "Attachments"): a file to upload first, or an upload already made.
/// A path, `UploadFile` or a name with bytes is a file; an upload's id must be said with [`Attachment::upload_id`].
#[derive(Debug, Clone, PartialEq)]
pub enum Attachment {
    File(UploadFile),
    Upload(String),
}

impl Attachment {
    /// A file, uploaded before the message is sent.
    pub fn file(file: impl Into<UploadFile>) -> Self {
        Attachment::File(file.into())
    }

    /// An upload the caller already made, reserved for this conversation, sent as it is.
    pub fn upload_id(id: impl Into<String>) -> Self {
        Attachment::Upload(id.into())
    }
}

impl From<UploadFile> for Attachment {
    fn from(f: UploadFile) -> Self {
        Attachment::File(f)
    }
}

impl From<&str> for Attachment {
    fn from(path: &str) -> Self {
        Attachment::File(path.into())
    }
}

impl From<String> for Attachment {
    fn from(path: String) -> Self {
        Attachment::File(path.into())
    }
}

impl From<&Path> for Attachment {
    fn from(path: &Path) -> Self {
        Attachment::File(path.into())
    }
}

impl From<PathBuf> for Attachment {
    fn from(path: PathBuf) -> Self {
        Attachment::File(path.into())
    }
}
