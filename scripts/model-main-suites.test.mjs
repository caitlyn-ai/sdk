// Tests for running the four language suites at once (scripts/model-main-suites.sh, model:main): each conformance
// harness's mock server keeps to its own range of ports, and build/model/model.json, which every suite prepares again,
// is never half-written (scripts/prepare-model.mjs writes it atomically, so a reader has the old file or the new one). The CI job release:scripts runs it:
//   node --test scripts/model-main-suites.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** [first, last] port of each harness's mock server, read from its source. */
function ranges() {
  const at = (file, re, f) => {
    const m = re.exec(read(file));
    assert.ok(m, `${file}: its mock server's port is not where this test looks`);
    return f(m);
  };
  return {
    // test-typescript.sh starts two mocks, on fixed ports; the harness picks its own only when run alone
    'typescript (test-typescript.sh)': at('scripts/test-typescript.sh', /for port in (\d+) (\d+); do/, (m) => [Number(m[1]), Number(m[2])]),
    'typescript (the harness alone)': at('conformance/typescript/conformance.test.ts', /\|\| (\d+) \+ Math\.floor\(Math\.random\(\) \* (\d+)\)/, (m) => [Number(m[1]), Number(m[1]) + Number(m[2]) - 1]),
    python: at('conformance/python/conftest.py', /port = (\d+) \+ random\.randint\(0, (\d+)\)/, (m) => [Number(m[1]), Number(m[1]) + Number(m[2])]),
    go: at('conformance/go/mock_test.go', /port := (\d+) \+ rand\.IntN\((\d+)\)/, (m) => [Number(m[1]), Number(m[1]) + Number(m[2]) - 1]),
    rust: at('conformance/rust/tests/conformance.rs', /let port = (\d+) \+ \(std::process::id\(\) % (\d+)\);/, (m) => [Number(m[1]), Number(m[1]) + Number(m[2]) - 1]),
  };
}

test("no two suites' mock servers can take the same port", () => {
  const all = Object.entries(ranges());
  for (const [i, [a, [a0, a1]]] of all.entries()) {
    for (const [b, [b0, b1]] of all.slice(i + 1)) {
      // The two TypeScript entries are one suite, which never runs both at once
      if (a.startsWith('typescript') && b.startsWith('typescript')) continue;
      assert.ok(a1 < b0 || b1 < a0, `${a} (${a0} to ${a1}) and ${b} (${b0} to ${b1}) share ports`);
    }
  }
});

test('a prepare-model that stops part way through writing leaves the model it replaces whole', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prepare-model-'));
  try {
    const output = path.join(dir, 'model.json');
    const prepare = (env = {}, args = []) =>
      spawnSync('node', [...args, path.join(root, 'scripts/prepare-model.mjs'), '--dev', path.join(root, 'model/model.json'), output], { encoding: 'utf8', env: { ...process.env, ...env } });
    assert.equal(prepare().status, 0);
    // The run that stops: its write to the output (or to a file beside it) gets a thousand bytes out, and the process
    // dies, as a suite's run would if it were killed while the others read the model
    const cut = path.join(dir, 'cut.mjs');
    fs.writeFileSync(cut, `import fs from 'node:fs';
const write = fs.writeFileSync;
fs.writeFileSync = (file, data, ...rest) => {
  if (String(file).startsWith(process.env.CUT)) {
    write(file, String(data).slice(0, 1000));
    throw new Error('stopped part way through the write');
  }
  return write(file, data, ...rest);
};
`);
    const stopped = prepare({ CUT: output }, ['--import', pathToFileURL(cut).href]);
    assert.notEqual(stopped.status, 0, 'the write was not cut');
    assert.match(stopped.stderr, /stopped part way through the write/);
    // Readers see the whole model from before, never the thousand bytes
    assert.doesNotThrow(() => JSON.parse(fs.readFileSync(output, 'utf8')), 'the model was left half-written');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
