// The release notes (scripts/release-notes.mjs): change files, the section semantic-release writes into CHANGELOG.md,
// the merge request check, and the Unreleased entry a merge request's preview opens its Changelog with. The section is
// read back by the Changelog page (scripts/docs-changelog.mjs), so these tests go through both.
//
// fixtures/release-notes/<version>/ are the change files 0.10.0, 0.10.1 and 0.11.0 would have had, written from their
// merge requests (!76, !78 and !82) for the dry run that regenerates their notes. Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { THIS_MR, atomFeed, changelogPage, parseChangelog, releaseViews } from '../../../scripts/docs-changelog.mjs';
import { agreementProblems, apiGroups, collect, lateProblems, parseChangeFile, parseCommit, renderSection, sitePages } from '../../../scripts/release-notes.mjs';
import { lineProblems } from '../../../scripts/docs-wording.mjs';

const root = path.resolve(import.meta.dirname, '../../..');
const backfill = path.join(import.meta.dirname, 'fixtures/release-notes');

const FILE = `---
type: feat
scope: typescript
summary: one page of any list
---

- **One page:** \`list().page()\` reads one page. See [Read one page](/pagination/#read-one-page).
- **The next page:** \`page.nextPage()\` reads the next,
  with the same input. See [Pagination](https://build.caitlyn.ai/pagination/).
`;

test('a change file is its type, scope, summary and highlights; a highlight may run over several lines', () => {
  const f = parseChangeFile(FILE, 'changes/pages.md');
  assert.deepEqual(f.problems, []);
  assert.equal(f.type, 'feat');
  assert.equal(f.scope, 'typescript');
  assert.equal(f.breaking, false);
  assert.equal(f.summary, 'one page of any list');
  assert.equal(f.highlights.length, 2);
  assert.match(f.highlights[1], /reads the next, with the same input\. See/);
});

test('a change file that would publish badly names each problem', () => {
  const problems = (text) => parseChangeFile(text, 'changes/x.md').problems.join('\n');
  assert.match(problems('no front matter'), /no front matter/);
  assert.match(problems('---\ntype: feature\nsummary: x\n---\n'), /type is "feature"/);
  assert.match(problems('---\ntype: feat\n---\n'), /no summary/);
  assert.match(problems('---\ntype: feat\nsummary: a line.\n---\n'), /ends with a full stop/);
  assert.match(problems('---\ntype: feat\ncolour: red\nsummary: x\n---\n'), /"colour"/);
  assert.match(problems('---\ntype: feat\nsummary: x\n---\n- no lead. See [P](/pagination/).\n'), /bold lead/);
  assert.match(problems('---\ntype: feat\nsummary: x\n---\n- **Lead:** no link at all.\n'), /links no page/);
  assert.match(problems('---\ntype: feat\nsummary: x\n---\n- **Lead:** see [it](/pagination).\n'), /names no page/);
  assert.match(problems('---\ntype: feat\nsummary: x\n---\n- **Lead:** [MR](https://git.customd.com/custom-d/caitlyn/sdk/-/merge_requests/1) and [P](/pagination/).\n'), /neither a page/);
  assert.match(problems('---\ntype: feat\nbreaking: true\nsummary: x\n---\n'), /needs a highlight saying what to change/);
  assert.match(problems('---\ntype: feat\nsummary: x\n---\nA paragraph.\n'), /outside the list/);
});

test('the backfilled change files for 0.10.0, 0.10.1 and 0.11.0 read well', () => {
  for (const v of fs.readdirSync(backfill)) {
    for (const f of fs.readdirSync(path.join(backfill, v))) {
      const parsed = parseChangeFile(fs.readFileSync(path.join(backfill, v, f), 'utf8'), `${v}/${f}`);
      assert.deepEqual(parsed.problems, [], `${v}/${f}`);
    }
  }
});

