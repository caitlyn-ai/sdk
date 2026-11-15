# `ai.caitlyn.protocols#restJson`: the Caitlyn v3 wire protocol and SDK runtime rules

This document is the wire protocol and runtime rules for every Caitlyn v3 SDK: how a generated client and its runtime core talk to the API that the model (`smithy/model/`) defines. Each SDK's runtime core implements it (for example `@caitlyn-ai/sdk-core` for TypeScript and `caitlyn-core` for Python), and each SDK's conformance suite tests it. When the runtime cores disagree, this document decides. When it is silent, raise the gap as a change to this document rather than choosing in one runtime core.

A change to this document is agreed for every SDK before any SDK implements it, and lands in one merge request with a conformance case. The `smithy/` code owners approve it.

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

| Rule            |                                                                                                                                                                                                                                                                                                 |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base URL        | `https://<workspace>/api`, the endpoint of section 12.1: each operation's `@http` path (`/v3/…`) is appended to it, so `GetCaller` is `GET https://<workspace>/api/v3/me`. It is the `servers` entry of the published OpenAPI document. An `endpoint` client option replaces it (section 12.1). |
| Bindings        | Smithy HTTP bindings (`@http`, `@httpLabel`, `@httpQuery`, `@httpHeader`, `@httpPayload`, `@httpResponseCode`), with `@jsonName` for body member names.                                                                                                                                         |
| Body            | `application/json`. An operation whose input has body members sends `{}` when every body member is unset; an operation with no body members sends no body and no `Content-Type`. A `@httpPayload` with `@mediaType` sends that media type.                                                      |
| Timestamps      | RFC 3339 `date-time` with milliseconds and `Z`, in bodies, headers and query strings, unless `@timestampFormat` says otherwise.                                                                                                                                                                 |
| Absent and null | Unset members are not sent. The SDK never sends `null`; clearing uses `clear` (section 8).                                                                                                                                                                                                      |

### 3.1 Request headers

Every request carries exactly these SDK-originated headers, and no `x-amz-*`, `amz-sdk-*` or `x-amzn-*` header:

| Header                                 | Value                                                                                                                                                                                                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `User-Agent`                           | `caitlyn-sdk-<sdk>/<sdkVersion> lang/<lang>[#<langVersion>] [md/<runtime>#<runtimeVersion>] [os/<os>] [app/<appId>]`, with each SDK's tokens as section 3.2 lists them. `app/<appId>` is the caller's own suffix, from a client option. Declared only, never used for authorisation. |
| `Caitlyn-Sdk-Model`                    | The model version the SDK was generated from: the highest `@since` anywhere in the published service.                                                                                                                                                                                |
| `Authorization`                        | `Bearer <token>`, from the sign-in mode (section 12). Not sent in `session` mode, which sends `Cookie` and, on writes, `Origin`.                                                                                                                                                     |
| `Idempotency-Key`                      | On operations with an `@idempotencyToken` member (section 7).                                                                                                                                                                                                                        |
| `If-Match`                             | Where the model binds it; a call option in the SDKs.                                                                                                                                                                                                                                 |
| `traceparent`, `tracestate`, `baggage` | Only when an OpenTelemetry propagator is configured; with none, the OpenTelemetry API is a no-op and nothing is sent.                                                                                                                                                                |
| `Accept`                               | `text/event-stream` on `@sseEvents` operations (proxies and CDNs key on it to stop buffering, and resuming a stream depends on it); otherwise the HTTP library's default.                                                                                                            |
| `Content-Type`                         | Per section 3.                                                                                                                                                                                                                                                                       |

Transport headers the HTTP library adds itself (`Host`, `Accept-Encoding`, `Connection`, `Content-Length`) are not SDK-originated and are not part of this contract.

`Caitlyn-Api-Version` is **never** sent; it is a response header.

SDKs MUST NOT read AWS configuration: no `AWS_*` environment variable, no `~/.aws/config` or credentials file, no instance metadata service. Retry settings, endpoints and timeouts come from client options only. The one exception is the `awsIam` sign-in mode, which reads the AWS credential and region variables listed in section 12.2, and only when the caller chooses that mode. Every conformance suite runs once with hostile `AWS_*` values set and assert that nothing changes.

### 3.2 User-Agent tokens

Each SDK fills in the `User-Agent` format of section 3.1 with its own tokens. A token in brackets is left out when the SDK's language has no such value. A new SDK adds its row here in the same merge request that introduces it, and its conformance suite checks the header against it.

| SDK        | `<sdk>`  | `lang/`                                            | `md/`                                                                                           | `os/`                  | Example                                                                         |
| ---------- | -------- | -------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------- |
| TypeScript | `ts`     | `js`                                               | `nodejs#<version>`, `bun#<version>`, `deno#<version>` or `browser`                              | not sent               | `caitlyn-sdk-ts/0.0.1 lang/js md/nodejs#24.17.0` (browsers may drop the header) |
| Python     | `python` | `python#<major.minor>`                             | `<implementation>#<version>`, for example `cpython#3.12.9` (`platform.python_implementation()`) | not sent               | `caitlyn-sdk-python/0.0.1 lang/python#3.12 md/cpython#3.12.9`                   |
| Go         | `go`     | `go#<Go version>`                                  | `gc` (the compiler, `runtime.Compiler`)                                                         | `runtime.GOOS`         | `caitlyn-sdk-go/0.0.1 lang/go#1.25.3 md/gc os/linux`                            |
| Rust       | `rust`   | `rust#<version of the rustc that built the crate>` | `rustc`                                                                                         | `std::env::consts::OS` | `caitlyn-sdk-rust/0.0.1 lang/rust#1.99.1 md/rustc os/linux`                     |

