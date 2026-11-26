// The release notes: each SDK release's section of CHANGELOG.md, which the developer site's Changelog and its feed,
// the GitLab release and the GitHub release all show. semantic-release runs it as its notes generator
// (.releaserc.yml, generateNotesCmd), so nobody writes or edits notes at release time. A section has:
//
//   - one entry per change file (changes/<name>.md, CONTRIBUTING.md "Release notes") added since the previous release:
//     its summary, linked to the commit that added it, and its highlights, each linking the pages it is about;
//   - a line for each releasing commit (feat, fix, perf, revert, or `!`) that added no change file, as before;
//   - what changed in the public API, from the model at the previous release tag to the one being released
//     (scripts/model-diff.mjs), each operation and type linked to its reference page. The model:main job's
//     `feat(model)` commits are covered by these, so they get no line of their own unless the API did not change;
//   - BREAKING CHANGES, listing every breaking change file, as semantic-release lists breaking commits.
//
// Commands:
//   node scripts/release-notes.mjs notes VERSION [LAST_TAG]   the section for VERSION, from LAST_TAG (default: the
//                                                              newest stable v* tag) to HEAD (semantic-release)
//   node scripts/release-notes.mjs check                      a merge request's change files and title agree, and
//                                                              read well (the changes:check job)
//   node scripts/release-notes.mjs dry-run VERSION FROM TO DIR
//                                                              the section VERSION would have had, from tag FROM to
//                                                              tag TO, with DIR's change files as if each had come
//                                                              with that range's releasing commit of its type
//   node scripts/release-notes.mjs unreleased                 the Unreleased section a merge request's docs preview
//                                                              shows (scripts/docs-build.mjs), as Markdown
//
// The check and the preview read the merge request from GitLab's predefined variables: CI_MERGE_REQUEST_TITLE,
// CI_MERGE_REQUEST_DIFF_BASE_SHA and CI_MERGE_REQUEST_TARGET_BRANCH_NAME.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { isBreaking, modelChanges, widens } from './model-diff.mjs';
import { apiSections, errorLinks } from './docs-changelog.mjs';
import { lineProblems } from './docs-wording.mjs';

export const root = path.resolve(import.meta.dirname, '..');
export const CHANGES_DIR = 'changes';
const GITHUB = 'https://github.com/caitlyn-ai/sdk';
export const SITE = 'https://build.caitlyn.ai';
/** A releasing type's CHANGELOG.md heading, in the order a section lists them. */
export const TYPE_HEADINGS = { feat: 'Features', fix: 'Bug Fixes', perf: 'Performance Improvements', revert: 'Reverts' };
/** The headings of the API's changes, in order; the breaking ones are listed together, last. */
export const API_HEADINGS = { 'new-operations': 'New operations', changed: 'Changed operations and types', stability: 'Stability changes', breaking: 'Breaking API changes' };
// Entries about the developer docs or this repository's CI change nothing in the SDKs (scripts/docs-changelog.mjs
// leaves them off the page), so they need no change file
const HIDDEN_SCOPES = new Set(['docs', 'ci']);
const HEADER = /^(\w+)(?:\(([^)]*)\))?(!)?: (.*)$/;
const FIELDS = ['type', 'scope', 'breaking', 'summary', 'commit'];

const git = (args, { allowFail = false } = {}) => {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).replace(/\n$/, '');
  } catch (e) {
    if (allowFail) return null;
    throw new Error(`git ${args.join(' ')}: ${e.stderr?.toString().trim() || e.message}`);
  }
};

// ------------------------------------------------------------------------------------------------ change files

/**
 * A change file: front matter (type, scope, breaking, summary, and commit for a file written after its change merged)
 * and a body that is a list of highlights, each `- **Lead:** what and why. See [Page](/page/).` Returns the parts, and
 * its problems as messages (none when it is fine).
 */
