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
| `User-Agent`                           | `caitlyn-sdk-<sdk>/<sdkVersion> lang/<lang>[#<langVersion>] [md/<runtime>#<runtimeVersion>] [os/<os>] [app/<appId>]`. `<sdk>` is `ts`, `python`, `go` or `rust`. TypeScript today: `caitlyn-sdk-ts/0.0.1 lang/js md/nodejs#24.17.0` (`md/bun#…`, `md/deno#…` or `md/browser` elsewhere; browsers may drop the header). Python: `caitlyn-sdk-python/0.0.1 lang/python#3.12 md/cpython#3.12.9`. Go: `caitlyn-sdk-go/<version> lang/go#<go version> md/gc os/<os>`, for example `caitlyn-sdk-go/0.0.1 lang/go#1.25.3 md/gc os/linux` (`md/` is the Go compiler, `runtime.Compiler`; `os/` is `runtime.GOOS`). Rust: `caitlyn-sdk-rust/<version> lang/rust#<rustc version> md/rustc os/<os>`, for example `caitlyn-sdk-rust/0.0.1 lang/rust#1.99.1 md/rustc os/linux` (`lang/rust#` is the version of the `rustc` that built the crate; `os/` is `std::env::consts::OS`). `app/<appId>` is the caller's own suffix, from a client option. Declared only, never used for authorisation (design doc, "Request origin"). |
| `Caitlyn-Sdk-Model`                    | The model version the SDK was generated from: the highest `@since` anywhere in the published service.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Authorization`                        | `Bearer <token>`, from the sign-in mode (section 12). Not sent in `session` mode, which sends `Cookie` and, on writes, `Origin`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Idempotency-Key`                      | On operations with an `@idempotencyToken` member (section 7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `If-Match`                             | Where the model binds it; a call option in the SDKs.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `traceparent`, `tracestate`, `baggage` | Only when an OpenTelemetry propagator is configured; with none, the OpenTelemetry API is a no-op and nothing is sent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Accept`                               | `text/event-stream` on `@sseEvents` operations (proxies and CDNs key on it to stop buffering, and the proposal's re-join wire form depends on it); otherwise the HTTP library's default.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Content-Type`                         | Per section 3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

Transport headers the HTTP library adds itself (`Host`, `Accept-Encoding`, `Connection`, `Content-Length`) are not SDK-originated and are not part of this contract.

`Caitlyn-Api-Version` is **never** sent; it is a response header.

SDKs MUST NOT read AWS configuration: no `AWS_*` environment variable, no `~/.aws/config` or credentials file, no instance metadata service. Retry settings, endpoints and timeouts come from client options only. The one exception is the `awsIam` sign-in mode, which reads the AWS credential and region variables listed in section 12.2, and only when the caller chooses that mode. Every conformance suite runs once with hostile `AWS_*` values set and assert that nothing changes.

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

**Bodies that are not problem details.** Something in front of the API can answer instead of Caitlyn: a proxy or load balancer (a `text/plain` 502), or the web framework itself (an HTML 404 page for a route that does not exist, a 405 with no body). An error response whose body is empty, is not JSON, or is JSON but not an object is still the typed error for its status (section 6.2), never a parse error. Its fields are filled as section 6.3 says when there is no body: `status` is the HTTP status, `code` is `HTTP_<status>` (for example `HTTP_404`), `title`, `detail` and `type` are empty, `requestId` is the `Caitlyn-Request-Id` header if there is one and otherwise empty, and the body is kept as text in `rawBody`. The usual retry rules apply (section 6.4): such a 502 is not retried.

### 6.2 Choosing the error class

1. Collect the operation's error shapes, then the service's.
2. The class is the one whose `@httpError` equals the response status. Lint rule 1 makes this unique.
3. If none matches, the SDK raises its generic error (TypeScript `CaitlynError`, the generated base `CaitlynServiceException`, with `name = code`; Python `CaitlynError`). It still carries every field below.
4. Per-code subclasses (one class for `DRAFT_CHANGED`, say) are deferred. If they come, they will be an opt-in trait mapping `code` values to subclasses of the status class, so existing `catch` and `except` blocks keep working.

### 6.3 Fields every error carries

| Field                     | Source                                                  |
| ------------------------- | ------------------------------------------------------- |
| `status`                  | The HTTP status of the response, always. A `status` in the body is ignored for this field: a proxy or a faulty handler can put the wrong number there, and the HTTP status is what the client got. The class is chosen by the HTTP status too (section 6.2). A failure event on a stream (section 5.5) has no HTTP status of its own, so its body `status` is used. |
| `code`                    | Body `code`, else `HTTP_<status>`.                      |
| `title`, `detail`, `type` | Body.                                                   |
| `requestId`               | Body `requestId`, else the `Caitlyn-Request-Id` header; empty when neither has one. |
| `retryAfterSeconds`       | `Retry-After`, on 429 and 503.                          |
| `rawBody`                 | The response body as received, as text (invalid UTF-8 replaced; an SDK may keep only the first 1 MiB). Empty for an empty body and for errors the SDK raises itself. TypeScript `rawBody`, Python and Rust `raw_body`, Go `RawBody`. |

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
- every `@examples` entry in the model, as a request the mock server answers with the example's output or error (design guide, section 14);
- sign-in: each mode, the shared token request and early renewal, and the one retry after a 401 (section 12).

## 12. Sign-in

How an SDK gets the credential it sends. The TypeScript runtime (`@caitlyn-ai/sdk-core`, `auth.ts`), the Python runtime (`caitlyn_core.auth`, for both the synchronous and the asynchronous client), the Go runtime (`go/core`, `auth.go` and `aws.go`) and the Rust runtime (`caitlyn-sdk-core`, `auth.rs` and `aws.rs`) implement this section; the conformance cases `auth.*` test it, and fail for any SDK whose runtime does not implement it yet.

### 12.1 The workspace, the endpoint and the audience

- The client is created for a **workspace**, given as a hostname (`your-company.getcaitlyn.ai`) or a URL (`https://your-company.getcaitlyn.ai/`). The SDK reduces it to the hostname.
- The workspace sets two things:
  - the **endpoint**, `https://<workspace>/api`: operation paths (`/v3/…`) and the sign-in paths (`/oauth/token`, `/oauth/authorize`) are appended to it;
  - the **token audience**, always `https://<workspace>/api`: the `resource` parameter of every token request and authorisation URL, and the audience of the AWS identity token in `awsIam` mode. It is one audience for the workspace's whole REST API, v2 and v3 alike; there is no separate v3 audience. (The server also accepts `https://<workspace>/api/v3`, which SDK versions up to 0.0.2 request, as an alias.)
- An `endpoint` client option (a proxy, a local app) replaces the base URL, so requests and the sign-in paths go there. It never changes the audience: a token is always for the workspace the client names.
- A mode that offers a `resource` option (`clientCredentials`, `oauth`, `workloadIdentity` in TypeScript) uses it in place of the workspace audience. `awsIam` offers `audience` instead, which changes only the audience of the AWS identity token.

### 12.2 Modes

Every mode except `token` and `session` ends in the same thing: a short-lived Caitlyn access token from `{endpoint}/oauth/token`, sent as `Authorization: Bearer <token>`. Token requests are `POST`s with an `application/x-www-form-urlencoded` body and `Accept: application/json`.

| Mode                | What the caller gives                                        | How the SDK gets the token                                                                                                                                                                                                                                                                                                                       |
| ------------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`             | A personal access token.                                     | None: the token is sent as it is, and never renewed.                                                                                                                                                                                                                                                                                            |
| `clientCredentials` | Client ID and secret; optional scopes.                       | `grant_type=client_credentials` with `client_id`, `client_secret`, `resource` and, when scopes are given, `scope` (space-separated). Asked again when the token is due for renewal; there is no refresh token.                                                                                                                                 |
| `oauth`             | Client ID; client secret on a server only; redirect URI; scopes; a token store. | Authorisation code with PKCE, then refresh tokens (below).                                                                                                                                                                                                                                                                     |
| `awsIam`            | Optional region, credentials, signing algorithm, lifetime, audience. | STS `GetWebIdentityToken` on the regional STS endpoint, then an RFC 8693 token exchange of the JWT it returns (below).                                                                                                                                                                                                                 |
| `workloadIdentity`  | A function that returns a JWT from another trusted issuer (a GitLab CI `id_tokens` variable, for example). | The function is called at every sign-in and its JWT exchanged (RFC 8693, below). The server accepts each JWT once, for the exact audience, before it expires, so the SDK never keeps or reuses one.                                                                                                 |
| `session`           | The browser session (a cookie, given on a server; in a browser the browser sends its own) and an optional Origin. | None. No `Authorization` header is sent. The cookie goes in `Cookie` when given, and every request other than `GET` and `HEAD` carries `Origin` (default `https://<workspace>`). For the Caitlyn app itself and local recording.                                                            |

**`oauth`.**

1. *Start:* the SDK builds `{endpoint}/oauth/authorize?response_type=code&client_id=…&redirect_uri=…&code_challenge=…&code_challenge_method=S256&state=…&resource=…[&scope=…]`. The PKCE verifier is 48 random bytes, base64url-encoded; the challenge is the base64url SHA-256 of the verifier. `state` is random unless the caller gives one. A redirect URI is required. The caller keeps the state and the verifier.
2. *Callback:* when the caller passes the state it expects, a different returned state fails with `invalid_state` before any request. Then `grant_type=authorization_code` with `code`, `code_verifier`, `redirect_uri`, `resource`, `client_id` and, for a confidential client, `client_secret`. The tokens are saved to the token store (default: in memory for the life of the client).
3. *Calls:* the SDK loads the store. A stored access token with more than a minute left (or no expiry), and that is not the token this client already holds or last saw refused, is used as it is (another process signed in or refreshed). Otherwise the stored refresh token is used: `grant_type=refresh_token` with `refresh_token`, `client_id` and `client_secret` when there is one. The new tokens are saved; when the response has no refresh token, the old one is kept. A refresh refused with `invalid_grant` clears the store and fails the call with that code. With nothing to refresh, the call fails with `sign_in_required` and sends nothing.
4. *Sign-out:* a `POST` to the token endpoint with `action=revoke`, `token=<refresh token>` and the client parameters, whose failure is ignored; then the cached token and the store are cleared.

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
- In `token` and `session` mode a 401 is raised at once: the SDK has no other credential to try.

### 12.5 Sign-in errors

A failed token request is a sign-in error (`CaitlynAuthError` in TypeScript and Python), not one of the operation error classes of section 6.2. It carries:

| Field       | Source                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------- |
| `code`      | The OAuth `error` (`invalid_client`, `invalid_grant`…), else the body's `code`, else `http_<status>`. |
| `message`   | `error_description`, else `detail`.                                                          |
| `status`    | The HTTP status.                                                                             |
| `requestId` | The `Caitlyn-Request-Id` header.                                                             |

A token response without `access_token` is a sign-in error too. Errors the SDK raises itself use the same class with these codes: `sign_in_required` (`oauth` with no tokens), `invalid_state` (the callback's state does not match), `invalid_request` (a missing redirect URI or region, or an `oauth` step on a client in another mode), and the STS code or `aws_identity_failed` (`awsIam`). A 401 from an operation is not a sign-in error: it is section 6.2's class for 401, after section 12.4's retry.
