---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - mcp-connectors
  - amazon-connect
operations: []
---

# Provision the Amazon Connect connector role

When your Amazon Connect resources live in your own AWS account, Caitlyn reaches them through an IAM role that you create and control. This guide walks an IT administrator through provisioning that role with the CloudFormation template the connector dialog offers, testing the assumption from inside Caitlyn, and revoking it later. Allow about fifteen minutes.

## What You'll Build

By the end of this guide, you'll have:

- An IAM role in your AWS account that only your Caitlyn deployment's principal can assume, and only when it presents your connector's external ID
- Permissions scoped to your Customer Profiles domain and your Cases domain, plus KMS decryption that can only be exercised through Customer Profiles, never by calling KMS directly
- An Amazon Connect connector in Caitlyn configured with the role's ARN and confirmed working with the dialog's **Test this role** action

## How Caitlyn Reaches Your Account

Caitlyn never stores credentials for your AWS account. Caitlyn's own AWS principal performs an STS `AssumeRole` into the role you create here, and signs the Customer Profiles and Cases calls with the temporary credentials that come back. Deployments configured with a per-tenant role present that tenant role as the principal, so the identity your trust policy names belongs to your workspace rather than to the platform as a whole. The connector dialog shows the exact principal ARN for your deployment; you never have to guess it.

The external ID is the second half of the lock. Caitlyn mints one per connector and sends it on every assumption, and the role's trust policy only permits the assumption when that exact value is presented. Keep the `sts:ExternalId` condition in place: it is what stops any other party who can name the same principal from assuming your role. The [AgentCore cross-account guide](/tools/deploy-an-mcp-server/#cross-account-setups) explains the reasoning behind the naming convention, the `sts:TagSession` requirement and the external ID in more depth; the template in this guide encodes all three for you.

## Prerequisites

Before you begin, ensure you have:

