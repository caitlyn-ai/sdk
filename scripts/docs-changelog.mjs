// The developer site's Changelog (/changelog/) and its Atom feed (/changelog/feed.xml): every SDK release, from
// CHANGELOG.md, the release notes semantic-release writes with each SDK release (.releaserc.yml), and every API release,
// from model/changes/<version>.json, the changes.json the app publishes with each release's model and
// scripts/model-pull.sh keeps. One entry per release, newest first by date, with its date, version, what changed and
// links to the pages each change touches. scripts/docs-build.mjs adds the page and writes the feed;
// docs/site/astro.config.mjs names the feed in every page's head.
//
// CHANGELOG.md has one heading per release, `# [0.8.0](compare url) (2026-11-15)` (a patch release's is `##`), then
// `### Features`, `### Bug Fixes` or `### BREAKING CHANGES`, each a list of `* **scope:** subject ([hash](url))`.
//
// A changes.json is { model, version, date, previousVersion, changes: [{ kind, surface: 'ga' | 'beta', ... }] }, its
// kinds operationAdded, operationRemoved, stabilityChanged, errorAdded, errorRemoved, serviceErrorAdded,
// serviceErrorRemoved, errorCodeAdded, errorCodeRemoved, memberAdded, memberRemoved, memberChanged, enumValueAdded and enumValueRemoved.
import fs from 'node:fs';
import path from 'node:path';

