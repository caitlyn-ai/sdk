// Which published changes.json a model pull keeps (scripts/model-changes.mjs), and scripts/model-pull.sh itself run
// against a stand-in for the app's package registry, in a copy of the repository's layout so the real model/ is
// never touched. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { compareVersions, versionsToKeep } from '../../../scripts/model-changes.mjs';

const scripts = new URL('../../../scripts/', import.meta.url).pathname;
const listing = (...versions) => versions.map((version) => ({ name: 'caitlyn-v3-model', version }));

test('release numbers compare as numbers', () => {
  assert.ok(compareVersions('5.9.0', '5.10.0') < 0);
  assert.equal(compareVersions('5.10.0', '5.10.0'), 0);
});

test('a pull keeps every published version after the previous lock, up to and including the new one', () => {
  const published = [...listing('5.110.0', '5.112.0', '5.113.0', '5.114.0', '5.115.0', '5.116.0', 'latest'), { name: 'another-package', version: '5.114.5' }];
  assert.deepEqual(versionsToKeep(published, { previous: '5.112.0', next: '5.115.0' }), ['5.113.0', '5.114.0', '5.115.0']);
  // Numbered, not by text: 5.10.0 comes after 5.9.0
  assert.deepEqual(versionsToKeep(listing('5.9.0', '5.10.0', '5.11.0'), { previous: '5.9.0', next: '5.11.0' }), ['5.10.0', '5.11.0']);
});

test('after a local build, the newest version already kept is the lower bound; with neither, only the new version', () => {
  const published = listing('5.112.0', '5.113.0', '5.114.0', '5.115.0');
  assert.deepEqual(versionsToKeep(published, { previous: null, kept: ['5.110.0', '5.113.0'], next: '5.115.0' }), ['5.114.0', '5.115.0']);
  assert.deepEqual(versionsToKeep(published, { previous: null, kept: [], next: '5.115.0' }), ['5.115.0']);
});

test('the new version is kept even when the listing does not show it yet, and a re-pull keeps just it', () => {
  assert.deepEqual(versionsToKeep(listing('5.112.0'), { previous: '5.112.0', next: '5.113.0' }), ['5.113.0']);
  assert.deepEqual(versionsToKeep(listing('5.112.0', '5.113.0'), { previous: '5.113.0', next: '5.113.0' }), ['5.113.0']);
  assert.throws(() => versionsToKeep([], { next: 'latest' }), /not a release number/);
});

// ------------------------------------------------------------------------------- model-pull.sh, end to end

/** A copy of the repository's layout: scripts/model-pull.sh, scripts/model-changes.mjs and model/model.lock.json. */
function checkout(lock) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pull-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'model'));
  for (const f of ['model-pull.sh', 'model-changes.mjs']) fs.copyFileSync(path.join(scripts, f), path.join(dir, 'scripts', f));
  fs.chmodSync(path.join(dir, 'scripts/model-pull.sh'), 0o755);
  fs.writeFileSync(path.join(dir, 'model/model.lock.json'), JSON.stringify(lock));
  return dir;
}

