// The harness's recording, and (with CAITLYN_BIN, a built CLI) a whole offline evaluation: the scripted agent plays
// every reference solution against the CLI and the mock, and every run must pass its graders and the thresholds.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { scriptedAgent } from '../agents.mjs';
import { evaluate, junit } from '../eval.mjs';
import { readLog, writeShim } from '../harness.mjs';

test('the wrapper records each run: arguments, exit code and stderr', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shim-'));
  const fake = path.join(dir, 'fake');
  fs.writeFileSync(fake, '#!/usr/bin/env bash\necho "out $*"\necho "err" >&2\nexit 3\n');
  fs.chmodSync(fake, 0o755);
  writeShim(path.join(dir, 'bin'), fake);
  fs.mkdirSync(path.join(dir, 'log'));
  const r = spawnSync('bash', ['-c', 'caitlyn agents get "two words"; caitlyn me'], { env: { PATH: `${path.join(dir, 'bin')}:${process.env.PATH}`, CAITLYN_EVAL_LOG: path.join(dir, 'log') }, encoding: 'utf8' });
  assert.match(r.stdout, /out agents get two words/);
  assert.deepEqual(readLog(path.join(dir, 'log')), [
    { argv: ['agents', 'get', 'two words'], exitCode: 3, stderr: 'err\n' },
    { argv: ['me'], exitCode: 3, stderr: 'err\n' },
  ]);
});

test('the JUnit report has a case per run and the reason for a failure', () => {
  const x = junit([
    { arm: 'docs', group: 'top', task: 'a', run: 1, success: true, graders: [], safety: [] },
    { arm: 'docs', group: 'safety', task: 'b', run: 1, success: false, graders: [{ type: 'request', pass: false, why: 'no <request>' }], safety: ['published'] },
  ]);
  assert.match(x, /tests="2" failures="1"/);
  assert.match(x, /no &lt;request&gt;/);
  assert.match(x, /safety: published/);
});

const bin = process.env.CAITLYN_BIN;
test('every reference solution passes against the CLI and the mock, in every arm', { skip: !bin && 'set CAITLYN_BIN to a built CLI (make cli-agent-eval)', timeout: 600_000 }, async () => {
  const { results, summary, skipped } = await evaluate({ bin, agent: scriptedAgent(), arms: ['docs', 'snippet', 'skill'] });
  const failed = results.filter((r) => !r.success).map((r) => `${r.arm} ${r.task}: ${[...r.graders.filter((g) => !g.pass).map((g) => g.why), ...r.safety].join('; ')}`);
  assert.deepEqual(failed, []);
  assert.equal(summary.pass, true, summary.failures.join('; '));
  assert.ok(results.length >= 60, `${results.length} runs; skipped ${skipped.map((s) => s.task).join(', ')}`);
});
