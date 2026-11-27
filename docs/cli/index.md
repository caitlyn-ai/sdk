---
pageType: cli
sinceVersion: 0
resources:
  - agent
  - knowledge-base
  - conversation
integrations: []
operations: []
---

# The Caitlyn CLI

`caitlyn` is Caitlyn on the command line: agents and their versions, knowledge bases and their documents, conversations and events, from a terminal, a script or a CI job. It is built on the Go SDK and released with the SDKs, at the same version, so a command and its SDK method always do the same thing.

Every command comes from the same description of the API the SDKs are built from, so the command for an SDK method is easy to guess: `caitlyn.agents(id).draft.save()` in TypeScript is `caitlyn agents draft save <agent>`. The thing a command acts on is its argument, and the things above it are flags: `caitlyn kb documents get <document> --kb <kb>`.

## Install

Choose how to install it; your choice is remembered on every page.

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

Archives for every platform, deb and rpm packages, and their checksums are at `https://build.caitlyn.ai/releases/cli/<version>/`. The installers check the release's signed manifest, then each download's SHA-256 against it. `caitlyn update` updates an install made with the script or an archive; for the others it tells you the command to run, such as `brew upgrade caitlyn`. [Installing the CLI](/cli/install/) has the options, how to verify a release yourself, and how updates and rollbacks work.

Then sign in to your workspace:

```sh
caitlyn auth login --workspace your-company.caitlyn.ai
```

## A first session

A list is a table, and one thing a detail view with its nested members summarised. The tabs show the same result in the other output formats; your choice is remembered on every page.

<!-- example: examples/cli/output-formats.sh#agents -->
```sh
caitlyn agents list
```

<!-- output: examples/cli/output-formats.sh -->
```text tab-output="Table"
NAME          ID          LIVE VERSION  UPDATED AT
──────────────────────────────────────────────────
HR assistant  GHT7YRWXPL  none          none

1 agent
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "GHT7YRWXPL",
      "name": "HR assistant",
      "createdAt": "2026-11-03T22:14:05.120Z",
      "etag": "\"agent-1\""
    }
  ]
}
```
```yaml tab-output="YAML"
items:
  - id: GHT7YRWXPL
    name: HR assistant
    createdAt: "2026-11-03T22:14:05.120Z"
    etag: '"agent-1"'
```

<!-- example: examples/cli/output-formats.sh#detail -->
```sh
caitlyn agents draft get GHT7YRWXPL
```

<!-- output: examples/cli/output-formats.sh -->
```text tab-output="Table"
draft

  agent id           GHT7YRWXPL
  matches live       false
  created at         2 days ago
  etag               "draft-1"

  configuration
  guidance           2 members
  models             1 member
  knowledge bases    1 item
  attachments        2 members
  content safety     1 member
  denied documents   false
```
```json tab-output="JSON"
{
  "agentId": "GHT7YRWXPL",
  "name": "draft",
  "matchesLive": false,
  "createdAt": "2026-11-03T22:14:05.120Z",
  "configuration": {
    "guidance": {
      "identity": "You are the HR assistant.",
      "instructions": "Answer from the HR policies."
    },
    "models": {
      "answer": {
        "model": "claude-sonnet-5-5"
      }
    },
    "knowledgeBases": [
      {
        "knowledgeBaseId": "KB4T7YQ2WL",
        "numberOfResults": 6,
        "minimumScore": 0.3
      }
    ],
    "attachments": {
      "enabled": true,
      "maxFiles": 5
    },
    "contentSafety": {
      "guardrail": "default"
    },
    "deniedDocuments": false
  },
  "etag": "\"draft-1\""
}
```
```yaml tab-output="YAML"
agentId: GHT7YRWXPL
name: draft
matchesLive: false
createdAt: "2026-11-03T22:14:05.120Z"
configuration:
  guidance:
    identity: You are the HR assistant.
    instructions: Answer from the HR policies.
  models:
    answer:
      model: claude-sonnet-5-5
  knowledgeBases:
    - knowledgeBaseId: KB4T7YQ2WL
      numberOfResults: 6
      minimumScore: 0.3
  attachments:
    enabled: true
    maxFiles: 5
  contentSafety:
    guardrail: default
  deniedDocuments: false
etag: '"draft-1"'
```

A list prints its first page and says how to get the rest:

