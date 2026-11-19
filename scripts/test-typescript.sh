#!/usr/bin/env bash
# TypeScript: install the workspace, type-check the runtime, the generated SDK, the harness, the runtime tests and
# the examples and the API reference's programs (strict), check that the guides' code blocks match the examples, run the conformance harness against
# the Node build and (still in Node) against the browser build, the two at once, and the runtime tests, then build the npm packages
# and check them as a user receives them (imports, types, no AWS runtime, export conditions, size budgets).
# The browser build's run in real browsers is the typescript:browser CI job (npm run conformance:browser).
# Writes build/conformance/typescript.xml, typescript-browser-build.xml, typescript-runtime.xml and
# build/package/report.json.
set -euo pipefail
cd "$(dirname "$0")/../typescript"
npm ci --no-audit --no-fund --silent
# prepare-model's dev mode, which the app's local loop (scripts/dev-sdk.sh) uses
node --test ../scripts/prepare-model.test.mjs
node ../scripts/prepare-model.mjs > /dev/null
node ../scripts/docs-snippets.mjs typescript
npx tsc -p tsconfig.json
echo "tsc --strict: no errors (SDK, runtime, harness, runtime tests, examples, the API reference's programs)"
node ../scripts/docs-guides.mjs
test -z "$(ls node_modules/@aws-sdk 2>/dev/null)" || { echo "An @aws-sdk package is installed" >&2; exit 1; }
! grep -rlE "(from |import\(|require\()['\"]@aws-sdk" packages/sdk/src packages/sdk-core/src || { echo "@aws-sdk is imported" >&2; exit 1; }
# The harness against the Node build and against the browser build, at once: one bundle, then two runs, each with its
# own mock server, started here; their output is printed in turn once both have ended.
node scripts/build-conformance.mjs
logs="$(mktemp -d)"
# Each run's mock server, started here (CAITLYN_MOCK_PORT tells the harness not to start its own).
mocks=()
for port in 4101 4102; do
  PORT=$port node ../conformance/mock-server/server.mjs > "$logs/mock-$port.log" 2>&1 & mocks+=($!)
done
trap 'kill "${mocks[@]}" 2>/dev/null || true' EXIT
for port in 4101 4102; do
  for _ in $(seq 100); do grep -q listening "$logs/mock-$port.log" && break; sleep 0.1; done
  grep -q listening "$logs/mock-$port.log" || { cat "$logs/mock-$port.log"; echo "the mock on $port did not start" >&2; exit 1; }
done
CAITLYN_MOCK_PORT=4101 npm run -s conformance:run > "$logs/node.log" 2>&1 & node_run=$!
CAITLYN_MOCK_PORT=4102 npm run -s conformance:browser-build:run > "$logs/browser.log" 2>&1 & browser_run=$!
node_rc=0; wait "$node_run" || node_rc=$?
browser_rc=0; wait "$browser_run" || browser_rc=$?
cat "$logs/node.log" "$logs/browser.log"
[ "$node_rc" = 0 ] && [ "$browser_rc" = 0 ] || { echo "conformance: Node build exit $node_rc, browser build exit $browser_rc" >&2; exit 1; }
npm run -s test:runtime
npm run -s build
npm run -s check:package
