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

1. `scripts/prepare-model.mjs`: checks `model/model.json` against the lock file and writes
   `build/model/model.json`, without the app's lint-rule metadata (those rules run in the app's model build)
   and with any `@since("next")` stamped as the lock's `stampNext`.
2. `scripts/gen-example-cases.mjs`: writes `conformance/cases/examples.json` from the model's `@examples`.
3. `gradle test publish` in `codegen/`: compiles and tests the generators and writes them to
   `codegen/build/repo`, a file repository. Nothing is published anywhere else.
4. `smithy build` in `codegen/`: runs the four generators (`codegen/smithy-build.json`).
5. Copies the output into `typescript/packages/sdk`, `python/caitlyn`, `go/` and `rust/caitlyn-sdk`, then tidies
   it (`scripts/postgen-ts.mjs`, `gofmt`, `rustfmt`).

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
Package versions are `0.0.1` everywhere until lane R2 decides the release scheme.

## Releasing to npm

`@caitlyn-ai/sdk-core` and `@caitlyn-ai/sdk` are published from a GitHub mirror of this repository, by
`.github/workflows/release-npm.yml`, with npm provenance. npm trusted publishing accepts OpenID Connect tokens
from GitHub Actions (and GitLab.com), not from this GitLab, so the mirror is what lets a release carry
provenance and need no stored npm token. GitLab stays the source: the mirror only receives `main` and tags.

None of this exists yet. Setting it up needs Sam (the GitHub organisation and the npm scope are his):

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
3. **The `npm` environment.** In the GitHub repository, Settings → Environments → `npm`, with Sam as required
   reviewer and deployment limited to `v*` tags. The workflow's publish job waits there for approval.
4. **Trusted publishers on npm.** For each of `@caitlyn-ai/sdk-core` and `@caitlyn-ai/sdk`: Settings →
   Trusted publishing → GitHub Actions, organisation `caitlyn-ai`, repository `sdk`, workflow
   `release-npm.yml`, environment `npm`. Then set "Require two-factor authentication and disallow tokens" so the
   workflow is the only way to publish. If npm still allows trusted publishers only on packages that already
   exist, the first version is published once by hand from Sam's account (`npm publish --access public` in
   each package after `npm run build`), and every version after it by the workflow.

To release: set the version in `typescript/packages/sdk-core/package.json` (generation copies it to the SDK),
regenerate, merge, then tag `v<version>` on `main` in GitLab. The tag reaches the mirror, the workflow tests,
builds and checks the packages, and after approval publishes `sdk-core` then `sdk`. The GitLab job
`release:npm` is a placeholder that says where releases run.

## Commit messages

Conventional commits, in British English: `feat(codegen): …`, `fix(conformance): …`, `ci: …`,
`docs: …`. A regenerate from a new model is `feat(model): regenerate the SDKs from model <version>`.
