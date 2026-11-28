# Contributing

Everything runs in the toolchain image (`docker/Dockerfile`) through `scripts/docker.sh`: `make` does that
for you. CI runs the same scripts in the same image, so a local run and CI agree.

## Rules

- **Never edit generated code.** `typescript/packages/sdk`, `python/caitlyn`, the generated `go/*.go` files
  (each starts with `// Code generated … DO NOT EDIT.`), `rust/caitlyn-sdk` and `conformance/cases/examples.json`
  come from the model. Change the generator, the runtime or the model, then `make generate`, and commit both. The `generate`
  CI job fails when the committed code differs from a fresh generation.
- **Never edit `model/` by hand.** It is a copy of a published model; `scripts/model-pull.sh` writes it and its
  lock file together, and `scripts/prepare-model.mjs` refuses a snapshot whose SHA-256 does not match the lock.
- **The model and `PROTOCOL.md` change in the app repository**, in `smithy/` (`smithy/PROTOCOL.md` for the
  protocol), not here. A protocol change is agreed for every SDK before any of them implements it, and lands with
  a conformance case that every SDK passes. The `model:snapshot-only` CI job refuses a merge request that edits
  `model/` without pulling a model ("The model snapshot", below).
- **Every protocol behaviour has a conformance case** in `conformance/cases/protocol.json`, and every harness
  runs it. Adding a case there fails the other languages until they implement it, which is the point.
- **Committed generated code comes only from the locked model**, by `make generate`. The `generate` CI job and the
  snapshot check (`model:snapshot-only`) enforce it. `build/dev-sdk/` is the app's local loop ("The app's local
  loop", below): an SDK built from a model that is not locked, for one app worktree. It is gitignored; never copy
  anything from it into the tracked tree, and never commit it.

## Tests and time

Every timer in a test is deterministic. A test that waits on the wall clock passes on a quiet machine and fails on
a busy CI runner, and one that changes what the code does under test no longer tests what users run. So tests
control time from outside the code, never from inside it:

1. **Wait on events, never on time.** A test waits for the thing itself: a hold the mock server releases (such as
   `holdJobs`), a request it recorded, a channel or a state change. Never a fixed sleep that hopes it has happened.
2. **No upper bounds on real elapsed time** ("dropped within a second"): a busy runner breaks them. Assert order,
   counts and outcomes. Where a deadline is the behaviour under test (a timeout firing), use virtual time.
3. **Virtual time comes from below the code, never from a hook in it.** The SDKs and the CLI have no test-only
   clock or switch; virtual time replaces the platform's own:
   - Go: `testing/synctest`. Inside its bubble, timers, tickers and `time.Sleep` run on a fake clock that moves
     only when every goroutine is blocked. It can't control a real socket, so give the code an `http.Client` with
     an in-memory transport there.
   - TypeScript: Node's `mock.timers`, which replaces the global timers the SDK already calls.
   - Python: an event loop with a virtual clock.
   - Rust: `tokio`'s paused time, only where nothing waits on a real socket.
4. **Shorter waits through public options.** Tests shorten a wait with the same documented option a user has: a
   call or stall timeout, a wait's timeout, a retry delay. If a wait has no such option and a user could reasonably
   want one, add a real, documented option; never a test-only knob.
5. **Lower bounds are fine** ("waited at least the `Retry-After`"): they can't fail spuriously. Keep them short (a
   small `Retry-After` from the mock) or virtual.

`scripts/test-timers.mjs` (the `tests:timers` CI job, `make test-timers`) finds the wall clock in the tests of every
language: sleeps, timers and clock reads. Where one is right, such as a sleep inside a synctest bubble, a comment
on its line or the line above says why: `// timers: virtual (synctest)`. Today's remaining uses are counted per file
in `scripts/test-timers-baseline.json`, a ratchet: no file may gain one, a new file has none, and when a file loses
some, `node scripts/test-timers.mjs --update` lowers its count, which the check asks for.

## Regenerating

```bash
make generate
```

`scripts/generate.sh` does, in order:

0. `scripts/version.mjs stamp`: writes the version in `VERSION` into the hand-written files that carry it and into
   the generator settings (see "Versions" below).
1. `scripts/prepare-model.mjs`: checks `model/model.json` against the lock file and writes
   `build/model/model.json`, without the app's lint-rule metadata (those rules run in the app's model build)
   and with any `@since("next")` stamped as the lock's `stampNext`. Only a model built from a branch of the app
   (pre-release, as v3 is now) has `"next"`; one built from the app's `main` has every `@since` as a released
   version. The docs decide availability from the latest published model, not from these stamps (docs/README.md,
   "Since, and Not available yet").
2. `scripts/gen-example-cases.mjs`: writes `conformance/cases/examples.json` from the model's `@examples`.
3. `gradle test publish` in `codegen/`: compiles and tests the generators and writes them to
   `codegen/build/repo`, a file repository. Nothing is published anywhere else.
4. `smithy build` in `codegen/`: runs the four generators (`codegen/smithy-build.json`).
5. Copies the output into `typescript/packages/sdk`, `python/caitlyn`, `go/` and `rust/caitlyn-sdk`, then tidies
   it (`scripts/postgen-ts.mjs`, `gofmt`, `rustfmt`).
