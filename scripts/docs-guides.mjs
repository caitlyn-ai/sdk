// The hand-written pages: every Markdown file under docs/ except docs/README.md and the site project in
// docs/site/. Guides are in docs/guides/; the other pages (the landing page, Getting started, Authentication,
// Errors and the rest) are at the top of docs/. Their code comes from the tested examples.
// A code block that follows a marker line
//   <!-- example: examples/typescript/browser-sign-in-page.ts#sign-in -->
// must equal that example's region: the lines between `// #region sign-in` and `// #endregion` (`# #region` and
// `# #endregion` in Python), less the indentation they share. The examples are compiled against their SDK in
// CI (scripts/test-typescript.sh, test-python.sh, test-go.sh and test-rust.sh), so a page whose code drifts
// from them, or a page with front matter ingestion would skip, fails here.
// Usage: node scripts/docs-guides.mjs           checks every page (scripts/test-typescript.sh and the docs build run it)
//        node scripts/docs-guides.mjs --write   first copies each marked region into its code block
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataProblems, parseFrontMatter } from './docs-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const docsDir = path.join(root, 'docs');
export const MARKER = /^<!-- example: (\S+?)#([\w-]+) -->$/;
const FENCE = /^(```+)[^`]*$/;

/** The hand-written page files, relative to docs/: README.md and the site project are not pages. */
function pageFiles(dir = docsDir, prefix = '') {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => {
      const rel = prefix + e.name;
      if (e.isDirectory()) return rel === 'site' ? [] : pageFiles(path.join(dir, e.name), `${rel}/`);
      return e.name.endsWith('.md') && rel !== 'README.md' ? [rel] : [];
    })
    .sort();
}

/** The lines of one region in a file, without the markers and less the indentation they share. */
function region(file, name) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  const marker = (l, text) => ['//', '#'].some((c) => l.trim() === `${c} ${text}`);
  const start = lines.findIndex((l) => marker(l, `#region ${name}`));
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && marker(l, '#endregion'));
  if (end < 0) return undefined;
  const body = lines.slice(start + 1, end);
  const indents = body.filter((l) => l.trim()).map((l) => /^[\t ]*/.exec(l)[0].length);
  const shared = indents.length ? Math.min(...indents) : 0;
  return body.map((l) => l.slice(shared)).join('\n');
}

/** Every hand-written page: its file, slug, title, front matter, Markdown, and its problems (empty when valid). */
export function readPages() {
  return pageFiles().map((f) => {
    const markdown = fs.readFileSync(path.join(docsDir, f), 'utf8');
    const problems = [];
    const metadata = parseFrontMatter(markdown);
    if (!metadata) problems.push('no front matter');
    else {
      problems.push(...metadataProblems(metadata));
      if (f.startsWith('guides/') && metadata.pageType !== 'guide') problems.push(`pageType is "${metadata.pageType}", not guide`);
    }
    const lines = markdown.split('\n');
    lines.forEach((line, i) => {
      const m = MARKER.exec(line.trim());
      if (!m) return;
      const [, file, name] = m;
      const at = `line ${i + 1}, ${file}#${name}`;
      const fence = FENCE.exec(lines[i + 1] ?? '');
      if (!fence) return problems.push(`${at}: the marker is not followed by a code block`);
      const close = lines.findIndex((l, j) => j > i + 1 && l === fence[1]);
      if (close < 0) return problems.push(`${at}: the code block is not closed`);
      const expected = fs.existsSync(path.join(root, file)) ? region(file, name) : undefined;
      if (expected === undefined) return problems.push(`${at}: no such file or region`);
      if (lines.slice(i + 2, close).join('\n') !== expected) problems.push(`${at}: the code block differs from the example; run node scripts/docs-guides.mjs --write`);
    });
    const title = /^# (.+)$/m.exec(markdown)?.[1];
    if (!title) problems.push('no # title');
    const slug = f.replace(/\.md$/, '').replace(/(^|\/)index$/, '');
    return { file: `docs/${f}`, slug, title: title ?? f, metadata, markdown, problems };
  });
}

/** Copies each marked region into the code block that follows its marker. */
function writeRegions() {
  for (const f of pageFiles()) {
    const lines = fs.readFileSync(path.join(docsDir, f), 'utf8').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      const m = MARKER.exec(lines[i].trim());
      const fence = m && FENCE.exec(lines[i + 1] ?? '');
      const close = fence ? lines.findIndex((l, j) => j > i + 1 && l === fence[1]) : -1;
      const code = close > 0 && fs.existsSync(path.join(root, m[1])) ? region(m[1], m[2]) : undefined;
      if (code === undefined) continue;
      out.push(lines[i + 1], code, lines[close]);
      i = close;
    }
    fs.writeFileSync(path.join(docsDir, f), out.join('\n'));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) writeRegions();
  const pages = readPages();
  let failed = 0;
  for (const g of pages) {
    for (const p of g.problems) {
      console.error(`${g.file}: ${p}`);
      failed++;
    }
  }
  if (failed) process.exit(1);
  console.log(`docs-guides: ${pages.length} hand-written pages; front matter valid and code blocks match the examples`);
}
