// Checks the npm packages as a user receives them: packs @caitlyn-ai/sdk-core and @caitlyn-ai/sdk, installs the
// tarballs in an empty project, then
//   1. imports the SDK from Node as an ECMAScript module and from CommonJS;
//   2. type-checks an ESM and a CommonJS file with module "nodenext", and one with moduleResolution "bundler", all
//      with skipLibCheck false; then, in a second empty project with no @types/node, a browser-only file (lib dom);
//   3. checks no @aws-sdk package was installed;
//   4. checks error classes keep their names: constructor.name in the built ESM and CommonJS output and in an
//      application's unminified browser bundle, err.name in a minified one;
//   5. bundles realistic imports for a browser, as an application bundler would, and checks each against its budget.
// Run after scripts/build-packages.mjs. Writes build/package/report.json.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

// Size budgets, per realistic import, for what a web app ships: each entry below is bundled for a browser the way
// an application bundler does it (ESM, minified, tree-shaken, code splitting on), and the budget applies to what
// loads up front, the entry chunk plus the chunks it imports statically, gzipped. Code behind a dynamic import
// (the AWS signer of the awsIam mode) is reported as lazy and is not counted. Budgets are in bytes; set from the
// sizes measured on 11 November 2026 plus a margin, so growth is a decision rather than an accident.
const ENTRIES = {
  'client + one operation': {
    budget: 44_500,
    code: `import { createCaitlynClient, getAgentVersion } from '@caitlyn-ai/sdk';
export const run = (token) => getAgentVersion(createCaitlynClient({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token } }), { agentId: 'A', version: 'draft' });`,
  },
  'client + one operation + oauth sign-in': {
    budget: 44_500,
    code: `import { createAuth, createCaitlynClient, getAgentVersion } from '@caitlyn-ai/sdk';
const options = { workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'oauth', clientId: 'app', redirectUri: location.origin + '/callback' } };
const auth = createAuth(options);
const client = createCaitlynClient(options, auth);
export const signIn = () => auth.authorizationUrl();
export const finish = (p) => auth.handleCallback(p);
export const run = () => getAgentVersion(client, { agentId: 'A', version: 'draft' });`,
  },
  'client + streaming chat': {
    budget: 45_500,
    code: `import { createCaitlynClient, sendMessage } from '@caitlyn-ai/sdk';
const client = createCaitlynClient({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'session' } });
export const ask = async (id, message, onText) => { for await (const e of sendMessage(client, id, { message })) if (e.type === 'text.delta') onText(e.delta); };`,
  },
  'Caitlyn class (every operation)': {
    budget: 46_000, // grows with every operation the model gains: raise it with the model change that needs it
    code: `import { Caitlyn } from '@caitlyn-ai/sdk';
export const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: 't' } });`,
  },
};

const root = path.resolve(import.meta.dirname, '..');
const work = path.resolve(root, '../build/package');
fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
const run = (cmd, args, cwd = work) => execFileSync(cmd, args, { cwd, stdio: ['ignore', 'pipe', 'inherit'] }).toString();

const tarballs = ['sdk-core', 'sdk'].map((p) => path.join(work, run('npm', ['pack', '--silent', '--pack-destination', work], path.join(root, 'packages', p)).trim().split('\n').pop()));
fs.writeFileSync(path.join(work, 'package.json'), JSON.stringify({ name: 'caitlyn-package-check', private: true }));
run('npm', ['install', '--no-audit', '--no-fund', '--silent', ...tarballs, `typescript@${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'))).version}`, '@types/node@24']);

// 1. Runtime imports
fs.writeFileSync(path.join(work, 'esm.mjs'), `import { Caitlyn, NotFoundError, CaitlynError } from '@caitlyn-ai/sdk';
const c = new Caitlyn({ workspace: 'example.getcaitlyn.ai', auth: { mode: 'token', token: 't' } });
if (typeof c.documents.list !== 'function' || !(new NotFoundError({ $metadata: {}, message: 'x' }) instanceof CaitlynError)) process.exit(1);
if (new NotFoundError({ $metadata: {}, message: 'x' }).constructor.name !== 'NotFoundError') { console.error('esm: NotFoundError is named', new NotFoundError({ $metadata: {}, message: 'x' }).constructor.name); process.exit(1); }
console.log('esm ok');`);
fs.writeFileSync(path.join(work, 'cjs.cjs'), `const { Caitlyn, createCaitlynClient, ConflictError } = require('@caitlyn-ai/sdk');
if (new ConflictError({ $metadata: {}, message: 'x' }).constructor.name !== 'ConflictError') process.exit(1);
const c = new Caitlyn({ workspace: 'example.getcaitlyn.ai', auth: { mode: 'clientCredentials', clientId: 'a', clientSecret: 'b' } });
if (typeof c.auth.token !== 'function' || typeof createCaitlynClient !== 'function') process.exit(1);
console.log('cjs ok');`);
process.stdout.write(run('node', ['esm.mjs']) + run('node', ['cjs.cjs']));

