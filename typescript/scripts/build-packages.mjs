// Builds @caitlyn-ai/sdk-core and @caitlyn-ai/sdk for npm, into each package's dist-* folders:
//   dist-es       ESM for Node (.mjs), with the Node HTTP handler
//   dist-cjs      CommonJS for Node (.cjs)
//   dist-browser  ESM for browsers and edge runtimes (.mjs), with the fetch handler (runtimeConfig.browser);
//                 the SDK only, since the core has nothing that differs by runtime
//   dist-types    declarations (tsc)
// Dependencies stay external, so a bundler can tree-shake across them; each entry point is one module per
// format, with code shared between entry points split into chunks.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const browserRuntimeConfig = {
  name: 'browser-runtime-config',
  setup(b) {
    b.onResolve({ filter: /^\.\/runtimeConfig$/ }, (a) => ({ path: path.join(a.resolveDir, 'runtimeConfig.browser.ts') }));
  },
};

async function buildPackage(dir, entries, { browser = false } = {}) {
  const pkgDir = path.join(root, 'packages', dir);
  for (const d of ['dist-es', 'dist-cjs', 'dist-browser', 'dist-types']) fs.rmSync(path.join(pkgDir, d), { recursive: true, force: true });
  const entryPoints = Object.fromEntries(entries.map((e) => [e, path.join(pkgDir, 'src', `${e}.ts`)]));
  const common = { entryPoints, bundle: true, packages: 'external', target: 'es2022', sourcemap: true, logLevel: 'warning', tsconfig: path.join(root, 'build-config', `${dir}.json`) };
  await build({ ...common, outdir: path.join(pkgDir, 'dist-es'), format: 'esm', platform: 'node', splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' });
  if (browser) await build({ ...common, outdir: path.join(pkgDir, 'dist-browser'), format: 'esm', platform: 'browser', splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]', plugins: [browserRuntimeConfig] });
  await build({ ...common, outdir: path.join(pkgDir, 'dist-cjs'), format: 'cjs', platform: 'node', outExtension: { '.js': '.cjs' } });
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(root, 'build-config', `${dir}.json`)], { stdio: 'inherit' });
  fs.copyFileSync(path.join(root, 'README.md'), path.join(pkgDir, 'README.md'));
  for (const f of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, '..', f), path.join(pkgDir, f));
  console.log(`built ${dir}`);
}

await buildPackage('sdk-core', ['index']);
await buildPackage('sdk', ['sdk/index'], { browser: true });
