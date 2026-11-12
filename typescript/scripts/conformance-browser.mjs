// Runs the TypeScript conformance harness (conformance/typescript/conformance.test.ts) against the browser build, in
// real headless browsers, with Playwright:
//   1. starts the mock server with MOCK_CORS=1, on its own port;
//   2. bundles the harness for a browser page: the SDK compiled exactly as dist-browser is (scripts/browser-plugins.mjs),
//      node:test and node:assert replaced by conformance/typescript/browser, the repository files it reads embedded;
//   3. serves the page from a second port, so every SDK call is cross-origin, as a web app's is, with CORS preflights;
//   4. runs every case (or those whose name contains ONLY) in each browser (BROWSERS, default chromium,firefox,webkit)
//      and writes
//      build/conformance/typescript-browser-<browser>.xml (JUnit);
//   5. fails unless every protocol and example case passed, or was skipped for the reason the harness gives
//      (NOT_IN_A_PAGE: no environment variables or files in a page, and no Cookie or Origin header).
// Needs Playwright's browsers: `npx playwright install chromium firefox webkit`, or the Playwright image in CI.
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import { browserFromSource } from './browser-plugins.mjs';

const root = path.resolve(import.meta.dirname, '..');
const repo = path.resolve(root, '..');
const shims = path.join(repo, 'conformance/typescript/browser');
const out = path.join(repo, 'build/browser-conformance');
const reports = path.join(repo, 'build/conformance');
const engines = { chromium, firefox, webkit };
const wanted = (process.env.BROWSERS ?? 'chromium,firefox,webkit').split(',').map((b) => b.trim()).filter(Boolean);
fs.mkdirSync(out, { recursive: true });
fs.mkdirSync(reports, { recursive: true });

