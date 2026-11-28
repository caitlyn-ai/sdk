// What each published package is built from: the files whose change changes what a user installs. A release, stable
// or beta, happens if and only if one of them changed (CONTRIBUTING.md, "What makes a release"):
//   - scripts/release-analyzer.mjs, semantic-release's commit analyzer, releases only when a commit since the last
//     release changed a package input, and then at least a patch;
//   - scripts/model-main.sh tags a beta only when a regenerated package differs from main;
//   - changes:check (scripts/release-notes.mjs check) fails a releasing title that changes no package input, and a
//     non-releasing title that changes one.
// Tests, test data, docs, tooling and CI are never package inputs. The versions are one line for every package
// (VERSION), so a change to any one package releases them all.
//
//   node scripts/package-inputs.mjs list                       each package and its inputs (paths and directories)
//   node scripts/package-inputs.mjs changed <from> [<to>]       the packages whose inputs differ between two commits
//                                                               (<to> defaults to the working tree, untracked files too)
//   node scripts/package-inputs.mjs verify                      checks the inputs against what the packaging tools
//                                                               say each package ships: cargo package --list, uv build,
//                                                               go list (the toolchain image; CI job release:package-inputs)
//
// The inputs come from the packages' own manifests where they say it: the Python wheels' `packages` and `readme`
// (pyproject.toml), the npm packages' TypeScript sources (typescript/build-config, the declarations' rootDir) and the
// files the build copies in (typescript/scripts/build-packages.mjs). The rest are listed here, and `verify` fails when
// a tool reports a shipped file they don't cover. The Go module and the CLI are wider than what they ship: every
// non-test file under go/ and cli/ counts, apart from the CLI's eval and test tools, so a new package needs no change
// here.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

/** Never a package input, in any package: tests, test data and test helpers. */
const TESTS = [/(^|\/)[^/]*_test\.go$/, /(^|\/)testdata\//, /\.test\.[cm]?[jt]sx?$/, /(^|\/)tests?\//, /(^|\/)test_[^/]*\.py$/, /(^|\/)conftest\.py$/];
/** The licence files the npm build and the CLI's archives copy in from the repository's root. */
const LICENCE = ['LICENSE', 'NOTICE'];

/** A pyproject.toml's wheel packages and readme, as paths from the repository root. */
function pythonInputs(dir) {
  const toml = read(`${dir}/pyproject.toml`);
  const wheel = /\[tool\.hatch\.build\.targets\.wheel\]\npackages = \[([^\]]*)\]/.exec(toml);
  if (!wheel) throw new Error(`${dir}/pyproject.toml: no [tool.hatch.build.targets.wheel] packages`);
  const packages = [...wheel[1].matchAll(/"([^"]+)"/g)].map((m) => `${dir}/${m[1]}/`);
  const readme = /^readme = "([^"]+)"$/m.exec(toml)?.[1];
  return [`${dir}/pyproject.toml`, ...(readme ? [`${dir}/${readme}`] : []), ...packages];
}

/** An npm package's inputs: its package.json, the sources its declarations' tsconfig compiles, and what the build copies in. */
function npmInputs(name) {
  const config = JSON.parse(read(`typescript/build-config/${name}.json`));
  const sources = config.include.map((p) => `${path.posix.normalize(path.posix.join('typescript/build-config', p))}/`);
  return [
    `typescript/packages/${name}/package.json`,
    `typescript/build-config/${name}.json`,
    ...sources,
    // The build and the tools that shape its output: esbuild and rollup (typescript/package.json and its lock), the
    // build script and its plugins, and the README the build copies into each package
    'typescript/package.json',
    'typescript/package-lock.json',
    'typescript/README.md',
    'typescript/scripts/build-packages.mjs',
    'typescript/scripts/browser-plugins.mjs',
    'typescript/scripts/check-runtime-schemas.mjs',
    ...LICENCE,
  ];
}

/** A crate's inputs: its directory (cargo package ships Cargo.toml, README.md, build.rs and src/), the workspace's
 * Cargo.toml (the version, edition and licence it inherits) and the lock file cargo package ships with it. */
const crateInputs = (dir) => [`${dir}/`, 'rust/Cargo.toml', 'rust/Cargo.lock'];

