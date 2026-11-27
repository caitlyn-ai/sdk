# The SDK repository's toolchain, in one image for local builds and CI:
#   - a JDK and Gradle, for the Caitlyn generators (codegen/);
#   - the Smithy CLI, which runs the generators over the model (same version as the app's model build);
#   - Go and staticcheck, for the Go SDK and the CLI, and GoReleaser, cosign, syft and minisign for the CLI's releases;
#   - Node, for the mock server, the conformance tooling and the TypeScript SDK;
#   - uv, for the Python SDK;
#   - Rust (rustc, cargo, rustfmt, clippy), for the Rust SDK.
# Keep SMITHY_VERSION in step with the app repository's smithy/docker/Dockerfile and codegen/gradle.properties.
# Built for linux/amd64 and linux/arm64 (the toolchain job). The Go tools compile on the build machine's own
# architecture for the target's (GOOS/GOARCH), so an emulated arm64 build doesn't compile them under QEMU. `go install`
# won't cross-compile into GOBIN, so they land in GOPATH/bin, or GOPATH/bin/<os>_<arch> when cross-compiled.
FROM --platform=$BUILDPLATFORM golang:1.27 AS go-tools
ARG TARGETOS TARGETARCH
ENV GOOS=$TARGETOS GOARCH=$TARGETARCH CGO_ENABLED=0
# staticcheck 2026.1 cannot read Go 1.27 export data; this master commit (2026-10-24) can.
RUN go install honnef.co/go/tools/cmd/staticcheck@v0.7.0-0.dev.0.20261024224503-8371db75e9da
# The CLI's release tools (cli/.goreleaser.yaml): GoReleaser, cosign for Sigstore signatures, syft for SBOMs, and
# minisign for the update manifest's signature. Static, so cli:publish can carry minisign into the AWS CLI image.
RUN go install github.com/goreleaser/goreleaser/v2@v2.20.0 \
 && go install github.com/sigstore/cosign/v3/cmd/cosign@v3.1.4 \
 && go install github.com/anchore/syft/cmd/syft@v1.57.0 \
 && go install aead.dev/minisign/cmd/minisign@v0.3.0
RUN mkdir /out && find "$(go env GOPATH)/bin" -type f -exec mv {} /out/ \;

# Go itself, for the target's architecture
FROM golang:1.27 AS go

FROM ghcr.io/astral-sh/uv:0.8.0 AS uv

FROM rust:1.99.1-slim-bookworm AS rust
RUN rustup component add rustfmt clippy

FROM gradle:8.14-jdk21
ARG SMITHY_VERSION=1.74.1
COPY scripts/install-smithy-cli.sh /usr/local/bin/install-smithy-cli.sh
# gcc for go test -race (cgo); python3 for uv's managed environments.
RUN apt-get update && apt-get install -y --no-install-recommends curl unzip jq gcc libc6-dev python3 python3-venv \
 && rm -rf /var/lib/apt/lists/* \
 && SMITHY_VERSION=${SMITHY_VERSION} SMITHY_CLI_DIR=/opt/smithy-cli sh /usr/local/bin/install-smithy-cli.sh \
 && smithy --version
COPY --from=go /usr/local/go /usr/local/go
COPY --from=go-tools /out/staticcheck /out/goreleaser /out/cosign /out/syft /out/minisign /usr/local/bin/
COPY --from=node:24-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=uv /uv /uvx /usr/local/bin/
COPY --from=rust /usr/local/rustup /usr/local/rustup
COPY --from=rust /usr/local/cargo /usr/local/cargo
ENV PATH=/usr/local/go/bin:/root/go/bin:/usr/local/cargo/bin:$PATH GOTOOLCHAIN=local UV_PYTHON_PREFERENCE=only-system \
    RUSTUP_HOME=/usr/local/rustup CARGO_HOME=/usr/local/cargo
RUN go version && staticcheck -version && goreleaser --version > /dev/null && cosign version > /dev/null && syft version > /dev/null && node --version && npm --version && uv --version && python3 --version \
 && rustc --version && cargo --version && cargo fmt --version && cargo clippy --version
WORKDIR /work
