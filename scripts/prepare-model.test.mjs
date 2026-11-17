// Tests for scripts/prepare-model.mjs's dev mode, the app's local loop (scripts/dev-sdk.sh). scripts/test-typescript.sh
// runs it:
//   node --test scripts/prepare-model.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(import.meta.dirname, 'prepare-model.mjs');
const lock = JSON.parse(fs.readFileSync(path.join(root, 'model/model.lock.json'), 'utf8'));
const SINCE = 'ai.caitlyn.traits#since';

/** A model that is not the locked snapshot: one shape and one member @since("next"), and the lint metadata. */
function devModel(dir) {
  const model = {
    smithy: '2.0',
    metadata: { validators: [{ name: 'X' }], suppressions: [{ id: 'Y' }], kept: true },
    shapes: {
      'ai.caitlyn.v3#Thing': { type: 'structure', traits: { [SINCE]: 'next' }, members: { name: { target: 'smithy.api#String', traits: { [SINCE]: 'next' } } } },
      'ai.caitlyn.v3#Old': { type: 'structure', traits: { [SINCE]: '5.1.0' } },
    },
  };
  const file = path.join(dir, 'source.json');
  fs.writeFileSync(file, JSON.stringify(model));
  return file;
}

test('dev mode reads the given model, skips the lock check, stamps stampNext and writes only the given output', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-model-'));
  const input = devModel(dir);
  const output = path.join(dir, 'out', 'model.json');
  const snapshot = path.join(root, 'build/model/model.json');
  const before = fs.existsSync(snapshot) ? fs.statSync(snapshot).mtimeMs : undefined;
  const out = execFileSync(process.execPath, [script, '--dev', input, output], { encoding: 'utf8' });
  const ast = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(ast.shapes['ai.caitlyn.v3#Thing'].traits[SINCE], lock.stampNext, 'next is stamped with the lock\'s stampNext');
  assert.equal(ast.shapes['ai.caitlyn.v3#Thing'].members.name.traits[SINCE], lock.stampNext);
  assert.equal(ast.shapes['ai.caitlyn.v3#Old'].traits[SINCE], '5.1.0', 'a release number is left alone');
  assert.deepEqual(ast.metadata, { kept: true }, 'the lint metadata is removed, the rest kept');
  assert.match(out, /from the dev model/);
  const after = fs.existsSync(snapshot) ? fs.statSync(snapshot).mtimeMs : undefined;
  assert.equal(after, before, 'build/model/model.json, which make generate reads, is untouched');
});

test('without --dev, a model that does not match the lock is refused', () => {
  // The normal path reads model/model.json; here only its check is exercised, against a copy of the script in a
  // checkout-shaped temporary directory whose snapshot differs from its lock.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-model-'));
  fs.mkdirSync(path.join(dir, 'scripts'));
  fs.mkdirSync(path.join(dir, 'model'));
  fs.copyFileSync(script, path.join(dir, 'scripts', 'prepare-model.mjs'));
  fs.copyFileSync(devModel(dir), path.join(dir, 'model', 'model.json'));
  fs.writeFileSync(path.join(dir, 'model', 'model.lock.json'), JSON.stringify({ sha256: '0'.repeat(64), stampNext: lock.stampNext }));
  const r = spawnSync(process.execPath, [path.join(dir, 'scripts', 'prepare-model.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /model\/model\.lock\.json says/);
  assert.ok(!fs.existsSync(path.join(dir, 'build/model/model.json')), 'nothing written');
});

test('dev mode takes exactly an input and an output', () => {
  const r = spawnSync(process.execPath, [script, '--dev', 'only-one.json'], { encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /usage/);
});