const SECTION_NAMES = {
  Features: 'New',
  'Bug Fixes': 'Fixes',
  'Performance Improvements': 'Performance',
  Reverts: 'Reverted',
};
// A change's scope, as a reader would name it
const SCOPE_NAMES = { typescript: 'TypeScript', python: 'Python', go: 'Go', rust: 'Rust', auth: 'Sign-in', retry: 'Retries', docs: 'Developer docs', cli: 'CLI', model: 'API' };
// The page a scope, or a word in a change, is about (only pages the site builds are linked)
const SCOPE_PAGES = { auth: 'authentication', retry: 'retries', stream: 'streaming', pagination: 'pagination', telemetry: 'telemetry', errors: 'errors' };
const TOPIC_WORDS = [
  [/\bstream(?:s|ing)?\b|\bSTREAM_LOST\b|\bwatch\b/i, 'streaming'],
  [/\bretr(?:y|ies)\b/i, 'retries'],
  [/\brefresh token\b|\bsign(?:-| )?in\b|\bOAuth\b|\bcredential/i, 'authentication'],
  [/\bpaginat|\bnext page\b|\bcursor\b/i, 'pagination'],
  [/\btelemetry\b|\bOpenTelemetry\b|\btrace\b/i, 'telemetry'],
  [/\bingest/i, 'guides/how-ingestion-works'],
  [/\b(?:Caitlyn|Validation)Error\b|\bCaitlyn errors?\b/, 'errors'],
  [/\bevery operation\b/i, 'sdk'],
];
// The order a release's changes are listed in
const SECTION_ORDER = ['Breaking changes', 'New', 'Fixes', 'Performance', 'Reverted'];
const sectionsOf = (r) => [...new Set(r.changes.map((c) => c.section))].sort((a, b) => (SECTION_ORDER.indexOf(a) + 1 || 99) - (SECTION_ORDER.indexOf(b) + 1 || 99));

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** "2026-11-16" -> "16 November 2026" */
export const longDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${d} ${MONTHS[m - 1]} ${y}`;
};
/** The release's heading id: 0.8.2 -> v0-8-2 */
export const releaseId = (version) => `v${version.replace(/\./g, '-')}`;
/** An API release's heading id: 5.115.0 -> api-5-115-0 */
export const apiReleaseId = (version) => `api-${version.replace(/\./g, '-')}`;
const idOf = (r) => (r.api ? apiReleaseId(r.version) : releaseId(r.version));

/**
 * The releases in CHANGELOG.md, newest first: { version, date, compare, changes: [{ section, scope, subject, commit, url,
 * breaking, highlights }] }. A change's `highlights` are the indented list written under it by hand (its parts, each
 * linking its guide), which semantic-release leaves alone once the release is written.
 */
export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
  let last = null;
  for (const line of markdown.split('\n')) {
    const head = /^#{1,2} (?:\[(\d+\.\d+\.\d+)\]\(([^)]+)\)|(\d+\.\d+\.\d+))(?: "[^"]*")? \((\d{4}-\d{2}-\d{2})\)\s*$/.exec(line);
    if (head) {
      release = { version: head[1] ?? head[3], compare: head[2] ?? null, date: head[4], changes: [] };
      releases.push(release);
      section = null;
      continue;
    }
    const sec = /^### (.+?)\s*$/.exec(line);
    if (sec && release) {
      section = sec[1];
      last = null;
      continue;
    }
    const sub = /^ {2,}[*-] (.+?)\s*$/.exec(line);
    if (sub && last) {
      (last.highlights ??= []).push(sub[1]);
      continue;
    }
    const item = /^\* (?:\*\*([^*]+):\*\* )?(.*?)(?: \(\[([0-9a-f]{7,40})\]\(([^)]+)\)\))?(?:, closes .*)?\s*$/.exec(line);
    if (item && release && section) {
      const [, scope = null, subject, commit = null, url = null] = item;
      if (section === 'BREAKING CHANGES') {
        // semantic-release repeats a breaking change's subject here; mark the change it repeats, or list it alone
        const same = release.changes.find((c) => c.subject === subject && c.scope === scope);
        if (same) same.breaking = true;
        else release.changes.push((last = { section: 'Breaking changes', scope, subject, commit, url, breaking: true }));
        if (same) last = null;
      } else release.changes.push((last = { section: SECTION_NAMES[section] ?? section, scope, subject, commit, url, breaking: false }));
    }
  }
  return releases;
}

/**
 * The pages one change touches, as { title, link }: its scope's page, the pages its words are about, and every
 * operation, type or error code it names (an operation by its model name or any SDK's method name). `pages` is the
 * site's pages ({ slug, title, operation?, kind }); a page the site does not build is never linked.
 */
export function changeLinks(change, pages) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const slugs = [];
  const add = (slug) => bySlug.has(slug) && !slugs.includes(slug) && slugs.push(slug);
  if (change.scope && SCOPE_PAGES[change.scope]) add(SCOPE_PAGES[change.scope]);
  for (const [re, slug] of TOPIC_WORDS) if (re.test(change.subject)) add(slug);
  // Each word, and a dotted name as the type it is (stream.reset: StreamReset)
  const words = new Set((change.subject.match(/[A-Za-z_][A-Za-z0-9_.]*[A-Za-z0-9]/g) ?? []).flatMap((w) => (w.includes('.') ? [w, ...w.split('.'), w.split('.').map((x) => x.charAt(0).toUpperCase() + x.slice(1)).join('')] : [w])));
  for (const p of pages) {
    const op = p.operation?.name;
    const names = op ? [op, op[0].toLowerCase() + op.slice(1), op.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()] : (p.kind === 'types' || p.kind === 'errors' || p.slug.startsWith('sdk/types/')) ? [p.title] : [];
    if (names.some((n) => words.has(n))) add(p.slug);
  }
  return slugs.map((s) => ({ title: bySlug.get(s).title, link: `/${s}/` }));
}

// ------------------------------------------------------------------------------------------------ API releases

const RELEASE = /^\d+\.\d+\.\d+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = ['operationAdded', 'operationRemoved', 'stabilityChanged', 'errorAdded', 'errorRemoved', 'serviceErrorAdded', 'serviceErrorRemoved', 'errorCodeAdded', 'errorCodeRemoved', 'memberAdded', 'memberRemoved', 'memberChanged', 'enumValueAdded', 'enumValueRemoved'];

/**
 * The API releases in a model/changes/ folder, newest first: { api: true, version, previousVersion, date, changes }, and
 * the problems with its files (a file the Changelog cannot read). No folder is no API release.
 */
export function readApiReleases(dir) {
  const releases = [];
  const problems = [];
  if (!fs.existsSync(dir)) return { releases, problems };
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()) {
    const where = path.join(path.basename(path.dirname(dir)), path.basename(dir), file);
    let c;
    try {
      c = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (e) {
      problems.push(`${where}: not JSON (${e.message})`);
      continue;
    }
    if (`${c.version}.json` !== file || !RELEASE.test(c.version ?? '')) problems.push(`${where}: names version ${c.version}, not the one its file name gives`);
    else if (!DATE.test(c.date ?? '')) problems.push(`${where}: has no date the Changelog can read`);
    else if (!Array.isArray(c.changes)) problems.push(`${where}: lists no changes`);
    else {
      for (const k of new Set(c.changes.map((x) => x.kind))) if (!KINDS.includes(k)) problems.push(`${where}: a change of kind ${k}, which the Changelog does not know`);
      releases.push({ api: true, version: c.version, previousVersion: c.previousVersion ?? null, date: c.date, changes: c.changes });
    }
  }
  return { releases: releases.sort((a, b) => b.date.localeCompare(a.date) || -compareReleases(a.version, b.version)), problems };
}
const compareReleases = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};

/** SDK and API releases together, newest first by date; on the same day the SDK release comes first. */
export function mergeReleases(sdk, api = []) {
  return [...sdk.map((r, i) => ({ r, i, k: 0 })), ...api.map((r, i) => ({ r, i, k: 1 }))]
    .sort((a, b) => b.r.date.localeCompare(a.r.date) || a.k - b.k || a.i - b.i)
    .map((x) => x.r);
}

const code = (s) => `\`${s}\``;
const list = (items) => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const STABILITY_NAMES = { ga: 'GA', beta: 'beta' };
const stabilityName = (s) => STABILITY_NAMES[s] ?? s;