## 4. Responses

| Header                | SDK behaviour                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Caitlyn-Request-Id`  | Exposed on every output (as the modelled `requestId` member and in response metadata) and on every error.               |
| `Caitlyn-Api-Version` | The server's model version. The SDK keeps the latest value it has seen, per client, for the `@since` check (section 9). |
| `ETag`                | Bound by the model where it matters (`etag`).                                                                           |
| `Retry-After`         | Delta-seconds or HTTP-date; used by retries (section 6.4) and bound into `retryAfterSeconds` on 429 and 503 errors.     |
| `WWW-Authenticate`    | On every 401: the bearer challenge of section 12.7. SDKs MAY read it and need not.                                      |

### 4.1 `raw`: unknown fields

- Every deserialised **structure**, at any depth (the output itself, nested structures, and each item of a list of structures), exposes `raw`: the JSON object it was read from, unknown fields included, under their JSON names.
- TypeScript: a non-enumerable `raw` property, so spreading or serialising the object does not copy it; outputs are typed `WithRaw<…>`. Python: a `raw` attribute (a `dict`); Pydantic models may additionally keep unknown fields (`extra="allow"`), but `raw` is the cross-language contract.
- Streaming outputs (SSE, blobs) have no `raw`. A body that is not JSON has no `raw`.
- Unknown enum values are kept as the raw string (TypeScript: the string itself; Python: an "unknown" enum member carrying the string). They never raise.

### 4.2 Response metadata

Every output of a single call (not a stream, and not the items of a list) carries its response's metadata, in a typed form:

| Field       | Source                            | TypeScript                                                                 | Python                               | Go                                  | Rust                                 |
| ----------- | --------------------------------- | -------------------------------------------------------------------------- | ------------------------------------ | ----------------------------------- | ------------------------------------ |
| HTTP status | The response's status             | `$metadata.httpStatusCode`                                                 | `response_metadata.http_status_code` | `ResponseMetadata().HTTPStatusCode` | `response_metadata.http_status_code` |
| Request id  | `Caitlyn-Request-Id`              | `$metadata.requestId`                                                      | `response_metadata.request_id`       | `ResponseMetadata().RequestID`      | `response_metadata.request_id`       |
| ETag        | `ETag`, when the response has one | the modelled `etag` member (Smithy's `ResponseMetadata` has no ETag field) | `response_metadata.etag`             | `ResponseMetadata().ETag`           | `response_metadata.etag`             |

An absent header is `undefined`, `None`, `""` or `None`. The metadata is never serialised with the output, and an output built in code has none (Python `None`; Go and Rust the zero value). The modelled `requestId` and `etag` members stay where the model binds them.

## 5. Server-sent events (`@sseEvents`)

1. The response is `text/event-stream`. Each SSE `event:` name is the `@jsonName` of a member of the `events` union (or the member name); `data:` is that member's JSON body; `id:` is exposed as `eventId`. Comment lines and `retry:` are ignored.
2. An event name the SDK does not know is skipped silently.
3. Events with an `id` already seen are dropped.
4. The stream ends successfully after the `final` event. `finalMessage()` drains the stream if needed and returns the final event's single member.
5. **A failure event ends a stream with a `final` event.** On such a stream it raises the typed error built from its problem body (section 6.3) and ends the stream. On a stream without a `final` event (a watch), it is delivered as an event like any other and is never raised, and the stream carries on: on WatchConversation, `message.failed` ends that answer, not the watch. The failure event is the union member whose target uses the `ProblemDetails` mixin; on the conversation stream that is `message.failed`. Keep-alives are SSE comment lines (`: keep-alive`), not events.
6. A transport failure mid-stream, **or a clean end of stream before the final event** (what a proxy or load balancer produces when it cuts a connection), reconnects with the `resumeWith` operation.
   - The reconnect sends `Last-Event-ID` set to the last `id` seen, and leaves the header out when no event has arrived yet. (The server treats an empty `Last-Event-ID`, as the SSE standard allows, the same as an absent one; an SDK still leaves it out.)
   - Labels are copied from the original input by member name. When an operation resumes itself (a watch), the whole original input is sent again, except that a cursor sent as `after` is left out once `Last-Event-ID` carries the position.
   - Before each reconnect the SDK waits an exponential backoff with jitter: `min(8 s, 0.5 s × 2^(n−1)) × random(0.5, 1)` before the nth reconnect in a row, so 0.25–0.5 s, then 0.5–1 s, then 1–2 s. Half of each pause is fixed, so each pause is longer than the one before (unlike the full jitter of section 6.4's retries).
   - At most 3 reconnects in a row without a new event; then the stream fails with `STREAM_LOST`. Only an event with an `id` not seen before counts as new: a replayed duplicate does not.
   - Without `resumeWith`, the failure is raised.
7. Without a `final` member, a clean end of stream reconnects as rule 6 says when the operation has `resumeWith` (a watch: the server ends one cleanly only when it shuts down), and otherwise ends the stream.
8. Cancellation (`AbortSignal` in TypeScript, task cancellation in Python) closes the connection and raises the language's own cancellation error, never `STREAM_LOST`.
9. **A stream with a `final` event resumed through an open-ended watch** (SendMessage reconnecting through WatchConversation) ends at its `final` event, as rule 4 says. If the answer finished while it was disconnected, the watch sends `stream.reset` instead. The SDK then ends that stream there, with no error and no further reconnect: iterating it yields the reset, and `finalMessage()` fails with `NO_FINAL_EVENT`, because the final event went to the earlier connection. The answer is then read from the conversation's messages: by the caller, or by the SDK on the caller's behalf (an SDK MAY do this, for example to return the answer from `finalMessage()` instead of failing; none has to). A response that ends cleanly without carrying any event, on a stream without `resumeWith`, ends the stream with no error. Comment lines (keep-alives) are not events; an event the SDK skips (unknown name, duplicate id) is.
10. Every stream exposes the `Caitlyn-Request-Id` of the response that opened it (TypeScript `requestId`, set once iteration starts; Python `request_id`; Go `RequestID()`; Rust `request_id()`), and every event its SSE event name (TypeScript and Python `type`, Go `EventType()`, Rust `event_type()`). Rust events serialise to their JSON object with `type` added, the shape TypeScript gives them.
11. **`stream.reset`: the server cannot carry on from the cursor.** A stream that carries on from a cursor (`after`, or `Last-Event-ID` on a reconnect) sends a `stream.reset` event, rather than an error, when it cannot resume from the cursor it was given: on the workspace stream, the cursor is older than the recent events the server still holds, or catching up from it would pass the catch-up limit; on a conversation watch, the answer the cursor names has ended, another has started since, or it can no longer be replayed. Its data is `{"cursor": "<event id>"}`, and its SSE `id:` is that same cursor.
    - Events not yet sent before the reset are never sent (a reset during catch-up may follow some that were). The stream does not end (except as rule 9 says for a stream with a `final` event): the events after the new cursor follow on the same response.
    - On the workspace stream, a cursor it never issued is still refused with 400 `INVALID_CURSOR`. A conversation watch takes a `Last-Event-ID` that names no answer, as a reset's own cursor does, as "from now" and never resets it, so a reconnect after a reset is not reset again.
    - A client that keeps state built from the stream's events treats that state as out of date: it reads what it needs again with the List and Get operations, then carries on from the new cursor. It does not wait for the missed events.
    - Every SDK delivers `stream.reset` to the caller as an event (rule 2 never skips it), and a reconnect after it sends its `id`, as rule 6 says. It is never raised as an error and never causes a retry.
12. **Events after the headers are delivered.** On the watch streams (`WatchWorkspaceEvents`, `WatchConversation`), the server is listening before it sends the response's headers, so a client that opens a watch, waits for its headers, then makes a call, receives that call's events. A conversation watch also sends an answer whose run started after the watch opened, even one that finished before the watch next looked.

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

**Bodies that are not problem details.** Something in front of the API can answer instead of Caitlyn: a proxy or load balancer (a `text/plain` 502), or the web framework itself (an HTML 404 page for a route that does not exist, a 405 with no body). An error response whose body is empty, is not JSON, or is JSON but not an object is still the typed error for its status (section 6.2), never a parse error. Its fields are filled as section 6.3 says when there is no body: `status` is the HTTP status, `code` is `HTTP_<status>` (for example `HTTP_404`), `title`, `detail` and `type` are empty, `requestId` is the `Caitlyn-Request-Id` header if there is one and otherwise empty, and the body is kept as text in `rawBody`. The usual retry rules apply (section 6.4): such a 502 is not retried.

### 6.2 Choosing the error class

1. Collect every error shape in the service (the operations' and the service's).
2. The class is the one whose `@httpError` equals the response status, **whether or not the operation lists that error**: a 404 from an operation that models no 404 is still the not-found class, because that is what callers switch on. Lint rule 1 makes the class unique. The operation's own list is documentation and decides nothing.
3. If no error shape in the service has the status (a 405, a 502), the SDK raises its generic error: TypeScript `CaitlynError` (the generated base `CaitlynServiceException`), Python `CaitlynError`, Go `*Error`, Rust `Error::Api`. Its class name is `CaitlynError` in TypeScript (`name`) and Python; the code stays in `code`. It still carries every field below.
4. Per-code subclasses (one class for `DRAFT_CHANGED`, say) are deferred. If they come, they will be an opt-in trait mapping `code` values to subclasses of the status class, so existing `catch` and `except` blocks keep working.

### 6.3 Fields every error carries

| Field                     | Source                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                  | The HTTP status of the response, always. A `status` in the body is ignored for this field: a proxy or a faulty handler can put the wrong number there, and the HTTP status is what the client got. The class is chosen by the HTTP status too (section 6.2). A failure event on a stream (section 5.5) has no HTTP status of its own, so its body `status` is used. |
| `code`                    | Body `code`, else `HTTP_<status>`.                                                                                                                                                                                                                                                                                                                                  |
| `title`, `detail`, `type` | Body.                                                                                                                                                                                                                                                                                                                                                               |
| `requestId`               | Body `requestId`, else the `Caitlyn-Request-Id` header; empty when neither has one.                                                                                                                                                                                                                                                                                 |
| `retryAfterSeconds`       | `Retry-After`, on 429 and 503.                                                                                                                                                                                                                                                                                                                                      |
| `rawBody`                 | The response body as received, as text (invalid UTF-8 replaced), **at most 8 KiB**: a longer body keeps its first 8,192 bytes, cut back to the start of a UTF-8 character so none is split. Empty for an empty body and for errors the SDK raises itself. TypeScript `rawBody`, Python and Rust `raw_body`, Go `RawBody`.                                           |
| `rawBodyTruncated`        | `true` when the body was longer than 8 KiB and `rawBody` holds only its start; otherwise `false`. TypeScript `rawBodyTruncated`, Python and Rust `raw_body_truncated`, Go `RawBodyTruncated`.                                                                                                                                                                       |

Errors the SDK raises itself use the same class and fields, with `status: 0` and these codes: `STREAM_LOST`, `NO_FINAL_EVENT`, `UPLOAD_PUT_FAILED`, `CONNECTION_ERROR` (section 6.5). `NotSupportedByServer` (section 9) is a separate class, because nothing was sent.

### 6.4 Retries

1. At most 3 attempts in total (client option).
2. Only operations that are `@readonly`, `@idempotent`, or have an `@idempotencyToken` member are retried. Generators emit that list; nothing else is ever retried, whatever the error.
3. Retried: modelled `@retryable` errors (429, 503), and failures with no response (connection refused or reset, DNS, a timeout before the response headers). Not retried: everything else, including other 5xx and failures after response bytes arrived.
4. Delay: `Retry-After`, honoured in full up to `maxRetryDelay` (client option: TypeScript `maxRetryDelayMs`, default 60 s). Above that, fail at once with the typed error. Without `Retry-After`: full-jitter exponential, `random(0, min(8 s, 0.5 s × 2^retry))`.
5. Cancellation interrupts the wait.
6. **Retry budget.** Each client holds a budget of retry tokens, shared by all its calls, so that a failing or overloaded server does not get every call multiplied by its retries:
   - The budget starts full, at its size: 500 tokens by default (client option: TypeScript `retryBudget`, Python `retry_budget`, Go `WithRetryBudget`, Rust `retry_budget`). A size of 0 turns retries off.
   - A retry costs 5 tokens, or 10 when the attempt it repeats got no response (a refused or reset connection, a timeout). The cost is taken when the retry is decided, before the wait.
   - When the budget holds less than the cost, the call fails at once with the error the attempt got, without waiting.
   - A call that succeeds returns tokens, up to the size: the cost of its last retry when it retried, and 1 when it did not. A call that fails returns nothing.
   - The first attempt of a call is never blocked; the budget only decides retries. Section 12.4's one sign-in retry after a 401 is not a retry here and costs nothing.

   The numbers are the AWS SDKs' "standard" retry quota: 500 tokens, 5 for a retry, 10 for a retry after a timeout, 1 back for a success. With the default 3 attempts, a client can spend its whole budget on 50 calls that each fail twice; a healthy client earns tokens back with every success, so isolated failures never exhaust it.

7. **No client-side rate limiting.** The SDKs do not measure their own send rate or slow themselves down (the AWS SDKs' "adaptive" mode). The server says when to slow down, with 429 and `Retry-After`, which rule 4 honours.

### 6.5 Connection errors

A call that gets no HTTP response (the connection is refused or reset, DNS fails, TLS fails, or a timeout passes before the response headers), or whose connection fails while the response body is being read, fails with the language's connection error once section 6.4's retries are spent:

| Language   | Type                                 | Is also                                        | The cause                    |
| ---------- | ------------------------------------ | ---------------------------------------------- | ---------------------------- |
| TypeScript | `CaitlynConnectionError`             | a `CaitlynError` (`instanceof`)                | `cause`                      |
| Python     | `CaitlynConnectionError`             | a `CaitlynError`                               | `__cause__` (`raise … from`) |
| Go         | `*ConnectionError`                   | an `*Error` (`errors.As` finds either)         | `Unwrap()` and `Cause`       |
| Rust       | `Error::Connection(ConnectionError)` | `status()` and `code()` read it like a problem | `source()`                   |

It carries `status` 0 and `code` `CONNECTION_ERROR`, with `requestId` and `rawBody` empty and `rawBodyTruncated` false; the message names the operation and the cause. The retry rules are section 6.4's: a retry-safe operation is retried when nothing arrived, and a failure after response bytes arrived is never retried. Cancellation (section 5.8) is never a connection error, and a failed token request is a sign-in error (section 12.5), not this one.

## 7. Idempotency

If an `@idempotencyToken` member is unset, the SDK generates a UUID version 4 once per call and reuses it on every retry. The caller may pass its own (TypeScript and Python: an `idempotencyKey` call option).

## 8. Partial updates: a resource-shaped body plus `clear`

- `PATCH` bodies are shaped like the resource's writable fields: an absent member is unchanged; a present member replaces the value; nested structures merge; lists are replaced whole. The content type is `application/json`; the body is not an RFC 7396 merge patch and is not labelled as one.
- **Clearing never uses `null`.** The input has `clear: [<field>, …]`, a list of a `Clearable…Field` enum. Each named field returns to its default.
- The server answers **400 `VALIDATION_FAILED`**, with the field in `errors`, when a field is both set and named in `clear`, or when `clear` names a field that cannot be cleared (there are no separate codes for these two cases).
- SDKs type `clear` as the enum's known values (TypeScript union, Python `Literal`) but send the strings as given, so a newer server's fields can be cleared by an older SDK.

## 9. Version checks (`@since`) and the support floor

- The SDK remembers the latest `Caitlyn-Api-Version` it has seen, per client.
- Before sending, if that version is known and the operation's `@since`, or the `@since` of any member the caller set, is newer, the SDK raises `NotSupportedByServer(operation[.member], requires, server)` and sends nothing.
- Before any response has been seen, there is no check.
- The support floor (the oldest server an SDK accepts) is the release that launches v3; enforcement is a separate check on the same header.

## 10. Client methods

- **Namespace and name come from resources.** The namespace is the resource name with any trailing `Resource` removed, pluralised and lower-camel-cased (`DocumentResource` gives `documents`, `Version` gives `versions`). Lifecycle operations are named `create`, `get`, `update`, `delete`, `list`, `put`; other bound operations use the lower-camel operation name.
- **`@clientMethod(namespace, name)` overrides both.** Python snake-cases names. Today it is needed on:
  - SendMessage: `conversations.send`;
  - WatchConversation: `conversations.watch`;
  - CreateUpload: `uploads.reserve`;
  - BatchDeleteDocuments: `documents.batchDelete`;
  - GetAgentVersion: `agents.versions.get`;
  - ListAgentVersions: `agents.versions.list`;
  - UpdateDraftVersion: `agents.versions.updateDraft` (an instance operation of `Agent`, because its path fixes `/versions/draft`);
  - PinDraftVersion: `agents.versions.pin` (the same);
  - ResetDraftVersion: `agents.versions.resetDraft` (the same);
  - PublishAgentVersion: `agents.versions.publish`;
  - DeleteAgentVersion: `agents.versions.delete`;
  - ListProductionHistoryEntries: `agents.productionHistory.list`;
  - GetProductionHistoryEntry: `agents.productionHistory.get`.
- **Nested namespaces.** A `@clientMethod` namespace may be a dotted path, outermost first: `agents.versions` gives `client.agents.versions.get(…)`. Every SDK nests it the same way, each segment being a property (TypeScript and Python), an exported field (Go) or a method (Rust), in the language's own casing: TypeScript `caitlyn.agents.productionHistory.list(…)`, Python `caitlyn.agents.production_history.list(…)`, Go `client.Agents.ProductionHistory.List(ctx, …)`, Rust `client.agents().production_history().list(…)`.
- **Positional argument.** A non-lifecycle instance operation of a resource with exactly one identifier takes that identifier positionally: `conversations.send(conversationId, {message})`. Every other operation takes named fields, including `documents.list({knowledgeBaseId})`.
- **Call options.** `If-Match` (`ifMatch`), the idempotency token (`idempotencyKey`) and cancellation are call options, not input fields.
- **Lists** (`@paginated`) are async iterators over items, paging with `nextCursor` behind the scenes.
- **Uploads.** `@presignedUpload` gives `uploads.create(file)`: compute SHA-256 (base64), call the operation, then `PUT` the bytes to `uploadUrl` with `requiredHeaders`, using the output's `id`. `@uploadTarget(member)` gives `<namespace>.upload(file, …)`, which does that and then calls the operation with `member` set to the upload's `id`. `documents.upload` returns `{document, operation}`.

### 10.1 Waiters (`@smithy.waiters#waitable`)

