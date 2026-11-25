// The reference sidebars (scripts/docs-api.mjs namespaceTree and sidebarGroups, as scripts/docs-build.mjs builds them):
// no two entries side by side share a label, the top-level groups are only the client's own top level
// (conformance/cases/scope-tree.json: its collections, namespaces and scopes, and the methods on the client itself),
// labels are words, every page is titled by its job, and the building blocks come last, collapsed. Reads the prepared
// model (scripts/docs-build.sh runs prepare-model before these tests).
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { kebab, loadModel, root } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { INGESTION_GUIDE, INGESTION_INTRO, SIDEBAR_LABELS, addIngestionIntro, apiOverview, entryTips, apiPages, publishedOpenapi, sidebarGroups, sidebarLabel, treeLabel, walkTree } from '../../../scripts/docs-api.mjs';

const ast = loadModel();
const reference = referencePages(ast);
const { tree } = reference;
const raw = JSON.parse(fs.readFileSync(path.join(root, 'model/openapi.json'), 'utf8'));
const { doc } = publishedOpenapi(raw, { ops: [...reference.ops, ...reference.apiOnly], tree, sdkSlug: (op) => `sdk/${kebab(op.name)}`, examples: reference.examples });
const api = apiPages(doc, { ast, ops: [...reference.ops, ...reference.apiOnly], sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: reference.typePages, tree });
// As scripts/docs-build.mjs builds them: each entry labelled by SIDEBAR_LABELS, else its title
const label = (name, p) => ({ label: sidebarLabel(name, p.label ?? p.title), link: `/${p.slug}/` });
const sdkSidebar = sidebarGroups(tree, (e) => label(e.op?.name ?? e.helper.id, reference.pages.find((p) => (e.op ? p.operation?.name === e.op.name : p.helper === e.helper.id))));
const apiSidebar = sidebarGroups(tree, (e) => (e.op ? label(e.op.name, api.pages.find((p) => p.operation.name === e.op.name)) : null));
const sidebars = { 'SDK reference': sdkSidebar, 'API reference': apiSidebar };

/** Each list of entries side by side, with where it is */
function siblings(items, where, out = []) {
  out.push({ where, labels: items.map((i) => i.label) });
  for (const i of items) if (i.items) siblings(i.items, `${where} > ${i.label}`, out);
  return out;
}

test('no two entries side by side in a reference sidebar share a label', () => {
  for (const [name, items] of Object.entries(sidebars)) {
    for (const { where, labels } of siblings(items, name)) {
      const repeated = labels.filter((l, i) => labels.indexOf(l) !== i);
      assert.deepEqual(repeated, [], `${where} lists ${[...new Set(repeated)].join(', ')} more than once`);
    }
  }
});

test('no group repeats its parent\'s name: a section\'s own pages sit at its root', () => {
  const check = (items, parent, where) => {
    for (const i of items) {
      if (!i.items) continue;
      assert.notEqual(i.label, parent, `${where} > ${i.label} repeats its parent's name`);
      check(i.items, i.label, `${where} > ${i.label}`);
    }
  };
  for (const [name, items] of Object.entries(sidebars)) check(items, name, name);
  const agents = sdkSidebar.find((i) => i.label === 'Agents');
  assert.equal(agents.items[0].label, 'List agents');
  assert.deepEqual(agents.items.filter((i) => i.items).map((i) => i.label), ['Draft', 'Versions', 'History', 'Conversations', 'Configuration options']);
});

test('a shortened sidebar label names an operation or helper, and is shorter than the title it stands for', () => {
  for (const [name, short] of Object.entries(SIDEBAR_LABELS)) {
    const page = reference.pages.find((p) => p.operation?.name === name || p.helper === name);
    assert.ok(page, `${name} in SIDEBAR_LABELS is no operation or helper`);
    assert.ok(short.length < page.title.length, `${name}: "${short}" is not shorter than "${page.title}"`);
  }
  assert.ok(siblings(sdkSidebar, '').some((s) => s.labels.includes('List conversations')));
});

