---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Retries

The SDKs retry a failed call for you, but only when that is safe and only when trying again might help. Every
SDK follows the same rules.

## What is retried

- **Only operations that are safe to repeat:** reads, operations that are idempotent, and creates that carry an
  idempotency key. Each operation's reference page says whether the SDKs retry it. Anything else, such as
  sending a message, is sent once, whatever goes wrong.
- **Only failures that may pass:** 429 [`RATE_LIMITED`](/errors/RATE_LIMITED/), 503
  [`SERVICE_UNAVAILABLE`](/errors/SERVICE_UNAVAILABLE/), and calls that got no response at all (a refused or reset
  connection, a DNS failure, a timeout before the response headers). Nothing else is retried: not a 500, and
  not a call whose response had started to arrive.
- **At most three attempts** in all, the first included, and only while the client's
  [retry budget](#the-retry-budget) lasts. Then the last error is raised.

## How long it waits

- When the response has `Retry-After`, the SDK waits exactly that long, up to the longest wait you allow
  (60 seconds by default). A `Retry-After` longer than that fails the call at once with the typed error, so you
  never wait longer than you said.
- Otherwise it waits a random time between 0 and `0.5 s × 2^retry`, at most 8 seconds ("full jitter"), so that
  many clients failing at once do not all come back at once.
- Cancelling the call (an abort signal, a cancelled context or task) stops the wait.

## Idempotency keys

A create that carries an `Idempotency-Key` can be retried without making two of anything: the server answers a
repeat of the same key with the first request's result. The SDKs make a new key for every call and send the
same key on each of that call's retries. To make your own retry of a whole call safe (after a crash, say), pass
your own key as a call option and reuse it.

Reusing a key with a different body is refused with [`IDEMPOTENCY_KEY_REUSED`](/errors/IDEMPOTENCY_KEY_REUSED/),
and a repeat that arrives while the first is still running gets
[`IDEMPOTENCY_KEY_IN_USE`](/errors/IDEMPOTENCY_KEY_IN_USE/).

## Changing the limits

<!-- example: examples/typescript/concepts.ts#retries -->
```ts tab="TypeScript"
const patient = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
  maxAttempts: 5, // the first attempt included; default 3
  maxRetryDelayMs: 120_000, // the longest Retry-After to wait for; default 60 seconds
});
```
<!-- example: examples/python/concepts.py#retries -->
```python tab="Python"
patient = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Token(os.environ["CAITLYN_TOKEN"]),
    max_attempts=5,  # the first attempt included; default 3
    max_retry_delay=120,  # seconds: the longest Retry-After to wait for; default 60
)
```
<!-- example: examples/go/concepts/concepts.go#retries -->
```go tab="Go"
patient, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
	caitlyn.WithMaxAttempts(5),               // the first attempt included; default 3
	caitlyn.WithMaxRetryDelay(2*time.Minute), // the longest Retry-After to wait for; default 60 s
)
```
<!-- example: examples/rust/src/concepts.rs#retries -->
```rust tab="Rust"
let patient = Client::builder("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))
    .max_attempts(5) // the first attempt included; default 3
    .max_retry_delay(Duration::from_secs(120)) // the longest Retry-After to wait for; default 60 s
    .build()?;
```

## The retry budget

Each client also has a budget for retries, shared by all its calls, so that when Caitlyn is failing or
overloaded your client does not multiply every call by its retries:

- The budget starts full, at 500 tokens. A retry costs 5 tokens, or 10 when the attempt it repeats got no response
  at all. The cost is taken when the retry is decided, before the wait.
- When the budget holds less than a retry costs, the call fails at once with the error it got, without waiting.
- A call that succeeds puts tokens back, up to the full budget: the cost of its last retry if it retried, or 1 if
  it did not. A call that fails puts nothing back.
- The first attempt of a call is never blocked: the budget only decides retries. The one extra try after a 401
  (below) costs nothing.

With the default three attempts, a client spends its whole budget on 50 calls in a row that each fail twice, and
a healthy client earns tokens back with every success, so an occasional failure never empties it. These are the
numbers of the AWS SDKs' "standard" retry mode. A client that makes many calls at once, such as a batch job, may
want a bigger budget; a budget of 0 turns retries off.

<!-- example: examples/typescript/concepts.ts#retry-budget -->
```ts tab="TypeScript"
const batch = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
  retryBudget: 2_000, // retry tokens shared by every call on this client; default 500, and 0 turns retries off
});
```
<!-- example: examples/python/concepts.py#retry-budget -->
```python tab="Python"
batch = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Token(os.environ["CAITLYN_TOKEN"]),
    retry_budget=2000,  # retry tokens shared by every call on this client; default 500, and 0 turns retries off
)
```
<!-- example: examples/go/concepts/concepts.go#retry-budget -->
```go tab="Go"
batch, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")),
	caitlyn.WithRetryBudget(2000), // retry tokens shared by every call on this client; default 500, and 0 turns retries off
)
```
<!-- example: examples/rust/src/concepts.rs#retry-budget -->
```rust tab="Rust"
let batch = Client::builder("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))
    .retry_budget(2000) // retry tokens shared by every call on this client; default 500, and 0 turns retries off
    .build()?;
```

The SDKs do not slow themselves down to a rate of their own choosing. Caitlyn says when to slow down, with 429
and `Retry-After`, and the SDKs follow it.

A 401 is handled separately: in the modes that renew tokens, the SDK gets a new token and sends the call once
more, for every operation, without counting it as a retry ([Authentication](/authentication/#when-a-token-is-refused)).
