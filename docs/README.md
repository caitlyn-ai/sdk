# Developer docs

The public developer site, `build.caitlyn.ai`, is built from this repository with Astro Starlight: the API
reference generated from the model, hand-written pages and guides whose code comes from tested examples, a
Markdown copy of every page, and `llms.txt`. `make docs` builds it (in the toolchain image); nothing after the
package install needs the network.

| Output | What it is |
| --- | --- |
| `build/docs/site/` | The static site. CI uploads it with `scripts/docs-upload.sh`. Each page is `<path>/index.html` with its Markdown copy at `<path>.md`, plus `llms.txt`, `llms-full.txt`, `robots.txt` and the Pagefind search index, and on the live build `sitemap.xml`. |
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
| `docs/embed/`, `docs/sign-in/`, `docs/tools/` | Pages that are not about the SDKs: embedding the chat, setting up sign-in, and MCP tools and connectors. Each folder is a group in the Guides section's sidebar, in the order `SECTIONS` in `scripts/docs-build.mjs` gives. |
| `docs/error-codes.mjs` | What each error code means and what to do about it; the rest of each `/errors/<CODE>/` page comes from the model. |
| `scripts/docs-reference.mjs` | The SDK reference from the model: a page per public operation, per type and per error code. An operation's Stability row shows its release (see "Since, and Not available yet" below). A released operation's stability label comes from its `@stability`. A sentence of the model's documentation that talks about the model itself (a trait, `PROTOCOL.md`, code owners) is left out (`publicDoc` in `scripts/docs-model.mjs`). |
| `scripts/docs-snippets.mjs` | The reference's runnable programs, one per `@examples` entry and language. |
| `scripts/docs-build.mjs` | Checks every page, writes the Starlight content (`docs/site/src/content/docs/`, generated) and the sidebar's sections (`docs/site/src/generated/sidebar.json`, for starlight-sidebar-topics: Get started, Guides, How the API works, SDK reference and API reference, each with its own sidebar; a new start page lands in Get started unless `TOPIC_START` places it), runs `astro build`, then writes the Markdown copies, `llms.txt` and `pages.json`. |
| Icons | Material Symbols Rounded (outlined, weight 400; the Caitlyn app's set) for the sections and the sidebar's groups, and Simple Icons' monochrome logos for the languages on code blocks and tabs, from the installed Iconify sets (`@iconify-json/*`). `scripts/docs-build.mjs` writes them into `src/generated/icons.css` as CSS masks in the text colour; the mapping is `TOPIC_ICONS`, `GROUP_ICONS` and `LANGUAGE_ICONS` there. Page links have none. |
| `scripts/docs-api.mjs` | The HTTP API's reference at `/api/`, built from the site's copy of `model/openapi.json`: an overview (the server, authentication, every operation by resource with its method, and a link to download the document) and a page per operation at `/api/<operation>/`. The pages use the SDK reference's layout and row builder (`paramRow` in `scripts/docs-reference.mjs`): wire names first, the SDK's name as a chip, the same limit wording; responses as a success row with its fields and a row per error status listing its codes. The code panel has curl (the reader's workspace, `$CAITLYN_TOKEN`) and the four SDKs, beside the HTTP response or, for a stream, a sample sequence of events. What the document does not carry (a `$ref` member's description, SDK names, error codes, a stream's events) comes from the model. The site's copy is published at `/api/openapi.json` (`docs/site/public/api/`, generated): grouped and titled as in the SDK reference, each operation opening with a link to it there and carrying its SDK examples as `x-codeSamples`. Scalar's old addresses (`/api/#tag/...`) go on to the operation's page. |
| `scripts/docs-wording.mjs` | The public-wording check, over every page and the published OpenAPI document. |
| `scripts/docs-changelog.mjs` | The Changelog (`/changelog/`, a start page) and its Atom feed (`/changelog/feed.xml`, named in every page's head): every stable SDK release, from `CHANGELOG.md`, which semantic-release writes with each release, and every API release kept in `model/changes/`. One entry per release with its date, version and changes, breaking changes marked, each change linked to the pages it touches (its scope's page, the topic its words are about, and any operation, type or error code it names). While a beta is newer than the latest stable release, the page opens with one **In beta** row: the newest beta's notes (`scripts/release-notes.mjs` `betaNotes`, the same notes as its GitHub pre-release) and the commands that install it. The feed has no entry for a beta, nor for a merge request's Unreleased entry. A release heading or change it cannot read fails the build, and so does release-note text the public-wording check refuses. |
| `scripts/docs-mr-title.mjs` | The public-wording check over a merge request's title (the `docs:mr-title` job, every merge request). A releasing title (feat, fix, perf, revert, or any type with `!`) becomes a Changelog line, so its subject and scope must pass the same rules as a page; a draft marker is ignored. GitLab starts no pipeline for a title edit, so rerun the job after one. |
| `scripts/docs-sitemap.mjs` | What the site tells search engines. Only the live build (`DOCS_LIVE=on`, which `docs:build` sets on `main` and on a release's `v*` tag alone) writes `sitemap.xml`, every page at its `build.caitlyn.ai` address with `lastmod` its source's newest commit (the build's date where git cannot say, as in `make docs` from a worktree), and names it in `robots.txt`. Any other build, a merge request's preview above all, writes no sitemap and gives every page `noindex, nofollow`; the build checks each page's robots meta. |
| `docs/site/src/components/ServerBlock.astro`, `docs/site/src/scripts/workspace.ts` | The Workspace box (`https://{workspace}/api` with the workspace as a field, labelled Workspace) on every operation page and the API reference's overview. What the reader types is one setting for the whole site, kept in the browser: every code block and copy button shows it in place of `your-company.caitlyn.ai`. |
| `docs/site/` | The Astro Starlight project, with Astro and Starlight pinned to exact versions in `package-lock.json`. |

The build fails on front matter ingestion would skip, a page whose code differs from its example, a
site-relative link to a page or heading that does not exist, a raw HTML heading, and a page Starlight did not write.

**Since, and Not available yet.** Whether workspaces serve an operation, and since which release, comes from the
latest model the app has published, not from the snapshot the SDKs are generated from. `scripts/docs-build.sh`
fetches `caitlyn-v3-model/latest/model.json` to `build/published-model.json` (`scripts/model-latest.sh`, with the job
token in CI, or `GITLAB_TOKEN` or glab locally) before the build. An operation that model gives a release shows
"Since Caitlyn X.Y.Z", that release, with no callout, however old or new the snapshot is. Any other operation says
"Not available yet": the operations a `model:main` pre-release snapshot adds ahead of the latest release. The callout
and the Stability row name the release it arrives in from `model/model.lock.json`'s `stampNext` ("Not available yet:
arrives in Caitlyn 5.158.0. The SDKs have this operation, but workspaces serve it only from that release."), the
number `scripts/prepare-model.mjs` stamps on it and the SDKs' doc comments show, so the site and the SDKs agree; with
no `stampNext` the callout says only "Not available yet", and the operation shows as Preview. If the published model
can't be read, the build warns and falls back to the snapshot: an operation still `"next"` in the raw
`model/model.json` is the unreleased one.
A hand-written page gets the same callout from a `<!-- not-available -->` line (its front matter's `operations`, or
`<!-- not-available: SendMessage, WatchConversation -->`), shown while any of them is unreleased and dropped once they
all are (`fillNotAvailable`). `publishedModel()`, `unreleasedOperations()` and `nextRelease()` in
`scripts/docs-model.mjs` decide it; `docs/site/test/published-model.test.mjs` checks the published model's part, and
`docs/site/test/not-available.test.mjs` the callout, the released case with a fixture lock and model
(`docs/site/test/fixtures/released.*.json`).

**Stability and the release channel.** Two separate things, which never share a word or a style
(`scripts/docs-releases.mjs` says how each is decided):

- **Stability** is the model's `@stability`: experimental, then preview, then GA (and internal, which the site leaves
  out). The model's older `beta` is preview. A preview operation has a quiet outline **Preview** badge, under its
  title and in its Stability row; an experimental one its own **Experimental** badge; a generally available one none.
- **The release channel** is the **Beta label**: "New in 0.12.0-beta.1" in the accent fill, linking to
  [Install a beta](/getting-started/#install-a-beta). It is only for what no stable release has yet, so an operation
  can show both: "Preview · New in 0.12.0-beta.1". It is written as a Markdown link titled `Beta: …` (`betaLabel`),
  which `src/plugins/rehype-channels.mjs` styles on the site, so the Markdown copies keep an ordinary link.

The site is built from `main` but describes the latest stable release, the one a package manager installs. What only a
beta has stays where it belongs, with the Beta label, and its page has a small Beta marker in the sidebar:

- **The reference** compares the model at the latest stable tag with main's (`apiChannels`, through
  `scripts/model-diff.mjs`): an operation, member or enum value main adds gets the label, from the first beta tag
  that has it ("New since 0.11.0" when only main has it). A member main changes shows its stable form, with a
  switch, "Stable 0.11.0 | Beta 0.12.0-beta.1", to the beta's, read from the stable model (its type may not be in
  main's); the Markdown copy gives both. A member or enum value main drops stays as the stable release has it, with
  "Removed in 0.12.0-beta.1" on the beta side of the switch, and an operation main drops keeps a page built from the
  stable model, saying the betas no longer have it, under "Not in the betas" in the sidebar. An experimental
  operation always has the label, since only the betas have it. Preview (or `beta`) and experimental operations are
  all public to the diff (`scripts/model-diff.mjs`), so renaming `beta` changes nothing.
- **A hand-written section that is new** has `<!-- sdk-release: <change file> -->` under its heading: the label for the
  release that change file arrived in (the tags that contain the commit that added it, or the one its `commit:`
  names), and nothing once a stable release has it. **A section a beta changes** is written both ways:

  ```markdown
  <!-- channel-toggle: <change file> -->
  <!-- stable -->
  … as the stable release has it …
  <!-- beta -->
  … as the beta has it …
  <!-- /channel-toggle -->
  ```

  which shows the stable side with the switch, and only the beta side once a stable release has the change. The
  switch sets the whole page and is remembered (`src/scripts/channel-switch.ts`); the Markdown copy gives both sides,
  each under its name. A marker or block naming no change file fails the build.
- **Installing.** Getting started's `<!-- install -->` line is each language's stable commands with the newest beta's
  beside them, and `<!-- install-beta -->` the Install a beta section: that beta's version on each registry and its
  commands (`npm install @caitlyn-ai/sdk@beta`, `pip install --pre caitlyn`, `go get …@v<beta>`,
  `cargo add caitlyn-sdk@<beta>`). The Changelog opens with the newest beta's notes as one **In beta** row.
- **The CLI.** `scripts/docs-build.sh` reads its channel pointers (`scripts/cli-channels.sh`, from
  `https://build.caitlyn.ai/releases/cli/channels/`). Until the CLI has a stable release, every CLI page carries the
  Beta label after its lead (the CLI beta's version, else the SDK beta the CLI arrived in), linking to
  [Installing the CLI](/cli/install/); until it has any release, a callout says there is none to install yet, as
  Getting started's `<!-- cli-release -->` line does. `{{cliVersion}}` and `{{cliMinor}}` are its stable release's
  version and minor line (the container tag), or `X.Y.Z` and `X.Y` before it.

In CI the build fetches the whole history and every tag first: docs:build's checkouts have been 20 commits deep,
whatever GIT_DEPTH it asks for. A build that publishes (`DOCS_LIVE=on`, or any build on main or a tag) fails when it
can't read the whole history, a stable tag or the CLI's channel pointers (a 404 is "no release yet"; anything else is
a failure); any other build warns. A local checkout without tags has no stable release to compare with, so nothing
is labelled.

**Markdown is the canonical output.** Each page is first written as Markdown with its knowledge-base front matter,
and that is its `.md` copy; the HTML is built from the same text. The title is written `# Title {#_top}`, the id
Starlight gives the page title, so a citation anchor under the title matches the page.

**Language tabs.** Consecutive code blocks whose info string has `tab="<label>"` become one tab group
(`docs/site/src/plugins/remark-lang-tabs.mjs`); the `.md` copy keeps them one after another, each labelled. On the
site, `docs/site/src/scripts/lang-tabs.ts` shows one language at a time, remembers the reader's choice, and opens
the tab that `?lang=<typescript|python|go|rust|curl>` names. curl is the API reference's: chosen there, it is the site's
language, and wherever curl is not offered TypeScript shows in its place.

**Heading ids and fragment links.** A heading's id is github-slugger over its text, one slugger per page, or the
`{#id}` at the end of the heading (`docs/site/src/plugins/remark-heading-ids.mjs`). These are the anchors
caitlyn-data-ingestion gives citations; `docs/site/test/heading-ids.test.mjs` runs the fixture both repositories
share (`heading-ids.json`, a copy of the ingestion repository's `pdf/topic/tests/fixtures/heading_ids.json`). A
`:~:text=` link into a code block in a hidden tab opens that tab and highlights the text; Safari hides the
fragment from scripts, so there the link only works for text that is already visible. The site does not change
quotes or dashes in text (no SmartyPants), so a quote taken from the Markdown matches the page.

## Theme and components

The site is styled in the Caitlyn Design System: `docs/site/src/styles/caitlyn.css` maps its tokens onto
Starlight, and `components.css` styles the site's own components. Every colour, type size and weight is a token (the type sizes are the system's, times one scale, `--caitlyn-type-scale`, 0.9, with reading text at 15px),
named beside it; a choice the system does not cover is marked `GAP`. Shapes follow caitlyn.ai rather than the
system's sharp corners: rounded buttons, panels, cards and code blocks (the radius values are at the top of
`caitlyn.css`). The site's one accent colour is amber (`amber-primary`), never as text: it
marks links' underlines, the current page, tab and contents entry, the note rule, and fills the selected tab and the
card icons' tiles with ink on them (with the Get started button). Its tone `amber-accent-01` is the hover on an amber
fill, and clay (`clay-primary`) takes amber's place where amber would read as a warning: the "Needs work" answer and the errors' warning tile. Code is
coloured from the palette (`src/code-theme.mjs`). The two Euclid files are preloaded, and a local fallback face
metric-matched to Euclid keeps text still when they arrive.

| Component | What it does |
| --- | --- |
| `Hero.astro` | The landing page's hero: the system's Edge cover archetype on the dark cover ground, with the approved amber orb (`src/assets/orb-amber.png`, as supplied) entering from the right, the title, the tagline and a Get started button. Under it, the four places most readers start, as cards. |
| `PageTitle.astro` | The page header: a kicker naming where the page sits, then the title. The page's first paragraph is styled as its lead, and a strong rule closes the opening on every page. Only a guide (`pageType: guide`) numbers its sections 01, 02 and on, because only a guide's sections are steps. |
| `WhatsNext.astro`, `NextCards.astro` | "What's next" at the end of a page: four cards or two, two across, each with an icon, the section's label, the title and a description. The candidates are the page's own closing `## Next` (or `## Next steps`, `## What's next`) list, which the build takes out of the page body (the Markdown copies keep it), then the page's entry in `src/whats-next.json`, then the pages beside it in the sidebar; the page the Next link already shows is left out. An item in the page's list that is not a page on this site stays as a note under the cards. |
| `Feedback.astro` | "Was this page useful?", a rounded panel with Helpful and Needs work buttons. Shown only when the build sets `PUBLIC_DOCS_FEEDBACK=on` (the live build and merge request builds do), and sent only when it also sets `PUBLIC_DOCS_FEEDBACK_ENDPOINT` (only the live build does); it sends the page's path and yes or no, nothing else. Without an endpoint it says the answer was not sent. |
| `Pagination.astro` | Previous and next, in sidebar order, as two rounded cards. |
| `rehype-tables.mjs` | Every table cell carries its column's label. The reference's member, event and error tables become compact rows: the name (or status) with a muted line of its type and where it is sent (or its error class), and a Required label; the codes and description beside it. Another table of four or more columns reads as an index. A cell of comma-separated codes becomes a list. |
| `remark-lang-tabs.mjs`, `code-theme.mjs` | Language tabs, which are a code block's header bar; a code block outside tabs gets a header bar naming its language. Code sits on `cover-ground` in a rounded frame with a copy button, coloured from the palette: one token for each of keywords, strings, types, numbers, function names, property names, comments and punctuation. |
| `rehype-landing.mjs` | On the landing page only: a list of "title: description" items becomes a numbered index, and the SDK table becomes cards. |

**The Caitlyn widget** is a placeholder (`docs/site/src/components/CaitlynWidgetPlaceholder.astro`) that renders
nothing until the v3 widget and embed work is done.

## Publishing

The hosting is in `production-demo-infrastructure`, root `developer-docs/`: an S3 bucket and
CloudFront distribution for the live site, and a preview bucket with one prefix per merge request. CI signs
in to AWS with GitLab `id_tokens` (OIDC, audience `https://git.customd.com`); the roles trust only
`project_path:custom-d/caitlyn/sdk`, so these jobs work only in that GitLab project.

| Job | When | Role (CI variable) | What it does |
| --- | --- | --- | --- |
| `docs:build` | Merge requests, `main` and a release's `v*` tag | none | `make docs`; on `main` and the tag with `DOCS_LIVE=on` (the sitemap, indexed pages) and the whole history (the sitemap's dates) |
| `docs:preview` | Merge requests | `DOCS_PREVIEW_ROLE_ARN` | Uploads to `mr-<iid>/` in the preview bucket: `https://mr-<iid>.preview.build.caitlyn.ai/` |
| `docs:preview:stop` | Manual, or when the merge request closes | `DOCS_PREVIEW_ROLE_ARN` | Deletes the preview |
| `docs:publish` | `main`, and a release's `v*` tag (its Changelog and install instructions name the new release) | `DOCS_PUBLISH_ROLE_ARN` | Uploads the live site and invalidates `DOCS_DISTRIBUTION_ID` |
| `docs:knowledge-base` | `main`, after `docs:publish` | none yet | A dry run of `scripts/docs-kb-publish.mjs` (see below) |

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
real publisher needs the v3 document operations on the server and the TypeScript SDK's `ingestion.sync`.
It signs in with the docs publisher's machine client; its client ID and secret are the masked, protected CI
variables `ASK_CAITLYN_CLIENT_ID` and `ASK_CAITLYN_CLIENT_SECRET`, set from the Caitlyn vault in 1Password.
They are to be replaced with `workloadIdentity` once the server accepts workload sign-in.

## No internal details

The published pages say what the SDK does, in the reader's terms. `scripts/docs-build.mjs` fails the build when a
page's prose mentions `PROTOCOL.md`, Smithy, the conformance suites, a model trait, the generators, a repository
path, or release plans, or when any line names a merge request or an internal host. Write what the reader can do
and what happens instead; a behaviour that is not available yet is left out, or says so in plain terms.
