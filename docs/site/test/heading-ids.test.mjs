// Heading ids on the site must be the anchors caitlyn-data-ingestion gives citations, so a citation link
// (`<page>#<anchor>`) lands on its heading. heading-ids.json is the fixture both repositories run; its copy in
// caitlyn-data-ingestion is pdf/topic/tests/fixtures/heading_ids.json, and the two must stay identical.
// Each document case goes through the site's own Markdown pipeline (Astro's unified processor with
// src/plugins/), and each slug case through the github-slugger the pipeline uses.
// Run: npm test (in docs/site), which scripts/docs-build.sh runs before every build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createMarkdownProcessor } from '@astrojs/markdown-remark';
import Slugger from 'github-slugger';
import remarkHeadingIds from '../src/plugins/remark-heading-ids.mjs';
import remarkLangTabs from '../src/plugins/remark-lang-tabs.mjs';

const fixture = JSON.parse(fs.readFileSync(new URL('./heading-ids.json', import.meta.url), 'utf8'));
const processor = await createMarkdownProcessor({ remarkPlugins: [remarkHeadingIds, remarkLangTabs], smartypants: false, syntaxHighlight: false });

for (const c of fixture.slugs) {
  test(`slugs: ${c.name}`, () => {
    const slugger = new Slugger();
    assert.deepEqual(c.headings.map((h) => slugger.slug(h)), c.ids);
  });
}

// The fixture says a raw HTML <h1>-<h6> takes a turn with the slugger. Astro does not: rehypeHeadingIds sees raw
// HTML as text, so the heading gets no id and the next one keeps its slug (checked with a full Starlight build).
// The docs build refuses raw HTML headings, so no page here can differ; the cases stay in the fixture until
// caitlyn-data-ingestion's rule changes to match.
const RAW_HTML_HEADING = /<h[1-6][\s>]/i;

for (const c of fixture.documents) {
  const run = RAW_HTML_HEADING.test(c.markdown) ? test.todo : test;
  run(`documents: ${c.name}`, async () => {
    const { metadata } = await processor.render(c.markdown);
    // GFM adds a visually hidden "Footnotes" heading after the content, which is not one of the document's headings
    const ids = metadata.headings.map((h) => h.slug).filter((id) => id !== 'footnote-label');
    assert.deepEqual(ids, c.ids);
  });
}

test('language tabs: consecutive tab blocks become one group, without the tab attribute', async () => {
  const { code } = await processor.render('```ts tab="TypeScript"\na\n```\n```python tab="Python"\nb\n```\n\n```go\nc\n```\n');
  assert.equal((code.match(/data-lang-tabs/g) ?? []).length, 1);
  assert.match(code, /role="tab" data-lang="typescript"/);
  assert.match(code, /role="tabpanel" data-lang="python" data-label="Python"/);
  assert.doesNotMatch(code, /tab=/);
});
