// The developer docs build: a skeleton until lane D2 (Astro Starlight) replaces it. It writes
//   build/docs/site/              the static site the publish jobs upload (D1's buckets)
//   build/docs/pages.json         one entry per page: path, public URL, title and its metadata
// Every Markdown page carries its knowledge-base metadata as front matter (scripts/docs-metadata.mjs), which
// Markdown ingestion reads; the build fails on a value ingestion would skip.
// Today the site is a holding page, one Markdown reference page per operation, generated from the model, and
// the guides in docs/guides/, so the publish and knowledge-base jobs have real input to work on.
// Usage: node scripts/docs-build.mjs   (reads build/model/model.json; run prepare-model first)
import fs from 'node:fs';
import path from 'node:path';
import { OPTIONS, frontMatter, metadataProblems, sinceVersion } from './docs-metadata.mjs';
import { readGuides } from './docs-guides.mjs';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'build/docs');
const site = path.join(out, 'site');
const ast = JSON.parse(fs.readFileSync(path.join(root, 'build/model/model.json'), 'utf8'));
const shapes = ast.shapes;
const T = (s) => `smithy.api#${s}`;
const C = (s) => `ai.caitlyn.traits#${s}`;

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(site, 'reference'), { recursive: true });

// Operations and the resource each is bound to, as the SDKs name them (PROTOCOL.md section 10).
const ops = [];
const visit = (id, resource) => {
  const s = shapes[id];
  const bind = (target, lifecycle) => ops.push({ id: target, resource, lifecycle });
  for (const k of ['create', 'put', 'read', 'update', 'delete', 'list']) if (s[k]) bind(s[k].target, k === 'read' ? 'get' : k);
  for (const { target } of [...(s.operations ?? []), ...(s.collectionOperations ?? [])]) bind(target, null);
  for (const { target } of s.resources ?? []) visit(target, target);
};
visit('ai.caitlyn.v3#Caitlyn', null);

const plural = (n) => (n.endsWith('y') ? `${n.slice(0, -1)}ies` : n.endsWith('s') ? `${n}es` : `${n}s`);
const lower = (n) => n[0].toLowerCase() + n.slice(1);
const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
const singular = (n) => (n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.endsWith('ses') ? n.slice(0, -2) : n.replace(/s$/, ''));

/** The knowledge base's resource options a page covers: the operation's resource, and its SDK namespace's. */
function resourcesOf(resource, namespace) {
  const keys = [kebab(resource.split('#')[1].replace(/Resource$/, '')), kebab(singular(namespace))];
  return [...new Set(keys)].filter((k) => OPTIONS.resources.includes(k));
}
let invalid = 0;

const pages = [];
for (const { id, resource, lifecycle } of ops.sort((a, b) => a.id.localeCompare(b.id))) {
  const op = shapes[id];
  const name = id.split('#')[1];
  const t = op.traits ?? {};
  if (t[C('stability')] === 'internal') continue; // never in the public docs
  const method = t[C('clientMethod')] ?? { namespace: lower(plural(resource.split('#')[1].replace(/Resource$/, ''))), name: lifecycle ?? lower(name) };
  const http = t[T('http')];
  const slug = `reference/${kebab(name)}`;
  const doc = (t[T('documentation')] ?? '').trim();
  const metadata = {
    pageType: 'reference',
    sinceVersion: sinceVersion(t[C('since')]),
    resources: resourcesOf(resource, method.namespace),
    integrations: [],
    operations: [name],
  };
  for (const p of metadataProblems(metadata)) {
    console.error(`${slug}.md: ${p}`);
    invalid++;
  }
  const md = frontMatter(metadata) + [
    `# ${method.namespace}.${method.name}`,
    '',
    `\`${http.method} ${http.uri}\` · ${t[C('stability')] ?? 'ga'} · since Caitlyn ${t[C('since')]}`,
    '',
    doc,
    '',
    '_Generated from the Smithy model by the docs skeleton. Lane D2 replaces this page with the full reference._',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(site, `${slug}.md`), md);
  pages.push({
    path: `${slug}.md`,
    url: `https://build.caitlyn.ai/${slug}/`,
    title: `${method.namespace}.${method.name}`,
    metadata,
  });
}
// Hand-written guides (docs/guides/), checked against the examples their code comes from
fs.mkdirSync(path.join(site, 'guides'), { recursive: true });
for (const g of readGuides()) {
  for (const p of g.problems) {
    console.error(`docs/${g.slug}.md: ${p}`);
    invalid++;
  }
  fs.writeFileSync(path.join(site, `${g.slug}.md`), g.markdown);
  pages.push({ path: `${g.slug}.md`, url: `https://build.caitlyn.ai/${g.slug}/`, title: g.title, metadata: g.metadata });
}
if (invalid) {
  console.error(`docs-build: ${invalid} front-matter values ingestion would skip; fix them before publishing.`);
  process.exit(1);
}
fs.writeFileSync(
  path.join(site, 'index.html'),
  '<!doctype html><html lang="en-NZ"><head><meta charset="utf-8"><title>Caitlyn developer docs</title></head>' +
    '<body><h1>Caitlyn developer docs</h1><p>Coming soon.</p></body></html>\n',
);
fs.writeFileSync(path.join(out, 'pages.json'), JSON.stringify({ pages }, null, 2) + '\n');
console.log(`docs-build: ${pages.length} pages in build/docs/site (skeleton; lane D2 builds the real site)`);
