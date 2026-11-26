// The task set: its shape, the merge request's subset, and every reference solution's commands are real ones.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { PENDING_COMMANDS, commandLineProblems } from '../../../scripts/docs-cli.mjs';
import { GRADERS } from '../graders.mjs';
import { ARMS, loadTasks, missingCommands, repo } from '../harness.mjs';
import { loadQuestions } from '../ask-caitlyn.mjs';

const tree = JSON.parse(fs.readFileSync(path.join(repo, 'docs/cli/tree.json'), 'utf8')).tree;
const { tasks } = loadTasks();

test('about 30 tasks, in every group, with a fast subset of 12', () => {
  assert.ok(tasks.length >= 28, `${tasks.length} tasks`);
  for (const g of ['top', 'recovery', 'safety', 'tool']) assert.ok(tasks.filter((t) => t.group === g).length >= 4, g);
  assert.equal(tasks.filter((t) => t.fast).length, 12);
  for (const t of tasks.filter((x) => x.fast)) assert.deepEqual(missingCommands(t, tree), [], `${t.id} is in the fast subset but needs commands the CLI lacks`);
  assert.deepEqual(Object.keys(ARMS), ['docs', 'snippet', 'skill']);
});

test('every grader is one the harness has, and every task has a reference solution', () => {
  for (const t of tasks) {
    for (const g of t.graders) assert.ok(GRADERS[g.type], `${t.id}: ${g.type}`);
    assert.ok(t.reference && typeof t.reference.answer === 'string', t.id);
  }
});

test("every reference command parses against the CLI's command tree", () => {
  for (const t of tasks) {
    for (const block of t.reference.commands) {
      for (const line of block.split('\n')) {
        for (const m of line.matchAll(/(?:^|\$\(|=\$\()\s*(caitlyn [^)|]*)/g)) {
          const pending = missingCommands(t, tree).length ? PENDING_COMMANDS : {};
          assert.deepEqual(commandLineProblems(m[1].trim(), tree, { pending }), [], `${t.id}: ${m[1]}`);
        }
      }
    }
  }
});

test('the Ask Caitlyn question set covers each kind of question', () => {
  const set = loadQuestions();
  for (const type of ['task', 'error', 'choice', 'flags']) assert.ok(set.questions.filter((q) => q.type === type).length >= 3, type);
  assert.equal(new Set(set.questions.map((q) => q.id)).size, set.questions.length);
  assert.equal(set.threshold, 0.9);
});
