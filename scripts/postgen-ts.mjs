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
// repository builds and tests the SDK from typescript/package.json (an npm workspace), so they are dropped
// here; packaging for npm (entry points, dual builds) is lane K1's.
const pkgUrl = new URL('../typescript/packages/sdk/package.json', import.meta.url);
const pkg = JSON.parse(fs.readFileSync(pkgUrl, 'utf8'));
delete pkg.scripts;
delete pkg.devDependencies;
pkg.private = true;
fs.writeFileSync(pkgUrl, JSON.stringify(pkg, null, 4) + '\n');
console.log('postgen-ts: removed the generated yarn scripts and devDependencies from packages/sdk/package.json');
