---
pageType: guide
sinceVersion: 5000115000000
resources:
  - workspace
integrations:
  - mcp-server
operations: []
---

# Connect an MCP client to Caitlyn

Caitlyn has an MCP server of its own, so an AI assistant or agent that speaks the Model Context Protocol can work
with your workspace: look up agents and knowledge bases, read feedback on answers, upload documents, and more. It
always acts as the person who connected it, and never does more than they can.

This is the other direction from [Deploy an MCP server](/tools/deploy-an-mcp-server/), where Caitlyn's agents call
an MCP server you build.

## Before you start

- **Your workspace's address**, such as `your-company.getcaitlyn.ai`.
- **The MCP server turned on for your workspace.** It is turned on per workspace. If connecting fails at the
  first step, email [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai).
- **A Caitlyn account.** The client acts as you, so you sign in as yourself when you connect it.
- **An MCP client that supports remote servers with OAuth**: the Streamable HTTP transport, with OAuth 2.1
  authorisation and dynamic client registration. Most current MCP clients do.

## Step 1: Add the server to your client

The server's address is your workspace's address followed by `/api/mcp`:

```text
https://your-company.getcaitlyn.ai/api/mcp
```

Add it to your client as a remote (HTTP) MCP server. In Claude Code, for example:

```bash
claude mcp add --transport http caitlyn https://your-company.getcaitlyn.ai/api/mcp
```

You don't need a client ID or secret. The client finds Caitlyn's sign-in from the server's discovery documents
(`/.well-known/oauth-authorization-server` and `/api/mcp/.well-known/oauth-protected-resource`) and registers
itself.

## Step 2: Sign in and choose what it may do

The first time the client connects, it opens Caitlyn in your browser. Sign in if you aren't already, and Caitlyn
shows its consent screen. It names the client, and says that the client will act as you and can never do more
than you can.

Choose one level for everything the client may reach:

| Level | What the client can do |
| --- | --- |
| Read | List and read: agents, knowledge bases and their documents, users, feedback and configuration |
| Write | Everything in Read, plus create, update and upload |
| Admin | Everything in Write, plus delete, and edit roles |

A level is offered only when you hold the permissions it covers; a level you can't grant is closed and says so.
Choose the lowest level that does the job. Read is enough for questions about your workspace.

Nothing is issued until you select **Authorise**. Cancelling returns you to the client with no access granted.

## Step 3: Use it

Ask your assistant about your workspace, for example "Which knowledge bases does the HR agent search?" or "Show me
last week's negative feedback". The client offers only the tools the level you chose allows.

Every call is checked twice: against the level you granted the client, and against your own permissions in
Caitlyn. What the server returns leaves out secrets and infrastructure details.

## Manage and disconnect clients

Every client a person has connected is listed in **Settings → MCP Clients**, with who authorised it and when it
was last used. An administrator can withdraw any of them there; the client's next call is refused, and it has to
be authorised again. Plan for a connection ending without your client being told.

A personal access token or an API client's credentials can't be used here. The MCP server needs a person behind
every token, and a credential issued for the REST API is refused by the MCP server (see
[Rules every credential follows](/authentication/#rules-every-credential-follows)).

## Troubleshooting

### The client can't connect at all

- Check the address ends in `/api/mcp` and uses `https`.
- If the server answers 404, the MCP server isn't turned on for your workspace.

### The consent screen offers no level, or not the one you need

Each level is offered only when your own role holds what it covers. Ask an administrator to change your role, or
connect with a lower level.

### A tool you expected isn't offered

The client sees only the tools your chosen level allows. Disconnect it in **Settings → MCP Clients** and connect
again with a higher level.

### The connection stopped working

An administrator may have withdrawn it, or your own access may have changed. Connect the client again.

## What's next

- [Authentication](/authentication/): how code signs in to the v3 API, and the rules every credential follows.
- [User identity headers](/tools/user-identity-headers/): who is behind a call when Caitlyn calls your MCP server.
