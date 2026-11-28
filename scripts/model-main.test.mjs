// Tests for scripts/model-main.sh, the model:main job, end to end against local repositories: a bare one standing in
// for this project on GitLab (PUSH_URL), and one standing in for the app (APP_REPO). The slow steps are stand-ins
// that do what the scenario needs: the app's model build, scripts/model-pull.sh, scripts/generate.sh,
// scripts/cli-tree.sh, the four suites, the conformance check, prepare-model and the Go tag. What is tested is the
// job's own logic: what it decides from what changed, and what it commits, tags and pushes. The CI job release:scripts
// runs it:
//   node --test scripts/model-main.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const stamped = execFileSync('node', [path.join(root, 'scripts/version.mjs'), 'files'], { encoding: 'utf8' }).trim().split('\n');
const REAL = ['scripts/model-main.sh', 'scripts/model-main-publish.sh', 'scripts/model-main-suites.sh', 'scripts/package-inputs.mjs', 'scripts/version.mjs', 'typescript/build-config/sdk-core.json', 'typescript/build-config/sdk.json', 'model/model.lock.json', ...stamped];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'model-main-'));
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
const gitconfig = path.join(tmp, 'gitconfig');
fs.writeFileSync(gitconfig, '[user]\n\tname = test\n\temail = test@example.com\n[init]\n\tdefaultBranch = main\n[protocol "file"]\n\tallow = always\n');
const baseEnv = { PATH: process.env.PATH, HOME: tmp, GIT_CONFIG_GLOBAL: gitconfig, GIT_CONFIG_NOSYSTEM: '1' };
const git = (cwd, ...args) => execFileSync('git', args, { cwd, env: baseEnv, encoding: 'utf8' }).trim();
const write = (file, text, mode = 0o644) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode });
};

// The stand-ins. SCENARIO says what the app's model changes: `lock` (nothing but the lock's provenance), `model` (the
// model, no package) or `package` (a generated package file too). FAIL names a suite that fails.
const STUBS = {
  'scripts/model-pull.sh': `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
# A prerelease pull always rewrites the lock's record of where the model came from
node -e 'const f="model/model.lock.json",l=JSON.parse(require("fs").readFileSync(f));l.source="prerelease: app "+process.env.APP_COMMIT;require("fs").writeFileSync(f,JSON.stringify(l,null,2)+"\\n")'
case "$SCENARIO" in model|package) echo '{"changes":["a trait only the docs read"]}' > model/changes/next.json ;; esac
`,
  'scripts/generate.sh': `#!/usr/bin/env bash
set -e
cd "$(dirname "$0")/.."
[ "$SCENARIO" = package ] && printf '// a new operation\\n' >> rust/caitlyn-sdk/src/lib.rs
echo generated
`,
  'scripts/cli-tree.sh': '#!/usr/bin/env bash\necho cli-tree\n',
  'scripts/prepare-model.mjs': "console.log('prepare-model');\n",
  'scripts/check-conformance.mjs': "console.log('conformance');\n",
  'scripts/go-tag.mjs': "import fs from 'node:fs';\nfs.appendFileSync(process.env.GO_TAGS, process.argv[2] + '\\n');\n",
  ...Object.fromEntries(['typescript', 'python', 'go', 'rust'].map((s) => [`scripts/test-${s}.sh`, `#!/usr/bin/env bash\necho "${s} suite ran"\n[ "$FAIL" != ${s} ] || { echo "${s}: a case failed" >&2; exit 1; }\n`])),
};

