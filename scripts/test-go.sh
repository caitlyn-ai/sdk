#!/usr/bin/env bash
# Go: the Go tag script's tests, then build, vet and staticcheck the SDK, the developer docs' examples and the harness, and run the conformance harness
# once, under the race detector (writes build/conformance/go.json).
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/build/conformance"
# The Go release step (scripts/go-tag.mjs, run by semantic-release), against a stand-in for GitLab's API
node --test "$root/scripts/go-tag.test.mjs"
cd "$root/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
# One command a line: set -e stops at a failing one, but not at one that fails before the last of an && list
go build -p 2 ./...
go vet -p 2 ./...
staticcheck ./...
go test -p 2 -count=1 ./...
# The developer docs' Go: the hand-written examples and the API reference's programs (scripts/docs-snippets.mjs)
cd "$root"
node scripts/prepare-model.mjs > /dev/null
node scripts/docs-snippets.mjs go
cd "$root/examples/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
go build -p 2 ./...
go vet -p 2 ./...
staticcheck ./...
cd "$root/conformance/go"
test -z "$(gofmt -l .)" || { gofmt -l .; echo "gofmt: the files above are not formatted" >&2; exit 1; }
# The harness builds the SDK with its conformance-only hooks (go/sync_conformance.go)
go vet -tags caitlyn_conformance ./...
staticcheck -tags caitlyn_conformance ./...
# One run, under the race detector, which runs every test as a plain run would and also reports a data race; its
# events go to build/conformance/go.json (the per-case check reads them). On a failure, the failing tests' output and
# any race report are printed, never reduced to the last line.
CGO_ENABLED=1 go test -tags caitlyn_conformance -race -count=1 -p 1 -json ./... > "$root/build/conformance/go.json" || {
  node -e '
    const lines = require("fs").readFileSync(process.argv[1], "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const failed = new Set(lines.filter((e) => e.Action === "fail").map((e) => e.Test ?? e.Package));
    for (const e of lines) if (e.Action === "output" && (failed.has(e.Test ?? e.Package) || /DATA RACE|WARNING: DATA RACE/.test(e.Output))) process.stdout.write(e.Output);
  ' "$root/build/conformance/go.json"
  echo "go test -race failed: every event is in build/conformance/go.json" >&2
  exit 1
}
grep -E '"Action":"(pass|fail)","Package"' "$root/build/conformance/go.json" | tail -2
