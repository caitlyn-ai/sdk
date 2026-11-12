//! The hand-written runtime behind the generated Caitlyn Rust SDK ([`caitlyn-sdk`](https://docs.rs/caitlyn-sdk)).
//!
//! It implements the wire protocol `ai.caitlyn.protocols#restJson` as `model/PROTOCOL.md` describes it: request
//! headers, sign-in, retries, RFC 9457 errors chosen by status, server-sent event streams with resume,
//! pagination, presigned uploads, `@since` checks and `tracing` spans. Generated code describes each operation
//! and calls into this crate; it holds no protocol logic of its own.
//!
//! It reads no AWS configuration (no `AWS_*` variable, no `~/.aws` file, no instance metadata), except in the
//! `awsIam` sign-in mode, which exists to use the caller's AWS identity. Async on tokio; TLS through rustls.
#![forbid(unsafe_code)]

pub mod auth;
pub mod aws;
mod budget;
mod client;
pub mod error;
pub mod paginate;
pub mod raw;
pub mod request;
pub mod stream;
pub mod telemetry;
pub mod time;
mod upload;

pub use auth::{Auth, AuthSession, AuthorizationUrl, Callback, MemoryTokenStore, OAuthTokens, TokenStore};
pub use aws::{AwsCredentialProvider, AwsCredentials, SigningAlgorithm};
pub use client::{compare_versions, workspace_audience, workspace_endpoint, workspace_host, Client, ClientBuilder, SdkInfo};
pub use error::{ApiError, AuthError, ConnectionError, Error, FieldError, InputError, NotSupportedByServer, CONNECTION_ERROR};
pub use paginate::{Items, Pages};
pub use raw::Raw;
pub use request::{path_label, BoxFuture, Call, CallOptions, Operation, Request, Response, ResponseMetadata};
/// The HTTP client the runtime uses, for `ClientBuilder::http_client`.
pub use reqwest;
pub use stream::{Decoded, Stream, StreamSpec};
pub use telemetry::Propagator;
pub use tokio_util::sync::CancellationToken;
pub use upload::UploadFile;

/// Re-exported for generated code.
#[doc(hidden)]
pub mod __private {
    pub use chrono;
    pub use serde;
    pub use serde_json;
}
