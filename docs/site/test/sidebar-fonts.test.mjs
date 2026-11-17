// The sidebar's entries are all in one face: the reading face, nested or not. Only an entry whose label is code itself
// (a type's name, an error code; scripts/docs-build.mjs marks it data-code-label) is in the code face. This reads the
// site's stylesheets, so a rule that puts other entries in the code face again fails here. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = ['caitlyn.css', 'components.css', 'custom.css'].map((f) => fs.readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8')).join('\n');
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));

test('no sidebar entry is in the code face but one whose label is code', () => {
  const mono = rules.filter((r) => /\.sidebar-content|starlight-sidebar|#starlight__sidebar/.test(r.selector) && /font-family:[^;]*mono/.test(r.body));
  assert.ok(mono.length > 0, 'the code face rule for code labels is gone');
  for (const r of mono) for (const sel of r.selector.split(',')) assert.match(sel, /\[data-code-label\]/, `${sel.trim()} puts sidebar entries in the code face`);
});

test('the sidebar tooltip is in the reading face', () => {
  for (const r of rules.filter((x) => /\.caitlyn-tip\b/.test(x.selector))) assert.doesNotMatch(r.body, /font-family:[^;]*mono/, r.selector);
});