<!-- example: examples/cli/output-formats.sh#table -->
```sh
caitlyn kb documents list --kb KB4T7YQ2WL --limit 3
```

<!-- output: examples/cli/output-formats.sh -->
```text tab-output="Table"
NAME          ID        FOLDER      STATUS             VERSION  UPDATED AT
──────────────────────────────────────────────────────────────────────────
policy-1.pdf  doc-0001  /policies/  ✓ indexed          1        4 days ago
policy-2.pdf  doc-0002  /policies/  ✓ indexed          1        4 days ago
policy-3.pdf  doc-0003  /policies/  partially_indexed  1        4 days ago

3 documents
More: --all, or --cursor eyJvZmZzZXQiOjN9
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "doc-0001",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-1.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 1000,
      "sha256": "xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0001-1\""
    },
    {
      "id": "doc-0002",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-2.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 2000,
      "sha256": "eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0002-1\""
    },
    {
      "id": "doc-0003",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-3.pdf",
      "folder": "/policies/",
      "status": "partially_indexed",
      "contentType": "application/pdf",
      "byteSize": 3000,
      "sha256": "zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "partialFailures": [
        {
          "code": "PICTURE_DESCRIPTION_FAILED",
          "detail": "page 4"
        }
      ],
      "etag": "\"doc-0003-1\""
    }
  ],
  "nextCursor": "eyJvZmZzZXQiOjN9"
}
```
```yaml tab-output="YAML"
items:
  - id: doc-0001
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-1.pdf
    folder: /policies/
    status: indexed
    contentType: application/pdf
    byteSize: 1000
    sha256: xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    etag: '"doc-0001-1"'
  - id: doc-0002
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-2.pdf
    folder: /policies/
    status: indexed
    contentType: application/pdf
    byteSize: 2000
    sha256: eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    etag: '"doc-0002-1"'
  - id: doc-0003
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-3.pdf
    folder: /policies/
    status: partially_indexed
    contentType: application/pdf
    byteSize: 3000
    sha256: zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    partialFailures:
      - code: PICTURE_DESCRIPTION_FAILED
        detail: page 4
    etag: '"doc-0003-1"'
nextCursor: eyJvZmZzZXQiOjN9
```

Piped or redirected, every command prints JSON: the server's own JSON, unknown fields kept, so a script reads exactly what Caitlyn sent. Filter it in place with `--jq` (no jq binary needed) or `--query` (JMESPath):

<!-- example: examples/cli/output-formats.sh#json -->
```sh
caitlyn kb documents get doc-0003 --kb KB4T7YQ2WL --jq '{name, status}'
```

<!-- output: examples/cli/output-formats.sh -->
```json
{"name":"policy-3.pdf","status":"partially_indexed"}
```

## Output formats

| Format | What it is |
| --- | --- |
| `table` | Tables for lists and detail views for one thing, for people on a terminal |
| `json` | The server's JSON, as one document; a list is one page, with its `nextCursor` |
| `jsonl` | One JSON object per line: a list's items, every page as it arrives with `--all`, or a stream's events |
| `yaml` | The same as `json`, as YAML |
| `text` | Tab-separated lines with no decoration, for shell tools: a list's rows, or one thing's members as name and value |

The CLI uses the first of these that is set:

1. `--output` (`-o`) on the command;
2. `CAITLYN_OUTPUT`;
3. under an AI agent, the profile's `agent_output` (JSON unless it says otherwise, or `same` to skip this step);
4. `output` in the project file, the profile, or your configuration file;
5. JSON when the command has `--jq` or `--query`;
6. a table on a terminal, and JSON when the output is piped or redirected.

What `--jq` and `--query` return is always printed as JSON, and a string as itself, whatever the format.

The format shapes a command's data on stdout, not its errors: a person at a terminal gets errors as a message even with JSON configured. See [When something fails](#when-something-fails).

The same list in each format:

<!-- example: examples/cli/output-formats.sh#table -->
```sh
caitlyn kb documents list --kb KB4T7YQ2WL --limit 3
```