- **Connector-management rights in Caitlyn**: the **Manage Connectors** button must be visible in the title bar of **Settings → Connectors**. If it is missing, ask an administrator for a role that includes connector management. See **Managing Connectors** in Caitlyn's Help if the registry is new to you.
- **An AWS account that owns the Connect resources**: with permission to run CloudFormation and create IAM roles in it.
- **Four identifiers from the Amazon Connect console**: the **instance ID** (in the instance's settings, or the last segment of its ARN), the **Customer Profiles domain name** (Customer profiles → Domain), the **Cases domain ID** and the **Cases template ID** (Cases → Domains, then the template you want new cases raised against). The connector cannot be saved without all four; the two domain values are needed again as CloudFormation parameters in Step 3.

> **Note**: The role does not exist yet, and it does not need to. You choose its account and its name, so its ARN is known in advance. You register the connector with that intended ARN first, because Caitlyn mints the connector's external ID when a role ARN is first saved.

## Step 1: Register the Connector with the Role's Intended ARN

Open **Settings → Connectors**, then **Manage Connectors** in the title bar. The registry lists every connector registered for your organisation.

![The Manage Connectors registry listing registered connectors](/images/tools/connectors-manage.webp)

Choose **Add Connector** and pick the **Amazon Connect** template (or open an existing Amazon Connect connector with **Edit**). In the **AWS access** section, enter the ARN the role will have once created:

```
arn:aws:iam::<your-account-id>:role/caitlyn-connector-amazon-connect
```

Keep the `caitlyn-connector-` name prefix. Caitlyn is only permitted to assume cross-account roles named this way, so a role named otherwise registers cleanly and then fails at call time. Fill in the region and the four contact centre identifiers from Prerequisites, then save.

## Step 2: Copy the Trust Details and Get the Template

Reopen the connector with **Edit**. The dialog now shows a **Trust policy** section with the two values your role must be built around, each with a copy control:

- **Trusted principal ARN**: the identity Caitlyn presents for your domain
- **External ID**: minted for this connector, and never regenerated

You have two ways to create the role from here, and Step 3 covers both:

- **Launch stack** opens the CloudFormation console with the template selected and every parameter already filled in from the values above. This is the fastest route and the one least likely to introduce a typo.
- **Download CloudFormation template** gives you the YAML to read, review, or run through your own tooling.

Either way it is the same template, and it is a plain YAML file you can read end to end before running it: the trust policy admits only the principal shown above, under your external ID, and the permissions grant is `profile:SearchProfiles`, `profile:CreateProfile`, `cases:CreateCase` and `cases:GetCase`, scoped to the domains you name, plus a KMS statement that can only be exercised through Customer Profiles.

> **Note**: The launch link carries your external ID in the part of the URL after the `#`, which browsers never send to a server, so it reaches no proxy or web log on the way to AWS. It does appear in your own browser history. AWS does not treat an external ID as a secret in any case: its protection comes from your trust policy requiring it, not from keeping it hidden.

> **Info**: No `connect:` permissions are needed. Voice sessions authenticate with a signed widget token rather than with this role, so the template grants nothing against the Connect instance itself.

If your organisation does not permit running a third-party CloudFormation template, you do not need it: the same dialog renders both finished documents, the **Trust policy** and a **Permissions policy** built from this connector's own account, region and domains, ready to paste into a role you create by hand or through your own infrastructure-as-code. The template encodes exactly those two documents, so either route produces the same role.

## Step 3: Create the Stack in Your AWS Account

Sign in to the AWS account that owns the Connect resources first. The stack must be created **in the region that holds them**, because the stack's region scopes the permissions the template creates.

**If you used Launch stack**, the console opens on the **Quick create stack** page with the template and all four parameters already populated. Confirm the region shown in the console's top-right corner is the one your Connect resources live in, expand **View template** if you want to read it in place, tick the acknowledgement that CloudFormation may create IAM resources with custom names, and choose **Create stack**.

**If you downloaded the template**, create the stack by hand:

1. Choose **Create stack** → **With new resources (standard)**.
2. Under **Specify template**, choose **Upload a template file** and select the downloaded YAML.
3. Fill in the parameters, pasting the trusted principal ARN and external ID copied in Step 2, and the Customer Profiles domain name and Cases domain ID from the Amazon Connect console. Leave the role name as its default unless it clashes with an existing role; if you change it, keep the `caitlyn-connector-` prefix and update the ARN saved in Caitlyn to match.
4. Continue through to **Submit**, ticking the acknowledgement that CloudFormation may create IAM resources with custom names. The template creates exactly one resource: the role.

When the stack reaches `CREATE_COMPLETE`, open its **Outputs** tab. The `RoleArn` output is the value Caitlyn needs. If you kept the default role name it matches what you entered in Step 1; if not, paste the output into the connector's **Assume-role ARN** field. Either way, save the connector before testing: the test runs against the saved configuration, so an ARN still sitting unsaved in the field is not the one Caitlyn will try.

## Verify It Works

1. In the connector dialog, select **Test this role**. Caitlyn attempts the assumption right now, exactly as the runtime performs it, and reports what AWS answered.
2. Once the connector is enabled on an agent (see **Managing Connectors** in Caitlyn's Help), trigger the handoff end to end: ask that agent to escalate, and confirm a case appears in the Amazon Connect console. This check is not available until that enablement is done, so it is not part of this guide's pass mark.

**It works when:**

- **Test this role** reports success, naming the assumed-role identity it is acting as. That alone confirms the work in this guide is complete.

**If it doesn't:**

- The test reports the assumption was denied; see [Troubleshooting](#troubleshooting)

## Troubleshooting

### Issue: The test reports the assumption was denied

**Symptoms**: **Test this role** fails with a message naming `sts:AssumeRole`.

**Solutions**:

1. Confirm the stack ran in the account the role ARN names, and that the ARN saved in Caitlyn matches the stack's `RoleArn` output exactly.
2. Compare the trust policy's principal with the **Trusted principal ARN** the dialog shows now. If your deployment's tenant role was configured after the stack ran, the principal has changed; update the stack's parameter and re-run it.
3. Check the `sts:ExternalId` condition matches the dialog's **External ID** exactly. The value is per connector, so a policy copied from another connector will not match.
4. Confirm the role name still carries the `caitlyn-connector-` prefix. Cross-account roles named otherwise are refused on Caitlyn's side before your trust policy is even consulted.

### Issue: The test passes but case creation fails

**Symptoms**: **Test this role** succeeds, yet the agent's handoff reports a failure, or no case appears.

**Solutions**:

1. Check the connector's region matches the region the stack ran in; the template's grants are scoped to that region.
2. Compare the Customer Profiles domain name and Cases domain ID stored on the connector with the values the stack was given; a mismatch leaves the role's grant pointing at resources the calls never touch.

### Issue: A hand-written trust policy fails with sts:TagSession denied

**Symptoms**: You wrote the trust policy yourself instead of using the template, and the assumption fails naming `sts:TagSession`.

**Solutions**:

1. Grant `sts:TagSession` to the same principal in its own statement, without the external ID condition. The condition key does not exist for `TagSession`, so a combined statement denies everything. The template and the dialog's rendered trust policy both encode this two-statement shape.

## Revoking Access

The role is yours, so revocation never involves Caitlyn:

- **Permanently**: delete the CloudFormation stack. The role goes with it, and every later assumption fails.
- **Temporarily**: edit the role's trust policy and change the `sts:ExternalId` condition value on the `sts:AssumeRole` statement to something Caitlyn will never present, for example `revoked`. Putting your connector's real external ID back reinstates access, with no change to the connector's configuration in Caitlyn.

Do not try to empty the trust policy's `Statement` array to suspend access: IAM rejects a trust policy with no statements (`MalformedPolicyDocument`), so the change will not save.

After revoking, **Test this role** reports the assumption as denied, which is your confirmation the door is closed.

## What's next

- **Managing Connectors** in Caitlyn's Help: enabling the connector on the agents that should use it
- **[Deploy an MCP Server](/tools/deploy-an-mcp-server/)**: the cross-account model in depth, and the same role pattern applied to an AgentCore connector
- **Live Call** in Caitlyn's Help: the separate in-browser voice escalation the same connector supports