test('the top-level groups are only the client\'s own top level', () => {
  const client = JSON.parse(fs.readFileSync(path.join(root, 'conformance/cases/scope-tree.json'), 'utf8'));
  const top = new Set([...Object.values(client.children ?? {}).map((c) => c.name), ...(client.methods ?? []).map((m) => m.name)]);
  for (const n of tree) assert.ok(top.has(n.key), `${n.label} (${n.key}) is a top-level group the client does not have`);
  for (const [name, items] of Object.entries(sidebars)) {
    assert.deepEqual(items.map((i) => i.label), tree.filter((n) => items.some((i) => i.label === n.label)).map((n) => treeLabel(n.key)), name);
    for (const i of items) assert.ok(tree.some((n) => n.label === i.label), `${name}: ${i.label} is not a group of the client`);
  }
});

test('a scope is the same group as its collection, and groups nest to any depth', () => {
  const keys = [];
  walkTree(tree, (n) => keys.push(n.key));
  for (const key of ['knowledgeBases', 'knowledgeBases.documents', 'knowledgeBases.documents.versions', 'knowledgeBases.ingestion.batches.items', 'agents.versions', 'agents.history']) assert.ok(keys.includes(key), key);
  assert.ok(!keys.some((k) => /[()]/.test(k)), 'a group is keyed by a scope');
  assert.equal(tree.groupOf.get('GetDocument'), 'knowledgeBases.documents');
  assert.equal(tree.groupOf.get('ListDocuments'), 'knowledgeBases.documents');
  assert.equal(tree.groupOf.get('GetAccess'), 'knowledgeBases.access');
  assert.equal(tree.groupOf.get('GetCaller'), 'me');
});

test('group labels are words', () => {
  walkTree(tree, (n) => assert.match(n.label, /^[A-Z][a-z-]*( [a-z-]+)*$/, `${n.key} is labelled ${n.label}`));
  assert.equal(tree.find((n) => n.key === 'knowledgeBases').label, 'Knowledge bases');
});

test('every operation page is titled by its job, with the operation\'s name under it', () => {
  for (const p of [...reference.pages.filter((x) => x.operation), ...api.pages]) {
    const op = [...reference.ops, ...reference.apiOnly].find((o) => o.name === p.operation.name);
    assert.equal(p.title, op.shape.traits['smithy.api#title'], p.slug);
    assert.equal(p.subtitle, op.name, p.slug);
  }
});

test('an estimate sits right after its job', () => {
  for (const op of reference.ops) {
    const forId = op.shape.traits?.['ai.caitlyn.traits#estimate']?.for;
    if (!forId) continue;
    const group = tree.nodes.get(tree.groupOf.get(op.name));
    const names = group.entries.map((e) => e.op?.name ?? e.helper.id);
    assert.equal(names[names.indexOf(op.name) - 1], forId.split('#')[1], op.name);
  }
});

test('the building blocks come last and collapsed, in both sidebars and the OpenAPI tags', () => {
  for (const [name, items] of Object.entries(sidebars)) {
    const last = items[items.length - 1];
    assert.equal(last.label, 'Building blocks', name);
    assert.equal(last.collapsed, true, name);
    assert.ok(items.slice(0, -1).every((i) => !i.collapsed), `${name}: only the building blocks are collapsed`);
  }
  const blocks = tree.find((n) => n.label === 'Building blocks');
  const lowLevel = (op) => !!(op.shape.traits?.['ai.caitlyn.traits#lowLevel'] || (op.resource && ast.shapes[op.resource].traits?.['ai.caitlyn.traits#lowLevel']));
  for (const op of reference.ops) assert.equal(tree.groupOf.get(op.name).startsWith(`${blocks.key}.`) || tree.groupOf.get(op.name) === blocks.key, lowLevel(op), `${op.name}: under the building blocks only if it is one`);
  const tops = doc.tags.filter((t) => !t.name.includes(' / '));
  assert.equal(tops[tops.length - 1].name, 'Building blocks');
  assert.ok(doc.tags.slice(doc.tags.findIndex((t) => t.name === 'Building blocks')).every((t) => t.name.startsWith('Building blocks')), 'the building blocks\' tags come last');
  assert.equal(new Set(doc.tags.map((t) => t.name)).size, doc.tags.length, 'tag names are unique');
});

