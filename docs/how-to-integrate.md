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
on your site, your own code, your agents' tools, or an AI assistant. Each way below says what it is for, what you
need, and where to go next.

| You want to | Use | Start with |
| --- | --- | --- |
| Put a chat in front of people | The embedded chat | [Embed chat in five minutes](/embed/quick-start/) |
| Call Caitlyn from your own code | The SDKs, or the HTTP API | [Getting started](/getting-started/) |
| Give your agents tools of your own | Your own MCP server | [Deploy an MCP server](/tools/deploy-an-mcp-server/) |
| Work with Caitlyn from an AI assistant | Caitlyn's MCP server | [Connect an MCP client](/tools/connect-an-mcp-client/) |
| Script Caitlyn from a terminal | The CLI, which is coming | |

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

## The CLI (coming)

A command-line tool for scripting Caitlyn from a terminal is coming. It doesn't exist yet, so there is nothing to
install. Until it does, use an SDK from a script.

## Next

- [Getting started](/getting-started/): make a first call with an SDK.
- [Authentication](/authentication/): choose how your client signs in.
- [FAQ](/faq/): sign-in with work accounts, troubleshooting, billing, and how to reach a person.
