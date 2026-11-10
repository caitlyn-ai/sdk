# Generators

One Gradle build with four projects. Each generator is a smithy-build plugin; `codegen/smithy-build.json`
runs all three over `build/model/model.json` (the prepared snapshot, see CONTRIBUTING.md). `make generate`
builds and runs them in the toolchain image.

| Project | Plugin | Output |
| --- | --- | --- |
| `model-support` | none (a library) | The rules the generators share: `ClientMethod` (namespace, method name and positional identifier, PROTOCOL.md section 10), `ResultNames`, `SseEvents` (unions, the failure member: the one carrying the problem details), `ProblemDetails`, `Versions`, `CaitlynTraits`, `Bindings` |
| `typescript` | smithy-typescript's `typescript-client-codegen`, with Caitlyn's integration | `typescript/packages/sdk`: the Smithy client with the Caitlyn REST JSON protocol (`CaitlynRestJsonProtocolGenerator`), no AWS runtime, and the method-style SDK in `src/sdk/` (`FacadeGenerator`) |
| `python` | `caitlyn-python-client-codegen` | `python/caitlyn`: Pydantic v2 models, open enums, typed errors and events, sync and async clients on `caitlyn-core` |
| `go` | `caitlyn-go-client-codegen` | The generated files in `go/`: types that keep their raw JSON, open enums, typed errors that embed `*core.APIError`, sealed event interfaces, namespaced clients on `core` |

The Python and Go generators are on Smithy's own codegen framework (`smithy-codegen-core`: `CodegenDirector`,
`DirectedCodegen`, symbol providers and writers). smithy-python (pre-alpha) and smithy-go (no retries, auth,
pagination or SSE) were assessed in the generator trial and not used.

Generator-level tests live beside each generator; `codegen/python/tests` checks the Python SDK's static types
with pyright and its interceptor hooks (`make python` runs them).
