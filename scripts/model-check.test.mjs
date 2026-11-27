// The model-version check (scripts/model-check.mjs): which snapshots the SDKs may be released from. Run: node --test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classify } from './model-check.mjs';

const latest = { sha256: 'b'.repeat(64), version: '5.157.0' };
const prerelease = (stampNext) => ({ version: null, sha256: 'c'.repeat(64), stampNext, prerelease: { appVersion: '5.157.0', appCommit: 'abc123' } });

test('the latest published model passes', () => {
  assert.equal(classify({ version: '5.157.0', sha256: latest.sha256, stampNext: null }, latest).case, 'latest');
});

test('a model:main pre-release ahead of the latest release passes', () => {
  const r = classify(prerelease('5.158.0'), latest);
  assert.deepEqual([r.ok, r.case], [true, 'ahead']);
});

test('nothing published yet passes', () => {
  assert.equal(classify({ version: null, stampNext: '5.115.0' }, null).ok, true);
});

test('behind: a published model that is not the latest fails, naming both', () => {
  const r = classify({ version: '5.156.0', sha256: 'a'.repeat(64), stampNext: null }, latest);
  assert.deepEqual([r.ok, r.case], [false, 'behind']);
  assert.match(r.message, /^Behind: .*5\.156\.0.*5\.157\.0/);
});

test('hand-pulled: an unpublished build with no prerelease record fails', () => {
  const r = classify({ version: null, sha256: 'd'.repeat(64), stampNext: '5.115.0', source: 'local build of branch v3 at commit 1234567 (not published)' }, latest);
  assert.deepEqual([r.ok, r.case], [false, 'hand-pulled']);
  assert.match(r.message, /^Hand-pulled: .*local build of branch v3/);
});

test('stale pre-release: a model:main pre-release not later than the latest release fails', () => {
  for (const stamp of ['5.157.0', '5.150.0', '5.99.0', null]) {
    const r = classify(prerelease(stamp), latest);
    assert.deepEqual([r.ok, r.case], [false, 'stale'], String(stamp));
    assert.match(r.message, /^Stale pre-release: .*5\.157\.0/);
  }
  // 5.160.0 is later than 5.157.0, though "5.16" sorts before "5.157" as text
  assert.equal(classify(prerelease('5.160.0'), latest).case, 'ahead');
});

test('the command warns (exit 2) in a merge request and fails (exit 1) with --strict', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-check-'));
  const model = path.join(dir, 'model.json');
  fs.writeFileSync(model, '{"shapes":{}}');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(model)).digest('hex');
  const lock = path.join(dir, 'lock.json');
  const run = (lockBody, ...extra) => {
    fs.writeFileSync(lock, JSON.stringify(lockBody));
    try {
      execFileSync(process.execPath, [path.join(import.meta.dirname, 'model-check.mjs'), lock, model, '5.157.0\n', ...extra], { stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run({ version: '5.157.0', sha256 }), 0);
  assert.equal(run({ version: '5.156.0', sha256: 'a'.repeat(64) }), 2);
  assert.equal(run({ version: '5.156.0', sha256: 'a'.repeat(64) }, '--strict'), 1);
  assert.equal(run(prerelease('5.158.0'), '--strict'), 0);
  assert.equal(run(prerelease('5.157.0'), '--strict'), 1);
});