A waiter polls its operation until an acceptor matches.

1. The first read is made at once. Before each later read, the SDK waits `random(minDelay, min(maxDelay, minDelay × 2^(n−1)))` after the nth read, with `minDelay` and `maxDelay` from the waiter (a caller may override both). Each read is an ordinary call, so the SDK's retries (section 6.4) apply inside it.
2. The whole wait is limited by default to the waiter's entry in the operation's `@ai.caitlyn.traits#waitLimits`, in seconds (for example 60 minutes for `Indexed` on GetDocument), or to 5 minutes for a waiter with no entry. A caller may set another limit. The last pause is cut to the time left.
3. Acceptors are checked in order against each result. `success` returns the output. A success reached through an error, such as `Deleted` on a 404, ends the wait with no output. A waiter may not mix output and error success acceptors; the model's lint rules refuse one that does. `failure` ends the wait with a waiter error. With no match, an output means poll again; an error that no acceptor matches ends the wait with a waiter error.
4. The waiter error names the waiter, says whether it failed or ran out of time (`failure` or `timeout`), and carries the last output or error and the number of reads.
5. Cancellation is the language's own (an `AbortSignal`, a context, task cancellation, dropping the future) and is never a waiter error.

## 11. Conformance

Every suite runs against the mock server and covers, at least:

