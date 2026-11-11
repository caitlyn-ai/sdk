//! Telemetry through the `tracing` crate. Each call is a `caitlyn.call` span (`otel.name` = `caitlyn <Operation>`,
//! `rpc.system`, `rpc.method`, `caitlyn.request_id`) with one child `caitlyn.attempt` span per HTTP attempt
//! (`http.request.method`, `http.request.resend_count`, `http.response.status_code`): the attribute names the
//! TypeScript, Python and Go SDKs use. With `tracing-opentelemetry` installed, they become OpenTelemetry spans.
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
