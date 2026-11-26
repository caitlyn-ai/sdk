---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations:
  - embed-widget
  - mcp-server
  - mcp-connectors
operations: []
---

# How to integrate

There are several ways to bring Caitlyn into what you build, depending on who is on the other side: people chatting
on your site, your own code, your agents' tools, an AI assistant, or a terminal. Each way below says what it is for,
what you need, and where to go next. If you're choosing between the CLI, an SDK and Caitlyn's MCP server, see
[Choose the CLI, an SDK or the MCP server](#choose-the-cli-an-sdk-or-the-mcp-server).

| You want to | Use | Start with |
| --- | --- | --- |
| Put a chat in front of people | The embedded chat | [Embed chat in five minutes](/embed/quick-start/) |
| Call Caitlyn from your own code | The SDKs, or the HTTP API | [Getting started](/getting-started/) |
| Give your agents tools of your own | Your own MCP server | [Deploy an MCP server](/tools/deploy-an-mcp-server/) |
| Work with Caitlyn from an AI assistant | Caitlyn's MCP server | [Connect an MCP client](/tools/connect-an-mcp-client/) |
| Work with Caitlyn from a terminal, a script or CI | The CLI | [Install the CLI](/cli/install/) |

## Embed the chat

For people on your website or in your app. Two lines of HTML put Caitlyn's chat on a page: a container and a script
tag served from your own workspace. The chat answers from your agent's knowledge bases with citations, and takes
its look from your workspace's theme. There is no back end to build and no credential in the page. In a native
mobile app, embed the same chat in a web view.

- [Embed chat in five minutes](/embed/quick-start/): the chat in a section of a page.
- [Embed widget and chat widget](/embed/embed-widget/): the events you can listen for, the JavaScript API, and a
  launcher in the corner of every page.
- [Iframe integration](/embed/iframe/): content-management systems, React, Vue and Angular, and the iframe's
  security settings.
- [Sign-in options](/sign-in/options/): how the people chatting sign in, with their work accounts or as guests.

## Use the SDKs

For your own code: a back end, a job, an app. The SDKs for TypeScript, Python, Go and Rust call the Caitlyn v3 API
for you. They sign in, retry what is safe to repeat, page through lists, follow streams and raise a typed error for
each failure. Anything else can call the HTTP API directly with the same requests.

- [Getting started](/getting-started/): install an SDK and make a first call.
- [Authentication](/authentication/): every way a client signs in, as a person or as itself.
- Guides: [Ask an agent](/guides/ask-an-agent/), [Load documents](/guides/load-documents/),
  [How ingestion works](/guides/how-ingestion-works/), [Change an agent safely](/guides/change-an-agent-safely/) and
  [Sign in from a browser](/guides/sign-in-from-a-browser/).
- Reference: the [SDK reference](/sdk/), every call in each language, and the [HTTP API reference](/api/), every
  request with curl.

The v3 API is in preview. For what it doesn't serve yet, the [guides still in the app](/guides-in-the-app/) cover the
current API.

## Build your own MCP tools

For giving your agents tools of their own: looking something up in your systems, or taking an action there. You
build a Model Context Protocol (MCP) server, host it, and register it in Caitlyn, and your agents call its tools
when a conversation needs them.

- [Deploy an MCP server](/tools/deploy-an-mcp-server/): build, host and register one, end to end.
- [Identify the user behind a tool call](/tools/user-identity-headers/): act as the person chatting, not as Caitlyn.
- [Amazon Connect connector role](/tools/amazon-connect-connector-role/): the role a contact-centre connector needs.

## Use Caitlyn's MCP server from an AI assistant

The other direction: Caitlyn has an MCP server of its own, so an AI assistant or agent that speaks MCP can work with
your workspace. It can look up agents and knowledge bases, read feedback on answers, upload documents and more. It
always acts as the person who connected it, and never does more than they can.

- [Connect an MCP client](/tools/connect-an-mcp-client/): connect an assistant, and what it can do.
- [Connect an AI client with the CLI](/cli/ai-agents/#connect-an-ai-client-to-the-mcp-server): `caitlyn mcp add`
  writes the configuration for Claude Code, Cursor or VS Code.

## Use the CLI

For a person at a terminal, a script, a CI job, or an AI coding agent with a shell. `caitlyn` runs every API
operation as a command, keeps agents in files you can review and apply, keeps a folder in step with a knowledge
base, and reports to GitLab, GitHub, Buildkite and Azure Pipelines. It prints a table at a terminal and JSON when
piped, and its errors say what to run next.

- [Install the CLI](/cli/install/): macOS, Linux and Windows, or a container image.
- [The Caitlyn CLI](/cli/): sign in, the commands, output formats and configuration.
- [AI agents](/cli/ai-agents/): how AI coding agents use the CLI, and what keeps them safe.

## Choose the CLI, an SDK or the MCP server

For code and AI tools, there are three ways in besides the app itself. Each is best at different work.

| Use | When | For example |
| --- | --- | --- |
| The CLI | A person at a terminal, a script, a CI job, or an AI coding agent with a shell; anything with files; anything that must run the same way twice | Keep a folder in step with a knowledge base from CI; publish a reviewed draft when the main branch changes |
| An SDK | Code you write and keep: a service, an integration, an app | A TypeScript service that streams answers to your own front end |
| The workspace's MCP server | An AI client with no shell, such as Claude Desktop, or conversational work over one workspace, where typed tools in the model's context beat reading command output | Refining an agent's answers from feedback, one change at a time, from Claude Desktop |

The CLI and the SDKs are the same API underneath, released together: a command and its SDK method do the same
thing, and every command's page links its SDK method and its HTTP request.

## Next

- [Getting started](/getting-started/): make a first call with an SDK.
- [Install the CLI](/cli/install/): work with Caitlyn from a terminal.
- [Authentication](/authentication/): choose how your client signs in.
- [FAQ](/faq/): sign-in with work accounts, troubleshooting, billing, and how to reach a person.
