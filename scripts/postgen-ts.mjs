// Deterministic post-generation edit for the TypeScript client (run by scripts/generate.sh).
// smithy-typescript's runtimeConfig templates always resolve a "defaults mode", which reads AWS_DEFAULTS_MODE
// and ~/.aws/config and, in "auto" mode, can query the EC2 instance metadata service. The integration already
// replaces every consumer (requestHandler, retryMode); this removes the dead lines and their imports.
// Every edit must match exactly once, or the script fails: a generator upgrade that changes the template is caught.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
// The TypeScript workspace to edit: the checkout's typescript/ (the default, for scripts/generate.sh), or another one
// laid out the same way (scripts/dev-sdk.sh's, under build/dev-sdk/<name>/typescript).
const tsRoot = process.argv[2] ? pathToFileURL(`${path.resolve(process.argv[2])}/`) : new URL('../typescript/', import.meta.url);
const dir = new URL('packages/sdk/src/', tsRoot);
const edits = {
  'runtimeConfig.ts': [
    ['import { emitWarningIfUnsupportedVersion, loadConfigsForDefaultMode } from "@smithy/core/client";\n', 'import { emitWarningIfUnsupportedVersion } from "@smithy/core/client";\n'],
    ['import { resolveDefaultsModeConfig } from "@smithy/core/config";\n', ''],
    ['  const defaultsMode = resolveDefaultsModeConfig(config);\n', ''],
    ['  const defaultConfigProvider = () => defaultsMode().then(loadConfigsForDefaultMode);\n', ''],
    ['    defaultsMode,\n', ''],
  ],
  'runtimeConfig.browser.ts': [
    ['import { loadConfigsForDefaultMode } from "@smithy/core/client";\n', ''],
    ['import { resolveDefaultsModeConfig } from "@smithy/core/config";\n', ''],
    ['  const defaultsMode = resolveDefaultsModeConfig(config);\n', ''],
    ['  const defaultConfigProvider = () => defaultsMode().then(loadConfigsForDefaultMode);\n', ''],
    ['    defaultsMode,\n', ''],
  ],
};
for (const [file, list] of Object.entries(edits)) {
  const url = new URL(file, dir);
  let s = fs.readFileSync(url, 'utf8');
  for (const [from, to] of list) {
    const n = s.split(from).length - 1;
    if (n !== 1) throw new Error(`postgen-ts: expected exactly one match in ${file} for ${JSON.stringify(from)}, found ${n}`);
    s = s.replace(from, to);
  }
  if (/defaultsMode|DefaultsMode/.test(s)) throw new Error(`postgen-ts: defaults mode still referenced in ${file}`);
  fs.writeFileSync(url, s);
}
console.log('postgen-ts: removed defaults-mode resolution from runtimeConfig.ts and runtimeConfig.browser.ts');

