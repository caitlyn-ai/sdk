//! Presigned uploads (PROTOCOL.md 10): the file, its SHA-256, and the `PUT` to the presigned URL.

use std::collections::BTreeMap;
use std::path::Path;
use tracing::Instrument;

use base64::Engine as _;
use sha2::{Digest, Sha256};

use crate::client::Client;
use crate::error::Error;
use crate::request::CallOptions;

/// A file for `uploads().create` and `<namespace>().upload`.
#[derive(Clone, Debug)]
pub struct UploadFile {
    pub name: String,
    pub content_type: String,
    pub data: Vec<u8>,
}

impl UploadFile {
    pub fn new(name: impl Into<String>, content_type: impl Into<String>, data: impl Into<Vec<u8>>) -> Self {
        UploadFile {
            name: name.into(),
            content_type: content_type.into(),
            data: data.into(),
        }
    }

    /// Reads a file, taking its content type from the extension.
    pub fn from_path(path: impl AsRef<Path>) -> std::io::Result<Self> {
        let path = path.as_ref();
        let data = std::fs::read(path)?;
        let ext = path.extension().and_then(|e| e.to_str()).unwrap_or_default().to_ascii_lowercase();
        Ok(UploadFile {
            name: path.file_name().and_then(|n| n.to_str()).unwrap_or("file").to_owned(),
            content_type: content_type_for(&ext).to_owned(),
            data,
        })
    }

    /// The base64-encoded SHA-256 of the bytes.
    pub fn sha256(&self) -> String {
        base64::engine::general_purpose::STANDARD.encode(Sha256::digest(&self.data))
    }
}

fn content_type_for(ext: &str) -> &'static str {
    match ext {
        "txt" => "text/plain; charset=utf-8",
        "md" => "text/markdown; charset=utf-8",
        "csv" => "text/csv; charset=utf-8",
        "html" | "htm" => "text/html; charset=utf-8",
        "json" => "application/json",
        "pdf" => "application/pdf",
        "doc" => "application/msword",
        "docx" => "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "pptx" => "application/vnd.openxmlformats-officedocument.presentationml.presentation",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        _ => "application/octet-stream",
    }
}

impl Client {
    /// Sends bytes to a presigned URL with exactly the required headers: no Caitlyn credentials go there.
    pub async fn put_presigned(
        &self,
        method: &str,
        url: &str,
        headers: &BTreeMap<String, String>,
        data: Vec<u8>,
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
        let mut req = self.http().request(method, url).body(data);
        for (k, v) in headers {
            req = req.header(k, v);
        }
        let record = span.clone();
        let send = async {
            let resp = req
                .send()
                .await
                .map_err(|e| fail("The bytes could not be sent", Some(Box::new(e))))?;
            record.record("http.response.status_code", resp.status().as_u16());
            if !resp.status().is_success() {
                return Err(fail(
                    "The upload URL refused the bytes",
                    Some(format!("HTTP {}", resp.status().as_u16()).into()),
                ));
            }
            Ok(())
        };
        let r = tokio::select! {
            biased;
            _ = opts.cancelled() => Err(Error::Cancelled),
            r = send.instrument(span.clone()) => r,
        };
        if let Err(e) = &r {
            crate::telemetry::record_failure(&span, e, &[]);
        }
        r
    }
}
