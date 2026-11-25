// The conformance mock reports the version the model's @since("next") stamp needs, so a model pulled from an app
// branch (scripts/model-pull.sh --prerelease, as model:main pulls one) passes conformance: every operation it marks
// "next" is one the mock's server has. It never reports less than 5.120.0, which the harnesses' older-server cases
// are written against.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const server = path.join(import.meta.dirname, '../conformance/mock-server/server.mjs');

/** The Caitlyn-Api-Version the mock answers with when the model lock stamps "next" as `stampNext`. */
async function reported(stampNext, port) {
  const lock = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mock-version-')), 'model.lock.json');
  fs.writeFileSync(lock, JSON.stringify({ stampNext }));
  const mock = spawn(process.execPath, [server], { env: { ...process.env, PORT: String(port), MOCK_MODEL_LOCK: lock }, stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    await new Promise((resolve, reject) => {
      mock.stdout.on('data', (d) => String(d).includes('listening') && resolve());
      mock.on('exit', (code) => reject(new Error(`the mock exited with ${code}`)));
    });
    const res = await fetch(`http://127.0.0.1:${port}/v3/me`, { headers: { authorization: 'Bearer pat_test' } });
    assert.equal(res.status, 200);
    return res.headers.get('caitlyn-api-version');
  } finally {
    mock.kill();
  }
}

test('a model stamped later than 5.120.0 (an app branch build) is served at its stamp', async () => {
  assert.equal(await reported('5.134.0', 4191), '5.134.0');
  assert.equal(await reported('5.120.1', 4192), '5.120.1');
  assert.equal(await reported('6.0.0', 4193), '6.0.0');
});

test('a model stamped at or before 5.120.0 is served at 5.120.0', async () => {
  assert.equal(await reported('5.115.0', 4194), '5.120.0');
  assert.equal(await reported('5.120.0', 4195), '5.120.0');
  assert.equal(await reported('4.200.0', 4196), '5.120.0');
});
