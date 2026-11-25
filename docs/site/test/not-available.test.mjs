// "Not available yet" names the release the operation arrives in: model/model.lock.json's stampNext, the number the
// SDKs' doc comments already show ("Since Caitlyn 5.115.0"), so the site and the SDKs agree. Reads the prepared model
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

test('the callout and the Stability row name the lock\'s stampNext, on every page of an operation no release serves', () => {
  const unreleased = unreleasedOperations();
  assert.equal(nextRelease(), stampNext ?? null);
  const pages = [...reference.pages.filter((p) => p.operation), ...api.pages].filter((p) => unreleased.has(p.operation.name));
  assert.ok(pages.length > 0);
  for (const p of pages) {
    const versions = [...p.body.matchAll(/Not available yet: arrives in Caitlyn (\d+\.\d+\.\d+)/g)].map((m) => m[1]);
    if (stampNext) {
      assert.ok(versions.length > 0, `${p.slug} names no release`);
      for (const v of versions) assert.equal(v, stampNext, p.slug);
    } else assert.equal(versions.length, 0, p.slug);
  }
  for (const p of stampNext ? reference.pages.filter((x) => x.operation && unreleased.has(x.operation.name)) : []) {
    assert.match(p.body, new RegExp(`^\\| Stability \\| .*Not available yet: arrives in Caitlyn ${stampNext.replace(/\./g, '\\.')}`, 'm'), p.slug);
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
  // Only the fixture's operations are released; the rest of the prepared model keeps its "next"
  const unreleased = new Set([...unreleasedOperations()].filter((n) => !Object.keys(snapshot).some((id) => id.endsWith(`#${n}`))));
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
// naming stampNext, while any of the page's operations is unreleased, and nothing once they all are.
test('a guide\'s callout names stampNext while its operations are unreleased, and is gone once they are released', () => {
  const marked = readPages().filter((p) => /^<!-- not-available/m.test(p.markdown));
  assert.ok(marked.some((p) => p.slug.startsWith('guides/')), 'no guide has the marker');
  assert.ok(!readPages().some((p) => /^> \*\*Not available yet/m.test(p.markdown) && !/sign-in|authentication/.test(p.slug)), 'a hand-written callout about operations is left');
  for (const p of marked) {
    const pending = fillNotAvailable(p.markdown, { operations: p.metadata.operations });
    assert.doesNotMatch(pending, /<!-- not-available/, p.file);
    if (stampNext) assert.match(pending, new RegExp(`> \\*\\*Not available yet: arrives in Caitlyn ${stampNext.replace(/\./g, '\\.')}\\.\\*\\*`), p.file);
    const released = fillNotAvailable(p.markdown, { operations: p.metadata.operations, unreleased: new Set(), next: null });
    assert.doesNotMatch(released, /Not available yet|<!-- not-available/, p.file);
  }
});
