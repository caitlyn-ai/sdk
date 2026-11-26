# Every target runs in the toolchain image (docker/Dockerfile) through scripts/docker.sh, because there is no
# JDK or Go on developer machines. CI runs the same scripts in the same image. `make help` lists the targets.
RUN := scripts/docker.sh

.PHONY: help generate check-generated model-snapshot-check examples-live typescript python go rust cli cli-snapshot conformance check docs docs-kb-dry-run cli-examples cli-agent-eval model-check shell clean

help: ## List the targets
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-18s %s\n", $$1, $$2}'

generate: ## Regenerate all four SDKs and the example cases from model/model.json
	@$(RUN) scripts/generate.sh

# Hand-written files scripts/version.mjs stamps with the version in VERSION.
VERSIONED := typescript/packages/sdk-core typescript/package-lock.json python/caitlyn-core python/uv.lock rust/Cargo.toml \
  rust/Cargo.lock conformance/rust/Cargo.lock examples/rust/Cargo.lock codegen/smithy-build.json

check-generated: generate ## Fail if the committed generated code differs from a fresh generation
	@git diff --exit-code --stat -- typescript/packages/sdk python/caitlyn go rust/caitlyn-sdk conformance/cases $(VERSIONED) \
	  || { echo "Generated code is out of date: run make generate and commit the result."; exit 1; }

typescript: ## TypeScript: install, type-check, conformance
	@$(RUN) scripts/test-typescript.sh

python: ## Python: install, pyright --strict, generator tests, conformance
	@$(RUN) scripts/test-python.sh

go: ## Go: build, vet, staticcheck, conformance (also with the race detector)
	@$(RUN) scripts/test-go.sh

cli: ## The CLI: build, vet, staticcheck, and the tests with the race detector
	@$(RUN) sh -c 'cd cli && go build ./... && go vet ./... && staticcheck ./... && CGO_ENABLED=1 go test -race -count=1 ./...'

cli-snapshot: ## The CLI's GoReleaser snapshot: every archive and package into cli/dist, nothing signed or published
	@$(RUN) sh -c 'cd cli && goreleaser release --snapshot --clean --skip=docker,sign,sbom'

rust: ## Rust: rustfmt, clippy, unit and doc tests, conformance
	@$(RUN) scripts/test-rust.sh

conformance: ## All four language suites at once (CAITLYN_SUITES_AT_ONCE, default 4), then the per-case check
	@scripts/conformance-all.sh
	@$(RUN) node scripts/check-conformance.mjs

model-snapshot-check: ## Fail if model/ changed (against origin/main) without model/model.lock.json: edit the app's smithy/ instead
	@scripts/model-snapshot-check.sh

check: model-snapshot-check generate conformance ## What a merge request pipeline runs

examples-live: ## Run every SDK's examples against a real workspace (CONTRIBUTING.md, "Running the examples against a workspace")
	@node scripts/examples-live.mjs

docs: ## Build the developer docs site into build/docs (docs/README.md)
	@$(RUN) scripts/docs-build.sh

docs-kb-dry-run: docs ## Show what the knowledge-base publisher would send, without sending anything
	@$(RUN) node scripts/docs-kb-publish.mjs --dry-run

cli-examples: ## Run the CLI's examples (examples/cli/) against the mock server and compare them with their transcripts
	@$(RUN) scripts/cli-examples.sh

cli-agent-eval: ## The CLI's agent evaluation, offline: its scripted agent plays every task's reference solution (cli/agent-eval/eval.mjs)
	@$(RUN) cli/agent-eval/run.sh --agent scripted

model-check: ## Is model/model.json the latest published model? (needs GITLAB_TOKEN)
	@scripts/model-check.sh

shell: ## A shell in the toolchain image
	@$(RUN) bash

clean: ## Remove build output (not generated code)
	rm -rf build codegen/build typescript/dist