/** Every package: { name, registry, inputs, exclude }. `inputs` are paths, a trailing / for a directory. */
export function packages() {
  return [
    { name: '@caitlyn-ai/sdk-core', registry: 'npm', inputs: npmInputs('sdk-core'), exclude: [] },
    { name: '@caitlyn-ai/sdk', registry: 'npm', inputs: npmInputs('sdk'), exclude: [] },
    { name: 'caitlyn-core', registry: 'PyPI', inputs: pythonInputs('python/caitlyn-core'), exclude: [] },
    { name: 'caitlyn', registry: 'PyPI', inputs: pythonInputs('python/caitlyn'), exclude: [] },
    { name: 'caitlyn-sdk-core', registry: 'crates.io', inputs: crateInputs('rust/caitlyn-sdk-core'), exclude: [] },
    { name: 'caitlyn-sdk', registry: 'crates.io', inputs: crateInputs('rust/caitlyn-sdk'), exclude: [] },
    // The module zip carries go/ whole, _test.go files too (Go offers no way to leave them out), but no one's build
    // compiles them, so they don't count
    { name: 'github.com/caitlyn-ai/sdk/go', registry: 'Go', inputs: ['go/'], exclude: [] },
    // The binary (cli/, and the Go SDK through go.mod's replace), its archives and packages (README, completions, the
    // licence files), its image (Dockerfile), the integrations and install scripts it publishes, and the release
    // scripts that lay them out. Not: the agent evals, the end-to-end tests, and the scripts that only check a key
    // or test the installer.
    {
      name: 'caitlyn (the CLI)',
      registry: 'build.caitlyn.ai, Homebrew, Scoop, ghcr.io',
      inputs: ['cli/', 'go/', ...LICENCE],
      exclude: [/^cli\/agent-eval\//, /^cli\/internal\/e2e\//, /^cli\/scripts\/test-/, /^cli\/scripts\/[^/]*-check\.sh$/, /(^|\/)\.gitignore$/],
    },
  ];
}

/** Whether `file` (a path from the repository root) is one of `pkg`'s inputs. */
export function isInput(pkg, file) {
  if (TESTS.some((re) => re.test(file)) || pkg.exclude.some((re) => re.test(file))) return false;
  return pkg.inputs.some((p) => (p.endsWith('/') ? file.startsWith(p) : file === p));
}

/** The packages any of `files` is an input of: [{ name, files }], in packages() order. */
export function touched(files, all = packages()) {
  return all.map((pkg) => ({ name: pkg.name, files: files.filter((f) => isInput(pkg, f)) })).filter((p) => p.files.length);
}

const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, '');
const lines = (s) => s.split('\n').filter(Boolean);

/** The files that differ between two commits, or between a commit and the working tree (untracked files too). */
export function changedFiles(from, to = null, cwd = root) {
  if (to) return lines(git(['diff', '--name-only', '--no-renames', from, to], cwd));
  return [...new Set([...lines(git(['diff', '--name-only', '--no-renames', from], cwd)), ...lines(git(['ls-files', '--others', '--exclude-standard'], cwd))])];
}

/** The files a commit changed (none for a merge: its changes are its parents' commits). */
export const commitFiles = (hash, cwd = root) => lines(git(['diff-tree', '--no-commit-id', '--name-only', '--no-renames', '-r', hash], cwd));

// ------------------------------------------------------------------------------------------------ verify

/**
 * The files a tool reports shipping, as paths from the repository root, that are this repository's own (`tracked`,
 * from `git ls-files`) and no package input of `pkg`. Anything else is external: a module in Go's module cache or
 * build cache, a crate in cargo's registry, wherever they are (in CI, GOMODCACHE and the other caches are under
 * .cache/ in the project directory), and nothing a commit here can change.
 */
export const uncovered = (pkg, files, tracked) => files.filter((f) => tracked.has(f) && !isInput(pkg, f));
/** The repository's own files: what `git ls-files` lists. */
export const trackedFiles = (cwd = root) => new Set(lines(git(['ls-files'], cwd)));

