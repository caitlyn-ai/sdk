// If-Match is optional on the model's @ifMatchOptional operations and required on every other write that takes it.
// Each operation page (both references) shows the header as optional or required, and lists 428 only where it is
// required; the conditional-writes rule (docs/errors.md) names the optional set from the model. Reads the prepared
// model (scripts/docs-build.sh runs prepare-model first). Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { T, fillIfMatchOptional, ifMatchOptional, kebab, loadModel, root } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { apiPages, publishedOpenapi } from '../../../scripts/docs-api.mjs';

const ast = loadModel();
const reference = referencePages(ast);
const raw = JSON.parse(fs.readFileSync(path.join(root, 'model/openapi.json'), 'utf8'));
const { doc } = publishedOpenapi(raw, { ops: [...reference.ops, ...reference.apiOnly], tree: reference.tree, sdkSlug: (op) => `sdk/${kebab(op.name)}`, examples: reference.examples });
const api = apiPages(doc, { ast, ops: [...reference.ops, ...reference.apiOnly], sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])), typePages: reference.typePages, tree: reference.tree });
const optional = new Set(ifMatchOptional(ast));

/** Every operation that takes If-Match, with what its two pages render: required or optional, and whether 428 is listed */
function rendered() {
  const out = [];
  for (const op of reference.ops) {
    const input = ast.shapes[op.shape.input.target];
    const member = Object.values(input.members ?? {}).find((m) => m.traits?.[T('httpHeader')] === 'If-Match');
    if (!member) continue;
    const sdk = reference.pages.find((p) => p.operation?.name === op.name).body;
    const http = api.pages.find((p) => p.operation.name === op.name).body;
    out.push({
      name: op.name,
      modelRequired: member.traits?.[T('required')] !== undefined,
      sdkRequired: /^\| `ifMatch` \(required\) \|/m.test(sdk),
      httpRequired: /^\| `If-Match` \(required\) \|/m.test(http),
      sdk428: /^\| 428 \|/m.test(sdk),
      http428: /^\| 428 \|/m.test(http),
    });
  }
  return out;
}

test('every operation page shows If-Match as the model has it, and lists 428 only where it is required', () => {
  const rows = rendered();
  assert.ok(rows.length > 0);
  for (const r of rows) {
    for (const k of ['sdkRequired', 'httpRequired', 'sdk428', 'http428']) assert.equal(r[k], r.modelRequired, `${r.name}: ${k}`);
  }
});

// The model's @ifMatchOptional set and its members' optional If-Match agree (the test prints any that do not)
test('If-Match is optional on exactly the model\'s @ifMatchOptional operations', () => {
  const off = rendered().filter((r) => r.modelRequired === optional.has(r.name));
  for (const r of off) console.log(`${r.name}: rendered ${r.modelRequired ? 'required' : 'optional'}, ${optional.has(r.name) ? 'in' : 'not in'} @ifMatchOptional`);
  assert.deepEqual(off.map((r) => r.name), []);
});

test('the conditional-writes rule names the optional set from the model, once', () => {
  const errors = fs.readFileSync(path.join(root, 'docs/errors.md'), 'utf8');
  assert.equal((errors.match(/^<!-- if-match-optional -->$/gm) ?? []).length, 1);
  const filled = fillIfMatchOptional(errors, [...optional]);
  for (const n of optional) assert.match(filled, new RegExp(`\\[${n}\\]\\(/reference/${kebab(n)}/\\)`), n);
});
