// An operation's header chips (its SDK call and HTTP line, src/components/OperationHeader.astro) never scroll: no
// stylesheet rule lets one scroll, and each is a copy button the fitting script cuts in the middle
// (src/scripts/chip-fit.ts). scripts/docs-build.mjs checks the built pages too. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const read = (f) => fs.readFileSync(new URL(`../src/${f}`, import.meta.url), 'utf8');
const css = ['styles/caitlyn.css', 'styles/components.css', 'styles/custom.css'].map(read).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('no rule lets a header chip scroll', () => {
  const chip = rules.filter((r) => /caitlyn-strip-code|caitlyn-chip|caitlyn-operation-strip/.test(r.selector));
  assert.ok(chip.length > 0);
  for (const r of chip) assert.doesNotMatch(r.body, /overflow(-x)?:\s*(auto|scroll)/, r.selector);
  assert.ok(chip.some((r) => /\.caitlyn-strip-code/.test(r.selector) && /overflow:\s*hidden/.test(r.body)), 'a header chip is not clipped');
});

test('every header chip is a copy button the fitting script cuts', () => {
  const header = read('components/OperationHeader.astro');
  const codes = (header.match(/<code class="caitlyn-strip-code">/g) ?? []).length;
  const chips = (header.match(/<button type="button" class="caitlyn-chip" data-chip=/g) ?? []).length;
  assert.ok(codes > 0);
  assert.equal(chips, codes, 'a header chip is not a copy button');
  assert.match(header, /import '\.\.\/scripts\/chip-fit\.ts'/);
});