// Every enum in the model is open: a server may send a value this SDK does not know yet, and the SDK keeps it as the
// string it is (PROTOCOL.md 4.1). smithy-typescript types an enum as the union of its known values only, which tells a
// caller that a `switch` over the known values is exhaustive when at runtime it is not. Each enum's type gains
// `| (string & {})`: any string is accepted, and editors still offer the known values.
{
  const url = new URL('models/enums.ts', dir);
  let s = fs.readFileSync(url, 'utf8');
  const declared = [...s.matchAll(/^export const (\w+) = \{$/gm)].map((m) => m[1]);
  let opened = 0;
  s = s.replace(/^export type (\w+) =\s*\(typeof (\w+)\)\[keyof typeof (\w+)\];$/gm, (line, a, b, c) => {
    if (a !== b || b !== c) throw new Error(`postgen-ts: unexpected enum type line ${line}`);
    opened++;
    return `export type ${a} = (typeof ${a})[keyof typeof ${a}] | (string & {});`;
  });
  if (declared.length === 0 || opened !== declared.length) {
    throw new Error(`postgen-ts: ${declared.length} enums in models/enums.ts but ${opened} enum types opened`);
  }
  fs.writeFileSync(url, s);
  console.log(`postgen-ts: ${opened} enum types accept values this SDK does not know yet`);
}

// The generated package.json carries smithy-typescript's yarn build scripts and their devDependencies. The
// repository builds and tests the SDK from typescript/package.json (an npm workspace), so they are dropped, and
// the package is described for npm: entry points for Node (ESM and CommonJS), for edge runtimes (fetch), for
// browser pages (the browser build, also as the explicit `@caitlyn-ai/sdk/browser`), types, and the files
// typescript/scripts/build-packages.mjs writes. The edge conditions come before `browser`, so a bundler that sets
// both (Cloudflare's, or webpack for a web worker) takes the edge build, which has every sign-in mode.
const pkgUrl = new URL('packages/sdk/package.json', tsRoot);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));
const corePkg = JSON.parse(fs.readFileSync(new URL('packages/sdk-core/package.json', tsRoot), 'utf8'));
const entry = (name) => ({
  types: `./dist-types/${name}.d.ts`,
  workerd: `./dist-edge/${name}.mjs`,
  worker: `./dist-edge/${name}.mjs`,
  deno: `./dist-edge/${name}.mjs`,
  'edge-light': `./dist-edge/${name}.mjs`,
  browser: `./dist-browser/${name}.mjs`,
  import: `./dist-es/${name}.mjs`,
  require: `./dist-cjs/${name}.cjs`,
});
const published = {
  name: pkg.name,
  description: 'The TypeScript SDK for the Caitlyn v3 API.',
  version: corePkg.version,
  license: corePkg.license,
  homepage: 'https://build.caitlyn.ai',
  // npm provenance checks this against the GitHub repository the release workflow runs in.
  repository: { type: 'git', url: 'git+https://github.com/caitlyn-ai/sdk.git', directory: 'typescript/packages/sdk' },
  sideEffects: false,
  main: './dist-cjs/sdk/index.cjs',
  module: './dist-es/sdk/index.mjs',
  types: './dist-types/sdk/index.d.ts',
  exports: {
    '.': entry('sdk/index'),
    './browser': { types: './dist-types/sdk/index.d.ts', default: './dist-browser/sdk/index.mjs' },
    './package.json': './package.json',
  },
  files: ['dist-*/**', 'README.md', 'LICENSE', 'NOTICE'],
  engines: pkg.engines,
  // Every runtime uses fetch (CaitlynTypeScriptIntegration), so the Node HTTP handler smithy-typescript always lists
  // is not a dependency; the check below fails generation if anything imports it.
  dependencies: { ...Object.fromEntries(Object.entries(pkg.dependencies).filter(([d]) => d !== '@smithy/node-http-handler')), '@caitlyn-ai/sdk-core': corePkg.version },
  publishConfig: corePkg.publishConfig,
};
for (const file of fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.ts'))) {
  if (fs.readFileSync(new URL(file, dir), 'utf8').includes('@smithy/node-http-handler')) throw new Error(`postgen-ts: ${file} imports @smithy/node-http-handler`);
}
fs.writeFileSync(pkgUrl, JSON.stringify(published, null, 4) + '\n');
console.log('postgen-ts: wrote the npm description of packages/sdk/package.json');

// The generated endpoint resolver runs smithy-typescript's rules engine over a one-rule decision diagram. The client
// never calls it: its endpoint provider is sdk-core's caitlynEndpointProvider (https://<workspace>/api or the
// `endpoint` override), so the two files are removed, and nothing may import them.
for (const file of ['endpoint/endpointResolver.ts', 'endpoint/bdd.ts']) fs.rmSync(new URL(file, dir));
for (const file of fs.readdirSync(dir, { recursive: true }).filter((f) => f.endsWith('.ts'))) {
  if (/from "\.\.?\/(endpoint\/)?(endpointResolver|bdd)"/.test(fs.readFileSync(new URL(file, dir), 'utf8'))) throw new Error(`postgen-ts: ${file} imports the removed endpoint resolver`);
}
console.log('postgen-ts: removed the rules-engine endpoint resolver (endpoint/endpointResolver.ts, endpoint/bdd.ts)');

