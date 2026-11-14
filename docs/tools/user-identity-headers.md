---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - mcp-connectors
operations: []
---

# Identify the user behind a tool call

Read the `X-Caitlyn-*` request headers to find out which Caitlyn user is behind a tool call, so your MCP server can attribute records, apply its own per-user rules, or write an audit trail. Wiring this up takes about fifteen minutes once your server is already connected to Caitlyn.

## What You'll Build

By the end of this guide, you'll have:

- A helper in your MCP server that reads the caller's identity from the request headers and rejects a call that arrives without one.
- A tool that attributes what it does to the signed-in user rather than to a shared service account.

## Prerequisites

Before you begin, ensure you have:

- **A working MCP server already registered in Caitlyn**, reachable and returning tools. If you have not built one yet, start with [Deploy an MCP Server](/tools/deploy-an-mcp-server/) and come back.
- **Access to your server's request handling.** You need to be able to read incoming HTTP headers on the transport your server uses. A framework that hides headers from your tool handlers will need a small change to pass them through.

> **Important**: Caitlyn sends real personal data (email address and display name) to your server on every call made from a signed-in chat session. Handle what you receive accordingly, and only register a connector for a server you control.

## The Headers Caitlyn Sends

Caitlyn attaches up to five headers to every request it makes to your server:

| Header                 | Contains                                                         | Example                                |
| ---------------------- | ---------------------------------------------------------------- | -------------------------------------- |
| `X-Caitlyn-User-Id`    | Caitlyn's stable internal identifier for the user                | `a1b2c3d4-0000-0000-0000-000000000000` |
| `X-Caitlyn-User-Email` | The user's email address                                         | `jo.smith@agency.govt.nz`              |
| `X-Caitlyn-User-Name`  | The user's display name, built from their given and family names | `Jo Smith`                             |
| `X-Caitlyn-Session-Id` | The chat session the call belongs to                             | `sess-8f21c0`                          |
| `X-Caitlyn-Domain`     | The environment domain the call came from                        | `your-company.getcaitlyn.ai`                 |

