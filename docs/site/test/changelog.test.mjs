// The Changelog page and its Atom feed (scripts/docs-changelog.mjs), from CHANGELOG.md as semantic-release writes it,
// and from the API releases' changes.json. Run: npm test (in docs/site).
//
// fixtures/model-changes/ holds two real changes.json, written by the app's CaitlynChanges (in its Smithy toolchain
// image) and not by hand: 5.115.0.json compares the model at 57af839ca6 with the one at 85e9fad542 (the locked model),
// and 5.114.0.json the model at 43c9bbbef8 (the 0.8.x lock) with the one at 57af839ca6. Neither model was published,
// so the version numbers and dates are stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { apiSections, atomFeed, changeLinks, changelogPage, longDate, mergeReleases, parseChangelog, readApiReleases, releaseViews } from '../../../scripts/docs-changelog.mjs';
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
  // One compare link a release, no commit hashes
  assert.match(body, /^SDK release, 30 November 2026\. \[Show diff\]\(https:\/\/github\.com\/caitlyn-ai\/sdk\/compare\/v0\.8\.2\.\.\.v0\.9\.0\)\.$/m);
  assert.doesNotMatch(body, /1111111|2222222|abc1234/);
  // Breaking changes are their own group, first; the change is not repeated under New
  assert.ok(body.indexOf('### Breaking {#v0-9-0-breaking}') < body.indexOf('### Fixed {#v0-9-0-fixed}'), 'Breaking before Fixed');
  assert.doesNotMatch(body, /\{#v0-9-0-new\}/);
  // A name in code keeps its spelling; prose starts with a capital
  assert.match(body, /^- \*\*TypeScript:\*\* createDocument takes a folder & a name/m);
  assert.match(body, /^- \*\*Python:\*\* create_document keeps the folder path/m);
  assert.match(body, /^- A refresh token is refreshed once/m);
  assert.match(body, /See \[Create a document\]\(\/sdk\/create-document\/\)/);
  assert.deepEqual(operations, ['CreateDocument']);
});

