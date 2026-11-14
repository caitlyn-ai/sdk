---
pageType: concept
sinceVersion: 5000115000000
resources:
  - workspace
integrations:
  - workload-identity
operations: []
---

# Authentication

A client signs in one of six ways, chosen by its `auth` option. Every way except `token` and `session` ends in
the same thing: a short-lived Caitlyn access token, which the client caches, renews before it expires and sends
as `Authorization: Bearer <token>`. You never handle that token yourself.

| Mode | Use it for | You give it |
| --- | --- | --- |
| [`token`](#a-personal-access-token) | Scripts you run yourself, and trying things out | A personal access token |
| [`clientCredentials`](#a-service-client-credentials) | A service or integration acting as itself | An API client's ID and secret |
| [`oauth`](#a-person-oauth) | An app acting as the person using it | An API client's ID (and secret, on a server), a redirect URI |
| [`awsIam`](#a-workload-on-aws-awsiam) | A workload on AWS (Lambda, ECS, AgentCore), with no stored secret | Nothing: the workload's own AWS credentials |
| [`workloadIdentity`](#a-ci-job-or-other-workload-workloadidentity) | A CI job, or another workload with an OpenID Connect token | A function returning the token |
| [`session`](#the-caitlyn-app-session) | The Caitlyn app itself, and tools driving a local copy of it | The app's session cookie |

Every token is for one workspace: its audience is `https://<workspace>/api`, the workspace the client was created
for, and every other workspace refuses it.

## A personal access token

A personal access token acts as you, with your permissions, until it expires or you revoke it. It is sent as it
is and never renewed. Use it for your own scripts and for trying the API; never put one in code other people run.

<!-- example: examples/typescript/sign-in-modes.ts#token -->
```ts tab="TypeScript"
const script = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! }, // a personal access token, cait-pat-…
});
```
<!-- example: examples/python/sign_in_modes.py#token -->
```python tab="Python"
script = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Token(os.environ["CAITLYN_TOKEN"]),  # a personal access token, cait-pat-…
)
```
<!-- example: examples/go/signin/signin.go#token -->
```go tab="Go"
script, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
	caitlyn.Token(os.Getenv("CAITLYN_TOKEN"))) // a personal access token, cait-pat-…
```
<!-- example: examples/rust/src/sign_in_modes.rs#token -->
```rust tab="Rust"
let script = Client::new(
    "your-company.getcaitlyn.ai",
    Auth::token(std::env::var("CAITLYN_TOKEN")?),
)?;
```

## A service: client credentials

A registered API client signs in with its ID and secret and acts as itself, with the scopes it was given. The
client asks for a new token when the old one is due; there is no refresh token. Keep the secret in a secret
store, never in code.

<!-- example: examples/typescript/sign-in-modes.ts#client-credentials -->
```ts tab="TypeScript"
const service = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: {
    mode: 'clientCredentials',
    clientId: process.env.CAITLYN_CLIENT_ID!,
    clientSecret: process.env.CAITLYN_CLIENT_SECRET!,
    scopes: ['api:read'],
  },
});
```
<!-- example: examples/python/sign_in_modes.py#client-credentials -->
```python tab="Python"
service = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=ClientCredentials(
        client_id=os.environ["CAITLYN_CLIENT_ID"],
        client_secret=os.environ["CAITLYN_CLIENT_SECRET"],
        scopes=["api:read"],
    ),
)
```
<!-- example: examples/go/signin/signin.go#client-credentials -->
```go tab="Go"
service, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.ClientCredentials{
	ClientID:     os.Getenv("CAITLYN_CLIENT_ID"),
	ClientSecret: os.Getenv("CAITLYN_CLIENT_SECRET"),
	Scopes:       []string{"api:read"},
})
```
<!-- example: examples/rust/src/sign_in_modes.rs#client-credentials -->
```rust tab="Rust"
let service = Client::new(
    "your-company.getcaitlyn.ai",
    Auth::client_credentials(
        std::env::var("CAITLYN_CLIENT_ID")?,
        std::env::var("CAITLYN_CLIENT_SECRET")?,
    )
    .scopes(["api:read"]),
)?;
```

## A person: OAuth

An app signs a person in with the OAuth authorisation code flow and PKCE, then acts as that person. The client
builds the sign-in address; you send the person there and keep the `state` and the PKCE verifier until Caitlyn
sends them back to your redirect URI.

<!-- example: examples/typescript/sign-in-modes.ts#oauth -->
```ts tab="TypeScript"
const asPerson = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: {
    mode: 'oauth',
    clientId: process.env.CAITLYN_CLIENT_ID!,
    clientSecret: process.env.CAITLYN_CLIENT_SECRET, // only on a server; a browser app has none
    redirectUri: 'https://app.example.com/caitlyn/callback',
    scopes: ['api:write'],
    tokenStore: encryptedTokenStoreFor(userId), // { load, save, clear }; default: in memory
  },
});

// Send the person to `url`, and keep `state` and `codeVerifier` for the callback
const { url, state, codeVerifier } = await asPerson.auth.authorizationUrl();
```
<!-- example: examples/python/sign_in_modes.py#oauth -->
```python tab="Python"
as_person = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=OAuth(
        client_id=os.environ["CAITLYN_CLIENT_ID"],
        client_secret=os.environ.get("CAITLYN_CLIENT_SECRET"),  # a confidential client on a server
        redirect_uri="https://app.example.com/caitlyn/callback",
        scopes=["api:write"],
        token_store=encrypted_token_store_for(user_id),  # load, save, clear; default: in memory
    ),
)

# Send the person to start.url, and keep start.state and start.code_verifier for the callback
start = as_person.auth.authorization_url()
```
<!-- example: examples/go/signin/signin.go#oauth -->
```go tab="Go"
asPerson, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.OAuth{
	ClientID:     os.Getenv("CAITLYN_CLIENT_ID"),
	ClientSecret: os.Getenv("CAITLYN_CLIENT_SECRET"), // a confidential client on a server
	RedirectURI:  "https://app.example.com/caitlyn/callback",
	Scopes:       []string{"api:write"},
	TokenStore:   encryptedTokenStoreFor(userID), // default: in memory
})
if err != nil {
	return err
}

// Send the person to start.URL, and keep start.State and start.CodeVerifier for the callback
start, err := asPerson.Auth().AuthorizationURL(ctx, caitlyn.AuthorizationOptions{})
```
<!-- example: examples/rust/src/sign_in_modes.rs#oauth -->
```rust tab="Rust"
let as_person = Client::new(
    "your-company.getcaitlyn.ai",
    Auth::oauth(std::env::var("CAITLYN_CLIENT_ID")?)
        .client_secret(std::env::var("CAITLYN_CLIENT_SECRET")?) // a confidential client on a server
        .redirect_uri("https://app.example.com/caitlyn/callback")
        .scopes(["api:write"])
        .token_store(Arc::new(MemoryTokenStore::new(None))), // your own encrypted store on a server
)?;

// Send the person to start.url, and keep start.state and start.code_verifier for the callback
let start = as_person.auth().authorization_url(None, None, None)?;
```

Then, on the redirect URI, hand the client the code. It checks the state, exchanges the code and saves the tokens
to the token store:

<!-- example: examples/typescript/sign-in-modes.ts#oauth-callback -->
```ts tab="TypeScript"
declare const code: string;
declare const returnedState: string;
await asPerson.auth.handleCallback({ code, state: returnedState, expectedState: state, codeVerifier });
```
<!-- example: examples/python/sign_in_modes.py#oauth-callback -->
```python tab="Python"
as_person.auth.handle_callback(
    code=code,
    state=returned_state,
    expected_state=start.state,
    code_verifier=start.code_verifier,
)
```
<!-- example: examples/go/signin/signin.go#oauth-callback -->
```go tab="Go"
_, err = asPerson.Auth().HandleCallback(ctx, caitlyn.Callback{
	Code:          code,
	State:         returnedState,
	ExpectedState: start.State,
	CodeVerifier:  start.CodeVerifier,
})
```
<!-- example: examples/rust/src/sign_in_modes.rs#oauth-callback -->
```rust tab="Rust"
as_person
    .auth()
    .handle_callback(Callback {
        code,
        state: Some(returned_state),
        expected_state: Some(start.state),
        code_verifier: start.code_verifier,
        ..Default::default()
    })
    .await?;
```

- **Refresh is automatic.** Refresh tokens are single use: each refresh returns a new one, which the client saves
  to the token store. A refresh token the server refuses fails the call with the sign-in error `invalid_grant`
  and clears the store: sign the person in again.
- **The token store** keeps the tokens between processes. On a server, keep them encrypted, one store per person.
  Without one, they live in memory for the life of the client.
- **Signing out** (`auth.signOut()`, Python `auth.sign_out()`, Go `Auth().SignOut`, Rust `auth().sign_out()`)
  revokes the refresh token and clears the store.
- **In a browser**, use `oauth` without a client secret. [Sign in from a browser](/guides/sign-in-from-a-browser/)
  covers both patterns, and what the TypeScript SDK refuses in a page.

## A workload on AWS: awsIam

> **Not available yet.** The SDKs have this mode, but Caitlyn workspaces do not accept workload sign-in yet.

A workload on AWS signs in with its own IAM role: no secret is stored anywhere. The client asks AWS STS
(`GetWebIdentityToken`, on the regional endpoint) for a token AWS signs, and exchanges it for a Caitlyn token.
The SDKs sign that one request themselves, so no AWS SDK is needed.

<!-- example: examples/typescript/sign-in-modes.ts#aws-iam -->
```ts tab="TypeScript"
const worker = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'awsIam', region: 'ap-southeast-2' }, // the workload's own AWS credentials
});
```
<!-- example: examples/python/sign_in_modes.py#aws-iam -->
```python tab="Python"
worker = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=AwsIam(region="ap-southeast-2"),  # the workload's own AWS credentials
)
```
<!-- example: examples/go/signin/signin.go#aws-iam -->
```go tab="Go"
worker, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
	caitlyn.AWSIAM{Region: "ap-southeast-2"}) // the workload's own AWS credentials
```
<!-- example: examples/rust/src/sign_in_modes.rs#aws-iam -->
```rust tab="Rust"
let worker = Client::new(
    "your-company.getcaitlyn.ai",
    Auth::aws_iam().region("ap-southeast-2"),
)?;
```

- **Credentials** come from `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` (as Lambda sets them), then the
  container credentials endpoint (ECS, Fargate, AgentCore). For anything else, such as profiles or single
  sign-on, pass a credentials provider. This is the only mode that reads `AWS_*` variables.
- **The region** is the option, then `AWS_REGION`, then `AWS_DEFAULT_REGION`.
- **Setting up:** outbound identity federation must be turned on in the AWS account, and the workspace needs an
  API client that trusts the account's issuer and the role.

## A CI job or other workload: workloadIdentity

> **Not available yet.** The SDKs have this mode, but Caitlyn workspaces do not accept workload sign-in yet.

A workload with an OpenID Connect token from an issuer the workspace trusts, such as a GitLab CI job's
`id_tokens`, exchanges that token for a Caitlyn one. The function you give is called at every sign-in, because
Caitlyn accepts each token once, only for the exact audience `https://<workspace>/api`, and only before it
expires.

```yaml
# .gitlab-ci.yml
publish:
  id_tokens:
    CAITLYN_ID_TOKEN:
      aud: https://your-company.getcaitlyn.ai/api
```

<!-- example: examples/typescript/sign-in-modes.ts#workload-identity -->
```ts tab="TypeScript"
const ciJob = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'workloadIdentity', token: () => process.env.CAITLYN_ID_TOKEN! }, // GitLab CI id_tokens
});
```
<!-- example: examples/python/sign_in_modes.py#workload-identity -->
```python tab="Python"
ci_job = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=WorkloadIdentity(token=lambda: os.environ["CAITLYN_ID_TOKEN"]),  # GitLab CI id_tokens
)
```
<!-- example: examples/go/signin/signin.go#workload-identity -->
```go tab="Go"
ciJob, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.WorkloadIdentity{
	Token: func(context.Context) (string, error) { return os.Getenv("CAITLYN_ID_TOKEN"), nil }, // GitLab CI id_tokens
})
```
<!-- example: examples/rust/src/sign_in_modes.rs#workload-identity -->
```rust tab="Rust"
let ci_job = Client::new(
    "your-company.getcaitlyn.ai",
    WorkloadIdentity::from_env("CAITLYN_ID_TOKEN"),
)?;
```

## The Caitlyn app: session

`session` sends the Caitlyn app's own session cookie instead of a token, and an `Origin` header on every write.
It is for the Caitlyn app's own pages; an integration uses one of the other modes.

<!-- example: examples/typescript/sign-in-modes.ts#session -->
```ts tab="TypeScript"
const appPage = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'session', cookie: sessionCookie, origin: 'https://your-company.getcaitlyn.ai' },
});
```
<!-- example: examples/python/sign_in_modes.py#session -->
```python tab="Python"
app_page = Caitlyn(
    workspace="your-company.getcaitlyn.ai",
    auth=Session(cookie=session_cookie, origin="https://your-company.getcaitlyn.ai"),
)
```
<!-- example: examples/go/signin/signin.go#session -->
```go tab="Go"
appPage, err := caitlyn.NewClient("your-company.getcaitlyn.ai",
	caitlyn.Session{Cookie: sessionCookie, Origin: "https://your-company.getcaitlyn.ai"})
```
<!-- example: examples/rust/src/sign_in_modes.rs#session -->
```rust tab="Rust"
let app_page = Client::new(
    "your-company.getcaitlyn.ai",
    Auth::session(session_cookie).origin("https://your-company.getcaitlyn.ai"),
)?;
```

## Rules every credential follows

Caitlyn issues three kinds of credential. The modes above use them:

| Credential | Acts as | Created in | Modes |
| --- | --- | --- | --- |
| Personal access token | The person who created it | The **Personal access tokens** panel on their profile page | `token` |
| API client (a machine integration in the app) | The role chosen when it was created | **Settings → API Integrations** | `clientCredentials`, `awsIam`, `workloadIdentity` |
| User-authorised application | The person who approved it | Your application's own sign-in, through Caitlyn's consent screen | `oauth` |

[Managing API Credentials](#managing-credentials) explains where an administrator issues, re-issues and revokes each one.

- **A credential never does more than the identity behind it.** Scopes narrow; they never widen. A personal
  access token granted `knowledge-bases:write` still reaches only the knowledge bases its owner can reach, and if
  the owner's access is reduced, the token's is reduced with it on its next request.
- **A personal access token has a lower ceiling than an API client.** It can never hold the **Developer tools**
  area, which can switch off document access control, and it holds **Roles and access** at read only, because a
  token able to rewrite its owner's role could widen itself. Both limits hold even for a token granted everything.
  If creating a token refuses a scope you expected, this is usually why, and an API client is the credential to
  use instead.
- **Every credential expires**, on a date chosen when it is created: up to a year ahead, with no never-expires
  option. An API client's secret is re-issued from its row on the **API Integrations** page; the client keeps its
  ID, role and scopes, and the old secret stops working at once.
- **Revoking takes effect on the next request**, not when the credential would have expired.
- **Every secret Caitlyn issues starts with `cait-`**: `cait-pat-` for a personal access token, `cait-secret-`
  for an API client's secret. One pattern in a secret scanner covers them all. Older tokens with an `mcp_`
  prefix keep working.
- **Credentials are for one surface.** A credential issued for the REST API is refused by Caitlyn's MCP server,
  and one issued for the MCP server is refused by the API, so a credential granted for one integration cannot be
  replayed against the other.
- **No token can create or revoke credentials.** That is done in the Caitlyn app while signed in; a token gets
  [`NOT_AVAILABLE_TO_CREDENTIALS`](/errors/NOT_AVAILABLE_TO_CREDENTIALS/).
- **Keep secrets on a server.** Never put a token or client secret in browser code, a mobile app or a public
  repository. A browser app signs in as described in [Sign in from a browser](/guides/sign-in-from-a-browser/).

### What a person sees when they authorise your application {#consent-screen}

In `oauth` mode, the person reaches Caitlyn's consent screen before anything is granted. It names your
application, and says it will act as them and can never do more than they can. It asks whether to grant
everything their account can reach or a named set of areas, with a level for each. Nothing is issued until they
select **Authorise**; cancelling returns them to your redirect URI with no credential created. An administrator
sees every application their people have authorised, and can withdraw one at any time, so plan for a connection
ending without your application being told.

### Managing credentials {#managing-credentials}

Issuing, re-issuing and revoking credentials is done in the Caitlyn app. The **Managing API Credentials** guide in
Caitlyn's Help walks through each screen.

## When a token is refused

- **One token, renewed early.** A client keeps one access token and renews it a minute before it expires (or
  halfway through a life shorter than two minutes). However many calls need a new token at once, the client makes
  one request for it, and they all wait for that.
- **One more try after a 401.** In the `clientCredentials`, `oauth`, `awsIam` and `workloadIdentity` modes, a 401
  makes the client drop its token, get a new one and send the call once more, whatever the operation. A second
  401 is raised as the [`UNAUTHENTICATED`](/errors/UNAUTHENTICATED/) error. In `token` and `session` mode a 401
  is raised at once.
- **Sign-in errors** are a separate class from the API's errors: `CaitlynAuthError` in TypeScript and Python,
  `*caitlyn.AuthError` in Go, `Error::Auth` in Rust. `code` is the OAuth error (`invalid_client`,
  `invalid_grant`), or one of the SDK's own: `sign_in_required` (`oauth` with no tokens yet), `invalid_state`
  (the callback's state does not match), `invalid_request` (a missing redirect URI or region), `aws_identity_failed`
  (`awsIam` could not get its AWS token), and in a browser `not_allowed_in_browser`.