The first four identify the signed-in user; `X-Caitlyn-Domain` identifies the environment. See [Which environment the call came from](#which-environment-the-call-came-from) for the domain header, which arrives even when there is no signed-in user.

**A header whose value is unknown is left out, never sent empty.** If a user record carries no display name, no `X-Caitlyn-User-Name` arrives at all. Treat presence as meaningful and check for it rather than assuming a blank string.

**`X-Caitlyn-User-Id` is the field to key on** for a user. Email addresses and display names change when people change their names or employers; the id does not. Store the id as your foreign key and treat the other two as display values you refresh on each call.

`X-Caitlyn-Session-Id` groups calls that belong to one conversation, which is useful for correlating a multi-step flow in your own logs. It is not a credential and it is not stable across conversations.

## Which Environment the Call Came From

`X-Caitlyn-Domain` carries the environment domain the session belongs to — the same domain the user is signed in under. Caitlyn runs many client environments from one platform, so if your server holds data for more than one of them, this header is how you tell them apart.

**Partition your data on this header, not on a tool argument.** It is the safe key for separating workspaces' data because Caitlyn sets it from the connector's own configuration in the transport layer, exactly like the identity headers: no tool argument, prompt, or user message can set or alter it, and an administrator cannot spoof it (see [Why you can trust the headers](#why-you-can-trust-the-headers)). A tenant identifier the model types into a tool argument carries none of that guarantee — the model produces it from its prompt, so one wrong character silently writes into the wrong partition. Read the tenant from `X-Caitlyn-Domain` and ignore any tenant argument for anything that decides data isolation.

**It arrives even without a signed-in user.** The domain is a fact about the environment, not the person, so a diagnostic or system call that carries no `X-Caitlyn-User-*` headers still carries `X-Caitlyn-Domain`. It is omitted only when no domain can be resolved at all.

## Why You Can Trust the Headers

Caitlyn sets these headers in its transport layer, from the session it has already authenticated. They are assembled after the language model has finished choosing what to call, and no tool argument, prompt, or user message can reach them. A model cannot talk Caitlyn into claiming a different user, because the model is not involved in writing them.

Caitlyn also reserves the whole `X-Caitlyn-` prefix. If an administrator configures custom request headers on your connector (a shared API key, for example), any header they name in that namespace is stripped before the request goes out, regardless of how it was capitalised. That is what makes the guarantee hold: nothing except Caitlyn's own transport layer can populate the namespace.

Your side of that bargain is to make sure nothing else can either.

> **Warning**: Only trust these headers on a connection you know came from Caitlyn. Your server must still authenticate the caller through its normal mechanism, whether that is AWS IAM signing, an OAuth token, or a shared secret. Anyone who can reach your endpoint unauthenticated can send any header they like, so treat the identity as trustworthy **because** the request was authenticated, never instead of authenticating it.

## Read the Identity from the Request

Write one helper that extracts the identity and returns a typed result. Keeping it in a single place means every tool gets the same parsing and the same treatment of missing values.

The examples below are two sibling files under your server's `src/`, and they import each other by relative path so they resolve in any project without extra `tsconfig.json` setup.

```ts title="src/actorHeaders.ts"
type CaitlynActor = {
  userId: string;
  email?: string;
  displayName?: string;
  sessionId?: string;
};

const HEADER_USER_ID = 'x-caitlyn-user-id';
const HEADER_USER_EMAIL = 'x-caitlyn-user-email';
const HEADER_USER_NAME = 'x-caitlyn-user-name';
const HEADER_SESSION_ID = 'x-caitlyn-session-id';

/**
 * Reads the Caitlyn actor identity from an incoming request's headers.
 *
 * Header names are matched lower-case because HTTP header names are
 * case-insensitive and Node lower-cases them on the way in.
 *
 * @param headers - The incoming request headers.
 * @returns The actor, or null when no user id was supplied.
 */
const getCaitlynActor = (headers: Headers): CaitlynActor | null => {
  const userId = headers.get(HEADER_USER_ID);
  if (!userId) return null;

  return {
    userId,
    email: headers.get(HEADER_USER_EMAIL) ?? undefined,
    displayName: headers.get(HEADER_USER_NAME) ?? undefined,
    sessionId: headers.get(HEADER_SESSION_ID) ?? undefined,
  };
};

export type {CaitlynActor};

export {getCaitlynActor};
```

Match the header names in lower case. HTTP header names are case-insensitive, and most server runtimes normalise them to lower case before your code sees them, so a lookup for `X-Caitlyn-User-Id` can silently miss.

## Decide What Happens Without an Identity

A call can arrive with no identity headers for legitimate reasons: the connector is being exercised by a diagnostic that runs outside a user session, or by a system context with no signed-in user. Choose deliberately between two behaviours per tool.

Reject the call when the tool cannot do its job anonymously. This example writes through `insertOnboardingRecord`, standing in for whatever persistence layer your server already uses:

```ts title="src/tools/createOnboardingRecord.ts"
import {getCaitlynActor} from '../actorHeaders';
import {insertOnboardingRecord} from '../db/onboardingRecords';

type CreateOnboardingRecordInput = {
  agencyName: string;
};

type CreateOnboardingRecordResult = {recordId: string} | {isError: true; message: string};

/**
 * Creates an onboarding record attributed to the calling Caitlyn user.
 *
 * @param headers - The incoming request headers.
 * @param input - The record fields supplied by the agent.
 * @returns The created record's id, or a tool error when no actor is present.
 */
const createOnboardingRecord = async (headers: Headers, input: CreateOnboardingRecordInput): Promise<CreateOnboardingRecordResult> => {
  const actor = getCaitlynActor(headers);
  if (!actor) {
    return {
      isError: true,
      message: 'This tool records who requested the onboarding, so it can only be called from a signed-in Caitlyn chat session.',
    };
  }

  const record = await insertOnboardingRecord({
    agencyName: input.agencyName,
    requestedByUserId: actor.userId,
    requestedByEmail: actor.email,
  });

  return {recordId: record.id};
};

export type {CreateOnboardingRecordInput, CreateOnboardingRecordResult};

export {createOnboardingRecord};
```

Say why in the error text. It reaches the agent, which relays it to whoever is in the conversation, so an error naming the reason is easier to act on than a bare "unauthorised".

For a tool that reads public reference data, ignore the absent identity and carry on. Do not make a read-only lookup fail over an attribution field it never uses.

## No Setup Needed to Turn It On

There is no switch to flick. Every Caitlyn connector receives the signed-in user's identity, so once your server is registered and connected, the headers arrive on every call made from a chat session. When an administrator saves a connector, Caitlyn re-checks the connection with the same headers a live call would carry, so a server that rejects headers it does not recognise fails verification at save time rather than breaking quietly on its first real turn.

## Let Caitlyn Fill in a Tool Argument (Optional)

Reading headers covers most cases. Where you would rather the caller's identity arrive as a normal tool argument, annotate that property in your tool's input schema with a pointer and Caitlyn fills it in at call time:

```json
{
  "type": "object",
  "required": ["customerEmail", "damageDescription"],
  "properties": {
    "customerEmail": {
      "type": "string",
      "description": "The customer's email address.",
      "x-caitlyn-resolve": "session.userEmail"
    },
    "damageDescription": {
      "type": "string",
      "description": "What the customer says is damaged."
    }
  }
}
```

Caitlyn drops an annotated property from the model-visible `required` list, tells the model it will be filled in automatically, and substitutes the session value before forwarding the call. Available pointers are `session.userId`, `session.userEmail`, `session.userGivenName`, `session.userFamilyName`, `session.userDisplayName`, and `session.sessionId`.

There is deliberately no pointer for the environment domain. Resolved arguments can be overridden by a value the model supplies, so a domain pointer would be no more trustworthy than a hardcoded prompt string. Read the domain from `X-Caitlyn-Domain` instead, which the model cannot reach at all.

When the call has no signed-in user (a diagnostic or system context), Caitlyn cannot resolve the pointer, so it leaves the property required and un-annotated and the model supplies a value like any other argument. Your tool keeps working instead of failing on every call. Keep the property's own description accurate for that reason: it is what the model reads when it has to fill the field itself.

> **Tip**: Prefer the headers for anything security-relevant. A resolved argument arrives in the same payload as model-authored values, whereas a header cannot be reached by the model at all.

## Verify It Works

1. Add one log line to the helper you wrote, so the resolved actor is visible without stepping through a tool:

   ```ts
   console.log('caitlyn actor', getCaitlynActor(request.headers));
   ```

2. In Caitlyn, ask an agent whose workflow includes your connector a question that calls one of your tools.
3. Check your server's logs for that line, then check whatever your tool wrote.

**It works when:**

- The request carries `X-Caitlyn-User-Id`, and its value matches the user you are signed in as in Caitlyn.
- `X-Caitlyn-User-Email` matches that user's email address.
- Records your tool writes carry the caller's id rather than a shared service-account id.

**If it doesn't:**

- No identity headers on the request at all: see [No identity headers arrive](#issue-no-identity-headers-arrive).
- The headers arrive but your code does not see them: see [The header lookup returns nothing](#issue-the-header-lookup-returns-nothing).

## Troubleshooting

### Issue: No identity headers arrive

**Symptoms**: Your server logs the request, other headers are present, but every `X-Caitlyn-*` header is missing.

**Solutions**:

1. Confirm the call came from a chat turn with a signed-in user. A diagnostic run outside a user session, or any system context with no signed-in user, has no identity to send.
2. Check that nothing between Caitlyn and your server strips unrecognised headers. An API gateway or proxy with a header allow-list will drop them, and your server will never see them.

### Issue: The header lookup returns nothing

**Symptoms**: The headers are visible in a request dump, but your helper returns `null`.

**Solutions**:

1. Look the names up in lower case (`x-caitlyn-user-id`). Most runtimes normalise incoming header names, so a mixed-case lookup misses.
2. If your framework parses headers into a plain object rather than a `Headers` instance, its keys may be lower-cased too. Normalise the key before indexing it rather than trusting the original casing.

### Issue: Saving the connector fails verification

**Symptoms**: An administrator saves the connector and Caitlyn reports a verification failure instead of saving.

**Solutions**:

1. Your server may be rejecting the request because it carries the `X-Caitlyn-*` headers. Check whether it validates incoming headers against a strict allow-list, and add the `X-Caitlyn-*` names to it.
2. Check your server's logs for the failed attempt. Caitlyn verifies with the same headers a real call would carry, so whatever it logs is what a live turn would have hit.

### Issue: A user's name or email looks out of date

**Symptoms**: Records your server wrote earlier show an email address or display name the user no longer uses.

**Solutions**:

1. Key your records on `X-Caitlyn-User-Id` and treat the email and display name as values to refresh on each call. Caitlyn sends the current values every time; a stored copy goes stale the moment a user is renamed.

## What's next

- [Deploy an MCP server](/tools/deploy-an-mcp-server/): build and host a server on Bedrock AgentCore, if you have not already.
- [Connect an MCP client](/tools/connect-an-mcp-client/): the other direction, an AI assistant calling Caitlyn's own MCP server.
- **Managing Connectors** in Caitlyn's Help: the administrator's view of registering connectors and per-user account linking.
