// Task 2: load documents into a knowledge base. knowledgeBases.create, documents.waitUntilIndexed (a @waitable
// waiter), uploadMany, replace and delete are not in the model yet; until they are, this uploads into an existing
// knowledge base and lists what is there.
import { openAsBlob } from 'node:fs';
import { Caitlyn } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });

export async function load(knowledgeBaseId: string): Promise<void> {
  const { document: doc, operation } = await caitlyn.documents.upload(
    {
      knowledgeBaseId,
      folder: '/policies/',
      file: await openAsBlob('leave-policy.pdf'),
      fileName: 'leave-policy.pdf',
    },
    { idempotencyKey: 'leave-policy-2026-11' },
  );
  console.log(doc.id, doc.status, operation.id);

  for await (const d of caitlyn.documents.list({ knowledgeBaseId, folder: '/policies/', status: 'partially_indexed' }, { signal: AbortSignal.timeout(60_000) })) {
    console.warn(d.name, d.partialFailures);
  }
}
