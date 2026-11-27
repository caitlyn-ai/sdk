// Which operations workspaces serve, and since which release, comes from the latest published model (fetched to
// build/published-model.json by scripts/docs-build.sh), not from the snapshot the SDKs are generated from. A stale
// snapshot once said "Not available yet: arrives in Caitlyn 5.115.0" on every operation that 5.149.0 already served.
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { loadModel, publishedModel, servedSince, unreleasedOperations } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';

const S = 'ai.caitlyn.traits#since';
const op = (since) => ({ type: 'operation', traits: since ? { [S]: since } : {} });

test('the published model names the release that first served each operation, and never counts "next"', () => {
  const { since } = servedSince({
    'ai.caitlyn#GetThing': op('5.149.0'),
    'ai.caitlyn#ListThings': op('5.150.0'),
    'ai.caitlyn#WatchThing': op('next'),
    'ai.caitlyn#Untagged': op(null),
    'ai.caitlyn#Thing': { type: 'structure', traits: { [S]: '5.149.0' } },
  });
  assert.deepEqual([...since], [['GetThing', '5.149.0'], ['ListThings', '5.150.0']]);
});

test('an operation the published model serves is available, whatever the snapshot says', () => {
  const published = servedSince({ 'ai.caitlyn#GetThing': op('5.149.0') });
  // A stale pre-release snapshot that still marks it "next": the published model wins
  assert.deepEqual([...unreleasedOperations({ 'ai.caitlyn#GetThing': op('next') }, published)], []);
  // A model:main pre-release snapshot ahead of it: the operation it adds is not served yet, though stamped
  const ahead = { 'ai.caitlyn#GetThing': op('5.149.0'), 'ai.caitlyn#AddThing': op('next') };
  assert.deepEqual([...unreleasedOperations(ahead, published)], ['AddThing']);
  // An operation the published model has only as "next" is not served either
  assert.deepEqual([...unreleasedOperations({ 'ai.caitlyn#WatchThing': op('5.160.0') }, servedSince({ 'ai.caitlyn#WatchThing': op('next') }))], ['WatchThing']);
});

test('without the published model, availability falls back to the snapshot\'s own @since("next")', () => {
  const snapshot = { 'ai.caitlyn#GetThing': op('5.149.0'), 'ai.caitlyn#AddThing': op('next') };
  assert.deepEqual([...unreleasedOperations(snapshot, null)], ['AddThing']);
  const missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'published-')), 'model.json');
  assert.equal(publishedModel(missing), null);
});

test('a page\'s Since row is the release the published model says first served the operation', () => {
  const ast = loadModel({ published: null });
  const name = 'GetKnowledgeBase';
  const id = Object.keys(ast.shapes).find((k) => k.endsWith(`#${name}`));
  const published = servedSince({ [id]: op('5.149.0') });
  const pages = referencePages(loadModel({ published }), { unreleased: new Set(), next: null });
  const page = pages.pages.find((p) => p.operation?.name === name);
  assert.match(page.body, /^\| Since \| Caitlyn 5\.149\.0 \|$/m);
});
