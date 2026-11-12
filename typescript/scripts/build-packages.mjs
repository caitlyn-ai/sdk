// Builds @caitlyn-ai/sdk-core and @caitlyn-ai/sdk for npm, into each package's dist-* folders:
//   dist-es       ESM for Node (.mjs), with the Node HTTP handler
//   dist-cjs      CommonJS for Node (.cjs)
//   dist-browser  ESM for browsers and edge runtimes (.mjs), with the fetch handler (runtimeConfig.browser);
//                 the SDK only, since the core has nothing that differs by runtime
//   dist-types    declarations: tsc's output bundled into one file per entry point, with the @smithy/* types the
//                 public API mentions inlined, so a project type-checks against them without @types/node
//                 (a browser project with skipLibCheck false); see bundleDeclarations below
// Dependencies stay external, so a bundler can tree-shake across them; each entry point is one module per
// format, with code shared between entry points split into chunks.
import { build } from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
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

// Types that stay imports: @opentelemetry/api is browser-safe and part of the public API. Everything else the
// declarations mention, @smithy/* and (for the SDK) @caitlyn-ai/sdk-core, is inlined, so an SDK user's program
// holds one copy of each type.
const KEEP_EXTERNAL = ['@opentelemetry/api'];

// The Node-only names the inlined @smithy/* declarations import, all in options and stream types a browser never
// uses (http.Agent for the Node request handler, Readable and IncomingMessage for streaming blobs). Each becomes an
// empty interface, which any value is assignable to, so a Node project can still pass its real agent or stream.
// Any other Node import fails the build: look at what it is before adding it here.
const NODE_STAND_INS = { 'node:http': ['Agent', 'AgentOptions', 'IncomingMessage'], 'node:https': ['Agent', 'AgentOptions'], 'node:stream': ['Readable'] };

/** Replaces tsc's declaration tree with one self-contained file for an entry point (dist-types/<entry>.d.ts). */
async function bundleDeclarations(pkgDir, entry) {
  const typesDir = path.join(pkgDir, 'dist-types');
  const external = (id) => /^node:/.test(id) || KEEP_EXTERNAL.some((e) => id === e || id.startsWith(`${e}/`));
  const bundle = await rollup({ input: path.join(typesDir, `${entry}.d.ts`), plugins: [dts({ respectExternal: true })], external, logLevel: 'silent' });
  let code = (await bundle.generate({ format: 'es' })).output[0].code;
  code = code.replace(/^import \{([^}]*)\} from '(node:[^']+)';\n/gm, (_, names, mod) => {
    const allowed = NODE_STAND_INS[mod];
    if (!allowed) throw new Error(`build-packages: the declarations import ${mod}`);
    return names.split(',').map((n) => n.trim()).filter(Boolean).map((n) => {
      const [name, alias = name] = n.split(/\s+as\s+/);
      if (!allowed.includes(name)) throw new Error(`build-packages: the declarations import ${name} from ${mod}`);
      return `/** Stand-in for ${mod}'s ${name}, so these types need no @types/node. */\ninterface ${alias} {}\n`;
    }).join('');
  });
  const leftover = code.match(/^import .*['"](node:[^'"]+|@smithy\/[^'"]+)['"];?$/m) ?? code.match(/\bNodeJS\./);
  if (leftover) throw new Error(`build-packages: the bundled declarations still need ${leftover[0]}`);
  fs.rmSync(typesDir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(path.join(typesDir, `${entry}.d.ts`)), { recursive: true });
  fs.writeFileSync(path.join(typesDir, `${entry}.d.ts`), code);
}

await buildPackage('sdk-core', ['index']);
await buildPackage('sdk', ['sdk/index'], { browser: true });
// After both tsc runs: the SDK's declarations were compiled against sdk-core's, and its bundle reads them.
await bundleDeclarations(path.join(root, 'packages/sdk'), 'sdk/index');
await bundleDeclarations(path.join(root, 'packages/sdk-core'), 'index');
console.log('bundled the declarations (dist-types)');