// smithy-typescript writes its own waiters (src/waiters/, on @smithy/core's createWaiter) from @waitable. The SDK's
// waiters are the facade's waitUntil…() functions, on sdk-core's waitUntil (PROTOCOL.md 10.1: an unexpected error
// is a waiter failure, and the default limit is the waiter's @waitLimits entry), so smithy-typescript's are removed.
{
  const waitersDir = new URL('waiters/', dir);
  if (fs.existsSync(waitersDir)) {
    fs.rmSync(waitersDir, { recursive: true });
    const indexUrl = new URL('index.ts', dir);
    const index = fs.readFileSync(indexUrl, 'utf8');
    const line = 'export * from "./waiters";\n';
    if (index.split(line).length - 1 !== 1) throw new Error('postgen-ts: expected exactly one waiters export in index.ts');
    fs.writeFileSync(indexUrl, index.replace(line, ''));
    // The aggregated client (src/Caitlyn.ts) lists them too: its imports, the waiters object, the methods it
    // declares for them, and the waiter types those methods use.
    const aggregatedUrl = new URL('Caitlyn.ts', dir);
    const before = fs.readFileSync(aggregatedUrl, 'utf8');
    const after = before
      .replace(/^import \{ waitUntil\w+ \} from "\.\/waiters\/\w+";\n/gm, '')
      .replace(/^const waiters = \{\n(?:  waitUntil\w+,\n)+\};\n/m, '')
      .replace(/\n  \/\*\*\n   \* @see \{@link \w+Command\}\n   \* @param args - command input\.\n   \* @param waiterConfig[^\n]*\n   \*\/\n  waitUntil\w+\([\s\S]*?\): Promise<WaiterResult<\w+>>;\n/g, '\n')
      .replace('{ paginators, waiters }', '{ paginators }')
      .replace('import { type WaiterResult, createAggregatedClient } from "@smithy/core/client";', 'import { createAggregatedClient } from "@smithy/core/client";')
      .replace(/^  WaiterConfiguration,\n/m, '');
    if (/[Ww]aiter/.test(after)) throw new Error('postgen-ts: Caitlyn.ts still refers to a waiter after removing smithy-typescript\'s');
    fs.writeFileSync(aggregatedUrl, after);
    console.log('postgen-ts: removed smithy-typescript\'s waiters (src/waiters/, and from index.ts and Caitlyn.ts); the facade has waitUntil…()');
  }
}

// The generated error classes reset their prototype with a reference to themselves
// (Object.setPrototypeOf(this, NotFoundError.prototype)). A bundler then has to rename the class (`var
// NotFoundError = class _NotFoundError`), and constructor.name becomes "_NotFoundError". new.target.prototype does
// the same job without the self-reference, so the class keeps its name.
for (const file of ['models/errors.ts', 'models/CaitlynServiceException.ts']) {
  const url = new URL(file, dir);
  const before = fs.readFileSync(url, 'utf8');
  const selfReference = /Object\.setPrototypeOf\(this, (\w+)\.prototype\);/g;
  const n = (before.match(selfReference) ?? []).length;
  if (n === 0) throw new Error(`postgen-ts: no prototype self-reference in ${file}`);
  fs.writeFileSync(url, before.replace(selfReference, 'Object.setPrototypeOf(this, new.target.prototype);'));
  console.log(`postgen-ts: ${file}: ${n} prototype resets use new.target`);
}

// The version is set once, in packages/sdk-core/package.json. The generated User-Agent version
// (caitlyn-sdk-ts/<version>) follows it, and the tracer version in sdk-core's telemetry must match it.
const sharedUrl = new URL('runtimeConfig.shared.ts', dir);
const shared = fs.readFileSync(sharedUrl, 'utf8');
const sdkVersion = /caitlynSdkVersion: config\?\.caitlynSdkVersion \?\? "[^"]*"/g;
if ((shared.match(sdkVersion) ?? []).length !== 1) throw new Error('postgen-ts: expected exactly one caitlynSdkVersion default in runtimeConfig.shared.ts');
fs.writeFileSync(sharedUrl, shared.replace(sdkVersion, `caitlynSdkVersion: config?.caitlynSdkVersion ?? ${JSON.stringify(corePkg.version)}`));
const telemetry = fs.readFileSync(new URL('packages/sdk-core/src/telemetry.ts', tsRoot), 'utf8');
if (!telemetry.includes(`getTracer('@caitlyn-ai/sdk', '${corePkg.version}')`))
  throw new Error(`postgen-ts: typescript/packages/sdk-core/src/telemetry.ts names a tracer version other than ${corePkg.version}`);
console.log(`postgen-ts: the User-Agent and tracer version is ${corePkg.version}`);

// smithy-typescript splits the model's structures across models_0.ts, models_1.ts, … once one file grows past its
// limit. The facade (src/sdk) imports them all from one place, models/models.ts, written here from the files there are.
{
  const files = fs.readdirSync(new URL('models/', dir)).filter((f) => /^models_\d+\.ts$/.test(f)).sort((a, b) => Number(a.match(/\d+/)[0]) - Number(b.match(/\d+/)[0]));
  if (!files.includes('models_0.ts')) throw new Error('postgen-ts: no models/models_0.ts');
  const body = files.map((f) => `export type * from "./${f.replace(/\.ts$/, '')}";\n`).join('');
  fs.writeFileSync(new URL('models/models.ts', dir), `// Written by scripts/postgen-ts.mjs: every structure smithy-typescript generated, from each of its models files.\n${body}`);
  console.log(`postgen-ts: models/models.ts re-exports ${files.length} models file(s)`);
}
