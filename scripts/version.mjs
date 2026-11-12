// The SDK version, for all four languages. The repository stores no released version: VERSION holds 0.0.0, the
// version of every build that is not a release, and a release build stamps the version of its tag
// (semantic-release on main creates the tag; .releaserc.yml).
//
//   node scripts/version.mjs stamp             writes VERSION into every hand-written file that names it, and
//                                              into the generator settings (codegen/smithy-build.json)
//   node scripts/version.mjs check [version]   fails unless every file that names the version, generated ones
//                                              included, names this one (default: VERSION's)
//   node scripts/version.mjs release <version> a release build: writes <version> into VERSION and every file that
//                                              names the version, generated ones included, then checks them
//   node scripts/version.mjs files             lists VERSION and every file that names the version, one per line
//   node scripts/version.mjs assets            fails unless .releaserc.yml's release commit and .gitlab-ci.yml's
//                                              stamp-version artifacts list exactly those files
//
// scripts/generate.sh runs `stamp` first and `check` last, so `make generate` sets VERSION's version everywhere
// and a file that disagrees fails the generation (and the CI generate job). `release` needs only Node, no
// generators: a release workflow for any registry (.github/workflows/release-npm.yml today; PyPI, Go and
// crates.io later) runs `node scripts/version.mjs release "${TAG#v}"` on a clean checkout of the tag, then builds.
// Stamping the generated files as text gives what generating at that version gives: generation writes the
// version in exactly these places.
//
// What carries the version:
//   TypeScript  the sdk-core and sdk package.json files, the npm lock file, the User-Agent and the tracer version
//   Python      the caitlyn and caitlyn-core pyproject.toml files, the caitlyn-core pin, both __version__ values
//               (the User-Agent and the tracer version), the uv lock file
//   Go          SDKVersion (the User-Agent and the tracer's instrumentation version)
//   Rust        both crates' versions, the core dependency, SDK_VERSION (the User-Agent), both Cargo.lock files
// Go module versions are git tags, so no Go file carries one apart from SDKVersion.
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const SEMVER = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const [mode, given] = process.argv.slice(2);
if (mode === 'release' && !given) {
  console.error('Usage: node scripts/version.mjs release <version>, for example 0.1.0');
  process.exit(2);
}
const version = (mode === 'stamp' ? undefined : given) ?? fs.readFileSync(path.join(root, 'VERSION'), 'utf8').trim();
if (!SEMVER.test(version)) throw new Error(`${JSON.stringify(version)} is not a semantic version`);

const V = String.raw`(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)`;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** A rule: the file, and a pattern whose one group is the version; `count` is how many matches it must have. */
const rule = (file, pattern, count = 1) => ({ file, pattern: new RegExp(pattern, 'g'), count });
const lockEntry = (name) => String.raw`\nname = "${esc(name)}"\nversion = "${V}"`;

/** Hand-written files: `stamp` rewrites them. */
const stamped = [
  rule('typescript/packages/sdk-core/package.json', String.raw`\n  "version": "${V}"`),
  rule('typescript/packages/sdk-core/src/telemetry.ts', String.raw`getTracer\('@caitlyn-ai/sdk', '${V}'\)`),
  rule('typescript/package-lock.json', String.raw`"name": "@caitlyn-ai/sdk",\n      "version": "${V}"`),
  rule('typescript/package-lock.json', String.raw`"name": "@caitlyn-ai/sdk-core",\n      "version": "${V}"`),
  rule('typescript/package-lock.json', String.raw`\n        "@caitlyn-ai/sdk-core": "${V}"`),
  rule('python/caitlyn-core/pyproject.toml', String.raw`\[project\]\nname = "caitlyn-core"\nversion = "${V}"`),
  rule('python/caitlyn-core/src/caitlyn_core/__init__.py', String.raw`\n__version__ = "${V}"`),
  rule('python/uv.lock', lockEntry('caitlyn')),
  rule('python/uv.lock', lockEntry('caitlyn-core')),
  rule('rust/Cargo.toml', String.raw`\[workspace\.package\]\nversion = "${V}"`),
  rule('rust/Cargo.lock', lockEntry('caitlyn-sdk')),
  rule('rust/Cargo.lock', lockEntry('caitlyn-sdk-core')),
  rule('conformance/rust/Cargo.lock', lockEntry('caitlyn-sdk')),
  rule('conformance/rust/Cargo.lock', lockEntry('caitlyn-sdk-core')),
  // The generators' settings: the TypeScript package version, the Python, Go and Rust SDK versions, and the
  // version of the Rust core crate the generated crate depends on.
  rule('codegen/smithy-build.json', String.raw`"packageVersion": "${V}"`),
  rule('codegen/smithy-build.json', String.raw`"distribution": "caitlyn",\n          "version": "${V}"`),
  rule('codegen/smithy-build.json', String.raw`"package": "caitlyn",\n          "version": "${V}"`),
  rule('codegen/smithy-build.json', String.raw`"crate": "caitlyn-sdk",\n          "version": "${V}"`),
  rule('codegen/smithy-build.json', String.raw`"coreVersion": "${V}"`),
];

