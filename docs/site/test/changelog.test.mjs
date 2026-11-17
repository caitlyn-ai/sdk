// The Changelog page and its Atom feed (scripts/docs-changelog.mjs), from CHANGELOG.md as semantic-release writes it.
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { atomFeed, changeLinks, changelogPage, longDate, parseChangelog } from '../../../scripts/docs-changelog.mjs';
import { lineProblems } from '../../../scripts/docs-wording.mjs';

const SAMPLE = `## [0.9.1](https://github.com/caitlyn-ai/sdk/compare/v0.9.0...v0.9.1) (2026-12-02)


### Bug Fixes

* **python:** create_document keeps the folder path ([abc1234](https://github.com/caitlyn-ai/sdk/commit/abc1234def))

# [0.9.0](https://github.com/caitlyn-ai/sdk/compare/v0.8.2...v0.9.0) (2026-11-30)


### Bug Fixes

* a refresh token is refreshed once ([1111111](https://github.com/caitlyn-ai/sdk/commit/1111111aaa))


### Features

* **typescript:** createDocument takes a folder & a name ([2222222](https://github.com/caitlyn-ai/sdk/commit/2222222bbb))


### BREAKING CHANGES

* **typescript:** createDocument takes a folder & a name
`;

const PAGES = [
  { slug: 'authentication', title: 'Authentication', kind: 'pages' },
  { slug: 'sdk/create-document', title: 'Create a document', kind: 'reference', operation: { name: 'CreateDocument' } },
  { slug: 'sdk/types/field-error', title: 'FieldError', kind: 'reference' },
];

test('each release heading is one release, newest first, with its date and changes', () => {
  const releases = parseChangelog(SAMPLE);
  assert.deepEqual(releases.map((r) => [r.version, r.date, r.changes.length]), [['0.9.1', '2026-12-02', 1], ['0.9.0', '2026-11-30', 2]]);
  assert.equal(releases[0].changes[0].scope, 'python');
  assert.equal(releases[0].changes[0].commit, 'abc1234');
});

test('a breaking change marks the change it repeats, rather than appearing twice', () => {
  const [, r] = parseChangelog(SAMPLE);
  const feature = r.changes.find((c) => c.section === 'New');
  assert.equal(feature.breaking, true);
  assert.equal(r.changes.filter((c) => c.subject === feature.subject).length, 1);
});

test('a change links to the operation it names in any SDK\'s spelling, and to the page its words are about', () => {
  const [r1, r0] = parseChangelog(SAMPLE);
  assert.deepEqual(changeLinks(r1.changes[0], PAGES).map((l) => l.link), ['/sdk/create-document/']);
  assert.deepEqual(changeLinks(r0.changes.find((c) => c.section === 'New'), PAGES).map((l) => l.link), ['/sdk/create-document/']);
  assert.deepEqual(changeLinks(r0.changes.find((c) => c.section === 'Fixes'), PAGES).map((l) => l.link), ['/authentication/']);
  // A page the site does not build is never linked
  assert.deepEqual(changeLinks({ scope: 'retry', subject: 'a retry budget' }, PAGES), []);
});

test('the page lists each release with its date and heading, breaking changes first, and links the feed', () => {
  const { body, operations } = changelogPage(parseChangelog(SAMPLE), PAGES);
  assert.match(body, /\[Atom feed\]\(\/changelog\/feed\.xml\)/);
  assert.match(body, /^## 0\.9\.1 \{#v0-9-1\}$/m);
  assert.match(body, /Released 30 November 2026\./);
  assert.ok(body.indexOf('### New {#v0-9-0-new}') < body.indexOf('### Fixes {#v0-9-0-fixes}'), 'New before Fixes');
  // A name in code keeps its spelling; prose starts with a capital
  assert.match(body, /^- \*\*Breaking\.\*\* \*\*TypeScript:\*\* createDocument takes a folder & a name/m);
  assert.match(body, /^- \*\*Python:\*\* create_document keeps the folder path/m);
  assert.match(body, /^- A refresh token is refreshed once/m);
  assert.match(body, /See \[Create a document\]\(\/sdk\/create-document\/\)/);
  assert.deepEqual(operations, ['CreateDocument']);
});

test('the feed is Atom: one entry per release, each linking to its heading, escaped', () => {
  const feed = atomFeed(parseChangelog(SAMPLE), PAGES, { base: 'https://build.caitlyn.ai' });
  assert.match(feed, /^<\?xml version="1.0" encoding="utf-8"\?>\n<feed xmlns="http:\/\/www\.w3\.org\/2005\/Atom">/);
  assert.match(feed, /<link rel="self" type="application\/atom\+xml" href="https:\/\/build\.caitlyn\.ai\/changelog\/feed\.xml"\/>/);
  assert.match(feed, /<updated>2026-12-02T00:00:00Z<\/updated>/);
  assert.equal((feed.match(/<entry>/g) ?? []).length, 2);
  assert.match(feed, /<id>https:\/\/build\.caitlyn\.ai\/changelog\/#v0-9-0<\/id>/);
  assert.match(feed, /a folder &amp;amp; a name/, 'content is HTML, escaped once more inside the XML');
  assert.match(feed, /href=&quot;https:\/\/build\.caitlyn\.ai\/sdk\/create-document\/&quot;/, 'site links are absolute in the feed');
});

test('dates read the New Zealand way', () => {
  assert.equal(longDate('2026-11-05'), '5 November 2026');
});

test('the real CHANGELOG.md: every release heading is read, every release has changes, and its text is public', () => {
  const markdown = fs.readFileSync(new URL('../../../CHANGELOG.md', import.meta.url), 'utf8');
  const headings = markdown.split('\n').filter((l) => /^#{1,2} \[?\d+\.\d+\.\d+/.test(l)).length;
  const releases = parseChangelog(markdown);
  assert.equal(releases.length, headings);
  for (const r of releases) assert.ok(r.changes.length, `${r.version} has changes`);
  const { body } = changelogPage(releases, PAGES);
  for (const line of body.split('\n')) assert.deepEqual(lineProblems(line), [], line);
});