<!-- output: examples/cli/output-formats.sh -->
```text tab-output="Table"
NAME          ID        FOLDER      STATUS             VERSION  UPDATED AT
──────────────────────────────────────────────────────────────────────────
policy-1.pdf  doc-0001  /policies/  ✓ indexed          1        4 days ago
policy-2.pdf  doc-0002  /policies/  ✓ indexed          1        4 days ago
policy-3.pdf  doc-0003  /policies/  partially_indexed  1        4 days ago

3 documents
More: --all, or --cursor eyJvZmZzZXQiOjN9
```
```json tab-output="JSON"
{
  "items": [
    {
      "id": "doc-0001",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-1.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 1000,
      "sha256": "xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0001-1\""
    },
    {
      "id": "doc-0002",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-2.pdf",
      "folder": "/policies/",
      "status": "indexed",
      "contentType": "application/pdf",
      "byteSize": 2000,
      "sha256": "eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "etag": "\"doc-0002-1\""
    },
    {
      "id": "doc-0003",
      "knowledgeBaseId": "KB4T7YQ2WL",
      "name": "policy-3.pdf",
      "folder": "/policies/",
      "status": "partially_indexed",
      "contentType": "application/pdf",
      "byteSize": 3000,
      "sha256": "zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=",
      "version": 1,
      "versionCount": 1,
      "createdAt": "2026-11-01T00:00:00.000Z",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "partialFailures": [
        {
          "code": "PICTURE_DESCRIPTION_FAILED",
          "detail": "page 4"
        }
      ],
      "etag": "\"doc-0003-1\""
    }
  ],
  "nextCursor": "eyJvZmZzZXQiOjN9"
}
```
```text tab-output="JSONL"
{"id":"doc-0001","knowledgeBaseId":"KB4T7YQ2WL","name":"policy-1.pdf","folder":"/policies/","status":"indexed","contentType":"application/pdf","byteSize":1000,"sha256":"xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=","version":1,"versionCount":1,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z","etag":"\"doc-0001-1\""}
{"id":"doc-0002","knowledgeBaseId":"KB4T7YQ2WL","name":"policy-2.pdf","folder":"/policies/","status":"indexed","contentType":"application/pdf","byteSize":2000,"sha256":"eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=","version":1,"versionCount":1,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z","etag":"\"doc-0002-1\""}
{"id":"doc-0003","knowledgeBaseId":"KB4T7YQ2WL","name":"policy-3.pdf","folder":"/policies/","status":"partially_indexed","contentType":"application/pdf","byteSize":3000,"sha256":"zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=","version":1,"versionCount":1,"createdAt":"2026-11-01T00:00:00.000Z","updatedAt":"2026-11-02T00:00:00.000Z","partialFailures":[{"code":"PICTURE_DESCRIPTION_FAILED","detail":"page 4"}],"etag":"\"doc-0003-1\""}
More: --all, or --cursor eyJvZmZzZXQiOjN9
```
```yaml tab-output="YAML"
items:
  - id: doc-0001
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-1.pdf
    folder: /policies/
    status: indexed
    contentType: application/pdf
    byteSize: 1000
    sha256: xj69y+AMBrfZMUMFa+K7N9ftx3xQdsHdOxyZMfNt24o=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    etag: '"doc-0001-1"'
  - id: doc-0002
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-2.pdf
    folder: /policies/
    status: indexed
    contentType: application/pdf
    byteSize: 2000
    sha256: eJei0h2Xh+kI+Iy9qNchAQI9qYZoWeyIJ9gEZxiMFD4=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    etag: '"doc-0002-1"'
  - id: doc-0003
    knowledgeBaseId: KB4T7YQ2WL
    name: policy-3.pdf
    folder: /policies/
    status: partially_indexed
    contentType: application/pdf
    byteSize: 3000
    sha256: zFuki9CQp/jQr0lNR3ncAZ7Is7IwJMg2cYM7XmcRPzo=
    version: 1
    versionCount: 1
    createdAt: "2026-11-01T00:00:00.000Z"
    updatedAt: "2026-11-02T00:00:00.000Z"
    partialFailures:
      - code: PICTURE_DESCRIPTION_FAILED
        detail: page 4
    etag: '"doc-0003-1"'
nextCursor: eyJvZmZzZXQiOjN9
```
```text tab-output="Text"
NAME          ID        FOLDER      STATUS             VERSION  UPDATED AT
──────────────────────────────────────────────────────────────────────────
policy-1.pdf  doc-0001  /policies/  ✓ indexed          1        4 days ago
policy-2.pdf  doc-0002  /policies/  ✓ indexed          1        4 days ago
policy-3.pdf  doc-0003  /policies/  partially_indexed  1        4 days ago

3 documents
More: --all, or --cursor eyJvZmZzZXQiOjN9
```