test('a commit is read as semantic-release reads it: a ! or a BREAKING CHANGE footer breaks', () => {
  assert.deepEqual(parseCommit({ subject: 'feat(go)!: scopes' }), { hash: null, type: 'feat', scope: 'go', breaking: true, subject: 'scopes' });
  assert.equal(parseCommit({ subject: 'fix: x', body: 'BREAKING CHANGE: y' }).breaking, true);
  assert.equal(parseCommit({ subject: 'Merge branch x' }), null);
});

// A release's notes, as semantic-release writes them, read back by the Changelog page
const pages = [
  { slug: 'pagination', title: 'Pagination', kind: 'pages' },
  { slug: 'sdk/cancel-ingestion-batch-item', title: 'Cancel a batch item', kind: 'reference', operation: { name: 'CancelIngestionBatchItem' } },
  { slug: 'sdk/types/ingestion-batch-status', title: 'IngestionBatchStatus', kind: 'types' },
];
const api = [
  { kind: 'operationAdded', surface: 'beta', operation: 'CancelIngestionBatchItem', stability: 'beta', title: 'Cancel a batch item' },
  { kind: 'enumValueRemoved', surface: 'beta', shape: 'IngestionBatchStatus', value: 'expired' },
];
const file = parseChangeFile(FILE, 'changes/pages.md');
const entries = [
  { type: 'feat', scope: file.scope, breaking: true, subject: file.summary, highlights: file.highlights, commit: 'abcdef1234567890' },
  { type: 'fix', scope: null, breaking: false, subject: 'a commit with no change file', highlights: [], commit: '1234567abcdef' },
];
const section = renderSection({ version: '0.12.0', previousTag: 'v0.11.0', date: '2026-12-01', entries, apiGroups: apiGroups(api, { pages }) });

