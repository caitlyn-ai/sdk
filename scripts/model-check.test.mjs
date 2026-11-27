// The model-version check (scripts/model-check.mjs): which snapshots the SDKs may be released from. Run: node --test
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { classify, shipped } from './model-check.mjs';

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

test('stale pre-release: a release since the build, with a model the pre-release does not have, fails', () => {
  for (const stamp of ['5.156.0', '5.150.0', '5.99.0', null]) {
    const r = classify(prerelease(stamp), latest);
    assert.deepEqual([r.ok, r.case], [false, 'stale'], String(stamp));
    assert.match(r.message, /^Stale pre-release: .*5\.157\.0/);
  }
  // 5.160.0 is later than 5.157.0, though "5.16" sorts before "5.157" as text
  assert.equal(classify(prerelease('5.160.0'), latest).case, 'ahead');
});

// A model:main snapshot keeps @since("next"); the app's release stamps those shapes with its own number
const op = (since, extra = {}) => ({ type: 'operation', traits: { 'ai.caitlyn.traits#since': since, 'smithy.api#documentation': 'Gets a thing.' }, ...extra });
const thing = (since) => ({ type: 'structure', members: { name: { target: 'smithy.api#String', traits: { 'ai.caitlyn.traits#since': since } } } });
const model = (newSince, more = {}) => ({ smithy: '2.0', shapes: { 'ai.caitlyn#GetOld': op('5.149.0'), 'ai.caitlyn#GetNew': op(newSince), 'ai.caitlyn#Thing': thing(newSince), ...more } });

test('released: the release after a model:main pre-release shipped its model, its "next" stamped with that release', () => {
  // The app's commit is built at 5.156.0, model:main commits it, the app releases it as 5.157.0 minutes later
  const r = classify(prerelease('5.156.0'), { ...latest, model: model('5.157.0') }, model('next'));
  assert.deepEqual([r.ok, r.case], [true, 'released']);
  assert.match(r.message, /5\.157\.0, shipped that model/);
  // Releases since with no model change (several a day) still ship it: the stamps stay 5.157.0
  assert.equal(classify(prerelease('5.156.0'), { sha256: 'e'.repeat(64), version: '5.161.2', model: model('5.157.0') }, model('next')).case, 'released');
  // A model change with no new shapes (a restamp or a fix to the docs) has no "next" at all, and ships just the same
  assert.equal(classify(prerelease('5.156.0'), { ...latest, model: model('5.150.0') }, model('5.150.0')).case, 'released');
});

test('stale: a release since the build that says anything the pre-release does not', () => {
  const later = { ...latest, version: '5.158.0' };
  // An operation the pre-release lacks
  assert.equal(classify(prerelease('5.156.0'), { ...later, model: model('5.157.0', { 'ai.caitlyn#GetMore': op('5.158.0') }) }, model('next')).case, 'stale');
  // A stamp that isn't "next" in the pre-release has to match
  assert.equal(classify(prerelease('5.156.0'), { ...later, model: model('5.157.0', { 'ai.caitlyn#GetOld': op('5.144.0') }) }, model('next')).case, 'stale');
  // Different documentation is a different model
  const docs = model('5.157.0');
  docs.shapes['ai.caitlyn#GetOld'].traits['smithy.api#documentation'] = 'Reads a thing.';
  assert.equal(classify(prerelease('5.156.0'), { ...later, model: docs }, model('next')).case, 'stale');
  // "next" stands for a release number, nothing else
  assert.equal(shipped(model('next'), model('next')), true);
  assert.equal(shipped(model('next'), model('soon')), false);
});

test('ahead: a pre-release built since the latest release passes whatever the release says', () => {
  // model:main's own main pipeline runs before the app has released the change
  const r = classify(prerelease('5.157.0'), { ...latest, model: model('5.150.0') }, model('next', { 'ai.caitlyn#GetMore': op('next') }));
  assert.deepEqual([r.ok, r.case], [true, 'ahead']);
});

test('published snapshots still compare by their bytes: a published model never has "next" to match', () => {
  const r = classify({ version: '5.156.0', sha256: 'a'.repeat(64), stampNext: null }, { ...latest, model: model('5.157.0') }, model('5.157.0'));
  assert.equal(r.case, 'behind');
});

test('the command warns (exit 2) in a merge request and fails (exit 1) with --strict, reading the snapshot beside the lock', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-check-'));
  const published = path.join(dir, 'published.json');
  fs.writeFileSync(published, JSON.stringify(model('5.157.0')));
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(published)).digest('hex');
  const snapshotDir = path.join(dir, 'model');
  fs.mkdirSync(snapshotDir);
  const lock = path.join(snapshotDir, 'model.lock.json');
  const run = (lockBody, snapshot, ...extra) => {
    fs.writeFileSync(lock, JSON.stringify(lockBody));
    fs.writeFileSync(path.join(snapshotDir, 'model.json'), JSON.stringify(snapshot));
    try {
      execFileSync(process.execPath, [path.join(import.meta.dirname, 'model-check.mjs'), lock, published, '5.157.0\n', ...extra], { stdio: 'pipe' });
      return 0;
    } catch (e) {
      return e.status;
    }
  };
  assert.equal(run({ version: '5.157.0', sha256 }, model('5.157.0')), 0);
  assert.equal(run({ version: '5.156.0', sha256: 'a'.repeat(64) }, model('5.156.0')), 2);
  assert.equal(run({ version: '5.156.0', sha256: 'a'.repeat(64) }, model('5.156.0'), '--strict'), 1);
  assert.equal(run(prerelease('5.158.0'), model('next'), '--strict'), 0);
  assert.equal(run(prerelease('5.156.0'), model('next'), '--strict'), 0, 'released: 5.157.0 shipped it');
  assert.equal(run(prerelease('5.156.0'), model('next', { 'ai.caitlyn#GetMore': op('next') }), '--strict'), 1, 'stale: 5.157.0 shipped something else');
});