test('the SDK helpers have pages, in the SDK reference only', () => {
  for (const id of ['ingestion.sync', 'ingestion.sync.estimate', 'stream.text', 'batch.upload.estimate', 'batch.upload']) {
    const page = reference.pages.find((p) => p.helper === id);
    assert.ok(page, id);
    for (const lang of ['TypeScript', 'Python', 'Go', 'Rust']) assert.match(page.body, new RegExp(`^\\| ${lang} \\| \``, 'm'), `${id} in ${lang}`);
    assert.ok(siblings(sdkSidebar, '').some((s) => s.labels.includes(page.title)), `${id} is in the SDK sidebar`);
    assert.ok(!siblings(apiSidebar, '').some((s) => s.labels.includes(page.title)), `${id} is not in the API sidebar`);
  }
  assert.equal(tree.groupOf.get('stream.text'), tree.groupOf.get('SendMessage'));
  assert.equal(tree.groupOf.get('ingestion.sync'), 'knowledgeBases.ingestion');
  // A hand-built batch's estimate and upload sit in the Batches group, after Wait until planned, in the order they are called
  for (const id of ['batch.upload.estimate', 'batch.upload']) assert.equal(tree.groupOf.get(id), 'knowledgeBases.ingestion.batches', id);
  const batches = siblings(sdkSidebar, '').find((s) => s.labels.includes('Estimate the upload'));
  assert.ok(batches.labels.indexOf('Wait until planned') < batches.labels.indexOf('Estimate the upload') && batches.labels.indexOf('Estimate the upload') < batches.labels.indexOf('Upload files'), batches.labels.join(', '));
  for (const id of ['batch.upload.estimate', 'batch.upload']) {
    const body = reference.pages.find((p) => p.helper === id).body;
    for (const type of ['ingestion-batch', 'ingestion-batch-item']) assert.match(body, new RegExp(`\\]\\(/reference/types/${type}/\\)`), `${id} links ${type}`);
  }
});

// The fields OpenAPI 3.2 added: on a tag (nested tags), on a path item, and on a media type. A document that says 3.1
// carries none of them; one that says 3.2 or later may.
const TAG_32 = ['parent', 'summary', 'kind'];
const PATH_ITEM_32 = ['query', 'additionalOperations'];
const MEDIA_TYPE_32 = ['itemSchema', 'prefixEncoding', 'itemEncoding'];

test('the published OpenAPI document uses only the fields of the version it says it is', () => {
  const [major, minor] = doc.openapi.split('.').map(Number);
  assert.equal(major, 3, doc.openapi);
  const found = [];
  for (const t of doc.tags ?? []) for (const f of TAG_32) if (f in t) found.push(`tag ${t.name}: ${f}`);
  for (const [route, item] of Object.entries(doc.paths ?? {})) {
    for (const f of PATH_ITEM_32) if (f in item) found.push(`${route}: ${f}`);
    for (const [method, operation] of Object.entries(item)) {
      const contents = [operation?.requestBody?.content, ...Object.values(operation?.responses ?? {}).map((r) => r.content)].filter(Boolean);
      for (const content of contents) for (const [type, media] of Object.entries(content)) for (const f of MEDIA_TYPE_32) if (f in media) found.push(`${method.toUpperCase()} ${route} ${type}: ${f}`);
    }
  }
  if (minor < 2) assert.deepEqual(found, [], `the document says ${doc.openapi} but uses OpenAPI 3.2 fields`);
  else for (const t of doc.tags ?? []) if (t.parent) assert.ok(doc.tags.some((x) => x.name === t.parent), `${t.name}'s parent is a tag`);
});

test('the API reference overview names the OpenAPI version the document says', () => {
  const [major, minor] = doc.openapi.split('.');
  assert.match(apiOverview(api.pages, { tree }).body, new RegExp(`as an OpenAPI ${major}\\.${minor} document`));
});

