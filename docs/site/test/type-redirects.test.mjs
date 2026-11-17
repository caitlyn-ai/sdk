// Every type page that existed before one type per thing (fixtures/type-pages-before-one-type.json) is still a page, or
// redirects to the page of the thing that replaced it (scripts/docs-reference.mjs RENAMED_TYPES, which
// scripts/docs-build.mjs turns into redirects). Every thing has its own type page. Reads the prepared model
// (scripts/docs-build.sh runs prepare-model first). Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { kebab, loadModel } from '../../../scripts/docs-model.mjs';
import { RENAMED_TYPES, referencePages } from '../../../scripts/docs-reference.mjs';

const reference = referencePages(loadModel());
const typePages = new Set(reference.pages.filter((p) => p.group === 'types').map((p) => p.slug.replace(/^reference\/types\//, '')));
const before = JSON.parse(fs.readFileSync(new URL('./fixtures/type-pages-before-one-type.json', import.meta.url), 'utf8')).pages;
const redirects = new Map(Object.entries(RENAMED_TYPES).map(([from, to]) => [kebab(from), kebab(to)]));

test('every removed type page redirects to a type page', () => {
  for (const slug of before) {
    if (typePages.has(slug)) continue;
    assert.ok(redirects.has(slug), `${slug} was a type page and has no redirect`);
    assert.ok(typePages.has(redirects.get(slug)), `${slug} redirects to ${redirects.get(slug)}, which is no type page`);
  }
  for (const [from] of redirects) assert.ok(!typePages.has(from), `${from} redirects but is still a page`);
});

test('every thing has its own type page', () => {
  for (const thing of ['KnowledgeBase', 'Agent', 'AgentVersion', 'IngestionBatch', 'IngestionBatchItem', 'Document', 'DocumentVersion', 'Folder', 'Field', 'Access', 'Conversation', 'HistoryEntry', 'Upload', 'Operation']) {
    assert.ok(typePages.has(kebab(thing)), `${thing} has no type page`);
  }
});

test('every thing an operation returns is linked from its Response section', () => {
  const linked = new Set();
  for (const p of reference.pages.filter((x) => x.operation)) {
    const m = /^Returns: \[(\w+)\]\(\/reference\/types\/([\w-]+)\/\)/m.exec(p.body);
    if (m) {
      assert.ok(typePages.has(m[2]), `${p.operation.name} returns ${m[1]}, which has no page`);
      linked.add(m[1]);
    }
  }
  for (const thing of ['KnowledgeBase', 'Agent', 'AgentVersion', 'IngestionBatch', 'IngestionBatchItem', 'Document', 'DocumentVersion', 'Folder', 'Field', 'Access', 'Conversation', 'HistoryEntry', 'Upload', 'Operation']) {
    assert.ok(linked.has(thing), `no operation page says it returns ${thing}`);
  }
});