/** A fresh project (bare, with main and a v0.11.0 tag) and app; returns a run function and the paths. */
function setup(name) {
  const dir = path.join(tmp, name);
  const seed = path.join(dir, 'seed');
  for (const file of REAL) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true });
    fs.copyFileSync(path.join(root, file), path.join(seed, file));
  }
  for (const [file, text] of Object.entries(STUBS)) write(path.join(seed, file), text, 0o755);
  write(path.join(seed, '.gitignore'), '/build/\n');
  write(path.join(seed, 'model/changes/.keep'), '');
  // Stand-ins for the generated conformance cases, which model:main commits as a directory
  write(path.join(seed, 'conformance/cases/examples.json'), '[]\n');
  // Main as the release v0.11.0 left it
  execFileSync('node', ['scripts/version.mjs', 'release', '0.11.0'], { cwd: seed, stdio: 'ignore' });
  git(seed, 'init', '-q');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'main');
  git(seed, 'tag', 'v0.11.0');
  const bare = path.join(dir, 'sdk.git');
  git(dir, 'init', '-q', '--bare', bare);
  git(seed, 'push', '-q', bare, 'HEAD:refs/heads/main', 'refs/tags/v0.11.0');
  const app = path.join(dir, 'app');
  write(path.join(app, 'smithy/scripts/build.sh'), '#!/usr/bin/env bash\necho "app model built"\n', 0o755);
  write(path.join(app, 'package.json'), '{"version":"5.159.0"}\n');
  git(app, 'init', '-q');
  git(app, 'add', '-A');
  git(app, 'commit', '-q', '-m', 'app');
  const appCommit = git(app, 'rev-parse', 'HEAD');
  const job = path.join(dir, 'job');
  git(dir, 'clone', '-q', bare, job);
  const base = git(bare, 'rev-parse', 'refs/heads/main');
  const goTags = path.join(dir, 'go-tags');
  fs.writeFileSync(goTags, '');
  const run = (scenario, extra = {}) =>
    spawnSync('bash', ['scripts/model-main.sh'], {
      cwd: job,
      encoding: 'utf8',
      env: { ...baseEnv, SCENARIO: scenario, APP_COMMIT: appCommit, APP_REPO: `file://${app}`, PUSH_URL: bare, GITLAB_TOKEN: 't', CI_SERVER_HOST: 'gitlab.example', CI_PROJECT_PATH: 'g/sdk', CI_DEFAULT_BRANCH: 'main', CI_PIPELINE_ID: '1', GO_TAGS: goTags, ...extra },
    });
  return { bare, job, base, run, goTags };
}
const tags = (bare) => git(bare, 'tag', '-l').split('\n').filter(Boolean);
const files = (bare, ref) => git(bare, 'show', '--name-only', '--format=', ref).split('\n').filter(Boolean);

test("an app model main already has, with only the lock's provenance new, commits and tags nothing, and passes", () => {
  const r = setup('lock');
  const run = r.run('lock');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /changes no package and nothing in model\/ apart from the lock's record/);
  assert.equal(git(r.bare, 'rev-parse', 'refs/heads/main'), r.base, 'main moved');
  assert.deepEqual(tags(r.bare), ['v0.11.0']);
  assert.equal(fs.readFileSync(r.goTags, 'utf8'), '');
  assert.doesNotMatch(run.stdout, /suite ran/, 'the suites ran for nothing');
});

test('a model change that changes no package is committed as docs(model), with no tag', () => {
  const r = setup('model');
  const run = r.run('model');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /changes the model but no package: it is committed as docs\(model\), with no beta/);
  assert.match(git(r.bare, 'log', '-1', '--format=%s', 'main'), /^docs\(model\): the model of app commit \w{12}, which changes no package$/);
  assert.equal(git(r.bare, 'rev-parse', 'main^'), r.base);
  assert.ok(files(r.bare, 'main').includes('model/changes/next.json'));
  assert.ok(files(r.bare, 'main').includes('model/model.lock.json'));
  assert.ok(!files(r.bare, 'main').includes('VERSION'), 'the version moved');
  assert.deepEqual(tags(r.bare), ['v0.11.0']);
  assert.equal(fs.readFileSync(r.goTags, 'utf8'), '');
  for (const s of ['typescript', 'python', 'go', 'rust']) assert.match(run.stdout, new RegExp(`${s} suite ran`));
});

test('a change to a package is a beta: the commit and its tag, with every stamped file at the beta version', () => {
  const r = setup('package');
  const run = r.run('package');
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /Beta 0\.12\.0-beta\.1, from app commit \w+\. The packages it changes:\n {2}caitlyn-sdk: rust\/caitlyn-sdk\/src\/lib\.rs/);
  assert.deepEqual(tags(r.bare).sort(), ['v0.11.0', 'v0.12.0-beta.1']);
  assert.equal(git(r.bare, 'rev-parse', 'v0.12.0-beta.1^{commit}'), git(r.bare, 'rev-parse', 'main'));
  assert.match(git(r.bare, 'log', '-1', '--format=%s', 'main'), /^feat\(model\): regenerate the SDKs from app commit/);
  assert.equal(git(r.bare, 'show', 'main:VERSION'), '0.12.0-beta.1');
  assert.equal(fs.readFileSync(r.goTags, 'utf8'), '0.12.0-beta.1\n');
});

test('a suite that fails fails the job, after every suite has run, and nothing is pushed', () => {
  const r = setup('fail');
  const run = r.run('package', { FAIL: 'go' });
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /Failed: go \(their logs are above/);
  for (const s of ['typescript', 'python', 'rust']) assert.match(run.stdout, new RegExp(`${s} suite ran`), `${s} did not run to its end`);
  assert.match(run.stdout, /go: a case failed[\s\S]*go: exit 1/);
  assert.equal(git(r.bare, 'rev-parse', 'refs/heads/main'), r.base);
  assert.deepEqual(tags(r.bare), ['v0.11.0']);
});
