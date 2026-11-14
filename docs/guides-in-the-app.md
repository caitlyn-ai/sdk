---
pageType: concept
sinceVersion: 5000115000000
resources: []
integrations: []
operations: []
---

# Guides still in the app

Some integration guides are written against the current REST API (v2), not the v3 API this site documents. They
stay in Caitlyn's Help, beside the current API's interactive reference, until v3 serves what they need. Each one
then moves here, rewritten onto the SDKs.

To open one, sign in to your workspace and go to **Help → Developers**, or add the path below to your workspace's
address, for example `https://your-company.getcaitlyn.ai/settings/documentation/developers/integration-methods`.

| Guide | What it covers | Path in your workspace |
| --- | --- | --- |
| Integration Methods | Choosing between the embed, the current REST API, or both | `/settings/documentation/developers/integration-methods` |
| API Integration | A first REST API call: a personal access token, paging, filtering and errors | `/settings/documentation/developers/guides/api-integration` |
| KB to Citation via API | Creating a knowledge base, agent and alias, uploading a document, and reading a cited answer | `/settings/documentation/developers/guides/api-knowledge-base-to-citation` |
| Unattended Runs API | Starting an agent run with documents, following it, and downloading what it produced | `/settings/documentation/developers/guides/unattended-runs-api` |
| Live Avatar Share Links | Issuing a live avatar link for one person, with session variables, from your own server | `/settings/documentation/developers/guides/live-avatar-share-links` |
| Interactive API reference | Every REST API endpoint, with a test panel (needs a role with API documentation access) | `/settings/documentation/api` |

## What v3 already covers

- **Your first call.** [Getting started](/getting-started/) installs an SDK and checks your credential, and
  [Authentication](/authentication/), [Errors](/errors/) and [Pagination](/pagination/) replace the
  conventions in API Integration.
- **Asking an agent a question and reading its cited answer.** [SendMessage](/reference/send-message/) streams
  the answer with its citations, for a person, an API client or a guest. It answers from the agent's draft for now.
- **Loading documents** is described in [CreateUpload](/reference/create-upload/) and
  [CreateDocument](/reference/create-document/). They are not served yet, so KB to Citation stays in the app until
  they are.

The API reference marks each operation that a Caitlyn release does not serve yet.
