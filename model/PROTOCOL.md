# `ai.caitlyn.protocols#restJson`: the Caitlyn v3 wire protocol and SDK runtime rules

Status: agreed for the generator trial on 9 November 2026 between the TypeScript and Python generators, then implemented by the Go generator; moved into the app repository with the model on 10 November 2026 (Gate 1 of the v3 implementation plan). The `Accept: text/event-stream` rule (section 3.1) was added at the Python generator's request. The runtimes (`@caitlyn-ai/sdk-core` for TypeScript, `caitlyn-core` for Python and Go) implement this document, and each conformance suite tests it. When the runtimes disagree, this document decides; when this document is silent, raise it here rather than choosing in one runtime.

A change to this document is agreed by all three generator lanes before any of them implements it, and lands in one merge request with a conformance case (implementation plan, "Running lanes in parallel sessions"). The design owners approve it through the `smithy/` code owners rule.

Terms: "the model" is the Smithy model in `smithy/model/`. "SDK" is a generated client plus its runtime core. MUST, SHOULD and MAY are used as in RFC 2119.

## 1. Where the protocol is declared

- The service carries `@ai.caitlyn.protocols#restJson` (defined in `smithy/model/protocols.smithy`).
- It also carries `@aws.protocols#restJson1`, only because Smithy's OpenAPI converter and smithy-python understand no other protocol. The HTTP bindings of the two are identical; the differences are errors, headers and the runtime rules below. SDK generators MUST select `restJson`.

## 2. Model lint rules

A model change that breaks one of these fails the model build. Each rule is a Caitlyn validator in `smithy/validators`, named after the rule:

1. **One error shape per HTTP status** (`CaitlynErrors`). Within the service (operation errors plus service errors), no two `@error` structures share an `@httpError` code. The SDKs choose the error class by status (rule 6.2), so a second shape for the same status could never be produced.
2. **Every error structure uses the `ProblemDetails` mixin** (`CaitlynErrors`), so it has `type`, `title`, `status`, `code` and `requestId`. Every code the shape carries is listed in its `@errorCodes`.
3. **Every operation has a client method** (`CaitlynClientMethod`). It is either a lifecycle or instance operation of a `resource`, or it carries `@clientMethod(namespace, name)` (section 10).
4. **`@sseEvents(final: …)` names a union member whose target has exactly one member** (`CaitlynEvents`). `finalMessage()` returns that member.
5. **`clear` members** are lists of an enum named `Clearable…Field`, and the enum lists exactly the input's `@clearable` members (section 8; `CaitlynUpdate`).
6. **Every operation and every member newer than the support floor carries `@since`** (`CaitlynSince` for operations; the breaking-change check for members added after the last published model). Authors write `@since("next")`; the release replaces it with the release number before the model is published, so a published model never contains "next".

## 3. Requests

| Rule            |                                                                                                                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Bindings        | Smithy HTTP bindings (`@http`, `@httpLabel`, `@httpQuery`, `@httpHeader`, `@httpPayload`, `@httpResponseCode`), with `@jsonName` for body member names.                                                                                    |
| Body            | `application/json`. An operation whose input has body members sends `{}` when every body member is unset; an operation with no body members sends no body and no `Content-Type`. A `@httpPayload` with `@mediaType` sends that media type. |
| Timestamps      | RFC 3339 `date-time` with milliseconds and `Z`, in bodies, headers and query strings, unless `@timestampFormat` says otherwise.                                                                                                            |
| Absent and null | Unset members are not sent. The SDK never sends `null`; clearing uses `clear` (section 8).                                                                                                                                                 |

### 3.1 Request headers

Every request carries exactly these SDK-originated headers, and no `x-amz-*`, `amz-sdk-*` or `x-amzn-*` header:

