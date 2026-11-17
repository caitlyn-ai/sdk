// What the site tells search engines (scripts/docs-sitemap.mjs): the live build publishes sitemap.xml and names it in
// robots.txt; a preview publishes neither and every page carries noindex. scripts/docs-build.mjs checks every built
// page's robots meta against the build it is. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { isLive, lastModified, robotsMeta, robotsTxt, sitemapXml } from '../../../scripts/docs-sitemap.mjs';

test('only DOCS_LIVE=on is the live build; a build that does not say is a preview', () => {
  assert.equal(isLive({ DOCS_LIVE: 'on' }), true);
  for (const env of [{}, { DOCS_LIVE: '' }, { DOCS_LIVE: 'true' }, { DOCS_LIVE: 'off' }, { CI_PIPELINE_SOURCE: 'merge_request_event' }]) assert.equal(isLive(env), false, JSON.stringify(env));
});

test('the live robots.txt names the sitemap at the canonical host', () => {
  const robots = robotsTxt({ live: true, base: 'https://build.caitlyn.ai' });
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Sitemap: https:\/\/build\.caitlyn\.ai\/sitemap\.xml$/m);
  assert.doesNotMatch(robots, /Disallow: \/\s*$/m);
});

test('a preview robots.txt names no sitemap, and still lets crawlers read each page\'s noindex', () => {
  const robots = robotsTxt({ live: false });
  assert.doesNotMatch(robots, /sitemap/i);
  assert.match(robots, /^Allow: \/$/m);
});

test('pages are indexed only on the live build', () => {
  assert.equal(robotsMeta(true), 'index, follow');
  assert.match(robotsMeta(false), /^noindex/);
  const config = fs.readFileSync(new URL('../astro.config.mjs', import.meta.url), 'utf8');
  assert.match(config, /name: 'robots', content: robotsMeta\(isLive\(\)\)/, 'every page\'s robots meta comes from robotsMeta(isLive())');
});

test('sitemap.xml lists each page once with its address and date, escaped', () => {
  const out = sitemapXml([
    { loc: 'https://build.caitlyn.ai/', lastmod: '2026-11-16T09:00:00+13:00' },
    { loc: 'https://build.caitlyn.ai/a&b/', lastmod: '2026-11-17T00:00:00Z' },
  ]);
  assert.match(out, /^<\?xml version="1.0" encoding="UTF-8"\?>\n<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/);
  assert.equal((out.match(/<url>/g) ?? []).length, 2);
  assert.match(out, /<loc>https:\/\/build\.caitlyn\.ai\/<\/loc><lastmod>2026-11-16T09:00:00\+13:00<\/lastmod>/);
  assert.match(out, /<loc>https:\/\/build\.caitlyn\.ai\/a&amp;b\/<\/loc>/);
});

test('a source git cannot date takes the build\'s date, and says so', () => {
  const git = (paths) => (paths[0] === 'docs/faq.md' ? '2026-11-10T12:00:00+13:00' : null);
  const { dates, dated } = lastModified(new Map([['docs/faq.md', ['docs/faq.md']], ['the model', ['model']]]), { cwd: '.', fallback: '2026-11-17T03:00:00Z', git });
  assert.equal(dates.get('docs/faq.md'), '2026-11-10T12:00:00+13:00');
  assert.equal(dates.get('the model'), '2026-11-17T03:00:00Z');
  assert.deepEqual([...dated], ['docs/faq.md']);
});
