// The developer site's Changelog (/changelog/) and its Atom feed (/changelog/feed.xml), both from CHANGELOG.md, the
// release notes semantic-release writes with each SDK release (.releaserc.yml): one entry per release, newest first,
// with its date, version, what changed and links to the pages each change touches. scripts/docs-build.mjs adds the
// page and writes the feed; docs/site/astro.config.mjs names the feed in every page's head.
//
// CHANGELOG.md has one heading per release, `# [0.8.0](compare url) (2026-11-15)` (a patch release's is `##`), then
// `### Features`, `### Bug Fixes` or `### BREAKING CHANGES`, each a list of `* **scope:** subject ([hash](url))`.

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

/** The releases in CHANGELOG.md, newest first: { version, date, compare, changes: [{ section, scope, subject, commit, url, breaking }] }. */
export function parseChangelog(markdown) {
  const releases = [];
  let release = null;
  let section = null;
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
      continue;
    }
    const item = /^\* (?:\*\*([^*]+):\*\* )?(.*?)(?: \(\[([0-9a-f]{7,40})\]\(([^)]+)\)\))?(?:, closes .*)?\s*$/.exec(line);
    if (item && release && section) {
      const [, scope = null, subject, commit = null, url = null] = item;
      if (section === 'BREAKING CHANGES') {
        // semantic-release repeats a breaking change's subject here; mark the change it repeats, or list it alone
        const same = release.changes.find((c) => c.subject === subject && c.scope === scope);
        if (same) same.breaking = true;
        else release.changes.push({ section: 'Breaking changes', scope, subject, commit, url, breaking: true });
      } else release.changes.push({ section: SECTION_NAMES[section] ?? section, scope, subject, commit, url, breaking: false });
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

// A subject starts a sentence, unless its first word is a name in code (createDocument, create_document, stream.reset)
const sentence = (s) => (/^[a-z][a-z'-]*\b(?![._(])/.test(s) && !/^[a-z]+[A-Z]/.test(s) ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const scopeName = (scope) => SCOPE_NAMES[scope] ?? sentence(scope.replace(/-/g, ' '));

/** The Changelog page's Markdown body (no title), and the operations its changes link to. */
export function changelogPage(releases, pages, { feed = '/changelog/feed.xml' } = {}) {
  const lines = [
    `Every release of the Caitlyn SDKs, newest first: when it shipped, what changed, and the pages each change touches. A breaking change is marked; read it before you upgrade. Follow new releases in a feed reader with the [Atom feed](${feed}).`,
    '',
  ];
  const operations = new Set();
  for (const r of releases) {
    lines.push(`## ${r.version} {#${releaseId(r.version)}}`, '');
    lines.push(`Released ${longDate(r.date)}.${r.compare ? ` [Every commit in this release](${r.compare}).` : ''}`, '');
    for (const s of sectionsOf(r)) {
      lines.push(`### ${s} {#${releaseId(r.version)}-${s.toLowerCase().replace(/[^a-z]+/g, '-')}}`, '');
      for (const c of r.changes.filter((x) => x.section === s)) {
        const links = changeLinks(c, pages);
        for (const l of links) {
          const p = pages.find((q) => `/${q.slug}/` === l.link);
          if (p?.operation) operations.add(p.operation.name);
        }
        const parts = [
          c.breaking && c.section !== 'Breaking changes' ? '**Breaking.** ' : '',
          c.scope ? `**${scopeName(c.scope)}:** ` : '',
          sentence(c.subject),
          c.commit && c.url ? ` ([${c.commit}](${c.url}))` : '',
          links.length ? `. See ${links.map((l) => `[${l.title}](${l.link})`).join(', ')}.` : '',
        ];
        lines.push(`- ${parts.join('')}`);
      }
      lines.push('');
    }
  }
  if (!releases.length) lines.push('No release yet.', '');
  return { body: lines.join('\n'), operations: [...operations].sort() };
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const inline = (md, base) =>
  esc(md)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href.startsWith('/') ? base + href : href}">${text}</a>`);

/** The Atom feed: one entry per release, newest first, each linking to its heading on the Changelog page. */
export function atomFeed(releases, pages, { base, path = '/changelog/', feed = '/changelog/feed.xml' }) {
  const page = `${base}${path}`;
  const updated = releases[0] ? `${releases[0].date}T00:00:00Z` : '1970-01-01T00:00:00Z';
  const entries = releases.map((r) => {
    const html = sectionsOf(r)
      .map((s) => {
        const items = r.changes.filter((c) => c.section === s).map((c) => {
          const links = changeLinks(c, pages);
          const md = `${c.breaking && s !== 'Breaking changes' ? '**Breaking.** ' : ''}${c.scope ? `**${scopeName(c.scope)}:** ` : ''}${sentence(c.subject)}${links.length ? `. See ${links.map((l) => `[${l.title}](${l.link})`).join(', ')}.` : ''}`;
          return `<li>${inline(md, base)}</li>`;
        });
        return `<h3>${esc(s)}</h3><ul>${items.join('')}</ul>`;
      })
      .join('');
    return [
      '  <entry>',
      `    <title>Caitlyn SDKs ${r.version}</title>`,
      `    <id>${page}#${releaseId(r.version)}</id>`,
      `    <link rel="alternate" type="text/html" href="${page}#${releaseId(r.version)}"/>`,
      `    <updated>${r.date}T00:00:00Z</updated>`,
      `    <summary>Released ${longDate(r.date)}: ${r.changes.length} ${r.changes.length === 1 ? 'change' : 'changes'}${r.changes.some((c) => c.breaking) ? ', including a breaking change' : ''}.</summary>`,
      `    <content type="html">${esc(html)}</content>`,
      '  </entry>',
    ].join('\n');
  });
  return [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<feed xmlns="http://www.w3.org/2005/Atom">',
    '  <title>Caitlyn SDK releases</title>',
    '  <subtitle>Every release of the Caitlyn SDKs: what changed, and the pages each change touches.</subtitle>',
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
