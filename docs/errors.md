---
pageType: error
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Errors

Every error the API returns is an [RFC 9457](https://www.rfc-editor.org/rfc/rfc9457) problem details object, and
every SDK raises it as a typed error you can tell apart by HTTP status and by code.

```json
{
  "type": "https://build.caitlyn.ai/errors/NOT_FOUND",
  "title": "Not found",
  "status": 404,
  "code": "NOT_FOUND",
  "detail": "No knowledge base KBNOPE0000",
  "requestId": "01JC9Q2W7R4M0H2T6N1S8V3B5X"
}
```

## Handling errors

**The class follows the HTTP status**, whether or not the operation lists that error: a 404 is always the not-found
error. Catch the class when the status is all you need:

<!-- example: examples/typescript/concepts.ts#errors-class -->
```ts tab="TypeScript"
// The class follows the HTTP status: a 404 is a NotFoundError, whichever call made it
try {
  await caitlyn.agents(agentId).versions('v99').get();
} catch (err) {
  if (!(err instanceof NotFoundError)) throw err;
  console.log('No such version');
}
```
<!-- example: examples/python/concepts.py#errors-class -->
```python tab="Python"
# The class follows the HTTP status: a 404 is a NotFoundError, whichever call made it
try:
    caitlyn.agents(agent_id).versions("v99").get()
except NotFoundError:
    print("No such version")
```
<!-- example: examples/go/concepts/concepts.go#errors-class -->
```go tab="Go"
// The class follows the HTTP status: a 404 is a *caitlyn.NotFoundError, whichever call made it
_, err := client.Agent("GHT7YRWXPL").Version("v99").Get(ctx)
var notFound *caitlyn.NotFoundError
if errors.As(err, &notFound) {
	fmt.Println("No such version")
	return nil
}
```
<!-- example: examples/rust/src/concepts.rs#errors-class -->
```rust tab="Rust"
// The variant follows the HTTP status: a 404 is Error::NotFound, whichever call made it
match client.agent("GHT7YRWXPL").version("v99").get().await {
    Ok(version) => println!("{}", version.name),
    Err(Error::NotFound(_)) => println!("No such version"),
    Err(err) => return Err(err),
}
```

**Every error is also the base Caitlyn error**, with a `code`: match on it, not on the message. A code is stable: once
shipped, it keeps its meaning and is never renamed. Several codes can share a status; each has
[its own page](#error-codes), and each SDK has a constant for it. A status no error class has (a 405, a proxy's 502)
is the base error only. Quote the `requestId` to Caitlyn support; it is also in the `Caitlyn-Request-Id` header of
every response.

<!-- example: examples/typescript/concepts.ts#errors-code -->
```ts tab="TypeScript"
// Every error is a CaitlynError: match on its code, and quote its requestId to Caitlyn support
try {
  await caitlyn.agents(agentId).versions('v99').get();
} catch (err) {
  if (!(err instanceof CaitlynError)) throw err;
  if (err.code === ErrorCode.NOT_FOUND) console.log('No such version');
  console.error(err.status, err.code, err.detail, err.requestId);
  if (err.code.startsWith('HTTP_')) console.error(err.rawBody); // not a Caitlyn error body: a proxy's page, say
}
```
<!-- example: examples/python/concepts.py#errors-code -->
```python tab="Python"
# Every error is a CaitlynError: match on its code, and quote its request_id to Caitlyn support
try:
    caitlyn.agents(agent_id).versions("v99").get()
except CaitlynError as err:
    if err.code == ErrorCode.NOT_FOUND:
        print("No such version")
    print(err.status, err.code, err.detail, err.request_id)
    if err.code.startswith("HTTP_"):
        print(err.raw_body)  # not a Caitlyn error body: a proxy's page, say
```
<!-- example: examples/go/concepts/concepts.go#errors-code -->
```go tab="Go"
// Every error is a *caitlyn.Error: match on its Code, and quote its RequestID to Caitlyn support
_, err := client.Agent("GHT7YRWXPL").Version("v99").Get(ctx)
var apiErr *caitlyn.Error
if errors.As(err, &apiErr) {
	if apiErr.Code == caitlyn.ErrorCodeNotFound {
		fmt.Println("No such version")
	}
	fmt.Println(apiErr.Status, apiErr.Code, apiErr.Detail, apiErr.RequestID)
	if strings.HasPrefix(apiErr.Code, "HTTP_") {
		fmt.Println(apiErr.RawBody) // not a Caitlyn error body: a proxy's page, say
	}
}
```
<!-- example: examples/rust/src/concepts.rs#errors-code -->
```rust tab="Rust"
// Every error has a code(): match on it, and quote its request_id() to Caitlyn support
if let Err(err) = client.agent("GHT7YRWXPL").version("v99").get().await {
    if err.code() == Some(ErrorCode::NOT_FOUND) {
        println!("No such version");
    }
    println!("{:?} {:?} {:?}", err.status(), err.code(), err.request_id());
}
```

**A refused request names what was wrong.** A 400 `VALIDATION_FAILED` has one entry in `errors` per member (by
`pointer`, a JSON Pointer into the body) or query parameter (by `parameter`) at fault:

<!-- example: examples/typescript/concepts.ts#errors-validation -->
```ts tab="TypeScript"
// A refused request names each member or parameter at fault
try {
  await caitlyn.knowledgeBases.list({ limit: 500 }).page();
} catch (err) {
  if (!(err instanceof ValidationError)) throw err;
  for (const e of err.errors ?? []) console.error(e.parameter ?? e.pointer, e.code, e.detail);
}
```
<!-- example: examples/python/concepts.py#errors-validation -->
```python tab="Python"
# A refused request names each member or parameter at fault
try:
    caitlyn.knowledge_bases.list(limit=500).page()
except ValidationError as err:
    for e in err.errors:
        print(e.parameter or e.pointer, e.code, e.detail)
```
<!-- example: examples/go/concepts/concepts.go#errors-validation -->
```go tab="Go"
// A refused request names each member or parameter at fault
_, err := client.KnowledgeBases.ListPage(ctx, &caitlyn.ListKnowledgeBasesInput{Limit: caitlyn.Ptr[int32](500)})
var invalid *caitlyn.ValidationError
if errors.As(err, &invalid) {
	for _, e := range invalid.Errors {
		fmt.Println(e.Parameter, e.Pointer, e.Code, e.Detail)
	}
}
```
<!-- example: examples/rust/src/concepts.rs#errors-validation -->
```rust tab="Rust"
// A refused request names each member or parameter at fault
if let Err(Error::Validation(err)) = client.knowledge_bases().list().limit(500).page().await {
    for e in &err.errors {
        println!(
            "{:?} {:?} {} {:?}",
            e.parameter, e.pointer, e.code, e.detail
        );
    }
}
```

**No response at all** is the connection error, [below](#when-there-is-no-response):

<!-- example: examples/typescript/concepts.ts#errors-connection -->
```ts tab="TypeScript"
// No response at all, after the SDK's retries: the network error is kept as the cause
try {
  await caitlyn.agents(agentId).get();
} catch (err) {
  if (!(err instanceof CaitlynConnectionError)) throw err;
  console.error('No response from Caitlyn:', err.cause);
}
```
<!-- example: examples/python/concepts.py#errors-connection -->
```python tab="Python"
# No response at all, after the SDK's retries: the network error is kept as the cause
try:
    caitlyn.agents(agent_id).get()
except CaitlynConnectionError as err:
    print("No response from Caitlyn:", err.__cause__)
```
<!-- example: examples/go/concepts/concepts.go#errors-connection -->
```go tab="Go"
// No response at all, after the SDK's retries: the network error is kept as the cause
_, err := client.Agent("GHT7YRWXPL").Get(ctx)
var noResponse *caitlyn.ConnectionError
if errors.As(err, &noResponse) {
	fmt.Println("No response from Caitlyn:", errors.Unwrap(noResponse))
}
```
<!-- example: examples/rust/src/concepts.rs#errors-connection -->
```rust tab="Rust"
// No response at all, after the SDK's retries: the network error is kept as the source
if let Err(Error::Connection(err)) = client.agent("GHT7YRWXPL").get().await {
    println!(
        "No response from Caitlyn: {:?}",
        std::error::Error::source(&err)
    );
}
```

## Conditional writes: ETags and If-Match

Every thing you read carries an `etag`. A write that changes a thing takes it back as `If-Match`, a call option, and
the rule is the same everywhere:

- **On these writes `If-Match` is optional.** Leave it out and the write applies to the thing as it stands:
<!-- if-match-optional -->
- **Send the ETag you last read to guard the write.** If the thing changed since, the write is refused with 412
  [`PRECONDITION_FAILED`](/errors/PRECONDITION_FAILED/): read it again and reapply your change rather than overwrite
  someone else's.
- **Every other write requires it.** Without `If-Match` it is refused with 428
  [`PRECONDITION_REQUIRED`](/errors/PRECONDITION_REQUIRED/). Each operation's page says which it is.

<!-- example: examples/typescript/concepts.ts#errors-if-match -->
```ts tab="TypeScript"
// Change a thing only if nobody else has since you read it: send back the ETag you read
const kb = caitlyn.knowledgeBases('KB4T7YQ2WL');
const current = await kb.get();
try {
  await kb.update({ description: 'HR policies, 2026' }, { ifMatch: current.etag });
} catch (err) {
  if (!(err instanceof PreconditionFailedError)) throw err;
  console.log('It changed since you read it: read it again and reapply your change');
}
```
<!-- example: examples/python/concepts.py#errors-if-match -->
```python tab="Python"
# Change a thing only if nobody else has since you read it: send back the ETag you read
kb = caitlyn.knowledge_bases("KB4T7YQ2WL")
current = kb.get()
try:
    kb.update(description="HR policies, 2026", if_match=current.etag)
except PreconditionFailedError:
    print("It changed since you read it: read it again and reapply your change")
```
<!-- example: examples/go/concepts/concepts.go#errors-if-match -->
```go tab="Go"
// Change a thing only if nobody else has since you read it: send back the ETag you read
kb := client.KnowledgeBase("KB4T7YQ2WL")
current, err := kb.Get(ctx)
if err != nil {
	return err
}
_, err = kb.Update(ctx, &caitlyn.UpdateKnowledgeBaseInput{Description: caitlyn.Ptr("HR policies, 2026")}, caitlyn.WithIfMatch(current.ETag))
var changed *caitlyn.PreconditionFailedError
if errors.As(err, &changed) {
	fmt.Println("It changed since you read it: read it again and reapply your change")
	return nil
}
```
<!-- example: examples/rust/src/concepts.rs#errors-if-match -->
```rust tab="Rust"
// Change a thing only if nobody else has since you read it: send back the ETag you read
let kb = client.knowledge_base("KB4T7YQ2WL");
let current = kb.get().await?;
match kb
    .update()
    .description("HR policies, 2026")
    .if_match(&current.etag)
    .await
{
    Ok(_) => {}
    Err(Error::PreconditionFailed(_)) => {
        println!("It changed since you read it: read it again and reapply your change")
    }
    Err(err) => return Err(err),
}
```

## The fields

Each SDK spells these in its own style (the examples above show it).

| Field | What it holds |
| --- | --- |
| `status` | The HTTP status of the response, always (a `status` in the body is ignored for this). |
| `code` | The stable code, for example `NOT_FOUND`, or `HTTP_<status>` when the body is not a Caitlyn error. Each code the API documents has a constant in each SDK. A constant is the code itself, so comparing with the string works the same, and a code your SDK version does not know yet is still a string. |
| `title`, `detail`, `type` | A short summary, what went wrong this time, and the code's page here. |
| `requestId` | The request's identifier. |
| `retryAfterSeconds` | On 429 and 503: how long to wait, from `Retry-After`. On a 409 `TARGET_IN_USE` or `DOCUMENT_INGESTION_IN_PROGRESS`: when to try again (the SDKs never retry a 409 themselves). |
| `errors` | On 400 `VALIDATION_FAILED`: one entry per member or parameter at fault. |
| `rawBody` | The response body as received, as text, at most its first 8 KiB. |
| `rawBodyTruncated` | True when the body was longer than 8 KiB and `rawBody` holds only its start. |

## When the body is not a Caitlyn error

Something in front of Caitlyn can answer instead of it: a load balancer's `502` page, or an HTML `404` for an
address that does not exist. That is still the typed error for its status, never a parsing error. Its `code` is
`HTTP_<status>` (`HTTP_502`), `title`, `detail` and `type` are empty, and the body is in `rawBody`, so you can see
what actually answered.

## When there is no response

A call that gets no response at all (a refused or reset connection, a DNS or TLS failure, a timeout before the
response headers), or whose connection fails while the body is being read, fails with the connection error once
the SDK's [retries](/retries/) are spent. It is a kind of the base Caitlyn error, and it keeps the network error
as its cause ([the example above](#handling-errors) reads it). Its `status` is 0 and its `code` is `CONNECTION_ERROR`. Cancelling a call yourself is never a connection error:
you get your language's own cancellation error.

## Errors the SDK raises itself

These have `status` 0 and nothing was received from Caitlyn. Each has a constant beside the API's codes. Any failure
during a call reaches you as one of these, never as the language's own error: that error is kept as the cause, read
as the connection error's is. Every SDK raises each of them wherever its case can happen:

| Code | When |
| --- | --- |
| `CONNECTION_ERROR` | No response (above). |
| `STREAM_LOST` | A [stream](/streaming/) or a watch dropped and could not be resumed after three tries. |
| `NO_FINAL_EVENT` | `finalMessage()` on a stream that ended without its final event, such as a resumed stream whose answer had already finished. |
| `WAIT_TIMEOUT` | A wait's time limit passed. |
| `CANCELLED` | The work a wait followed was cancelled, or a sync's plan was declined. |
| `DECODE_FAILED` | A response or an event could not be read as the operation's output. |
| `SERIALIZATION_FAILED` | A request could not be serialised. |
| `HTTP_CLIENT_FAILED` | The HTTP client could not be built, or could not make the request. Not in TypeScript, which sends with `fetch`. |
| `JOB_FAILED` | A job ended failed without an error code of its own. |
| `INGESTION_BATCH_FAILED` | An ingestion batch ended failed without a failure code of its own. |
| `FILE_UNREADABLE` | A file could not be read. |
| `FILE_TOO_LARGE` | A file is larger than the operation accepts. |
| `FILE_CHANGED` | A file's size or bytes no longer match what was described for it. |
| `UPLOAD_PUT_FAILED` | An upload helper could not send the file's bytes to the upload address. |
| `UPLOAD_FAILED` | A file's upload still failed after its retries: only its item fails, in a sync or a batch upload. |
| `UPLOAD_POLICY_MISSING` | A batch gave no upload policy for the files awaiting upload. |
| `INGESTION_ITEM_REFUSED` | An item a sync added to its batch was refused; the message names the item and why. |
| `INGESTION_ITEM_HAS_NO_FILE` | A sync's batch awaits a file the call has none for. |
| `INGESTION_BATCH_NOT_PLANNED` | [Estimate the upload](/reference/helpers/batch-upload-estimate/) on a draft batch: add its last items first. |
| `INGESTION_BATCH_NOT_STARTED` | [Upload files](/reference/helpers/batch-upload/) on a batch that has not started: start it with `batch.start()`. |

Three come from one SDK only, because their case exists only there: `REDIRECT_UNREADABLE` (TypeScript in a browser,
a redirect whose address the browser hid from the page: use `download()` instead), `FILE_ALREADY_READ` (Go, one
`io.Reader` given to two calls) and `BAD_METHOD` (Rust, an HTTP method its HTTP client cannot use).

Two more are separate classes: `NotSupportedByServer`, raised when the server is too old for the call, before
sending or from the server's own answer ([Getting started](/getting-started/#versions-and-older-servers)), and the sign-in error, `CaitlynAuthError`,
when a token could not be got ([Authentication](/authentication/#when-a-token-is-refused)).

## Error codes

| Code | Status | Error class |
| --- | --- | --- |
| [`VALIDATION_FAILED`](/errors/VALIDATION_FAILED/) | 400 | `ValidationError` |
| [`UNKNOWN_FIELD`](/errors/UNKNOWN_FIELD/) | 400 | `ValidationError` |
| [`UNKNOWN_FILTER`](/errors/UNKNOWN_FILTER/) | 400 | `ValidationError` |
| [`UNKNOWN_SORT`](/errors/UNKNOWN_SORT/) | 400 | `ValidationError` |
| [`INVALID_CURSOR`](/errors/INVALID_CURSOR/) | 400 | `ValidationError` |
| [`UNAUTHENTICATED`](/errors/UNAUTHENTICATED/) | 401 | `UnauthenticatedError` |
| [`PERMISSION_DENIED`](/errors/PERMISSION_DENIED/) | 403 | `PermissionDeniedError` |
| [`NOT_AVAILABLE_TO_CREDENTIALS`](/errors/NOT_AVAILABLE_TO_CREDENTIALS/) | 403 | `PermissionDeniedError` |
| [`PRIMARY_WORKSPACE_REQUIRED`](/errors/PRIMARY_WORKSPACE_REQUIRED/) | 403 | `PermissionDeniedError` |
| [`NOT_FOUND`](/errors/NOT_FOUND/) | 404 | `NotFoundError` |
| [`CONFLICT`](/errors/CONFLICT/) | 409 | `ConflictError` |
| [`ALREADY_EXISTS`](/errors/ALREADY_EXISTS/) | 409 | `ConflictError` |
| [`IDEMPOTENCY_KEY_IN_USE`](/errors/IDEMPOTENCY_KEY_IN_USE/) | 409 | `ConflictError` |
| [`OPERATION_NOT_CANCELLABLE`](/errors/OPERATION_NOT_CANCELLABLE/) | 409 | `ConflictError` |
| [`PRECONDITION_FAILED`](/errors/PRECONDITION_FAILED/) | 412 | `PreconditionFailedError` |
| [`PAYLOAD_TOO_LARGE`](/errors/PAYLOAD_TOO_LARGE/) | 413 | `PayloadTooLargeError` |
| [`IDEMPOTENCY_KEY_REUSED`](/errors/IDEMPOTENCY_KEY_REUSED/) | 422 | `UnprocessableContentError` |
| [`PRECONDITION_REQUIRED`](/errors/PRECONDITION_REQUIRED/) | 428 | `PreconditionRequiredError` |
| [`RATE_LIMITED`](/errors/RATE_LIMITED/) | 429 | `TooManyRequestsError` |
| [`INTERNAL`](/errors/INTERNAL/) | 500 | `InternalError` |
| [`SERVICE_UNAVAILABLE`](/errors/SERVICE_UNAVAILABLE/) | 503 | `ServiceUnavailableError` |

Two more codes come from the server's routing rather than an operation, so no operation lists them. The SDKs raise
`NotSupportedByServer` for both ([Getting started](/getting-started/#versions-and-older-servers)):

| Code | Status | Raised as |
| --- | --- | --- |
| [`UNKNOWN_OPERATION`](/errors/UNKNOWN_OPERATION/) | 404 | `NotSupportedByServer`: the server has no operation at that address |
| [`METHOD_NOT_ALLOWED`](/errors/METHOD_NOT_ALLOWED/) | 405 | `NotSupportedByServer`: the address, but not that method |
