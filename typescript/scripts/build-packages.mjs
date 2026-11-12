// Builds @caitlyn-ai/sdk-core and @caitlyn-ai/sdk for npm, into each package's dist-* folders:
//   dist-es       ESM for Node (.mjs), with the Node HTTP handler
//   dist-cjs      CommonJS for Node (.cjs)
//   dist-edge     ESM for Deno, Cloudflare Workers, Vercel Edge and web workers bundled with the `worker` condition
//                 (.mjs): the Node build's code with the fetch handler (runtimeConfig.browser); the SDK only
//   dist-browser  ESM for browser pages (.mjs), both packages: only what a browser can use. Every @smithy/* import
//                 goes to sdk-core's browser/smithy.ts, which keeps the small parts of the Smithy runtime and
//                 replaces the heavy ones (the protocol and its JSON codec, commands, endpoints, retries); the
//                 sign-in modes a browser may not use (clientCredentials, awsIam, workloadIdentity) and the AWS
//                 signer are left out (browser/auth-server.ts, browser/aws.ts). The SDK's browser build imports
//                 sdk-core through '@caitlyn-ai/sdk-core/browser' and '@caitlyn-ai/sdk-core/smithy', so it loads the
//                 browser runtime whichever export conditions a bundler sets.
//   dist-types    declarations: tsc's output bundled into one file per entry point, with the @smithy/* types the
//                 public API mentions inlined, so a project type-checks against them without @types/node
//                 (a browser project with skipLibCheck false); see bundleDeclarations below. Every build has the
//                 same declarations.
// Dependencies stay external, so a bundler can tree-shake across them; each entry point is one module per
// format, with code shared between entry points split into chunks.
import { build } from 'esbuild';
import { rollup } from 'rollup';
import { dts } from 'rollup-plugin-dts';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkBrowserSchemas } from './check-browser-schemas.mjs';
import { coreBrowser, fetchRuntimeConfig, sdkBrowser } from './browser-plugins.mjs';

const root = path.resolve(import.meta.dirname, '..');
const coreSrc = path.join(root, 'packages/sdk-core/src');

async function buildPackage(dir, entries, { edge = false, browser } = {}) {
  const pkgDir = path.join(root, 'packages', dir);
  for (const d of ['dist-es', 'dist-cjs', 'dist-edge', 'dist-browser', 'dist-types']) fs.rmSync(path.join(pkgDir, d), { recursive: true, force: true });
  const entryPoints = Object.fromEntries(entries.map((e) => [e, path.join(pkgDir, 'src', `${e}.ts`)]));
  const common = { entryPoints, bundle: true, packages: 'external', target: 'es2022', sourcemap: true, logLevel: 'warning', tsconfig: path.join(root, 'build-config', `${dir}.json`) };
  const esm = { format: 'esm', splitting: true, outExtension: { '.js': '.mjs' }, chunkNames: 'chunks/[name]-[hash]' };
  await build({ ...common, ...esm, outdir: path.join(pkgDir, 'dist-es'), platform: 'node' });
  if (edge) await build({ ...common, ...esm, outdir: path.join(pkgDir, 'dist-edge'), platform: 'browser', plugins: [fetchRuntimeConfig] });
  if (browser) {
    const { metafile } = await build({ ...common, ...esm, entryPoints: { ...entryPoints, ...browser.entryPoints }, outdir: path.join(pkgDir, 'dist-browser'), platform: 'browser', plugins: browser.plugins, metafile: true });
    assertBrowserOnly(path.join(pkgDir, 'dist-browser'), metafile);
  }
  await build({ ...common, outdir: path.join(pkgDir, 'dist-cjs'), format: 'cjs', platform: 'node', outExtension: { '.js': '.cjs' } });
  execFileSync(path.join(root, 'node_modules/.bin/tsc'), ['-p', path.join(root, 'build-config', `${dir}.json`)], { stdio: 'inherit' });
  fs.copyFileSync(path.join(root, 'README.md'), path.join(pkgDir, 'README.md'));
  for (const f of ['LICENSE', 'NOTICE']) fs.copyFileSync(path.join(root, '..', f), path.join(pkgDir, f));
  console.log(`built ${dir}`);
}

/**
 * The browser build imports nothing a browser cannot run, and nothing that the browser runtime replaces: no node:
 * modules, no Node HTTP handler, no Smithy protocol or retry internals, and no AWS signer.
 */
function assertBrowserOnly(dir, metafile) {
  const allowed = /^(@smithy\/core(\/(client|transport|schema|protocols|serde))?|@smithy\/fetch-http-handler|@opentelemetry\/api|@caitlyn-ai\/sdk-core\/(browser|smithy)|tslib)$/;
  for (const [file, output] of Object.entries(metafile.outputs)) {
    for (const i of output.imports) if (i.external && !allowed.test(i.path)) throw new Error(`build-packages: the browser build's ${file} imports ${i.path}`);
  }
  for (const file of fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.mjs'))) {
    const code = fs.readFileSync(path.join(dir, file), 'utf8');
    if (/GetWebIdentityToken|AWS4-HMAC-SHA256|client_credentials|token-exchange/.test(code)) throw new Error(`build-packages: the browser build's ${file} carries a server-only sign-in mode`);
  }
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

// The browser runtime implements the model features Caitlyn uses; a model that needs more fails here, not in a browser.
await checkBrowserSchemas(path.join(root, 'packages/sdk/src/schemas/schemas_0.ts'));
await buildPackage('sdk-core', ['index'], { browser: { entryPoints: { smithy: path.join(coreSrc, 'browser/smithy.ts') }, plugins: [coreBrowser] } });
await buildPackage('sdk', ['sdk/index'], { edge: true, browser: { entryPoints: {}, plugins: [fetchRuntimeConfig, sdkBrowser] } });
// After both tsc runs: the SDK's declarations were compiled against sdk-core's, and its bundle reads them.
await bundleDeclarations(path.join(root, 'packages/sdk'), 'sdk/index');
await bundleDeclarations(path.join(root, 'packages/sdk-core'), 'index');
console.log('bundled the declarations (dist-types)');
