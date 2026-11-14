---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations:
  - microsoft-entra-id
  - google-workspace
  - auth0
operations: []
---

# Sign-in options and access control

How people sign in to Caitlyn, and how roles and groups decide what they can see and do. This page is for the
technical team choosing or reviewing sign-in for their organisation, and for anyone embedding the chat. How code
signs in, with tokens and client credentials, is on the [Authentication](/authentication/) page.

## Sign-in options

Every Caitlyn workspace has its own address and its own sign-in configuration. Your organisation chooses which of the following options are enabled: a single option for most deployments, or a combination where different audiences need different sign-in routes.

> **Note**: Once signed in, users stay signed in across visits. Where a provider supports it, sessions refresh automatically in the background. When a session can no longer be refreshed, for example after access is revoked, the user is asked to sign in again.

### Single Sign-on with Microsoft Entra ID

Users sign in with their existing work accounts through Microsoft Entra ID (formerly Azure Active Directory). No new passwords are created, leavers lose access when they leave your directory, and your directory's groups can be mapped to Caitlyn roles so access follows your existing structure. The [Microsoft SSO](/sign-in/microsoft/) guide walks through the configuration.

### Google Sign-in

Users sign in with a Google account. This suits organisations on Google Workspace, or public-facing deployments where a low-friction, verified identity is enough. The [Google Workspace SSO](/sign-in/google-workspace/) guide walks through the configuration.

### Single Sign-on with Auth0

Users sign in through your organisation's Auth0 tenant, including any enterprise connection you have set up in Auth0, such as Okta, SAML or a corporate directory. A short post-login Action in Auth0 sends each person's Auth0 roles or groups to Caitlyn, so they can be mapped to Caitlyn roles in the same way as directory groups. If you manage the Auth0 tenant yourself, Caitlyn can set it up for you from a temporary Management API token. The [Auth0 SSO](/sign-in/auth0/) guide walks through both ways.

### Email Invitations

Users are invited by email and sign in through a link sent to their inbox, with no password to create or remember. This suits smaller, curated user groups where an administrator decides exactly who gets access.

### Guest and Open Access

For public-facing deployments, visitors can use the chat without creating an account. Administrative areas remain restricted: open access applies to the conversational experience, not to settings or management screens.

### Custom Arrangements

If your users already sign in to an existing application, a custom provider can pass that session through to Caitlyn so they never see a second sign-in screen. Contact [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai) to discuss a custom arrangement.

## Access control

Signing in establishes who a user is; **roles** decide what they can do. Every user holds one or more roles, and every platform capability in Caitlyn, from using chat to managing agents, is governed by a permission that roles grant or withhold.

Access to **content** is a separate layer: which knowledge bases, folders, and documents a user can see is controlled by their group membership (from your SSO directory, or managed within Caitlyn for non-SSO sign-in options), independently of their role, so even an administrator sees only the content their groups grant. The **Roles & Permissions** article in Caitlyn's Help explains both layers in full.

In practice this means:

- **Everyday users** chat with the assistant and see only the features their role allows.
- **Administrators** additionally manage users, documents, and configuration through the Settings area.
- **Invited users** can be granted a specific role at invitation time, so access is right-sized from their first sign-in.

User management (inviting people, assigning roles, and removing access) is done in **Settings → Users** by administrators with the appropriate permission.

## The embedded chat

The inline embed uses your workspace's sign-in configuration. With guest access on, visitors chat straight away; otherwise the embed offers the same sign-in options as the app itself. The [chat widget](/embed/embed-widget/#chat-widget) is for guests only. See [Iframe integration](/embed/iframe/) for embedding details, and the [FAQ](/faq/#the-embedded-chat-says-the-browser-is-blocking-cookies) for why some browsers block sign-in inside an iframe.

## Changing your sign-in options

Your workspace's sign-in options were agreed when it was set up. An administrator with the right role adds or
changes a method in **Settings → Sign-in Methods**, using the guides in this section. To have the Caitlyn team do
it, email [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai).

## What's next

- [Microsoft SSO](/sign-in/microsoft/), [Google Workspace SSO](/sign-in/google-workspace/) and [Auth0 SSO](/sign-in/auth0/): set up single sign-on.
- [Authentication](/authentication/): how code signs in, and the rules every credential follows.
- [Embed chat in five minutes](/embed/quick-start/): put the chat on a page.