/**
 * Where an API release's names link: an operation to its SDK reference page, a type to its type page, an error class
 * to its code's page (or, with several codes, to the Errors page's list of codes). Only pages the site builds are
 * linked, as for the SDK releases: an operation with no page yet is named, not linked. `errorCodes` is each error
 * class's codes ({ ConflictError: ['CONFLICT', ...] }).
 */
function apiLinker(pages, errorCodes = {}) {
  const bySlug = new Map(pages.map((p) => [p.slug, p]));
  const operation = new Map();
  for (const p of pages) if (p.operation?.name && p.kind !== 'api' && !operation.has(p.operation.name)) operation.set(p.operation.name, p);
  const type = new Map();
  for (const p of pages) if ((p.kind === 'types' || p.slug.startsWith('sdk/types/')) && !type.has(p.title)) type.set(p.title, p);
  const linked = new Set();
  const op = (name) => {
    const p = operation.get(name);
    if (!p) return code(name);
    linked.add(name);
    return `[${code(name)}](/${p.slug}/)`;
  };
  return {
    linked,
    op,
    opTitled: (name, title) => {
      const p = operation.get(name);
      if (!title) return op(name);
      if (!p) return `${title} (${code(name)})`;
      linked.add(name);
      return `[${title}](/${p.slug}/) (${code(name)})`;
    },
    type: (name) => (type.has(name) ? `[${code(name)}](/${type.get(name).slug}/)` : code(name)),
    // An error code: its own page, when the site has one (a code an error dropped has none)
    code: (name, status) => `${bySlug.has(`errors/${name}`) ? `[${code(name)}](/errors/${name}/)` : code(name)}${status ? ` (${status})` : ''}`,
    error: (name, status) => {
      const codes = errorCodes[name] ?? [];
      const st = status ? ` (${status})` : '';
      if (codes.length === 1 && bySlug.has(`errors/${codes[0]}`)) return `[${code(codes[0])}](/errors/${codes[0]}/)${st}`;
      if (bySlug.has('errors')) return `[${code(name)}](/errors/#error-codes)${st}`;
      return `${code(name)}${st}`;
    },
  };
}

// What a change to an operation or a type says, by kind (in this order within one entry)
const CHANGED_KINDS = ['serviceErrorAdded', 'serviceErrorRemoved', 'errorAdded', 'errorRemoved', 'errorCodeAdded', 'errorCodeRemoved', 'memberAdded', 'memberRemoved', 'memberChanged', 'enumValueAdded', 'enumValueRemoved'];

/**
 * An API release's sections, in the order a reader acts on them: { title, slug, badge, items: [Markdown] }. New
 * operations; changed operations and types (errors, error codes, members and enum values added, removed or changed);
 * stability changes; removed operations. A change that reaches only beta operations says so. An error code an error
 * class adds or drops is a change to each operation `codeOperations` names for it (the operations whose examples or
 * documentation give that code); a code no operation names is a change to the operations that return its class.
 */
