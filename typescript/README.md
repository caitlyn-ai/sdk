# Caitlyn SDK for TypeScript

> **Preview.** This SDK needs a Caitlyn with the v3 API, which is not released yet, and its API will change
> before version 1.0.

`@caitlyn-ai/sdk` is the TypeScript client for the Caitlyn v3 API. It runs on Node 20 and later, Bun, Deno,
browsers and edge runtimes, ships ECMAScript modules and CommonJS with types, and has no AWS runtime: its
only telemetry dependency is the OpenTelemetry API.

```bash
npm install @caitlyn-ai/sdk
```

Runnable examples are in `examples/typescript/` in the SDK repository.

## Creating a client

`workspace` is your workspace's hostname. `auth.mode` says how the client signs in. Every mode except
`session` ends in the same short-lived Caitlyn bearer token, which the client caches and renews a minute
before it expires, one request at a time however many calls are waiting.

```ts
import { Caitlyn } from '@caitlyn-ai/sdk';

// A script using a personal access token (it starts cait-pat-)
const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });
```

| Mode | For | Options |
| --- | --- | --- |
| `token` | Scripts run by a person, with a personal access token | `token` |
| `clientCredentials` | A registered machine integration (an API client) outside AWS | `clientId`, `clientSecret`, `scopes` |
| `oauth` | An application acting as a signed-in person | `clientId`, `clientSecret` (servers only), `redirectUri`, `scopes`, `tokenStore` |
| `awsIam` | A workload on AWS (Lambda, ECS, AgentCore), with no stored secret | `region`, `credentials`, `signingAlgorithm` |
| `workloadIdentity` | A CI job or other workload with an OpenID Connect token (GitLab CI `id_tokens`) | `token`: a function returning the current token |
| `session` | The Caitlyn app itself, or a tool driving a local app with a session cookie | `cookie` (server side only), `origin` |

The workspace works as a region does in the AWS SDKs: it decides where requests go (`https://<workspace>/api`)
and the audience every token is bound to (`https://<workspace>/api`). `endpoint` overrides only where
requests go, for a proxy or a local app; the audience still comes from the workspace. `caitlyn.auth.workspace`
and `caitlyn.auth.resource` show what the client uses.

### Signing in as a person (`oauth`)

```ts
const app = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'oauth', clientId, clientSecret, redirectUri: 'https://app.example.com/callback', scopes: ['chat:write'], tokenStore },
});

// Start: send the person to `url`, and keep `state` and `codeVerifier` (in their session, for example)
const { url, state, codeVerifier } = await app.auth.authorizationUrl();

// The callback: checks the state, exchanges the code and saves the tokens in tokenStore
await app.auth.handleCallback({ code, state: returnedState, expectedState: state, codeVerifier });
```

`tokenStore` is `{load, save, clear}`, so an application can keep each person's tokens encrypted on its own
server. Without one, tokens live in memory for the life of the client. Refresh is automatic. A refresh token
the server refuses (`invalid_grant`) clears the store and fails the call with `CaitlynAuthError`, code
`invalid_grant`; sign the person in again.

### Workloads on AWS (`awsIam`)

```ts
const worker = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'awsIam', region: 'ap-southeast-2' } });
```

The client calls AWS STS `GetWebIdentityToken` on the regional endpoint with the workload's own AWS
credentials, and exchanges the AWS-signed token for a Caitlyn token. No secret is stored, and no AWS SDK is
needed: the client signs that one request itself. It finds credentials in `AWS_ACCESS_KEY_ID` and
`AWS_SECRET_ACCESS_KEY` (AWS Lambda) or the container credentials endpoint (ECS, Fargate, AgentCore). For
anything else, such as profiles or single sign-on, pass any AWS SDK credential provider:

```ts
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
new Caitlyn({ workspace, auth: { mode: 'awsIam', region: 'ap-southeast-2', credentials: fromNodeProviderChain() } });
```

Code the browser never needs stays out of its bundle: the request signer loads only when a client signs in
with `awsIam`.

Outbound identity federation must be turned on in the AWS account, and the workspace must have an API client
that trusts the account's issuer and the role.

### CI jobs (`workloadIdentity`)

```yaml
# .gitlab-ci.yml
publish:
  id_tokens:
    CAITLYN_ID_TOKEN:
      aud: https://your-company.getcaitlyn.ai/api
```

```ts
new Caitlyn({ workspace, auth: { mode: 'workloadIdentity', token: () => process.env.CAITLYN_ID_TOKEN! } });
```

### In a browser

In a browser page, use `oauth` without a `clientSecret` (authorisation code with PKCE), or `session` for the
Caitlyn app itself. Creating a client with `clientCredentials`, `oauth` with a `clientSecret`, `awsIam` or
`workloadIdentity` throws `CaitlynAuthError` with code `not_allowed_in_browser`: a client secret in a page is
visible to everyone who loads it, and the other two sign in server workloads. `token` mode works but warns once
per client, because a long-lived token in a page is exposed; it is for local testing, and
`allowBrowserToken: true` on the mode silences the warning.