// 2. Types
const typed = `import { Caitlyn, ValidationError, type ConversationEvent } from '@caitlyn-ai/sdk';
const c = new Caitlyn({ workspace: 'w', auth: { mode: 'workloadIdentity', token: () => 'jwt' } });
export async function f(): Promise<string | undefined> {
  for await (const e of c.conversations.send('C1', { message: 'hi' })) { const x: ConversationEvent = e; void x; }
  try {
    const v = await c.versions.get({ agentId: 'A', version: 'draft' });
    const status: number | undefined = v.$metadata.httpStatusCode; // a single call's output carries its response metadata
    const requestId: string | undefined = v.$metadata.requestId;
    void [status, requestId, v.raw];
  } catch (e) { if (e instanceof ValidationError) return e.code; }
  return undefined;
}
`;
fs.writeFileSync(path.join(work, 'typed.mts'), typed);
fs.writeFileSync(path.join(work, 'typed.cts'), typed);
fs.writeFileSync(path.join(work, 'bundler.ts'), typed);
const tsc = path.join(work, 'node_modules/.bin/tsc');
const tscBase = ['--noEmit', '--strict', '--skipLibCheck', 'false', '--target', 'es2022', '--types', 'node'];
run(tsc, [...tscBase, '--module', 'nodenext', '--moduleResolution', 'nodenext', 'typed.mts', 'typed.cts']);
run(tsc, [...tscBase, '--module', 'esnext', '--moduleResolution', 'bundler', '--lib', 'es2022,dom', 'bundler.ts']);
// A browser-only project: its own install with no @types/node, lib dom, skipLibCheck false.
const browserDir = path.join(work, 'browser');
fs.mkdirSync(browserDir);
fs.writeFileSync(path.join(browserDir, 'package.json'), JSON.stringify({ name: 'caitlyn-browser-check', private: true, type: 'module' }));
run('npm', ['install', '--no-audit', '--no-fund', '--silent', ...tarballs, `typescript@${JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'))).version}`], browserDir);
if (fs.existsSync(path.join(browserDir, 'node_modules/@types/node'))) throw new Error('the browser check installed @types/node');
fs.writeFileSync(path.join(browserDir, 'app.ts'), typed);
fs.writeFileSync(path.join(browserDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { noEmit: true, strict: true, skipLibCheck: false, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', lib: ['es2022', 'dom', 'dom.iterable'], types: [] }, files: ['app.ts'] }));
run(path.join(browserDir, 'node_modules/.bin/tsc'), ['-p', 'tsconfig.json'], browserDir);
console.log('types ok (nodenext ESM and CommonJS, bundler, and a browser-only project without @types/node)');

// 3. No AWS runtime
if (fs.existsSync(path.join(work, 'node_modules/@aws-sdk'))) throw new Error('an @aws-sdk package was installed');
console.log('no @aws-sdk packages installed');

// 4. Class names after an application bundles the browser build. Unminified, constructor.name is the class name;
// minified, a minifier renames classes in any library, and err.name (an instance property) stays right.
const namesFile = path.join(work, 'names.mjs');
fs.writeFileSync(namesFile, `import { NotFoundError, ValidationError, CaitlynError } from '@caitlyn-ai/sdk';
const errors = [NotFoundError, ValidationError, CaitlynError].map((C) => new C({ $metadata: {}, message: 'x' }));
const check = (what, got, want) => { if (got.join() !== want) throw new Error(what + ': ' + got.join()); };
check('err.name', errors.slice(0, 2).map((e) => e.name), 'NotFoundError,ValidationError'); // the generic error's name is its code
if (process.env.EXPECT_CONSTRUCTOR_NAMES) check('constructor.name', errors.map((e) => e.constructor.name), 'NotFoundError,ValidationError,CaitlynServiceException');`);
for (const minify of [false, true]) {
  await build({ entryPoints: [namesFile], bundle: true, minify, format: 'esm', platform: 'browser', outfile: path.join(work, 'names-out.mjs'), logLevel: 'error', absWorkingDir: work });
  execFileSync('node', ['names-out.mjs'], { cwd: work, stdio: 'inherit', env: { ...process.env, EXPECT_CONSTRUCTOR_NAMES: minify ? '' : '1' } });
}
console.log('error class names survive bundling (constructor.name unminified, err.name minified)');

// 5. Size
const sizes = {};
for (const [name, { code, budget }] of Object.entries(ENTRIES)) {
  const file = path.join(work, `size-${Object.keys(sizes).length}.mjs`);
  fs.writeFileSync(file, code);
  const out = await build({ entryPoints: [file], bundle: true, minify: true, splitting: true, format: 'esm', platform: 'browser', outdir: path.join(work, 'size-out', String(Object.keys(sizes).length)), write: false, metafile: true, logLevel: 'error', absWorkingDir: work });
  const files = new Map(out.outputFiles.map((f) => [path.relative(work, f.path), f.contents]));
  const outputs = out.metafile.outputs;
  const entry = Object.keys(outputs).find((k) => outputs[k].entryPoint && !k.endsWith('.map'));
  const upFront = new Set();
  const walk = (k) => {
    if (upFront.has(k)) return;
    upFront.add(k);
    for (const i of outputs[k].imports) if (i.kind === 'import-statement' && !i.external) walk(i.path);
  };
  walk(entry);
  const join = (keys) => Buffer.concat(keys.map((k) => Buffer.from(files.get(k))));
  const now = join([...upFront]);
  const lazy = join(Object.keys(outputs).filter((k) => !upFront.has(k) && !k.endsWith('.map')));
  sizes[name] = { minified: now.length, gzip: gzipSync(now, { level: 9 }).length, budget, lazyGzip: lazy.length ? gzipSync(lazy, { level: 9 }).length : 0 };
}
console.table(sizes);
fs.writeFileSync(path.join(work, 'report.json'), JSON.stringify({ sizes }, null, 2));
const over = Object.entries(sizes).filter(([, s]) => s.gzip > s.budget);
if (over.length) throw new Error(`over the size budget: ${over.map(([n, s]) => `${n} ${s.gzip} B > ${s.budget} B`).join(', ')}`);
console.log('package check passed');