export function apiSections(release, pages, { errorCodes, codeOperations = {} } = {}) {
  const link = apiLinker(pages, errorCodes);
  const beta = (changes) => (changes.every((c) => c.surface === 'beta') ? ' (beta)' : '');
  const of = (kind) => release.changes.filter((c) => c.kind === kind);
  const sections = [];

  const added = of('operationAdded').map((c) => `- ${link.opTitled(c.operation, c.title)}${beta([c])}`);
  if (added.length) sections.push({ title: 'New operations', slug: 'new-operations', badge: 'new', label: 'New', items: added });

  // Changes to operations and types, one entry each: an operation's errors and its request's and response's members
  // (its Input and Output shapes) are the operation's; any other shape is a type
  const subjects = new Map();
  for (const c of release.changes.filter((x) => CHANGED_KINDS.includes(x.kind))) {
    let key;
    let part = null;
    if (c.kind.startsWith('serviceError')) key = { sort: '', label: 'Every operation' };
    else if (c.kind.startsWith('errorCode')) {
      const ops = codeOperations[c.code] ?? [];
      if (ops.length) {
        for (const op of ops) {
          if (!subjects.has(`op:${op}`)) subjects.set(`op:${op}`, { sort: op, op, changes: [] });
          subjects.get(`op:${op}`).changes.push({ ...c, part: null });
        }
        continue;
      }
      key = { sort: c.error, label: `Operations that return ${link.error(c.error)}`, errorClass: c.error };
    } else if (c.operation) key = { sort: c.operation, op: c.operation };
    else {
      const io = /^(.+?)(Input|Output)$/.exec(c.shape);
      if (io) {
        key = { sort: io[1], op: io[1] };
        part = io[2] === 'Input' ? 'request' : 'response';
      } else key = { sort: c.shape, shape: c.shape };
    }
    const id = key.op ? `op:${key.op}` : key.shape ? `type:${key.shape}` : key.errorClass ? `class:${key.errorClass}` : 'service';
    if (!subjects.has(id)) subjects.set(id, { ...key, changes: [] });
    subjects.get(id).changes.push({ ...c, part });
  }
  const member = (c) => `${c.required ? 'the required ' : ''}${code(c.member)} (${link.type(c.target)})`;
  const memberChange = (c) => {
    // `member` is now T (was U), or now optional (was required)
    const now = [];
    const was = [];
    if (c.from.target !== c.to.target) {
      now.push(link.type(c.to.target));
      was.push(code(c.from.target));
    }
    if (c.from.required !== c.to.required) {
      now.push(c.to.required ? 'required' : 'optional');
      was.push(c.from.required ? 'required' : 'optional');
    }
    return `${code(c.member)} is now ${now.join(', ')} (was ${was.join(', ')})`;
  };
  const changed = [...subjects.values()]
    .sort((a, b) => a.sort.localeCompare(b.sort))
    .map((s) => {
      // The operation's or type's own changes first, then its request's, then its response's
      const parts = [];
      for (const part of [null, 'request', 'response']) {
        const phrases = [];
        for (const kind of CHANGED_KINDS) {
          const cs = s.changes.filter((c) => c.kind === kind && c.part === part);
          if (!cs.length) continue;
          if (kind === 'errorAdded' || kind === 'serviceErrorAdded') phrases.push(`can now return ${list(cs.map((c) => link.error(c.error, c.status)))}`);
          else if (kind === 'errorRemoved' || kind === 'serviceErrorRemoved') phrases.push(`no longer returns ${list(cs.map((c) => link.error(c.error, c.status)))}`);
          else if (kind === 'errorCodeAdded') phrases.push(`can now return ${list(cs.map((c) => link.code(c.code, c.status)))}`);
          else if (kind === 'errorCodeRemoved') phrases.push(`no longer returns ${list(cs.map((c) => link.code(c.code, c.status)))}`);
          else if (kind === 'memberAdded') phrases.push(`adds ${list(cs.map(member))}`);
          else if (kind === 'memberRemoved') phrases.push(`drops ${list(cs.map((c) => code(c.member)))}`);
          else if (kind === 'memberChanged') phrases.push(list(cs.map(memberChange)));
          else if (kind === 'enumValueAdded') phrases.push(`adds the ${cs.length === 1 ? 'value' : 'values'} ${list(cs.map((c) => code(c.value)))}`);
          else if (kind === 'enumValueRemoved') phrases.push(`drops the ${cs.length === 1 ? 'value' : 'values'} ${list(cs.map((c) => code(c.value)))}`);
        }
        // An error and a code it can now return are one "can now return …" (and the same for "no longer returns")
        for (const verb of ['can now return ', 'no longer returns ']) {
          const at = phrases.flatMap((x, i) => (x.startsWith(verb) ? [i] : []));
          if (at.length > 1) {
            phrases[at[0]] = verb + list(at.map((i) => phrases[i].slice(verb.length)).flatMap((x) => x.split(/, | and /)));
            for (const i of at.slice(1).reverse()) phrases.splice(i, 1);
          }
        }
        // "its request adds …", or "its request's `ifMatch` is now …" when a changed member comes first
        if (phrases.length) parts.push(part ? `its ${part}${phrases[0].startsWith('`') ? "'s" : ''} ${phrases.join('; ')}` : phrases.join('; '));
      }
      const phrases = parts;
      const subject = s.op ? link.op(s.op) : s.shape ? (errorCodes?.[s.shape] ? link.error(s.shape) : link.type(s.shape)) : s.label;
      return `- ${subject}${beta(s.changes)}: ${phrases.join('; ')}.`;
    });
  if (changed.length) sections.push({ title: 'Changed operations and types', slug: 'changed', badge: 'changed', label: 'Changed', items: changed });

  const stability = of('stabilityChanged').map((c) => `- ${link.op(c.operation)}: from ${stabilityName(c.from)} to ${stabilityName(c.to)}.`);
  if (stability.length) sections.push({ title: 'Stability changes', slug: 'stability', badge: 'stability', label: 'Stability', items: stability });

  const removed = of('operationRemoved').map((c) => `- ${code(c.operation)}${beta([c])}`);
  if (removed.length) sections.push({ title: 'Removed operations', slug: 'removed', badge: 'breaking', label: 'Removed', items: removed });
  return { sections, operations: [...link.linked] };
}

/** The sentence under an API release's heading. */
const apiIntro = (r) =>
  `${r.previousVersion ? `What changed in the Caitlyn API since Caitlyn ${r.previousVersion}` : "The Caitlyn API's first release"}, released with Caitlyn ${r.version}.${r.changes.length ? '' : ' Nothing in the public API changed.'}`;

// A subject starts a sentence, unless its first word is a name in code (createDocument, create_document, stream.reset)
const sentence = (s) => (/^[a-z][a-z'-]*\b(?![._(])/.test(s) && !/^[a-z]+[A-Z]/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const scopeName = (scope) => SCOPE_NAMES[scope] ?? sentence(scope.replace(/-/g, ' '));

// Entries about the developer docs or the repository's own CI change nothing in the SDKs: CHANGELOG.md keeps them,
// the Changelog page and its feed leave them out
const HIDDEN_SCOPES = new Set(['docs', 'ci']);
/** An SDK release's changes an integrator reads: every one but the docs and CI entries. */
export const shownChanges = (r) => r.changes.filter((c) => !HIDDEN_SCOPES.has(c.scope));

// An SDK release's groups, each under its badge: breaking changes first (wherever semantic-release listed them)
const SDK_GROUPS = [
  { badge: 'breaking', label: 'Breaking', slug: 'breaking', has: (c) => c.breaking },
  { badge: 'new', label: 'New', slug: 'new', has: (c) => c.section === 'New' },
  { badge: 'fixed', label: 'Fixed', slug: 'fixed', has: (c) => c.section === 'Fixes' },
  { badge: 'changed', label: 'Faster', slug: 'performance', has: (c) => c.section === 'Performance' },
  { badge: 'changed', label: 'Reverted', slug: 'reverted', has: (c) => c.section === 'Reverted' },
];
const SDK_GROUP_OF = (c) => SDK_GROUPS.find((g) => g.has(c)) ?? { badge: 'changed', label: sentence(c.section), slug: c.section.toLowerCase().replace(/[^a-z]+/g, '-') };

/** One SDK change as its entry: its scope, its subject as a sentence, and the pages it touches. */
function sdkEntry(c, pages, operations) {
  // A change with highlights links through them; its own words' links would undersell it
  const links = c.highlights?.length ? [] : changeLinks(c, pages);
  for (const l of links) {
    const p = pages.find((q) => `/${q.slug}/` === l.link);
    if (p?.operation) operations.add(p.operation.name);
  }
  const head = `- ${c.scope ? `**${scopeName(c.scope)}:** ` : ''}${sentence(c.subject)}${links.length ? `. See ${links.map((l) => `[${l.title}](${l.link})`).join(', ')}.` : ''}`;
  return [head, ...(c.highlights ?? []).map((h) => `  - ${siteLinks(h)}`)].join('\n');
}
/** The site's own address, as written in CHANGELOG.md (read on GitHub too), made a link within the site. */
const siteLinks = (md) => md.replace(/\]\(https:\/\/build\.caitlyn\.ai(\/[^)]*)\)/g, ']($1)');

/**
 * Each release as the page shows it: { id, kind ('SDK' or 'API'), version, date, intro, compare, groups: [{ badge,
 * label, slug, items: [Markdown] }] }, and the operations their entries link to.
 */
export function releaseViews(releases, pages, { errorCodes = {}, codeOperations = {} } = {}) {
  const operations = new Set();
  const views = releases.map((r) => {
    if (r.api) {
      const { sections, operations: ops } = apiSections(r, pages, { errorCodes, codeOperations });
      for (const o of ops) operations.add(o);
      return { id: apiReleaseId(r.version), kind: 'API', version: r.version, date: r.date, intro: r.changes.length ? null : 'Nothing in the public API changed.', compare: { link: '/api/', text: 'API reference' }, groups: sections.map((s) => ({ badge: s.badge, label: s.label, slug: s.slug, items: s.items })) };
    }
    const groups = [];
    for (const c of shownChanges(r)) {
      const g = SDK_GROUP_OF(c);
      let group = groups.find((x) => x.slug === g.slug);
      if (!group) groups.push((group = { badge: g.badge, label: g.label, slug: g.slug, items: [] }));
      group.items.push(sdkEntry(c, pages, operations));
    }
    const order = (g) => SDK_GROUPS.findIndex((x) => x.slug === g.slug) + 1 || 99;
    groups.sort((a, b) => order(a) - order(b));
    const previous = r.compare && /\/compare\/v?([\d.]+)\.\.\./.exec(r.compare)?.[1];
    return {
      id: releaseId(r.version),
      kind: 'SDK',
      version: r.version,
      date: r.date,
      intro: groups.length ? null : 'No change to the SDKs themselves.',
      compare: r.compare ? { link: r.compare, text: previous ? `Compare with ${previous}` : 'Every change in this release' } : null,
      groups,
    };
  });
  return { views, operations: [...operations].sort() };
}

const INTRO = (feed) => `Every SDK and API release, newest first. Read a breaking change before you upgrade. Follow them in a feed reader with the [Atom feed](${feed}).`;

/**
 * The Changelog page (no title): `body`, its Markdown copy, a heading per release and one per group; `siteBody`, the
 * site's timeline, a row per release with its version, date and SDK or API tag on the left and its entries under
 * their badges on the right (src/styles/components.css .caitlyn-release), so the page's contents list the versions
 * alone; and the operations its entries link to. `releases` are SDK and API releases together (mergeReleases).
 */
export function changelogPage(releases, pages, { feed = '/changelog/feed.xml', errorCodes = {}, codeOperations = {} } = {}) {
  const { views, operations } = releaseViews(releases, pages, { errorCodes, codeOperations });
  const md = [INTRO(feed), ''];
  const site = [INTRO(feed), '', '<div class="caitlyn-releases">', ''];
  for (const v of views) {
    const when = `${v.kind === 'API' ? 'API' : 'SDK'} release, ${longDate(v.date)}.`;
    md.push(`## ${v.kind === 'API' ? 'API ' : ''}${v.version} {#${v.id}}`, '', `${when}${v.intro ? ` ${v.intro}` : ''}${v.compare ? ` [${v.compare.text}](${v.compare.link}).` : ''}`, '');
    for (const g of v.groups) md.push(`### ${g.label} {#${v.id}-${g.slug}}`, '', ...g.items, '');

    site.push(
      `<section class="caitlyn-release" data-kind="${v.kind.toLowerCase()}"${v.groups.some((g) => g.badge === 'breaking') ? ' data-breaking' : ''}>`,
      '<div class="caitlyn-release-meta">',
      '',
      `## ${v.version} <span class="caitlyn-release-kind">${v.kind}</span> {#${v.id}}`,
      '',
      `<p class="caitlyn-release-date"><time datetime="${v.date}">${longDate(v.date)}</time></p>`,
      ...(v.compare ? [`<p class="caitlyn-release-compare"><a href="${v.compare.link}">${v.compare.text}</a></p>`] : []),
      '',
      '</div>',
      '<div class="caitlyn-release-entries">',
      '',
    );
    if (v.intro) site.push(`<p class="caitlyn-release-intro">${inlineHtml(v.intro)}</p>`, '');
    for (const g of v.groups) {
      site.push(`<div class="caitlyn-release-group" data-change="${g.badge}">`, `<p class="caitlyn-release-label"><span class="caitlyn-stability" data-change="${g.badge}">${g.label}</span></p>`, '', ...g.items, '', '</div>', '');
    }
    site.push('</div>', '</section>', '');
  }
  if (!views.length) {
    md.push('No release yet.', '');
    site.push('<p>No release yet.</p>', '');
  }
  site.push('</div>', '');
  return { body: md.join('\n'), siteBody: site.join('\n'), operations };
}

/** Inline Markdown (code, bold, links) as HTML, for text inside the timeline's own elements. */
const inlineHtml = (md) =>
  md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (md, base) =>
  esc(md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href.startsWith('/') ? base + href : href}">${text}</a>`);

/** The Atom feed: one entry per release, SDK and API alike, newest first, each linking to its heading on the Changelog page. */
export function atomFeed(releases, pages, { base, path: pagePath = '/changelog/', feed = '/changelog/feed.xml', errorCodes = {}, codeOperations = {} }) {
  const page = `${base}${pagePath}`;
  const updated = releases[0] ? `${releases[0].date}T00:00:00Z` : '1970-01-01T00:00:00Z';
  const entries = releases.map((r) => {
    let html;
    let title;
    let summary;
    if (r.api) {
      const { sections } = apiSections(r, pages, { errorCodes, codeOperations });
      html = `<p>${inline(apiIntro(r), base)}</p>${sections.map((s) => `<h3>${esc(s.title)}</h3><ul>${s.items.map((md) => `<li>${inline(md.replace(/^- /, ''), base)}</li>`).join('')}</ul>`).join('')}`;
      title = `Caitlyn API ${r.version}`;
      summary = `API release, ${longDate(r.date)}: ${r.changes.length} ${r.changes.length === 1 ? 'change' : 'changes'} to the Caitlyn API.`;
    } else {
      // The docs and CI entries are left out, as on the page
      const shown = { ...r, changes: shownChanges(r) };
      html = sectionsOf(shown)
        .map((s) => {
          const items = shown.changes.filter((c) => c.section === s).map((c) => {
            const links = changeLinks(c, pages);
            const md = `${c.breaking && s !== 'Breaking changes' ? '**Breaking.** ' : ''}${c.scope ? `**${scopeName(c.scope)}:** ` : ''}${sentence(c.subject)}${links.length ? `. See ${links.map((l) => `[${l.title}](${l.link})`).join(', ')}.` : ''}`;
            return `<li>${inline(md, base)}</li>`;
          });
          return `<h3>${esc(s)}</h3><ul>${items.join('')}</ul>`;
        })
        .join('');
      title = `Caitlyn SDKs ${r.version}`;
      summary = shown.changes.length ? `Released ${longDate(r.date)}: ${shown.changes.length} ${shown.changes.length === 1 ? 'change' : 'changes'}${shown.changes.some((c) => c.breaking) ? ', including a breaking change' : ''}.` : `Released ${longDate(r.date)}: no change to the SDKs themselves.`;
    }
    return [
      '  <entry>',
      `    <title>${title}</title>`,
      `    <id>${page}#${idOf(r)}</id>`,
      `    <link rel="alternate" type="text/html" href="${page}#${idOf(r)}"/>`,
      `    <updated>${r.date}T00:00:00Z</updated>`,
      `    <summary>${summary}</summary>`,
      `    <content type="html">${esc(html)}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Caitlyn SDK and API releases</title>',
    '  <subtitle>Every release of the Caitlyn SDKs and of the Caitlyn API: what changed, and the pages each change touches.</subtitle>',
    `  <id>${page}</id>`,
    `  <link rel="self" type="application/atom+xml" href="${base}${feed}"/>`,
    `  <link rel="alternate" type="text/html" href="${page}"/>`,
    `  <updated>${updated}</updated>`,
    '  <author><name>Caitlyn</name></author>',
    ...entries,
    '</feed>',
    '',
  ].join('\n');
}