test('every operation\'s and helper\'s sidebar entry has a tooltip: its title and the operation\'s name, or the helper\'s call', () => {
  for (const p of [...reference.pages.filter((x) => x.operation), ...api.pages]) {
    const tips = entryTips(p);
    assert.equal(tips['data-full'], `${p.title} (${p.operation.name})`, p.slug);
    assert.ok('data-tip' in tips, p.slug);
  }
  for (const p of reference.pages.filter((x) => x.helper)) {
    const tips = entryTips(p);
    for (const key of ['data-full', 'data-full-python', 'data-full-go', 'data-full-rust']) assert.match(tips[key] ?? '', new RegExp(`^${p.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\((kb|conversation|caitlyn)[.(]`), `${p.slug} ${key}`);
  }
  assert.equal(entryTips(reference.pages.find((p) => p.helper === 'ingestion.sync'))['data-full'], 'Sync a folder (kb.ingestion.sync)');
  assert.equal(entryTips(reference.pages.find((p) => p.operation?.name === 'CreateIngestionBatch'))['data-full'], 'Create an ingestion batch (CreateIngestionBatch)');
});

test('every thing that can be watched and waited on has its watch and wait pages, beside its operations', () => {
  // [helper, group, the method its calls end with]; the knowledge base's own watch is WatchKnowledgeBase's page
  const expected = [
    ['batch.watch', 'knowledgeBases.ingestion.batches', 'watch'], ['batch.wait', 'knowledgeBases.ingestion.batches', 'wait'], ['batch.planned', 'knowledgeBases.ingestion.batches', 'planned'],
    ['document.watch', 'knowledgeBases.documents', 'watch'], ['document.wait', 'knowledgeBases.documents', 'wait'],
    ['folder.watch', 'knowledgeBases.folders', 'watch'], ['folder.wait', 'knowledgeBases.folders', 'wait'],
    ['knowledgeBase.wait', 'knowledgeBases', 'wait'],
  ];
  for (const [id, group, m] of expected) {
    const p = reference.pages.find((x) => x.helper === id);
    assert.ok(p, id);
    assert.equal(p.group, group, id);
    for (const lang of ['typescript', 'python', 'go', 'rust']) assert.match(p.calls[lang], new RegExp(`\\.${m}\\(`, 'i'), `${id} in ${lang}`);
    assert.match(p.body, /\/reference\/watch-knowledge-base\//, `${id} links to Watch a knowledge base`);
  }
  assert.equal(tree.groupOf.get('WatchKnowledgeBase'), 'knowledgeBases');
  // Wait until planned sits beside Wait for a batch
  const batches = tree.nodes.get('knowledgeBases.ingestion.batches').entries.map((e) => e.op?.name ?? e.helper.id);
  assert.equal(batches[batches.indexOf('batch.wait') + 1], 'batch.planned');
});

test('"New to ingestion?" sits under the summary of every ingestion page once the guide is a page, and nowhere before', () => {
  const copy = () => [...reference.pages, ...api.pages].map((p) => ({ ...p, kind: p.slug.startsWith('api/') ? 'api' : 'reference' }));
  const without = copy();
  assert.equal(addIngestionIntro(without), false);
  assert.ok(without.every((p) => !p.body.includes(INGESTION_INTRO)));
  const withGuide = [...copy(), { slug: INGESTION_GUIDE, title: 'How ingestion works', body: '' }];
  assert.equal(addIngestionIntro(withGuide), true);
  const marked = withGuide.filter((p) => p.body.includes(INGESTION_INTRO));
  const names = (kind) => marked.filter((p) => p.kind === kind).map((p) => p.operation?.name ?? p.helper).sort();
  for (const kind of ['reference', 'api']) {
    for (const n of ['CreateDocument', 'BatchDeleteDocuments', 'CreateIngestionBatch', 'GetIngestionBatch', 'ListIngestionBatchItems', 'UpdateIngestionBatchItem']) assert.ok(names(kind).includes(n), `${kind}: ${n}`);
    assert.ok(!names(kind).includes('ListDocuments'), `${kind}: ListDocuments is not an ingestion page`);
  }
  for (const h of ['ingestion.sync', 'ingestion.sync.estimate', 'batch.watch', 'batch.wait']) assert.ok(names('reference').includes(h), h);
  // Under the summary: the page's first paragraph, then the line
  for (const p of marked) assert.equal(p.body.split('\n\n')[1], INGESTION_INTRO, p.slug);
});