- retries honour `Retry-After` in full;
- the retry budget: repeated 503s drain it and then calls fail without retrying, a success refunds it, and the first attempt always goes (section 6.4.6);
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
- the response metadata of a successful call: its HTTP status and request id (section 4.2);
- a connection closed before any response, and a refused connection, are the connection error (section 6.5);
- `rawBody` keeps at most 8 KiB, cut on a character boundary, with `rawBodyTruncated` (section 6.3);
- wire headers: section 3.1, with no AWS headers;
- a hostile `AWS_*` environment changes nothing;
- telemetry: one span per call and one per attempt;
- telemetry: span names and attributes as section 13 lists them, on a failed call and an upload;
- an error status the operation does not list is still that status's class (section 6.2);
- a SendMessage stream resumed after its answer finished yields `stream.reset` and ends with no error and no further reconnect, and `finalMessage()` fails with `NO_FINAL_EVENT` unless the SDK reads the answer from the conversation's messages (section 5.9); a watch that the server ends cleanly reconnects (section 5.7);
- a reconnect waits a growing, jittered pause, and fails with `STREAM_LOST` after three in a row without a new event, a replayed duplicate not counting (section 5.6); a reconnect before any event sends no `Last-Event-ID`, and a watch's reconnect leaves out `after` once it sends `Last-Event-ID` (section 5.6);
- on a watch, `message.failed` is delivered as an event, never raised, and the events after it (the next answer) follow on the same stream; on SendMessage it raises and ends the stream (section 5.5);
- a waiter returns the output when an output success acceptor matches, and nothing when an error success acceptor does (`Deleted` on a 404), ends with a `failure` waiter error when a failure acceptor or an unmatched error does, and with a `timeout` waiter error when its limit passes; its default limit is its `@waitLimits` entry, or 5 minutes without one (section 10.1);
- `stream.reset` is delivered as an event, never skipped or raised, the stream carries on after it, and a reconnect sends its `id` (section 5.11);
- every `@examples` entry in the model, as a request the mock server answers with the example's output or error;
- sign-in: each mode, the shared token request and early renewal, and the one retry after a 401 (section 12);
- one refresh for many concurrent 401s, and one refresh across clients sharing a locking token store (section 12.2, `oauth` step 5);
- a workspace given as a URL is reduced to its hostname, and a path, query string or other scheme is refused (section 12.1).

