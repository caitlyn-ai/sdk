// A member whose type is an enum shows its values as chips (scripts/docs-reference.mjs), so its description says what
// the choice means and does not list the values again. A description repeats them when it names all of the enum's
// values, or three or more of them, as words or as code. The descriptions come from the model, so a flagged member is
// fixed there. Reads the prepared model (scripts/docs-build.sh runs prepare-model first). Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { T, loadModel, local } from '../../../scripts/docs-model.mjs';

const ast = loadModel();

/** Every member whose type is an enum (or a list of one) and whose description repeats its values */
function repeatedEnumValues() {
  const found = [];
  for (const [id, shape] of Object.entries(ast.shapes)) {
    if (shape.type !== 'structure' || !id.startsWith('ai.caitlyn.v3#')) continue;
    for (const [name, m] of Object.entries(shape.members ?? {})) {
      let target = ast.shapes[m.target];
      if (target?.type === 'list') target = ast.shapes[target.member.target];
      if (target?.type !== 'enum') continue;
      const values = Object.values(target.members).map((v) => v.traits?.[T('enumValue')]).filter(Boolean);
      const doc = m.traits?.[T('documentation')] ?? '';
      const words = (v) => [v, v.replace(/_/g, ' ')].map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const named = values.filter((v) => words(v).some((w) => new RegExp(`(^|[^\\w-])${w}(?![\\w-])`).test(doc)));
      // A list is three or more of the values. Naming both values of a two-value enum (a default, and what the other
      // means) is how a description says what the choice decides, and the model's own lint allows it.
      if (named.length >= 3) found.push({ member: `${local(id)}.${name}`, values: named, of: values.length });
    }
  }
  return found;
}

// A member's description says what the choice decides; the values and their meanings are listed beside it as chips.
test('no member\'s description repeats its enum\'s values', () => {
  const found = repeatedEnumValues();
  for (const f of found) console.log(`${f.member}: names ${f.values.length} of ${f.of} values (${f.values.join(', ')})`);
  assert.deepEqual(found, []);
});
