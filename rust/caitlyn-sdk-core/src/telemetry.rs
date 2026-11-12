//! Telemetry through the `tracing` crate, with the span names and attributes every SDK uses (PROTOCOL.md 13). Each
//! call is a `caitlyn.call` span (`rpc.system`, `rpc.method`, `caitlyn.request_id`; on failure `otel.status_code`,
//! `error.type`, `caitlyn.error.code` and an `exception` event) with one child `caitlyn.attempt` span per HTTP
//! attempt (`http.request.method`, `server.address`, `url.full`, `http.request.resend_count`,
//! `http.response.status_code`, `caitlyn.request_id`, `caitlyn.server.api_version`). An upload's bytes are a
//! `caitlyn.upload` span. With `tracing-opentelemetry` installed, they become OpenTelemetry spans.
//!
//! Trace context (`traceparent`, `tracestate`, `baggage`) is sent only when a [`Propagator`] is configured. With
//! `tracing-opentelemetry`, one is a few lines:
//!
//! ```ignore
//! struct Otel;
//! impl caitlyn_sdk_core::Propagator for Otel {
//!     fn inject(&self, span: &tracing::Span, headers: &mut http::HeaderMap) {
//!         use tracing_opentelemetry::OpenTelemetrySpanExt;
//!         let cx = span.context();
//!         opentelemetry::global::get_text_map_propagator(|p| p.inject_context(&cx, &mut opentelemetry_http::HeaderInjector(headers)));
//!     }
//! }
//! ```

/// Writes trace context into an attempt's request headers. `span` is the attempt's span.
pub trait Propagator: Send + Sync {
    fn inject(&self, span: &tracing::Span, headers: &mut http::HeaderMap);
}

impl<F: Fn(&tracing::Span, &mut http::HeaderMap) + Send + Sync> Propagator for F {
    fn inject(&self, span: &tracing::Span, headers: &mut http::HeaderMap) {
        self(span, headers)
    }
}

use crate::error::{Error, CONNECTION_ERROR};

/// `server.address` and `url.full` for a URL. `url.full` loses the query, fragment and user information, which can
/// carry secrets (a presigned URL's signature).
pub(crate) fn http_target(raw: &str) -> (String, String) {
    match url::Url::parse(raw) {
        Ok(mut u) => {
            u.set_query(None);
            u.set_fragment(None);
            let _ = u.set_username("");
            let _ = u.set_password(None);
            (u.host_str().unwrap_or_default().to_owned(), u.to_string())
        }
        Err(_) => (String::new(), raw.split(['?', '#']).next().unwrap_or_default().to_owned()),
    }
}

/// An error's class name as every SDK reports it in `error.type`: the model's error shape for a problem whose
/// status has one (`NotFoundError`), else `CaitlynError`; `CaitlynConnectionError`, `CaitlynAuthError`,
/// `NotSupportedByServer`, `InputError` or `Cancelled`.
pub fn error_type(e: &Error, shapes: &[(u16, &'static str)]) -> &'static str {
    match e {
        Error::Api(a) => shapes
            .iter()
            .find(|(s, _)| *s == a.status && a.status != 0)
            .map_or("CaitlynError", |(_, n)| n),
        Error::Connection(_) => "CaitlynConnectionError",
        Error::Auth(_) => "CaitlynAuthError",
        Error::NotSupportedByServer(_) => "NotSupportedByServer",
        Error::Input(_) => "InputError",
        Error::Cancelled => "Cancelled",
    }
}

/// Marks `span` failed: `otel.status_code`, `error.type`, `caitlyn.error.code`, and an `exception` event.
pub(crate) fn record_failure(span: &tracing::Span, e: &Error, shapes: &[(u16, &'static str)]) {
    let kind = error_type(e, shapes);
    span.record("otel.status_code", "ERROR");
    span.record("error.type", kind);
    let code = match e {
        Error::Api(a) => Some(a.code.as_str()),
        Error::Auth(a) => Some(a.code.as_str()),
        Error::Connection(_) => Some(CONNECTION_ERROR),
        _ => None,
    };
    if let Some(c) = code {
        span.record("caitlyn.error.code", c);
    }
    tracing::event!(parent: span, tracing::Level::ERROR, "exception.type" = kind, "exception.message" = %e, "exception");
}
