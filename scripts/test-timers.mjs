#!/usr/bin/env node
// Every timer in a test is deterministic (CONTRIBUTING.md, "Tests and time"): a test waits on events, not on the
// wall clock, and never bounds how long something took in real time. This finds the wall clock in the repository's
// tests: sleeps, timers and clock reads in the CLI's and the SDKs' tests, the conformance harnesses and the mock
// server. A use that is right (virtual time inside synctest, say) carries a `timers:` comment saying why, on its
// line or the line above.
//
// Today's uses are counted per file in scripts/test-timers-baseline.json, a ratchet: no file may have more than
// its baseline, a new file has none, and a file that has fewer must have its baseline lowered with it, so the
// count only ever goes down.
//
//   node scripts/test-timers.mjs            check against the baseline (CI's tests:timers job)
//   node scripts/test-timers.mjs --list     every use, file by file
//   node scripts/test-timers.mjs --update   write today's counts as the baseline (review the diff: it may only go down)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const BASELINE = path.join(root, 'scripts', 'test-timers-baseline.json');

/** The wall clock in each language's tests: sleeps and timers, and reads of the clock (to measure or bound time). */
export const PATTERNS = {
  go: /\btime\.(?:Sleep|After|AfterFunc|NewTimer|NewTicker|Tick|Since|Until)\(/,
  js: /\bset(?:Timeout|Interval)\s*\(|\bDate\.now\(\)|\bperformance\.now\(\)|(?:^|[^.\w])sleep\s*\(/,
  py: /\b(?:asyncio|time)\.sleep\(|\btime\.(?:monotonic|time|perf_counter)\(\)|(?:^|[^.\w])(?:monotonic|perf_counter)\(\)/,
  rs: /\bsleep\(|\bInstant::now\(\)|\.elapsed\(\)/,
};

/** Which files are tests, and their language. Rust's are its test folders and the `#[cfg(test)]` part of a source. */
export function language(file) {
  // This check's own tests hold sample code with timers in it, as text
  if (file === 'scripts/test-timers.test.mjs') return null;
  if (file.endsWith('_test.go')) return 'go';
  if (/(^|\/)conformance\/mock-server\/.*\.m?js$/.test(file)) return 'js';
  if (/\.test\.(?:ts|mts|js|mjs)$/.test(file) || /(^|\/)conformance\/typescript\/.*\.(?:ts|mts)$/.test(file) || /^typescript\/test\/.*\.ts$/.test(file)) return 'js';
  if (/(^|\/)(?:test_[^/]*|[^/]*_test)\.py$/.test(file) || /(^|\/)tests?\/.*\.py$/.test(file) || /^conformance\/python\/.*\.py$/.test(file)) return 'py';
  if (/(^|\/)tests\/.*\.rs$/.test(file) || /^conformance\/rust\/.*\.rs$/.test(file)) return 'rs';
  if (/^rust\/.*\/src\/.*\.rs$/.test(file)) return 'rs-src';
  return null;
}

const COMMENT = /(?:\/\/|#)\s*timers:\s*\S/;

/** The wall-clock uses in one file's text: [{ line, text }], leaving out those a `timers:` comment explains. */
export function uses(text, lang) {
  const lines = text.split('\n');
  let from = 0;
  if (lang === 'rs-src') {
    // Only a source file's tests: from its `#[cfg(test)]` on. The SDK's own retries and waits are production code.
    from = lines.findIndex((l) => /^\s*#\[cfg\(test\)\]/.test(l));
    if (from < 0) return [];
    lang = 'rs';
  }
  const found = [];
  for (let i = from; i < lines.length; i++) {
    const l = lines[i];
    // The code before any comment on the line: `#` in Python, `//` elsewhere (a URL's `//` in a string is rare in tests)
    const code = lang === 'py' ? l.replace(/#.*$/, '') : l.replace(/\/\/.*$/, '');
    if (!PATTERNS[lang].test(code)) continue;
    let prev = i - 1;
    while (prev >= 0 && !lines[prev].trim()) prev--;
    if (COMMENT.test(l) || (prev >= 0 && COMMENT.test(lines[prev]))) continue;
    found.push({ line: i + 1, text: l.trim() });
  }
  return found;
}

/** Every tracked test file's uses: { file: [{ line, text }] }, for files that have any. */
export function scan() {
  const files = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\n').filter(Boolean);
  const out = {};
  for (const file of files) {
    const lang = language(file);
    if (!lang) continue;
    const found = uses(fs.readFileSync(path.join(root, file), 'utf8'), lang);
    if (found.length) out[file] = found;
  }
  return out;
}

/** The ratchet: a file over its baseline (or new with any) fails, and so does a baseline higher than today's count. */
export function compare(found, baseline) {
  const over = [];
  const lower = [];
  for (const [file, list] of Object.entries(found)) {
    const allowed = baseline[file] ?? 0;
    if (list.length > allowed) over.push({ file, count: list.length, allowed, uses: list });
  }
  for (const [file, allowed] of Object.entries(baseline)) {
    const count = found[file]?.length ?? 0;
    if (count < allowed) lower.push({ file, count, allowed });
  }
  return { over, lower };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const found = scan();
  const arg = process.argv[2];
  if (arg === '--list') {
    for (const [file, list] of Object.entries(found)) for (const u of list) console.log(`${file}:${u.line}: ${u.text}`);
    process.exit(0);
  }
  if (arg === '--update') {
    const counts = Object.fromEntries(Object.entries(found).sort().map(([f, l]) => [f, l.length]));
    fs.writeFileSync(BASELINE, `${JSON.stringify(counts, null, 2)}\n`);
    console.log(`test-timers: the baseline is ${Object.values(counts).reduce((a, b) => a + b, 0)} uses in ${Object.keys(counts).length} files`);
    process.exit(0);
  }
  const baseline = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : {};
  const { over, lower } = compare(found, baseline);
  for (const o of over) {
    console.error(`${o.file}: ${o.count} wall-clock uses in a test, ${o.allowed} allowed:`);
    for (const u of o.uses) console.error(`  ${o.file}:${u.line}: ${u.text}`);
  }
  for (const l of lower) console.error(`${l.file}: ${l.count} wall-clock uses, but the baseline allows ${l.allowed}: lower it (node scripts/test-timers.mjs --update)`);
  if (over.length || lower.length) {
    if (over.length) {
      console.error(
        '\nA test waits on events, not on the wall clock, and never bounds how long something took (CONTRIBUTING.md, "Tests and time"): wait on a hold, a request or a channel; use virtual time (synctest, mock.timers, a virtual-clock loop, tokio paused time) or a shorter public timeout. Where the wall clock is right, say why in a `timers:` comment on the line.',
      );
    }
    process.exit(1);
  }
  const total = Object.values(found).reduce((a, l) => a + l.length, 0);
  console.log(`test-timers: ${total} wall-clock uses in tests, none over the baseline`);
}
