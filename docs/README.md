# Developer docs

The public developer site, `build.caitlyn.ai`, is built from this repository with Astro Starlight: the API
reference generated from the model, hand-written pages and guides whose code comes from tested examples, a
Markdown copy of every page, and `llms.txt`. `make docs` builds it (in the toolchain image); nothing after the
package install needs the network.

| Output | What it is |
| --- | --- |
| `build/docs/site/` | The static site. CI uploads it with `scripts/docs-upload.sh`. Each page is `<path>/index.html` with its Markdown copy at `<path>.md`, plus `llms.txt`, `llms-full.txt` and the Pagefind search index. |
| `build/docs/pages.json` | One entry per page: its Markdown copy's path, public URL, title and metadata (the same values as its front matter). |

To work on it locally:

```bash
make docs                                   # or, with Node 24 on your machine:
(cd docs/site && npm ci) && node scripts/prepare-model.mjs && node scripts/docs-build.mjs
(cd docs/site && npx astro preview)         # serves build/docs/site at http://localhost:4321
```

## How it is built

| Where | What |
| --- | --- |
| `docs/*.md`, `docs/guides/*.md` | The hand-written pages: the landing page (`index.md`), Getting started, Authentication, Errors, Retries, Streaming, Pagination, Telemetry, the FAQ, Guides still in the app, and the guides. The file's path is the page's address. |
| `docs/embed/`, `docs/sign-in/`, `docs/tools/` | Pages that are not about the SDKs: embedding the chat, setting up sign-in, and MCP tools and connectors. Each folder is a sidebar section, in the order `SECTIONS` in `scripts/docs-build.mjs` gives. |
| `docs/error-codes.mjs` | What each error code means and what to do about it; the rest of each `/errors/<CODE>/` page comes from the model. |
| `scripts/docs-reference.mjs` | The API reference from the model: a page per public operation, per type and per error code. `LIVE_OPERATIONS` lists the operations Caitlyn workspaces serve; every other operation's page says it is not available yet, and shows it as beta. A sentence of the model's documentation that talks about the model itself (a trait, `PROTOCOL.md`, code owners) is left out (`publicDoc` in `scripts/docs-model.mjs`). |
| `scripts/docs-snippets.mjs` | The reference's runnable programs, one per `@examples` entry and language. |
| `scripts/docs-build.mjs` | Checks every page, writes the Starlight content (`docs/site/src/content/docs/`, generated) and sidebar, runs `astro build`, then writes the Markdown copies, `llms.txt` and `pages.json`. |
| `docs/site/` | The Astro Starlight project, with Astro and Starlight pinned to exact versions in `package-lock.json`. |

The build fails on front matter ingestion would skip, a page whose code differs from its example, a
site-relative link to a page or heading that does not exist, a raw HTML heading, and a page Starlight did not write.

**Markdown is the canonical output.** Each page is first written as Markdown with its knowledge-base front matter,
and that is its `.md` copy; the HTML is built from the same text. The title is written `# Title {#_top}`, the id
Starlight gives the page title, so a citation anchor under the title matches the page.

**Language tabs.** Consecutive code blocks whose info string has `tab="<label>"` become one tab group
(`docs/site/src/plugins/remark-lang-tabs.mjs`); the `.md` copy keeps them one after another, each labelled. On the
site, `docs/site/src/scripts/lang-tabs.ts` shows one language at a time, remembers the reader's choice, and opens
the tab that `?lang=<typescript|python|go|rust>` names.

