#!/usr/bin/env bash
# Go: the Go tag script's tests, then build, vet and staticcheck the SDK, the developer docs' examples and the harness, run the conformance harness (writes
# build/conformance/go.json), then again with the race detector.
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/build/conformance"
# The Go release step (scripts/go-tag.mjs, run by semantic-release), against a stand-in for GitLab's API
node --test "$root/scripts/go-tag.test.mjs"
cd "$root/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
go build -p 2 ./... && go vet -p 2 ./... && staticcheck ./... && go test -p 2 -count=1 ./...
# The developer docs' Go: the hand-written examples and the API reference's programs (scripts/docs-snippets.mjs)
cd "$root"
node scripts/prepare-model.mjs > /dev/null
node scripts/docs-snippets.mjs go
cd "$root/examples/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
go build -p 2 ./... && go vet -p 2 ./... && staticcheck ./...
cd "$root/conformance/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
# The harness builds the SDK with its conformance-only hooks (go/sync_conformance.go)
go vet -tags caitlyn_conformance ./... && staticcheck -tags caitlyn_conformance ./...
go test -tags caitlyn_conformance -count=1 -p 1 -json ./... > "$root/build/conformance/go.json" || { grep -E '"Action":"fail"' "$root/build/conformance/go.json" | head -20; exit 1; }
# The race run's whole output is kept in build/conformance/go-race.log and printed when it fails, so a data race
# report (or a failing test) is never reduced to its last line
CGO_ENABLED=1 go test -tags caitlyn_conformance -race -count=1 -p 1 ./... > "$root/build/conformance/go-race.log" 2>&1 \
  || { grep -v -E '^(=== RUN|    --- PASS|--- PASS)' "$root/build/conformance/go-race.log"; echo "go test -race failed: full output in build/conformance/go-race.log" >&2; exit 1; }
tail -1 "$root/build/conformance/go-race.log"