| Header                                 | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User-Agent`                           | `caitlyn-sdk-<sdk>/<sdkVersion> lang/<lang>[#<langVersion>] [md/<runtime>#<runtimeVersion>] [os/<os>] [app/<appId>]`. `<sdk>` is `ts`, `python` or `go`. TypeScript today: `caitlyn-sdk-ts/0.0.1 lang/js md/nodejs#24.17.0` (`md/bun#…`, `md/deno#…` or `md/browser` elsewhere; browsers may drop the header). Python: `caitlyn-sdk-python/0.0.1 lang/python#3.12 md/cpython#3.12.9`. Go: `caitlyn-sdk-go/<version> lang/go#<go version> md/gc os/<os>`, for example `caitlyn-sdk-go/0.0.1 lang/go#1.25.3 md/gc os/linux` (`md/` is the Go compiler, `runtime.Compiler`; `os/` is `runtime.GOOS`). `app/<appId>` is the caller's own suffix, from a client option. Declared only, never used for authorisation (design doc, "Request origin"). |
| `Caitlyn-Sdk-Model`                    | The model version the SDK was generated from: the highest `@since` anywhere in the published service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Authorization`                        | `Bearer <token>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Idempotency-Key`                      | On operations with an `@idempotencyToken` member (section 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `If-Match`                             | Where the model binds it; a call option in the SDKs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `traceparent`, `tracestate`, `baggage` | Only when an OpenTelemetry propagator is configured; with none, the OpenTelemetry API is a no-op and nothing is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Accept`                               | `text/event-stream` on `@sseEvents` operations (proxies and CDNs key on it to stop buffering, and the proposal's re-join wire form depends on it); otherwise the HTTP library's default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Content-Type`                         | Per section 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Transport headers the HTTP library adds itself (`Host`, `Accept-Encoding`, `Connection`, `Content-Length`) are not SDK-originated and are not part of this contract.

`Caitlyn-Api-Version` is **never** sent; it is a response header.

SDKs MUST NOT read AWS configuration: no `AWS_*` environment variable, no `~/.aws/config` or credentials file, no instance metadata service. Retry settings, endpoints and timeouts come from client options only. Every conformance suite runs once with hostile `AWS_*` values set and assert that nothing changes.

## 4. Responses

| Header                | SDK behaviour                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Caitlyn-Request-Id`  | Exposed on every output (as the modelled `requestId` member and in response metadata) and on every error.               |
| `Caitlyn-Api-Version` | The server's model version. The SDK keeps the latest value it has seen, per client, for the `@since` check (section 9). |
| `ETag`                | Bound by the model where it matters (`etag`).                                                                           |
| `Retry-After`         | Delta-seconds or HTTP-date; used by retries (section 6.4) and bound into `retryAfterSeconds` on 429 and 503 errors.     |

### 4.1 `raw`: unknown fields

- Every deserialised **structure**, at any depth (the output itself, nested structures, and each item of a list of structures), exposes `raw`: the JSON object it was read from, unknown fields included, under their JSON names.
- TypeScript: a non-enumerable `raw` property, so spreading or serialising the object does not copy it; outputs are typed `WithRaw<…>`. Python: a `raw` attribute (a `dict`); Pydantic models may additionally keep unknown fields (`extra="allow"`), but `raw` is the cross-language contract.
- Streaming outputs (SSE, blobs) have no `raw`. A body that is not JSON has no `raw`.
- Unknown enum values are kept as the raw string (TypeScript: the string itself; Python: an "unknown" enum member carrying the string). They never raise.

## 5. Server-sent events (`@sseEvents`)

1. The response is `text/event-stream`. Each SSE `event:` name is the `@jsonName` of a member of the `events` union (or the member name); `data:` is that member's JSON body; `id:` is exposed as `eventId`. Comment lines and `retry:` are ignored.
2. An event name the SDK does not know is skipped silently.
3. Events with an `id` already seen are dropped.
4. The stream ends successfully after the `final` event. `finalMessage()` drains the stream if needed and returns the final event's single member.
5. A failure event raises the typed error built from its problem body (section 6.3) and ends the stream. The failure event is the union member whose target uses the `ProblemDetails` mixin; on the chat stream that is `message.failed` (it was `error` in the generator trial). Keep-alives are SSE comment lines (`: keep-alive`), not events.
6. A transport failure mid-stream, **or a clean end of stream before the final event** (what a proxy or load balancer produces when it cuts a connection), reconnects with the `resumeWith` operation and `Last-Event-ID` set to the last `id` seen. Labels are copied from the original input by member name. At most 3 reconnects; then the stream fails with `STREAM_LOST`. Without `resumeWith`, the failure is raised.
7. Without a `final` member, a clean end of stream ends the stream.
8. Cancellation (`AbortSignal` in TypeScript, task cancellation in Python) closes the connection and raises the language's own cancellation error, never `STREAM_LOST`.

## 6. Errors

### 6.1 Wire format

Error responses are RFC 9457 problem details, `application/problem+json`:

```json
{
  "type": "https://build.caitlyn.ai/errors/NOT_FOUND",
  "title": "Not found",
  "status": 404,
  "detail": "No knowledge base KBNOPE0000",
  "code": "NOT_FOUND",
  "requestId": "01JC9Q2W7R4M0H2T6N1S8V3B5X"
}
```

`code` is the stable, documented product code. It is always a field, never a shape name. `type` is that code's page in the public error reference, `https://build.caitlyn.ai/errors/{code}`. `instance` is not used, because `requestId` identifies the occurrence. No `X-Amzn-Errortype` header is sent or read.

### 6.2 Choosing the error class

1. Collect the operation's error shapes, then the service's.
2. The class is the one whose `@httpError` equals the response status. Lint rule 1 makes this unique.
3. If none matches, the SDK raises its generic error (TypeScript `CaitlynError`, the generated base `CaitlynServiceException`, with `name = code`; Python `CaitlynError`). It still carries every field below.
4. Per-code subclasses (one class for `DRAFT_CHANGED`, say) are deferred. If they come, they will be an opt-in trait mapping `code` values to subclasses of the status class, so existing `catch` and `except` blocks keep working.

### 6.3 Fields every error carries

| Field                     | Source                                                  |
| ------------------------- | ------------------------------------------------------- |
| `status`                  | Body `status`, or the HTTP status.                      |
| `code`                    | Body `code`.                                            |
| `title`, `detail`, `type` | Body.                                                   |
| `requestId`               | Body `requestId`, else the `Caitlyn-Request-Id` header. |
| `retryAfterSeconds`       | `Retry-After`, on 429 and 503.                          |

Errors the SDK raises itself use the same class and fields, with `status: 0` and these codes: `STREAM_LOST`, `NO_FINAL_EVENT`, `UPLOAD_PUT_FAILED`. `NotSupportedByServer` (section 9) is a separate class, because nothing was sent.

### 6.4 Retries

1. At most 3 attempts in total (client option).
2. Only operations that are `@readonly`, `@idempotent`, or have an `@idempotencyToken` member are retried. Generators emit that list; nothing else is ever retried, whatever the error.
3. Retried: modelled `@retryable` errors (429, 503), and failures with no response (connection refused or reset, DNS, a timeout before the response headers). Not retried: everything else, including other 5xx and failures after response bytes arrived.
4. Delay: `Retry-After`, honoured in full up to `maxRetryDelay` (client option: TypeScript `maxRetryDelayMs`, default 60 s). Above that, fail at once with the typed error. Without `Retry-After`: full-jitter exponential, `random(0, min(8 s, 0.5 s × 2^retry))`.
5. Cancellation interrupts the wait.

## 7. Idempotency

If an `@idempotencyToken` member is unset, the SDK generates a UUID version 4 once per call and reuses it on every retry. The caller may pass its own (TypeScript and Python: an `idempotencyKey` call option).

## 8. Partial updates: a resource-shaped body plus `clear`

- `PATCH` bodies are shaped like the resource's writable fields: an absent member is unchanged; a present member replaces the value; nested structures merge; lists are replaced whole. The content type is `application/json`; the body is not an RFC 7396 merge patch and is not labelled as one.
- **Clearing never uses `null`.** The input has `clear: [<field>, …]`, a list of a `Clearable…Field` enum. Each named field returns to its default.
- The server answers **400 `VALIDATION_FAILED`**, with the field in `errors`, when a field is both set and named in `clear`, or when `clear` names a field that cannot be cleared (design guide, section 4; the trial's `FIELD_SET_AND_CLEARED` and `FIELD_NOT_CLEARABLE` codes are not used).
- SDKs type `clear` as the enum's known values (TypeScript union, Python `Literal`) but send the strings as given, so a newer server's fields can be cleared by an older SDK.

## 9. Version checks (`@since`) and the support floor

- The SDK remembers the latest `Caitlyn-Api-Version` it has seen, per client.
- Before sending, if that version is known and the operation's `@since`, or the `@since` of any member the caller set, is newer, the SDK raises `NotSupportedByServer(operation[.member], requires, server)` and sends nothing.
- Before any response has been seen, there is no check.
- The support floor (the oldest server an SDK accepts) is the release that launches v3; enforcement is a separate check on the same header.

## 10. Client methods

- **Namespace and name come from resources.** The namespace is the resource name with any trailing `Resource` removed, pluralised and lower-camel-cased (`DocumentResource` gives `documents`, `Version` gives `versions`). Lifecycle operations are named `create`, `get`, `update`, `delete`, `list`, `put`; other bound operations use the lower-camel operation name.
- **`@clientMethod(namespace, name)` overrides both.** Today it is needed on SendMessage (`conversations.send`), ResumeConversationStream (`conversations.resume`), CreateUpload (`uploads.reserve`) and UpdateDraftVersion (`versions.updateDraft`, an instance operation of `Agent` because its path fixes `/versions/draft`). Python snake-cases names.
- **Positional argument.** A non-lifecycle instance operation of a resource with exactly one identifier takes that identifier positionally: `conversations.send(conversationId, {message})`. Every other operation takes named fields, including `documents.list({knowledgeBaseId})`, as the proposal's examples do.
- **Call options.** `If-Match` (`ifMatch`), the idempotency token (`idempotencyKey`) and cancellation are call options, not input fields.
- **Lists** (`@paginated`) are async iterators over items, paging with `nextCursor` behind the scenes.
- **Uploads.** `@presignedUpload` gives `uploads.create(file)`: compute SHA-256 (base64), call the operation, then `PUT` the bytes to `uploadUrl` with `requiredHeaders`, using the output's `id`. `@uploadTarget(member)` gives `<namespace>.upload(file, …)`, which does that and then calls the operation with `member` set to the upload's `id`. `documents.upload` returns `{document, operation}`.

## 11. Conformance

Every suite runs against the mock server and covers, at least:

- retries honour `Retry-After` in full;
- a `Retry-After` above `maxRetryDelay` fails at once;
- an operation that is not retry-safe (`SendMessage`) is sent once on a 503;
- the idempotency key is kept across retries;
- pagination runs to the last page;
- SSE: typed events, resume with `Last-Event-ID` without duplicates, unknown events skipped, `finalMessage()`;
- unknown enum values are kept;
- unknown fields are kept in `raw`, on the output and on nested items;
- typed errors carry `status`, `code` and `requestId`, chosen by status with and without `X-Amzn-Errortype`, for 404, 409, 412 and 429;
- cancellation, of a stream and of a single call;
- `If-Match` and the new ETag;
- `clear` sends only the clear list;
- `@since` fails before sending;
- `Caitlyn-Request-Id` on outputs;
- wire headers: section 3.1, with no AWS headers;
- a hostile `AWS_*` environment changes nothing;
- telemetry: one span per call and one per attempt;
- every `@examples` entry in the model, as a request the mock server answers with the example's output or error (design guide, section 14).
