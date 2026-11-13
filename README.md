# Caitlyn SDKs

The SDKs for the Caitlyn v3 API, generated from its Smithy model, with the runtimes they sit on, the shared
conformance suite, and (later) the Go CLI, the integrations MCP server and the developer docs.

| Language | Package | Generated from the model by | Runtime | Where |
| --- | --- | --- | --- | --- |
| TypeScript | `@caitlyn-ai/sdk` | smithy-typescript with Caitlyn's integration (`codegen/typescript`) | `@caitlyn-ai/sdk-core` | `typescript/` |
| Python | `caitlyn` | Caitlyn's own generator (`codegen/python`): Pydantic v2 and httpx | `caitlyn-core` | `python/` |
| Go | `github.com/caitlyn-ai/caitlyn-go` | Caitlyn's own generator (`codegen/go`) | `github.com/caitlyn-ai/caitlyn-go/core` | `go/` |
| Rust | `caitlyn-sdk` | Caitlyn's own generator (`codegen/rust`): serde and tokio | `caitlyn-sdk-core` | `rust/` |

None of them uses an AWS runtime: no `@aws-sdk` package, no botocore, no aws-sdk-go, no aws-smithy crate, and
none reads AWS configuration. They depend on the OpenTelemetry API only (Rust: the `tracing` crate). Nothing is published yet (lane R2).

## Where things are

```
model/                 the model snapshot the SDKs are generated from, and its lock file
  model.json           the Smithy JSON model, exactly as the app published it
  model.lock.json      which model it is: version, source and SHA-256
  openapi.json         the same model as OpenAPI 3.1, for reference
  PROTOCOL.md          the wire protocol and runtime rules every SDK implements (owned by the app repository)
codegen/               the generators: one Gradle build, one smithy-build plugin per language
  model-support/       model-reading rules the generators share (client-method names, result names, SSE
                       unions and their failure event, problem-details members, versions)
  typescript/ python/ go/ rust/
  smithy-build.json    runs all four over the prepared model
typescript/            npm workspace: packages/sdk (generated), packages/sdk-core (hand-written)
python/                uv workspace: caitlyn (generated), caitlyn-core (hand-written)
go/                    one Go module: the generated package at the root, core/ hand-written
rust/                  Cargo workspace: caitlyn-sdk (generated), caitlyn-sdk-core (hand-written)
conformance/
  cases/protocol.json  the protocol cases every SDK must pass (PROTOCOL.md section 11)
  cases/examples.json  one case per @examples entry, plus synthesised 403 and 404 cases (generated)
  mock-server/         the mock Caitlyn server, with fault injection and example matching
  typescript/ python/ go/ rust/   one thin harness per language
examples/              the examples the docs show, in each language, compiled against the SDKs in CI
docs/                  the developer docs site, build.caitlyn.ai (docs/README.md)
cli/                   the Go CLI (lane C1)
docker/Dockerfile      the toolchain image every make target and CI job runs in
scripts/               generation, model pull and check, tests, docs
```

## Quick start

You need Docker and make. Java, Go, Node, uv and Rust all run in the toolchain image.

```bash
make generate      # regenerate the four SDKs and the example cases from model/model.json
make conformance   # run the four conformance suites against the mock server, then check every case passed
make help          # everything else
```

`make conformance` ends with a table like this:

```
language    protocol cases  example cases  tests passed (all)
typescript  30/30           22/22          52
python      30/30           22/22          53
go          30/30           22/22          58
```

## How the model gets here

The model is defined in the app repository (`custom-d/caitlyn/platform/caitlyn`, folder `smithy/`), beside
the v3 handlers. Each app release publishes it to the app's package registry as `caitlyn-v3-model/<version>/`
(`model.json`, `openapi.json` and the model sources with `PROTOCOL.md`). This repository keeps a committed
snapshot in `model/`, and the generated code beside it is committed too, so a model change arrives as a
reviewable diff of every SDK. See [CONTRIBUTING.md](CONTRIBUTING.md) for pulling a new model and for the
multi-project pipeline that does it on every app release.

Today the snapshot is the Gate 1 build of the model (seven operations), which is not published yet; its
`@since("next")` traits are stamped as `5.115.0` (`stampNext` in the lock file) when the generators read it.

## Plans and decisions

- The design, the implementation plan (gates and lanes) and the generator trial results are in Notion, under
  "Caitlyn v3 API and SDK platform — design".
- `model/PROTOCOL.md` is the contract between the server and every SDK. It is changed in the app repository,
  agreed by all three generator lanes first, with a conformance case in the same change.

## Licence

The SDKs are licensed under the Apache License 2.0 (`LICENSE`, `NOTICE`), copyright Custom D Ltd.
