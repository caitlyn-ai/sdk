// Language tabs (src/plugins/remark-lang-tabs.mjs): two groups of code blocks side by side are two tab groups, each
// with one tab per language, and every page's groups have no language twice and no more panels than tabs.
// scripts/docs-build.mjs checks the built pages the same way. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import remarkLangTabs from '../src/plugins/remark-lang-tabs.mjs';
import { readPages } from '../../../scripts/docs-guides.mjs';

const LANGS = [['ts', 'TypeScript'], ['python', 'Python'], ['go', 'Go'], ['rust', 'Rust']];
const code = (lang, label, value) => ({ type: 'code', lang, meta: `tab="${label}"`, value });

/** A page's top-level blocks as the plugin sees them: each fenced block a code node, anything else a paragraph */
function blocks(markdown) {
  const out = [];
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const fence = /^(```+)(\S*)(.*)$/.exec(lines[i]);
    if (fence) {
      let j = i + 1;
      while (j < lines.length && !lines[j].startsWith(fence[1])) j++;
      out.push({ type: 'code', lang: fence[2], meta: fence[3].trim(), value: lines.slice(i + 1, j).join('\n') });
      i = j;
    } else if (lines[i].trim() && !/^<!-- example:/.test(lines[i])) out.push({ type: 'paragraph', children: [] });
  }
  return { type: 'root', children: out };
}

/** Each tab group's labels and panel count */
function groups(tree) {
  remarkLangTabs()(tree);
  return tree.children.filter((n) => n.type === 'langTabs').map((g) => ({
    tabs: g.children[0].children.map((t) => t.children[0].value),
    panels: g.children.length - 1,
  }));
}

test('two groups side by side stay two groups, each with one tab per language', () => {
  const tree = { type: 'root', children: [...LANGS.map(([l, n]) => code(l, n, 'one')), ...LANGS.map(([l, n]) => code(l, n, 'two'))] };
  const found = groups(tree);
  assert.equal(found.length, 2);
  for (const g of found) assert.deepEqual(g.tabs, LANGS.map(([, n]) => n));
});

test('no page has a tab strip with a language twice, or more panels than tabs', () => {
  let seen = 0;
  for (const page of readPages()) {
    for (const g of groups(blocks(page.markdown))) {
      seen++;
      assert.equal(new Set(g.tabs).size, g.tabs.length, `${page.file}: a tab strip has ${g.tabs.join(', ')}`);
      assert.equal(g.panels, g.tabs.length, `${page.file}: ${g.panels} panels for ${g.tabs.length} tabs`);
    }
  }
  assert.ok(seen > 0);
});

test('output tabs are their own groups, marked apart from language tabs', () => {
  const out = (lang, label, value) => ({ type: 'code', lang, meta: `tab-output="${label}"`, value });
  const tree = { type: 'root', children: [...LANGS.map(([l, n]) => code(l, n, 'call')), out('text', 'Table', 'NAME'), out('json', 'JSON', '{}')] };
  remarkLangTabs()(tree);
  const [lang, output] = tree.children;
  assert.equal(lang.data.hProperties.dataLangTabs, '');
  assert.equal(lang.data.hProperties.dataOutputTabs, undefined);
  assert.equal(output.data.hProperties.dataOutputTabs, '');
  assert.equal(output.data.hProperties.dataLangTabs, undefined);
  assert.deepEqual(output.children[0].children.map((t) => [t.children[0].value, t.data.hProperties.dataOutput]), [['Table', 'table'], ['JSON', 'json']]);
  assert.equal(output.children[0].data.hProperties.ariaLabel, 'Output');
  for (const p of output.children.slice(1)) assert.equal(p.data.hProperties.dataLang, undefined);
});
