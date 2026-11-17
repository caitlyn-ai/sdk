// The API reference at /api/ (scripts/docs-api.mjs): every operation in the OpenAPI document gets a page, the document
// the site publishes at /api/openapi.json passes the public-wording check the pages pass (scripts/docs-wording.mjs),
// and the curl examples carry the token as $CAITLYN_TOKEN and the workspace as the placeholder the Server block
// replaces. Reads the prepared model (scripts/docs-build.sh runs prepare-model before these tests).
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { kebab, loadModel, root } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { apiOperations, apiPages, namespaceLabel, publishedOpenapi, tagSlug } from '../../../scripts/docs-api.mjs';
import { documentProblems } from '../../../scripts/docs-wording.mjs';

const ast = loadModel();
const reference = referencePages(ast);
const raw = JSON.parse(fs.readFileSync(path.join(root, 'model/openapi.json'), 'utf8'));
const { doc, problems } = publishedOpenapi(raw, { ops: reference.ops, tree: reference.tree, sdkSlug: (op) => `sdk/${kebab(op.name)}`, examples: reference.examples });
const api = apiPages(doc, { ast, ops: reference.ops, sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: reference.typePages, tree: reference.tree });

test('every operation in the OpenAPI document is an operation of the SDK reference', () => {
  assert.deepEqual(problems, []);
});

test('every OpenAPI operation gets a page at /api/<operation>/', () => {
  const operations = apiOperations(doc);
  assert.ok(operations.length > 0);
  for (const { operation } of operations) {
    const page = api.pages.find((p) => p.operation.name === operation.operationId);
    assert.ok(page, `${operation.operationId} has no page`);
    assert.equal(page.slug, `api/${kebab(operation.operationId)}`);
  }
  assert.equal(api.pages.length, operations.length);
});

test('the published OpenAPI document passes the public-wording check', () => {
  assert.deepEqual(documentProblems(doc), []);
});

test('the public-wording check finds an internal mention in a document', () => {
  const found = documentProblems({ info: { description: 'Generated from the Smithy model; see PROTOCOL.md.' }, servers: [{ url: 'https://git.customd.com' }] });
  assert.equal(found.length, 3);
});

test('each curl example sends $CAITLYN_TOKEN to the workspace placeholder, and no token of its own', () => {
  const commands = api.pages.flatMap((p) => p.operation.panel.map((ex) => ex.code.curl));
  assert.ok(commands.length > 0);
  for (const c of commands) {
    assert.match(c, /--header "Authorization: Bearer \$CAITLYN_TOKEN"/);
    assert.match(c, /https:\/\/your-company\.getcaitlyn\.ai\/api\/v3\//);
    assert.doesNotMatch(c, /Bearer (?!\$CAITLYN_TOKEN)/);
  }
});

test('each example has the four SDKs beside curl', () => {
  for (const p of api.pages) for (const ex of p.operation.panel) assert.deepEqual(Object.keys(ex.code).sort(), ['curl', 'go', 'python', 'rust', 'typescript'], `${p.title}: ${ex.title}`);
});

test('every old Scalar address of an operation names its page', () => {
  for (const { route, method, operation } of apiOperations(doc)) {
    const op = reference.ops.find((o) => o.name === operation.operationId);
    assert.equal(api.anchors[`tag/${tagSlug(namespaceLabel(op.namespace, op))}/${method}${route}`], `/api/${kebab(operation.operationId)}/`);
  }
});

test('every status an operation documents has a response to show, on the SDK and API pages', () => {
  for (const p of api.pages) {
    const operation = doc.paths[p.route][p.method.toLowerCase()];
    const documented = Object.keys(operation.responses).map(Number).sort((a, b) => a - b);
    assert.deepEqual(p.operation.responses.map((r) => r.status), documented, p.title);
    for (const r of p.operation.responses) assert.ok(r.response || r.events, `${p.title} ${r.status} has no body`);
    const sdk = reference.pages.find((s) => s.operation?.name === p.operation.name).operation;
    assert.deepEqual(sdk.responses.map((r) => r.status), documented, `${p.title} in the SDK reference`);
    for (const r of sdk.responses.filter((x) => x.status >= 400)) {
      const body = JSON.parse(r.result);
      assert.equal(body.status, r.status);
      assert.match(body.type, /^https:\/\/build\.caitlyn\.ai\/errors\/[A-Z_]+$/);
    }
  }
});

test('the live site\'s old addresses for a nested namespace\'s operations (under the parent\'s tag) name their pages', () => {
  for (const { route, method, operation } of apiOperations(doc)) {
    const ns = reference.ops.find((o) => o.name === operation.operationId).namespace;
    if (!ns?.includes('.')) continue;
    assert.equal(api.anchors[`tag/${tagSlug(ns.split('.')[0])}/${method}${route}`], `/api/${kebab(operation.operationId)}/`);
  }
});
