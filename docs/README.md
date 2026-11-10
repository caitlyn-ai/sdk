# Developer docs

The public developer site, `build.caitlyn.ai`, is built from this repository: the API reference from the
model, guides that pull their code from the tested examples, Markdown copies of every page and `llms.txt`.
Lane D2 of the v3 implementation plan builds it with Astro Starlight; until then `make docs` runs a skeleton
(`scripts/docs-build.mjs`) that writes a holding page and one Markdown reference page per operation, so the
publishing jobs have real input.

| Output | What it is |
| --- | --- |
| `build/docs/site/` | The static site. CI uploads it with `scripts/docs-upload.sh`. |
| `build/docs/pages.json` | One entry per page: its path, public URL, title and metadata (the same values as its front matter). |

## Publishing

The hosting is in `production-demo-infrastructure`, root `developer-docs/` (lane D1): an S3 bucket and
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

None of them runs until the CI variable `DOCS_ENABLED` is `true`, which should wait for lane D2's first
real site: until then `build.caitlyn.ai` stays a 404, as D1 intends.

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
real publisher (lane D4) needs v3 documents (lane S3) and the TypeScript SDK's `documents.upload` (lane K1).
It signs in with the docs publisher's machine client; its client ID and secret are the masked, protected CI
variables `ASK_CAITLYN_CLIENT_ID` and `ASK_CAITLYN_CLIENT_SECRET`, set from the Caitlyn vault in 1Password.
Lane D4 plans to replace them with `workloadIdentity` once workload sign-in (lane A3) exists.
