// The developer docs build (docs/README.md). It writes
//   build/docs/site/              the static site the publish jobs upload: Astro Starlight's HTML, a Markdown
//                                 copy of every page beside it (guides/x/index.html and guides/x.md), llms.txt
//                                 and llms-full.txt
//   build/docs/pages.json         one entry per page: its Markdown copy's path, public URL, title and metadata
// The pages are the hand-written ones in docs/ (scripts/docs-guides.mjs) and the API reference generated from the
// model (scripts/docs-reference.mjs). Markdown is the canonical output: each page is first written as Markdown
// with its knowledge-base metadata as front matter (scripts/docs-metadata.mjs), which is what the Markdown copy
// is; the HTML is built from the same text. The build fails on front matter ingestion would skip, on a guide
// whose code differs from its example, and on a page Starlight did not write.
// Usage: node scripts/docs-build.mjs   (reads build/model/model.json; scripts/docs-build.sh runs prepare-model and
//        installs docs/site first)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { frontMatter, metadataProblems, sinceVersion } from './docs-metadata.mjs';
import { MARKER, readPages } from './docs-guides.mjs';
import { allErrors, fillIfMatchOptional, fillNotAvailable, ifMatchOptional, kebab, loadModel, root } from './docs-model.mjs';
import { RENAMED_TYPES, referencePages, sdkOverview } from './docs-reference.mjs';
import { SDK_TYPES, addIngestionIntro, apiOverview, apiPages, entryTips, publishedOpenapi, sdkReturns, sdkTypePages, sidebarGroups, sidebarLabel } from './docs-api.mjs';
import { documentProblems, lineProblems } from './docs-wording.mjs';
import { LIVE_URL, isLive, lastModified, robotsTxt, sitemapXml } from './docs-sitemap.mjs';
import { atomFeed, changelogPage, mergeReleases, parseChangelog, readApiReleases } from './docs-changelog.mjs';

// Where the site is served: https://build.caitlyn.ai, at the root; a merge request's preview is the same build at the
// root of its own host (docs:preview). pages.json, llms.txt, the sitemap and the moved pages name these addresses.
const PROD_URL = LIVE_URL;
const out = path.join(root, 'build/docs');
const site = path.join(out, 'site');
const project = path.join(root, 'docs/site');
const content = path.join(project, 'src/content/docs');
const generated = path.join(project, 'src/generated');

const ast = loadModel();
let invalid = 0;
const fail = (where, problem) => {
  console.error(`${where}: ${problem}`);
  invalid++;
};

// ------------------------------------------------------------------------------------------------- the pages

/** The newest release tag (v1.2.3), for the install instructions; `vX.Y.Z` when the checkout has no tags. */
function latestRelease() {
  try {
    const tags = execFileSync('git', ['tag', '--list', 'v*', '--sort=-v:refname'], { cwd: root, encoding: 'utf8' }).split('\n').filter((t) => /^v\d+\.\d+\.\d+$/.test(t));
    return tags[0] ?? 'vX.Y.Z';
  } catch {
    return 'vX.Y.Z';
  }
}
const release = latestRelease();
if (release === 'vX.Y.Z') console.warn('docs-build: no v* release tag in this checkout, so the install instructions say vX.Y.Z');

