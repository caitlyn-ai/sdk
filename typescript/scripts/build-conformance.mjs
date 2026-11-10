// Bundles the TypeScript conformance harness (conformance/typescript) against the SDK in this workspace.
// Type checking is `npm run typecheck`; this only bundles.
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
fs.mkdirSync(path.join(root, '../build/conformance'), { recursive: true });
await build({
  entryPoints: [path.join(root, '../conformance/typescript/conformance.test.ts')],
  outfile: path.join(root, 'dist/conformance.test.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'external',
  // The SDK and its runtime are TypeScript source in the workspace, so bundle them rather than load them at run time.
  alias: {
    '@caitlyn-ai/sdk/commands': path.join(root, 'packages/sdk/src/commands/index.ts'),
    '@caitlyn-ai/sdk': path.join(root, 'packages/sdk/src/sdk/index.ts'),
    '@caitlyn-ai/sdk-core': path.join(root, 'packages/sdk-core/src/index.ts'),
  },
  define: { 'process.env.CAITLYN_REPO_ROOT': JSON.stringify(path.resolve(root, '..')) },
  logLevel: 'warning',
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