export function parseChangeFile(text, file = 'a change file') {
  const problems = [];
  const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text.replace(/\r\n/g, '\n'));
  if (!fm) return { file, problems: [`${file}: starts with no front matter between --- lines`] };
  const meta = {};
  for (const raw of fm[1].split('\n')) {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (!line || line.startsWith('#')) continue;
    const kv = /^([a-z]+):\s*(.*)$/.exec(line);
    if (!kv) problems.push(`${file}: the front matter line "${line}" is not "key: value"`);
    else if (!FIELDS.includes(kv[1])) problems.push(`${file}: the front matter has "${kv[1]}", which is none of ${FIELDS.join(', ')}`);
    else meta[kv[1]] = kv[2].replace(/^(["'])(.*)\1$/, '$2');
  }
  const type = meta.type;
  if (!TYPE_HEADINGS[type]) problems.push(`${file}: type is "${type ?? ''}"; give one of ${Object.keys(TYPE_HEADINGS).join(', ')}`);
  if (meta.breaking !== undefined && !['true', 'false'].includes(meta.breaking)) problems.push(`${file}: breaking is "${meta.breaking}"; give true or false`);
  const breaking = meta.breaking === 'true';
  const scope = meta.scope || null;
  const summary = (meta.summary ?? '').trim();
  const describes = meta.commit || null;
  if (describes && !/^[0-9a-f]{7,40}$/.test(describes)) problems.push(`${file}: commit is "${describes}"; give the hash of the commit it describes`);
  if (!summary) problems.push(`${file}: has no summary, the entry's first line`);
  else if (/\.$/.test(summary)) problems.push(`${file}: the summary ends with a full stop; it is a line, not a sentence`);

  const highlights = [];
  let current = null;
  for (const line of fm[2].split('\n')) {
    const item = /^[-*] (.*)$/.exec(line);
    if (item) highlights.push((current = item[1].trim()));
    else if (!line.trim()) current = null;
    else if (current !== null && /^\s+\S/.test(line)) highlights[highlights.length - 1] = `${highlights.at(-1)} ${line.trim()}`;
    else problems.push(`${file}: "${line.trim().slice(0, 60)}" is outside the list; the body is a list of highlights`);
  }
  for (const h of highlights) {
    const short = h.slice(0, 60);
    if (!/^\*\*[^*]+:\*\* \S/.test(h)) problems.push(`${file}: the highlight "${short}" does not start with a bold lead, "**Lead:** "`);
    if (!docLinks(h).length) problems.push(`${file}: the highlight "${short}" links no page of the developer docs; end it with "See [Page](/page/)."`);
    for (const href of [...h.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1])) {
      if (!href.startsWith('/') && !href.startsWith(`${SITE}/`) && !href.startsWith(`${GITHUB}/`)) problems.push(`${file}: the link ${href} is neither a page of the developer docs nor the public repository`);
      else if (href.startsWith('/') && !/\/(#[\w-]+)?$/.test(href)) problems.push(`${file}: the link ${href} names no page (page links end in /)`);
    }
  }
  if (breaking && !highlights.length) problems.push(`${file}: is breaking, so it needs a highlight saying what to change`);
  for (const [what, text2] of [['summary', summary], ['scope', scope ?? ''], ...highlights.map((h) => ['highlight', h])]) {
    for (const p of lineProblems(text2)) problems.push(`${file}: the ${what} ${p}`);
  }
  return { file, type, scope, breaking, summary, highlights, describes, problems };
}

/** The developer-docs links in a line, site-relative ("/streaming/", "/sdk/#groups"). */
export const docLinks = (md) =>
  [...md.matchAll(/\]\(([^)\s]+)\)/g)].map((m) => m[1]).filter((h) => h.startsWith('/') || h.startsWith(`${SITE}/`)).map((h) => h.replace(SITE, ''));

/** A conventional commit's header (and a BREAKING CHANGE footer), as semantic-release reads it; null when it is not one. */
export function parseCommit({ hash = null, subject, body = '' }) {
  const m = HEADER.exec(subject.trim().replace(/^(?:\[?(?:Draft|WIP)\]?:?\s*|\(Draft\)\s*)/i, ''));
  if (!m) return null;
  return { hash, type: m[1], scope: m[2] || null, breaking: !!m[3] || /^BREAKING[ -]CHANGE: /m.test(body), subject: m[4] };
}
/** Whether a commit makes a release (and so takes a line of the notes). */
export const releases = (c) => !!c && (!!TYPE_HEADINGS[c.type] || c.breaking);

// ------------------------------------------------------------------------------------------------ git reads

/** The newest stable release tag (vX.Y.Z, never a beta's) reachable from `ref`, or null before the first release. */
export const lastTag = (ref = 'HEAD') => git(['describe', '--tags', '--abbrev=0', '--match', 'v[0-9]*.[0-9]*.[0-9]*', '--exclude', 'v*-*', ref], { allowFail: true });
const resolves = (ref) => !!ref && git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true }) !== null;
/** Whether a path is a change file: changes/<name>.md, the README excepted. */
const isChangeFile = (f) => new RegExp(`^${CHANGES_DIR}/[^/]+\\.md$`).test(f) && f !== `${CHANGES_DIR}/README.md`;
/** The change files in `ref`'s tree: changes/*.md, its README excepted. */
const changeFilesAt = (ref) =>
  ref ? (git(['ls-tree', '--name-only', `${ref}:${CHANGES_DIR}`], { allowFail: true }) ?? '').split('\n').filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => `${CHANGES_DIR}/${f}`) : [];
