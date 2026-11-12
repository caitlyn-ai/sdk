// Bundles the TypeScript conformance harness (conformance/typescript) and the runtime tests (test/) against the
// SDK in this workspace, compiled the way scripts/build-packages.mjs compiles it (the generated code on sdk-core's
// runtime), and the harness once more against the browser build (conformance-browser.test.mjs), for a quick run in
// Node before the run in real browsers (scripts/conformance-browser.mjs).
// Type checking is `npm run typecheck`; this only bundles.
import { build } from 'esbuild';
import { browserFromSource, runtimeFromSource } from './browser-plugins.mjs';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, '../build/conformance'), { recursive: true });
const common = {
  outdir: path.join(root, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  define: { 'process.env.CAITLYN_REPO_ROOT': JSON.stringify(path.resolve(root, '..')) },
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
};
// The SDK and its runtime are TypeScript source in the workspace, so bundle them rather than load them at run time.
const sources = {
  '@caitlyn-ai/sdk/commands': path.join(root, 'packages/sdk/src/commands/index.ts'),
  '@caitlyn-ai/sdk': path.join(root, 'packages/sdk/src/sdk/index.ts'),
  '@caitlyn-ai/sdk-core': path.join(root, 'packages/sdk-core/src/index.ts'),
};
await build({
  ...common,
  entryPoints: {
    'conformance.test': path.join(root, '../conformance/typescript/conformance.test.ts'),
    'auth.test': path.join(root, 'test/auth.test.ts'),
    'waiter.test': path.join(root, 'test/waiter.test.ts'),
    'browser-guard.test': path.join(root, 'test/browser-guard.test.ts'),
    'request-handler.test': path.join(root, 'test/request-handler.test.ts'),
  },
  alias: sources,
  plugins: [runtimeFromSource],
});
await build({
  ...common,
  entryPoints: { 'conformance-browser.test': path.join(root, '../conformance/typescript/conformance.test.ts') },
  alias: sources,
  plugins: [browserFromSource],
  define: { ...common.define, 'process.env.CAITLYN_SDK_BUILD': '"browser"' },
});