test('the site\'s page is a timeline: a row per release, its version, tag and date beside its entries under badges', () => {
  const { siteBody } = changelogPage(parseChangelog(SAMPLE), PAGES);
  // The contents list the versions alone: a heading per release, none per group
  assert.deepEqual(siteBody.match(/^#+ .*$/gm), ['## 0.9.1 <span class="caitlyn-release-kind">SDK</span> {#v0-9-1}', '## 0.9.0 <span class="caitlyn-release-kind">SDK</span> {#v0-9-0}']);
  assert.equal((siteBody.match(/<section class="caitlyn-release"/g) ?? []).length, 2);
  assert.match(siteBody, /<p class="caitlyn-release-date"><time datetime="2026-11-30">30 November 2026<\/time><\/p>/);
  assert.match(siteBody, /<a href="https:\/\/github\.com\/caitlyn-ai\/sdk\/compare\/v0\.8\.2\.\.\.v0\.9\.0" title="The code changes since 0\.8\.2, on GitHub">Show diff<\/a>/);
  // The release with a breaking change says so, and its Breaking badge comes before the others
  assert.match(siteBody, /<section class="caitlyn-release" data-kind="sdk" data-breaking>/);
  const v090 = siteBody.slice(siteBody.indexOf('{#v0-9-0}'));
  assert.ok(v090.indexOf('data-change="breaking">Breaking<') < v090.indexOf('data-change="fixed">Fixed<'));
  // Each badge's group is HTML around Markdown entries, a blank line apart, so the entries' links still render
  assert.match(siteBody, /<p class="caitlyn-release-label"><span class="caitlyn-stability" data-change="fixed">Fixed<\/span><\/p>\n\n- <span class="caitlyn-entry-title">\*\*Python:\*\* create_document/);
});

test('docs and CI entries are left off the page and out of the feed; a release with nothing else says so', () => {
  const markdown = `## [0.9.2](https://github.com/caitlyn-ai/sdk/compare/v0.9.1...v0.9.2) (2026-12-03)\n\n\n### Bug Fixes\n\n* **docs:** code in a table never breaks mid-word ([abc1235](https://github.com/caitlyn-ai/sdk/commit/abc1235def))\n* **ci:** the docs job waits for its preview ([abc1236](https://github.com/caitlyn-ai/sdk/commit/abc1236def))\n\n${SAMPLE}`;
  const releases = parseChangelog(markdown);
  assert.equal(releases[0].changes.length, 2, 'CHANGELOG.md keeps them');
  const { body, siteBody } = changelogPage(releases, PAGES);
  assert.doesNotMatch(body, /mid-word|preview/);
  assert.match(body, /^SDK release, 3 December 2026\. No change to the SDKs themselves\. \[Show diff\]/m);
  assert.match(siteBody, /<p class="caitlyn-release-intro">No change to the SDKs themselves\.<\/p>/);
  const [view] = releaseViews(releases, PAGES).views;
  assert.deepEqual(view.groups, []);
  const feed = atomFeed(releases, PAGES, { base: 'https://build.caitlyn.ai' });
  assert.doesNotMatch(feed, /mid-word|preview/);
  assert.match(feed, /<summary>Released 3 December 2026: no change to the SDKs themselves\.<\/summary>/);
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

// ------------------------------------------------------------------------------------------------ API releases

const FIXTURES = new URL('./fixtures/model-changes/', import.meta.url).pathname;
const API_PAGES = [
  ...PAGES,
  { slug: 'errors', title: 'Errors', kind: 'pages' },
  { slug: 'errors/PRECONDITION_REQUIRED', title: 'PRECONDITION_REQUIRED', kind: 'errors' },
  { slug: 'sdk/batch-create-ingestion-batch-items', title: 'Add items to a batch', kind: 'reference', operation: { name: 'BatchCreateIngestionBatchItems' } },
  { slug: 'sdk/delete-agent-version', title: 'Delete a version', kind: 'reference', operation: { name: 'DeleteAgentVersion' } },
  { slug: 'api/delete-document', title: 'Delete a document', kind: 'api', operation: { name: 'DeleteDocument' } },
  { slug: 'sdk/types/readers-kind', title: 'ReadersKind', kind: 'types' },
  { slug: 'sdk/types/agent-configuration', title: 'AgentConfiguration', kind: 'types' },
  { slug: 'sdk/types/answer-settings', title: 'AnswerSettings', kind: 'types' },
  { slug: 'errors/VERSIONS_NOT_NUMBERED', title: 'VERSIONS_NOT_NUMBERED', kind: 'errors' },
  { slug: 'api', title: 'Caitlyn v3 HTTP API', kind: 'api' },
];
const ERROR_CODES = { ConflictError: ['CONFLICT', 'ALREADY_EXISTS'], PreconditionRequiredError: ['PRECONDITION_REQUIRED'] };
// The operations that give each code in an example or their documentation, as scripts/docs-build.mjs reads them
const CODE_OPERATIONS = { VERSIONS_NOT_NUMBERED: ['DeleteDocumentVersion'], VERSION_IN_USE: ['DeleteAgentVersion'] };

test('the fixtures are real changes.json: the public readers kind, error codes, and errors added and removed', () => {
  const { releases, problems } = readApiReleases(FIXTURES);
  assert.deepEqual(problems, []);
  assert.deepEqual(releases.map((r) => [r.version, r.date, r.previousVersion]), [['5.115.0', '2026-11-17', '5.114.0'], ['5.114.0', '2026-11-10', '5.113.0']]);
  assert.ok(releases.every((r) => r.api));
  const all = releases.flatMap((r) => r.changes);
  assert.ok(releases[0].changes.some((c) => c.kind === 'enumValueAdded' && c.shape === 'ReadersKind' && c.value === 'public'));
  assert.ok(all.some((c) => c.kind === 'errorAdded'), 'an errorAdded entry');
  assert.ok(all.some((c) => c.kind === 'errorRemoved'), 'an errorRemoved entry');
  assert.ok(releases[0].changes.some((c) => c.kind === 'errorCodeAdded' && c.error === 'ConflictError' && c.code === 'VERSIONS_NOT_NUMBERED' && c.status === 409));
});

test('no model/changes/ folder: no API release, and the page is the SDK releases alone', () => {
  const { releases, problems } = readApiReleases(path.join(os.tmpdir(), 'no-such-folder-model-changes'));
  assert.deepEqual([releases, problems], [[], []]);
  const sdk = parseChangelog(SAMPLE);
  assert.deepEqual(changelogPage(mergeReleases(sdk, releases), PAGES), changelogPage(sdk, PAGES));
  assert.doesNotMatch(changelogPage(sdk, PAGES).body, /^## API /m);
});

test('a changes.json the Changelog cannot read is a problem, not a silent gap', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'model-changes-'));
  fs.writeFileSync(path.join(dir, '5.200.0.json'), JSON.stringify({ version: '5.199.0', date: '2026-12-01', changes: [] }));
  fs.writeFileSync(path.join(dir, '5.201.0.json'), JSON.stringify({ version: '5.201.0', date: '2026-12-02', changes: [{ kind: 'somethingNew', surface: 'ga' }] }));
  const { problems } = readApiReleases(dir);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /names version 5\.199\.0/);
  assert.match(problems[1], /kind somethingNew/);
});

test('SDK and API releases are one list, newest first by date; on the same day the SDK release comes first', () => {
  const sdk = parseChangelog(SAMPLE); // 0.9.1 on 2 December, 0.9.0 on 30 November
  const [newer, older] = readApiReleases(FIXTURES).releases;
  const merged = mergeReleases(sdk, [{ ...newer, date: '2026-12-01' }, older, { ...older, version: '5.116.0', date: '2026-11-30' }]);
  assert.deepEqual(merged.map((r) => `${r.api ? 'API ' : ''}${r.version}`), ['0.9.1', 'API 5.115.0', '0.9.0', 'API 5.116.0', 'API 5.114.0']);
  const { body } = changelogPage(merged, API_PAGES, { errorCodes: ERROR_CODES });
  const at = (heading) => body.indexOf(heading);
  assert.ok(at('## 0.9.1 {#v0-9-1}') < at('## API 5.115.0 {#api-5-115-0}') && at('## API 5.115.0') < at('## 0.9.0 {#v0-9-0}') && at('## 0.9.0') < at('## API 5.114.0 {#api-5-114-0}'));
  // SDK releases keep their form
  assert.match(body, /^- \*\*Python:\*\* create_document keeps the folder path/m);
});

test('an API release is labelled with its version, and its changes are grouped by what a reader does about them', () => {
  const releases = readApiReleases(FIXTURES).releases;
  const { body, siteBody } = changelogPage(releases, API_PAGES, { errorCodes: ERROR_CODES, codeOperations: CODE_OPERATIONS });
  assert.match(body, /^## API 5\.115\.0 \{#api-5-115-0\}\n\nAPI release, 17 November 2026\. \[API reference\]\(\/api\/\)\.$/m);
  assert.match(siteBody, /^## 5\.115\.0 <span class="caitlyn-release-kind">API<\/span> \{#api-5-115-0\}$/m);
  // The version, tag and date say what the row is: no lead sentence, and the API reference where an SDK row has its compare link
  assert.doesNotMatch(siteBody, /What changed in the Caitlyn API/);
  assert.match(siteBody, /<p class="caitlyn-release-compare"><a href="\/api\/">API reference<\/a><\/p>/);
  const release = body.slice(body.indexOf('## API 5.114.0'));
  const order = ['### New {#api-5-114-0-new-operations}', '### Changed {#api-5-114-0-changed}', '### Removed {#api-5-114-0-removed}'].map((h) => release.indexOf(h));
  assert.ok(order.every((i, n) => i >= 0 && (n === 0 || i > order[n - 1])), `sections in order: ${order}`);
  // One entry per operation or type, its errors, members and values together; a change reaching only beta operations says so
  assert.match(body, /^- \[`ReadersKind`\]\(\/sdk\/types\/readers-kind\/\): adds the value `public`\.$/m);
  assert.match(body, /^- \[`DeleteAgentVersion`\]\(\/sdk\/delete-agent-version\/\): can now return \[`ConflictError`\]\(\/errors\/#error-codes\) \(409\)/m);
  assert.match(body, /^- `UpdateDraftVersion`: no longer returns \[`PRECONDITION_REQUIRED`\]\(\/errors\/PRECONDITION_REQUIRED\/\) \(428\); /m);
  assert.match(body, /^- `GetCaller`: its response's `scopes` is now `OAuthScopeList` \(was `ScopeList`\)\.$/m);
  assert.match(body, /^- `OperationStatus`: adds the value `completed_with_failures`; drops the value `succeeded_with_failures`\.$/m);
  assert.match(release, /^- `PinDraftVersion`$/m);
  // Removing an operation is breaking: the Removed badge takes the breaking style
  assert.match(siteBody, /data-change="breaking">Removed</);
});

test('an error code an error class adds is a change to the operations that give it, linked to its page', () => {
  const [newer, older] = readApiReleases(FIXTURES).releases;
  const { body } = changelogPage([newer], API_PAGES, { errorCodes: ERROR_CODES, codeOperations: CODE_OPERATIONS });
  assert.match(body, /^- `DeleteDocumentVersion`: can now return \[`VERSIONS_NOT_NUMBERED`\]\(\/errors\/VERSIONS_NOT_NUMBERED\/\) \(409\)\.$/m);
  // A code no operation gives: a change to the operations that return its class; a code with no page is named, not linked
  const older_ = changelogPage([older], API_PAGES, { errorCodes: ERROR_CODES, codeOperations: CODE_OPERATIONS }).body;
  assert.match(older_, /^- Operations that return \[`ConflictError`\]\(\/errors\/#error-codes\): can now return .*`TARGET_IN_USE` \(409\)/m);
  assert.match(older_, /^- \[`DeleteAgentVersion`\]\(\/sdk\/delete-agent-version\/\): can now return \[`ConflictError`\]\(\/errors\/#error-codes\) \(409\) and `VERSION_IN_USE` \(409\)\.$/m);
  // A dropped code
  const dropped = apiSections({ api: true, version: '5.120.0', date: '2026-12-10', changes: [{ kind: 'errorCodeRemoved', surface: 'ga', error: 'ConflictError', code: 'VERSIONS_NOT_NUMBERED', status: 409 }] }, API_PAGES, { errorCodes: ERROR_CODES, codeOperations: CODE_OPERATIONS });
  assert.deepEqual(dropped.sections[0].items, ['- `DeleteDocumentVersion`: no longer returns [`VERSIONS_NOT_NUMBERED`](/errors/VERSIONS_NOT_NUMBERED/) (409).']);
});

test('stability changes have their own section, and a change a GA operation reaches is not marked preview', () => {
  const release = {
    api: true, version: '5.120.0', previousVersion: '5.119.0', date: '2026-12-10',
    changes: [
      { kind: 'stabilityChanged', surface: 'ga', operation: 'DeleteAgentVersion', from: 'beta', to: 'ga' },
      { kind: 'memberAdded', surface: 'ga', shape: 'AgentConfiguration', member: 'notes', target: 'String', required: false },
      { kind: 'serviceErrorAdded', surface: 'ga', error: 'PreconditionRequiredError', status: 428 },
    ],
  };
  const { sections } = apiSections(release, API_PAGES, { errorCodes: ERROR_CODES });
  assert.deepEqual(sections.map((s) => s.title), ['Changed operations and types', 'Stability changes']);
  assert.deepEqual(sections[0].items, [
    '- Every operation: can now return [`PRECONDITION_REQUIRED`](/errors/PRECONDITION_REQUIRED/) (428).',
    '- [`AgentConfiguration`](/sdk/types/agent-configuration/): adds `notes` (`String`).',
  ]);
  assert.deepEqual(sections[1].items, ['- [`DeleteAgentVersion`](/sdk/delete-agent-version/): from preview to GA.']);
});

test('an API release links every operation, type and error code to its page, and an operation with no page yet is named, not linked', () => {
  const [, older] = readApiReleases(FIXTURES).releases;
  const { body, operations } = changelogPage([older], API_PAGES, { errorCodes: ERROR_CODES });
  assert.match(body, /^- \[Add items to a batch\]\(\/sdk\/batch-create-ingestion-batch-items\/\) \(`BatchCreateIngestionBatchItems`\)$/m);
  // No page for CancelDocumentProcessing in this site: its title and name, unlinked
  assert.match(body, /^- Stop processing a document \(`CancelDocumentProcessing`\)$/m);
  // The HTTP API's page is not the SDK reference's: DeleteDocument has only an /api/ page here, so it is not linked
  assert.match(body, /^- `DeleteDocument`: /m);
  // A type with a page is linked where it is a member's type too
  assert.match(body, /^- \[`AgentConfiguration`\]\(\/sdk\/types\/agent-configuration\/\): adds `answers` \(\[`AnswerSettings`\]\(\/sdk\/types\/answer-settings\/\)\), `connectors` \(`ConnectorBindingList`\)/m);
  assert.deepEqual(operations, ['BatchCreateIngestionBatchItems', 'CreateDocument', 'DeleteAgentVersion']);
  // Every link is to a page the site builds
  const slugs = new Set(API_PAGES.map((p) => `/${p.slug}/`));
  for (const [, href] of body.slice(body.indexOf('## API')).matchAll(/\]\((\/[^)#]*)(?:#[^)]*)?\)/g)) assert.ok(slugs.has(href), `${href} is a page`);
});

test('the feed carries API releases beside the SDK releases, and every API release passes the public-wording check', () => {
  const releases = mergeReleases(parseChangelog(SAMPLE), readApiReleases(FIXTURES).releases);
  const feed = atomFeed(releases, API_PAGES, { base: 'https://build.caitlyn.ai', errorCodes: ERROR_CODES });
  assert.equal((feed.match(/<entry>/g) ?? []).length, 4);
  assert.match(feed, /<title>Caitlyn API 5\.115\.0<\/title>\n {4}<id>https:\/\/build\.caitlyn\.ai\/changelog\/#api-5-115-0<\/id>/);
  assert.match(feed, /<summary>API release, 17 November 2026: 2 changes to the Caitlyn API\.<\/summary>/);
  assert.match(feed, /href=&quot;https:\/\/build\.caitlyn\.ai\/sdk\/types\/readers-kind\/&quot;/);
  assert.match(feed, /<title>Caitlyn SDKs 0\.9\.1<\/title>/);
  const { body, siteBody } = changelogPage(releases, API_PAGES, { errorCodes: ERROR_CODES, codeOperations: CODE_OPERATIONS });
  for (const line of [...body.split('\n'), ...siteBody.split('\n')]) assert.deepEqual(lineProblems(line), [], line);
});

test('a change\'s hand-written highlights are its entry\'s nested list, each linking its page within the site', () => {
  const markdown = `# [0.9.0](https://github.com/caitlyn-ai/sdk/compare/v0.8.2...v0.9.0) (2026-11-17)\n\n\n### Features\n\n* SDK 0.9.0: callable scopes and watch and wait ([92e92e5](https://github.com/caitlyn-ai/sdk/commit/92e92e5))\n  * **Callable scopes:** a scope sends nothing. See [Groups and operations](https://build.caitlyn.ai/sdk/#groups-and-operations).\n  * **Watch and wait:** \`wait()\` for its end. See [Streaming](https://build.caitlyn.ai/streaming/).\n\n\n### BREAKING CHANGES\n\n* SDK 0.9.0: callable scopes and watch and wait\n`;
  const [r] = parseChangelog(markdown);
  assert.equal(r.changes.length, 1);
  assert.equal(r.changes[0].breaking, true);
  assert.equal(r.changes[0].highlights.length, 2);
  const { body, siteBody } = changelogPage([r], PAGES);
  // The subject's own word links ("watch": Streaming) give way to the highlights'
  assert.match(body, /^- SDK 0\.9\.0: callable scopes and watch and wait\n {2}- \*\*Callable scopes:\*\* a scope sends nothing\. See \[Groups and operations\]\(\/sdk\/#groups-and-operations\)\.\n {2}- \*\*Watch and wait:\*\* `wait\(\)` for its end\. See \[Streaming\]\(\/streaming\/\)\.$/m);
  assert.match(siteBody, /data-change="breaking">Breaking<\/span><\/p>\n\n- <span class="caitlyn-entry-title">SDK 0\.9\.0: callable scopes and watch and wait<\/span>\n {2}- \*\*Callable scopes:\*\*/);
});

test('the page opens with one sentence and the feed', () => {
  const { body } = changelogPage(parseChangelog(SAMPLE), PAGES);
  assert.equal(body.split('\n')[0], 'Every SDK and API release, newest first. Read a breaking change before you upgrade. Follow them in a feed reader with the [Atom feed](/changelog/feed.xml).');
});
