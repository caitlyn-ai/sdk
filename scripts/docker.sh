#!/usr/bin/env bash
# Runs a command inside the SDK toolchain image (docker/Dockerfile), building the image first when it
# is missing. There is no JDK or Go on developer machines; this is how the generators run locally.
# CI runs the same commands in the same image without this wrapper.
#
#   scripts/docker.sh scripts/generate.sh
#   scripts/docker.sh sh -c 'cd go && go test ./...'
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="caitlyn-sdk-toolchain:$(shasum -a 256 "$root/docker/Dockerfile" | cut -c1-12)"
docker image inspect "$image" > /dev/null 2>&1 \
  || docker build -q -t "$image" -f "$root/docker/Dockerfile" "$root"
tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-it)
# Named volumes keep the Gradle, Maven, Go, npm, uv and Cargo caches (and Cargo's build output) between runs. typescript/node_modules lives in
# a volume too, because esbuild's binary differs between macOS and Linux. python/.venv is a Linux
# environment in the checkout (it is ignored by git).
docker run --rm ${tty[@]+"${tty[@]}"} \
  -v "$root":/work \
  -v caitlyn-sdk-gradle:/root/.gradle \
  -v caitlyn-sdk-m2:/root/.m2 \
  -v caitlyn-sdk-go-mod:/root/go/pkg/mod \
  -v caitlyn-sdk-go-build:/root/.cache/go-build \
  -v caitlyn-sdk-npm:/root/.npm \
  -v caitlyn-sdk-uv:/root/.cache/uv \
  -v caitlyn-sdk-node-modules:/work/typescript/node_modules \
  -v caitlyn-sdk-cargo:/root/.cargo \
  -v caitlyn-sdk-cargo-target:/work/build/rust-target \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e CARGO_HOME=/root/.cargo \
  -e CARGO_TARGET_DIR=/work/build/rust-target \
  -w /work \
  "$image" "$@"
