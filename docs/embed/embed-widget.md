---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - embed-widget
  - live-avatar
operations: []
---

# Embed widget and chat widget

Add a grounded, cited Caitlyn assistant to any web page with a single script tag and an empty container, then listen for browser events to connect the widget to the rest of your site. The widget loads from your own Caitlyn domain, with no API key in the browser.

The Caitlyn embed widget is a JavaScript loader served from your workspace. It renders a chat surface into a container you place on the page, talks only to your Caitlyn workspace, and uses its theme, agents and knowledge bases.

This page covers the standard install, the events you can listen for, the `window.caitlyn` JavaScript API, and the stricter Content Security Policy you will need if your site already runs `Content-Security-Policy: script-src 'self'`. To put Caitlyn in a corner of every page instead, as a launcher that opens a chat panel, see [Chat widget](#chat-widget).

> **Before you begin**: You need a Caitlyn workspace and at least one agent. For the shortest route to a working chat, start with [Embed chat in five minutes](/embed/quick-start/).

## Install in five minutes

Add the embed snippet to your site HTML, anywhere before the closing `</body>` tag. The widget renders the chat into the `<div id="caitlyn-chat">` container, so that element must be present. Serve the `<script>` from your Caitlyn workspace: it works out the chat's address from its own `src`. Replace `{AGENT_ID}` and `{AGENT_ALIAS_ID}` with the values on the agent's page in **Settings → Agents**, or leave them out to load the workspace's default agent.

```html tab="HTML"
<!-- Caitlyn embed widget — drop in once, anywhere on the page -->
<div
  id="caitlyn-chat"
  data-agent-id="{AGENT_ID}"
  data-agent-alias-id="{AGENT_ALIAS_ID}"
  data-chat-height="auto"></div>
<script src="https://your-company.getcaitlyn.ai/scripts/caitlyn-chat.js" defer></script>
```
```jsx tab="React"
import {useEffect} from 'react';

export const CaitlynEmbed = ({agentId, agentAliasId}) => {
  useEffect(() => {
    const script = document.createElement('script');
    script.src = 'https://your-company.getcaitlyn.ai/scripts/caitlyn-chat.js';
    script.defer = true;
    document.body.appendChild(script);
    return () => script.remove();
  }, []);

  return <div id="caitlyn-chat" data-agent-id={agentId} data-agent-alias-id={agentAliasId} data-chat-height="auto" />;
};
```
```jsx tab="Next.js"
import Script from 'next/script';

export default function CaitlynEmbed({agentId, agentAliasId}) {
  return (
    <>
      <div id="caitlyn-chat" data-agent-id={agentId} data-agent-alias-id={agentAliasId} data-chat-height="auto" />
      <Script src="https://your-company.getcaitlyn.ai/scripts/caitlyn-chat.js" strategy="afterInteractive" />
    </>
  );
}
```

That is it. The widget loads the chat surface from your workspace and renders it inline. No third-party network requests are made.

### Install attributes

Only the `<div id="caitlyn-chat">` container and the `<script>` tag are required; every `data-*` attribute below is optional.

| Attribute             | Purpose                                                                           | Required   |
| --------------------- | --------------------------------------------------------------------------------- | ---------- |
| `data-agent-id`       | The agent to load. Omit to use the workspace's default agent.                     | _Optional_ |
| `data-agent-alias-id` | The agent alias to load. Pair with `data-agent-id`.                               | _Optional_ |
| `data-path`           | Path appended to the widget URL (e.g. `live-avatar`) to load a specific surface.  | _Optional_ |
| `data-chat-height`    | `contained` fills the container at 100%; `auto` grows with the content (default). | _Optional_ |

> **Note**: The agent and alias IDs are the ones the app shows today. The v3 API names an agent's configurations as versions (`draft`, `production` or a version name) rather than aliases; its attributes and event names may change when the embed moves onto the v3 API, and this page will say so first.

## Listening to events

The inline embed dispatches a `CustomEvent` on `window` for each meaningful action. Every event fires twice: as a namespaced `caitlyn:<type>` event, and on a generic `caitlyn:event` you can use as a catch-all. Hook your analytics or downstream automations into these; do not poll the DOM.

```js title="events.js"
// Targeted listener — preferred for most use cases
window.addEventListener('caitlyn:message.sent', (e) => {
  analytics.track('AskedCaitlyn', {text: e.detail.text});
});

window.addEventListener('caitlyn:citation.clicked', (e) => {
  // e.detail = { citationNumber, sourceType, sourceUrl }
  openSourceViewer(e.detail.sourceUrl);
});

// Generic catch-all — useful for logging every event
window.addEventListener('caitlyn:event', (e) => {
  const {type, payload} = e.detail;
  console.log(type, payload);
});
```

### Event reference

The `session.*` and `*.utterance` events fire only for live-avatar agents.

| Event              | Fires when                                        | Payload                                     |
| ------------------ | ------------------------------------------------- | ------------------------------------------- |
| `widget.ready`     | Widget mounted & theme applied                    | `{}`                                        |
| `message.sent`     | User sends a chat message                         | `{ text }`                                  |
| `message.received` | Assistant answer finished streaming               | `{ text }`                                  |
| `citation.clicked` | User clicks a citation                            | `{ citationNumber, sourceType, sourceUrl }` |
| `citation.opened`  | Citation modal opens                              | `{ route }`                                 |
| `citation.closed`  | Citation modal closes                             | `{}`                                        |
| `navigation`       | User navigates to a different route in the widget | `{ path }`                                  |
| `feedback.given`   | User submits feedback on an answer                | `{ score, messageId }`                      |
| `error`            | A chat answer error occurred                      | `{ level, message }`                        |
| `session.started`  | Live avatar conversation begins                   | `{ sessionId }`                             |
| `session.paused`   | Live avatar conversation paused                   | `{ sessionId }`                             |
| `session.resumed`  | Paused live avatar conversation carries on        | `{ sessionId }`                             |
| `session.ended`    | Live avatar conversation stopped or ran out       | `{ sessionId }`                             |
| `agent.utterance`  | Avatar completes a coalesced utterance            | `{ text, sessionId }`                       |
| `user.utterance`   | User completes a coalesced utterance              | `{ text, sessionId }`                       |

### Live avatar pause and resume

An administrator can turn on pause and resume for a live-avatar agent version (see **Live Avatar** in Caitlyn's Help). One conversation then keeps the same `sessionId` from `session.started` to `session.ended`, however many times it is paused, and `agent.utterance` and `user.utterance` carry that same id throughout. A pause sends `session.paused`, not `session.ended`, and a resume sends `session.resumed`, not a second `session.started`.

A paused conversation sends `session.ended` when the person ends it, when its time to resume runs out, or when `startLiveAvatarChat` replaces it with a new conversation. Treat `session.ended` as the end of the conversation in every case, and `session.paused` as a gap that may still be followed by `session.resumed`.

```js title="pause-tracking.js"
// Tracks how long each live-avatar conversation spent paused
const pausedAt = new Map();

window.addEventListener('caitlyn:session.paused', (e) => {
  pausedAt.set(e.detail.sessionId, Date.now());
});

window.addEventListener('caitlyn:session.resumed', (e) => {
  const pausedTime = pausedAt.get(e.detail.sessionId);
  if (pausedTime !== undefined) {
    analytics.track('LiveAvatarResumed', {sessionId: e.detail.sessionId, pausedMs: Date.now() - pausedTime});
    pausedAt.delete(e.detail.sessionId);
  }
});

window.addEventListener('caitlyn:session.ended', (e) => {
  pausedAt.delete(e.detail.sessionId);
});
```

## JavaScript API

The widget exposes a small API on `window.caitlyn` once the embed script has loaded. Today it provides a single method for live-avatar surfaces.

```js title="api.js"
// window.caitlyn is available once the embed script has loaded.
// Starts a live-avatar conversation (pair with data-path="live-avatar"),
// forwarding dynamic variables through to the avatar for personalisation.
window.caitlyn.startLiveAvatarChat({
  customerName: 'Ada',
  plan: 'enterprise',
});
```

`startLiveAvatarChat(variables)` forwards the supplied key-value pairs to the live-avatar surface for personalisation. Call it after the script has loaded; it is a no-op (with a console warning) if the chat iframe is not ready yet. It always starts a new conversation. A paused one is ended first, with a `session.ended` event, so it can no longer be resumed.

To hand one person's details to the live avatar without putting them in the page, issue a share link for them from your server instead. See [Live Avatar Share Links](/guides-in-the-app/). When a visitor arrives from a share link that carries variables, the live avatar uses the link's variables and ignores any passed to `startLiveAvatarChat` or on the page's address.

## Content Security Policy

If your site enforces a Content Security Policy — and it should — Caitlyn loads cleanly under `'self'` when the script and chat surface are served from your workspace. Because the widget renders the chat as an iframe, your policy must allow that origin under `frame-src` as well as `script-src`:

```text
Content-Security-Policy:
  script-src  'self' https://your-company.getcaitlyn.ai;
  connect-src 'self' https://your-company.getcaitlyn.ai;
  img-src     'self' data: https://your-company.getcaitlyn.ai;
  style-src   'self' 'unsafe-inline';
  font-src    'self' https://your-company.getcaitlyn.ai;
  frame-src   'self' https://your-company.getcaitlyn.ai;
```

> **Warning**: The widget injects a small scoped `<style>` block for its loading animation, so `'unsafe-inline'` must remain in `style-src`.

## Chat widget

The chat widget puts a launcher in the bottom right corner of the page. Visitors open it to chat with one agent in a panel styled with your Caitlyn theme, make it fullscreen, or use it as a full-height sheet on a phone. They chat as guests, without signing in, and can carry the chat on in Caitlyn. Your site's CSS does not reach the widget, and the widget's CSS does not reach your site.

### Add the snippet

Paste this tag into every page that should show the chat, just before `</body>`. Load it from your Caitlyn workspace, and replace `{AGENT_ID}` and `{AGENT_ALIAS_ID}` with the values on your agent's page. No container is needed.

```html
<script
  src="https://your-company.getcaitlyn.ai/widget.js"
  data-agent-id="{AGENT_ID}"
  data-alias-id="{AGENT_ALIAS_ID}"
  async></script>
```

| Attribute                      | Purpose                                                                      | Required   |
| ------------------------------ | ---------------------------------------------------------------------------- | ---------- |
| `data-agent-id`                | The agent visitors chat with.                                                | Yes        |
| `data-alias-id`                | The agent alias visitors chat with. Note the name: `data-alias-id`.          | Yes        |
| `data-open-in-caitlyn="false"` | Hides the header's **Open in Caitlyn** button.                               | _Optional_ |
| `data-launcher-bounce="false"` | Stops the launcher bouncing now and then before a visitor first opens it.    | _Optional_ |
| `nonce`                        | Your page's CSP nonce. The widget puts it on the styles it adds to the page. | _Optional_ |

Add the tag once per page. The widget starts once, however many tags a page has, and keeps its place on a site that swaps the page body as it navigates.

The widget needs Chrome or Edge 105, Firefox 110, or Safari 16.4 or later. In an older browser it does not appear, and your page carries on as normal.

### Allowed websites

The widget only runs on websites allowed for your Caitlyn site, and visitors chat as guests, so two settings must be on before it appears:

- **Guest access.** Visitors do not sign in, so your Caitlyn site must allow guests, and guests must be able to use the agent in the snippet.
- **The website's address.** Each website must be listed in full, with its scheme and any port, for example `https://www.example.com` and `https://staging.example.com`. A bare `*` allows nothing, and neither does a wildcard over a whole domain ending such as `https://*.com`.

Ask your Caitlyn administrator to add each website, including staging and test sites. On any website not on the list, the widget is refused and no chat opens.

### Content Security Policy

If your site sends a `Content-Security-Policy` header, add these sources to it. Replace `your-company.getcaitlyn.ai` with your Caitlyn domain, and `{S3_BUCKET_ORIGINS}` with the storage addresses your Caitlyn administrator gives you, where your agent's documents and answer images are kept.

```text
Content-Security-Policy:
  script-src  https://your-company.getcaitlyn.ai 'wasm-unsafe-eval';
  connect-src https://your-company.getcaitlyn.ai {S3_BUCKET_ORIGINS} https://cdn.jsdelivr.net/npm/@embedpdf/;
  img-src     https://your-company.getcaitlyn.ai {S3_BUCKET_ORIGINS} blob:;
  media-src   {S3_BUCKET_ORIGINS};
  style-src   'unsafe-inline';
  worker-src  blob:;
```

What each source is for:

- `script-src` loads the widget from your Caitlyn domain. `'wasm-unsafe-eval'` lets the document viewer run, so a visitor can open a document an answer cites.
- `connect-src` lets the widget talk to Caitlyn, fetch cited documents from storage, and load the document viewer's engine from `cdn.jsdelivr.net`.
- `img-src` and `media-src` show your theme's logos and the images, audio and video in answers. `blob:` previews an image a visitor attaches.
- `style-src 'unsafe-inline'` lets the widget add its styles. With a `nonce` on the script tag, the widget's styles carry that nonce instead.
- `worker-src blob:` runs the document viewer in a background worker.

The widget adds no frames, so it needs nothing in `frame-src`. **Open in Caitlyn** and website sources open in a new tab.

If your policy uses `'strict-dynamic'`, put your page's nonce on the script tag (`nonce="…"`) rather than listing your Caitlyn domain in `script-src`.

> **Note**: The storage that holds your documents must also allow your website in its CORS rules, or cited documents will not open. Your Caitlyn administrator sets this up when they add your website.

## What's next

- [Sign-in options](/sign-in/options/): who can use the inline embed, and how they sign in. The chat widget is for guests only.
- [Microsoft SSO](/sign-in/microsoft/), [Google Workspace SSO](/sign-in/google-workspace/) or [Auth0 SSO](/sign-in/auth0/): let your own people use the inline embed with their work accounts.
- [Iframe integration](/embed/iframe/): content-management systems, frameworks, layouts and the iframe's security settings.
