# Generators

One Gradle build with five projects. Each generator is a smithy-build plugin; `codegen/smithy-build.json`
runs all four over `build/model/model.json` (the prepared snapshot, see CONTRIBUTING.md). `make generate`
builds and runs them in the toolchain image.

| Project | Plugin | Output |
| --- | --- | --- |
| `model-support` | none (a library) | The rules the generators share: `ClientMethod` (namespace, method name and positional identifier, PROTOCOL.md section 10), `ResultNames`, `SseEvents` (unions, the failure member: the one carrying the problem details), `ProblemDetails`, `Versions`, `CaitlynTraits`, `Bindings` |
| `typescript` | smithy-typescript's `typescript-client-codegen`, with Caitlyn's integration | `typescript/packages/sdk`: the Smithy client with the Caitlyn REST JSON protocol (`CaitlynRestJsonProtocolGenerator`), no AWS runtime, and the method-style SDK in `src/sdk/` (`FacadeGenerator`) |
| `python` | `caitlyn-python-client-codegen` | `python/caitlyn`: Pydantic v2 models, open enums, typed errors and events, sync and async clients on `caitlyn-core` |
| `go` | `caitlyn-go-client-codegen` | The generated files in `go/`: types that keep their raw JSON, open enums, typed errors that embed `*core.APIError`, sealed event interfaces, namespaced clients on `core` |
| `rust` | `caitlyn-rust-client-codegen` | `rust/caitlyn-sdk`: serde types that keep their raw JSON, open enums with an `Unknown(String)` variant, an `Error` enum with one variant per error shape, event enums, namespaced clients on `caitlyn-sdk-core` |

The Python, Go and Rust generators are on Smithy's own codegen framework (`smithy-codegen-core`: `CodegenDirector`,
`DirectedCodegen`, symbol providers and writers). smithy-python (pre-alpha) and smithy-go (no retries, auth,
pagination or SSE) were assessed in the generator trial and not used.

Generator-level tests live beside each generator; `codegen/python/tests` checks the Python SDK's static types
with pyright and its interceptor hooks (`make python` runs them).

## Why the Rust generator is not smithy-rs

smithy-rs, the generator behind the AWS SDK for Rust, was trialled first (November 2026, codegen-client 0.1.39
from Maven Central, over this model). It runs, once its published POM's `kotlin-stdlib-jdk8:unspecified`
dependency is pinned by hand, and produces a compiling crate, but only for `aws.protocols#restJson1`: it has no
way to select `ai.caitlyn.protocols#restJson` without a Kotlin decorator written against its internal,
pre-1.0 codegen API. On the protocol rules it fell short in ways a decorator would have to rewrite rather than
extend:

- **Errors** are chosen by the `code` or `__type` body field read as a shape name; PROTOCOL.md 6.2 chooses by
  HTTP status, and `code` is a product code (`NOT_FOUND`), so every error came back unmodelled.
- **Server-sent events** came back as a raw byte stream: smithy-rs streams AWS's binary event-stream framing,
  not SSE, so typed events, de-duplication, the final event and resuming (PROTOCOL.md 5) were all missing.
- **`raw`** (PROTOCOL.md 4.1): the generated structures drop unknown fields.
- **Retries** follow the AWS standard retry classifier (any 5xx, throttling codes), not the per-operation
  retry-safe list and modelled `@retryable` statuses (PROTOCOL.md 6.4).
- **Client methods** are AWS-style fluent builders (`client.get_agent_version().agent_id(…).send()`), not the
  namespaced methods of PROTOCOL.md 10 (`client.versions().get(…)`), and the `@since` check,
  `Caitlyn-Sdk-Model`, uploads and the sign-in modes would all be extra runtime crates.

So the Rust generator follows the Python and Go ones: a Smithy codegen-core plugin over the shared
`model-support` rules, emitting plain serde and tokio code on a hand-written runtime crate. The OpenAPI route
(generating from `model/openapi.json`) was not taken further for the same reason the other lanes gave: OpenAPI
loses resources, `@sseEvents`, `@since`, pagination and the upload traits, which are where the client methods come
from.
