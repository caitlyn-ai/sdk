// "Not available yet" names the release the operation arrives in: model/model.lock.json's stampNext, the number the
// SDKs' doc comments already show, so the site and the SDKs agree. A published snapshot has no "next", so no page has
// the callout; the pre-release case is then tested with an operation marked unreleased here. Reads the prepared model
// (scripts/docs-build.sh runs prepare-model first). Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fillNotAvailable, kebab, loadModel, nextRelease, root, unreleasedOperations } from '../../../scripts/docs-model.mjs';
import { readPages } from '../../../scripts/docs-guides.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { apiPages, publishedOpenapi } from '../../../scripts/docs-api.mjs';

const ast = loadModel();
const reference = referencePages(ast);
const raw = JSON.parse(fs.readFileSync(path.join(root, 'model/openapi.json'), 'utf8'));
const { doc } = publishedOpenapi(raw, { ops: [...reference.ops, ...reference.apiOnly], tree: reference.tree, sdkSlug: (op) => `sdk/${kebab(op.name)}`, examples: reference.examples });
const api = apiPages(doc, { ast, ops: [...reference.ops, ...reference.apiOnly], sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: reference.typePages, tree: reference.tree });
const stampNext = JSON.parse(fs.readFileSync(path.join(root, 'model/model.lock.json'), 'utf8')).stampNext;

