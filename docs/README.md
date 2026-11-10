# Developer docs

The public developer site, `build.caitlyn.ai`, is built from this repository: the API reference from the
model, guides that pull their code from the tested examples, Markdown copies of every page and `llms.txt`.
Lane D2 of the v3 implementation plan builds it with Astro Starlight; until then `make docs` runs a skeleton
(`scripts/docs-build.mjs`) that writes a holding page and one Markdown reference page per operation, so the
publishing jobs have real input.

| Output | What it is |
| --- | --- |
| `build/docs/site/` | The static site. CI uploads it with `scripts/docs-upload.sh`. |
| `build/docs/pages.json` | One entry per page: its path, public URL, title and knowledge-base metadata. |

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
keyed by its URL, with the page URL as `sourceUrl` and these custom fields (`scripts/docs-metadata.mjs`):

| Field | Type | Meaning |
| --- | --- | --- |
| `pageType` | text | `reference`, `guide`, `example`, `concept` or `error` |
| `resources` | list of text | SDK namespaces the page covers, for example `documents` |
| `integrations` | list of text | Integrations the page covers |
| `operations` | list of text | Model operation names, for example `ListDocuments` |
| `sinceVersion` | whole number | The release the content needs, as major×10^12 + minor×10^6 + patch (5.115.0 is 5000115000000), so "available in my version" is a numeric filter |

It is a stub: it checks the metadata and, with `--dry-run`, prints what it would send. The real publisher
(lane D4) needs v3 documents with metadata (lane S3) and the TypeScript SDK's `documents.upload` (lane K1).
It signs in with the docs publisher's machine client; its client ID and secret are the masked, protected CI
variables `ASK_CAITLYN_CLIENT_ID` and `ASK_CAITLYN_CLIENT_SECRET`, set from the Caitlyn vault in 1Password.
Lane D4 plans to replace them with `workloadIdentity` once workload sign-in (lane A3) exists.
