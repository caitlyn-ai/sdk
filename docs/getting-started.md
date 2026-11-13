---
pageType: guide
sinceVersion: 5000115000000
resources:
  - version
  - workspace
integrations: []
operations:
  - GetAgentVersion
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
# Not on PyPI yet: install both packages from the same release tag
pip install "caitlyn-core @ git+https://github.com/caitlyn-ai/sdk@{{sdkRelease}}#subdirectory=python/caitlyn-core" \
            "caitlyn @ git+https://github.com/caitlyn-ai/sdk@{{sdkRelease}}#subdirectory=python/caitlyn"
```
```sh tab="Go"
# The module path does not resolve yet: build against a copy of the release
git clone --depth 1 --branch {{sdkRelease}} https://github.com/caitlyn-ai/sdk caitlyn-sdk
go mod edit -require github.com/caitlyn-ai/caitlyn-go@v0.0.0 \
            -replace github.com/caitlyn-ai/caitlyn-go=./caitlyn-sdk/go
go mod tidy
```
```toml tab="Rust"
# Cargo.toml. Not on crates.io yet: depend on the release tag
[dependencies]
caitlyn-sdk = { git = "https://github.com/caitlyn-ai/sdk", tag = "{{sdkRelease}}" }
tokio = { version = "1", features = ["macros", "rt-multi-thread"] }
```

`{{sdkRelease}}` is the latest release; the [tags](https://github.com/caitlyn-ai/sdk/tags) list every release.

## Make a first call

Create a client for your workspace, then call an operation. This reads the draft version of an agent: its
configuration, and the ETag you would send to change it. Put your own agent's ID in place of `GHT7YRWXPL`.

<!-- example: examples/typescript/getting-started.ts#first-call -->
```ts tab="TypeScript"
import { Caitlyn } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
});

// Read the draft of an agent: its configuration and its ETag
const draft = await caitlyn.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
console.log(draft.configuration.instructions);
```
<!-- example: examples/python/getting_started.py#first-call -->
```python tab="Python"
import os

from caitlyn import Caitlyn
from caitlyn.auth import Token

caitlyn = Caitlyn(workspace="your-company.getcaitlyn.ai", auth=Token(os.environ["CAITLYN_TOKEN"]))

# Read the draft of an agent: its configuration and its ETag
draft = caitlyn.versions.get(agent_id="GHT7YRWXPL", version="draft")
print(draft.configuration.instructions)
```
<!-- example: examples/go/gettingstarted/main.go#first-call -->
```go tab="Go"
import (
	"context"
	"fmt"
	"log"
	"os"

	caitlyn "github.com/caitlyn-ai/caitlyn-go"
)

func main() {
	ctx := context.Background()
	client, err := caitlyn.NewClient("your-company.getcaitlyn.ai", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")))
	if err != nil {
		log.Fatal(err)
	}

	// Read the draft of an agent: its configuration and its ETag
	draft, err := client.Versions.Get(ctx, &caitlyn.GetAgentVersionInput{AgentID: "GHT7YRWXPL", Version: "draft"})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(draft.Configuration.Instructions)
}

```
<!-- example: examples/rust/src/bin/getting_started.rs#first-call -->
```rust tab="Rust"
use caitlyn_sdk::{Auth, Client, GetAgentVersionInput};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let client = Client::new("your-company.getcaitlyn.ai", Auth::token(std::env::var("CAITLYN_TOKEN")?))?;

    // Read the draft of an agent: its configuration and its ETag
    let draft = client
        .versions()
        .get(GetAgentVersionInput { agent_id: "GHT7YRWXPL".into(), version: "draft".into() })
        .await?;
    println!("{}", draft.configuration.instructions);
    Ok(())
}
```

[GetAgentVersion](/reference/get-agent-version/) has the whole result, and what each error means.

## The workspace

`workspace` is your workspace's hostname, such as `your-company.getcaitlyn.ai`. It decides two things, the way a
region does in the AWS SDKs: where requests go (`https://<workspace>/api`), and the audience every token the
client gets is bound to. A token for one workspace is refused by every other.

To send requests somewhere else, such as a proxy or a Caitlyn running on your machine, set the client's
`endpoint` option. The token audience still comes from the workspace.

## Versions and older servers

Each SDK knows which Caitlyn release introduced each operation and member. Once a client has had a response from
your workspace, it knows the server's version (the `Caitlyn-Api-Version` header), and it refuses to call an
operation, or send a member, that the server is too old for: it raises `NotSupportedByServer` (Go
`NotSupportedByServerError`, Rust `Error::NotSupportedByServer`) before sending anything. Each reference page
says which release an operation needs.

The API only grows: a newer server adds operations, members, enum values and events, and never removes or
renames them. The SDKs keep what they do not know: unknown members are in each result's `raw`, an unknown enum
value is kept as its string, and an unknown event is skipped. So an older SDK keeps working against a newer
server.

## Next

- [Authentication](/authentication/): sign in as a service, as a person, or as a workload on AWS or in CI.
- [Errors](/errors/): what each failure looks like, and which ones to handle.
- [Streaming](/streaming/): ask an agent a question and stream the answer.
