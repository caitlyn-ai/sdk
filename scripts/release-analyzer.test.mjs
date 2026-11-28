// Tests for the package rule: scripts/package-inputs.mjs (what each package is built from) and
// scripts/release-analyzer.mjs (semantic-release's analyzer: a release if and only if a package input changed). The
// CI job release:scripts runs it:
//   node --test scripts/release-analyzer.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { isInput, packages, touched, trackedFiles, uncovered } from './package-inputs.mjs';
import { analyze, analyzeCommits, commitBump } from './release-analyzer.mjs';

const root = path.resolve(import.meta.dirname, '..');
const names = (files) => touched(files).map((p) => p.name);

test('a package input is what a build of the package uses, never its tests, test data, docs or tooling', () => {
  assert.deepEqual(names(['rust/caitlyn-sdk-core/src/client.rs']), ['caitlyn-sdk-core']);
  assert.deepEqual(names(['python/caitlyn-core/src/caitlyn_core/_retry.py']), ['caitlyn-core']);
  assert.deepEqual(names(['typescript/packages/sdk/src/CaitlynClient.ts']), ['@caitlyn-ai/sdk']);
  // The Go SDK is the module and part of the CLI's binary (cli/go.mod's replace)
  assert.deepEqual(names(['go/api_agents.go']), ['github.com/caitlyn-ai/sdk/go', 'caitlyn (the CLI)']);
  assert.deepEqual(names(['cli/internal/spec/commands.json']), ['caitlyn (the CLI)']);
  // Shared: the licence files the npm build and the CLI's archives copy in, and the npm build's tools
  assert.deepEqual(names(['LICENSE']), ['@caitlyn-ai/sdk-core', '@caitlyn-ai/sdk', 'caitlyn (the CLI)']);
  assert.deepEqual(names(['typescript/package-lock.json']), ['@caitlyn-ai/sdk-core', '@caitlyn-ai/sdk']);
  assert.deepEqual(names(['rust/Cargo.toml']), ['caitlyn-sdk-core', 'caitlyn-sdk']);
  for (const file of [
    'go/core/version_test.go',
    'cli/internal/ui/testdata/golden/list/plain.txt',
    'cli/internal/auth/auth_test.go',
    'cli/internal/e2e/e2e.go',
    'cli/agent-eval/eval.mjs',
    'cli/scripts/test-install-ps1.ps1',
    'cli/scripts/cosign-key-check.sh',
    'typescript/test/runtime.test.ts',
    'conformance/go/mock_test.go',
    'conformance/cases/examples.json',
    'docs/getting-started.md',
    'docs/cli/tree.json',
    'model/model.json',
    'model/model.lock.json',
    'changes/the-caitlyn-cli.md',
    'scripts/model-main.sh',
    'codegen/smithy-build.json',
    '.gitlab-ci.yml',
    '.github/workflows/release-npm.yml',
    'CONTRIBUTING.md',
    'CHANGELOG.md',
    'examples/rust/Cargo.lock',
  ]) {
    assert.deepEqual(names([file]), [], `${file} counts as a package input`);
  }
});

test("the inputs come from the packages' manifests: the Python wheels' packages and the npm declarations' sources", () => {
  const core = packages().find((p) => p.name === 'caitlyn-core');
  assert.ok(core.inputs.includes('python/caitlyn-core/src/caitlyn_core/'), core.inputs.join());
  assert.ok(core.inputs.includes('python/caitlyn-core/README.md'));
  const sdk = packages().find((p) => p.name === '@caitlyn-ai/sdk');
  assert.ok(sdk.inputs.includes('typescript/packages/sdk/src/'), sdk.inputs.join());
  // Every listed input exists
  for (const p of packages()) for (const i of p.inputs) assert.ok(fs.existsSync(path.join(root, i)), `${p.name}: ${i} does not exist`);
  assert.ok(isInput(sdk, 'typescript/packages/sdk/src/models/models_0.ts'));
  assert.ok(!isInput(sdk, 'typescript/packages/sdk/src/models/models_0.test.ts'));
});

