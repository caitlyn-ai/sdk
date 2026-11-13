// Publishes the built developer docs into the ask.caitlyn.ai developer-docs knowledge base, so Ask Caitlyn
// answers from them: one document per page, keyed by its URL as externalId, with its URL as sourceUrl for
// citations.
//
// The metadata travels in each page's front matter, which the docs build writes (scripts/docs-metadata.mjs).
// Markdown ingestion reads front-matter keys that equal the knowledge base's custom fields (pageType,
// sinceVersion, resources, integrations, operations), validates and stores them, and the model does not infer
// those fields. So the publisher sends no metadata of its own and needs no metadata update after uploading.
// Valid values are applied again on every ingest; a field an operator has locked keeps its value. Ingestion
// skips an invalid value and records a partial failure, so this script checks every page's front matter
// against the fields' option keys first and sends nothing if any page fails.
//
// A STUB. The real publisher uses @caitlyn-ai/sdk: documents.upload with metadata, sourceUrl and
// externalId, new versions on change, deletes and moves, and waitUntilIndexed. None of that exists until
// the server serves the v3 document operations and the TypeScript SDK covers them. Until
// then this script reads build/docs/pages.json, checks every page's front matter and, with --dry-run,
// prints what it would send. Without --dry-run it stops, saying so.
//
// Sign-in: OAuth client credentials for the docs publisher's machine client, which may write only to this
// knowledge base. The values are CI variables (masked, protected), never in the repository:
//   ASK_CAITLYN_CLIENT_ID, ASK_CAITLYN_CLIENT_SECRET
// They are to be replaced with workloadIdentity (GitLab CI id_tokens) once the server accepts workload sign-in, so no
// secret is stored at all.
//
// Usage: node scripts/docs-kb-publish.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { metadataProblems, parseFrontMatter } from './docs-metadata.mjs';

export const WORKSPACE = 'ask.caitlyn.ai';
export const KNOWLEDGE_BASE_ID = '01M73EYJMHXXS4GMWBG827B7RB';

const root = path.resolve(import.meta.dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const manifest = path.join(root, 'build/docs/pages.json');
if (!fs.existsSync(manifest)) {
  console.error('docs-kb-publish: no build/docs/pages.json; run make docs first.');
  process.exit(1);
}
const { pages } = JSON.parse(fs.readFileSync(manifest, 'utf8'));

let bad = 0;
for (const page of pages) {
  const file = path.join(root, 'build/docs/site', page.path);
  const problems = [];
  if (!fs.existsSync(file)) problems.push('no such file');
  else {
    page.frontMatter = parseFrontMatter(fs.readFileSync(file, 'utf8'));
    if (!page.frontMatter) problems.push('no front matter');
    else problems.push(...metadataProblems(page.frontMatter));
  }
  for (const p of problems) console.error(`${page.path}: ${p}`);
  bad += problems.length ? 1 : 0;
}
if (bad) {
  console.error(`docs-kb-publish: ${bad} of ${pages.length} pages have problems; nothing sent.`);
  process.exit(1);
}

if (dryRun) {
  console.log(`docs-kb-publish (dry run): would publish ${pages.length} pages to knowledge base ${KNOWLEDGE_BASE_ID} on ${WORKSPACE}:`);
  for (const p of pages) console.log(`  ${p.url}  front matter ${JSON.stringify(p.frontMatter)}`);
  console.log(`Sign-in: ASK_CAITLYN_CLIENT_ID is ${process.env.ASK_CAITLYN_CLIENT_ID ? 'set' : 'not set'}, ` +
    `ASK_CAITLYN_CLIENT_SECRET is ${process.env.ASK_CAITLYN_CLIENT_SECRET ? 'set' : 'not set'}.`);
  process.exit(0);
}

console.error('docs-kb-publish: publishing is not built yet. It needs the v3 document operations on the server and ' +
  '@caitlyn-ai/sdk documents.upload with metadata, sourceUrl and externalId. Use --dry-run.');
process.exit(1);
