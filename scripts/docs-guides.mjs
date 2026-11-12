// Guides: hand-written pages in docs/guides/, whose code comes from the tested examples.
// A code block in a guide that follows a marker line
//   <!-- example: examples/typescript/browser-sign-in-page.ts#sign-in -->
// must equal that example's region, the lines between `// #region sign-in` and `// #endregion`. The examples
// are type-checked against the SDK in CI (scripts/test-typescript.sh), so a guide whose code drifts from them,
// or a guide with front matter ingestion would skip, fails here.
// Usage: node scripts/docs-guides.mjs           checks every guide (scripts/test-typescript.sh runs it)
//        node scripts/docs-guides.mjs --write   first copies each marked region into its code block
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { metadataProblems, parseFrontMatter } from './docs-metadata.mjs';

const root = path.resolve(import.meta.dirname, '..');
const guidesDir = path.join(root, 'docs/guides');
const MARKER = /^<!-- example: (\S+?)#([\w-]+) -->$/;

/** The lines of one `// #region name` in a file, without the markers. */
function region(file, name) {
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  const start = lines.findIndex((l) => l.trim() === `// #region ${name}`);
  if (start < 0) return undefined;
  const end = lines.findIndex((l, i) => i > start && l.trim() === '// #endregion');
  return end < 0 ? undefined : lines.slice(start + 1, end).join('\n');
}

/** Every guide: its slug, title, front matter, Markdown, and the problems with it (empty when it is valid). */
export function readGuides() {
  if (!fs.existsSync(guidesDir)) return [];
  return fs
    .readdirSync(guidesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const markdown = fs.readFileSync(path.join(guidesDir, f), 'utf8');
      const problems = [];
      const metadata = parseFrontMatter(markdown);
      if (!metadata) problems.push('no front matter');
      else {
        problems.push(...metadataProblems(metadata));
        if (metadata.pageType !== 'guide') problems.push(`pageType is "${metadata.pageType}", not guide`);
      }
      const lines = markdown.split('\n');
      lines.forEach((line, i) => {
        const m = MARKER.exec(line.trim());
        if (!m) return;
        const [, file, name] = m;
        const at = `line ${i + 1}, ${file}#${name}`;
        const fence = /^(```+)\w*$/.exec(lines[i + 1] ?? '');
        if (!fence) return problems.push(`${at}: the marker is not followed by a code block`);
        const close = lines.findIndex((l, j) => j > i + 1 && l === fence[1]);
        if (close < 0) return problems.push(`${at}: the code block is not closed`);
        const expected = fs.existsSync(path.join(root, file)) ? region(file, name) : undefined;
        if (expected === undefined) return problems.push(`${at}: no such file or region`);
        if (lines.slice(i + 2, close).join('\n') !== expected) problems.push(`${at}: the code block differs from the example; run node scripts/docs-guides.mjs --write`);
      });
      const title = /^# (.+)$/m.exec(markdown)?.[1] ?? f;
      return { slug: `guides/${f.replace(/\.md$/, '')}`, title, metadata, markdown, problems };
    });
}

/** Copies each marked example region into the code block that follows its marker. */
function writeRegions() {
  if (!fs.existsSync(guidesDir)) return;
  for (const f of fs.readdirSync(guidesDir).filter((f) => f.endsWith('.md'))) {
    const lines = fs.readFileSync(path.join(guidesDir, f), 'utf8').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      out.push(lines[i]);
      const m = MARKER.exec(lines[i].trim());
      const fence = m && /^(```+)\w*$/.exec(lines[i + 1] ?? '');
      const close = fence ? lines.findIndex((l, j) => j > i + 1 && l === fence[1]) : -1;
      const code = close > 0 && fs.existsSync(path.join(root, m[1])) ? region(m[1], m[2]) : undefined;
      if (code === undefined) continue;
      out.push(lines[i + 1], code, lines[close]);
      i = close;
    }
    fs.writeFileSync(path.join(guidesDir, f), out.join('\n'));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) writeRegions();
  const guides = readGuides();
  let failed = 0;
  for (const g of guides) for (const p of g.problems) {
    console.error(`docs/${g.slug}.md: ${p}`);
    failed++;
  }
  if (failed) process.exit(1);
  console.log(`docs-guides: ${guides.length} guide(s); front matter valid and code blocks match the examples`);
}
