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
- **The model and `PROTOCOL.md` change in the app repository**, not here. A generator lane never edits the
  model. A protocol change is agreed by all three generator lanes before any of them implements it, and lands
  with a conformance case (the implementation plan, "Running lanes in parallel sessions").
- **Every protocol behaviour has a conformance case** in `conformance/cases/protocol.json`, and every harness
  runs it. Adding a case there fails the other languages until they implement it, which is the point.

## Regenerating

```bash
make generate
```

`scripts/generate.sh` does, in order:

0. `scripts/version.mjs stamp`: writes the version in `VERSION` into the hand-written files that carry it and into
   the generator settings (see "Versions" below).
1. `scripts/prepare-model.mjs`: checks `model/model.json` against the lock file and writes
   `build/model/model.json`, without the app's lint-rule metadata (those rules run in the app's model build)
   and with any `@since("next")` stamped as the lock's `stampNext`.
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

## Running conformance

```bash
make conformance        # all four, then scripts/check-conformance.mjs
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

## How the model version flows in

```
app repository (custom-d/caitlyn/platform/caitlyn)
  smithy/ model  ──release──>  package registry: caitlyn-v3-model/<version>/ and /latest/
                                      │
                                      │  publish:smithy-model triggers this project
                                      ▼
this repository: regenerate job
  scripts/model-pull.sh latest → make generate → every suite → scripts/open-model-mr.sh
  → merge request "feat(model): regenerate the SDKs from model <version>"
