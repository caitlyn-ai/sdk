// Resource names the reference writes in words ("the knowledge base named by knowledgeBaseId", "the caller's agent
// grants") are whole words: each is a word of one of the model's shape names, so a name cut short or singularised
// badly ("knowledge bas") fails here. Reads the prepared model (scripts/docs-build.sh runs prepare-model first).
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadModel, local, words } from '../../../scripts/docs-model.mjs';
import { referencePages, singular } from '../../../scripts/docs-reference.mjs';

const ast = loadModel();
const reference = referencePages(ast);
// Every word of every shape's name, as the model spells it: KnowledgeBase gives knowledge and base
const known = new Set(Object.keys(ast.shapes).flatMap((id) => words(local(id) ?? '')));

test('every resource the reference names in words is made of whole words', () => {
  const phrases = [/the ([a-z][a-z -]*?) named by/g, /caller's ([a-z][a-z -]*?) grants/g];
  let seen = 0;
  for (const p of reference.pages) {
    for (const re of phrases) {
      for (const [, name] of p.body.matchAll(re)) {
        seen++;
        for (const w of name.split(/[ -]/)) assert.ok(known.has(w), `${p.slug}: "${name}" has "${w}", which is no word of the model's names`);
      }
    }
  }
  assert.ok(seen > 0, 'no resource names found to check');
});

test('singular() turns the model\'s plural resource names into words', () => {
  assert.equal(singular('knowledge-bases'), 'knowledge-base');
  assert.equal(singular('policies'), 'policy');
  assert.equal(singular('statuses'), 'status');
  assert.equal(singular('batches'), 'batch');
  assert.equal(singular('agents'), 'agent');
});