const files = {
  docs: ['docs/getting-started.md', 'changes/x.md'],
  tooling: ['scripts/model-main.sh', '.gitlab-ci.yml'],
  tests: ['conformance/go/conformance_test.go', 'go/core/version_test.go'],
  rust: ['rust/caitlyn-sdk-core/src/client.rs'],
  python: ['python/caitlyn/caitlyn/_client.py'],
};
const commit = (hash, message) => ({ hash, message });
const run = (commits, lastVersion = '0.11.0') => analyze(commits, { filesOf: (h) => files[h], lastVersion }).type;

test('only a commit that changed a package input makes a release: a fix to the docs, the tooling or the tests makes none', () => {
  assert.equal(run([commit('docs', 'fix(docs): a typo')]), null);
  assert.equal(run([commit('tooling', 'feat: a faster model:main')]), null);
  assert.equal(run([commit('tests', 'fix: a flaky test')]), null);
  assert.equal(run([commit('docs', 'feat!: drop a page')]), null);
  assert.equal(run([commit('docs', 'docs(model): the model of app commit e2b58500d962, which changes no package')]), null);
  assert.equal(run([]), null);
});

test("a commit that changed a package input sets the bump by its type, and the others' types don't count", () => {
  assert.equal(run([commit('rust', 'fix(rust): retry a 503')]), 'patch');
  assert.equal(run([commit('rust', 'perf: fewer allocations')]), 'patch');
  assert.equal(run([commit('python', 'feat(python): pages')]), 'minor');
  // Before 1.0 a breaking change is minor, after it major
  assert.equal(run([commit('python', 'feat(python)!: pages')]), 'minor');
  assert.equal(run([commit('python', 'fix: pages\n\nBREAKING CHANGE: the cursor is gone')], '1.2.0'), 'major');
  // A feat that only changed the docs doesn't raise a fix to minor
  assert.equal(run([commit('docs', 'feat(docs): a new guide'), commit('rust', 'fix(rust): retry a 503')]), 'patch');
  // A package change under a type that makes no release is still one (changes:check refuses such a title)
  assert.equal(run([commit('rust', 'chore: bump reqwest')]), 'patch');
  assert.equal(commitBump('Merge branch \'x\' into \'main\''), null);
});

test('semantic-release uses this analyzer, and it says in the log why it releases or not', async () => {
  const releaserc = fs.readFileSync(path.join(root, '.releaserc.yml'), 'utf8');
  assert.match(releaserc, /^plugins:\n {2}- '\.\/scripts\/release-analyzer\.mjs'$/m);
  assert.doesNotMatch(releaserc, /^\s+-( -)? '@semantic-release\/commit-analyzer'$/m);
  const logged = [];
  const type = await analyzeCommits({}, { commits: [], lastRelease: { version: '0.11.0' }, logger: { log: (m) => logged.push(m) } });
  assert.equal(type, null);
  assert.match(logged.join('\n'), /No package input changed since the last release: no release\./);
});

test("verify counts only this repository's own files: a module cache inside the project, as CI has it, is external", () => {
  const cli = packages().find((p) => p.name === 'caitlyn (the CLI)');
  const tracked = trackedFiles();
  // What go list -deps reports in CI, where GOMODCACHE and GOCACHE are under .cache/ in the project directory
  const reported = [
    'cli/cmd/caitlyn/main.go',
    '.cache/go-mod/golang.org/x/text@v0.44.0/unicode/norm/normalize.go',
    '.cache/go-mod/github.com/spf13/cobra@v1.10.1/command.go',
    '.cache/go-build/ab/abcdef-d',
    'build/rust-target/debug/build/ring/out/generated.rs',
  ];
  assert.deepEqual(uncovered(cli, reported, tracked), []);
  // A file of this repository's own that the list doesn't cover is still reported
  assert.deepEqual(uncovered(cli, ['cli/cmd/caitlyn/main.go', 'scripts/model-main.sh'], tracked), ['scripts/model-main.sh']);
});