const show = (ref, file) => git(['show', `${ref}:${file}`], { allowFail: true });
const modelAt = (ref) => {
  const text = ref ? show(ref, 'model/model.json') : null;
  return text ? JSON.parse(text) : null;
};
/**
 * The API's changes from one model to another, as the notes list them: scripts/model-diff.mjs's, less the changes to
 * mixins (a structure's shared members, such as IngestionBatchBody), which no SDK names and no page documents; each
 * change shows on the structures that use the mixin.
 */
export function apiChanges(before, after) {
  const mixins = new Set([before, after].flatMap((m) => Object.entries(m?.shapes ?? {}).filter(([, s]) => s.traits?.['smithy.api#mixin']).map(([id]) => id.split('#')[1])));
  return modelChanges(before, after)
    .filter((c) => !(c.shape && mixins.has(c.shape)))
    .map((c) => (widens(c, before, after) ? { ...c, widens: true } : c));
}
/** The commit that added `file` between `from` and `to` (a squash commit, as merge requests are squashed). */
const addedBy = (from, to, file) => git(['log', '--diff-filter=A', '--format=%H', from ? `${from}..${to}` : to, '--', file], { allowFail: true })?.split('\n').filter(Boolean).at(-1) ?? null;
/** The full hash of a commit, or null when there is none. */
const resolveCommit = (ref) => git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { allowFail: true });

/** A commit's subject and body. */
function commitMessage(hash) {
  const [subject, body = ''] = git(['show', '-s', '--format=%s%x1f%b', hash]).split('\x1f');
  return { subject, body };
}

/** Every commit from `from` (exclusive) to `to`, oldest first, as { hash, subject, body }. */
function commitsIn(from, to) {
  const out = git(['log', '--reverse', '--no-merges', '--format=%H%x1f%s%x1f%b%x1e', from ? `${from}..${to}` : to]);
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, subject, body] = r.split('\x1f');
      return { hash, subject, body: body ?? '' };
    });
}
const utcDate = (iso) => new Date(iso).toISOString().slice(0, 10);
// The working tree's change files and model: in CI the commit being built; locally, what you have not committed yet too
const workFiles = () => (fs.existsSync(path.join(root, CHANGES_DIR)) ? fs.readdirSync(path.join(root, CHANGES_DIR)).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => `${CHANGES_DIR}/${f}`).sort() : []);
const readWork = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const workModel = () => JSON.parse(readWork('model/model.json'));

// ------------------------------------------------------------------------------------------------ the site's pages

/**
 * The pages the API's changes link to, as the docs build makes them from the model: every reference page
 * (scripts/docs-reference.mjs referencePages) and the Errors page. The docs build passes its own list instead.
 */
