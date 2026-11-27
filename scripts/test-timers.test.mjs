// The test-timers check (scripts/test-timers.mjs): what counts as the wall clock in each language's tests, what a
// `timers:` comment exempts, and the baseline's ratchet. Run: node --test scripts/test-timers.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compare, language, uses } from './test-timers.mjs';

test('the test files of each language are found, and a Rust source counts only from its #[cfg(test)]', () => {
  assert.equal(language('cli/internal/ui/components_test.go'), 'go');
  assert.equal(language('conformance/typescript/conformance.test.ts'), 'js');
  assert.equal(language('conformance/mock-server/server.mjs'), 'js');
  assert.equal(language('conformance/python/test_conformance.py'), 'py');
  assert.equal(language('conformance/rust/tests/conformance.rs'), 'rs');
  assert.equal(language('rust/caitlyn-sdk-core/src/client.rs'), 'rs-src');
  assert.equal(language('cli/internal/ui/components.go'), null, 'production code is not a test');
  assert.equal(language('python/caitlyn-core/src/caitlyn_core/_client.py'), null);
  assert.equal(language('scripts/test-timers.test.mjs'), null, "this check's own tests hold timers as sample text");
});

test('sleeps, timers and clock reads are found in each language', () => {
  assert.equal(uses('time.Sleep(20 * time.Millisecond)\n<-time.After(d)\nok := time.Since(t) < d', 'go').length, 3);
  assert.equal(uses('await new Promise((r) => setTimeout(r, 50));\nconst t = Date.now();\nperformance.now()', 'js').length, 3);
  assert.equal(uses('await asyncio.sleep(0.1)\nstart = time.monotonic()\ntime.sleep(1)', 'py').length, 3);
  assert.equal(uses('tokio::time::sleep(d).await;\nlet t = Instant::now();\nassert!(t.elapsed() < d);', 'rs').length, 3);
  assert.equal(uses('fmt.Println("release-bot#2.1.0")', 'go').length, 0, "a # in a string isn't a comment in Go");
  assert.equal(uses('let x = 1; // time.Sleep in a comment', 'go').length, 0, 'a commented-out use is not a use');
});

test('a timers: comment on the line or the line above exempts a use, and says why', () => {
  assert.equal(uses('time.Sleep(d) // timers: virtual (synctest)', 'go').length, 0);
  assert.equal(uses('// timers: virtual (synctest)\n\ntime.Sleep(d)', 'go').length, 0);
  assert.equal(uses('await asyncio.sleep(0)  # timers: yields to the loop, no wait', 'py').length, 0);
  assert.equal(uses('time.Sleep(d) // timers:', 'go').length, 1, 'an exemption gives a reason');
  assert.equal(uses('// timers: virtual\nx := 1\ntime.Sleep(d)', 'go').length, 1, 'only the line right after it');
});

test("a Rust source's production waits are left alone; its tests are not", () => {
  const src = 'async fn retry() { tokio::time::sleep(d).await; }\n#[cfg(test)]\nmod tests {\n  fn t() { std::thread::sleep(d); }\n}';
  assert.deepEqual(uses(src, 'rs-src').map((u) => u.line), [4]);
  assert.deepEqual(uses('async fn retry() { tokio::time::sleep(d).await; }', 'rs-src'), []);
});

test('the baseline is a ratchet: no file may gain a use, a new file has none, and a lower count lowers it', () => {
  const found = { 'a_test.go': [{ line: 1 }, { line: 2 }], 'b_test.go': [{ line: 3 }] };
  assert.deepEqual(compare(found, { 'a_test.go': 2, 'b_test.go': 1 }), { over: [], lower: [] });
  assert.equal(compare(found, { 'a_test.go': 1, 'b_test.go': 1 }).over[0].file, 'a_test.go');
  assert.equal(compare(found, { 'a_test.go': 2 }).over[0].file, 'b_test.go', 'a new file starts at zero');
  assert.deepEqual(compare({ 'a_test.go': [{ line: 1 }] }, { 'a_test.go': 2 }).lower, [{ file: 'a_test.go', count: 1, allowed: 2 }]);
});