```

- **By hand**: `scripts/model-pull.sh 5.121.0` (or `latest`), then `make generate`, then commit. Locally the
  script needs `GITLAB_TOKEN`, a personal access token with `read_api`. For an unpublished model,
  `scripts/model-pull.sh --from-build <app checkout>/smithy` takes a local `make smithy` build instead.
- **The check**: `scripts/model-check.sh` (`make model-check`, and the `model:version-check` job on merge
  requests) compares the snapshot's SHA-256 with `caitlyn-v3-model/latest/model.json`. Behind, unpublished or
  nothing published is a warning, not a failure.
- **Automatically**: the app's `publish:smithy-model` job triggers this project after each release. That
  trigger is not in the app repository yet; it is one job in `smithy.gitlab-ci.yml`:

  ```yaml
  trigger:sdk-regenerate:
    stage: release
    needs: [publish:smithy-model]
    trigger:
      project: custom-d/caitlyn/sdk
      branch: main
    rules:
      - if: $CI_DEFAULT_BRANCH == $CI_COMMIT_BRANCH
  ```

  The regenerate job pulls `latest` unless the trigger passes `MODEL_VERSION`. (Passing the release number
  needs `publish:smithy-model` to write it to a dotenv report, because a trigger job cannot read
  `VERSION.txt`.) Every app release publishes the model, changed or not; the regenerate job stops early when
  the pulled model is the snapshot already.

Reading the app's registry from this project's CI needs the app project to allow this project's job token
(app project, Settings, CI/CD, Job token permissions). The regenerate job pushes with `SDK_BOT_TOKEN`, a
project access token with `write_repository` and `api`.

## Versions

The SDKs send `Caitlyn-Sdk-Model`, the highest `@since` in the model they were generated from, and refuse,
before sending, an operation or member newer than the server's `Caitlyn-Api-Version` (PROTOCOL.md section 9).

All four SDKs share one version. On `main`, the top-level `VERSION` file holds `0.0.0`, the version of every build
that is not a release, and nobody edits it. Each release commit (below) stamps the real version, and the release's
tag points at that commit. `make generate` stamps `VERSION`'s version everywhere it appears (`scripts/version.mjs`
lists each place):

- TypeScript: both `package.json` files, the SDK's dependency on `sdk-core`, `typescript/package-lock.json`, the
  `User-Agent` and the OpenTelemetry tracer version;
- Python: both `pyproject.toml` files, the `caitlyn-core==` pin, both `__version__` values (the `User-Agent` and the
  tracer version) and `python/uv.lock`;
- Go: `SDKVersion` (the `User-Agent` and the tracer's instrumentation version). Go module versions are git tags;
- Rust: both crates, the generated crate's dependency on `caitlyn-sdk-core`, `SDK_VERSION` (the `User-Agent`) and
  both `Cargo.lock` files.

Generation fails when any of them disagrees with `VERSION`, and the `generate` CI job fails when the committed
files differ from what generation writes. Each conformance harness checks its `User-Agent` against `VERSION`.

A release stamps its version with Node only, no generators:

```bash
node scripts/version.mjs release 0.1.1   # VERSION and every file above at 0.1.1, then checked
node scripts/version.mjs check 0.1.1     # fails unless every one of them names 0.1.1
node scripts/version.mjs files           # the stamped files, which the release commit carries
```

`release` writes the version in exactly the places generation does, so the result is what `make generate` at that
version would commit.

**Installed from git**, an SDK reports the version of the commit it was built from. A release tag's tree is its
release commit, so every SDK installed from a tag reports that version: Go (`go get …@v0.1.1`), Python
(`pip install "git+…@v0.1.1#subdirectory=python/caitlyn"`, with `caitlyn-core` from the same tag, since `caitlyn`
pins `caitlyn-core==0.1.1`) and Rust (a `git` dependency with `tag = "v0.1.1"`). Installed from a branch or another
commit, they report 0.0.0, except Go, which reads the module version Go records in the binary
(`core.ModuleVersion`) and falls back to `SDKVersion`.

**Which pipeline tests what.** Merge request and `main` pipelines generate and test every SDK at 0.0.0. The release
commit runs no `main` pipeline (a workflow rule skips `chore(release):` commits on `main`), because it only changes
the stamped version. Its tag's pipeline runs `release:version`, which checks that the tag's files carry the tag's
version, and GitHub's `release-npm` checks the same before it tests, builds and stages the packages at that version.

## How a version is chosen

semantic-release (`.releaserc.yml`, run by the `release` CI job from the shared
`custom-d/devops-platform/ci-templates/semantic-versioning` template, as in the app repository) runs on every
`main` pipeline whose conformance passed. From the conventional commits since the last `v*` tag it works out the
next version:

| Commit | Release |
| --- | --- |
| `feat` | minor (0.1.0 → 0.2.0) |
| `fix`, `perf`, `revert` | patch (0.1.0 → 0.1.1) |
| a breaking change (`feat!:`, or a `BREAKING CHANGE:` footer) | minor while the version is below 1.0; going to 1.0 is a decision, made by removing that rule in `.releaserc.yml` |
| `docs`, `ci`, `chore`, `test`, `refactor`, `style`, `build` | none |

So the commit type is what releases: a commit that changes what an SDK does is `feat` or `fix`, and one that
changes only the pipeline, the docs or the tests is not. The release commit is `chore(release): x.y.z`, with no
release notes in its message, so it can never start another release. The `fetch-semantic-version` job shows on
`main` what the next version would be (`VERSION.txt`).

## Releasing

**Never tag by hand, and never edit `VERSION`.** Merge to `main`; when its commits call for a release, the pipeline
cuts it, in the order the app repository's pipeline does:

1. `fetch-semantic-version` (a semantic-release dry run) writes the next version to `VERSION.txt`.
2. `stamp-version` stamps it into every SDK file (`scripts/version.mjs release`), as artifacts.
3. `release` (semantic-release) checks the stamped files name that version, commits them to `main` as
   `chore(release): x.y.z` (`@semantic-release/git`), tags that commit `v<version>` and creates the GitLab release.
4. The push mirror takes `main` and the protected tag to `github.com/caitlyn-ai/sdk`.
5. On GitHub, `release-npm` checks the tag's files carry its version (`scripts/version.mjs check`), tests, builds
   and checks the packages, then stages `sdk-core` and then `sdk`.
6. On npmjs.com, account settings → Staged Packages: check both versions (name, version, dist-tag `latest`,
   publisher), then approve them, `sdk-core` with or before `sdk`, since the SDK depends on that exact
   `sdk-core` version. A batch approves both with one two-factor challenge.

The release commit has no `[skip ci]`, on purpose: GitHub Actions skips every `push`-triggered workflow whose head
commit message contains `[skip ci]`, `[ci skip]`, `[no ci]`, `[skip actions]` or `[actions skip]`, and a tag push is
a push, so `release-npm` would never run ("Skipping workflow runs",
https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-workflow-runs/skipping-workflow-runs).
GitLab skips the release commit's `main` pipeline with a workflow rule instead.

The `release` job pushes the release commit and the tag with `GITLAB_TOKEN`, a CI variable (masked, protected)
holding a project access token (`GITLAB_TOKEN`, bot user `project_857_bot_f4d639af535f0bcf131cd87b09f601c5`) with
the **Maintainer** role and the `api` and `write_repository` scopes. Two protections must let that bot through:

- the protected `v*` tags allow Maintainers to create them;
- the protected branch `main` must allow the bot to push (Settings → Repository → Protected branches → `main` →
  "Allowed to push and merge"). Merges stay as they are.

The token expires: replace it before then, or releases stop with "HTTP Basic: Access denied" (the template's
README, https://git.customd.com/custom-d/devops-platform/ci-templates/semantic-versioning).

### npm

`@caitlyn-ai/sdk-core` and `@caitlyn-ai/sdk` are released from a GitHub mirror of this repository by
`.github/workflows/release-npm.yml`, with npm provenance. npm trusted publishing accepts OpenID Connect tokens
from GitHub Actions (and GitLab.com), not from this GitLab, so the mirror is what lets a release carry
provenance and need no stored npm token. GitLab stays the source: the mirror only receives `main` and tags.

The workflow never publishes directly. It **stages** each version (`npm stage publish`), and a maintainer
approves it on npmjs.com with two-factor authentication, which is the release's one approval
(https://docs.npmjs.com/staged-publishing). Version 0.0.1 of both packages was published by hand from Sam's
account; every version after it goes through the workflow.

What is set up (by Sam: the GitHub organisation and the npm scope are his):

1. **The mirror repository: `github.com/caitlyn-ai/sdk`** (created by Sam). Actions enabled; nobody pushes
   to it except the mirror.
2. **The push mirror, over HTTPS** (GitLab's "Set up a push mirror from GitLab to GitHub",
   https://docs.gitlab.com/user/project/repository/mirror/push/#set-up-a-push-mirror-from-gitlab-to-github):
   - In GitHub, create a fine-grained personal access token with resource owner `caitlyn-ai`, repository
     access "Only select repositories" → `caitlyn-ai/sdk`, and permissions **Contents: read and write** and
     **Workflows: read and write**. GitHub refuses a push that adds or changes a file under `.github/workflows/`
     from a token without the Workflows permission, and this repository carries `release-npm.yml`.
   - In GitLab, `custom-d/caitlyn/sdk` → Settings → Repository → Mirroring repositories → Add new: Git repository
     URL `https://github.com/caitlyn-ai/sdk.git`, direction Push, authentication method "Username and Password",
     username the GitHub account that owns the token, password the token.
   - Turn on "Mirror only protected branches", so `main` reaches GitHub and work-in-progress branches do not.
     Protect the release tags `v*` too (Settings → Repository → Protected tags) so they are mirrored.
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

## Commit messages

Conventional commits, in British English: `feat(codegen): …`, `fix(conformance): …`, `ci: …`,
`docs: …`. The type decides the release ("How a version is chosen"), so pick it for what the commit does to the
SDKs: a merge request's squash commit or merge commit message is what semantic-release reads. Never write a skip-CI marker
(the bracketed "skip ci" or "ci skip") anywhere in a commit message, even to talk about it: GitLab then skips that
commit's pipelines, and GitHub Actions skips its push-triggered workflows. A regenerate from a new model is `feat(model): regenerate the SDKs from model <version>`.
