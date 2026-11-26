# Caitlyn CLI: GitLab CI/CD component

The sources of the `caitlyn-ai/ci-components` component project (the CLI design, 15.8). A component must live in a
project of its own, so **the CLI's release job mirrors this folder to that project** and tags it with the CLI's
release; edit the templates here, never there.

| Template | What it does |
| --- | --- |
| `setup` | A hidden `.caitlyn` job to extend: the CLI's image and secret-free sign-in with an ID token; and `caitlyn-verify-image` in `.pre`, which checks the image's signature with Caitlyn's release key |
| `diff` | Plans configuration changes in a merge request: log sections, JUnit, the plan as an artifact, an optional merge-request comment |
| `apply` | Applies configuration on the default branch, one at a time, idempotently; optionally publishes |
| `sync` | Keeps a folder in step with a knowledge base |
| `run` | Starts an unattended run, waits, and fails on the outcomes you name. Not usable yet: it needs `caitlyn unattended-runs`, which arrives with unattended runs in the API |

Every template takes `workspace`, `stage` and `cli_version`, and its own inputs (see each file's `spec:`). Each also
adds a job in `.pre` that checks the signature of the CLI image it runs (its own `cli_version`) with Caitlyn's
release key, using a cosign image pinned by digest; a failed check stops the pipeline before any later stage. Pin
`cli_version` with its digest (`0.12.0@sha256:...`) and the image checked is exactly the image run.

```yaml
include:
  - component: $CI_SERVER_FQDN/caitlyn-ai/ci-components/diff@1.0.0
    inputs:
      workspace: your-company.caitlyn.ai
      path: caitlyn/
      comment: true
  - component: $CI_SERVER_FQDN/caitlyn-ai/ci-components/apply@1.0.0
    inputs:
      workspace: your-company.caitlyn.ai
      path: caitlyn/
```

Components can be included only on the GitLab instance that hosts them. On self-managed GitLab, mirror the
component project into your own catalog, pinned to a release tag, and include it from there.

Sign-in needs a trusted-workloads rule on the workspace that names your project and its protected branch. The
templates are thin: all behaviour is the CLI's, and its tests cover it.
