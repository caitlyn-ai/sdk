#!/usr/bin/env bash
# TypeScript: install the workspace, type-check the runtime, the generated SDK and the harness (strict), run
# the conformance harness. Writes build/conformance/typescript.xml.
set -euo pipefail
cd "$(dirname "$0")/../typescript"
npm ci --no-audit --no-fund --silent
npx tsc -p tsconfig.json
echo "tsc --strict: no errors"
test -z "$(ls node_modules/@aws-sdk 2>/dev/null)" || { echo "An @aws-sdk package is installed" >&2; exit 1; }
! grep -rl "@aws-sdk" packages/sdk/src packages/sdk-core/src || { echo "@aws-sdk is imported" >&2; exit 1; }
npm run -s conformance