test('the section is CHANGELOG.md\'s form: compare link, entries with their commits and highlights, the API, breaking changes', () => {
  assert.match(section, /^# \[0\.12\.0\]\(https:\/\/github\.com\/caitlyn-ai\/sdk\/compare\/v0\.11\.0\.\.\.v0\.12\.0\) \(2026-12-01\)\n/);
  assert.match(section, /\n### Features\n\n\* \*\*typescript:\*\* one page of any list \(\[abcdef1\]\(https:\/\/github\.com\/caitlyn-ai\/sdk\/commit\/abcdef1234567890\)\)\n {2}\* \*\*One page:\*\*/);
  assert.match(section, /See \[Read one page\]\(https:\/\/build\.caitlyn\.ai\/pagination\/#read-one-page\)/, 'links are absolute, for GitHub readers');
  assert.match(section, /\n### New operations\n\n\* \[Cancel a batch item\]\(https:\/\/build\.caitlyn\.ai\/sdk\/cancel-ingestion-batch-item\/\) \(`CancelIngestionBatchItem`\)\n/);
  assert.match(section, /\n### Breaking API changes\n\n\* \[`IngestionBatchStatus`\]\(https:\/\/build\.caitlyn\.ai\/sdk\/types\/ingestion-batch-status\/\): drops the value `expired`\.\n/);
  assert.match(section, /\n### BREAKING CHANGES\n\n\* \*\*typescript:\*\* one page of any list\n/);
  assert.equal(section.match(/git\.customd\.com/), null);
  assert.match(renderSection({ version: '0.12.1', previousTag: 'v0.12.0', date: '2026-12-02', entries: [entries[1]] }), /^## \[0\.12\.1\]/, 'a patch release is a level-two heading');
});

test('the Changelog page reads the section back: badges, highlights within the site, the API under its own badges', () => {
  const [release] = parseChangelog(section);
  assert.equal(release.version, '0.12.0');
  const { views } = releaseViews([release], pages);
  const groups = Object.fromEntries(views[0].groups.map((g) => [g.label, g]));
  assert.deepEqual(views[0].groups.map((g) => g.label), ['Breaking', 'Breaking in the API', 'Fixed', 'New in the API']);
  assert.equal(groups['Breaking in the API'].badge, 'breaking');
  assert.equal(groups['New in the API'].badge, 'new');
  assert.match(groups.Breaking.items[0], /\n {2}- \*\*One page:\*\* .*See \[Read one page\]\(\/pagination\/#read-one-page\)/, 'highlights link within the site');
  assert.match(groups['New in the API'].items[0], /^- \[Cancel a batch item\]\(\/sdk\/cancel-ingestion-batch-item\/\)/);
  assert.equal(views[0].compare.text, 'Show diff');
});

test('the page: badges name the kind of change, "See" is a footnote, a change many operations share leads them, and Slack is explained', () => {
  const changelog = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
  const { siteBody, body } = changelogPage(parseChangelog(changelog), [], { feed: '/changelog/feed.xml' });
  assert.match(siteBody, /<span class="caitlyn-stability" data-change="changed">Changed<\/span><span class="caitlyn-release-scope">in the API<\/span>/);
  assert.match(siteBody, /<span class="caitlyn-see">See \[Retries\]\([^)]+\)\.<\/span>/);
  assert.match(siteBody, /^- Each request's `ifMatch` is now `EntityTagCondition` \(was `EntityTag`\), in 14 operations:<span class="caitlyn-api-subjects">(<span class="caitlyn-api-subject">\[`\w+`\]\([^)]+\)<\/span>){14}<\/span>$/m);
  // The Slack command is a button that copies it (src/scripts/copy-command.ts)
  assert.match(siteBody, /<div class="caitlyn-follow">\n<p><strong>Get each release in Slack\.<\/strong>/);
  assert.match(siteBody, /<button type="button" class="caitlyn-copy-command" data-copy="\/feed subscribe https:\/\/build\.caitlyn\.ai\/changelog\/feed\.xml" aria-label="Copy the command: [^"]+"><code>\/feed subscribe https:\/\/build\.caitlyn\.ai\/changelog\/feed\.xml<\/code>/);
  assert.match(body, /run `\/feed subscribe https:\/\/build\.caitlyn\.ai\/changelog\/feed\.xml`/, 'the Markdown copy keeps the command inline');
  // The Markdown copy keeps the plain line, with no styling spans
  assert.match(body, /^- Each request's `ifMatch` .*, in 14 operations: \[`CreateDocumentVersion`\]/m);
  assert.doesNotMatch(body, /caitlyn-(see|entry-title|api-subject)/);
});

test('the feed carries the highlights and the API changes too, and passes the public-wording check', () => {
  const feed = atomFeed(parseChangelog(section), pages, { base: 'https://build.caitlyn.ai' });
  assert.match(feed, /One page:/);
  assert.match(feed, /Breaking in the API/);
  // The summary, what Slack's RSS app shows under the title: the breaking change first, then the headline changes
  assert.match(feed, /<summary>Includes a breaking change\. One page of any list\. [^<]*And \d+ changes? in the API\.<\/summary>/);
  assert.match(feed, /href=&quot;https:\/\/build\.caitlyn\.ai\/pagination\/#read-one-page&quot;/);
});

test("a merge request's Unreleased entry heads the page, marks its own entries, and never reaches the feed", () => {
  const preview = renderSection({ version: 'Unreleased', date: '2026-12-01', entries });
  assert.match(preview, /^# Unreleased \(2026-12-01\)\n/);
  const [unreleased] = parseChangelog(preview);
  assert.equal(unreleased.unreleased, true);
  unreleased.since = 'v0.11.0';
  for (const c of unreleased.changes) c.thisMr = c.subject === 'one page of any list';
  const page = changelogPage([unreleased, ...parseChangelog(section)], pages);
  assert.match(page.siteBody, /<section class="caitlyn-release" data-kind="unreleased"[^>]*>[\s\S]*?## Unreleased \{#unreleased\}/);
  assert.match(page.siteBody, /since v0\.11\.0/);
  assert.ok(page.siteBody.includes(`**TypeScript:** One page of any list</span> ${THIS_MR}`), 'its own entry is marked');
  assert.ok(!page.siteBody.includes(`A commit with no change file</span> ${THIS_MR}`), 'an entry merged before it is not');
  assert.match(page.body, /\*\*TypeScript:\*\* One page of any list \*\(This merge request\)\*/, 'the Markdown copy says it in words');
  assert.ok(page.siteBody.indexOf('{#unreleased}') < page.siteBody.indexOf('{#v0-12-0}'));
  const feed = atomFeed([unreleased, ...parseChangelog(section)], pages, { base: 'https://build.caitlyn.ai' });
  assert.equal(feed.match(/Unreleased/), null);
});

test('a releasing title needs a change file of its type, and ! and breaking: true go together', () => {
  const feat = parseChangeFile(FILE, 'changes/pages.md');
  const breaking = { ...feat, breaking: true };
  assert.deepEqual(agreementProblems({ title: 'feat(typescript): pages', added: [feat] }), []);
  assert.deepEqual(agreementProblems({ title: 'build: faster make check', added: [] }), []);
  assert.deepEqual(agreementProblems({ title: 'fix(docs): a typo', added: [] }), [], 'a docs fix is left off the Changelog, so needs no file');
  assert.match(agreementProblems({ title: 'feat: pages', added: [] }).join(), /add a change file/);
  assert.match(agreementProblems({ title: 'fix: pages', added: [feat] }).join(), /type is feat, but the title's is fix/);
  assert.match(agreementProblems({ title: 'feat!: pages', added: [feat] }).join(), /needs breaking: true/);
  assert.match(agreementProblems({ title: 'feat: pages', added: [breaking] }).join(), /needs a ! before its colon: "feat!: pages"/);
  assert.match(agreementProblems({ title: 'chore: tidy', added: [feat] }).join(), /makes none: use feat/);
  const dropped = [{ kind: 'enumValueRemoved', shape: 'IngestionBatchStatus', value: 'expired' }];
  assert.match(agreementProblems({ title: 'feat: pages', added: [feat], breakingApi: dropped }).join(), /break callers \(enumValueRemoved IngestionBatchStatus\.expired\)/);
  assert.deepEqual(agreementProblems({ title: 'feat!: pages', added: [breaking], breakingApi: dropped }), []);
});

test('a file written after its change merged names the commit, and is checked against that commit, not the title', () => {
  const late = parseChangeFile(FILE.replace('type: feat\n', 'type: feat\ncommit: c3b60ec0\n'), 'changes/ranges.md');
  assert.equal(late.describes, 'c3b60ec0');
  assert.deepEqual(late.problems, []);
  assert.match(parseChangeFile(FILE.replace('type: feat\n', 'type: feat\ncommit: HEAD~1\n'), 'x.md').problems.join(), /give the hash of the commit it describes/);
  const commit = (subject) => parseCommit({ hash: 'c3b60ec0', subject });
  const one = (over) => lateProblems([{ file: late, commit: commit('feat: every SDK refuses a value outside its range'), found: true, released: false, covered: false, ...over }]);
  assert.deepEqual(one({}), []);
  assert.match(one({ found: false }).join(), /not on the target branch/);
  assert.match(one({ released: true }).join(), /already released/);
  assert.match(one({ covered: true }).join(), /already has a change file/);
  assert.match(one({ commit: commit('fix: ranges') }).join(), /type is feat, but commit c3b60ec0's is fix/);
  assert.match(one({ commit: commit('feat!: ranges') }).join(), /breaking is false, but commit c3b60ec0 is breaking/);
  assert.match(one({ commit: commit('chore: ranges') }).join(), /makes no release/);
});

// The dry run: 0.10.0, 0.10.1 and 0.11.0's notes regenerated from their tags and the backfilled change files
const hasTags = (() => {
  try {
    for (const tag of ['v0.9.0', 'v0.10.0', 'v0.10.1', 'v0.11.0']) execFileSync('git', ['rev-parse', '--verify', '--quiet', `${tag}^{commit}`], { cwd: root, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();
test('the dry run regenerates 0.10.0, 0.10.1 and 0.11.0: every change file, every API change, nothing internal', { skip: hasTags ? false : 'this checkout has no release tags (a shallow clone)' }, async () => {
  const site = await sitePages();
  const run = (version, from, to) => {
    const dir = path.join(backfill, version);
    const files = fs.readdirSync(dir).map((f) => parseChangeFile(fs.readFileSync(path.join(dir, f), 'utf8'), f));
    return renderSection({ version, previousTag: from, date: '2026-11-20', ...collect({ from, to, files, site }) });
  };
  const v0100 = run('0.10.0', 'v0.9.0', 'v0.10.0');
  const v0101 = run('0.10.1', 'v0.10.0', 'v0.10.1');
  const v0110 = run('0.11.0', 'v0.10.1', 'v0.11.0');
  assert.match(v0100, /\* aligned error codes and safer batch uploads \(\[314e0dd\]/, "the file takes its release commit's place");
  assert.match(v0100, /### Breaking API changes\n\n\* \[`IngestionBatchStatus`\]\([^)]+\): drops the value `expired`\./);
  assert.match(v0101, /### New operations\n\n\* \[[^\]]+\]\(https:\/\/build\.caitlyn\.ai\/sdk\/cancel-ingestion-batch-item\/\) \(`CancelIngestionBatchItem`\)/);
  assert.match(v0101, /`uploadWindowSeconds`/);
  assert.match(v0101, /### Changed operations and types\n[^#]*`ifMatch` is now `EntityTagCondition` \(was `EntityTag`\)/, 'If-Match takes every entity tag it did, and *');
  assert.doesNotMatch(v0101, /### Breaking API changes/, 'a plain string that takes more values breaks no one');
  assert.doesNotMatch(v0101, /IngestionBatchBody/, 'a mixin is no type a reader meets');
  assert.doesNotMatch(v0110, /### (New operations|Changed operations|Breaking API)/, '0.11.0 left the model as it was');
  assert.doesNotMatch(`${v0100}${v0101}${v0110}`, /SDK 0\.1\d\.\d/, "no merge request title's internal phrasing");
  for (const line of `${v0100}${v0101}${v0110}`.split('\n')) assert.deepEqual(lineProblems(line), [], line);
});

test("the Unreleased preview reads main as the merge request branched from it, not main's tip", (t) => {
  // A clone with this checkout's scripts, where main has moved on past the branch: an entry merged since may link a
  // page this branch's tree lacks, which failed the preview's docs build (!105) until the branch merged main in
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unreleased-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' } });
  execFileSync('git', ['clone', '-q', '--shared', '--no-checkout', root, dir]);
  git('checkout', '-q', '--detach', execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim());
  fs.cpSync(path.join(root, 'scripts'), path.join(dir, 'scripts'), { recursive: true });
  if (fs.existsSync(path.join(root, 'build/model'))) fs.cpSync(path.join(root, 'build/model'), path.join(dir, 'build/model'), { recursive: true });
  const branch = git('rev-parse', 'HEAD').trim();
  git('checkout', '-q', '-b', 'moved-on');
  fs.writeFileSync(path.join(dir, 'changes/zz-moved-on.md'), '---\ntype: feat\nsummary: a change main gained after the branch\n---\n');
  git('add', 'changes/zz-moved-on.md');
  git('commit', '-q', '-m', 'feat: a change main gained after the branch');
  const preview = () =>
    execFileSync(process.execPath, ['scripts/release-notes.mjs', 'unreleased'], { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI_MERGE_REQUEST_TARGET_BRANCH_NAME: 'moved-on', CI_MERGE_REQUEST_TITLE: 'test: a branch behind main' } });
  git('checkout', '-q', '--detach', branch);
  assert.doesNotMatch(preview(), /a change main gained after the branch/, 'a branch behind main previews main as it branched');
  git('merge', '-q', '--ff-only', 'moved-on');
  assert.match(preview(), /a change main gained after the branch/, 'merging main in brings the preview up to date');
});