6. `scripts/version.mjs check`: fails if any file that names the SDK version, generated or hand-written, names
   another one.

The generators share their model-reading rules through `codegen/model-support`: how operations become client
methods (PROTOCOL.md section 10), how outputs are named, which SSE union member is the failure event, which
error members the runtimes already carry. Change a naming rule there and every SDK changes together.

## The app's local loop

`scripts/dev-sdk.sh` builds the TypeScript SDK from a model the Caitlyn app has just built, so the app can run against
a model change before it is published. The app drives it (`pnpm sdk:local`, and its watcher); you don't run it by hand
here, and `make generate` does not use it.

```bash
scripts/docker.sh scripts/dev-sdk.sh build/dev-sdk/<name>/model/source.json <name>
CAITLYN_DOCKER_NAME=caitlyn-sdk-dev scripts/docker.sh   # a long-lived container, for `docker exec … scripts/dev-sdk.sh`
```

- **Its input** is the app's `smithy` build output, which the app copies to `build/dev-sdk/<name>/model/source.json`;
  `<name>` is the app worktree's name.
- **Everything it writes** is under the gitignored `build/dev-sdk/<name>/`: the model the generators read
  (`scripts/prepare-model.mjs --dev`, which skips the lock check and keeps the lock's `stampNext`), the Smithy output,
  and a TypeScript workspace whose `packages/sdk` and `packages/sdk-core` are built as published. It never writes a
  tracked file, `model/`, the lock or `conformance/`.
- **It is quick on purpose:** the generators are recompiled only when one changed (`gradle publish -x test`, its
  daemon kept warm in the long-lived container), and only the TypeScript projection is built. A model change takes
  about 5 s in a warm container.
- **Its last line on stdout** is a JSON summary with the SDK's commit, the model's SHA-256 and the packages' paths. A
  failed build exits non-zero and leaves the previous build in place.

## Running conformance

```bash
make conformance        # every SDK, then scripts/check-conformance.mjs
make typescript         # or one language: type checks, lint and its harness
make python
make go
make rust
```

The TypeScript SDK runs on its own runtime (`typescript/packages/sdk-core`: `src/protocol.ts`, `src/retry.ts` and
`src/runtime/`), not on the whole Smithy runtime, and has a second build for browser pages without the server-only
sign-in modes. Its harness runs against both: in Node by `make typescript` (`npm run conformance` and
`npm run conformance:browser-build`), and in headless Chromium, Firefox and WebKit by the `typescript:browser` CI job
(`cd typescript && npx playwright install && npm run conformance:browser` locally). A model that uses a Smithy feature
the runtime does not implement fails the package build (`typescript/scripts/check-runtime-schemas.mjs`).

Each harness starts the mock server (`conformance/mock-server/server.mjs`, Node, no dependencies), resets it
before each test and drives it through `/__mock/`:

| Endpoint | Use |
| --- | --- |
| `POST /__mock/reset` | Clear state, faults, the request log and any primed example |
| `POST /__mock/faults` | Inject faults: status codes per operation with `Retry-After`, dropped or cut streams, `message.failed`, unknown events, enum values and fields, `X-Amzn-Errortype`, a different `Caitlyn-Api-Version` |
| `GET /__mock/requests` | The request log, to assert on what the SDK sent |
| `GET /__mock/answered?path=…&status=…` | Answers once a request whose path contains `path` has been answered with `status`, so a case waits on that event rather than polling the log |
| `POST /__mock/example` | Answer the next request with an example case, after checking the request matches it |
| `GET /__mock/example` | Whether the primed case was served, and how the request differed |

There are two kinds of case:

- **Protocol cases** (`conformance/cases/protocol.json`): retries, pagination, streams, tolerance of unknown
  data, typed errors, cancellation, updates, wire headers, the hostile AWS environment, `@since`, telemetry,
  the endpoint and sign-in. Each harness has one test per case, named after its id.
- **Example cases** (`conformance/cases/examples.json`, generated): one per `@examples` entry in the model.
  The design guide (section 12) also asks for a 403 and a 404 case for every operation, so the generator
  synthesises the missing ones from the model: a 403 `PERMISSION_DENIED` for every operation (it is a service
  error, so no example carries it), and a 404 `NOT_FOUND` for every operation whose `@permission` names an
  entity and whose examples have no 404. The case holds the input, the exact request an SDK must send for it (worked out from the HTTP bindings)
  and the response. The harness calls the operation with the input; the mock server checks the request; the
  harness checks the output or the typed error. A new operation gets cases the moment the model has examples
  for it: TypeScript and Python find the method from the model; the Go and Rust harnesses need an entry in their
  example tables (`examples` in Go, `call_example` in Rust) and fail until they have it.

`scripts/check-conformance.mjs` reads each harness's report (`build/conformance/`) and fails if any case is
missing or failed in any language.

## Running the examples against a workspace

The conformance suites run against a mock server. The developer docs' examples also run against a real Caitlyn
workspace, so an example in the docs is known to work, not only to compile. `scripts/examples-live.mjs` runs
each SDK's examples in the toolchain image against the workspace's API and prints a table of checks: one per
operation, and one that `stream.reset` reaches the caller.

```sh
CAITLYN_WORKSPACE=your-workspace.example.com CAITLYN_AGENT_ID=… CAITLYN_TOKEN_REF='op://…' \
  make examples-live            # or: node scripts/examples-live.mjs typescript python
```

- `CAITLYN_WORKSPACE` is the workspace's hostname. The examples call `https://<workspace>/api`, or
  `CAITLYN_ENDPOINT` when it is set.
- The credential is a personal access token for a person in that workspace: `CAITLYN_TOKEN`, or
  `CAITLYN_TOKEN_REF`, a 1Password secret reference the script reads with `op read`. It is passed into the
  container by name, never on a command line, and the script never prints it.
- `CAITLYN_AGENT_ID` is an agent whose draft can answer.
- `CAITLYN_KNOWLEDGE_BASE_ID` is a knowledge base the checks may add documents to, and `CAITLYN_PUBLISH_AGENT_ID`
  an agent the checks may publish. Without one, the checks that need it print
  `skip <check>: no knowledge base configured` or `skip <check>: publishing turned off`; a language runner may
  skip for no other reason. Reading a history entry uses the publish agent's history, so without one it
  skips with `publishing turned off`; listing an empty history is a pass.
- A check refused with 403 `PERMISSION_DENIED` reports `fail <check>: 403 PERMISSION_DENIED: <detail>`. The script
  turns that into `skip <check>: public role only` only when `CAITLYN_PUBLIC_ROLE_ONLY=1`, set while the workspace's
  role setup has not run: a 403 does not say which role the caller has. Otherwise it is a failure. The setting is
  empty in the CI job, so a run has to set it deliberately, and a run that sets it says so at the top of its summary.
- The table lists every skip with its reason. A skip is not a pass: a skipped check blocks a release unless it is
  accepted for that release.
- The checks put the workspace back as they found it. The draft checks change the draft and restore it; saving
  creates a uniquely named version and deleting removes it. Publishing, on the publish agent only, saves that agent's
  draft as a uniquely named version, publishes it (with live's ETag as If-Match), checks `publishedAt`, then
  deletes the saved version; live keeps what was published. Each run adds a history entry to that agent, as
  publishing does.
- The document checks delete every document they create. DeleteDocument deletes the document CreateDocument made
  and DeleteDocument.wait waits for it to be gone; DeleteDocument.processing deletes a document while it is
  still being processed and expects the delete to be accepted and the document to stay gone; BatchDeleteDocuments deletes a second document together with an
  identifier that does not exist, and expects `accepted` for the document and `failed` with `NOT_FOUND` for the
  other, in request order. A check that fails part way still batch-deletes what the run created and waits until
  each is gone.
- Each language's runner is `scripts/examples-live/<language>.sh`. It runs the examples with the client's
  `endpoint` set to `CAITLYN_ENDPOINT`, and prints `ok <check>` or `fail <check>: <why>` for each check.

It needs a workspace and a credential, so it is not part of `make check`. In CI it is the manual
`examples:live` job: it runs in merge request pipelines and in pipelines started through the API or the web, against
the workspace and agent in `CAITLYN_WORKSPACE` and `CAITLYN_AGENT_ID` (both can be set for a pipeline), with the
token from the masked project variable `CAITLYN_TOKEN_MR2062`. The table is in the job log.

## The model snapshot

`model/model.json`, `model/openapi.json` and `model/PROTOCOL.md` are a copy of the app's model, whose source is
`smithy/` in the app repository (https://git.customd.com/custom-d/caitlyn/platform/caitlyn): `smithy/PROTOCOL.md`,
and the Smithy sources under `smithy/model/` that `model.json` and `openapi.json` are built from.
`scripts/model-pull.sh` writes them together with `model/model.lock.json`, so a pulled snapshot always changes the
lock file.

A pull also keeps `model/changes/<version>.json`: the `changes.json` the app publishes beside each release's model,
listing what changed in the public API since the release before. It keeps one for every published version after the
previous lock's, up to and including the one it pulls, so a release the SDKs skipped still has its entry; the files
accumulate across pulls, and the developer site's Changelog lists each as an API release. A version published before
the app wrote `changes.json` is skipped with a note, and `--from-build` keeps the build's `build/changes.json` only
when it has one.

An edit made to `model/` here would be erased by the next pull. So the `model:snapshot-only` job, on every merge
request pipeline, fails when a file under `model/` changes and `model/model.lock.json` does not, and its message
says where to make the change. `make model-snapshot-check` runs the same check locally against `origin/main`, and
`make check` includes it.

To change the protocol or the model: change `smithy/` in the app repository. When that change merges to the app's
`main`, the `model:main` job here brings it in (below); nobody pulls a model into `main` by hand.

`scripts/model-pull.sh --prerelease <app checkout>/smithy` takes an app build, and stamps `@since("next")` as the app
version that build's server reports in `Caitlyn-Api-Version` (its `package.json` version, without a suffix). So the
SDK's version check (PROTOCOL.md section 9) passes on that app build's own server and refuses, sending nothing, on an
older one. The lock records `"prerelease": {"appVersion", "appCommit"}`. `--from-build` copies the same files but
keeps the previous lock's `stampNext` unless `STAMP_NEXT` is set. A published model never contains `"next"`.

The `model:version-check` job (`scripts/model-check.sh`, deciding in `scripts/model-check.mjs`) says whether the SDKs
may be released from the snapshot. It compares what the models say, not their version numbers: the app releases
several times a day, mostly without touching the model, and none of those releases needs anyone to pull a model. It
fails when the snapshot is:

- **behind:** a published model that says something different from the latest published one;
- **hand-pulled:** an unpublished build with no `prerelease` record, one `model:main` didn't make;
- **a stale pre-release:** a `model:main` pre-release, where the app has released since its build (the latest release
  is later than its `stampNext`) and that release's model says something the pre-release doesn't.

It passes for the latest published model (or one identical to it), for a `model:main` pre-release that the latest
release shipped (the same model, each `@since("next")` stamped with that release's number), and for a `model:main`
pre-release built since the latest release (its `stampNext` is that release or later). In a merge request it's a
warning; on `main` and `v*` tags it fails, and `docs:publish` needs it.

## How a model change reaches the SDK

The model belongs to the app repository; the generator, the runtimes and the docs belong to this one.

```
app repository: a merge to main that changes smithy/
  │  triggers this project with APP_COMMIT
  ▼
this repository: model:main (scripts/model-main.sh)
  build the app's model at APP_COMMIT → model-pull.sh --prerelease → make generate
  → the TypeScript, Python, Go and Rust suites and the conformance check
  → only if every one passes: commit to main, tag v<next>-beta.<n>
  ▼
the beta tag: PyPI and crates.io from the GitHub mirror, and go/v<next>-beta.<n> for Go
```

- **No merge request.** The commit goes straight to `main` because it is generated from a model the app has
  already merged, and it is pushed only once every suite has passed on it. `model:main` runs one at a time, and
  never alongside the `release` job (both are in the `main-push` resource group), starts from the newest `main`, and
  does nothing when `main` already has that model.
- **Main or nothing.** It pushes the commit and its beta tag together (`git push --atomic`), and only while `main` is
  still the commit it started from (`scripts/model-main-publish.sh`). If a merge request merges while the suites run,
  the job fails saying so and pushes nothing, neither the commit nor the tag: retry it, and it starts again from the
  newest `main`. The commit carries every file the suites tested; the job fails before committing if a tracked file
  changed that it would leave out.
- **The version.** `<next>` is the minor version after the last stable tag; `<n>` counts that version's betas. The
  commit stamps the beta's version into every file that carries one, so `main` always names the newest beta.
- **A change to the SDK's own code** (the generator, a runtime, conformance cases, docs) goes through a merge
  request as usual.
- **The app does not use a published SDK.** It pins a commit of this repository in its `sdk.ref` and builds the
  TypeScript SDK from its own model (the app's internal v3 SDK article). An app merge request that needs an SDK
  change sets `sdk.ref` to the commit at the head of that SDK merge request's branch; once the SDK merge request
  merges, the app sets `sdk.ref` to a commit on `main` before it merges too.

Setting it up, once:

- the app's `main` pipeline needs a job that triggers this project when `smithy/` changes:

  ```yaml
  trigger:sdk:
    stage: release
    trigger:
      project: custom-d/caitlyn/sdk
      branch: main
    variables:
      APP_COMMIT: $CI_COMMIT_SHA
    rules:
      - if: $CI_COMMIT_BRANCH == $CI_DEFAULT_BRANCH
        changes: [smithy/**/*]
  ```

- the app project must allow this project's job token to read its repository (app project, Settings, CI/CD, Job
  token permissions);
- `GITLAB_TOKEN` (under "Releasing") pushes the commit and the tag, so the bot must be allowed to push to `main`.

To run it by hand for an app commit: Build → Pipelines → Run pipeline on `main` with `APP_COMMIT` set, or start the
same pipeline through the API:

```sh
glab api -X POST projects/857/pipeline -H 'Content-Type: application/json' \
  --input - <<< '{"ref": "main", "variables": [{"key": "APP_COMMIT", "value": "<app commit>"}]}'
```

## Releasing

**Never tag by hand, and never edit `VERSION`.** A stable release is a person's decision: start the manual
`release` job on a `main` pipeline, and it cuts the release in the order the app repository's pipeline does:

1. `fetch-semantic-version` (a semantic-release dry run) writes the next version to `VERSION.txt`.
2. `stamp-version` stamps it into every SDK file (`scripts/version.mjs release`), as artifacts.
3. `release` (semantic-release) checks the stamped files name that version, writes the release notes ("Release
   notes", below) and adds them to the top of `CHANGELOG.md` (`@semantic-release/changelog`), commits both to `main` as `chore(release): x.y.z`
   (`@semantic-release/git`), tags that commit `v<version>`, tags the same commit `go/v<version>` for the Go
   module (`scripts/go-tag.mjs`), and creates the GitLab release with the same notes.
4. The push mirror takes `main` and the protected tags to `github.com/caitlyn-ai/sdk`. The Go release is done:
   `go get github.com/caitlyn-ai/sdk/go@v<version>` resolves the `go/` tag from GitHub.
5. On GitHub, three workflows publish from the tag, and each first checks the tag's files carry its version
   (`scripts/version.mjs check`):
   - `release-npm` tests, builds and checks the packages, then stages `sdk-core` and then `sdk`;
   - `release-pypi` builds `caitlyn-core` and `caitlyn` (sdist and wheel) and publishes them to PyPI, core first;
   - `release-crates` packages and verifies both crates (`cargo publish --dry-run`), then publishes
     `caitlyn-sdk-core` and then `caitlyn-sdk` to crates.io.

   `release-github` creates the GitHub release (below).
6. On npmjs.com, account settings → Staged Packages: check both versions (name, version, dist-tag `latest`,
   publisher), then approve them, `sdk-core` with or before `sdk`, since the SDK depends on that exact
   `sdk-core` version. A batch approves both with one two-factor challenge.

**GitHub releases.** On the same tag, `.github/workflows/release-github.yml` creates the GitHub release for it on the
mirror, titled with the tag, with the version's section of the tag's `CHANGELOG.md` as its notes
(`scripts/changelog-section.mjs`). Only the highest version
tag is marked the latest release. A beta tag (see "Betas") has no section in `CHANGELOG.md`, which only a stable
release writes: its release is a pre-release, never the latest, and its notes are every change since the last
stable release, from `scripts/release-notes.mjs notes` on the beta's tree. Running it again edits the release rather than failing. It uses the workflow's
own `GITHUB_TOKEN` with `contents: write`; there is nothing to set up.

To create or correct a GitHub release by hand, run the workflow from `main` with the tag: in GitHub, Actions →
`release-github` → Run workflow, or `gh workflow run release-github.yml --repo caitlyn-ai/sdk --ref main -f tag=v0.8.0`.
A tag from before `CHANGELOG.md` existed (v0.8.0 and earlier) takes its notes from `main`'s `CHANGELOG.md`, which
was seeded with the GitLab releases' notes for v0.3.0 to v0.8.0; v0.2.0 and earlier have no GitHub release.

**Links in the notes point at the GitHub mirror**, never at this GitLab, which the public cannot open: the notes are
`CHANGELOG.md` and the GitHub releases, and the GitLab release shows the same text. The mirror has the same commits
and tags, so `https://github.com/caitlyn-ai/sdk/commit/<sha>` and `…/compare/vX...vY` work. `scripts/release-notes.mjs`
writes them with the GitHub address, not semantic-release's `repositoryUrl`, which must stay this GitLab because it
pushes there (issue references are left out, since their numbers are this GitLab's). As a safety net, `release-github` points any link still under
`https://git.customd.com/custom-d/caitlyn/sdk/` at the mirror, and fails rather than publish any other
`git.customd.com` address.

The release commit has no `[skip ci]`, on purpose: GitHub Actions skips every `push`-triggered workflow whose head
commit message contains `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]`, and a tag push is
a push, so `release-npm` would never run ("Skipping workflow runs",
https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs).
GitLab skips the release commit's `main` pipeline with a workflow rule instead.

The `release` job pushes the release commit and the tag with `GITLAB_TOKEN`, a CI variable (masked, protected)
holding a project access token (`GITLAB_TOKEN`, bot user `project_857_bot_f4d639af535f0bcf131cd87b09f601c5`) with
the **Maintainer** role and the `api` and `write_repository` scopes. Two protections must let that bot through:

- the protected `v*` and `go/v*` tags allow Maintainers to create them;
- the protected branch `main` must allow the bot to push (Settings → Repository → Protected branches → `main` →
  "Allowed to push and merge"). Merges stay as they are.

The token expires: replace it before then, or releases stop with "HTTP Basic: Access denied" (the template's
README, https://git.customd.com/custom-d/devops-platform/ci-templates/semantic-versioning).

### Betas

`model:main` tags a beta, `v<next>-beta.<n>`, with each model change it commits ("How a model change reaches the
SDK"). A beta tag publishes, with no one involved apart from the npm approval:

- **Python**: `caitlyn-core` and `caitlyn` to PyPI as `<next>b<n>` (PEP 440's spelling), which `pip` installs only
  when asked for a pre-release;
- **Rust**: the crates to crates.io as `<next>-beta.<n>`, which Cargo picks only when asked for exactly;
- **Go**: the tag `go/v<next>-beta.<n>`, which `go get …@latest` passes over;
- **GitHub**: a release marked as a pre-release, never the latest, with every change since the last stable release as
  its notes;
- **npm**: `release-npm` stages both packages as `<next>-beta.<n>` under the `beta` dist-tag, so `latest` stays the
  last stable release. As for a release, a maintainer approves them on npmjs.com with two-factor authentication
  ("npm", below), the one step that is not automatic.

To run `release-npm` again by hand for a tag whose run failed, start it from the tag, not from `main`: the `npm`
environment allows only `v*` tags, so a run from `main` is refused before it starts.

```
gh workflow run release-npm.yml --repo caitlyn-ai/sdk --ref v<next>-beta.<n> -f tag=v<next>-beta.<n>
```

A stable release is the manual `release` job on a `main` pipeline (above).

### npm

`@caitlyn-ai/sdk-core` and `@caitlyn-ai/sdk` are released from a GitHub mirror of this repository by
`.github/workflows/release-npm.yml`, with npm provenance. npm trusted publishing accepts OpenID Connect tokens
from GitHub Actions (and GitLab.com), not from this GitLab, so the mirror is what lets a release carry
provenance and need no stored npm token. GitLab stays the source: the mirror only receives `main` and tags.

The workflow never publishes directly. It **stages** each version (`npm stage publish`), and a maintainer
approves it on npmjs.com with two-factor authentication, which is the release's one approval
(https://docs.npmjs.com/staged-publishing). Version 0.0.1 of both packages was published by hand by a maintainer;
every version after it goes through the workflow.

What is set up (by the maintainers who own the `caitlyn-ai` GitHub organisation and npm scope):

1. **The mirror repository: `github.com/caitlyn-ai/sdk`**. Actions enabled; nobody pushes
   to it except the mirror.
2. **The push mirror, over HTTPS** (GitLab's "Set up a push mirror from GitLab to GitHub",
   https://docs.gitlab.com/user/project/repository/mirror/push/#set-up-a-push-mirror-from-gitlab-to-github):
   - In GitHub, create a fine-grained personal access token with resource owner `caitlyn-ai`, repository
     access "Only select repositories" → `caitlyn-ai/sdk`, and permissions **Contents: read and write** and
     **Workflows: read and write**. GitHub refuses a push that adds or changes a file under `.github/workflows/`
     from a token without the Workflows permission, and this repository carries the release workflows.
   - In GitLab, `custom-d/caitlyn/sdk` → Settings → Repository → Mirroring repositories → Add new: Git repository
     URL `https://github.com/caitlyn-ai/sdk.git`, direction Push, authentication method "Username and Password",
     username the GitHub account that owns the token, password the token.
   - Turn on "Mirror only protected branches", so `main` reaches GitHub and work-in-progress branches do not.
     Protect the release tags `v*` and the Go tags `go/v*` too (Settings → Repository → Protected tags, allowed to
     create: Maintainers) so they are mirrored.
   - **The token expires.** Fine-grained tokens have an expiry date. Note it, and replace the token in the
     mirror's settings before then: once it expires the mirror stops (GitLab shows the error on the mirror),
     and a release tag pushed after that never reaches GitHub.
3. **The `npm` environment.** In the GitHub repository, Settings → Environments → `npm`, with deployment
   limited to `v*` tags and **no required reviewer**. The environment stays because the trusted publishers are
   bound to its name; a reviewer there would only add a second approval before the one on npmjs.com.
4. **Trusted publishers on npm.** For each of `@caitlyn-ai/sdk-core` and `@caitlyn-ai/sdk`: Settings →
   Trusted publishing → GitHub Actions, organisation `caitlyn-ai`, repository `sdk`, workflow
   `release-npm.yml`, environment `npm`, allowing **`npm stage publish` only**: direct `npm publish` is off, as
   npm recommends. Set publishing access to "Require two-factor authentication and disallow tokens", so the
   workflow can only stage, and only a maintainer with two-factor authentication can make a version public.
   Staged publishing needs npm 11.15.0 or later; the workflow pins its npm version.

The steps of a release are under "Releasing" above. The GitLab job `release:npm` is a placeholder that says where
npm releases run.

### PyPI

`caitlyn-core` and `caitlyn` are published to PyPI from the GitHub mirror by `.github/workflows/release-pypi.yml`,
with PyPI trusted publishing and attestations, for the same reason as npm: PyPI accepts OpenID Connect tokens from
GitHub Actions, not from this GitLab, and no PyPI token is stored anywhere. Unlike npm there is no staging step: the
workflow uploads, and the version is public. `caitlyn` pins `caitlyn-core` to the same version, so the workflow
uploads `caitlyn-core` first (job `publish-core`, environment `pypi-core`), then `caitlyn` (job `publish-sdk`,
environment `pypi`). Each package has its own environment because PyPI takes only one pending publisher for each
repository, workflow and environment. It skips files PyPI already has, so running it again after a part-failed upload finishes
the release.

It runs on every release tag and every beta tag (a beta as `<next>b<n>`: see "Betas"), and by hand: in GitHub,
Actions → `release-pypi` → Run workflow, from `main`, with the
tag (such as `v0.9.0`). Running it by hand publishes a release whose run failed. Either way it builds the tag's tree.

**The first PyPI release was 0.8.1.** Releases up to v0.8.0 are not on PyPI: their `pyproject.toml` files have no
readme, licence or project URLs, and PyPI never lets a published version's metadata change.

To set it up, once (a maintainer of the `caitlyn-ai` GitHub organisation, with a PyPI account that has two-factor
authentication):

1. **Pending publishers on PyPI.** On pypi.org, Your account → Publishing → "Add a new pending publisher" → GitHub,
   once for each package, with owner `caitlyn-ai`, repository name `sdk` and workflow name `release-pypi.yml`:
   - PyPI project name `caitlyn`, environment name `pypi`;
   - PyPI project name `caitlyn-core`, environment name `pypi-core`.

   A pending publisher does not reserve the name: the first upload through it creates the project and makes that
   account its owner, and the pending publisher becomes the project's trusted publisher
   (https://docs.pypi.org/trusted-publishers/creating-a-project-through-oidc/).
2. **The `pypi` and `pypi-core` environments.** In the GitHub repository, Settings → Environments → New environment,
   once for each, with deployment branches and tags limited to `v*` tags and the `main` branch (`main`, because a run
   by hand starts from `main`: without it, publishing an existing tag by hand is refused), and no required reviewer.
3. **The first release.** Nothing to do: the next release tag runs the workflow, which publishes both projects.
4. **Co-maintainers.** Once both projects exist, add the other maintainers on each: the project → Manage →
   Collaborators, role Owner, so more than one person can manage each project.

The GitLab job `release:pypi` is a placeholder that says where PyPI releases run.

### crates.io

`caitlyn-sdk-core` and `caitlyn-sdk` are published to crates.io from the GitHub mirror by
`.github/workflows/release-crates.yml`, with crates.io trusted publishing: the workflow exchanges the job's OpenID
Connect token for a publish token that lasts 30 minutes and is revoked when the job ends
(https://crates.io/docs/trusted-publishing). No crates.io token is stored anywhere. `caitlyn-sdk` depends on
`caitlyn-sdk-core` at the same version, so `caitlyn-sdk-core` goes first. A version crates.io already has is skipped.

The workflow has two jobs:

- `package` runs on every release tag and every beta tag (see "Betas"). It checks the versions, then packages both crates and builds each from its
  package (`cargo publish --dry-run --workspace`, which builds `caitlyn-sdk` against the packaged
  `caitlyn-sdk-core`), so a crate that would not build from crates.io fails before anything is published.
- `publish` runs only when the repository variable `CRATES_IO_TRUSTED_PUBLISHING` is `true`. crates.io lets a
  trusted publisher be added only to a crate that already exists, so the first version of each crate is published by
  hand, and the workflow stops after the dry run until then.

Run by hand (Actions → `release-crates` → Run workflow, from `main`, with the tag) to publish a release whose run
failed or that was tagged before the variable was set.

**The first crates.io release was 0.8.1**, published by hand as below; releases up to v0.8.0 are not on crates.io,
since `caitlyn-sdk` there has no README for its crates.io page.

To set it up, once (a maintainer of the `caitlyn-ai` GitHub organisation, with a crates.io account signed in through
GitHub and a verified email address):

1. **A short-lived token.** On crates.io, Account Settings → API Tokens → New Token: name it for this, the shortest
   expiry offered, scopes `publish-new` and `publish-update`, crates `caitlyn-sdk*`.
2. **The first publish, by hand, core first,** from a clean checkout of the first release tag (the tag's files
   carry its version; its `release-crates` run has already passed the dry run):

   ```bash
   git fetch --tags && git checkout v0.8.1   # the first release on crates.io
   cd rust
   read -rs CARGO_REGISTRY_TOKEN && export CARGO_REGISTRY_TOKEN   # paste the token; it is not echoed or stored
   cargo publish --locked -p caitlyn-sdk-core
   cargo publish --locked -p caitlyn-sdk
   unset CARGO_REGISTRY_TOKEN
   ```

3. **Trusted publishers.** On crates.io, for each of `caitlyn-sdk-core` and `caitlyn-sdk`: the crate → Settings →
   Trusted Publishing → Add: GitHub, repository owner `caitlyn-ai`, repository name `sdk`, workflow filename
   `release-crates.yml`, environment `crates`.
4. **Revoke the token** (Account Settings → API Tokens → Revoke).
5. **The `crates` environment.** In the GitHub repository, Settings → Environments → New environment → `crates`,
   with deployment branches and tags limited to the `main` branch and `v*` tags, and no required reviewer.
6. **Turn publishing on.** In the GitHub repository, Settings → Secrets and variables → Actions → Variables → New
   repository variable: `CRATES_IO_TRUSTED_PUBLISHING`, value `true`.
7. **Co-owners.** Add the other maintainers as owners of each crate, on crates.io under the crate's Settings →
   Owners (or `cargo owner --add <github-login> <crate>`, with a token that has the `change-owners` scope).

The GitLab job `release:crates` is a placeholder that says where crates.io releases run.

### Go

The Go SDK is the module `github.com/caitlyn-ai/sdk/go`: the `go/` directory of the GitHub mirror, with its runtime
at `github.com/caitlyn-ai/sdk/go/core`. Nothing is uploaded anywhere. Go finds a version of a module in a
subdirectory by a tag with the directory as its prefix (https://go.dev/ref/mod#vcs-version), so every release has
two tags on the release commit: `v<version>` for everything else, and `go/v<version>` for Go. The Go module proxy
(proxy.golang.org) fetches a version from GitHub the first time someone asks for it, and pkg.go.dev lists it after
that.

`semantic-release` creates the Go tag right after it pushes `v<version>` (`.releaserc.yml`, `publishCmd`, which runs
`scripts/go-tag.mjs` with the release job's `GITLAB_TOKEN`). The script tags the commit `v<version>` points at, leaves
a Go tag that is already there alone, and fails if one is on another commit. It also refuses a release whose
`go/go.mod` declares another module path, since Go would reject that version.

The import path changed from `github.com/caitlyn-ai/caitlyn-go` to `github.com/caitlyn-ai/sdk/go` before anything
was published under the old one. Every release up to v0.8.0 still declares the old path in its `go/go.mod`, so they
have no Go release: **the first Go release was v0.8.1** (`go/v0.8.1`).

To tag a release by hand, when its Go tag failed: in GitLab, Build → Pipelines → Run pipeline, on `main`, with the
variable `GO_TAG` set to the release tag (such as `v0.9.0`), then start the manual `release:go` job.

Set up once, before the first Go release:

1. **Protect the Go tags.** In GitLab, `custom-d/caitlyn/sdk` → Settings → Repository → Protected tags → `go/v*`,
   allowed to create: Maintainers. The push mirror sends only protected tags, and `v*` does not match `go/v0.9.0`.
2. **After that release**, check it resolves: `go list -m github.com/caitlyn-ai/sdk/go@v<version>`.

## Release notes

Every release's notes are written by `scripts/release-notes.mjs`, which semantic-release runs as its notes generator
(`.releaserc.yml`, `generateNotesCmd`). Nobody writes or edits notes at release time. A release's section has:

- **One entry per change file** added since the last release (`changes/<name>.md`, the format is in
  [changes/README.md](changes/README.md)): its summary, linked to the commit that added it, and its highlights, each
  saying what changed and why, and linking the page it is about.
- **A line for each releasing commit with no change file**, from its subject, as semantic-release wrote them before.
  The `model:main` job's `feat(model)` commits get none when the API changed: the next item says what they did.
- **What changed in the public API**, from the model at the last release tag to the one being released
  (`scripts/model-diff.mjs`, which says what the app's `CaitlynChanges` says, checked against two changes.json it
  wrote): new operations, changed operations and types (members, errors, error codes, enum values), stability changes,
  and the breaking ones together under **Breaking API changes**. Each operation and type links to its reference page,
  worked out from the model as the docs build does (`scripts/docs-reference.mjs` `referencePages`). This works whether
  the snapshot is locked to a published model or a local build.
- **BREAKING CHANGES**, every change file with `breaking: true`.

**Merge requests.** A releasing title (`feat`, `fix`, `perf`, `revert`, or `!`; not a `docs` or `ci` scope) needs a
change file. The `changes:check` job fails when it is missing, reads badly (no bold lead, no docs link, internal
wording), has another type than the title, or disagrees with it about `!`, and when the model's changes break callers
(a removed operation, member or enum value, a member made required, a changed type) without the title's `!` and a
breaking change file. A changed type breaks no one when both are plain strings or numbers (the SDKs spell them as the
language's own types, so no one imports their names) and the new one takes every value the old one did: a wider
number, or a length or range no narrower (`scripts/model-diff.mjs` `widens`). An enum, structure, list, map or union
changed to another breaks code that names it. Like `docs:mr-title`, rerun it after editing the title: GitLab starts no
pipeline for that.

**A change that merged without its file.** Any merge request can add one later with `commit: <hash>` in its front
matter, naming the commit it describes: it takes that commit's line in the notes, and is checked against that commit's
title rather than its own. The commit must be on `main`, not released yet, and have no other file.

**The preview.** A merge request's docs preview (`docs:build` with `DOCS_UNRELEASED=on`) opens its Changelog with an
**Unreleased** entry: the section the next release would have if it were cut once the merge request merged. That is the
change files and releasing commits merged to `main` since the last release, the merge request's own change files (or
its title, as the squash commit it becomes, when it adds none), and the model's changes. The merge request's own entries,
and the API changes its model brings, are marked **This merge request**. Its links are checked with every other page's,
so a broken one fails the preview, not the release. The live site never shows the entry, and the feed leaves it out.
`node scripts/release-notes.mjs unreleased` prints it locally, from `origin/main`.

**Trying it on past releases.** `node scripts/release-notes.mjs dry-run <version> <from tag> <to tag> <dir>` prints the
section a past release would have had with `<dir>`'s change files, each standing for that range's releasing commit of
its type. `docs/site/test/fixtures/release-notes/` holds change files for 0.10.0, 0.10.1 and 0.11.0, written from their
merge requests, and `docs/site/test/release-notes.test.mjs` regenerates the three.

## Commit messages

Conventional commits, in British English: `feat(codegen): …`, `fix(conformance): …`, `ci: …`,
`docs: …`. The type decides the release ("How a version is chosen"), so pick it for what the commit does to the
SDKs: a merge request's squash commit or merge commit message is what semantic-release reads. Never write a skip-CI marker
(the bracketed "skip ci" or "ci skip") anywhere in a commit message, even to talk about it: GitLab then skips that
commit's pipelines, and GitHub Actions skips its push-triggered workflows. A regenerate from a new model is `feat(model): regenerate the SDKs from model <version>`.
