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
import { frontMatter, metadataProblems } from './docs-metadata.mjs';
import { MARKER, readPages } from './docs-guides.mjs';
import { loadModel, root } from './docs-model.mjs';
import { referencePages } from './docs-reference.mjs';

// Where the site is served. Production is https://build.caitlyn.ai at the root. A merge request's GitLab Pages
// preview (the `pages` CI job) serves it under a path instead: DOCS_SITE_URL is that address and DOCS_BASE its
// path, and site-relative links in the pages, the sidebar, the Markdown copies and llms.txt are written under it.
// pages.json always names the production addresses, which the knowledge base cites.
const PROD_URL = 'https://build.caitlyn.ai';
const SITE_URL = (process.env.DOCS_SITE_URL ?? PROD_URL).replace(/\/+$/, '');
const BASE = `/${(process.env.DOCS_BASE ?? '/').replace(/^\/+|\/+$/g, '')}/`.replace(/^\/\/$/, '/');
/** Site-relative Markdown links (`](/errors/)`) moved under BASE; unchanged at the root. */
const rebase = (md) => (BASE === '/' ? md : md.replace(/\]\(\/(?!\/)/g, `](${BASE}`));
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
// Every site-relative link must name a page (with its trailing slash), an anchor on it, or a published file.
for (const p of pages) {
  for (const m of p.body.matchAll(/\]\((\/[^)\s]*)\)/g)) {
    const [target, anchor] = m[1].split('#');
    if (target === '/llms.txt' || target === '/llms-full.txt') continue;
    // A file the site publishes as it is, such as a screenshot in docs/site/public/images/
    if (!target.endsWith('/') && fs.existsSync(path.join(project, 'public', target))) continue;
    const slug = target.replace(/^\/|\/$/g, '');
    if (!target.endsWith('/') || !slugs.has(slug)) fail(p.source === 'the model' ? `${p.slug} (generated)` : p.source, `the link ${m[1]} names no page (page links end in /)`);
    else if (anchor !== undefined && !anchors(bySlugEarly.get(slug)).has(anchor)) fail(p.source === 'the model' ? `${p.slug} (generated)` : p.source, `the link ${m[1]} names no heading on that page`);
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
for (const p of pages) {
  const file = path.join(content, `${p.slug || 'index'}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fm = [
    '---',
    `title: ${yaml(p.title)}`,
    `description: ${yaml(description(p.body))}`,
    // An explicit slug keeps the address exactly as written (Starlight would lower-case /errors/NOT_FOUND/)
    ...(p.slug ? [`slug: ${yaml(p.slug)}`] : ['tableOfContents: false']),
    `pageType: ${p.metadata.pageType}`,
    `sinceVersion: ${p.metadata.sinceVersion}`,
    `resources: ${yaml(p.metadata.resources ?? [])}`,
    `integrations: ${yaml(p.metadata.integrations ?? [])}`,
    `operations: ${yaml(p.metadata.operations ?? [])}`,
    '---',
    '',
  ].join('\n');
  fs.writeFileSync(file, `${fm}${rebase(p.body).trimEnd()}\n`);
}

// The sidebar: the start pages in a fixed order, the guides, then the reference grouped by SDK namespace.
const START = ['getting-started', 'authentication', 'errors', 'retries', 'streaming', 'pagination', 'telemetry', 'guides-in-the-app', 'faq'];
const bySlug = new Map(pages.map((p) => [p.slug, p]));
// Starlight puts the base in front of sidebar links itself
const link = (p, label = p.title) => ({ label, link: `/${p.slug ? `${p.slug}/` : ''}` });
const namespaces = [...new Set(reference.ops.map((o) => o.namespace))];
const sidebar = [
  { label: 'Start here', items: [link(bySlug.get(''), 'Overview'), ...START.filter((s) => bySlug.has(s)).map((s) => link(bySlug.get(s)))] },
  { label: 'Guides', items: pages.filter((p) => p.kind === 'guides').map((p) => link(p)) },
  ...SECTIONS.map((s) => ({ label: s.label, items: sectionPages(s, pages).map((p) => link(p)) })),
  {
    label: 'API reference',
    items: [
      ...namespaces.map((ns) => ({ label: ns, items: pages.filter((p) => p.kind === 'reference' && p.group === ns).map((p) => link(p, p.label)) })),
      { label: 'Types', collapsed: true, items: pages.filter((p) => p.kind === 'types').map((p) => link(p, p.label)) },
      { label: 'Error codes', collapsed: true, items: pages.filter((p) => p.kind === 'errors').map((p) => link(p, p.label)) },
    ],
  },
];
const unlisted = pages.filter((p) => p.kind === 'pages' && p.slug !== '' && !START.includes(p.slug));
if (unlisted.length) sidebar[0].items.push(...unlisted.map((p) => link(p)));
fs.writeFileSync(path.join(generated, 'sidebar.json'), JSON.stringify(sidebar, null, 2) + '\n');

// ---------------------------------------------------------------------------------------------- the build

fs.rmSync(out, { recursive: true, force: true });
execFileSync('npx', ['--no-install', 'astro', 'build'], {
  cwd: project,
  stdio: 'inherit',
  env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1', DOCS_SITE_ORIGIN: new URL(SITE_URL).origin, DOCS_BASE: BASE },
});

// ------------------------------------------------------------------- Markdown copies, llms.txt, pages.json

const entries = [];
for (const p of pages) {
  const html = path.join(site, p.slug, 'index.html');
  if (!fs.existsSync(html)) fail(p.slug, `Starlight wrote no ${path.relative(root, html)}`);
  const mdPath = p.slug ? `${p.slug}.md` : 'index.md';
  const md = rebase(canonical(p));
  fs.mkdirSync(path.dirname(path.join(site, mdPath)), { recursive: true });
  fs.writeFileSync(path.join(site, mdPath), md);
  entries.push({ path: mdPath, url: `${PROD_URL}/${p.slug ? `${p.slug}/` : ''}`, title: p.title, metadata: p.metadata, page: p, markdown: md });
}
if (invalid) {
  console.error(`docs-build: ${invalid} problems.`);
  process.exit(1);
}

const mdUrl = (e) => `${SITE_URL}/${e.path}`;
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
  ...section('API reference', kind('reference')),
  ...section('Types', kind('types')),
  '## Optional',
  '',
  ...kind('errors').map((e) => `- [${e.title}](${mdUrl(e)}): ${description(e.page.body)}`),
  `- [Everything in one file](${SITE_URL}/llms-full.txt): every page above, in this order`,
  '',
];
fs.writeFileSync(path.join(site, 'llms.txt'), llms.join('\n'));
const ordered = [...startPages, ...kind('guides'), ...SECTIONS.flatMap((s) => kind(s.dir)), ...kind('reference'), ...kind('types'), ...kind('errors')];
fs.writeFileSync(
  path.join(site, 'llms-full.txt'),
  ordered.map((e) => `<!-- ${SITE_URL}/${e.page.slug ? `${e.page.slug}/` : ''} -->\n${e.markdown.replace(/^---\n[\s\S]*?\n---\n\n?/, '')}`).join('\n'),
);
fs.writeFileSync(
  path.join(out, 'pages.json'),
  JSON.stringify({ pages: entries.map(({ path: p, url, title, metadata }) => ({ path: p, url, title, metadata })) }, null, 2) + '\n',
);
const counts = ['pages', 'guides', ...SECTIONS.map((s) => s.dir), 'reference', 'types', 'errors'].map((k) => `${entries.filter((e) => e.page.kind === k).length} ${k === 'pages' ? 'start pages' : k}`);
console.log(`docs-build: ${entries.length} pages (${counts.join(', ')}) in build/docs/site, each with its Markdown copy; llms.txt; release ${release}`);