test('the callout and the Stability row name the release, on every page of an operation no release serves', () => {
  const unreleased = unreleasedOperations();
  assert.equal(nextRelease(), stampNext ?? null);
  // A published snapshot (as now) has no "next": no page has the callout
  if (unreleased.size === 0) {
    for (const p of [...reference.pages, ...api.pages]) assert.doesNotMatch(p.body, /Not available yet/, p.slug);
  }
  // The pre-release case, from the same model: the snapshot's unreleased operations, or one marked so here, arriving
  // in the lock's stampNext, or a release given here
  const pre = unreleased.size ? unreleased : new Set(['GetDocument']);
  const next = stampNext ?? '9.9.0';
  const refs = referencePages(ast, { unreleased: pre, next });
  const preApi = apiPages(doc, { ast, ops: [...refs.ops, ...refs.apiOnly], sdkPages: new Map(refs.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: refs.typePages, tree: refs.tree, unreleased: pre, next });
  const pages = [...refs.pages.filter((p) => p.operation), ...preApi.pages].filter((p) => pre.has(p.operation.name));
  assert.ok(pages.length > 0);
  for (const p of pages) {
    const versions = [...p.body.matchAll(/Not available yet: arrives in Caitlyn (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    assert.ok(versions.length > 0, `${p.slug} names no release`);
    for (const v of versions) assert.equal(v, next, p.slug);
  }
  for (const p of refs.pages.filter((x) => x.operation && pre.has(x.operation.name))) {
    assert.match(p.body, new RegExp(`^\\| Stability \\| .*Not available yet: arrives in Caitlyn ${next.replace(/\./g, '\\.')}`, 'm'), p.slug);
  }
});

// The normal case: a model built from the app's main, where every operation's @since is a released version. The
// callout is the pre-release case only (a model built from a branch, @since "next"); here no page has it, and the
// Stability row is followed by "Since Caitlyn X.Y.Z".
test('a released operation has no callout, and shows the release it arrived in', () => {
  const fixture = (name) => JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures', name), 'utf8'));
  const snapshot = fixture('released.model.json').shapes;
  const lock = fixture('released.lock.json');
  const released = loadModel();
  for (const [id, s] of Object.entries(snapshot)) released.shapes[id].traits['ai.caitlyn.traits#since'] = s.traits['ai.caitlyn.traits#since'];
  // Only the fixture's operations are released; GetDocument is marked unreleased here, whatever the snapshot says
  const unreleased = new Set([...unreleasedOperations(), 'GetDocument'].filter((n) => !Object.keys(snapshot).some((id) => id.endsWith(`#${n}`))));
  assert.equal(unreleasedOperations(snapshot).size, 0);
  const next = nextRelease(lock);
  assert.equal(next, null);
  const pages = referencePages(released, { unreleased, next });
  for (const [id, s] of Object.entries(snapshot)) {
    const name = id.split('#')[1];
    const page = pages.pages.find((p) => p.operation?.name === name);
    assert.doesNotMatch(page.body, /Not available yet/, name);
    assert.match(page.body, new RegExp(`^\\| Since \\| Caitlyn ${s.traits['ai.caitlyn.traits#since'].replace(/\./g, '\\.')} \\|$`, 'm'), name);
    assert.match(page.body, /^\| Stability \| Beta: Public, and may still change before it is generally available \|$/m, name);
  }
  // An operation still "next" with no stampNext says only "Not available yet"
  const other = pages.pages.find((p) => p.operation?.name === 'GetDocument');
  assert.match(other.body, /^> \*\*Not available yet\.\*\* The SDKs have this operation, but workspaces do not serve it yet\.$/m);
  assert.doesNotMatch(other.body, /arrives in/);
  const { doc: d } = publishedOpenapi(raw, { ops: [...pages.ops, ...pages.apiOnly], tree: pages.tree, sdkSlug: (op) => `sdk/${kebab(op.name)}`, examples: pages.examples });
  const apis = apiPages(d, { ast: released, ops: [...pages.ops, ...pages.apiOnly], sdkPages: new Map(pages.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: pages.typePages, tree: pages.tree, unreleased, next });
  for (const id of Object.keys(snapshot)) assert.doesNotMatch(apis.pages.find((p) => p.operation.name === id.split('#')[1]).body, /Not available yet/, id);
});

// The hand-written pages' callouts come from the same source: a `<!-- not-available -->` line becomes the callout,
// naming stampNext, while any of the page's operations is unreleased, and nothing once they all are. An operation is
// unreleased when no release serves it (unreleasedOperations: the published model has no release for it, or, without
// that model, its @since is still "next"). The lock's stampNext alone says nothing about that: a model:main
// pre-release always has one, the app's release, even when every operation it has is already served (after app
// !2158 every v3 operation is @since 5.149.0), so its pages have no callout. The conformance harnesses read the
// SDK's model version by the same rule: the highest @since, with "next" counted as stampNext.
test('a guide\'s callout names stampNext while its operations are unreleased, and is gone once they are released', () => {
  const marked = readPages().filter((p) => /^<!-- not-available/m.test(p.markdown));
  assert.ok(marked.some((p) => p.slug.startsWith('guides/')), 'no guide has the marker');
  assert.ok(!readPages().some((p) => /^> \*\*Not available yet/m.test(p.markdown) && !/sign-in|authentication/.test(p.slug)), 'a hand-written callout about operations is left');
  const unreleased = unreleasedOperations();
  const named = (next) => new RegExp(`> \\*\\*Not available yet: arrives in Caitlyn ${next.replace(/\./g, '\\.')}\\.\\*\\*`);
  for (const p of marked) {
    const listed = p.markdown.match(/^<!-- not-available(?::\s*([\w,\s]+?))?\s*-->$/m)[1];
    const ops = listed ? listed.split(/[,\s]+/).filter(Boolean) : p.metadata.operations;
    assert.ok(ops?.length, `${p.file}: the marker names no operations`);
    // As the build fills it: a callout only while one of its operations is unreleased, naming the lock's stampNext
    const built = fillNotAvailable(p.markdown, { operations: p.metadata.operations });
    assert.doesNotMatch(built, /<!-- not-available/, p.file);
    if (!ops.some((op) => unreleased.has(op))) assert.doesNotMatch(built, /Not available yet/, p.file);
    else if (stampNext) assert.match(built, named(stampNext), p.file);
    else assert.match(built, /> \*\*Not available yet\.\*\*/, p.file);
    // Unreleased operations, arriving in a known release: the callout names it
    const pending = fillNotAvailable(p.markdown, { operations: p.metadata.operations, unreleased: new Set(ops), next: '9.9.0' });
    assert.match(pending, named('9.9.0'), p.file);
    // A pre-release lock (stampNext set) whose operations are all released: no callout, as on main after app !2158
    const released = fillNotAvailable(p.markdown, { operations: p.metadata.operations, unreleased: new Set(), next: '9.9.0' });
    assert.doesNotMatch(released, /Not available yet|<!-- not-available/, p.file);
  }
});
