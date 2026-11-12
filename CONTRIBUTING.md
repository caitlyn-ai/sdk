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

All four SDKs share one version, the one in the top-level `VERSION` file. `make generate` stamps it everywhere it
appears (`scripts/version.mjs` lists each place):

- TypeScript: both `package.json` files, the SDK's dependency on `sdk-core`, `typescript/package-lock.json`, the
  `User-Agent` and the OpenTelemetry tracer version;
- Python: both `pyproject.toml` files, the `caitlyn-core==` pin, both `__version__` values (the `User-Agent` and the
  tracer version) and `python/uv.lock`;
- Go: `SDKVersion` (the `User-Agent` and the tracer's instrumentation version). Go module versions are git tags;
- Rust: both crates, the generated crate's dependency on `caitlyn-sdk-core`, `SDK_VERSION` (the `User-Agent`) and
  both `Cargo.lock` files.

Generation fails when any of them disagrees with `VERSION`, and the `generate` CI job fails when the committed
files differ from what generation writes. Each conformance harness checks its `User-Agent` against `VERSION`.

## Releasing to npm

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

To release:

1. Set the version in `VERSION`, run `make generate` (it stamps every SDK, the lock files included; see
   "Versions"), commit the result and merge.
2. Tag `v<version>` on `main` in GitLab. The protected tag reaches the mirror.
3. On GitHub, the `release-npm` run for the tag tests, builds and checks the packages, then stages `sdk-core`
   and then `sdk`.
4. On npmjs.com, account settings → Staged Packages: check both versions (name, version, dist-tag `latest`,
   publisher), then approve them, `sdk-core` with or before `sdk`, since the SDK depends on that exact
   `sdk-core` version. A batch approves both with one two-factor challenge.

The GitLab job `release:npm` is a placeholder that says where releases run.

## Commit messages

Conventional commits, in British English: `feat(codegen): …`, `fix(conformance): …`, `ci: …`,
`docs: …`. A regenerate from a new model is `feat(model): regenerate the SDKs from model <version>`.
