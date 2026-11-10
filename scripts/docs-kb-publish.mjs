// Publishes the built developer docs into the ask.caitlyn.ai developer-docs knowledge base, so Ask Caitlyn
// answers from them: one document per page, keyed by its URL as externalId, with the page's metadata
// (scripts/docs-metadata.mjs) and its URL as sourceUrl for citations.
//
// A STUB. The real publisher (lane D4) uses @caitlyn-ai/sdk: documents.upload with metadata, sourceUrl and
// externalId, new versions on change, deletes and moves, and waitUntilIndexed. None of that exists until
// the server lanes ship v3 documents (S3) and the TypeScript SDK covers them (K1). Until
// then this script reads build/docs/pages.json, checks every page's metadata and, with --dry-run, prints
// what it would send. Without --dry-run it stops, saying so.
//
// Sign-in: OAuth client credentials for the docs publisher's machine client, which may write only to this
// knowledge base. The values are CI variables (masked, protected), never in the repository:
//   ASK_CAITLYN_CLIENT_ID, ASK_CAITLYN_CLIENT_SECRET
// The plan's lane D4 replaces them with workloadIdentity (GitLab CI id_tokens) once lane A3 exists, so no
// secret is stored at all.
//
// Usage: node scripts/docs-kb-publish.mjs [--dry-run]
import fs from 'node:fs';
import path from 'node:path';
import { metadataProblems } from './docs-metadata.mjs';

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
  const problems = metadataProblems(page.metadata);
  if (!fs.existsSync(path.join(root, 'build/docs/site', page.path))) problems.push(`no file ${page.path}`);
  for (const p of problems) console.error(`${page.path}: ${p}`);
  bad += problems.length ? 1 : 0;
}
if (bad) {
  console.error(`docs-kb-publish: ${bad} of ${pages.length} pages have problems; nothing sent.`);
  process.exit(1);
}

if (dryRun) {
  console.log(`docs-kb-publish (dry run): would publish ${pages.length} pages to knowledge base ${KNOWLEDGE_BASE_ID} on ${WORKSPACE}:`);
  for (const p of pages) console.log(`  ${p.url}  ${JSON.stringify(p.metadata)}`);
  console.log(`Sign-in: ASK_CAITLYN_CLIENT_ID is ${process.env.ASK_CAITLYN_CLIENT_ID ? 'set' : 'not set'}, ` +
    `ASK_CAITLYN_CLIENT_SECRET is ${process.env.ASK_CAITLYN_CLIENT_SECRET ? 'set' : 'not set'}.`);
  process.exit(0);
}

console.error('docs-kb-publish: publishing is not built yet. It needs v3 documents (lane S3) and @caitlyn-ai/sdk ' +
  'documents.upload with metadata, sourceUrl and externalId (lane K1); lane D4 builds it. Use --dry-run.');
process.exit(1);
