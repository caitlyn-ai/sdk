---
pageType: guide
sinceVersion: 5000115000000
resources: []
integrations:
  - embed-widget
operations: []
---

# Embed chat in five minutes

Put Caitlyn's chat on a web page with two lines of HTML: a container and a script tag served from your own
Caitlyn workspace. The chat answers from your agent's knowledge bases, with citations, and takes its look from
your workspace's theme. There is no back end to build and no credential in the page.

## Before you start

- **Your workspace's address**, such as `your-company.getcaitlyn.ai`. Every example below uses that
  placeholder, so substitute your own. If you don't have a workspace yet, email
  [support@getcaitlyn.ai](mailto:support@getcaitlyn.ai).
- **A page you can edit**, served over HTTPS. Voice input needs a secure page.

## Step 1: Add the snippet

Put these two lines where the chat should appear:

```html
<div id="caitlyn-chat"></div>
<script src="https://your-company.getcaitlyn.ai/scripts/caitlyn-chat.js" defer></script>
```

The script creates the chat's iframe inside the `caitlyn-chat` container. It also sets the iframe's height as the
conversation grows, scrolls the page when a citation is opened, and asks for the microphone permission voice
input needs.

## Step 2: Choose how the chat sizes itself

The `data-chat-height` attribute on the container decides the chat's height:

- `auto` (the default): the chat grows with the conversation, and the page scrolls.
- `contained`: the chat fills the container's height and scrolls inside it. Give the container a height.

```html
<!-- Grows with the conversation -->
<div id="caitlyn-chat" data-chat-height="auto"></div>

<!-- Stays 600 pixels tall and scrolls inside -->
<div id="caitlyn-chat" data-chat-height="contained" style="height: 600px;"></div>

<script src="https://your-company.getcaitlyn.ai/scripts/caitlyn-chat.js" defer></script>
```

To load a particular agent rather than the workspace's default agent, add its IDs to the container. The
[embed widget](/embed/embed-widget/#install-attributes) page lists every attribute.

## Step 3: Check it works

1. Open the page. The chat appears in your theme, with its welcome message and any suggested questions.
2. Ask a question your agent's documents answer. The answer streams in, with numbered citations.
3. Open a citation. The source document opens at the passage the answer quotes.

## Troubleshooting

### The chat doesn't appear

- Check the script's `src` names your workspace exactly, and that the container's `id` is `caitlyn-chat`.
- Open the browser's developer tools. A failed script request or a Content Security Policy error in the console
  names the cause. If your site sends a `Content-Security-Policy` header, add the sources in
  [Content Security Policy](/embed/embed-widget/#content-security-policy).
- Try a private window, to rule out an extension blocking the script.

### The chat is the wrong height

- With `contained`, the container must have a height of its own, in CSS or a `style` attribute.
- Check that your own CSS isn't setting the iframe's height or `max-height`.

### The chat appears twice in a single-page app

The script ran more than once. Add it once per page, and in React or Vue remove it when the component unmounts.
The [iframe integration](/embed/iframe/#react-integration) page has components that do this.

### Voice input doesn't work

- The page must be served over HTTPS.
- The visitor must allow the microphone when the browser asks.
- If you wrote your own `<iframe>` instead of using the script, it needs `allow="microphone"`.

### Answers have no citations

- The agent needs a knowledge base with documents that have finished processing.
- Ask about something the documents cover. A question they don't answer gets no citation.

## What's next

- [Embed widget](/embed/embed-widget/): the install attributes, the browser events the chat sends, the
  `window.caitlyn` API, and the corner chat widget.
- [Iframe integration](/embed/iframe/): content-management systems, frameworks, layouts and security settings.
- [Sign-in options](/sign-in/options/): who can use the embedded chat, and how they sign in.