## 12. Sign-in

How an SDK gets the credential it sends. Each SDK's runtime core implements this section (for example `auth.ts` in TypeScript's `@caitlyn-ai/sdk-core`, and `caitlyn_core.auth` in Python, for both the synchronous and the asynchronous client); the conformance cases `auth.*` test it, and fail for any SDK whose runtime does not implement it yet.

### 12.1 The workspace, the endpoint and the audience

- The client is created for a **workspace**, given as a hostname (`your-company.getcaitlyn.ai`) or as its URL (`https://your-company.getcaitlyn.ai`, with or without a trailing `/`). The SDK reduces it to the hostname, in lower case, keeping a port if one is given.
- Anything else is refused when the client is created, before any request, with an error that names the expected form (`your-company.getcaitlyn.ai` or `https://your-company.getcaitlyn.ai`) and what was wrong: a scheme other than `https` (`http://`, `ftp://`), a path (`https://your-company.getcaitlyn.ai/api`), a query string or fragment, user information (`user@…`), or an empty value. TypeScript throws a `TypeError`, Python raises `ValueError`, Go's `NewClient` returns an error, and Rust's `build` returns `Error::Input` for the member `workspace`. A local server or a proxy is reached with the `endpoint` option, not through the workspace.
- The workspace sets two things:
  - the **endpoint**, `https://<workspace>/api`: operation paths (`/v3/…`) and the sign-in paths (`/oauth/token`, `/oauth/authorize`) are appended to it;
  - the **token audience**, always `https://<workspace>/api`: the `resource` parameter of every token request and authorisation URL, and the audience of the AWS identity token in `awsIam` mode. It is one audience for the workspace's whole REST API, v2 and v3 alike; there is no separate v3 audience. (The server also accepts `https://<workspace>/api/v3`, which SDK versions up to 0.0.2 request, as an alias.)
