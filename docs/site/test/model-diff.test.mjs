// What changed in the public API between two model snapshots (scripts/model-diff.mjs), which the release notes list.
// It must say what the app's CaitlynChanges says: fixtures/model-changes/ holds two changes.json CaitlynChanges wrote
// (changelog.test.mjs says from which models), and this compares them with the diff of the same models, read from
// this repository's history. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { assemble, isBreaking, modelChanges, widens } from '../../../scripts/model-diff.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const fixtures = path.join(import.meta.dirname, 'fixtures/model-changes');
const modelAt = (ref) => {
  try {
    return JSON.parse(execFileSync('git', ['show', `${ref}:model/model.json`], { cwd: root, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return null;
  }
};

// The models CaitlynChanges compared: the 0.8.x lock (at v0.8.2), 0.9.0's, and the lock to app commit 85e9fad542
for (const [fixture, from, to] of [['5.114.0.json', 'v0.8.2', 'v0.9.0'], ['5.115.0.json', 'v0.9.0', 'c0734da5']]) {
  const before = modelAt(from);
  const after = modelAt(to);
  test(`the diff of ${from} and ${to}'s models is CaitlynChanges' ${fixture}, change for change and in its order`, { skip: before && after ? false : `this checkout has no ${from} or ${to} (a shallow clone)` }, () => {
    const expected = JSON.parse(fs.readFileSync(path.join(fixtures, fixture), 'utf8')).changes;
    assert.deepEqual(modelChanges(before, after), expected);
  });
}

const svc = (ops, extra = {}) => ({ 'ai.caitlyn.v3#Caitlyn': { type: 'service', version: '3', operations: ops.map((o) => ({ target: `ai.caitlyn.v3#${o}` })), ...extra } });
const op = (name, { stability = 'beta', input, errors = [] } = {}) => ({
  [`ai.caitlyn.v3#${name}`]: { type: 'operation', ...(input ? { input: { target: `ai.caitlyn.v3#${input}` } } : {}), errors: errors.map((e) => ({ target: `ai.caitlyn.v3#${e}` })), traits: { 'ai.caitlyn.traits#stability': stability, 'smithy.api#title': `Title of ${name}` } },
});

test('a new operation is added with its title and stability; a removed one is removed, and breaks callers', () => {
  const before = { shapes: { ...svc(['GetThing']), ...op('GetThing') } };
  const after = { shapes: { ...svc(['ListThings']), ...op('ListThings', { stability: 'ga' }) } };
  const changes = modelChanges(before, after);
  assert.deepEqual(changes, [
    { kind: 'operationAdded', surface: 'ga', operation: 'ListThings', stability: 'ga', title: 'Title of ListThings' },
    { kind: 'operationRemoved', surface: 'beta', operation: 'GetThing', stability: 'beta' },
  ]);
  assert.deepEqual(changes.map(isBreaking), [false, true]);
});

test("a mixin's members are the structure's own, and @required applied to one counts as the member's", () => {
  const shapes = (required) => ({
    ...svc(['MakeThing']),
    ...op('MakeThing', { input: 'MakeThingInput' }),
    'ai.caitlyn.v3#ThingBody': { type: 'structure', members: { name: { target: 'smithy.api#String' } }, traits: { 'smithy.api#mixin': {} } },
    'ai.caitlyn.v3#MakeThingInput': { type: 'structure', mixins: [{ target: 'ai.caitlyn.v3#ThingBody' }], members: {} },
    ...(required ? { 'ai.caitlyn.v3#MakeThingInput$name': { type: 'apply', traits: { 'smithy.api#required': {} } } } : {}),
  });
  assert.deepEqual(assemble({ shapes: shapes(true) })['ai.caitlyn.v3#MakeThingInput'].members.name.traits, { 'smithy.api#required': {} });
  const changes = modelChanges({ shapes: shapes(false) }, { shapes: shapes(true) });
  assert.deepEqual(changes, [{ kind: 'memberChanged', surface: 'beta', shape: 'MakeThingInput', member: 'name', from: { target: 'String', required: false }, to: { target: 'String', required: true } }]);
  assert.equal(isBreaking(changes[0]), true, 'a member that became required breaks a caller who leaves it out');
});

test('shapes only an internal operation reaches are not public, and never appear', () => {
  const base = { ...svc(['Hidden']), ...op('Hidden', { stability: 'internal', input: 'HiddenInput' }), 'ai.caitlyn.v3#HiddenInput': { type: 'structure', members: {} } };
  const after = structuredClone(base);
  after['ai.caitlyn.v3#HiddenInput'].members.secret = { target: 'smithy.api#String' };
  assert.deepEqual(modelChanges({ shapes: base }, { shapes: after }), []);
});

test('an optional member and an enum value added break no one; a value dropped does', () => {
  assert.equal(isBreaking({ kind: 'memberAdded', required: false }), false);
  assert.equal(isBreaking({ kind: 'enumValueAdded' }), false);
  assert.equal(isBreaking({ kind: 'enumValueRemoved' }), true);
  assert.equal(isBreaking({ kind: 'stabilityChanged', from: 'beta', to: 'ga' }), false);
});

test("a member's new type breaks no one when it is a plain value that takes every value the old one did", () => {
  const model = (target, extra = {}) => ({
    shapes: {
      ...svc(['PutThing']),
      ...op('PutThing', { input: 'PutThingInput' }),
      'ai.caitlyn.v3#PutThingInput': { type: 'structure', members: { tag: { target } } },
      'ai.caitlyn.v3#Tag': { type: 'string', traits: { 'smithy.api#length': { min: 2, max: 256 } } },
      'ai.caitlyn.v3#TagOrStar': { type: 'string', traits: { 'smithy.api#length': { min: 1, max: 256 } } },
      'ai.caitlyn.v3#ShortTag': { type: 'string', traits: { 'smithy.api#length': { min: 2, max: 64 } } },
      'ai.caitlyn.v3#PatternTag': { type: 'string', traits: { 'smithy.api#pattern': '^"' } },
      'ai.caitlyn.v3#Kind': { type: 'enum', members: { A: { target: 'smithy.api#Unit' } } },
      'ai.caitlyn.v3#Count': { type: 'integer' },
      'ai.caitlyn.v3#BigCount': { type: 'long' },
      'ai.caitlyn.v3#Wrapper': { type: 'structure', members: {} },
      ...extra,
    },
  });
  const change = (from, to) => {
    const [before, after] = [model(`ai.caitlyn.v3#${from}`), model(`ai.caitlyn.v3#${to}`)];
    const [c] = modelChanges(before, after);
    return { c, widens: widens(c, before, after) };
  };
  assert.equal(change('Tag', 'TagOrStar').widens, true, 'a wider length');
  assert.equal(change('Count', 'BigCount').widens, true, 'an integer to a long');
  assert.equal(change('Tag', 'ShortTag').widens, false, 'a narrower length refuses what was sent');
  assert.equal(change('BigCount', 'Count').widens, false, 'a long to an integer');
  assert.equal(change('Tag', 'PatternTag').widens, false, 'a new pattern');
  assert.equal(change('Tag', 'Kind').widens, false, 'an enum is a named type');
  assert.equal(change('Tag', 'Wrapper').widens, false, 'a structure is a named type');
  const { c } = change('Tag', 'TagOrStar');
  assert.equal(isBreaking(c), true, 'without widens, a changed type breaks');
  assert.equal(isBreaking({ ...c, widens: true }), false);
  assert.equal(isBreaking({ ...c, widens: true, to: { ...c.to, required: true } }), true, 'made required still breaks');
});