function verify() {
  const problems = [];
  const tracked = trackedFiles();
  const all = packages();
  const pkg = (name) => all.find((p) => p.name === name);
  // Rust: cargo package --list, which names the crate's files from its own directory
  for (const [name, dir] of [['caitlyn-sdk-core', 'rust/caitlyn-sdk-core'], ['caitlyn-sdk', 'rust/caitlyn-sdk']]) {
    const listed = lines(execFileSync('cargo', ['package', '--list', '--allow-dirty', '-p', name], { cwd: path.join(root, 'rust'), encoding: 'utf8' }));
    const files = listed.filter((f) => !['.cargo_vcs_info.json', 'Cargo.toml.orig'].includes(f)).map((f) => (f === 'Cargo.lock' ? 'rust/Cargo.lock' : `${dir}/${f}`));
    for (const f of uncovered(pkg(name), files, tracked)) problems.push(`${name}: cargo package ships ${f}, which is no input of it`);
    for (const f of files.filter((f) => tracked.has(f) && TESTS.some((re) => re.test(f)))) problems.push(`${name}: cargo package ships the test file ${f}`);
  }
  // Python: the sdist and the wheel uv builds
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  const out = fs.mkdtempSync(path.join(root, 'build', 'package-inputs-'));
  try {
    for (const [name, dir] of [['caitlyn-core', 'python/caitlyn-core'], ['caitlyn', 'python/caitlyn']]) {
      execFileSync('uv', ['build', '-q', '--package', name, '--out-dir', path.join(out, name)], { cwd: path.join(root, 'python') });
      for (const file of fs.readdirSync(path.join(out, name))) {
        if (file === '.gitignore') continue;
        const archive = path.join(out, name, file);
        const entries = file.endsWith('.whl')
          ? lines(execFileSync('python3', ['-c', 'import sys, zipfile; print("\\n".join(zipfile.ZipFile(sys.argv[1]).namelist()))', archive], { encoding: 'utf8' })).filter((e) => !e.includes('.dist-info/'))
          : lines(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' })).map((e) => e.split('/').slice(1).join('/')).filter((e) => e && !e.endsWith('/') && !['PKG-INFO', '.gitignore'].includes(e));
        // A wheel's paths are the package's own (caitlyn_core/…), found under the wheel's `packages` directories
        const files = entries.map((e) => {
          if (!file.endsWith('.whl')) return `${dir}/${e}`;
          const base = pkg(name).inputs.find((p) => p.endsWith('/') && e.startsWith(`${path.posix.basename(p.slice(0, -1))}/`));
          return base ? `${base.slice(0, -1).replace(/[^/]+$/, '')}${e}` : `${dir}/${e}`;
        });
        for (const f of uncovered(pkg(name), files, tracked)) problems.push(`${name}: ${file} ships ${f}, which is no input of it`);
        for (const f of files.filter((f) => tracked.has(f) && TESTS.some((re) => re.test(f)))) problems.push(`${name}: ${file} ships the test file ${f}`);
      }
    }
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
  // Go: every file of every package the CLI's binary and the Go module are built from, as go list says
  const goFiles = (dir, pattern) =>
    lines(execFileSync('go', ['list', ...(pattern === './cmd/caitlyn' ? ['-deps'] : []), '-f', '{{if not .Standard}}{{range .GoFiles}}{{$.Dir}}/{{.}}\n{{end}}{{range .EmbedFiles}}{{$.Dir}}/{{.}}\n{{end}}{{end}}', pattern], { cwd: path.join(root, dir), encoding: 'utf8' }))
      .filter((f) => f.startsWith(`${root}/`))
      .map((f) => path.relative(root, f));
  for (const f of uncovered(pkg('caitlyn (the CLI)'), goFiles('cli', './cmd/caitlyn'), tracked)) problems.push(`the CLI: go build compiles ${f}, which is no input of it`);
  for (const f of uncovered(pkg('github.com/caitlyn-ai/sdk/go'), goFiles('go', './...'), tracked)) problems.push(`the Go module: ${f} is in it, but no input of it`);
  // npm: the declarations' sources are the package's own
  for (const name of ['sdk-core', 'sdk']) {
    const src = `typescript/packages/${name}/src/`;
    if (!pkg(`@caitlyn-ai/${name}`).inputs.includes(src)) problems.push(`@caitlyn-ai/${name}: its sources, ${src}, are not its input`);
  }
  if (problems.length) {
    console.error(`package-inputs: ${problems.length} shipped file(s) not covered:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`package-inputs: every file cargo, uv and go list report shipping is an input of its package (${all.length} packages)`);
}

// ------------------------------------------------------------------------------------------------ the commands

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const [cmd, from, to] = process.argv.slice(2);
  if (cmd === 'list') {
    for (const p of packages()) console.log(`${p.name} (${p.registry})\n  ${p.inputs.join('\n  ')}${p.exclude.length ? `\n  except ${p.exclude.map(String).join(', ')}` : ''}`);
  } else if (cmd === 'changed' && from) {
    const hit = touched(changedFiles(from, to ?? null));
    for (const p of hit) console.log(`${p.name}: ${p.files.slice(0, 5).join(', ')}${p.files.length > 5 ? `, and ${p.files.length - 5} more` : ''}`);
    if (!hit.length) console.error(`package-inputs: no package input differs from ${from}${to ? ` at ${to}` : ' in the working tree'}`);
  } else if (cmd === 'verify') {
    verify();
  } else {
    console.error('Usage: node scripts/package-inputs.mjs list | changed <from> [<to>] | verify');
    process.exit(2);
  }
}