const freePort = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// 1. The mock server
const mockPort = await freePort();
const mock = spawn(process.execPath, [path.join(repo, 'conformance/mock-server/server.mjs')], { env: { ...process.env, PORT: String(mockPort), MOCK_CORS: '1' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((resolve) => mock.stdout.on('data', (d) => String(d).includes('listening') && resolve()));
process.on('exit', () => mock.kill());
const refusedPort = await freePort();

// 2. The harness, for a page
const mockAuth = await import(path.join(repo, 'conformance/mock-server/auth.mjs'));
const constants = Object.fromEntries(Object.entries(mockAuth).filter(([, v]) => typeof v !== 'function'));
const files = Object.fromEntries(['conformance/cases/examples.json', 'VERSION', 'model/model.lock.json'].map((f) => [f, fs.readFileSync(path.join(repo, f), 'utf8')]));
const env = {
  CAITLYN_REPO_ROOT: '/repo',
  CAITLYN_SDK_BUILD: 'browser',
  CAITLYN_MOCK_PORT: String(mockPort),
  CAITLYN_REFUSED_ENDPOINT: `http://127.0.0.1:${refusedPort}`,
};
const virtual = {
  'node:test': { path: path.join(shims, 'node-test.ts') },
  'node:assert/strict': { path: path.join(shims, 'assert.ts') },
  'node:fs': { contents: `import { fs } from ${JSON.stringify(path.join(shims, 'node-stubs.ts'))}; export default fs;` },
  'node:path': { contents: `import { path } from ${JSON.stringify(path.join(shims, 'node-stubs.ts'))}; export default path;` },
  'node:os': { contents: `import { os } from ${JSON.stringify(path.join(shims, 'node-stubs.ts'))}; export default os;` },
  'node:net': { contents: `import { net } from ${JSON.stringify(path.join(shims, 'node-stubs.ts'))}; export default net;` },
  'node:child_process': { contents: `export { spawn } from ${JSON.stringify(path.join(shims, 'node-stubs.ts'))};` },
  'caitlyn:files': { contents: `export default ${JSON.stringify(files)};` },
  // The mock's sign-in constants. mockOidcToken signs with Node's crypto; only cases the browser build refuses use it.
  'mock-auth': { contents: `${Object.entries(constants).map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`).join('\n')}\nexport const mockOidcToken = () => 'not-a-jwt';` },
};
const pageShims = {
  name: 'page-shims',
  setup(b) {
    b.onResolve({ filter: /^(node:(test|assert\/strict|fs|path|os|net|child_process)|caitlyn:files)$/ }, (a) => ({ path: a.path, namespace: 'virtual' }));
    b.onResolve({ filter: /mock-server\/auth\.mjs$/ }, () => ({ path: 'mock-auth', namespace: 'virtual' }));
    b.onLoad({ filter: /.*/, namespace: 'virtual' }, (a) => {
      const v = virtual[a.path];
      return v.path ? { contents: fs.readFileSync(v.path, 'utf8'), loader: 'ts', resolveDir: shims } : { contents: v.contents, loader: 'ts', resolveDir: shims };
    });
  },
};
await build({
  entryPoints: { harness: path.join(repo, 'conformance/typescript/conformance.test.ts') },
  outdir: out,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  sourcemap: 'inline',
  logLevel: 'warning',
  alias: {
    '@caitlyn-ai/sdk/commands': path.join(root, 'packages/sdk/src/commands/index.ts'),
    '@caitlyn-ai/sdk': path.join(root, 'packages/sdk/src/sdk/index.ts'),
    '@caitlyn-ai/sdk-core': path.join(root, 'packages/sdk-core/src/index.ts'),
  },
  plugins: [pageShims, browserFromSource],
  nodePaths: [path.join(root, 'node_modules')], // the harness is outside this workspace
  // The harness reads process.env; a page has no process, so this one is the harness's own (module scope).
  banner: { js: `const process = { env: ${JSON.stringify(env)}, execPath: '' };` },
});
fs.writeFileSync(path.join(out, 'index.html'), '<!doctype html><meta charset="utf-8"><title>Caitlyn SDK conformance</title><script type="module" src="./harness.js"></script>');

// 3. The page, on another origin than the mock server
const types = { '.html': 'text/html', '.js': 'text/javascript' };
const page = http.createServer((req, res) => {
  const file = path.join(out, new URL(req.url, 'http://x').pathname.replace(/^\/$/, '/index.html'));
  if (!file.startsWith(out) || !fs.existsSync(file)) return res.writeHead(404).end();
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] ?? 'application/octet-stream' }).end(fs.readFileSync(file));
});
const pagePort = await freePort();
await new Promise((resolve) => page.listen(pagePort, '127.0.0.1', resolve));

// 4. Each browser
const protocol = JSON.parse(fs.readFileSync(path.join(repo, 'conformance/cases/protocol.json'), 'utf8')).cases.map((c) => c.id);
const examples = JSON.parse(fs.readFileSync(path.join(repo, 'conformance/cases/examples.json'), 'utf8')).cases.map((c) => c.id);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
let failed = false;
const rows = [];
try {
  for (const name of wanted) {
    const engine = engines[name];
    if (!engine) throw new Error(`Unknown browser ${name}`);
    let browser;
    try {
      browser = await engine.launch();
    } catch (err) {
      console.error(`${name}: did not start: ${String(err).split('\n')[0]}`);
      failed = true;
      rows.push([name, '-', '-', 'did not start']);
      continue;
    }
    const results = await (async () => {
      try {
        const tab = await browser.newPage();
        const errors = [];
        tab.on('pageerror', (e) => errors.push(e));
        if (process.env.VERBOSE) tab.on('console', (m) => console.log(`${name}: ${m.text()}`));
        await tab.goto(`http://127.0.0.1:${pagePort}/`);
        await tab.waitForFunction(() => globalThis.__caitlynConformance, null, { timeout: 30_000 }).catch(() => {
          throw new Error(`${name}: the harness did not load: ${errors.map(String).join('; ')}`);
        });
        return await tab.evaluate((only) => globalThis.__caitlynConformance.run(only), process.env.ONLY);
      } finally {
        await browser.close();
      }
    })();
    const version = browser.version();
    const xml = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites><testsuite name="typescript-browser-${name}" tests="${results.length}" failures="${results.filter((r) => r.status === 'failed').length}" skipped="${results.filter((r) => r.status === 'skipped').length}">`,
      ...results.map(
        (r) =>
          `<testcase classname="${name}" name="${esc(r.name)}" time="${(r.ms / 1000).toFixed(3)}">` +
          (r.status === 'failed' ? `<failure message="${esc(r.message?.split('\n')[0])}">${esc(r.message)}</failure>` : r.status === 'skipped' ? `<skipped message="${esc(r.message)}"/>` : '') +
          '</testcase>',
      ),
      '</testsuite></testsuites>',
    ].join('\n');
    fs.writeFileSync(path.join(reports, `typescript-browser-${name}.xml`), xml);

    // 5. Every case ran, and passed or was skipped for a stated reason
    const find = (n) => results.find((r) => r.name === n || r.name.startsWith(`${n} `));
    const problems = [];
    let skipped = 0;
    for (const n of [...protocol.map((id) => `[${id}]`), ...examples.map((id) => `[example] ${id}`)]) {
      const r = find(n);
      if (!r) problems.push(`missing: ${n}`);
      else if (r.status === 'failed') problems.push(`failed: ${r.name}\n    ${r.message?.split('\n').slice(0, 3).join('\n    ')}`);
      else if (r.status === 'skipped') skipped++;
    }
    for (const r of results.filter((x) => x.status === 'failed' && !problems.some((p) => p.includes(x.name)))) problems.push(`failed: ${r.name}\n    ${r.message?.split('\n')[0]}`);
    for (const p of problems) console.error(`${name}: ${p}`);
    if (problems.length) failed = true;
    rows.push([`${name} ${version}`, `${results.filter((r) => r.status === 'passed').length}`, `${skipped}`, `${problems.length}`]);
    for (const r of results.filter((x) => x.status === 'skipped')) console.log(`${name}: skipped ${r.name}: ${r.message}`);
  }
} finally {
  mock.kill();
  page.close();
}
const header = ['browser', 'passed', 'skipped (not in a page)', 'problems'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [header, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
process.exit(failed ? 1 : 0);