/** The app's package registry: a two-page listing, and each version's files (a missing one is a 404). */
async function registry(files) {
  const older = Array.from({ length: 98 }, (_, i) => ({ name: 'caitlyn-v3-model', version: `4.${i}.0` }));
  const pages = [[...older, ...listing('5.112.0', '5.113.0')], listing('5.114.0', '5.114.1', '5.115.0', 'latest')];
  const asked = [];
  const server = http.createServer((req, res) => {
    if (req.headers['private-token'] !== 'token') return res.writeHead(401).end();
    const url = new URL(req.url, 'http://x');
    asked.push(url.pathname);
    if (url.pathname === '/api/v4/projects/653/packages') {
      assert.equal(url.searchParams.get('package_name'), 'caitlyn-v3-model');
      const page = pages[Number(url.searchParams.get('page')) - 1] ?? [];
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(page));
    }
    const file = /^\/api\/v4\/projects\/653\/packages\/generic\/caitlyn-v3-model\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    const body = file && files[`${file[1]}/${file[2]}`];
    if (body === undefined) return res.writeHead(404).end();
    res.writeHead(200).end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}/api/v4`, asked, close: () => server.close() };
}

const run = (dir, args, env) =>
  new Promise((resolve) => {
    execFile(path.join(dir, 'scripts/model-pull.sh'), args, { env: { ...process.env, CI_JOB_TOKEN: '', ...env } }, (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }));
  });

// A release's changes.json, by default with one change; `none` for a release that changed nothing in the public API
const ONE_CHANGE = [{ kind: 'operationAdded', surface: 'ga', operation: 'ListThings', stability: 'ga', title: 'List things' }];
const changes = (version, previousVersion, list = ONE_CHANGE) => JSON.stringify({ model: 'caitlyn-v3-model', version, previousVersion, date: '2026-11-17', changes: list });
const none = [];

test('model-pull.sh keeps the changes.json of each version after the lock that changed the API, notes one published without it or with no changes, and locks the model by its SHA-256', async () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pull-tar-'));
  fs.writeFileSync(path.join(work, 'PROTOCOL.md'), '# Protocol\n');
  execFileSync('tar', ['-czf', path.join(work, 'model.tar.gz'), '-C', work, 'PROTOCOL.md']);
  const model = JSON.stringify({ smithy: '2.0', shapes: {} });
  const reg = await registry({
    '5.115.0/model.json': model,
    '5.115.0/openapi.json': '{}',
    '5.115.0/caitlyn-v3-model.tar.gz': fs.readFileSync(path.join(work, 'model.tar.gz')),
    '5.114.0/changes.json': changes('5.114.0', '5.113.0'),
    // 5.114.1 changed nothing in the public API: no file is kept
    '5.114.1/changes.json': changes('5.114.1', '5.114.0', none),
    '5.115.0/changes.json': changes('5.115.0', '5.114.1'),
    // 5.113.0 was published before changes.json existed: a 404
    '5.112.0/changes.json': changes('5.112.0', '5.111.0'),
  });
  const dir = checkout({ package: 'caitlyn-v3-model', version: '5.112.0', stampNext: null });
  try {
    const { code, stdout, stderr } = await run(dir, ['5.115.0'], { CI_API_V4_URL: reg.url, GITLAB_TOKEN: 'token' });
    assert.equal(code, 0, stderr);
    assert.deepEqual(fs.readdirSync(path.join(dir, 'model/changes')).sort(), ['5.114.0.json', '5.115.0.json']);
    assert.match(stdout, /caitlyn-v3-model\/5\.113\.0 has no changes\.json/);
    assert.match(stdout, /5\.114\.1 changed nothing in the public API, so no file is kept/);
    assert.ok(reg.asked.some((p) => p.endsWith('/packages')) && reg.asked.filter((p) => p.endsWith('/packages')).length === 2, 'both listing pages read');
    assert.ok(!reg.asked.includes('/api/v4/projects/653/packages/generic/caitlyn-v3-model/5.112.0/changes.json'), 'the locked version is not fetched again');
    const lock = JSON.parse(fs.readFileSync(path.join(dir, 'model/model.lock.json'), 'utf8'));
    assert.equal(lock.version, '5.115.0');
    assert.equal(lock.sha256, crypto.createHash('sha256').update(model).digest('hex'));
    assert.equal(fs.readFileSync(path.join(dir, 'model/PROTOCOL.md'), 'utf8'), '# Protocol\n');
  } finally {
    reg.close();
  }
});

test('model-pull.sh --from-build keeps the build\'s changes.json when it has one, and otherwise leaves the kept files alone', async () => {
  const build = fs.mkdtempSync(path.join(os.tmpdir(), 'model-pull-build-'));
  fs.mkdirSync(path.join(build, 'build/smithy/source/model'), { recursive: true });
  fs.mkdirSync(path.join(build, 'build/smithy/openapi/openapi'), { recursive: true });
  fs.writeFileSync(path.join(build, 'build/smithy/source/model/model.json'), JSON.stringify({ smithy: '2.0', shapes: {} }));
  fs.writeFileSync(path.join(build, 'build/smithy/openapi/openapi/Caitlyn.openapi.json'), '{}');
  fs.writeFileSync(path.join(build, 'PROTOCOL.md'), '# Protocol\n');
  const dir = checkout({ package: 'caitlyn-v3-model', version: '5.115.0', stampNext: null });
  fs.mkdirSync(path.join(dir, 'model/changes'));
  fs.writeFileSync(path.join(dir, 'model/changes/5.115.0.json'), changes('5.115.0', '5.114.0'));

  let r = await run(dir, ['--from-build', build], { STAMP_NEXT: '5.116.0' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'model/changes')), ['5.115.0.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'model/model.lock.json'), 'utf8')).version, null);

  fs.writeFileSync(path.join(build, 'build/changes.json'), changes('5.116.0', '5.115.0'));
  r = await run(dir, ['--from-build', build], { STAMP_NEXT: '5.116.0' });
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'model/changes')).sort(), ['5.115.0.json', '5.116.0.json']);
});