**Heading ids and fragment links.** A heading's id is github-slugger over its text, one slugger per page, or the
`{#id}` at the end of the heading (`docs/site/src/plugins/remark-heading-ids.mjs`). These are the anchors
caitlyn-data-ingestion gives citations; `docs/site/test/heading-ids.test.mjs` runs the fixture both repositories
share (`heading-ids.json`, a copy of the ingestion repository's `pdf/topic/tests/fixtures/heading_ids.json`). A
`:~:text=` link into a code block in a hidden tab opens that tab and highlights the text; Safari hides the
fragment from scripts, so there the link only works for text that is already visible. The site does not change
quotes or dashes in text (no SmartyPants), so a quote taken from the Markdown matches the page.

**The Caitlyn widget** is a placeholder (`docs/site/src/components/CaitlynWidgetPlaceholder.astro`) that renders
nothing until the v3 widget and embed work is done.

## Publishing

The hosting is in `production-demo-infrastructure`, root `developer-docs/`: an S3 bucket and
CloudFront distribution for the live site, and a preview bucket with one prefix per merge request. CI signs
in to AWS with GitLab `id_tokens` (OIDC, audience `https://git.customd.com`); the roles trust only
`project_path:custom-d/caitlyn/sdk`, so these jobs work only in that GitLab project.

| Job | When | Role (CI variable) | What it does |
| --- | --- | --- | --- |
| `docs:build` | Merge requests and `main` | none | `make docs` |
| `docs:preview` | Merge requests | `DOCS_PREVIEW_ROLE_ARN` | Uploads to `mr-<iid>/` in the preview bucket: `https://mr-<iid>.preview.build.caitlyn.ai/` |
| `docs:preview:stop` | Manual, or when the merge request closes | `DOCS_PREVIEW_ROLE_ARN` | Deletes the preview |
| `docs:publish` | `main` | `DOCS_PUBLISH_ROLE_ARN` | Uploads the live site and invalidates `DOCS_DISTRIBUTION_ID` |
| `docs:knowledge-base` | `main`, after `docs:publish` | none yet | A dry run of `scripts/docs-kb-publish.mjs` (see below) |
| `pages` | Merge requests, whatever `DOCS_ENABLED` says | none | Builds the docs under the merge request's GitLab Pages path and deploys them there for a week: a private parallel deployment, `mr-<iid>`, that only project members can open. The merge request's environment links to it. |

None of them runs until the CI variable `DOCS_ENABLED` is `true`. The roles' ARNs and the distribution ID are
the CI variables `DOCS_PREVIEW_ROLE_ARN`, `DOCS_PUBLISH_ROLE_ARN` and `DOCS_DISTRIBUTION_ID`.

## Code on the pages

A page's code comes from the examples in `examples/`, which CI compiles against each SDK. Mark a region in the
example with `// #region <name>` and `// #endregion` (`# #region` and `# #endregion` in Python), and put a marker
line before the page's code block:

````markdown
<!-- example: examples/typescript/browser-sign-in-page.ts#sign-in -->
```ts tab="TypeScript"
```
````

`node scripts/docs-guides.mjs --write` copies each region, less its shared indentation, into its code block, and
`node scripts/docs-guides.mjs` (run by `scripts/test-typescript.sh` in CI, and by the docs build) fails when a
block differs from its region, a region is missing or the front matter is one ingestion would skip.

| Language | Examples | Compiled by |
| --- | --- | --- |
| TypeScript | `examples/typescript/` | `tsc --strict` in `scripts/test-typescript.sh` |
| Python | `examples/python/` | `pyright --strict` in `scripts/test-python.sh` |
| Go | `examples/go/` (its own module, using `go/`) | `go build`, `go vet` and `staticcheck` in `scripts/test-go.sh` |
| Rust | `examples/rust/` (its own crate, using `rust/caitlyn-sdk`) | `cargo clippy -D warnings` in `scripts/test-rust.sh` |

The reference's programs are generated into `examples/<language>/reference/` (`examples/rust/examples/` for
Rust) by `node scripts/docs-snippets.mjs <language>`, which each of those scripts runs first; the directories are
ignored by git. So a model or SDK change that breaks a program shown in the docs fails that language's job.

Guides are in `docs/guides/`, named for the task in the imperative (`sign-in-from-a-browser.md`), with
`pageType: guide`. Every hand-written page starts with front matter (below), then a `#` title.

## Into Ask Caitlyn

Ask Caitlyn answers from the developer docs. `scripts/docs-kb-publish.mjs` will publish each page as a
document in the `ask.caitlyn.ai` workspace's developer-docs knowledge base (`01M73EYJMHXXS4GMWBG827B7RB`),
keyed by its URL, with the page URL as `sourceUrl`.

The page's metadata is its **front matter**, written by the docs build (`scripts/docs-metadata.mjs`).
Markdown ingestion (caitlyn-data-ingestion !313) reads every front-matter key that equals one of the
knowledge base's custom fields, validates the value against the field's type and options, and stores it; the
model does not infer those fields. So the publisher sends no metadata of its own, and nothing is updated after
upload. Valid values are applied again on every ingest; a field an operator has locked keeps its value.

| Key (exact, case matters) | Type | Values |
| --- | --- | --- |
| `pageType` | one option | `guide`, `concept`, `reference`, `error`, `sdk`, `cli`, `migration`, `changelog` |
| `resources` | list of options | `agent`, `version`, `conversation`, `knowledge-base`, `document`, `upload`, `operation`, `organisation`, `policy-review`, `unattended-run`, `workspace` |
| `integrations` | list of options | `microsoft-entra-id`, `google-workspace`, `auth0`, `mcp-server`, `mcp-connectors`, `amazon-connect`, `live-avatar`, `embed-widget`, `agentcore`, `workload-identity` |
| `operations` | list of text | Model operation names, for example `ListDocuments` |
| `sinceVersion` | whole number | The release the content needs, as major×10^12 + minor×10^6 + patch (5.115.0 is 5000115000000), so "available in my version" is a numeric filter |

Options take the option key, not its label. A number may be written as text, and a list field takes a YAML
list or a single value. For example:

```yaml
---
pageType: reference
sinceVersion: 5000115000000
resources:
  - document
integrations: []
operations:
  - ListDocuments
---
```

Ingestion skips an invalid value and records it as a partial failure, so both the docs build and the
publisher check every page against these options first, and fail rather than publish a page ingestion would
only partly read.

The publisher is a stub: it checks the front matter and, with `--dry-run`, prints what it would send. The
real publisher needs the v3 document operations on the server and the TypeScript SDK's `documents.upload`.
It signs in with the docs publisher's machine client; its client ID and secret are the masked, protected CI
variables `ASK_CAITLYN_CLIENT_ID` and `ASK_CAITLYN_CLIENT_SECRET`, set from the Caitlyn vault in 1Password.
They are to be replaced with `workloadIdentity` once the server accepts workload sign-in.

## No internal details

The published pages say what the SDK does, in the reader's terms. `scripts/docs-build.mjs` fails the build when a
page's prose mentions `PROTOCOL.md`, Smithy, the conformance suites, a model trait, the generators, a repository
path, or release plans, or when any line names a merge request or an internal host. Write what the reader can do
and what happens instead; a behaviour that is not available yet is left out, or says so in plain terms.
