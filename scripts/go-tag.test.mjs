// Tests for scripts/go-tag.mjs against a stand-in for GitLab's tags and files API. scripts/test-go.sh runs it:
//   node --test scripts/go-tag.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFile } from 'node:child_process';
import path from 'node:path';

const script = path.join(import.meta.dirname, 'go-tag.mjs');
const MOVED = 'module github.com/caitlyn-ai/sdk/go\n\ngo 1.23.0\n';
const OLD = 'module github.com/caitlyn-ai/caitlyn-go\n\ngo 1.23.0\n';

// tags: name → commit; files: commit → go/go.mod. Records the tags created.
async function gitlab(tags, files) {
  const created = [];
  const server = http.createServer((req, res) => {
    if (req.headers['private-token'] !== 'token') return res.writeHead(401).end();
    const url = new URL(req.url, 'http://x');
    const file = url.pathname.match(/^\/api\/v4\/projects\/857\/repository\/files\/go%2Fgo\.mod\/raw$/);
    if (file && req.method === 'GET') {
      const body = files[url.searchParams.get('ref')];
      return body === undefined ? res.writeHead(404).end('{}') : res.writeHead(200).end(body);
    }
    const tag = url.pathname.match(/^\/api\/v4\/projects\/857\/repository\/tags(?:\/(.+))?$/);
    if (!tag) return res.writeHead(404).end('{}');
    if (req.method === 'GET') {
      const name = decodeURIComponent(tag[1]);
      return tags[name]
        ? res.writeHead(200).end(JSON.stringify({ name, commit: { id: tags[name] } }))
        : res.writeHead(404).end('{}');
    }
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const { tag_name, ref } = JSON.parse(body);
      created.push({ tag_name, ref });
      tags[tag_name] = ref;
      res.writeHead(201).end('{}');
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, created, url: `http://127.0.0.1:${server.address().port}/api/v4` };
}

function run(api, version, token = 'token') {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [script, version],
      { env: { PATH: process.env.PATH, GITLAB_TOKEN: token, CI_API_V4_URL: api, CI_PROJECT_ID: '857' } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, out: stdout + stderr }),
    );
  });
}

test('tags go/vX.Y.Z on the release commit when go/go.mod declares the module', async (t) => {
  const g = await gitlab({ 'v0.9.0': 'c9' }, { c9: MOVED });
  t.after(() => g.server.close());
  const r = await run(g.url, '0.9.0');
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(g.created, [{ tag_name: 'go/v0.9.0', ref: 'c9' }]);
});

test('refuses a release whose go/go.mod declares another module (v0.8.0 and earlier)', async (t) => {
  const g = await gitlab({ 'v0.8.0': 'c8' }, { c8: OLD });
  t.after(() => g.server.close());
  const r = await run(g.url, 'v0.8.0');
  assert.equal(r.code, 1);
  assert.match(r.out, /declares module github\.com\/caitlyn-ai\/caitlyn-go/);
  assert.deepEqual(g.created, []);
});

test('refuses a release without go/go.mod', async (t) => {
  const g = await gitlab({ 'v0.9.0': 'c9' }, {});
  t.after(() => g.server.close());
  const r = await run(g.url, '0.9.0');
  assert.equal(r.code, 1);
  assert.deepEqual(g.created, []);
});

test('leaves a Go tag already on the release commit alone', async (t) => {
  const g = await gitlab({ 'v0.9.0': 'c9', 'go/v0.9.0': 'c9' }, { c9: MOVED });
  t.after(() => g.server.close());
  const r = await run(g.url, '0.9.0');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /already on c9/);
  assert.deepEqual(g.created, []);
});

test('fails when the Go tag is on another commit', async (t) => {
  const g = await gitlab({ 'v0.9.0': 'c9', 'go/v0.9.0': 'other' }, { c9: MOVED });
  t.after(() => g.server.close());
  const r = await run(g.url, '0.9.0');
  assert.equal(r.code, 1);
  assert.deepEqual(g.created, []);
});

test('fails when there is no release tag', async (t) => {
  const g = await gitlab({}, {});
  t.after(() => g.server.close());
  assert.equal((await run(g.url, '0.9.0')).code, 1);
});

test('rejects a malformed version and a missing token without calling GitLab', async (t) => {
  const g = await gitlab({ 'v0.9.0': 'c9' }, { c9: MOVED });
  t.after(() => g.server.close());
  assert.equal((await run(g.url, 'latest')).code, 2);
  assert.equal((await run(g.url, '0.9.0', '')).code, 2);
  assert.deepEqual(g.created, []);
});
