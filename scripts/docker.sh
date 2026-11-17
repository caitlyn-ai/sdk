#!/usr/bin/env bash
# Runs a command inside the SDK toolchain image (docker/Dockerfile), building the image first when it
# is missing. There is no JDK or Go on developer machines; this is how the generators run locally.
# CI runs the same commands in the same image without this wrapper.
#
#   scripts/docker.sh scripts/generate.sh
#   scripts/docker.sh sh -c 'cd go && go test ./...'
#
# Detached mode, for the app's local loop (scripts/dev-sdk.sh): with CAITLYN_DOCKER_NAME set and no command, it starts
# a long-lived container of that name (`sleep infinity`) with the same mounts and environment, and prints its name.
# A container of that name already running on the current image is left as it is; one on an older image, or stopped,
# is replaced. Callers then run `docker exec <name> scripts/dev-sdk.sh …`.
#
#   CAITLYN_DOCKER_NAME=caitlyn-sdk-dev scripts/docker.sh
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
image="caitlyn-sdk-toolchain:$(shasum -a 256 "$root/docker/Dockerfile" | cut -c1-12)"
# Cargo's build output is kept per checkout: two checkouts building at once in one shared volume corrupt each
# other's builds (a module reported missing that is there). So is the Maven repository, because generate.sh clears
# this project's own artifacts from it before each build. The other caches are safe to share.
checkout="$(printf '%s' "$root" | shasum -a 256 | cut -c1-12)"
docker image inspect "$image" > /dev/null 2>&1 \
  || docker build -q -t "$image" -f "$root/docker/Dockerfile" "$root"
tty=()
[ -t 0 ] && [ -t 1 ] && tty=(-it)
# A git worktree's .git is a file naming its main repository's .git, by a host path: mounted read-only at that same
# path, git works inside the container too (scripts/dev-sdk.sh reads the commit and whether the checkout is dirty).
git_mounts=()
if [ -f "$root/.git" ]; then
  common="$(git -C "$root" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  [ -n "$common" ] && [ -d "$common" ] && git_mounts=(-v "$common:$common:ro")
fi
# CAITLYN_* variables pass through by name (their values never appear on a command line), for the examples run
# against a real workspace (scripts/examples-live.mjs).
env_args=()
while IFS= read -r name; do env_args+=(-e "$name"); done < <(env | sed -n 's/^\(CAITLYN_[A-Z0-9_]*\)=.*/\1/p')
# Named volumes keep the Gradle, Maven, Go, npm, uv and Cargo caches between runs, and Cargo's build output per checkout. typescript/node_modules lives in
# a volume too, because esbuild's binary differs between macOS and Linux. python/.venv is a Linux
# environment in the checkout (it is ignored by git).
run_args=(${env_args[@]+"${env_args[@]}"} \
  -e CAITLYN_HOST_ROOT="$root" \
  -v "$root":/work ${git_mounts[@]+"${git_mounts[@]}"} \
  -v caitlyn-sdk-gradle:/root/.gradle \
  -v "caitlyn-sdk-m2-${checkout}":/root/.m2 \
  -v caitlyn-sdk-go-mod:/root/go/pkg/mod \
  -v caitlyn-sdk-go-build:/root/.cache/go-build \
  -v caitlyn-sdk-npm:/root/.npm \
  -v caitlyn-sdk-uv:/root/.cache/uv \
  -v caitlyn-sdk-node-modules:/work/typescript/node_modules \
  -v caitlyn-sdk-cargo:/root/.cargo \
  -v "caitlyn-sdk-cargo-target-${checkout}":/work/build/rust-target \
  -e GRADLE_USER_HOME=/root/.gradle \
  -e CARGO_HOME=/root/.cargo \
  -e CARGO_TARGET_DIR=/work/build/rust-target \
  -w /work)
if [ -n "${CAITLYN_DOCKER_NAME:-}" ] && [ $# -eq 0 ]; then
  name="$CAITLYN_DOCKER_NAME"
  running="$(docker inspect -f '{{.State.Running}} {{.Config.Image}}' "$name" 2>/dev/null || true)"
  if [ "$running" = "true $image" ]; then
    echo "$name"
    exit 0
  fi
  [ -n "$running" ] && docker rm -f "$name" > /dev/null
  docker run -d --name "$name" "${run_args[@]}" "$image" sleep infinity > /dev/null
  echo "$name"
  exit 0
fi
docker run --rm ${tty[@]+"${tty[@]}"} "${run_args[@]}" "$image" "$@"