/** Generated files: `make generate` writes them from the settings above; `check` only reads them. */
const generated = [
  rule('typescript/packages/sdk/package.json', String.raw`\n    "version": "${V}"`),
  rule('typescript/packages/sdk/package.json', String.raw`"@caitlyn-ai/sdk-core": "${V}"`),
  rule('typescript/packages/sdk/src/runtimeConfig.shared.ts', String.raw`caitlynSdkVersion: config\?\.caitlynSdkVersion \?\? "${V}"`),
  rule('python/caitlyn/pyproject.toml', String.raw`\nversion = "${V}"`),
  rule('python/caitlyn/pyproject.toml', String.raw`"caitlyn-core==${V}"`),
  rule('python/caitlyn/caitlyn/_version.py', String.raw`__version__: Final = "${V}"`),
  rule('go/version.go', String.raw`const SDKVersion = "${V}"`),
  rule('rust/caitlyn-sdk/Cargo.toml', String.raw`\nversion = "${V}"`),
  rule('rust/caitlyn-sdk/Cargo.toml', String.raw`caitlyn-sdk-core = \{ version = "${V}"`),
  rule('rust/caitlyn-sdk/src/lib.rs', String.raw`pub const SDK_VERSION: &str = "${V}";`),
];

if (mode === 'files' || mode === 'assets') {
  const files = [...new Set(['VERSION', ...[...stamped, ...generated].map((r) => r.file)])];
  if (mode === 'files') {
    console.log(files.join('\n'));
  } else {
    // The release commit (@semantic-release/git) and the stamp-version artifacts must carry every stamped file, or the
    // tag's tree would name 0.0.0 somewhere. Both lists mark their lines "# stamped".
    let failed = false;
    for (const file of ['.releaserc.yml', '.gitlab-ci.yml']) {
      const text = fs.readFileSync(path.join(root, file), 'utf8');
      const listed = new Set([...text.matchAll(/^\s+- '?([^'\s]+)'?\s*# stamped$/gm)].map((m) => m[1]));
      const missing = files.filter((f) => !listed.has(f));
      const extra = [...listed].filter((f) => !files.includes(f));
      if (missing.length || extra.length) {
        console.error(`${file}: the lines marked "# stamped" must be exactly the stamped files (node scripts/version.mjs files).\n  missing: ${missing.join(', ') || 'none'}\n  not stamped: ${extra.join(', ') || 'none'}`);
        failed = true;
      }
    }
    if (failed) process.exit(1);
    console.log(`version: the release commit and the stamp-version artifacts carry all ${files.length} stamped files`);
  }
  process.exit(0);
}

function matches(r) {
  const text = fs.readFileSync(path.join(root, r.file), 'utf8');
  const found = [...text.matchAll(r.pattern)];
  if (found.length !== r.count) throw new Error(`${r.file}: expected ${r.count} match(es) of ${r.pattern}, found ${found.length}`);
  return { text, found };
}

/** Rewrites every match of the rules to `version`. Returns the files it changed. */
function stamp(rules) {
  const changed = new Set();
  for (const r of rules) {
    const { text, found } = matches(r);
    if (found.every((m) => m[1] === version)) continue;
    const out = text.replace(r.pattern, (whole, v) => whole.slice(0, whole.lastIndexOf(v)) + version + whole.slice(whole.lastIndexOf(v) + v.length));
    fs.writeFileSync(path.join(root, r.file), out);
    changed.add(r.file);
  }
  return [...changed];
}

function check() {
  const wrong = [];
  for (const r of [...stamped, ...generated]) {
    for (const m of matches(r).found) if (m[1] !== version) wrong.push(`${r.file}: ${m[1]}`);
  }
  if (wrong.length) {
    console.error(`These files name a version other than ${version}${mode === 'check' && !given ? ' (VERSION); run make generate' : ''}:\n  ${wrong.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`version: every SDK is at ${version}`);
}

if (mode === 'stamp') {
  const changed = stamp(stamped);
  console.log(`version: ${version}${changed.length ? ` (stamped ${changed.join(', ')})` : ''}`);
} else if (mode === 'check') {
  check();
} else if (mode === 'release') {
  fs.writeFileSync(path.join(root, 'VERSION'), `${version}\n`);
  const changed = stamp([...stamped, ...generated]);
  console.log(`version: stamped ${version} into VERSION and ${changed.length} files`);
  check();
} else {
  console.error('Usage: node scripts/version.mjs stamp | check [version] | release <version>');
  process.exit(2);
}