- An `endpoint` client option (a proxy, a local app) replaces the base URL, so requests and the sign-in paths go there. It never changes the audience: a token is always for the workspace the client names.
- A mode that offers a `resource` option (`clientCredentials`, `oauth`, `workloadIdentity` in TypeScript) uses it in place of the workspace audience. `awsIam` offers `audience` instead, which changes only the audience of the AWS identity token.

### 12.2 Modes

Every mode except `token` and `session` ends in the same thing: a short-lived Caitlyn access token from `{endpoint}/oauth/token`, sent as `Authorization: Bearer <token>`. Token requests are `POST`s with an `application/x-www-form-urlencoded` body and `Accept: application/json`.

| Mode                | What the caller gives                                                                                             | How the SDK gets the token                                                                                                                                                                                                       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`             | A personal access token.                                                                                          | None: the token is sent as it is, and never renewed.                                                                                                                                                                             |
| `clientCredentials` | Client ID and secret; optional scopes.                                                                            | `grant_type=client_credentials` with `client_id`, `client_secret`, `resource` and, when scopes are given, `scope` (space-separated). Asked again when the token is due for renewal; there is no refresh token.                   |
| `oauth`             | Client ID; client secret on a server only; redirect URI; scopes; a token store.                                   | Authorisation code with PKCE, then refresh tokens (below).                                                                                                                                                                       |
| `awsIam`            | Optional region, credentials, signing algorithm, lifetime, audience.                                              | STS `GetWebIdentityToken` on the regional STS endpoint, then an RFC 8693 token exchange of the JWT it returns (below).                                                                                                           |
| `workloadIdentity`  | A function that returns a JWT from another trusted issuer (a GitLab CI `id_tokens` variable, for example).        | The function is called at every sign-in and its JWT exchanged (RFC 8693, below). The server accepts each JWT once, for the exact audience, before it expires, so the SDK never keeps or reuses one.                              |
| `session`           | The browser session (a cookie, given on a server; in a browser the browser sends its own) and an optional Origin. | None. No `Authorization` header is sent. The cookie goes in `Cookie` when given, and every request other than `GET` and `HEAD` carries `Origin` (default `https://<workspace>`). For the Caitlyn app itself and local recording. |

**`oauth`.**

