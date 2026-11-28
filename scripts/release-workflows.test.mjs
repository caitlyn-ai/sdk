// Tests for the GitHub release workflows' tag check (.github/workflows/release-pypi.yml, release-crates.yml,
// release-github.yml and release-npm.yml), which decides what each one publishes: a release tag vX.Y.Z, or a beta tag vX.Y.Z-beta.N
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
const WORKFLOWS = ['release-pypi', 'release-crates', 'release-github', 'release-npm'];
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
    if (['release-pypi', 'release-crates'].includes(workflow)) assert.equal(r.outputs.version, '0.12.0');
    if (workflow === 'release-pypi') assert.equal(r.outputs.pyversion, '0.12.0');
    if (workflow === 'release-npm') assert.equal(r.outputs.dist_tag, 'latest');
  });

  test(`${workflow} takes a beta tag`, () => {
    const r = chooseTag(workflow, 'v0.12.0-beta.12');
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.outputs.tag, 'v0.12.0-beta.12');
    // crates.io takes the SemVer pre-release as the crates carry it; PyPI the PEP 440 form the build writes
    if (['release-pypi', 'release-crates'].includes(workflow)) assert.equal(r.outputs.version, '0.12.0-beta.12');
    if (workflow === 'release-pypi') assert.equal(r.outputs.pyversion, '0.12.0b12');
    // npm stages a beta under `beta`, so `latest` stays the last stable release
    if (workflow === 'release-npm') assert.equal(r.outputs.dist_tag, 'beta');
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

// release-npm stages every release and beta tag pushed, as the others publish them: no condition on the job stops a
// beta. The tag check above is what refuses any other tag. Each stage step names the dist-tag the check chose.
test('release-npm runs for every pushed tag and by hand, and stages under the dist-tag the tag check chose', () => {
  const text = fs.readFileSync(path.join(root, '.github/workflows/release-npm.yml'), 'utf8');
  assert.match(text, /^on:\n  push:\n    tags: \['v\*\.\*\.\*'\]\n  workflow_dispatch:\n/m);
  const job = text.slice(text.indexOf('\n  stage:\n'));
  assert.doesNotMatch(job.split('\n    steps:\n')[0], /^\s+if:/m, 'the stage job has a condition');
  const stages = [...text.matchAll(/^\s+run: npm stage publish .*--tag "\$DIST_TAG"\n\s+env:\n\s+DIST_TAG: \$\{\{ steps\.tag\.outputs\.dist_tag \}\}$/gm)];
  assert.equal(stages.length, 2, 'both packages stage under the chosen dist-tag');
  assert.equal([...text.matchAll(/^\s+run: npm stage publish/gm)].length, 2, 'a stage step names no dist-tag, or names another');
});
