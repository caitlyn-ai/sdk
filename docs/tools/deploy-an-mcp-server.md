---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - mcp-connectors
  - agentcore
operations: []
---

# Deploy an MCP server to AgentCore

Build and host your own Model Context Protocol (MCP) server on AWS Bedrock AgentCore Runtime with AWS IAM authentication, then register it in Caitlyn so your agents can call its tools. This technical guide walks you through building your own custom integration end to end, and a first run takes about forty-five minutes, most of it the initial AWS deployment.

## What You'll Accomplish

By the end of this guide, you'll have:

- A running MCP server on AgentCore Runtime, authenticated with **AWS IAM (SigV4)**, with no user sign-in required.
- A Caitlyn **Bedrock AgentCore** connector pointing at that runtime.
- An agent that successfully calls one of your server's tools in chat.

## Prerequisites

- **The starter template**, in TypeScript or Python. Each variant contains a working MCP server, a one-command CDK deployment, and example tools; its `README.md` is the build-and-deploy reference. This guide picks up from a deployed runtime.
- **An AWS account** with Bedrock AgentCore available in your region, CDK bootstrapped, and Docker running locally.
- **Caitlyn administrator access**, specifically the permission to manage connectors (Settings → Connectors → Manage Connectors).
- Ideally, **deploy the runtime into the same AWS account as your Caitlyn deployment.** Same-account IAM is the simplest path; see [Cross-account setups](#cross-account-setups) if you can't.

Clone whichever language you prefer — the rest of this guide follows your choice:

```bash tab="TypeScript"
git clone https://github.com/caitlyn-ai/bedrock-agentcore-mcp-boilerplate-typescript
```
```bash tab="Python"
git clone https://github.com/caitlyn-ai/bedrock-agentcore-mcp-boilerplate-python
```

## Deploy the Runtime

Follow the template `README.md`: write (or keep) a tool, then deploy.

```bash tab="TypeScript"
pnpm install
pnpm run deploy        # builds the arm64 image, creates the role + AgentCore runtime
```
```bash tab="Python"
pip install -r cdk/requirements.txt
cdk deploy            # builds the arm64 image, creates the role + AgentCore runtime
```

The stack prints an **`AgentRuntimeArn`**. Note it down.

## Confirm the Runtime Is IAM-Authenticated and Ready

```bash
aws bedrock-agentcore-control get-agent-runtime \
  --agent-runtime-id <id-from-the-arn> --region ap-southeast-2
```

Check these as a manual sanity check (Caitlyn's own auto-detection keys only off the presence of an authoriser, not `status` or `serverProtocol`):

- `"status": "READY"`
- `"protocolConfiguration": { "serverProtocol": "MCP" }`
- **No `authorizerConfiguration` key.** Its absence is what makes the runtime IAM-authenticated. If you see a `customJWTAuthorizer` here, the runtime is configured for OAuth instead, so redeploy without an authoriser for the IAM path.

## Give Caitlyn Permission to Invoke It

Caitlyn signs its calls to your runtime with SigV4, using the AWS role its own server runs as. That role needs `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN.

- **Same account** (recommended): Caitlyn's server role already grants `bedrock-agentcore:InvokeAgentRuntime` on `arn:aws:bedrock-agentcore:*:<account>:runtime/*`, so a runtime you deploy into the Caitlyn account is covered automatically.
- **Different account**: see [Cross-account setups](#cross-account-setups) below.

## Register the Connector in Caitlyn

Open **Settings → Connectors → Manage Connectors → Add Connector** and choose the **Bedrock AgentCore** template.

Instead of typing an ARN, you'll see a **Pick a runtime** list of runtimes discovered in the configured AWS region. Select yours. Caitlyn fills in the ARN, region, and name, then inspects the runtime and shows the detected auth mode.

![The Add connector dialog with the Bedrock AgentCore template selected and the Pick a runtime list populated](/images/tools/agentcore-add-connector.webp)

> **Detected: AWS IAM (SigV4).**

![The Add connector dialog after selecting a runtime, showing the detected AWS IAM (SigV4) badge](/images/tools/agentcore-detected-auth.webp)

Save. Because IAM connectors need no per-user sign-in, there is no Connect button, so the connector is ready immediately. (For the detailed click-path and per-user OAuth connectors, see **Managing Connectors** in Caitlyn's Help.)

## Use It in Chat

Ask an agent a question that should trigger your tool. With the template's example tools, "ping the example server" or "look up example record abc-123" will call the server. The tool result feeds back into the agent's answer.

## Verify It Works

### Check the connector and a tool call

1. On **Settings → Connectors → Manage Connectors**, find your connector's card.
2. Ask an agent whose workflow includes the connector a question that should trigger one of your tools.
3. Open the agent's trace and confirm the tool call resolves with a result.

![The registered AgentCore connector card showing bedrock-agentcore · iam](/images/tools/agentcore-connector-card.webp)

**It works when:**

- The connector's card shows the Bedrock AgentCore template and its auth mode as text (for example, `bedrock-agentcore · iam`).
- In a chat that exercises a tool, the agent's trace shows the tool call resolving with a result rather than an error.
- CloudWatch Logs for the runtime record the incoming request, confirming the signed call reached your container.

**If it doesn't:**

- The runtime picker was empty when you tried to register the connector (see Troubleshooting).
- The connector saved, but tool calls fail with a permission error or a 403 (see Troubleshooting).
- The agent answers without calling your tool (see Troubleshooting).

## Returning Files

A tool can hand a file back to the person chatting, such as an export or a generated spreadsheet. Return it in the tool result's `content` in either of the two standard MCP shapes:

- **A resource link** — `{"type": "resource_link", "uri": "https://…/q1-costs.xlsx", "name": "q1-costs.xlsx", "mimeType": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"}`. A pre-signed S3 URL with a short expiry works well here.
- **An embedded resource** — `{"type": "resource", "resource": {"uri": "file:///q1-costs.csv", "mimeType": "text/csv", "blob": "<base64>"}}`, for a small file you would rather not host.

Then ask your Caitlyn administrator to turn on **Save returned files as downloads** for that tool (see **Managing Connectors** in Caitlyn's Help). Caitlyn downloads the file, keeps a copy in the conversation, and shows it to the person as a file card. The agent is given the file's name rather than your URL, so a link that expires never appears in an answer.

For the file to be kept:

- **Use a supported type**: Excel (`.xlsx`, `.xls`), CSV, PDF, Word (`.docx`), plain text or Markdown. Give the file a name with the matching extension, or set `mimeType`.
- **Serve the link over `https`** from a public address. Caitlyn does not follow links to private or internal addresses, including after a redirect.
- **Keep it under 25 MB**, and make sure the whole download finishes within 30 seconds.
- **Send the real file.** The bytes must match the type: an `.xlsx` that is really a sign-in page or an error message is refused.

Caitlyn keeps up to 10 files from one tool call. Each file is kept or refused on its own: if one cannot be kept, the agent tells the person that file could not be saved, and the other files and the rest of your tool's result are unaffected. A link that is not to one of the supported file types, such as a link to a web page, is passed to the agent unchanged.

## Cross-Account Setups

If the runtime lives in a different AWS account from Caitlyn, IAM still works, but Caitlyn assumes a role in the runtime's account before signing (the **AWS IAM (cross-account)** option in the Add Connector dialog). You provide the ARN of a role in the runtime's account, and Caitlyn performs an STS `AssumeRole` into that account, then signs with the temporary credentials.

That role has three requirements:

1. **Name it with the `caitlyn-connector-` prefix** (e.g. `caitlyn-connector-agentcore`). Caitlyn is only permitted to assume cross-account roles that follow this convention — a role named otherwise registers cleanly and then fails at call time.
2. **Its trust policy must allow both `sts:AssumeRole` and `sts:TagSession`** for Caitlyn's principal. The connector dialog shows the principal ARN to name when you edit the connector. The `sts:TagSession` action is not optional: on some Caitlyn deployments the server's AWS session carries session tags, which are passed on through the assumption, and a trust policy granting only `sts:AssumeRole` then fails with `sts:TagSession` denied. Grant both, and the role works on every deployment.
3. **Its permissions policy must allow `bedrock-agentcore:InvokeAgentRuntime`** on the runtime ARN.

**Strongly recommended — require an external ID.** Caitlyn sends a per-connector external ID on every assumption. If you add an `sts:ExternalId` condition (matching that connector's ID) to the `sts:AssumeRole` statement, only your tenant's principal presenting that exact ID can assume the role — closing the gap where a role trusting Caitlyn's shared principal is a role trusted by every tenant; without the condition, that gap stays open. Put the condition on the `sts:AssumeRole` statement only, not on `sts:TagSession` (the `sts:ExternalId` key does not exist in the `TagSession` context, so a combined statement denies the whole assumption). Caitlyn's **Amazon Connect** connector dialog renders this two-statement policy ready to paste and offers a downloadable CloudFormation template that provisions the whole role — the [Connector Role Setup guide](/tools/amazon-connect-connector-role/) walks through it; for an AgentCore connector, construct the same shape using the external ID shown when editing that connector.

> **Caution**: Caitlyn's principal ARN goes in your role's **trust policy**, never in the connector's **Assume-role ARN** field. When you reopen the connector to edit it the two sit close together on screen, and pasting the principal into that field asks Caitlyn to assume the identity it is already running as, which fails on every call with an access-denied error. Caitlyn refuses that save on an Amazon Connect connector; put the ARN of the role in **your** account in the field, and Caitlyn's principal in that role's trust relationships. See **Managing Connectors** in Caitlyn's Help for the administrator's side of the same step.

## Troubleshooting

### Issue: The runtime picker is empty

**Symptoms**: The Add Connector dialog shows no runtimes to choose from, so you can't select yours.

**Solutions**:

1. Confirm your runtime's region matches the region Caitlyn is querying. Caitlyn lists runtimes in one region only.
2. Confirm the runtime's status is `READY` (see [Confirm the runtime is IAM-authenticated and ready](#confirm-the-runtime-is-iam-authenticated-and-ready)).
3. Paste the ARN by hand if you'd rather not wait for discovery.

### Issue: The connector saves but tool calls fail with a permission error

**Symptoms**: The connector registers cleanly, but calling one of its tools in chat returns a permission error.

**Solutions**:

1. Add `bedrock-agentcore:InvokeAgentRuntime` on the runtime ARN to Caitlyn's server role (same account) or to the assumed role (cross-account), then retry.

### Issue: Tool calls fail with a 403 despite the permission

**Symptoms**: The permission is in place, but tool calls still return a 403.

**Solutions**:

1. The runtime's auth mode and Caitlyn's connector mode disagree. Re-check the runtime's auth mode (see [Confirm the runtime is IAM-authenticated and ready](#confirm-the-runtime-is-iam-authenticated-and-ready)): a runtime with a JWT authoriser expects OAuth, not IAM.
2. Redeploy the runtime without an authoriser, or register it as an OAuth connector instead.

### Issue: The agent ignores the tool

**Symptoms**: The connector is registered and permitted, but the agent never calls your tool.

**Solutions**:

1. The model chooses tools from their descriptions. Make the tool's `description` explicit about when to use it and what it returns, then redeploy.

## What's next

- Add real tools to your server. One file per tool keeps them easy to test.
- Move third-party API keys into AWS Secrets Manager (the template shows the pattern) rather than plain environment variables.
- Review **Managing Connectors** in Caitlyn's Help for OAuth-based connectors and per-user account linking.
