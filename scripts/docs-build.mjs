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
import { kebab, loadModel, root } from './docs-model.mjs';
import { referencePages, sdkOverview } from './docs-reference.mjs';
import { apiOverview, apiPages, namespaceLabel, namespaceTree, publishedOpenapi } from './docs-api.mjs';
import { documentProblems, lineProblems } from './docs-wording.mjs';

// Where the site is served: https://build.caitlyn.ai, at the root; a merge request's preview is the same build at the
// root of its own host (docs:preview). pages.json, llms.txt and the moved pages name these addresses.
const PROD_URL = 'https://build.caitlyn.ai';
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

/** A hand-written page's body: without front matter, its `# title`, or the example markers (build plumbing). */
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
  pages.push({ slug: p.slug, title: p.title, metadata: p.metadata, body: handWrittenBody(p.markdown), source: p.file, kind: p.slug.startsWith('guides/') ? 'guides' : section ? section.dir : 'pages' });
}
const reference = referencePages(ast);
for (const p of reference.pages) {
  for (const problem of metadataProblems(p.metadata)) fail(`${p.slug} (generated)`, problem);
  pages.push({ ...p, source: 'the model', kind: p.group === 'errors' ? 'errors' : p.group === 'types' ? 'types' : 'reference' });
}
const namespaces = [...new Set(reference.ops.map((o) => o.namespace))];
const tree = namespaceTree(reference.ops);

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
  namespaceLabel,
  sdkSlug: (op) => `sdk/${kebab(op.name)}`,
  examples: reference.examples,
});
for (const problem of openapiProblems) fail('model/openapi.json', problem);
for (const problem of documentProblems(openapi)) fail('the published OpenAPI document', problem);
const api = apiPages(openapi, {
  ast,
  ops: reference.ops,
  sdkPages: new Map(reference.pages.filter((p) => p.operation).map((p) => [p.title, p])),
  typePages: reference.typePages,
  namespaceLabel,
});
pages.push({
  slug: 'api',
  title: 'Caitlyn v3 HTTP API',
  metadata: { pageType: 'reference', sinceVersion: Math.min(...api.pages.map((p) => p.metadata.sinceVersion)), resources: [...new Set(api.pages.flatMap((p) => p.metadata.resources))], integrations: [], operations: api.pages.map((p) => p.title) },
  ...apiOverview(api.pages, { tree }),
  source: 'the OpenAPI document',
  kind: 'api',
  group: 'overview',
  server: true,
  apiAnchors: api.anchors,
});
for (const p of api.pages) pages.push({ ...p, source: 'the OpenAPI document', kind: 'api' });
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
    if (target === '/llms.txt' || target === '/llms-full.txt' || target === '/api/openapi.json') continue;
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
const canonical = (p) => `${frontMatter(p.metadata)}\n# ${p.title} {#_top}\n\n${p.body.trimEnd()}\n`;

// --------------------------------------------------------------------------------- the Starlight project

fs.rmSync(content, { recursive: true, force: true });
fs.rmSync(generated, { recursive: true, force: true });
fs.mkdirSync(content, { recursive: true });
fs.mkdirSync(generated, { recursive: true });
const yaml = (v) => JSON.stringify(v); // JSON strings are valid YAML scalars

// The start pages, in the sidebar's order
const START = ['getting-started', 'authentication', 'errors', 'retries', 'streaming', 'pagination', 'telemetry', 'guides-in-the-app', 'faq'];
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
    ...(p.operation ? [`operation: ${yaml({ ...p.operation, other: p.kind === 'api' ? { label: 'In the SDK reference', link: `/sdk/${kebab(p.title)}/` } : { label: 'In the API reference', link: `/api/${kebab(p.title)}/` } })}`] : []),
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
const TOPIC_START = {
  'how-the-api-works': ['streaming', 'pagination', 'retries', 'errors', 'telemetry'],
  guides: ['guides-in-the-app'],
};
const placed = new Set(Object.values(TOPIC_START).flat());
const startPagesOf = (slugs) => slugs.filter((s) => bySlug.has(s)).map((s) => bySlug.get(s));
const getStarted = [bySlug.get(''), ...startPagesOf(START.filter((s) => !placed.has(s))), ...pages.filter((p) => p.kind === 'pages' && p.slug !== '' && !START.includes(p.slug))];
const referenceGroups = [
  ...tree.map(function group(node) {
    if (node.children) return { label: node.label, items: node.children.map(group) };
    return { label: node.label, items: pages.filter((p) => p.kind === 'reference' && p.group === node.ns).map((p) => refLink(p)) };
  }),
  { label: 'Types', collapsed: true, items: pages.filter((p) => p.kind === 'types').map((p) => refLink(p)) },
  { label: 'Error codes', collapsed: true, items: pages.filter((p) => p.kind === 'errors').map((p) => refLink(p)) },
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
    ...tree.map(function group(node) {
      if (node.children) return { label: node.label, items: node.children.map(group) };
      return { label: node.label, items: pages.filter((p) => p.kind === 'api' && p.group === node.ns).map((p) => refLink(p)) };
    }),
    // The types and error codes are the SDK reference's pages: shortcuts to them
    ...referenceGroups.filter((g) => g.label === 'Types' || g.label === 'Error codes'),
  ],
};
sidebar.push(apiTopic);
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
  Agents: 'smart-toy-outline-rounded', Versions: 'stacks-outline-rounded', 'Production history': 'history-rounded', Callers: 'badge-outline-rounded',
  Events: 'notifications-outline-rounded',
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
const ordered = [...startPages, ...kind('guides'), ...SECTIONS.flatMap((s) => kind(s.dir)), ...kind('reference'), ...kind('api'), ...kind('types'), ...kind('errors')];
fs.writeFileSync(
  path.join(site, 'llms-full.txt'),
  ordered.map((e) => `<!-- ${PROD_URL}/${e.page.slug ? `${e.page.slug}/` : ''} -->\n${e.markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')}`).join('\n'),
);
fs.writeFileSync(
  path.join(out, 'pages.json'),
  JSON.stringify({ pages: entries.map(({ path: p, url, title, metadata }) => ({ path: p, url, title, metadata })) }, null, 2) + '\n',
);
const counts = ['pages', 'guides', ...SECTIONS.map((s) => s.dir), 'reference', 'api', 'types', 'errors'].map((k) => `${entries.filter((e) => e.page.kind === k).length} ${k === 'pages' ? 'start pages' : k}`);
console.log(`docs-build: ${entries.length} pages (${counts.join(', ')}) in build/docs/site, each with its Markdown copy; llms.txt; release ${release}`);
