// Task 2: load documents into a knowledge base: one file, a new version of it, then a whole folder kept in step.
import { Caitlyn, UploadFile } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({ workspace: 'your-company.caitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });

export async function load(knowledgeBaseId: string): Promise<void> {
  const kb = caitlyn.knowledgeBases(knowledgeBaseId);
  const doc = await kb.documents.create(UploadFile.fromPath('leave-policy.pdf'), { folder: '/policies/' }, { idempotencyKey: 'leave-policy-2026-11' }).wait();
  console.log(doc.id, doc.status);

  // A new edition: a new version of the same document, which keeps its identifier and history
  await doc.replace('leave-policy-2027.pdf').wait();

  // A whole folder, kept in step: new and changed files are uploaded, missing ones removed
  const report = await kb.ingestion.sync('./policies', { folder: '/policies/', removeMissing: true });
  console.log(report.batch.status, report.batch.counts);

  for await (const d of kb.documents.list({ folder: '/policies/', status: 'partially_indexed' }, { signal: AbortSignal.timeout(60_000) })) {
    console.warn(d.name, d.partialFailures);
  }
}
