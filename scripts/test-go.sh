#!/usr/bin/env bash
# Go: build, vet and staticcheck the SDK and the harness, run the conformance harness (writes
# build/conformance/go.json), then again with the race detector.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/build/conformance"
cd "$root/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
go build ./... && go vet ./... && staticcheck ./... && go test -count=1 ./...
cd "$root/conformance/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
go vet ./... && staticcheck ./...
go test -count=1 -p 1 -json ./... > "$root/build/conformance/go.json" || { grep -E '"Action":"fail"' "$root/build/conformance/go.json" | head -20; exit 1; }
CGO_ENABLED=1 go test -race -count=1 -p 1 ./... | tail -1