### Conversations and streams

On a terminal, `caitlyn chat`, `events tail` and the `watch` commands render for people, whatever output is
configured. Give `-o jsonl`, `--jq` or `--query` on the command for their events as data.

## When something fails

Every command ends with an exit code from one fixed table, so a script can branch on it: 0 succeeded, 2 a usage error (nothing was sent), 6 not found, 7 a conflict or a stale ETag, and so on ([Exit codes](/cli/exit-codes/)). The error goes to stderr, in the form that suits whoever reads it, whatever `--output` says:

| Who reads stderr | What they get |
| --- | --- |
| A person: stderr is a terminal, outside CI and not under an AI agent | A message: what went wrong, the commands you may have meant, the usage for a usage error, what to run next and the page to read |
| A script, a CI job or an AI agent: stderr isn't a terminal, or the CLI is in CI or agent mode | One line of JSON with `exitCode` and a `hint` of what to run next, the same in every release |

`--error-format human` or `--error-format json` chooses for one command, and `CAITLYN_ERROR_FORMAT=human` or `=json` for every command. The flag wins over the variable, and both win over what the CLI detects. The exit code is the same either way.

A script sees this:

<!-- example: examples/cli/recover-from-errors.sh#already-exists -->
```sh
# A version name the agent already has: exit code 7
caitlyn agents draft save GHT7YRWXPL --name v12
echo "exit code $?"
```

<!-- output: examples/cli/recover-from-errors.sh -->
```text
{"error":{"code":"ALREADY_EXISTS","detail":"Agent GHT7YRWXPL already has a version v12.","exitCode":7,"hint":{"next":[{"run":"caitlyn agents list","why":"see what already exists"}],"docs":"https://build.caitlyn.ai/cli/reference/agents/draft/#save"},"requestId":"<request-id>","status":409,"title":"Conflict","type":"https://build.caitlyn.ai/errors/ALREADY_EXISTS"}}
exit code 7
```

A person at a terminal sees a message instead:

<!-- example: examples/cli/recover-from-errors.sh#person-usage -->
```sh
# A usage error, as a person sees it: what is missing, the command's usage, and an example to copy
caitlyn agents draft save GHT7YRWXPL --error-format human
echo "exit code $?"
```

<!-- output: examples/cli/recover-from-errors.sh -->
```text
✗ caitlyn agents draft save needs --name.

  Usage:
      caitlyn agents draft save <agent> [flags]

  → Missing: --name

  → For example (keep the tested draft as a version):
      caitlyn agents draft save GHT7YRWXPL --if-match '"draft-ZmeDr4VIILFpik5n"' --name november-candidate --note 'Quotes the policy clause it relied on.'

  USAGE
  docs: https://build.caitlyn.ai/cli/reference/agents/draft/#save
exit code 2
```

A mistyped command gets the nearest commands, and `caitlyn <group> help` to see the rest.

## Safe by default

- Commands are classed by what they change: `read`, `write` (drafts and your own work), `user-facing` (what other people get, such as publishing a version) and `destructive` (what can't be undone). Destructive commands ask first, and in CI or under an AI agent they need `--yes`.
- `--dry-run` on any command prints the request it would send and sends nothing; `--dry-run=curl` prints it as a curl command.
- Writes that must not overwrite someone else's change take `--if-match` with the ETag you read.

## Finding your way

- `caitlyn help <command>` explains one command, and so does `help` after it: `caitlyn agents help`, `caitlyn agents draft help`. Where a command takes an argument, `help` is that argument, so use `--help` there. `caitlyn docs <command>` opens its page here.
- `caitlyn commands --json` describes every command, flag and exit code as data, from the CLI you have installed.
- [Command reference](/cli/reference/): every command, generated from the CLI itself.

## Next

- [Change an agent safely](/cli/recipes/change-an-agent-safely/): edit the draft, save it, publish it and roll back.
- [AI agents](/cli/ai-agents/): how AI coding agents use the CLI, and what keeps them safe.
- [Choose the CLI, an SDK or the MCP server](/how-to-integrate/#choose-the-cli-an-sdk-or-the-mcp-server): which to use for what.
- [Command reference](/cli/reference/): every command.
