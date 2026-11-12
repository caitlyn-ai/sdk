#!/usr/bin/env bash
# TypeScript: install the workspace, type-check the runtime, the generated SDK, the harness, the runtime tests and
# the examples (strict), check that the guides' code blocks match the examples, run the conformance harness and
# the runtime tests, then build the npm packages and check them as a user receives them (imports, types, no AWS
# runtime, size budget).
# Writes build/conformance/typescript.xml, build/conformance/typescript-runtime.xml and build/package/report.json.
set -euo pipefail
cd "$(dirname "$0")/../typescript"
npm ci --no-audit --no-fund --silent
npx tsc -p tsconfig.json
echo "tsc --strict: no errors (SDK, runtime, harness, runtime tests, examples)"
node ../scripts/docs-guides.mjs
test -z "$(ls node_modules/@aws-sdk 2>/dev/null)" || { echo "An @aws-sdk package is installed" >&2; exit 1; }
! grep -rlE "(from |import\(|require\()['\"]@aws-sdk" packages/sdk/src packages/sdk-core/src || { echo "@aws-sdk is imported" >&2; exit 1; }
npm run -s conformance
npm run -s test:runtime
npm run -s build
npm run -s check:package
