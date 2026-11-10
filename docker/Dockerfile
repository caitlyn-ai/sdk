# The SDK repository's toolchain, in one image for local builds and CI:
#   - a JDK and Gradle, for the Caitlyn generators (codegen/);
#   - the Smithy CLI, which runs the generators over the model (same version as the app's model build);
#   - Go and staticcheck, for the Go SDK;
#   - Node, for the mock server, the conformance tooling and the TypeScript SDK;
#   - uv, for the Python SDK.
# Keep SMITHY_VERSION in step with the app repository's smithy/docker/Dockerfile and codegen/gradle.properties.
FROM golang:1.27 AS go
# staticcheck 2026.1 cannot read Go 1.27 export data; this master commit (2026-10-24) can.
RUN GOBIN=/out go install honnef.co/go/tools/cmd/staticcheck@v0.7.0-0.dev.0.20261024224503-8371db75e9da

FROM ghcr.io/astral-sh/uv:0.8.0 AS uv

FROM gradle:8.14-jdk21
ARG SMITHY_VERSION=1.74.1
COPY scripts/install-smithy-cli.sh /usr/local/bin/install-smithy-cli.sh
# gcc for go test -race (cgo); python3 for uv's managed environments.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip jq gcc libc6-dev python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && SMITHY_VERSION=${SMITHY_VERSION} SMITHY_CLI_DIR=/opt/smithy-cli sh /usr/local/bin/install-smithy-cli.sh \
 && smithy --version
COPY --from=go /usr/local/go /usr/local/go
COPY --from=go /out/staticcheck /usr/local/bin/staticcheck
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/
ENV PATH=/usr/local/go/bin:/root/go/bin:$PATH GOTOOLCHAIN=local UV_PYTHON_PREFERENCE=only-system
RUN go version && staticcheck -version && node --version && npm --version && uv --version && python3 --version
WORKDIR /work
