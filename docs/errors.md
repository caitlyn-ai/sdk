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

<!-- example: examples/typescript/concepts.ts#errors -->
```ts tab="TypeScript"
try {
  await caitlyn.versions.get({ agentId, version: 'v99' });
} catch (err) {
  if (err instanceof NotFoundError) {
    console.log('No such version');
  } else if (err instanceof ValidationError) {
    for (const e of err.errors ?? []) console.error(e.pointer, e.code, e.detail);
  } else if (err instanceof CaitlynConnectionError) {
    console.error('No response from Caitlyn:', err.cause); // after the SDK's retries
  } else if (err instanceof CaitlynError) {
    // Any other status. code is the stable product code; quote requestId to support.
    console.error(err.status, err.code, err.detail, err.requestId);
    if (err.code.startsWith('HTTP_')) console.error(err.rawBody); // not a Caitlyn error body: a proxy's page, say
  } else {
    throw err;
  }
}
```
<!-- example: examples/python/concepts.py#errors -->
```python tab="Python"
try:
    caitlyn.versions.get(agent_id=agent_id, version="v99")
except NotFoundError:
    print("No such version")
except ValidationError as err:
    for e in err.errors:  # one per member or parameter at fault
        print(e.pointer, e.code, e.detail)
except CaitlynConnectionError as err:
    print("No response from Caitlyn:", err.__cause__)  # after the SDK's retries
except CaitlynError as err:
    # Any other status. code is the stable product code; quote request_id to support.
    print(err.status, err.code, err.detail, err.request_id)
    if err.code.startswith("HTTP_"):
        print(err.raw_body)  # not a Caitlyn error body: a proxy's page, say
```
<!-- example: examples/go/concepts/concepts.go#errors -->
```go tab="Go"
_, err := client.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: "GHT7YRWXPL", Version: "v99"})
var notFound *caitlyn.NotFoundError
var invalid *caitlyn.ValidationError
var noResponse *caitlyn.ConnectionError
var apiErr *caitlyn.Error
switch {
case err == nil:
case errors.As(err, &notFound):
	fmt.Println("No such version")
case errors.As(err, &invalid):
	for _, e := range invalid.Errors {
		fmt.Println(e.Pointer, e.Code, e.Detail)
	}
case errors.As(err, &noResponse):
	fmt.Println("No response from Caitlyn:", noResponse.Cause) // after the SDK's retries
case errors.As(err, &apiErr):
	// Any other status. Code is the stable product code; quote RequestID to support.
	fmt.Println(apiErr.Status, apiErr.Code, apiErr.Detail, apiErr.RequestID)
	if apiErr.RawBody != "" && apiErr.Title == "" {
		fmt.Println(apiErr.RawBody) // not a Caitlyn error body: a proxy's page, say
	}
default:
	log.Fatal(err)
}
```
<!-- example: examples/rust/src/concepts.rs#errors -->
```rust tab="Rust"
let input = GetAgentVersionInput { agent_id: "GHT7YRWXPL".into(), version: "v99".into() };
match client.versions().get(input).await {
    Ok(version) => println!("{}", version.name),
    Err(Error::NotFound(_)) => println!("No such version"),
    Err(Error::Validation(err)) => {
        for e in &err.errors {
            println!("{:?} {:?} {:?}", e.pointer, e.code, e.detail);
        }
    }
    Err(Error::Connection(err)) => println!("No response from Caitlyn: {err}"), // after the SDK's retries
    Err(err) => {
        // Any other error. code() is the stable product code; quote request_id() to support.
        println!("{:?} {:?} {:?}", err.status(), err.code(), err.request_id());
        return Err(err);
    }
}
```

- **The class follows the HTTP status**, whether or not the operation lists that error: a 404 is always
  `NotFoundError`. A status no error class has (a 405, a proxy's 502) is the base class, `CaitlynError` (Go
  `*caitlyn.Error`, Rust `Error::Api`).
- **Match on `code`, not on the message.** `code` is stable: once shipped, a code keeps its meaning and is never
  renamed. Several codes can share a status; each has [its own page](#error-codes).
- **Quote `requestId`** (Python and Rust `request_id`, Go `RequestID`) to Caitlyn support. It is also in the
  `Caitlyn-Request-Id` header of every response.

## The fields

| Field | What it holds |
| --- | --- |
| `status` | The HTTP status of the response, always (a `status` in the body is ignored for this). |
| `code` | The stable code, for example `NOT_FOUND`, or `HTTP_<status>` when the body is not a Caitlyn error. |
| `title`, `detail`, `type` | A short summary, what went wrong this time, and the code's page here. |
| `requestId` | The request's identifier. |
| `retryAfterSeconds` | On 429 and 503: how long to wait, from `Retry-After`. |
| `errors` | On 400 `VALIDATION_FAILED`: one entry per member or parameter at fault. |
| `rawBody` | The response body as received, as text, at most its first 8 KiB (Python and Rust `raw_body`, Go `RawBody`). |
| `rawBodyTruncated` | True when the body was longer than 8 KiB and `rawBody` holds only its start. |

## When the body is not a Caitlyn error

Something in front of Caitlyn can answer instead of it: a load balancer's `502` page, or an HTML `404` for an
address that does not exist. That is still the typed error for its status, never a parsing error. Its `code` is
`HTTP_<status>` (`HTTP_502`), `title`, `detail` and `type` are empty, and the body is in `rawBody`, so you can see
what actually answered.

## When there is no response

A call that gets no response at all (a refused or reset connection, a DNS or TLS failure, a timeout before the
response headers), or whose connection fails while the body is being read, fails with the connection error once
the SDK's [retries](/retries/) are spent:

| Language | Error | It is also | The network error |
| --- | --- | --- | --- |
| TypeScript | `CaitlynConnectionError` | a `CaitlynError` | `cause` |
| Python | `CaitlynConnectionError` | a `CaitlynError` | `__cause__` |
| Go | `*caitlyn.ConnectionError` | an `*caitlyn.Error` (`errors.As` finds either) | `Cause`, and `Unwrap()` |
| Rust | `Error::Connection` | `status()` and `code()` read it like any other | `source()` |

Its `status` is 0 and its `code` is `CONNECTION_ERROR`. Cancelling a call yourself is never a connection error:
you get your language's own cancellation error.

## Errors the SDK raises itself

These have `status` 0 and nothing was received from Caitlyn:

| Code | When |
| --- | --- |
| `CONNECTION_ERROR` | No response (above). |
| `STREAM_LOST` | A [stream](/streaming/) dropped and could not be resumed after three tries. |
| `NO_FINAL_EVENT` | `finalMessage()` on a stream that ended without its final event, such as a resumed stream whose answer had already finished. |
| `UPLOAD_PUT_FAILED` | An upload helper could not send the file's bytes to the upload address. |

Two more are separate classes: `NotSupportedByServer`, raised before sending when the server is too old for the
call ([Getting started](/getting-started/#versions-and-older-servers)), and the sign-in error, `CaitlynAuthError`,
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
