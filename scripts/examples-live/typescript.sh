#!/usr/bin/env bash
# The TypeScript examples against a real server (scripts/examples-live.mjs runs this in the toolchain image).
# Bundles scripts/examples-live/typescript.ts against the SDK in this workspace, then runs it. Prints one line per
# check on stdout, `ok <check>` or `fail <check>: <why>`; everything else goes to stderr.
set -euo pipefail
cd "$(dirname "$0")/../../typescript"
npm ci --no-audit --no-fund --silent >&2
node --input-type=module -e "
import { build } from 'esbuild';
await build({
  entryPoints: ['../scripts/examples-live/typescript.ts'],
  outfile: 'dist/examples-live.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node20', packages: 'external', logLevel: 'warning',
  alias: {
    '@caitlyn-ai/sdk': './packages/sdk/src/sdk/index.ts',
    '@caitlyn-ai/sdk-core': './packages/sdk-core/src/index.ts',
  },
  define: { 'process.env.CAITLYN_REPO_ROOT': JSON.stringify(process.cwd().slice(0, process.cwd().lastIndexOf('/'))) },
  banner: { js: \"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);\" },
});
" >&2
exec node dist/examples-live.mjs
