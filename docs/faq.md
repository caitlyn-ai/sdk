---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations:
  - embed-widget
operations: []
---

# FAQ

The questions integrators ask most often, and how to reach a person when these pages don't answer yours.

## Which way should I integrate?

- **To put a chat in front of people**, embed it: [Embed chat in five minutes](/embed/quick-start/) for a page
  section, or the [chat widget](/embed/embed-widget/#chat-widget) for a launcher in the corner of every page. In a
  native mobile app, embed the same chat in a web view.
- **To call Caitlyn from your own code**, use an SDK: [Getting started](/getting-started/). The v3 API is in
  preview; the [guides still in the app](/guides-in-the-app/) cover the current API for what v3 doesn't serve yet.
- **To give your agents tools of your own**, build an MCP server: [Deploy an MCP server](/tools/deploy-an-mcp-server/).
- **To call Caitlyn from an AI assistant**, connect it to Caitlyn's MCP server:
  [Connect an MCP client](/tools/connect-an-mcp-client/).

## Can people sign in with their work accounts?

Yes. Caitlyn supports Microsoft Entra ID, Google Workspace and Auth0, as well as email invitations and guest
access. See [Sign-in options](/sign-in/options/).

## Troubleshooting

### The embedded chat says the browser is blocking cookies

Visitors see a message titled "Your browser is blocking cookies for this chat" in place of the sign-in options,
with a button to open Caitlyn in a new tab.

Caitlyn keeps a visitor's session in a cookie. Inside an iframe on your site that is a cross-site cookie, and some
browsers refuse to store it. Caitlyn checks for this directly: it sets a small test cookie and looks for it on the
next request. The message appears only when the test cookie does not come back, so it is never triggered by a
network or server problem.

Safari is the usual cause. It accepts cross-site cookies of this kind only from Safari 18.4 onwards, and never for
a domain its tracking prevention has flagged as a tracker. That flag is decided inside each visitor's own
browser, from their browsing history, so the same embed can work for one Safari user and not another. Any browser
with third-party cookies switched off, or with a content blocker installed, behaves the same way.

Things to check:

- The visitor's browser and version: on Safari, anything before 18.4 cannot store the cookie at all.
- Safari's "Prevent cross-site tracking" setting (Settings > Privacy): turning it off allows the cookie, but most
  visitors will not want to change it.
- Content blockers or privacy extensions in the visitor's browser.
- Whether your page and the Caitlyn embed share a site: an embed served from a hostname under your own domain is
  first-party, and the restriction does not apply. Contact [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai)
  to arrange this.

The button in the message always works: it opens the chat at the top level in a new tab, where the cookie is
first-party.

The [chat widget](/embed/embed-widget/#chat-widget) is not an iframe, and visitors use it as guests, so it is not
affected.

### The embedded chat doesn't appear

See [Embed chat in five minutes](/embed/quick-start/#troubleshooting). Most often the page's Content Security
Policy blocks it, and the browser console says which directive.

### An API call is refused

Every refusal carries a `code` and a `type` link to a page explaining it. See [Errors](/errors/) and, for
a credential that is refused outright, [When a token is refused](/authentication/#when-a-token-is-refused).

## Billing and evaluation

For pricing and usage, or an evaluation workspace to test an integration against, email
[support@getcaitlyn.ai](mailto:support@getcaitlyn.ai).

## Getting help from a person

Email [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai). We reply within 24 hours on business days; put "urgent" in the
subject line for anything that is stopping your service.

To report a bug, include the steps to reproduce it, what you expected and what happened, your browser or runtime,
and any `Caitlyn-Request-Id` the API returned. Report security vulnerabilities to the same address, and don't
post details publicly.

For a feature request, describe what you are trying to do and the problem it would solve.
