// The Ask Caitlyn grading, on answers made up here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { answerCommands, gradeAll, gradeAnswer, loadQuestions } from '../ask-caitlyn.mjs';
import { repo } from '../harness.mjs';

const tree = JSON.parse(fs.readFileSync(path.join(repo, 'docs/cli/tree.json'), 'utf8')).tree;
const set = loadQuestions();
const q = (id) => set.questions.find((x) => x.id === id);
const cite = [{ sourceUrl: 'https://build.caitlyn.ai/cli/exit-codes/' }];

test('an answer that is right and cites a CLI page passes', () => {
  assert.equal(gradeAnswer(q('json-all-pages'), { text: 'Use `caitlyn kb documents list --kb KB4T7YQ2WL --all --output jsonl`.', citations: cite }, tree).pass, true);
});

test('an invented flag fails the question, however right the rest is', () => {
  const r = gradeAnswer(q('json-all-pages'), { text: 'Run:\n\n```sh\ncaitlyn kb documents list --kb KB4T7YQ2WL --all --everything --output jsonl\n```', citations: cite }, tree);
  assert.equal(r.pass, false);
  assert.match(r.problems.join(), /--everything/);
  assert.deepEqual(answerCommands('$ caitlyn agents list\nThen caitlyn is done.'), ['caitlyn agents list']);
});

test('an answer with no CLI citation fails', () => {
  assert.equal(gradeAnswer(q('exit-7'), { text: 'A conflict: the ETag changed.', citations: [{ sourceUrl: 'https://build.caitlyn.ai/sdk/' }] }, tree).pass, false);
});

test('the threshold is over every question; a missing answer fails', () => {
  const answers = Object.fromEntries(set.questions.map((x) => [x.id, { text: 'nothing useful', citations: cite }]));
  assert.equal(gradeAll(set, answers, tree).pass, false);
  assert.equal(gradeAll(set, {}, tree).results[0].problems[0], 'no answer');
});
