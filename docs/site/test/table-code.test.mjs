// Code in a table never wraps mid-identifier (Sam: on a phone, "clientCredentials" broke into "cli/ent/Cre/den/tia/ls"
// while the prose columns took the width). The site's stylesheets keep table code on one line, and no rule that
// reaches code in a table cell lets it break: a table too wide for the screen scrolls in its wrapper instead
// (src/plugins/rehype-tables.mjs, src/styles/components.css). Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const css = ['caitlyn.css', 'components.css', 'custom.css'].map((f) => fs.readFileSync(new URL(`../src/styles/${f}`, import.meta.url), 'utf8')).join('\n');
// Every rule as { selector, body }, comments removed and at-rule wrappers flattened
const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
const tableCode = (selector) => selector.split(',').some((s) => /\b(?:td|th)\b/.test(s) && /\bcode\b/.test(s));
const BREAKS = /overflow-wrap:\s*anywhere|word-break:\s*break-(?:all|word)|white-space:\s*(?:normal|pre-wrap|pre-line)/;

test('code in a table cell stays on one line', () => {
  const rule = rules.find((r) => r.selector === '.sl-markdown-content :is(th, td) code');
  assert.ok(rule, 'no rule for code in table cells');
  assert.match(rule.body, /white-space:\s*nowrap/);
});

test('no rule lets code in a table cell break mid-identifier', () => {
  // A long path's code may wrap only because each of its segments is a span that cannot (the next test)
  const offenders = rules.filter((r) => tableCode(r.selector) && BREAKS.test(r.body) && !/code\.caitlyn-code-path$/.test(r.selector)).map((r) => r.selector);
  assert.deepEqual(offenders, []);
});

test('a long path in a table breaks only before a slash', async () => {
  const pathRule = rules.find((r) => r.selector === '.sl-markdown-content :is(th, td) code.caitlyn-code-path > span');
  assert.ok(pathRule);
  assert.match(pathRule.body, /white-space:\s*nowrap/);
  const { createMarkdownProcessor } = await import('@astrojs/markdown-remark');
  const { default: rehypeTables } = await import('../src/plugins/rehype-tables.mjs');
  const md = await createMarkdownProcessor({ rehypePlugins: [rehypeTables], syntaxHighlight: false });
  const { code } = await md.render('| Guide | Path |\n| --- | --- |\n| A | `/settings/documentation/developers/integration-methods` |\n| B | `clientCredentials` |\n| C | `https://app.example.com/caitlyn/callback` |\n');
  assert.match(code, /<code class="caitlyn-code-path"><span>\/settings<\/span><wbr><span>\/documentation<\/span><wbr><span>\/developers<\/span><wbr><span>\/integration-methods<\/span><\/code>/);
  assert.match(code, /<code>clientCredentials<\/code>/);
  assert.match(code, /<span>https:\/\/app\.example\.com<\/span><wbr><span>\/caitlyn<\/span><wbr><span>\/callback<\/span>/);
});

test('a table that cannot fit scrolls in its wrapper, not the page', () => {
  const rule = rules.find((r) => r.selector === '.sl-markdown-content .caitlyn-table-scroll');
  assert.ok(rule);
  assert.match(rule.body, /overflow-x:\s*auto/);
});
