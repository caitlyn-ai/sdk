// Tests for the GitHub release workflows' tag check (.github/workflows/release-pypi.yml, release-crates.yml and
// release-github.yml), which decides what each one publishes: a release tag vX.Y.Z, or a beta tag vX.Y.Z-beta.N
// (the GitLab model:main job's), and nothing else. Each test runs a workflow's own "Choose the tag" step, as GitHub
// would, with a tag in TAG and GITHUB_OUTPUT a file, so nothing is pushed or published. The CI job release:workflows
// runs it:
//   node --test scripts/release-workflows.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const WORKFLOWS = ['release-pypi', 'release-crates', 'release-github'];
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'release-workflows-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

/** The `run: |` script of a workflow's step named `name`, unindented. */
function stepScript(workflow, name) {
  const lines = fs.readFileSync(path.join(root, `.github/workflows/${workflow}.yml`), 'utf8').split('\n');
  const at = lines.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.ok(at >= 0, `${workflow} has no step "${name}"`);
  const stepIndent = lines[at].indexOf('-');
  const run = lines.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  assert.ok(run > at && lines.slice(at + 1, run).every((l) => !l.trim() || l.search(/\S/) > stepIndent), `${workflow}: "${name}" has no run: | block`);
  const body = [];
  for (const l of lines.slice(run + 1)) {
    if (l.trim() && l.search(/\S/) <= lines[run].search(/\S/)) break;
    body.push(l);
  }
  const indent = Math.min(...body.filter((l) => l.trim()).map((l) => l.search(/\S/)));
  return body.map((l) => l.slice(indent)).join('\n');
}

/** Runs the step as GitHub does (bash -e), returning its exit status, stderr and outputs. */
function chooseTag(workflow, tag) {
  const output = path.join(tmp, `${workflow}-${Math.random().toString(36).slice(2)}`);
  fs.writeFileSync(output, '');
  const run = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', stepScript(workflow, 'Choose the tag')], {
    env: { PATH: process.env.PATH, TAG: tag, GITHUB_OUTPUT: output },
    encoding: 'utf8',
  });
  const outputs = Object.fromEntries(fs.readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => l.split(/=(.*)/s).slice(0, 2)));
  return { status: run.status, stderr: run.stderr, outputs };
}

for (const workflow of WORKFLOWS) {
  test(`${workflow} takes a release tag`, () => {
    const r = chooseTag(workflow, 'v0.12.0');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.tag, 'v0.12.0');
    if (workflow !== 'release-github') assert.equal(r.outputs.version, '0.12.0');
    if (workflow === 'release-pypi') assert.equal(r.outputs.pyversion, '0.12.0');
  });

  test(`${workflow} takes a beta tag`, () => {
    const r = chooseTag(workflow, 'v0.12.0-beta.12');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.tag, 'v0.12.0-beta.12');
    // crates.io takes the SemVer pre-release as the crates carry it; PyPI the PEP 440 form the build writes
    if (workflow !== 'release-github') assert.equal(r.outputs.version, '0.12.0-beta.12');
    if (workflow === 'release-pypi') assert.equal(r.outputs.pyversion, '0.12.0b12');
  });

  test(`${workflow} refuses any other tag`, () => {
    for (const tag of ['0.12.0', 'v0.12', 'v0.12.0-rc.1', 'v0.12.0-beta', 'v0.12.0-beta.', 'v0.12.0-beta.1x', 'v0.12.0-beta.1.2', 'v0.12.0b1', 'go/v0.12.0', 'v0.12.0\nv0.13.0', ' v0.12.0', '']) {
      const r = chooseTag(workflow, tag);
      assert.notEqual(r.status, 0, JSON.stringify(tag));
      assert.match(r.stderr, /is not a release tag \(vX\.Y\.Z\) or a beta tag \(vX\.Y\.Z-beta\.N\)/, JSON.stringify(tag));
      assert.deepEqual(r.outputs, {}, JSON.stringify(tag));
    }
  });
}

// release-npm stays a maintainer's choice for a beta: a pushed beta tag starts no job, a pushed release tag does
test('release-npm runs for a pushed release tag, and for a beta only by hand', () => {
  const text = fs.readFileSync(path.join(root, '.github/workflows/release-npm.yml'), 'utf8');
  assert.match(text, /^\s+if: github\.event_name == 'workflow_dispatch' \|\| !contains\(github\.ref_name, '-'\)$/m);
});
