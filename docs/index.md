---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Caitlyn developer docs

Build on Caitlyn from your own code: ask an agent a question and stream its cited answer, load documents into a
knowledge base, and change an agent safely, through the Caitlyn v3 API and its SDKs for TypeScript, Python, Go
and Rust.

> **Preview.** The v3 API is being built. The SDKs and this reference describe the whole of it, but a Caitlyn
> release serves only [GetAgentVersion](/reference/get-agent-version/) so far; every other operation's page says
> it is not available yet. Expect changes before version 1.0.

## Start here

- [Getting started](/getting-started/): install an SDK, create a client for your workspace and make a first call.
- [Authentication](/authentication/): the six ways a client signs in, and which to use.
- [Sign in from a browser](/guides/sign-in-from-a-browser/): a web app calling Caitlyn as the person using it.
- How the SDKs behave: [errors](/errors/), [retries](/retries/), [streaming](/streaming/),
  [pagination](/pagination/) and [telemetry](/telemetry/).

## The API reference

One reference covers every SDK. Each operation's page shows the call in TypeScript, Python, Go and Rust (pick a
language once and every page follows), the request and response members, the permission it checks, its errors,
and complete, runnable examples. The examples are compiled against every SDK on each change, so they match the
SDKs you install.

- Operations: [versions](/reference/get-agent-version/), [conversations](/reference/send-message/),
  [documents](/reference/list-documents/) and [uploads](/reference/create-upload/).
- [Types](/reference/types/agent-configuration/): the objects the operations take and return.
- [Error codes](/errors/NOT_FOUND/): one page per code, at the address each error's `type` names.

## The SDKs

| Language | Package | Runs on |
| --- | --- | --- |
| TypeScript | `@caitlyn-ai/sdk` on npm | Node 20 and later, Bun, Deno, browsers and edge runtimes |
| Python | `caitlyn` (installed from the GitHub repository until it is on PyPI) | Python 3.12 and later |
| Go | `github.com/caitlyn-ai/caitlyn-go` (from the GitHub repository until the module path is published) | Go 1.23 and later |
| Rust | `caitlyn-sdk` (from the GitHub repository until it is on crates.io) | Rust with tokio |

All four are generated from the same model of the API, share one version number and behave the same way: the
same sign-in modes, retries, errors and telemetry. None of them depends on an AWS SDK. The source is at
[github.com/caitlyn-ai/sdk](https://github.com/caitlyn-ai/sdk).

## For AI agents and tools

Every page is also Markdown: add `.md` in place of the trailing slash (`/getting-started.md`). The index of them
all is [`/llms.txt`](/llms.txt), and [`/llms-full.txt`](/llms-full.txt) has every page in one file.
