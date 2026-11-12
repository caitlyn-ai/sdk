// Deterministic post-generation edit for the TypeScript client (run by scripts/generate.sh).
// smithy-typescript's runtimeConfig templates always resolve a "defaults mode", which reads AWS_DEFAULTS_MODE
// and ~/.aws/config and, in "auto" mode, can query the EC2 instance metadata service. The integration already
// replaces every consumer (requestHandler, retryMode); this removes the dead lines and their imports.
// Every edit must match exactly once, or the script fails: a generator upgrade that changes the template is caught.
import fs from 'node:fs';
const dir = new URL('../typescript/packages/sdk/src/', import.meta.url);
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

// The generated package.json carries smithy-typescript's yarn build scripts and their devDependencies. The
// repository builds and tests the SDK from typescript/package.json (an npm workspace), so they are dropped, and
// the package is described for npm: entry points for Node (ESM and CommonJS), for edge runtimes (fetch), for
// browser pages (the browser build, also as the explicit `@caitlyn-ai/sdk/browser`), types, and the files
// typescript/scripts/build-packages.mjs writes. The edge conditions come before `browser`, so a bundler that sets
// both (Cloudflare's, or webpack for a web worker) takes the edge build, which has every sign-in mode.
const pkgUrl = new URL('../typescript/packages/sdk/package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));
const corePkg = JSON.parse(fs.readFileSync(new URL('../typescript/packages/sdk-core/package.json', import.meta.url), 'utf8'));
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
  dependencies: { ...pkg.dependencies, '@caitlyn-ai/sdk-core': corePkg.version },
  publishConfig: corePkg.publishConfig,
};
fs.writeFileSync(pkgUrl, JSON.stringify(published, null, 4) + '\n');
console.log('postgen-ts: wrote the npm description of packages/sdk/package.json');

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
const telemetry = fs.readFileSync(new URL('../typescript/packages/sdk-core/src/telemetry.ts', import.meta.url), 'utf8');
if (!telemetry.includes(`getTracer('@caitlyn-ai/sdk', '${corePkg.version}')`))
  throw new Error(`postgen-ts: typescript/packages/sdk-core/src/telemetry.ts names a tracer version other than ${corePkg.version}`);
console.log(`postgen-ts: the User-Agent and tracer version is ${corePkg.version}`);