1. _Start:_ the SDK builds `{endpoint}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…[&scope=…]`. The PKCE verifier is 48 random bytes, base64url-encoded; the challenge is the base64url SHA-256 of the verifier. `state` is random unless the caller gives one. A redirect URI is required. The caller keeps the state and the verifier.
2. _Callback:_ when the caller passes the state it expects, a different returned state fails with `invalid_state` before any request. Then `grant_type=authorization_code` with `code`, `code_verifier`, `redirect_uri`, `resource`, `client_id` and, for a confidential client, `client_secret`. The tokens are saved to the token store (default: in memory for the life of the client).
3. _Calls:_ the SDK loads the store. A stored access token with more than a minute left (or no expiry), and that is not the token this client already holds or last saw refused, is used as it is (another process signed in or refreshed). Otherwise the stored refresh token is used: `grant_type=refresh_token` with `refresh_token`, `client_id` and `client_secret` when there is one. The new tokens are saved; when the response has no refresh token, the old one is kept. A refresh refused with `invalid_grant` clears the store and fails the call with that code. With nothing to refresh, the call fails with `sign_in_required` and sends nothing.
4. _Sign-out:_ a `POST` to the token endpoint with `action=revoke`, `token=<refresh token>` and the client parameters, whose failure is ignored; then the cached token and the store are cleared.
5. _One refresh at a time._ Refresh tokens are single-use and rotate: the server refuses a refresh token used a second time (and may treat the reuse as a stolen token). So a refresh token is never sent twice:
   - Within a client, section 12.3 already makes one token request serve every waiting call, and section 12.4 forgets only the token that was refused, so a 401 that arrives after a refresh does not throw the new token away and refresh again.
   - Across clients and processes that share a token store, the store may offer a lock: TypeScript `withLock(fn)`, Python `with_lock(fn)`, Go the optional `TokenStoreLocker` interface (`WithLock(ctx, fn)`), Rust `TokenStore::with_lock`. When it does, the SDK runs step 3 (load, decide, refresh, save) inside it. Whoever waited then loads the tokens the winner saved and uses them instead of refreshing again. A store shared between processes should offer it: a database row lock, a Redis lock, `navigator.locks` for browser tabs. The in-memory default store needs none.
   - A compare-and-swap `save` is not offered, because it would only notice the race after the second refresh request had already spent the token.

**`awsIam`.**

