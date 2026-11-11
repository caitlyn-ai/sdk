// Checks that each language's conformance harness ran every case in conformance/cases/protocol.json and
// conformance/cases/examples.json, and that each passed, from the reports the harnesses write:
//   build/conformance/typescript.xml   node --test, JUnit reporter
//   build/conformance/python.xml       pytest --junitxml
//   build/conformance/go.json          go test -json
//   build/conformance/rust.json        the Rust harness's own report: {"results": {"<test name>": passed}}
// Prints a table of counts and exits non-zero when a case is missing or failed in any language given.
// Usage: node scripts/check-conformance.mjs [typescript] [python] [go] [rust]   (default: all four)
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const read = (p) => JSON.parse(fs.readFileSync(path.join(root, p), 'utf8'));
const protocol = read('conformance/cases/protocol.json').cases.map((c) => c.id);
const examples = read('conformance/cases/examples.json').cases.map((c) => c.id);

const unescape = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** JUnit XML: testcase name -> passed (no <failure>, <error> or <skipped> inside). */
function junit(file) {
  const xml = fs.readFileSync(file, 'utf8');
  const out = new Map();
  for (const m of xml.matchAll(/<testcase\b((?:[^>"]|"[^"]*")*?)(\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = unescape(/\bname="([^"]*)"/.exec(m[1])[1]);
    out.set(name, !/<(failure|error|skipped)\b/.test(m[3] ?? ''));
  }
  return out;
}

/** go test -json: test name -> passed. */
function goJson(file) {
  const out = new Map();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const e = JSON.parse(line);
    if (e.Test && (e.Action === 'pass' || e.Action === 'fail' || e.Action === 'skip')) out.set(e.Test, e.Action === 'pass');
  }
  return out;
}

/** The Rust harness's report: test name -> passed. */
const rustJson = (file) => new Map(Object.entries(JSON.parse(fs.readFileSync(file, 'utf8')).results));

// Each language names its tests differently; these find a case's test.
const languages = {
  typescript: {
    report: 'build/conformance/typescript.xml',
    load: junit,
    protocol: (results, id) => [...results].find(([n]) => n.startsWith(`[${id}] `)),
    example: (results, id) => [...results].find(([n]) => n === `[example] ${id}`),
  },
  python: {
    report: 'build/conformance/python.xml',
    load: junit,
    protocol: (results, id) => [...results].find(([n]) => n.endsWith(`[[${id}]]`)),
    example: (results, id) => [...results].find(([n]) => n === `test_example[[example] ${id}]`),
  },
  go: {
    report: 'build/conformance/go.json',
    load: goJson,
    protocol: (results, id) => [...results].find(([n]) => n === `TestProtocol/${id}`),
    // go test writes spaces in subtest names as underscores.
    example: (results, id) => [...results].find(([n]) => n === `TestExamples/${id.replaceAll(' ', '_')}`),
  },
  rust: {
    report: 'build/conformance/rust.json',
    load: rustJson,
    protocol: (results, id) => [...results].find(([n]) => n.startsWith(`[${id}] `)),
    example: (results, id) => [...results].find(([n]) => n === `[example] ${id}`),
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(languages);
let failed = false;
const rows = [];
for (const lang of wanted) {
  const l = languages[lang];
  if (!l) throw new Error(`Unknown language ${lang}`);
  const file = path.join(root, l.report);
  if (!fs.existsSync(file)) {
    console.error(`${lang}: no report at ${l.report}; run its conformance first`);
    failed = true;
    continue;
  }
  const results = l.load(file);
  const count = (ids, find) => {
    let pass = 0;
    const problems = [];
    for (const id of ids) {
      const hit = find(results, id);
      if (!hit) problems.push(`missing: ${id}`);
      else if (!hit[1]) problems.push(`failed: ${id}`);
      else pass++;
    }
    return { pass, problems };
  };
  const p = count(protocol, l.protocol);
  const e = count(examples, l.example);
  const extra = [...results.values()].filter(Boolean).length;
  rows.push([lang, `${p.pass}/${protocol.length}`, `${e.pass}/${examples.length}`, String(extra)]);
  for (const problem of [...p.problems, ...e.problems]) console.error(`${lang}: ${problem}`);
  if (p.problems.length || e.problems.length) failed = true;
}
const header = ['language', 'protocol cases', 'example cases', 'tests passed (all)'];
const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
for (const r of [header, ...rows]) console.log(r.map((c, i) => c.padEnd(widths[i])).join('  '));
process.exit(failed ? 1 : 0);