export async function sitePages() {
  if (!fs.existsSync(path.join(root, 'build/model/model.json'))) execFileSync(process.execPath, [path.join(root, 'scripts/prepare-model.mjs')], { cwd: root, stdio: ['ignore', 'ignore', 'inherit'] });
  const { loadModel } = await import('./docs-model.mjs');
  const { referencePages } = await import('./docs-reference.mjs');
  const ast = loadModel();
  // The SDK reference's pages are at /sdk/: the generator still writes /reference/, which the docs build moves
  const pages = referencePages(ast).pages.map((p) => ({ ...p, slug: p.slug.replace(/^reference\//, 'sdk/'), kind: p.group === 'errors' ? 'errors' : p.group === 'types' ? 'types' : 'reference' }));
  if (fs.existsSync(path.join(root, 'docs/errors.md'))) pages.push({ slug: 'errors', title: 'Errors', kind: 'pages' });
  return { pages, ...errorLinks(ast) };
}

// ------------------------------------------------------------------------------------------------ a release

/**
 * The API's changes as the notes list them: { key, heading, items: [{ md, subject }] } in API_HEADINGS order. The
 * breaking changes (scripts/model-diff.mjs isBreaking) are listed together under their own heading, so a reader
 * sees them first; the rest under new operations, changed operations and types, and stability changes. Links are
 * site-relative.
 */
export function apiGroups(changes, { pages, errorCodes = {}, codeOperations = {} }) {
  const groups = [];
  const subjectOf = (md) => md.replace(/^- /, '').split(/: | \(beta\)/)[0];
  const rest = apiSections({ changes: changes.filter((c) => !isBreaking(c)) }, pages, { errorCodes, codeOperations }).sections;
  for (const s of rest) groups.push({ key: s.slug, heading: API_HEADINGS[s.slug] ?? s.title, items: s.items.map((md) => ({ md: md.replace(/^- /, ''), subject: subjectOf(md) })) });
  const breaking = apiSections({ changes: changes.filter(isBreaking) }, pages, { errorCodes, codeOperations }).sections;
  // A removed operation's line is its name alone in apiSections; here it sits among other changes, so it says so
  const items = breaking.flatMap((s) => s.items.map((md) => ({ md: `${md.replace(/^- /, '')}${s.slug === 'removed' ? ': removed.' : ''}`, subject: subjectOf(md) })));
  if (items.length) groups.push({ key: 'breaking', heading: API_HEADINGS.breaking, items });
  return groups.sort((a, b) => Object.keys(API_HEADINGS).indexOf(a.key) - Object.keys(API_HEADINGS).indexOf(b.key));
}

/**
 * What a release's notes say: { entries, api } from the change files and the commits from `from` to `to`, and the
 * model's changes between them. `files` replaces the change files (a dry run's); `extra` adds commits not yet made
 * (a merge request's title, which becomes its squash commit).
 */
export function collect({ from, to = 'HEAD', files = null, extra = [], modelFrom = from, modelTo = to, site }) {
  const commits = [...commitsIn(from, to).map((c) => parseCommit(c)), ...extra].filter(releases);
  // A file that names the commit it describes (one written after its change merged) stands for that commit
  const changeFiles = (files ?? changeFilesAt(to).filter((f) => !changeFilesAt(from).includes(f)).map((f) => ({ ...parseChangeFile(show(to, f), f), commit: addedBy(from, to, f) }))).map((f) =>
    f.describes ? { ...f, commit: resolveCommit(f.describes) ?? f.describes } : f,
  ).filter((f) => !f.describes || commits.some((c) => c.hash === f.commit)); // one for an earlier release's commit is that release's
  // A dry run's files have no commit of their own: each stands for a releasing commit of its type in the range
  if (files) {
    const free = [...commits];
    for (const f of changeFiles.filter((c) => !c.describes)) {
      const i = free.findIndex((c) => c.type === f.type);
      if (i >= 0) f.commit = free.splice(i, 1)[0].hash;
    }
  }
  const covered = new Set(changeFiles.map((f) => f.commit).filter(Boolean));
  // modelTo null is the working tree's model (the preview's: the merge request's own snapshot)
  const api = apiChanges(modelAt(modelFrom), modelTo === null ? workModel() : modelAt(modelTo));
  const entries = [
    ...changeFiles.map((f) => ({ type: f.type, scope: f.scope, breaking: f.breaking, subject: f.summary, highlights: f.highlights, commit: f.commit, file: f.file, problems: f.problems })),
    // The model:main job's commits are what the API's changes list, unless the API did not change
    ...commits.filter((c) => !covered.has(c.hash) && !(c.scope === 'model' && api.length)).map((c) => ({ type: TYPE_HEADINGS[c.type] ? c.type : 'feat', scope: c.scope, breaking: c.breaking, subject: c.subject, highlights: [], commit: c.hash, file: null, problems: [] })),
  ];
  return { entries, api, apiGroups: apiGroups(api, site) };
}

const absolute = (md) => md.replace(/\]\((\/[^)\s]*)\)/g, `](${SITE}$1)`);
const isPatch = (version) => /^\d+\.\d+\.[1-9]\d*$/.test(version);

/** A release's section of CHANGELOG.md, as semantic-release's notes generator wrote one, with every link absolute. */
export function renderSection({ version, previousTag, date, entries, apiGroups: groups = [] }) {
  const tag = /^\d/.test(version) ? `v${version}` : null;
  const title = tag && previousTag ? `[${version}](${GITHUB}/compare/${previousTag}...${tag})` : version;
  const out = [`${isPatch(version) ? '##' : '#'} ${title} (${date})`, '', ''];
  const line = (e, withCommit = true) => `* ${e.scope ? `**${e.scope}:** ` : ''}${e.subject}${withCommit && e.commit ? ` ([${e.commit.slice(0, 7)}](${GITHUB}/commit/${e.commit}))` : ''}`;
  for (const [type, heading] of Object.entries(TYPE_HEADINGS)) {
    const these = entries.filter((e) => e.type === type);
    if (!these.length) continue;
    out.push(`### ${heading}`, '');
    for (const e of these) out.push(line(e), ...e.highlights.map((h) => `  * ${absolute(h)}`));
    out.push('', '');
  }
  for (const g of groups) out.push(`### ${g.heading}`, '', ...g.items.map((i) => `* ${absolute(i.md)}`), '', '');
  const breaking = entries.filter((e) => e.breaking);
  if (breaking.length) out.push('### BREAKING CHANGES', '', ...breaking.map((e) => line(e, false)), '', '');
  return `${out.join('\n').replace(/\n+$/, '')}\n`;
}

// ------------------------------------------------------------------------------------------------ merge requests

/** The merge request this pipeline runs for, from GitLab's predefined variables (or the given values). */
function mergeRequest(env = process.env) {
  const target = env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME || 'main';
  const main = [`origin/${target}`, target, env.CI_MERGE_REQUEST_DIFF_BASE_SHA].find(resolves) ?? 'HEAD';
  const base = git(['merge-base', main, 'HEAD'], { allowFail: true }) ?? main;
  return { title: env.CI_MERGE_REQUEST_TITLE ?? '', main, base };
}

/**
 * The Unreleased section: what the next release's notes would say if it were cut once this merge request merged.
 * The change files and releasing commits merged to main since the last release, this merge request's change files,
 * its title as the squash commit it becomes (when it adds no change file), and the model's changes since the last
 * release. Returns { markdown, thisMr: { subjects } }: the subjects of the entries and API lines this merge request
 * adds, which the preview marks.
 */
export function unreleased({ site, env = process.env, date = utcDate(Date.now()) } = {}) {
  const mr = mergeRequest(env);
  const from = lastTag(mr.main) ?? lastTag('HEAD');
  const onMain = collect({ from, to: mr.main, modelTo: null, site });
  const pending = new Set([...changeFilesAt(from), ...changeFilesAt(mr.main)]);
  // A file naming its commit (one written after that change merged) takes the place of the commit's own line
  const own = workFiles().filter((f) => !pending.has(f)).map((f) => {
    const parsed = parseChangeFile(readWork(f), f);
    return { ...parsed, commit: parsed.describes ? resolveCommit(parsed.describes) : null };
  });
  const replaced = new Set(own.map((f) => f.commit).filter(Boolean));
  onMain.entries = onMain.entries.filter((e) => e.file || !replaced.has(e.commit));
  const title = parseCommit({ subject: mr.title });
  const titleEntry = !own.some((f) => !f.describes) && releases(title) && !HIDDEN_SCOPES.has(title.scope) ? [{ type: TYPE_HEADINGS[title.type] ? title.type : 'feat', scope: title.scope, breaking: title.breaking, subject: title.subject, highlights: [], commit: null }] : [];
  const mine = [...own.map((f) => ({ type: f.type, scope: f.scope, breaking: f.breaking, subject: f.summary, highlights: f.highlights, commit: f.commit })), ...titleEntry];
  // The model's changes this merge request makes: from where it branched to its own tree
  const ownApi = apiGroups(apiChanges(modelAt(mr.base), workModel()), site).flatMap((g) => g.items.map((i) => i.subject));
  const markdown = renderSection({ version: 'Unreleased', date, entries: [...onMain.entries, ...mine], apiGroups: onMain.apiGroups });
  // As CHANGELOG.md writes them, links absolute, so they match the parsed section's subjects
  return { markdown, from, thisMr: { subjects: [...mine.map((e) => e.subject), ...ownApi].map(absolute) } };
}

/**
 * Whether a merge request's title, the change files it adds and the model's breaking changes agree: a releasing
 * title comes with a change file of its type, a `!` with a breaking file and the other way round, and a model change
 * that breaks callers is marked breaking. `added` are parsed change files; `breakingApi` the model's breaking changes.
 */
export function agreementProblems({ title: raw, added = [], breakingApi = [] }) {
  const problems = [];
  const title = parseCommit({ subject: raw });
  const releasing = releases(title) && !HIDDEN_SCOPES.has(title.scope);
  if (releasing && !added.length) problems.push(`the title "${raw}" makes a release, so add a change file, changes/<name>.md, saying what changed and why (CONTRIBUTING.md, "Release notes")`);
  if (!releasing && added.length && title && !HIDDEN_SCOPES.has(title.scope)) problems.push(`${added.map((f) => f.file).join(', ')} describe a release, but the title's type "${title.type}" makes none: use ${[...new Set(added.map((f) => f.type))].join(' or ')} in the title`);
  if (releasing) {
    for (const f of added) if (f.type && TYPE_HEADINGS[title.type] && f.type !== title.type) problems.push(`${f.file}: type is ${f.type}, but the title's is ${title.type}`);
    const fileBreaking = added.some((f) => f.breaking);
    if (title.breaking && !fileBreaking) problems.push('the title is breaking (!), so a change file needs breaking: true and a highlight saying what to change');
    if (fileBreaking && !title.breaking) problems.push(`a change file is breaking, so the title needs a ! before its colon: "${title.type}${title.scope ? `(${title.scope})` : ''}!: ${title.subject}"`);
  }
  if (breakingApi.length && !(title?.breaking && added.some((f) => f.breaking))) {
    const what = breakingApi.slice(0, 5).map((c) => `${c.kind} ${[c.operation, c.shape, c.member, c.value, c.error].filter(Boolean).join('.')}`);
    problems.push(`the model's changes break callers (${what.join(', ')}${breakingApi.length > 5 ? ', …' : ''}): mark the title with ! and add a change file with breaking: true saying what to change`);
  }
  return problems;
}

/** The merge request check's problems: the change files it adds or edits read well, and agree with its title and model. */
export function mrProblems({ env = process.env } = {}) {
  const mr = mergeRequest(env);
  const before = new Set(changeFilesAt(mr.base));
  const touched = workFiles().filter((f) => !before.has(f) || show(mr.base, f) !== readWork(f).replace(/\n$/, ''));
  const parsed = touched.map((f) => parseChangeFile(readWork(f), f));
  const added = parsed.filter((f) => !before.has(f.file));
  const breakingApi = apiChanges(modelAt(mr.base), workModel()).filter(isBreaking);
  // A file naming its commit describes a change already on the target branch, not this merge request's
  const late = added.filter((f) => f.describes);
  const described = late.map((f) => {
    const hash = resolveCommit(f.describes);
    const onMain = hash && git(['merge-base', '--is-ancestor', hash, mr.main], { allowFail: true }) !== null;
    const commit = onMain ? parseCommit({ hash, ...commitMessage(hash) }) : null;
    const tag = onMain ? lastTag(mr.main) : null;
    const released = !!tag && git(['merge-base', '--is-ancestor', hash, tag], { allowFail: true }) !== null;
    const covered =
      onMain &&
      (git(['show', '--diff-filter=A', '--name-only', '--format=', hash, '--', `${CHANGES_DIR}/`]).split('\n').some((n) => isChangeFile(n)) ||
        changeFilesAt(mr.base).some((other) => {
          const d = parseChangeFile(show(mr.base, other), other).describes;
          return d && resolveCommit(d) === hash;
        }));
    return { file: f, commit, found: !!onMain, released, covered };
  });
  return [
    ...parsed.flatMap((f) => f.problems),
    ...lateProblems(described),
    ...agreementProblems({ title: mr.title, added: added.filter((f) => !f.describes), breakingApi }),
  ];
}

/**
 * The problems of change files that name the commit they describe: it must be on the target branch, make a release
 * of the file's type, not be released yet, agree on breaking, and have no other file. `described` is
 * [{ file, commit, found, released, covered }].
 */
export function lateProblems(described) {
  const problems = [];
  for (const { file: f, commit: c, found, released, covered } of described) {
    if (!found) problems.push(`${f.file}: names commit ${f.describes}, which is not on the target branch`);
    else if (released) problems.push(`${f.file}: names commit ${f.describes}, which is already released; its notes are in CHANGELOG.md`);
    else if (!releases(c)) problems.push(`${f.file}: names commit ${f.describes}, whose title makes no release`);
    else {
      const type = TYPE_HEADINGS[c.type] ? c.type : 'feat';
      if (f.type && f.type !== type) problems.push(`${f.file}: type is ${f.type}, but commit ${f.describes}'s is ${type}`);
      if (f.breaking !== c.breaking) problems.push(`${f.file}: breaking is ${f.breaking}, but commit ${f.describes} ${c.breaking ? 'is' : 'is not'} breaking`);
    }
    if (covered) problems.push(`${f.file}: commit ${f.describes} already has a change file`);
  }
  return problems;
}

// ------------------------------------------------------------------------------------------------ the commands

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const [cmd, ...args] = process.argv.slice(2);
  const fail = (msg, code = 2) => {
    console.error(msg);
    process.exit(code);
  };
  if (cmd === 'notes') {
    const [version, given] = args;
    if (!/^\d+\.\d+\.\d+/.test(version ?? '')) fail('Usage: node scripts/release-notes.mjs notes VERSION [LAST_TAG]');
    const from = given || lastTag('HEAD');
    const site = await sitePages();
    const r = collect({ from, to: 'HEAD', site });
    const bad = r.entries.flatMap((e) => e.problems);
    if (bad.length) fail(`The change files cannot be released as they are:\n${bad.map((p) => `  - ${p}`).join('\n')}`, 1);
    process.stdout.write(renderSection({ version, previousTag: from, date: utcDate(Date.now()), ...r }));
  } else if (cmd === 'dry-run') {
    const [version, from, to, dir] = args;
    if (!version || !from || !to || !dir) fail('Usage: node scripts/release-notes.mjs dry-run VERSION FROM TO DIR');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => parseChangeFile(fs.readFileSync(path.join(dir, f), 'utf8'), path.join(dir, f)));
    const site = await sitePages();
    const r = collect({ from, to, files, site });
    for (const p of r.entries.flatMap((e) => e.problems)) console.error(`warning: ${p}`);
    process.stdout.write(renderSection({ version, previousTag: from, date: utcDate(git(['log', '-1', '--format=%cI', to])), ...r }));
  } else if (cmd === 'check') {
    const problems = mrProblems();
    if (problems.length) {
      console.error(`This merge request's release notes need ${problems.length === 1 ? 'a change' : 'changes'}:`);
      for (const p of problems) console.error(`  - ${p}`);
      console.error('Fix them, push, or edit the title and rerun this job (GitLab starts no pipeline for a title edit).');
      process.exit(1);
    }
    console.log('release-notes: the change files, the title and the model agree');
  } else if (cmd === 'unreleased') {
    const site = await sitePages();
    const { markdown, thisMr } = unreleased({ site });
    process.stdout.write(markdown);
    if (thisMr.subjects.length) console.error(`This merge request adds: ${thisMr.subjects.join(' | ')}`);
  } else fail('Usage: node scripts/release-notes.mjs notes|check|dry-run|unreleased …');
}