## Calls

Every operation is a method on a namespace (`caitlyn.documents.list`) and also a standalone function that
takes a client (`listDocuments(client, …)`). Import the standalone functions and `createCaitlynClient` for
the smallest bundle; a bundler then keeps only the operations you use.

```ts
import { createCaitlynClient, getAgentVersion } from '@caitlyn-ai/sdk';
const client = createCaitlynClient({ workspace, auth });
const draft = await getAgentVersion(client, { agentId: 'GHT7YRWXPL', version: 'draft' });
```

- **Lists** are async iterables that fetch the next page as you go: `for await (const doc of caitlyn.documents.list({knowledgeBaseId}))`.
- **Streams** (`conversations.send`) are async iterables of typed events. If the connection drops, the
  client re-attaches from the last event it saw, so no event is lost or repeated. `await stream.finalMessage()` returns the finished answer.
- **Updates** take `ifMatch` (the ETag you read) as a call option, and `clear: [...]` to return members to their defaults.
- **Creates** take an `idempotencyKey` call option; without one the client makes one per call and reuses it on retries.
- **Cancellation and timeouts:** every call takes `signal`. Use `AbortSignal.timeout(ms)` for a deadline.
- **Retries:** 429 and 503, and connection failures, are retried up to `maxAttempts` (default 3), only for
  reads, idempotent operations and creates with their idempotency key. `Retry-After` is honoured up to
  `maxRetryDelayMs` (default 60 seconds).
- **Unknown fields** the server added after this SDK was built are kept on each result's `raw`.
- **Older servers:** calling an operation or member the server is too old for fails before sending, with `NotSupportedByServer`.

## Errors

Every API error is a `CaitlynError` subclass, one per status (`ValidationError`, `NotFoundError`,
`ConflictError`, `PreconditionFailedError`, `TooManyRequestsError`…), carrying the problem details: `status`,
`code`, `title`, `detail`, `requestId` (quote it to Caitlyn support) and, on a 400, `errors`, one entry per
field. An error page from something in front of the API (an HTML 404, a proxy's 502) is the same class for its
status, with `code` `HTTP_<status>` and the page in `rawBody`. A call that got no response (a refused or reset
connection, a DNS or TLS failure) is `CaitlynConnectionError`, a `CaitlynError` with `status` 0, `code`
`CONNECTION_ERROR` and the network error as its `cause`. Sign-in failures are `CaitlynAuthError`, with the OAuth
error code.

A result's `$metadata` has the response's `httpStatusCode` and `requestId`.

```ts
try {
  await caitlyn.versions.updateDraft('GHT7YRWXPL', { instructions }, { ifMatch: etag });
} catch (err) {
  if (err instanceof PreconditionFailedError) { /* someone else changed it: read again and reapply */ }
  else if (err instanceof ValidationError) for (const e of err.errors ?? []) console.error(e.pointer, e.code, e.detail);
  else throw err;
}
```

## Waiting

`waitUntil…()` methods poll until the resource reaches a final state, and take `signal` and `maxWaitMs`. A
failure state throws `WaiterError`. They are generated from the model's `@waitable` traits, so they appear as
operations gain them.

## Your own HTTP handler

`requestHandler` gives this client its own HTTP handler, for a private certificate authority, a proxy or
keep-alive settings, without changing the process-wide default:

```ts
import https from 'node:https';
import { NodeHttpHandler } from '@smithy/node-http-handler';

const caitlyn = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
  requestHandler: new NodeHttpHandler({ httpsAgent: new https.Agent({ ca: fs.readFileSync('ca.pem') }) }),
});
```

Sign-in requests go through the `fetch` option, which takes your own `fetch` the same way.

## Telemetry

The client creates OpenTelemetry spans for each call (`caitlyn.call`), each HTTP attempt (`caitlyn.attempt`) and
an upload's bytes (`caitlyn.upload`), with the names and attributes every Caitlyn SDK uses (`model/PROTOCOL.md`
section 13), and passes `traceparent` on, with whatever tracer provider your application has registered. With none registered it costs nothing. Pass
`telemetry: {tracerProvider}` to use another provider, or `telemetry: {enabled: false}` to switch it off.

## Runtimes

| Runtime | Entry | HTTP |
| --- | --- | --- |
| Node and Bun, ECMAScript modules | `dist-es` | Node's `http`/`https` |
| Node, CommonJS | `dist-cjs` | Node's `http`/`https` |
| Browsers, Deno, Cloudflare Workers, Vercel Edge (the `browser`, `worker`, `workerd`, `deno` and `edge-light` export conditions) | `dist-browser` | `fetch` |

## Licence

Apache License 2.0. See `LICENSE` and `NOTICE`.
