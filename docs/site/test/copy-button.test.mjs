// The code blocks' copy button (Expressive Code's, styled in src/styles/components.css) is one rounded square at rest and
// on hover, never clipped: its icon (::after, a mask) has no radius of its own to cut its corners, nothing on the button
// hides its overflow, and it sits inside the block (a positive inset that leaves its 32px box within the frame).
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = ['caitlyn.css', 'components.css', 'custom.css'].map((f) => fs.readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8')).join('\n').replace(/\/\*[\s\S]*?\*\//g, '');
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const copyRules = rules.filter((r) => /\.copy\b/.test(r.selector) && /expressive-code/.test(r.selector));

test('the copy icon is never cut by a radius, and nothing on the button hides its overflow', () => {
  assert.ok(copyRules.length > 0);
  for (const r of copyRules) {
    for (const sel of r.selector.split(',')) if (/::after\s*$/.test(sel.trim())) assert.doesNotMatch(r.body, /border-radius/, `${sel.trim()} rounds the icon's mask, cutting its corners`);
    assert.doesNotMatch(r.body, /overflow:\s*(hidden|clip)/, r.selector);
  }
});

test('the button is one rounded square, at rest and on hover, inside the block', () => {
  const button = copyRules.find((r) => /\.copy button\s*$/.test(r.selector));
  assert.match(button.body, /width:\s*32px/);
  assert.match(button.body, /height:\s*32px/);
  assert.match(button.body, /border-radius:\s*var\(--caitlyn-radius-button\)/);
  for (const part of ['::before', ' div']) {
    const r = copyRules.find((x) => x.selector.endsWith(`.copy button${part}`));
    assert.ok(r, `no rule for the button's ${part.trim()}`);
    assert.match(r.body, /border-radius:\s*var\(--caitlyn-radius-button\)/, `the button's ${part.trim()} is another shape`);
  }
  const place = copyRules.find((r) => /\.copy\s*$/.test(r.selector));
  for (const side of ['inset-block-start', 'inset-inline-end']) {
    const v = new RegExp(`${side}:\\s*(\\d+)px`).exec(place.body)?.[1];
    assert.ok(v !== undefined && Number(v) > 0, `the button's ${side} leaves it at or past the block's edge`);
  }
});