/** A hand-written page's body (its "Not available yet" marker already filled, scripts/docs-model.mjs): without front matter, its `# title`, or the example markers (build plumbing). */
function handWrittenBody(markdown) {
  const lines = markdown.replace(/^---\n[\s\S]*?\n---\n/, '').split('\n');
  const title = lines.findIndex((l) => /^# /.test(l));
  if (title >= 0) lines.splice(title, 1);
  return lines
    .filter((l) => !MARKER.test(l.trim()))
    .join('\n')
    .replaceAll('{{sdkRelease}}', release)
    .replace(/^\n+/, '');
}

// Sections of hand-written pages that are not about the SDKs: each is a folder under docs/, shown in the sidebar
// after the guides with its pages in the order given (a page not listed goes last).
const SECTIONS = [
  { dir: 'embed', label: 'Embed', order: ['quick-start', 'embed-widget', 'iframe'] },
  { dir: 'sign-in', label: 'Sign-in and identity', order: ['options', 'microsoft', 'google-workspace', 'auth0'] },
  { dir: 'tools', label: 'Tools and connectors', order: ['deploy-an-mcp-server', 'user-identity-headers', 'amazon-connect-connector-role', 'connect-an-mcp-client'] },
];
const sectionPages = (s, list) => {
  const rank = (p) => { const i = s.order.indexOf(p.slug.slice(s.dir.length + 1)); return i < 0 ? s.order.length : i; };
  return list.filter((p) => p.kind === s.dir).sort((x, y) => rank(x) - rank(y));
};

const pages = [];
for (const p of readPages()) {
  for (const problem of p.problems) fail(p.file, problem);
  const section = SECTIONS.find((s) => p.slug.startsWith(`${s.dir}/`));
  pages.push({ slug: p.slug, title: p.title, metadata: p.metadata, body: handWrittenBody(fillIfMatchOptional(fillNotAvailable(p.markdown, { operations: p.metadata?.operations ?? [] }), ifMatchOptional(ast))), source: p.file, kind: p.slug.startsWith('guides/') ? 'guides' : section ? section.dir : 'pages' });
}
const reference = referencePages(ast);
for (const p of reference.pages) {
  for (const problem of metadataProblems(p.metadata)) fail(`${p.slug} (generated)`, problem);
  pages.push({ ...p, source: 'the model', kind: p.group === 'errors' ? 'errors' : p.group === 'types' ? 'types' : 'reference' });
}
// The groups the sidebars, the overviews and the OpenAPI document's tags share: the client tree (scripts/docs-api.mjs)
const tree = reference.tree;

// The SDK reference's overview (/sdk/): Getting started's install and first call, and Authentication's modes table
// (its links made to point at that page), as their readers know them
const gettingStarted = pages.find((p) => p.slug === 'getting-started')?.body ?? '';
const mdSection = (body, heading) => new RegExp(`^## ${heading}\\n([\\s\\S]*?)(?=^## )`, 'm').exec(body)?.[1] ?? '';
const tabGroup = (md) => /((?:^```\w+ tab="[^"]+"\n[\s\S]*?^```\n?)+)/m.exec(md)?.[1] ?? '';
const authBody = pages.find((p) => p.slug === 'authentication')?.body ?? '';
const modesTable = /^\| Mode \|[\s\S]*?(?=\n\n)/m.exec(authBody)?.[0] ?? '';
const overviewParts = { install: tabGroup(mdSection(gettingStarted, 'Install')), firstCall: tabGroup(mdSection(gettingStarted, 'Make a first call')), modes: modesTable.replace(/\]\(#/g, '](/authentication/#') };
for (const [part, md] of Object.entries(overviewParts)) if (!md.trim()) fail('scripts/docs-build.mjs', `the SDK reference's overview found no ${part} in Getting started or Authentication`);
pages.push({
  slug: 'sdk',
  title: 'Caitlyn v3 SDKs',
  metadata: { pageType: 'sdk', sinceVersion: Math.min(...reference.ops.map((o) => sinceVersion(o.since))), resources: [...new Set(reference.pages.filter((p) => p.operation).flatMap((p) => p.metadata.resources))], integrations: [], operations: reference.ops.map((o) => o.name) },
  ...sdkOverview(ast, reference.ops, reference.pages, { ...overviewParts, tree }),
  source: 'the model',
  kind: 'reference',
  group: 'overview',
  server: true,
});

// The HTTP API's reference (/api/, scripts/docs-api.mjs): the site's copy of the model's OpenAPI document, published at
// /api/openapi.json, and an overview and a page per operation built from it. Its text passes the same public-wording
// check as the pages.
const { doc: openapi, problems: openapiProblems } = publishedOpenapi(JSON.parse(fs.readFileSync(path.join(root, 'model/openapi.json'), 'utf8')), {
  ops: reference.ops,
  tree,
  sdkSlug: (op) => `sdk/${kebab(op.name)}`,
  examples: reference.examples,
});
for (const problem of openapiProblems) fail('model/openapi.json', problem);
for (const problem of documentProblems(openapi)) fail('the published OpenAPI document', problem);
const api = apiPages(openapi, {
  ast,
  ops: reference.ops,
  sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.operation.name, p])),
  typePages: reference.typePages,
  tree,
  unreleased: reference.unreleased,
  next: reference.next,
});
pages.push({
  slug: 'api',
  title: 'Caitlyn v3 HTTP API',
  metadata: { pageType: 'reference', sinceVersion: Math.min(...api.pages.map((p) => p.metadata.sinceVersion)), resources: [...new Set(api.pages.flatMap((p) => p.metadata.resources))], integrations: [], operations: api.pages.map((p) => p.operation.name) },
  ...apiOverview(api.pages, { tree }),
  source: 'the OpenAPI document',
  kind: 'api',
  group: 'overview',
  server: true,
  apiAnchors: api.anchors,
});
for (const p of api.pages) pages.push({ ...p, source: 'the OpenAPI document', kind: 'api' });
// What each SDK call returns and raises, in each language, for the response panes of both references' operation pages
// (src/components/OperationPanel.astro); the HTTP view keeps the HTTP response alone
const returned = sdkReturns({ ast, ops: reference.ops, tree, typePages: reference.typePages, sdkSlug: (op) => `sdk/${kebab(op.name)}` });
for (const p of pages) {
  if (!p.operation) continue;
  const r = returned[p.operation.name];
  for (const lang of ['typescript', 'python', 'go', 'rust']) if (!r?.returns[lang]) fail(`${p.slug} (generated)`, `no ${lang} return type for ${p.operation.name}: scripts/docs-api.mjs sdkReturns could not read it from the SDK`);
  p.operation = { ...p.operation, returns: r?.returns ?? {}, errorClasses: r?.errorClasses ?? {} };
}
// Every type a response pane names has a page: a model type's, an operation's Response section, or its entry in the
// SDK types area (scripts/docs-api.mjs sdkTypePages), whose pages are the SDK reference's
for (const [name, r] of Object.entries(returned)) {
  for (const [lang, names] of Object.entries(r.unlinked)) for (const n of names) fail(`sdk/${kebab(name)} (generated)`, `the ${lang} return type ${n} has no page: give its family in scripts/docs-api.mjs sdkTypeFamily`);
}
for (const p of sdkTypePages(returned[SDK_TYPES])) pages.push({ ...p, source: 'the SDKs', kind: 'reference' });
// "New to ingestion?" under the summary of every ingestion page, once the guide it points at is a page (scripts/docs-api.mjs)
if (!addIngestionIntro(pages)) console.warn('docs-build: no guides/how-ingestion-works page yet, so the ingestion pages leave out "New to ingestion?"');
// The SDK reference lives under /sdk/ (the HTTP API's reference is /api/). Its pages were /reference/, which the pages
// and the generator still write: each slug and link moves here, and every old address redirects to its new one.
const SDK_REFERENCE = 'sdk';
const moved = new Map();
for (const p of pages) {
  if (p.slug.startsWith('reference/')) {
    const to = `${SDK_REFERENCE}/${p.slug.slice('reference/'.length)}`;
    moved.set(`/${p.slug}/`, `/${to}/`);
    p.slug = to;
  }
  p.body = p.body.replace(/\]\(\/reference\//g, `](/${SDK_REFERENCE}/`);
  if (p.siteBody) p.siteBody = p.siteBody.replace(/\]\(\/reference\//g, `](/${SDK_REFERENCE}/`);
}
// The type pages one type per thing replaced (scripts/docs-reference.mjs RENAMED_TYPES) redirect to the thing's page,
// at the SDK reference's address and its old /reference/ one
for (const [from, to] of Object.entries(RENAMED_TYPES)) {
  const target = `/${SDK_REFERENCE}/types/${kebab(to)}/`;
  if (!pages.some((p) => `/${p.slug}/` === target)) fail('scripts/docs-reference.mjs', `RENAMED_TYPES sends ${from} to ${to}, which has no type page`);
  if (pages.some((p) => p.slug === `${SDK_REFERENCE}/types/${kebab(from)}`)) fail('scripts/docs-reference.mjs', `RENAMED_TYPES redirects ${from}, which still has a type page`);
  moved.set(`/${SDK_REFERENCE}/types/${kebab(from)}/`, target);
  moved.set(`/reference/types/${kebab(from)}/`, target);
}
// Every redirect (src/generated/redirects.json) sends its reader to a page the site builds, and none comes from one
for (const [from, to] of moved) {
  if (!pages.some((p) => `/${p.slug ? `${p.slug}/` : ''}` === to)) fail('the redirects', `${from} redirects to ${to}, which is no page`);
  if (pages.some((p) => `/${p.slug}/` === from)) fail('the redirects', `${from} redirects, but is a page`);
}
// The Changelog (/changelog/, scripts/docs-changelog.mjs): every SDK release in CHANGELOG.md, which semantic-release
// writes, and every API release in model/changes/ (scripts/model-pull.sh keeps each published model's changes.json
// there), newest first, with links to the pages each change touches; its Atom feed is written beside it after the build
const CHANGELOG_FEED = '/changelog/feed.xml';
const sdkReleases = parseChangelog(fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8'));
if (!sdkReleases.length) fail('CHANGELOG.md', 'no release headings the Changelog can read');
for (const r of sdkReleases) if (!r.changes.length) fail('CHANGELOG.md', `the ${r.version} release lists no change the Changelog can read`);
const apiReleases = readApiReleases(path.join(root, 'model/changes'));
for (const problem of apiReleases.problems) fail('the API releases', problem);
const releases = mergeReleases(sdkReleases, apiReleases.releases);
// Each error class's codes, so an API release's error links to its code's page
const errorCodes = Object.fromEntries(allErrors(ast).map((e) => [e.name, e.codes]));
// The operations each error code belongs to, for a code an error class adds or drops: those that return its class and
// give the code in an example or their documentation
const codeOperations = {};
{
  const service = Object.values(ast.shapes).find((x) => x.type === 'service');
  const serviceErrors = new Set((service.errors ?? []).map((e) => e.target));
  for (const e of allErrors(ast)) {
    for (const c of e.codes) {
      const ops = Object.entries(ast.shapes)
        .filter(([, sh]) => sh.type === 'operation' && (serviceErrors.has(e.id) || (sh.errors ?? []).some((x) => x.target === e.id)))
        .filter(([, sh]) => (sh.traits?.['smithy.api#documentation'] ?? '').includes(c) || JSON.stringify(sh.traits?.['smithy.api#examples'] ?? []).includes(`"${c}"`))
        .map(([id]) => id.split('#')[1])
        .sort();
      if (ops.length) codeOperations[c] = ops;
    }
  }
}
{
  const { body, siteBody, operations } = changelogPage(releases, pages, { feed: CHANGELOG_FEED, errorCodes, codeOperations });
  pages.push({
    slug: 'changelog',
    title: 'Changelog',
    metadata: { pageType: 'changelog', sinceVersion: 0, resources: [], integrations: [], operations },
    body,
    siteBody,
    source: 'CHANGELOG.md',
    kind: 'pages',
  });
}
/** The heading ids a page will have: github-slugger over each heading's text, or its {#id} (as on the site). */
function anchors(page) {
  const ids = new Set(['_top']);
  const seen = new Map();
  let fence = false;
  for (const line of page.body.split('\n')) {
    if (/^```/.test(line)) fence = !fence;
    const h = !fence && /^#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (!h) continue;
    const explicit = /[ \t]+\{#([^\s{}]+)\}[ \t]*$/.exec(h[1]);
    if (explicit) {
      ids.add(explicit[1]);
      continue;
    }
    const text = h[1].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '');
    const base = text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');
    const n = seen.has(base) ? seen.get(base) + 1 : 0;
    seen.set(base, n);
    ids.add(n ? `${base}-${n}` : base);
  }
  return ids;
}
const bySlugEarly = new Map(pages.map((p) => [p.slug, p]));
const slugs = new Set();
for (const p of pages) {
  if (slugs.has(p.slug)) fail(p.slug, 'two pages have this address');
  slugs.add(p.slug);
  if (/\.[^/]*$/.test(p.slug.split('/').pop())) fail(p.slug, 'the last path segment has a dot, which the hosting would serve as a file');
}
// No raw HTML headings: Astro gives them no id, while citation anchors count them (docs/site/test/heading-ids.test.mjs)
for (const p of pages) if (/^\s*<h[1-6][\s>]/im.test(p.body)) fail(p.source, 'a raw HTML heading; write it as a Markdown heading');
// Nothing on a page points readers at how Caitlyn is built (scripts/docs-wording.mjs). Prose is checked outside code;
// hosts and merge request links are checked everywhere.
for (const p of pages) {
  const where = p.source === 'the model' || p.source === 'the OpenAPI document' ? `${p.slug} (generated)` : p.source;
  let fence = false;
  for (const line of p.body.split('\n')) {
    if (/^\s*```/.test(line)) fence = !fence;
    for (const problem of lineProblems(line, { prose: !(fence || /^<!-- example:/.test(line)) })) fail(where, problem);
  }
}
// Every site-relative link must name a page (with its trailing slash), an anchor on it, or a published file.
for (const p of pages) {
  for (const m of p.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
    const [target, anchor] = m[1].split('#');
    if (target === '/llms.txt' || target === '/llms-full.txt' || target === '/api/openapi.json' || target === CHANGELOG_FEED) continue;
    // A file the site publishes as it is, such as a screenshot in docs/site/public/images/
    if (!target.endsWith('/') && fs.existsSync(path.join(project, 'public', target))) continue;
    const slug = target.replace(/^\/|\/$/g, '');
    if (!target.endsWith('/') || !slugs.has(slug)) fail((p.source === 'the model' || p.source === 'the OpenAPI document') ? `${p.slug} (generated)` : p.source, `the link ${m[1]} names no page (page links end in /)`);
    else if (anchor !== undefined && !anchors(bySlugEarly.get(slug)).has(anchor)) fail((p.source === 'the model' || p.source === 'the OpenAPI document') ? `${p.slug} (generated)` : p.source, `the link ${m[1]} names no heading on that page`);
  }
}
if (invalid) {
  console.error(`docs-build: ${invalid} problems; fix them before publishing.`);
  process.exit(1);
}

/** The first paragraph, as plain text, for the page's description. */
function description(body) {
  const para = body.split(/\n\s*\n/).find((b) => b.trim() && !/^(#|>|\||```|-|\d+\.|<)/.test(b.trim())) ?? '';
  const text = para.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
  return text.length > 200 ? `${text.slice(0, 197).replace(/\s+\S*$/, '')}…` : text;
}

/** The canonical Markdown: knowledge-base front matter, the title (with the id Starlight gives it), the body. */
/** An operation's or helper's page has its name under its title (`CreateDocument`). */
const canonical = (p) => `${frontMatter(p.metadata)}\n# ${p.title} {#_top}\n\n${p.subtitle ? `\`${p.subtitle}\`\n\n` : ''}${p.body.trimEnd()}\n`;

// --------------------------------------------------------------------------------- the Starlight project

fs.rmSync(content, { recursive: true, force: true });
fs.rmSync(generated, { recursive: true, force: true });
fs.mkdirSync(content, { recursive: true });
fs.mkdirSync(generated, { recursive: true });
const yaml = (v) => JSON.stringify(v); // JSON strings are valid YAML scalars

// The start pages, in the sidebar's order
const START = ['getting-started', 'how-to-integrate', 'authentication', 'errors', 'retries', 'streaming', 'pagination', 'telemetry', 'guides-in-the-app', 'faq', 'changelog'];
// The start pages' labels: what each is about, so a card's label tells the reader something
const START_LABELS = {
  '': 'Overview',
  authentication: 'Sign-in',
  errors: 'SDK behaviour',
  retries: 'SDK behaviour',
  streaming: 'SDK behaviour',
  pagination: 'SDK behaviour',
  telemetry: 'SDK behaviour',
  faq: 'Questions',
  changelog: 'Releases',
  'guides-in-the-app': 'Guides',
};
// Where a page sits, for the kicker above its title (docs/site/src/components/PageTitle.astro) and its card label
const sectionLabel = (page) => {
  if (page.kind === 'guides') return 'Guide';
  if (page.kind === 'reference') return 'SDK reference';
  if (page.kind === 'api') return 'API reference';
  if (page.kind === 'types') return 'Type';
  if (page.kind === 'errors') return 'Error code';
  if (page.kind === 'pages') return START_LABELS[page.slug] ?? 'Start here';
  const first = page.slug.split('/')[0];
  return first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, ' ');
};

// The icon on a page's card (docs/site/src/components/NextCards.astro): Starlight's own icon set, by page, then by
// section, then by kind
const ICONS = {
  'getting-started': 'rocket',
  authentication: 'padlock',
  errors: 'warning',
  retries: 'clock',
  streaming: 'comment-alt',
  pagination: 'list-format',
  telemetry: 'analytics',
  faq: 'question-circle',
  changelog: 'rss',
  'how-to-integrate': 'puzzle',
  'guides-in-the-app': 'open-book',
  embed: 'window',
  'sign-in': 'padlock',
  tools: 'setting',
};
const KIND_ICONS = { guides: 'open-book', reference: 'puzzle', api: 'puzzle', types: 'document', errors: 'warning' };
const cardIcon = (page) => ICONS[page.slug] ?? ICONS[page.slug.split('/')[0]] ?? KIND_ICONS[page.kind] ?? 'information';

// "What's next" on each page: the site's own map (docs/site/src/whats-next.json), resolved to titles and
// descriptions here so the component needs no lookup. A link to no page fails the build.
const whatsNextMap = JSON.parse(fs.readFileSync(path.join(project, 'src/whats-next.json'), 'utf8'));
const pageBySlug = new Map(pages.map((p) => [p.slug, p]));
const whatsNext = (slug) =>
  (whatsNextMap[slug] ?? []).map((entry) => {
    const target = typeof entry === 'string' ? entry : entry.page;
    const t = pageBySlug.get(target);
    if (!t) {
      fail('docs/site/src/whats-next.json', `"${slug}" lists "${target}", which is no page`);
      return null;
    }
    return { link: `/${target ? `${target}/` : ''}`, title: entry.label ?? t.title, description: description(t.body), section: sectionLabel(t), icon: cardIcon(t) };
  }).filter(Boolean);

/**
 * A page's own closing "Next" section (## Next, ## Next steps or ## What's next) becomes its "What's next" cards: each
 * list item that links to a page is a card, with the item's own text as its description; any other item (a pointer
 * to the app's Help) stays as a note under the cards. The section leaves the Starlight body only; the Markdown copies
 * and llms-full.txt keep it as written. Returns null when the page has no such section.
 */
const NEXT_HEADING = /^## (?:Next|Next steps|What's next)\s*$/m;
const plainText = (md) => md.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[`*_]/g, '').replace(/\s+/g, ' ').trim();
const sentence = (text) => text.charAt(0).toUpperCase() + text.slice(1);
const contentNext = (p) => {
  const match = NEXT_HEADING.exec(p.body);
  if (!match) return null;
  const rest = p.body.slice(match.index + match[0].length);
  if (/^## /m.test(rest)) return null; // only a closing section
  const items = rest.split(/\n(?=- )/).map((i) => i.trim()).filter((i) => i.startsWith('- ')).map((i) => i.slice(2).replace(/\s+/g, ' '));
  if (!items.length || rest.replace(/^- .*(\n {2,}.*)*$/gm, '').trim()) return null; // not a plain list
  const cards = [];
  const notes = [];
  for (const item of items) {
    const link = /^\[([^\]]+)\]\((\/[^)#\s]*)(?:#[^)]*)?\)(?::\s*|\s+[-–]\s*)?(.*)$/.exec(item);
    const target = link && pageBySlug.get(link[2].replace(/^\/|\/$/g, ''));
    if (!target) {
      notes.push(inlineHtml(item));
      continue;
    }
    cards.push({
      link: `/${target.slug ? `${target.slug}/` : ''}`,
      title: target.title,
      description: sentence(plainText(link[3])) || description(target.body),
      section: sectionLabel(target),
      icon: cardIcon(target),
    });
  }
  if (!cards.length) return null;
  return { cards, notes, body: p.body.slice(0, match.index).trimEnd() + '\n' };
};

const card = (t) => ({ link: `/${t.slug ? `${t.slug}/` : ''}`, title: t.title, description: description(t.body), section: sectionLabel(t), icon: cardIcon(t) });
/** The pages in the same sidebar group as this one, starting after it and wrapping round */
const neighbours = (p) => {
  const rank = (q) => (q.kind === 'pages' && START.includes(q.slug) ? START.indexOf(q.slug) : START.length);
  const group = pages.filter((q) => q.kind === p.kind && (q.group ?? '') === (p.group ?? '') && q.slug !== '').sort((x, y) => rank(x) - rank(y));
  const at = group.findIndex((q) => q.slug === p.slug);
  return [...group.slice(at + 1), ...group.slice(0, Math.max(at, 0))].filter((q) => q.slug !== p.slug).map(card);
};
const dedupe = (cards, p) => {
  const seen = new Set([`/${p.slug}/`]);
  return cards.filter((c) => !seen.has(c.link) && seen.add(c.link)).slice(0, 6);
};

/** The landing page's first paragraph, which its hero shows instead (the .md copy keeps it in place). */
const firstParagraph = (body) => /^\s*([^\n#>|`<-][\s\S]*?)(?:\n\s*\n|$)/.exec(body)?.[1] ?? '';
const inlineHtml = (md) =>
  md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, href) => `<a href="${href}">${text}</a>`)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\s+/g, ' ')
    .trim();

for (const p of pages) {
  const file = path.join(content, `${p.slug || 'index'}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let body = p.siteBody ?? p.body;
  const landing = [];
  if (!p.slug) {
    // The landing page opens with the hero (docs/site/src/components/Hero.astro): its title, its first paragraph
    // as the tagline, and the two places most readers start.
    const lead = firstParagraph(body);
    body = body.replace(lead, '').replace(/^\s+/, '');
    landing.push(
      'template: splash',
      'hero:',
      `  title: ${yaml(p.title)}`,
      `  tagline: ${yaml(inlineHtml(lead))}`,
      '  actions:',
      `    - { text: "Get started", link: ${yaml('/getting-started/')}, variant: primary }`,
    );
  }
  // The page's own "Next" section wins over the site's map: it is what its author wrote
  const own = p.slug ? contentNext(p) : null;
  if (own) body = own.body;
  // The cards are four or two (docs/site/src/components/WhatsNext.astro trims them, after leaving out the page the
  // Next link already shows), so the list carries spares: the site's map, then the pages beside this one.
  const next = p.slug ? dedupe([...(own ? own.cards : []), ...whatsNext(p.slug), ...neighbours(p)], p) : whatsNext(p.slug);
  const nextNotes = own?.notes ?? [];

  const fm = [
    '---',
    `title: ${yaml(p.title)}`,
    // An operation's or helper's name, under its title (src/components/PageTitle.astro)
    ...(p.subtitle ? [`subtitle: ${yaml(p.subtitle)}`] : []),
    `description: ${yaml(description(p.body))}`,
    // An explicit slug keeps the address exactly as written (Starlight would lower-case /errors/NOT_FOUND/)
    ...(p.slug ? [`slug: ${yaml(p.slug)}`] : ['tableOfContents: false', ...landing]),
    ...(next.length ? [`whatsNext: ${yaml(next)}`] : []),
    ...(nextNotes.length ? [`whatsNextNotes: ${yaml(nextNotes)}`] : []),
    `section: ${yaml(sectionLabel(p))}`,
    `pageType: ${p.metadata.pageType}`,
    `sinceVersion: ${p.metadata.sinceVersion}`,
    `resources: ${yaml(p.metadata.resources ?? [])}`,
    `integrations: ${yaml(p.metadata.integrations ?? [])}`,
    `operations: ${yaml(p.metadata.operations ?? [])}`,
    // An operation page's header strip (src/components/OperationHeader.astro): each SDK's call, the HTTP call and the
    // same operation in the HTTP API's reference
    // the same operation in the other reference: the API reference's page from the SDK reference, and back
    ...(p.operation ? [`operation: ${yaml({ ...p.operation, other: p.kind === 'api' ? { label: 'In the SDK reference', link: `/sdk/${kebab(p.operation.name)}/` } : { label: 'In the API reference', link: `/api/${kebab(p.operation.name)}/` } })}`] : []),
    // The API reference's overview: its Server block (src/components/PageTitle.astro), and Scalar's old anchors
    // (#tag/documents/GET/v3/...), each sent on to its operation's page
    ...(p.server ? ['server: true'] : []),
    ...(p.apiAnchors ? [`apiAnchors: ${yaml(p.apiAnchors)}`] : []),
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(file, `${fm}${body.trimEnd()}\n`);
}

// The sidebar, as topics (starlight-sidebar-topics): each topic is a section of the site with its own sidebar, and
// a page's topic is the one whose sidebar lists it. Get started and How the API works take the start pages named in
// TOPIC_START; a start page in neither (a new one) lands in Get started. Guides holds the guides, the SECTIONS and
// the app's guides. SDK reference holds the operations by SDK namespace, then the types and the error codes.
const bySlug = new Map(pages.map((p) => [p.slug, p]));
// Starlight puts the base in front of sidebar links itself
const link = (p, label = p.title) => ({ label, link: `/${p.slug ? `${p.slug}/` : ''}` });
// A reference page's link (an operation, type or error code) stays on one line, cut with an ellipsis
// (src/styles/components.css), and carries its full name for the tooltip shown when it is cut (src/scripts/sidebar-cut.ts).
// The full name is the link's own text either way, so a screen reader reads all of it.
const refLink = (p, label = p.label ?? p.title) => ({ ...link(p, label), attrs: { 'data-ref': '', 'data-full': label } });
/** A sidebar entry whose label is code itself */
const codeLink = (item) => ({ ...item, attrs: { ...item.attrs, 'data-code-label': '' } });
/** An operation's or helper's sidebar entry: its label, and the tooltip scripts/docs-api.mjs entryTips gives it */
const opLink = (p, label) => {
  const base = refLink(p, label);
  return { ...base, attrs: { ...base.attrs, ...entryTips(p) } };
};
const TOPIC_START = {
  'how-the-api-works': ['authentication', 'streaming', 'pagination', 'retries', 'errors', 'telemetry'],
  guides: ['guides-in-the-app'],
};
const placed = new Set(Object.values(TOPIC_START).flat());
const startPagesOf = (slugs) => slugs.filter((s) => bySlug.has(s)).map((s) => bySlug.get(s));
const getStarted = [bySlug.get(''), ...startPagesOf(START.filter((s) => !placed.has(s))), ...pages.filter((p) => p.kind === 'pages' && p.slug !== '' && !START.includes(p.slug))];
// The operations and helpers by the client's groups, nested to any depth, with the building blocks last and collapsed
const sdkPageOf = (e) => pages.find((p) => p.kind === 'reference' && (e.op ? p.operation?.name === e.op.name : p.helper === e.helper.id));
const referenceGroups = [
  ...sidebarGroups(tree, (e) => { const p = sdkPageOf(e); return opLink(p, sidebarLabel(e.op?.name ?? e.helper.id, p.label ?? p.title)); }),
  // What the SDKs return around the API's results (handles, scopes, streams, lists, requests, error classes)
  { label: 'SDK types', collapsed: true, items: pages.filter((p) => p.group === 'sdk-types').map((p) => refLink(p)) },
  // A type's or an error code's name is code, so its entry is in the code face (data-code-label); every other entry is
  // in the reading face
  { label: 'Types', collapsed: true, items: pages.filter((p) => p.kind === 'types').map((p) => codeLink(refLink(p))) },
  { label: 'Error codes', collapsed: true, items: pages.filter((p) => p.kind === 'errors').map((p) => codeLink(refLink(p))) },
];
const guidePages = pages.filter((p) => p.kind === 'guides');
const howItWorks = startPagesOf(TOPIC_START['how-the-api-works']);
const sidebar = [
  // The section's own link is Getting started; the logo and the section's Overview item are the landing page (/)
  { label: 'Get started', link: '/getting-started/', icon: 'rocket', items: getStarted.map((p) => link(p, p.slug === '' ? 'Overview' : p.title)) },
  {
    label: 'Guides',
    link: link(guidePages[0] ?? sectionPages(SECTIONS[0], pages)[0]).link,
    icon: 'open-book',
    items: [
      ...guidePages.map((p) => link(p)),
      ...SECTIONS.map((s) => ({ label: s.label, items: sectionPages(s, pages).map((p) => link(p)) })),
      ...startPagesOf(TOPIC_START.guides).map((p) => link(p)),
    ],
  },
  { label: 'How the API works', link: link(howItWorks[0]).link, icon: 'puzzle', items: howItWorks.map((p) => link(p)) },
  { label: 'SDK reference', link: '/sdk/', icon: 'seti:json', badge: { text: 'Beta', variant: 'default' }, items: [link(bySlug.get('sdk'), 'Overview'), ...referenceGroups] },
];
// The HTTP API's reference: its overview, its operations by the SDK reference's groups, then shortcuts to the types and
// the error codes, which are the SDK reference's pages. The published OpenAPI document is beside the pages.
fs.mkdirSync(path.join(project, 'public/api'), { recursive: true });
fs.writeFileSync(path.join(project, 'public/api/openapi.json'), JSON.stringify(openapi, null, 2) + '\n');
const apiTopic = {
  label: 'API reference',
  link: '/api/',
  icon: 'seti:json',
  items: [
    link(bySlug.get('api'), 'Overview'),
    // The same groups; the SDK helpers have no HTTP operation, so they are left out
    ...sidebarGroups(tree, (e) => { const p = e.op && pages.find((q) => q.kind === 'api' && q.operation?.name === e.op.name); return p ? opLink(p, sidebarLabel(e.op.name, p.label ?? p.title)) : null; }),
    // The types and error codes are the SDK reference's pages: shortcuts to them
    ...referenceGroups.filter((g) => g.label === 'Types' || g.label === 'Error codes'),
  ],
};
sidebar.push(apiTopic);
// No two entries side by side share a label, in any topic's sidebar (docs/site/test/sidebar.test.mjs checks the
// reference sidebars before the build)
(function distinct(items, where) {
  const labels = items.map((i) => i.label);
  for (const l of new Set(labels.filter((x, i) => labels.indexOf(x) !== i))) fail('the sidebar', `${where} lists "${l}" more than once`);
  for (const i of items) if (i.items) distinct(i.items, `${where} > ${i.label}`);
})(sidebar, 'the topics');
// The site's icons (src/generated/icons.css): Material Symbols Rounded (outlined, weight 400), the Caitlyn app's own set, for the sections
// and the sidebar's groups, and Simple Icons' monochrome logos for the languages on code blocks and the language tabs.
// Each is drawn in CSS as a mask filled with the text colour, 16px, so it is decorative (no text for a screen reader)
// and needs no script or icon font. The icon data comes from the installed Iconify sets; nothing is fetched.
const iconSet = (name) => JSON.parse(fs.readFileSync(path.join(project, `node_modules/@iconify-json/${name}/icons.json`), 'utf8'));
const ICON_SETS = { 'material-symbols': iconSet('material-symbols'), 'simple-icons': iconSet('simple-icons') };
const iconUrl = (id) => {
  const [prefix, name] = id.split(':');
  const set = ICON_SETS[prefix];
  const icon = set.icons[name] ?? set.icons[set.aliases?.[name]?.parent];
  if (!icon) throw new Error(`docs-build: no icon ${id}`);
  const w = icon.width ?? set.width ?? 24;
  const h = icon.height ?? set.height ?? 24;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}">${icon.body}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg).replace(/'/g, '%27')}")`;
};
const TOPIC_ICONS = { 'Get started': 'rocket-launch-outline-rounded', Guides: 'menu-book-outline-rounded', 'How the API works': 'extension-outline-rounded', 'SDK reference': 'code-outline-rounded', 'API reference': 'api-outline-rounded' };
const GROUP_ICONS = {
  Conversations: 'chat-bubble-outline-rounded', Documents: 'description-outline-rounded', Uploads: 'upload-outline-rounded',
  Agents: 'smart-toy-outline-rounded', Versions: 'stacks-outline-rounded', 'Live history': 'history-rounded', Callers: 'badge-outline-rounded',
  Events: 'notifications-outline-rounded', 'Knowledge bases': 'library-books-outline-rounded', History: 'history-rounded', Me: 'badge-outline-rounded',
  Draft: 'edit-note-outline-rounded', Access: 'lock-outline-rounded', Fields: 'label-outline-rounded', Folders: 'folder-outline-rounded',
  Ingestion: 'upload-file-outline-rounded', 'Configuration options': 'tune-rounded', 'Layout-aware search': 'dashboard-outline-rounded',
  'Building blocks': 'construction-rounded',
  Types: 'data-object-outline-rounded', 'Error codes': 'warning-outline-rounded', 'Sign-in and identity': 'key-outline-rounded', Embed: 'web-outline-rounded',
  'Tools and connectors': 'power-outline-rounded',
};
// Every code block's language and every tab group's label has an icon: Simple Icons' monochrome logo where the language
// or framework has one, a Material Symbols icon where it does not (text, HTTP). The build fails on one with no icon,
// so a new language or tab never shows an empty square.
const CODE_ICONS = {
  ts: 'simple-icons:typescript', typescript: 'simple-icons:typescript', tsx: 'simple-icons:react', js: 'simple-icons:javascript',
  javascript: 'simple-icons:javascript', jsx: 'simple-icons:react', python: 'simple-icons:python', py: 'simple-icons:python',
  go: 'simple-icons:go', rust: 'simple-icons:rust', rs: 'simple-icons:rust', sh: 'simple-icons:gnubash', bash: 'simple-icons:gnubash',
  shell: 'simple-icons:gnubash', html: 'simple-icons:html5', json: 'simple-icons:json', yaml: 'simple-icons:yaml', yml: 'simple-icons:yaml',
  toml: 'simple-icons:toml', markdown: 'simple-icons:markdown', md: 'simple-icons:markdown', apache: 'simple-icons:apache',
  nginx: 'simple-icons:nginx', php: 'simple-icons:php', http: 'material-symbols:http-rounded', text: 'material-symbols:notes-rounded',
  plaintext: 'material-symbols:notes-rounded', txt: 'material-symbols:notes-rounded',
};
const TAB_ICONS = {
  typescript: 'simple-icons:typescript', python: 'simple-icons:python', go: 'simple-icons:go', rust: 'simple-icons:rust',
  html: 'simple-icons:html5', react: 'simple-icons:react', 'next-js': 'simple-icons:nextdotjs', javascript: 'simple-icons:javascript',
  curl: 'simple-icons:gnubash', shell: 'simple-icons:gnubash',
};
const LANGUAGE_ICONS = { typescript: 'typescript', python: 'python', go: 'go', rust: 'rust' };
const tabKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
for (const p of pages) {
  let fence = false;
  for (const line of p.body.split('\n')) {
    const open = /^\s*```([A-Za-z0-9_+-]*)(.*)$/.exec(line);
    if (!open) continue;
    fence = !fence;
    if (!fence) continue;
    const lang = open[1] || 'plaintext';
    if (!CODE_ICONS[lang]) fail((p.source === 'the model' || p.source === 'the OpenAPI document') ? `${p.slug} (generated)` : p.source, `a \`${lang}\` code block has no icon: add it to CODE_ICONS in scripts/docs-build.mjs`);
    const tab = /(?:^|\s)tab="([^"]+)"/.exec(open[2])?.[1];
    if (tab && !TAB_ICONS[tabKey(tab)]) fail((p.source === 'the model' || p.source === 'the OpenAPI document') ? `${p.slug} (generated)` : p.source, `the "${tab}" tab has no icon: add it to TAB_ICONS in scripts/docs-build.mjs`);
  }
}
const topicKey = (label) => label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
const iconRules = [];
const masked = (selector, id) => `${selector} {\n  display: inline-block;\n  -webkit-mask-image: ${iconUrl(id)};\n  mask-image: ${iconUrl(id)};\n}`;
for (const topic of sidebar) {
  const key = topicKey(topic.label);
  topic.attrs = { ...(topic.attrs ?? {}), 'data-topic': key };
  if (TOPIC_ICONS[topic.label]) iconRules.push(masked(`.starlight-sidebar-topics a[data-topic='${key}'] .starlight-sidebar-topics-icon::before`, `material-symbols:${TOPIC_ICONS[topic.label]}`));
  // A group's icon by its place in its section's sidebar (Starlight's groups take no attributes), nested groups included
  (function groupIcons(items, path) {
    items.forEach((item, i) => {
      if (!item.items) return;
      const at = `${path} > li:nth-child(${i + 1}) > details`;
      if (GROUP_ICONS[item.label]) iconRules.push(masked(`${at} > summary .group-label::before`, `material-symbols:${GROUP_ICONS[item.label]}`));
      groupIcons(item.items, `${at} > ul`);
    });
  })(topic.items, `.sidebar-content:has(a.starlight-sidebar-topics-current[data-topic='${key}']) ul.top-level`);
}
for (const [lang, icon] of Object.entries(CODE_ICONS)) {
  iconRules.push(masked(`.expressive-code:has(pre[data-language='${lang}']) figcaption .title::before`, icon));
}
for (const [key, icon] of Object.entries(TAB_ICONS)) iconRules.push(masked(`.lang-tab[data-lang='${key}']::before`, icon));
// The code panel's language menu shows its chosen language's logo (src/scripts/lang-tabs.ts sets data-value; before it
// runs, the site's language on <html data-lang>, TypeScript until one is chosen)
const PICKER_ICONS = { ...Object.fromEntries(Object.entries(LANGUAGE_ICONS).map(([k, v]) => [k, `simple-icons:${v}`])), curl: 'simple-icons:gnubash' };
for (const [lang, icon] of Object.entries(PICKER_ICONS)) {
  iconRules.push(masked(`caitlyn-language-select[data-value='${lang}'] .caitlyn-lang-picker-icon, :root[data-lang='${lang}'] caitlyn-language-select:not([data-value]) .caitlyn-lang-picker-icon`, icon));
}
iconRules.push(masked(`:root:not([data-lang]) caitlyn-language-select:not([data-value]) .caitlyn-lang-picker-icon`, 'simple-icons:typescript'));
// Each language in the menu's open list, and the check on the chosen one
for (const [lang, icon] of Object.entries(PICKER_ICONS)) iconRules.push(masked(`.caitlyn-lang-option[data-value='${lang}'] .caitlyn-lang-option-icon`, icon));
iconRules.push(masked('.caitlyn-lang-option-check', 'material-symbols:check-rounded'));
// The SDK reference's member rows (scripts/docs-reference.mjs memberTree): where a group is sent, and a wire name
const UI_ICONS = { path: 'route-outline-rounded', query: 'search-rounded', header: 'subject-rounded', body: 'data-object-outline-rounded', events: 'stream-rounded', wire: 'swap-horiz-rounded', values: 'list-rounded', sdk: 'code-rounded' };
for (const [name, icon] of Object.entries(UI_ICONS)) iconRules.push(masked(`.caitlyn-icon[data-icon='${name}']`, `material-symbols:${icon}`));
// An operation page's example links (scripts/docs-reference.mjs) and the code panel's example buttons
// (src/components/OperationPanel.astro): the code icon, </>
iconRules.push(masked('.sl-markdown-content .caitlyn-example-list h3 > a::before, .caitlyn-op-panel-examples button::before', 'material-symbols:code-rounded'));
fs.writeFileSync(path.join(generated, 'icons.css'), `/* Generated by scripts/docs-build.mjs: the site's icons, as masks (src/styles/components.css draws them). */\n${iconRules.join('\n')}\n`);
fs.writeFileSync(path.join(generated, 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n');
// The SDK reference's old addresses, for astro.config.mjs's redirects
fs.writeFileSync(path.join(generated, 'redirects.json'), JSON.stringify(Object.fromEntries(moved), null, 2) + '\n');

// ---------------------------------------------------------------------------------------------- the build

if (invalid) {
  console.error(`docs-build: ${invalid} problems; fix them before publishing.`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
// Astro caches rendered pages between builds and keeps a cached page's old stylesheet names when only the site's
// configuration changed, so every build starts without that cache.
for (const cache of ['node_modules/.astro', '.astro']) fs.rmSync(path.join(project, cache), { recursive: true, force: true });
execFileSync('npx', ['--no-install', 'astro', 'build'], {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' },
});

// ------------------------------------------------------------------- Markdown copies, llms.txt, pages.json

const entries = [];
for (const p of pages) {
  const html = path.join(site, p.slug, 'index.html');
  if (!fs.existsSync(html)) fail(p.slug, `Starlight wrote no ${path.relative(root, html)}`);
  // An operation page's example titles link to their own headings (scripts/docs-reference.mjs headingId)
  else if (p.operation) {
    for (const [, id, href] of fs.readFileSync(html, 'utf8').matchAll(/<h3 id="([^"]*)"><a href="#([^"]*)"/g)) {
      if (id !== href) fail(`${p.slug} (generated)`, `the example link #${href} is not its heading's id, #${id}`);
    }
  }
  // Every header chip is a copy button (docs/site/src/scripts/chip-fit.ts fits it; none scrolls)
  if (p.operation && fs.existsSync(html)) {
    const built = fs.readFileSync(html, 'utf8');
    const codes = (built.match(/class="caitlyn-strip-code/g) ?? []).length;
    const chips = (built.match(/class="caitlyn-chip[" ][^>]*data-chip=|data-chip="[^"]*"[^>]*class="caitlyn-chip/g) ?? []).length;
    if (codes !== chips) fail(`${p.slug} (generated)`, `${codes - chips} of its header chips are not copy buttons`);
  }
  // Every tab strip has each language once, and a panel per tab (docs/site/src/plugins/remark-lang-tabs.mjs)
  if (fs.existsSync(html)) {
    for (const [group] of fs.readFileSync(html, 'utf8').matchAll(/<div class="lang-tabs"[\s\S]*?(?=<div class="lang-tabs"|$)/g)) {
      const tabs = [...group.matchAll(/<button[^>]*class="lang-tab"[^>]*>|<button[^>]*data-lang="[^"]+"[^>]*class="lang-tab"[^>]*>/g)].map((m) => /data-lang="([^"]+)"/.exec(m[0])[1]);
      const panels = (group.match(/class="lang-panel"/g) ?? []).length;
      if (new Set(tabs).size !== tabs.length) fail(p.slug || 'index', `a tab strip has a language twice: ${tabs.join(', ')}`);
      if (panels !== tabs.length) fail(p.slug || 'index', `a tab group has ${panels} panels for ${tabs.length} tabs`);
    }
  }
  // Every link in a response pane's return and raise lines names a built page
  if (p.operation && fs.existsSync(html)) {
    const built = fs.readFileSync(html, 'utf8');
    const lines = [...built.matchAll(/<span class="caitlyn-op-returns[^"]*"[\s\S]*?<\/p>/g)].map((m) => m[0]);
    if (!lines.length) fail(`${p.slug} (generated)`, 'its response pane says what no call returns');
    for (const line of lines) {
      for (const [, href, anchor] of line.matchAll(/href="([^"#]*)(?:#([^"]*))?"/g)) {
        const target = path.join(site, href, 'index.html');
        if (!fs.existsSync(target)) fail(`${p.slug} (generated)`, `the response pane links to ${href}, which is no built page`);
        else if (anchor && !fs.readFileSync(target, 'utf8').includes(`id="${anchor}"`)) fail(`${p.slug} (generated)`, `the response pane links to ${href}#${anchor}, which is no heading there`);
      }
    }
  }
  const mdPath = p.slug ? `${p.slug}.md` : 'index.md';
  const md = canonical(p);
  fs.mkdirSync(path.dirname(path.join(site, mdPath)), { recursive: true });
  fs.writeFileSync(path.join(site, mdPath), md);
  entries.push({ path: mdPath, url: `${PROD_URL}/${p.slug ? `${p.slug}/` : ''}`, title: p.title, metadata: p.metadata, page: p, markdown: md });
}
// The SDK reference's old Markdown addresses (/reference/x.md): static hosting cannot redirect a file, so each is a
// short Markdown page that names its new address, the Markdown counterpart of the HTML redirect pages.
for (const [from, to] of moved) {
  const p = pages.find((q) => `/${q.slug}/` === to);
  const file = path.join(site, `${from.replace(/^\/|\/$/g, '')}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `# ${p?.title ?? to}\n\nThis page has moved to ${PROD_URL}${to.replace(/\/$/, '')}.md (the page itself: ${PROD_URL}${to}).\n`);
}
if (invalid) {
  console.error(`docs-build: ${invalid} problems.`);
  process.exit(1);
}

const mdUrl = (e) => `${PROD_URL}/${e.path}`;
const section = (title, list) => [`## ${title}`, '', ...list.map((e) => `- [${e.title}](${mdUrl(e)}): ${description(e.page.body)}`), ''];
const kind = (k) => entries.filter((e) => e.page.kind === k);
const startOrder = (e) => (e.page.slug === '' ? -1 : START.includes(e.page.slug) ? START.indexOf(e.page.slug) : START.length);
const startPages = kind('pages').sort((a, b) => startOrder(a) - startOrder(b));
const llms = [
  '# Caitlyn developer docs',
  '',
  '> The Caitlyn v3 API and its SDKs: how to sign in, call the API, handle errors, retries, streams and pages,',
  '> the reference for every operation, type and error code, and how to embed the chat, set up sign-in and connect MCP tools.',
  '> Every page is also Markdown, at its address',
  '> with `.md` in place of the trailing slash.',
  '',
  ...section('Start here', startPages),
  ...section('Guides', kind('guides')),
  ...SECTIONS.flatMap((s) => section(s.label, sectionPages(s, entries.map((e) => e.page)).map((pg) => entries.find((e) => e.page === pg)))),
  ...section('SDK reference', kind('reference')),
  ...section('HTTP API reference', kind('api')),
  ...section('Types', kind('types')),
  '## Optional',
  '',
  ...kind('errors').map((e) => `- [${e.title}](${mdUrl(e)}): ${description(e.page.body)}`),
  `- [Everything in one file](${PROD_URL}/llms-full.txt): every page above, in this order`,
  '',
];
fs.writeFileSync(path.join(site, 'llms.txt'), llms.join('\n'));
// The Changelog's Atom feed, at the address the page and every page's head name (docs/site/astro.config.mjs)
fs.writeFileSync(path.join(site, CHANGELOG_FEED), atomFeed(releases, pages, { base: PROD_URL, feed: CHANGELOG_FEED, errorCodes, codeOperations }));
const ordered = [...startPages, ...kind('guides'), ...SECTIONS.flatMap((s) => kind(s.dir)), ...kind('reference'), ...kind('api'), ...kind('types'), ...kind('errors')];
fs.writeFileSync(
  path.join(site, 'llms-full.txt'),
  ordered.map((e) => `<!-- ${PROD_URL}/${e.page.slug ? `${e.page.slug}/` : ''} -->\n${e.markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')}`).join('\n'),
);
fs.writeFileSync(
  path.join(out, 'pages.json'),
  JSON.stringify({ pages: entries.map(({ path: p, url, title, metadata }) => ({ path: p, url, title, metadata })) }, null, 2) + '\n',
);

// ----------------------------------------------------------------------------------- sitemap.xml, robots.txt

// The live build lists every page at its canonical address in sitemap.xml, dated by its source's newest commit, and
// robots.txt names it; any other build (a preview) publishes neither, and its pages carry noindex
// (scripts/docs-sitemap.mjs, docs/site/astro.config.mjs).
const live = isLive();
// What a generated page is made from: its data and the scripts that write it
const GENERATED_SOURCES = {
  'the model': ['model', 'docs/helpers.json', 'scripts/docs-model.mjs', 'scripts/docs-reference.mjs', 'scripts/docs-api.mjs'],
  'the OpenAPI document': ['model/openapi.json', 'scripts/docs-model.mjs', 'scripts/docs-api.mjs'],
  'the SDKs': ['typescript', 'python', 'go', 'rust', 'scripts/docs-api.mjs'],
};
const sourcePaths = (p) => GENERATED_SOURCES[p.source] ?? [p.source];
for (const e of entries) if (!sourcePaths(e.page).every((f) => fs.existsSync(path.join(root, f)))) fail(e.page.slug || 'index', `no source file for its sitemap date: ${sourcePaths(e.page).join(', ')}`);
const buildDate = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const { dates, dated } = lastModified(new Map(entries.map((e) => [e.page.source, sourcePaths(e.page)])), { cwd: root, fallback: buildDate });
const sitemapFile = path.join(site, 'sitemap.xml');
fs.rmSync(sitemapFile, { force: true });
if (live) {
  fs.writeFileSync(sitemapFile, sitemapXml(entries.map((e) => ({ loc: e.url, lastmod: dates.get(e.page.source) }))));
  if (dated.size < dates.size) console.warn(`docs-build: git could not date ${dates.size - dated.size} of ${dates.size} page sources, so their sitemap lastmod is the build's date`);
}
fs.writeFileSync(path.join(site, 'robots.txt'), robotsTxt({ live, base: PROD_URL }));
// Every built page says what the build is: indexed when live, noindex otherwise
const robotsWant = live ? 'index, follow' : 'noindex';
const htmlFiles = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? htmlFiles(path.join(dir, d.name)) : d.name.endsWith('.html') ? [path.join(dir, d.name)] : []));
for (const file of htmlFiles(site)) {
  const robots = /<meta name="robots" content="([^"]*)"/.exec(fs.readFileSync(file, 'utf8'))?.[1] ?? '';
  const redirect = /^<!doctype html><title>Redirecting to:/.test(fs.readFileSync(file, 'utf8'));
  if (!robots.startsWith(robotsWant) && !(redirect && robots === 'noindex')) fail(path.relative(site, file), `its robots meta is "${robots}", not "${robotsWant}" (DOCS_LIVE ${live ? 'is' : 'is not'} on)`);
}
if (invalid) {
  console.error(`docs-build: ${invalid} problems.`);
  process.exit(1);
}

const counts = ['pages', 'guides', ...SECTIONS.map((s) => s.dir), 'reference', 'api', 'types', 'errors'].map((k) => `${entries.filter((e) => e.page.kind === k).length} ${k === 'pages' ? 'start pages' : k}`);
console.log(`docs-build: ${entries.length} pages (${counts.join(', ')}) in build/docs/site, each with its Markdown copy; llms.txt; ${live ? `the live build: sitemap.xml (${dated.size === dates.size ? 'every source dated by git' : `${dated.size} of ${dates.size} sources dated by git, the rest by the build`})` : 'a preview build: no sitemap, every page noindex'}; release ${release}`);
