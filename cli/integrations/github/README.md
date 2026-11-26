# Caitlyn CLI: GitHub Actions

The sources of two actions (the CLI design, 15.8). An action must live at the root of a repository of its own, so
**the CLI's release job mirrors each folder to its repository** and tags it with the release; edit them here, never
there. `setup-caitlyn` runs the published installer from `https://build.caitlyn.ai/releases/cli/` (`install.sh`, or
`install.ps1` on Windows), the one people run, never a copy of its own.

| Folder | Published as | What it does |
| --- | --- | --- |
| `setup-caitlyn/` | `caitlyn-ai/setup-caitlyn@v1` | Installs a pinned CLI (Linux, macOS and Windows), adds it to `PATH`, and with `workspace` sets `CAITLYN_WORKSPACE` and `CAITLYN_AUTH=workload-identity` |
| `diff-comment/` | `caitlyn-ai/diff-comment@v1` | Posts the Markdown plan to the pull request, updating its own comment on later pushes |

```yaml
permissions:
  contents: read
  id-token: write          # secret-free sign-in
  pull-requests: write     # the plan comment

jobs:
  caitlyn:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: caitlyn-ai/setup-caitlyn@v1
        with:
          workspace: your-company.caitlyn.ai
          version: 0.12.0
      - run: caitlyn diff -f caitlyn/ --report markdown=plan.md
      - uses: caitlyn-ai/diff-comment@v1
        with:
          file: plan.md
```

Under GitHub Actions the CLI itself writes `::group::` sections, `::error file=…,line=…::` annotations, the step
summary and `$GITHUB_OUTPUT`; the actions only install it and post the comment.