1. Region: the option, then `AWS_REGION`, then `AWS_DEFAULT_REGION`; with none, the call fails with `invalid_request`.
2. Credentials: the option (credentials, or a provider the SDK calls at each sign-in, such as the AWS SDK's own providers); otherwise `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (with `AWS_SESSION_TOKEN`); otherwise the container credentials endpoint (`AWS_CONTAINER_CREDENTIALS_FULL_URI` or `AWS_CONTAINER_CREDENTIALS_RELATIVE_URI`, with `AWS_CONTAINER_AUTHORIZATION_TOKEN` or `AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE`), as ECS, Fargate and AgentCore runtimes set it. Profiles, single sign-on and instance metadata are reached only by passing a provider. This mode, and only this mode, reads those `AWS_*` variables; section 3.1's rule holds for every other mode and for everything else the SDK does.
3. A Signature Version 4 signed `POST` to `https://sts.<region>.amazonaws.com/` (or the `stsEndpoint` option): `Action=GetWebIdentityToken`, `Version=2011-06-15`, `Audience.member.1=<audience>`, `DurationSeconds` (default 300, the most allowed) and `SigningAlgorithm` (default `ES384`; `RS256` allowed). An STS refusal fails the call with the STS error code (`SignatureDoesNotMatch`, for example). Any other failure to get the identity token, including finding no credentials, fails it with `aws_identity_failed`.
4. The returned JWT is exchanged as below.

**Token exchange** (`awsIam`, `workloadIdentity`): `grant_type=urn:ietf:params:oauth:grant-type:token-exchange`, `subject_token=<JWT>`, `subject_token_type=urn:ietf:params:oauth:token-type:jwt`, `requested_token_type=urn:ietf:params:oauth:token-type:access_token`, `resource`.

### 12.3 One cached token, renewed early by one request

- The SDK keeps one access token per client and sends it on every call until it is due for renewal.
- A token is due **a minute before it expires**, or, for a token that lives less than two minutes, **halfway through its life** (from `expires_in`, measured when the token arrives). A token with no `expires_in` is kept until a 401.
- When the token is due, or there is none yet, the first call to need one starts **one** token request, and every call that needs a token while it is in flight waits for the same request, however many there are. A failure fails every waiting call; the next call starts a new request.
- `token` and `session` mode have nothing to cache or renew.

### 12.4 One sign-in retry on a 401

- In `clientCredentials`, `oauth`, `awsIam` and `workloadIdentity` mode, a 401 response makes the SDK forget its cached token and send the call **once more**, with a new token got as in section 12.3. A 401 on that second attempt is raised. This happens for every operation, including those section 6.4 never retries, because the server refused the first attempt before acting on it. It is separate from, and counts nothing against, the retries of section 6.4.
- In `oauth` mode the refused token is never reloaded from the store; the refresh token replaces it.
- The SDK forgets only the token it sent and the server refused. When several calls were sent with the same token and their 401s arrive one after another, the first starts the renewal and the later ones find the new token already cached, so one renewal serves them all.
- In `token` and `session` mode a 401 is raised at once: the SDK has no other credential to try.

### 12.5 Sign-in errors

A failed token request is a sign-in error (`CaitlynAuthError` in TypeScript and Python), not one of the operation error classes of section 6.2. It carries:

| Field       | Source                                                                                                |
| ----------- | ----------------------------------------------------------------------------------------------------- |
| `code`      | The OAuth `error` (`invalid_client`, `invalid_grant`…), else the body's `code`, else `http_<status>`. |
| `message`   | `error_description`, else `detail`.                                                                   |
| `status`    | The HTTP status.                                                                                      |
| `requestId` | The `Caitlyn-Request-Id` header.                                                                      |

A token response without `access_token` is a sign-in error too. Errors the SDK raises itself use the same class with these codes: `sign_in_required` (`oauth` with no tokens), `invalid_state` (the callback's state does not match), `invalid_request` (a missing redirect URI or region, or an `oauth` step on a client in another mode), the STS code or `aws_identity_failed` (`awsIam`), and, in the TypeScript SDK only, `not_allowed_in_browser` (section 12.6). A 401 from an operation is not a sign-in error: it is section 6.2's class for 401, after section 12.4's retry.

### 12.6 In a browser (TypeScript only)

The TypeScript SDK is the only one that runs in a browser page, so only it has this rule. A browser page is where `globalThis` has both a `window` and a `document`. Node, Deno and Bun have no `document`; web, service and shared workers have neither. A test environment that simulates a DOM, such as jsdom, counts as a browser.

In a browser, creating a client (`new Caitlyn(…)`, `createCaitlynClient(…)` or `createAuth(…)`) checks the sign-in mode before anything is sent:

| Mode                                                   | In a browser                                                                                                                                                                                                                                                        |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `clientCredentials`, and `oauth` with a `clientSecret` | Refused: throws `CaitlynAuthError` with code `not_allowed_in_browser`. A client secret in a browser is visible to everyone who loads the page. The message points to `oauth` without a secret (authorisation code with PKCE), or signing in on a server.            |
| `awsIam`, `workloadIdentity`                           | Refused the same way: they sign in a server workload with its own identity.                                                                                                                                                                                         |
| `token`                                                | Allowed, with one `console.warn` per client: a long-lived token in a browser is exposed to anyone who can run script on the page, so the mode is for local testing, and `oauth` should be used instead. `allowBrowserToken: true` on the mode silences the warning. |
| `session`, and `oauth` without a `clientSecret`        | Unaffected.                                                                                                                                                                                                                                                         |

### 12.7 The challenge on a 401

This is server behaviour that SDKs MAY use; none needs it, because section 12.4 already decides what to do with a 401.

- Every v3 401 carries `WWW-Authenticate` with the bearer scheme (RFC 6750). It is `Bearer error="invalid_token"` when the request presented a bearer token that was refused: malformed, unknown, revoked, expired, issued for another workspace, or not checkable because of a server failure (which counts as a refusal). Otherwise it is plain `Bearer`: the request sent no credential, or its browser session cookie is missing, expired or unreadable, which the server treats as no credential. The problem body (section 6.1) is the same 401 `UNAUTHENTICATED` either way.
- The server answers the 401 before any check meant for a browser session, so a token caller never gets a session-specific refusal instead.
- A script on a browser origin the workspace has registered can read the header on every 401, including one answered before the caller is identified: the response carries the workspace's CORS headers, and `Access-Control-Expose-Headers` lists `WWW-Authenticate` with `Caitlyn-Request-Id`, `Caitlyn-Api-Version`, `ETag`, `Retry-After` and `Location`. A response to an origin the workspace has not registered carries no CORS headers, so a script there cannot read it at all.
- A widget guest token used from a website other than the one it was issued for is refused with 403 `PERMISSION_DENIED`, not 401, so it carries no challenge and no CORS headers.

## 13. Telemetry

Every SDK emits the same OpenTelemetry spans. The span names and attributes are in the shared registry (the app repository's `telemetry/registry`, which the server uses too), alongside the OpenTelemetry semantic conventions. TypeScript, Python and Go use the OpenTelemetry API, a no-op until the caller configures a provider; Rust uses `tracing` spans, which `tracing-opentelemetry` turns into the same spans (`otel.name`, `otel.kind` and `otel.status_code` fields).

| Span                                                    | Kind and parent                   | Attributes                                                                                                                                                                                                         |
| ------------------------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `caitlyn.call`, one per call                            | client; the caller's current span | `rpc.system` = `caitlyn`, `rpc.method` = the operation (`GetAgentVersion`), `caitlyn.request_id` (the last attempt's)                                                                                              |
| `caitlyn.attempt`, one per HTTP attempt                 | client; the call span             | `http.request.method`, `server.address`, `url.full`, `http.request.resend_count` (0 for the first), and when a response arrived `http.response.status_code`, `caitlyn.request_id` and `caitlyn.server.api_version` |
| `caitlyn.upload`, the bytes of an upload helper's `PUT` | client; the caller's current span | `http.request.method`, `server.address`, `url.full`, `http.response.status_code`                                                                                                                                   |

- `url.full` never carries the query string, fragment or user information: a presigned upload URL's query is its signature.
- A failed call, attempt or upload records its failure the same way: the span's status is error, with the error's message as the status description (`otel.status_message` in Rust); `error.type` is the error's class name; `caitlyn.error.code` is its `code` when it has one; and an `exception` event records the class name and the message.
- An attempt fails when its response is 400 or above, with the error that response is (`ServiceUnavailableError` for a 503), or when no response arrived, which it reports as the call does once retries are spent: `CaitlynConnectionError`, `CONNECTION_ERROR`. The class name is the same in every SDK: the model's error shape for a typed error (`NotFoundError`), `CaitlynError` for the generic one, `CaitlynConnectionError`, `CaitlynAuthError`, `NotSupportedByServer`.
- `traceparent`, `tracestate` and `baggage` are injected from the attempt span (section 3.1).
