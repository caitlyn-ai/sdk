---
pageType: guide
sinceVersion: 5000115000000
resources:
  - version
  - workspace
integrations: []
operations:
  - GetAgentVersion
  - GetCaller
---

# Getting started

Install an SDK, create a client for your workspace, and read an agent's draft.

You need a Caitlyn workspace and a credential for it. The quickest is a personal access token from your
workspace (it starts `cait-pat-`); put it in the `CAITLYN_TOKEN` environment variable.
[Authentication](/authentication/) covers the other ways to sign in, which are what you use for anything other
people run.

## Install

```sh tab="TypeScript"
npm install @caitlyn-ai/sdk
```
```sh tab="Python"
pip install caitlyn
# or, in a uv project
uv add caitlyn
```
```sh tab="Go"
go get github.com/caitlyn-ai/sdk/go@latest
```
```sh tab="Rust"
cargo add caitlyn-sdk
# the examples run on tokio
cargo add tokio --features macros,rt-multi-thread
```

Every SDK has the same version number. See [Releases](https://github.com/caitlyn-ai/sdk/releases) for the latest
version and what changed.

## Install the CLI

The `caitlyn` command line does the same from a terminal or a script, and needs no code.

```sh tab-install="macOS and Linux"
curl -fsSL https://build.caitlyn.ai/releases/cli/install.sh | sh
```
```sh tab-install="Windows"
irm https://build.caitlyn.ai/releases/cli/install.ps1 | iex
```
```sh tab-install="Homebrew"
brew install caitlyn-ai/tap/caitlyn
```
```sh tab-install="Scoop"
scoop bucket add caitlyn https://github.com/caitlyn-ai/scoop-bucket
scoop install caitlyn
```
```sh tab-install="Container"
docker run --rm ghcr.io/caitlyn-ai/caitlyn:0.12 caitlyn version
```

Sign in, then check who you are:

```sh
caitlyn auth login --workspace your-company.caitlyn.ai
caitlyn me
```

The [CLI's Install section](/cli/#install) has more about each, and [Installing the CLI](/cli/install/) how to verify a release.

## Make a first call

Create a client for your workspace, then call an operation. This reads the draft version of an agent: its
configuration, and its ETag, for a change that must not overwrite someone else's. Put your own agent's ID in place of `GHT7YRWXPL`.

<!-- example: examples/typescript/getting-started.ts#first-call -->
```ts tab="TypeScript"
import { Caitlyn } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({
  workspace: 'your-company.caitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
});

// Read the draft of an agent: its configuration and its ETag
const draft = await caitlyn.agents('GHT7YRWXPL').draft.get();
console.log(draft.configuration?.guidance?.instructions);
```
<!-- example: examples/python/getting_started.py#first-call -->
```python tab="Python"
import os

from caitlyn import Caitlyn
from caitlyn.auth import Token

caitlyn = Caitlyn(workspace="your-company.caitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))

# Read the draft of an agent: its configuration and its ETag
draft = caitlyn.agents("GHT7YRWXPL").draft.get()
print(draft.configuration.guidance.instructions if draft.configuration and draft.configuration.guidance else "")
```
<!-- example: examples/go/gettingstarted/main.go#first-call -->
```go tab="Go"
import (
	"context"
	"fmt"
	"log"
	"os"

	caitlyn "github.com/caitlyn-ai/sdk/go"
)

func main() {
	ctx := context.Background()
	client, err := caitlyn.NewClient("your-company.caitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")))
	if err != nil {
		log.Fatal(err)
	}

	// Read the draft of an agent: its configuration and its ETag
	draft, err := client.Agent("GHT7YRWXPL").Draft().Get(ctx)
	if err != nil {
		log.Fatal(err)
	}
	if g := draft.Configuration.Guidance; g != nil && g.Instructions != nil {
		fmt.Println(*g.Instructions)
	}
}

```
<!-- example: examples/rust/src/bin/getting_started.rs#first-call -->
```rust tab="Rust"
use caitlyn_sdk::{Auth, Client};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new(
        "your-company.caitlyn.ai",
        Auth::token(std::env::var("CAITLYN_TOKEN")?),
    )?;

    // Read the draft of an agent: its configuration and its ETag (draft.etag)
    let draft = client.agent("GHT7YRWXPL").draft().get().await?;
    println!(
        "{}",
        draft
            .configuration
            .as_ref()
            .and_then(|c| c.guidance.as_ref())
            .and_then(|g| g.instructions.as_deref())
            .unwrap_or_default()
    );
    Ok(())
}
```

[GetAgentVersion](/reference/get-agent-version/) has the whole result, and what each error means.

## Check who you are

[GetCaller](/reference/get-caller/) returns who the client is signed in as: the person or API client, the kind
of credential, its scopes and the organisation. It needs no permission, so it is the quickest way to check that
a token works.

<!-- example: examples/typescript/conversations.ts#get-caller -->
```ts tab="TypeScript"
// Check the credential before doing anything else: any valid credential may call this
const me = await caitlyn.me();
console.log(`${me.displayName} (${me.credential}) in ${me.organisation.name}; scopes: ${me.scopes.join(' ')}`);
```
<!-- example: examples/python/conversations.py#get-caller -->
```python tab="Python"
me = caitlyn.me()
print(me.display_name, me.credential, me.scopes)  # who this credential belongs to, and what it may do
```
<!-- example: examples/go/conversations/conversations.go#get-caller -->
```go tab="Go"
caller, err := client.Me(ctx)
if err != nil {
	return nil, err
}
fmt.Println(caller.DisplayName, caller.Credential, caller.Organisation.Name, caller.Scopes)
```
<!-- example: examples/rust/src/conversations.rs#get-caller -->
```rust tab="Rust"
let caller = client.me().await?;
println!(
    "{} ({:?}) in {}",
    caller.display_name, caller.credential, caller.organisation.name
);
println!("scopes: {}", caller.scopes.join(" "));
```

## The workspace

`workspace` is your workspace's hostname, such as `your-company.caitlyn.ai`. It decides two things, the way a
region does in the AWS SDKs: where requests go (`https://<workspace>/api`), and the audience every token the
client gets is bound to. A token for one workspace is refused by every other.

To send requests somewhere else, such as a proxy or a Caitlyn running on your machine, set the client's
`endpoint` option. The token audience still comes from the workspace.

## Versions and older servers

Each SDK knows which Caitlyn release introduced each operation and member. Once a client has had a response from
your workspace, it knows the server's version (the `Caitlyn-Api-Version` header), and it refuses to call an
operation, or send a member, that the server is too old for: it raises `NotSupportedByServer` before sending
anything, naming the operation, the release it needs and the server's version. On a first call, before it knows the
version, a server that does not have the operation says so, and the SDK raises the same error from that answer. Each
reference page says which release an operation needs.

The API only grows: a newer server adds operations, members, enum values and events, and never removes or
renames them. The SDKs keep what they do not know: unknown members are in each result's `raw`, an unknown enum
value is kept as its string, and an unknown event is skipped. So an older SDK keeps working against a newer
server.

## Next

- [How to integrate](/how-to-integrate/): the other ways in, from embedding the chat to MCP.
- [Authentication](/authentication/): sign in as a service, as a person, or as a workload on AWS or in CI.
- [Errors](/errors/): what each failure looks like, and which ones to handle.
- [Streaming](/streaming/): ask an agent a question and stream the answer.
