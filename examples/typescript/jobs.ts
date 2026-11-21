// The jobs on the SDK's landing page, one region each, with the region names every language's examples share:
// add-document, sync-folder, sync-estimate, replace-document, watch-document, set-access, publish-agent, roll-back,
// chat, watch-conversation, watch-knowledge-base, delete-things, fill-in-fields, reprocess, layout-aware-search,
// avatar-picture and send-upload. In each, `kb` is `caitlyn.knowledgeBases(kbId)`. scripts/test-typescript.sh
// type-checks this file against the SDK.
import type { Caitlyn, FileInput, Job, KnowledgeBase, KnowledgeBaseEvent, ConversationEvent } from '@caitlyn-ai/sdk';

/** 1. Adds a document, and waits until it can be searched. */
export async function addDocument(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region add-document
  const doc = await kb.documents.create('./leave-policy.pdf', { folder: '/hr/' }).wait();
  // #endregion
  return doc;
}

/** 2. Keeps a folder of the knowledge base in step with a folder on disk. */
export async function syncFolder(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region sync-folder
  const report = await kb.ingestion.sync('./policies', { folder: '/policies/', removeMissing: true });
  for (const item of report.items) console.log(item.path, item.outcome, item.status, item.failureCode ?? '');
  // #endregion
  return report;
}

/** 2a. What syncing would do and cost, before anything is uploaded. */
export async function syncEstimate(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region sync-estimate
  const plan = await kb.ingestion.sync.estimate('./policies', { folder: '/policies/', removeMissing: true });
  console.log(`${plan.items.length} items; ${plan.estimate?.documents ?? 0} to upload, about ${plan.estimate?.durationSeconds.high ?? 0} s`);
  // #endregion
  return plan;
}

/** 3. Replaces a document's file; the current version keeps answering until the new one is indexed. */
export async function replaceDocument(caitlyn: Caitlyn, kbId: string, documentId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region replace-document
  await kb.documents(documentId).replace('./leave-policy-2027.pdf').wait();
  // #endregion
}

/** 4. Follows a document's processing, also after a page reload: its progress as it stands, then each change. */
export async function watchDocument(caitlyn: Caitlyn, kbId: string, documentId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region watch-document
  const doc = await kb.documents(documentId).wait({ onProgress: (p) => console.log(p.stage, p.percent, p.eta) });
  // #endregion
  return doc;
}

/** 4a. The same with a raw watch: `event.processing` reads the snapshot and the progress events alike. */
export async function watchDocumentEvents(caitlyn: Caitlyn, kbId: string, documentId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  for await (const event of kb.documents(documentId).watch()) {
    const p = event.processing;
    if (p) console.log(p.stage, p.percent, p.eta);
    if (event.type === 'job.finished') break;
  }
}

/** 5. Restricts who may read a folder, and puts a document back to its folder's readers. */
export async function setAccess(caitlyn: Caitlyn, kbId: string, documentId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region set-access
  await kb.folders('/hr/investigations/').access.set({ readers: { roles: ['hr-team'] } });
  await kb.documents(documentId).access.set({ readers: 'inherit' });
  // #endregion
  // #region readers-values
  // The four kinds of readers, widest first
  await kb.folders('/handbook/').access.set({ readers: 'public' });
  await kb.folders('/staff/').access.set({ readers: 'everyone' });
  await kb.folders('/hr/').access.set({ readers: { roles: ['hr-team'], people: ['u-1'] } });
  await kb.folders('/hr/handbook/').access.set({ readers: 'inherit' });
  // #endregion
}

/** 5a. A guarded write: only if no one changed the folder's readers since you read them (a stale ETag is a 412). */
export async function setAccessGuarded(caitlyn: Caitlyn, kbId: string) {
  const folder = caitlyn.knowledgeBases(kbId).folders('/hr/investigations/');
  const { etag } = await folder.access.get();
  await folder.access.set({ readers: { roles: ['hr-team'] } }, { ifMatch: etag });
}

/** 6. Creates an agent with its first configuration, and publishes it. */
export async function publishAgent(caitlyn: Caitlyn, instructions: string) {
  // #region publish-agent
  const agent = await caitlyn.agents.create({ name: 'HR assistant', configuration: { guidance: { instructions } } });
  await agent.draft.publish({ name: 'v1' });
  // #endregion
  return agent;
}

/** 7. Points live at an earlier version again; the history records it as a rollback. */
export async function rollBack(caitlyn: Caitlyn, agentId: string) {
  // #region roll-back
  await caitlyn.agents(agentId).versions('v13').publish();
  // #endregion
}

/** 8. Starts a conversation with what is live, and streams the answer's text. */
export async function chat(caitlyn: Caitlyn, agentId: string) {
  // #region chat
  const conversation = await caitlyn.agents(agentId).live.conversations.create();
  for await (const text of conversation.send('How much leave do part-time staff get?').text()) process.stdout.write(text);
  // #endregion
  return conversation;
}

/** 8a. After a page reload, with only the conversation's ID: the answer in flight from its start, then every one after. */
export async function watchConversation(caitlyn: Caitlyn, conversationId: string, render: (event: ConversationEvent) => void) {
  // #region watch-conversation
  for await (const event of caitlyn.conversations(conversationId).watch()) {
    render(event);
    if (event.type === 'message.completed') break; // or keep watching for the next answer
  }
  // #endregion
}

/** 9. Watches a whole knowledge base: a snapshot, then each change. */
export async function watchKnowledgeBase(
  caitlyn: Caitlyn,
  kbId: string,
  render: (knowledgeBase: KnowledgeBase | undefined, jobs: Job[]) => void,
  update: (event: KnowledgeBaseEvent) => boolean,
) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region watch-knowledge-base
  for await (const event of kb.watch()) {
    if (event.type === 'snapshot') render(event.knowledgeBase, event.jobs);
    else if (!update(event)) break; // document.updated, document.progress, job.progress, …
  }
  // #endregion
}

/** 10. Deletes a document, a folder, a knowledge base and an agent; the ones that take time are waited on. */
export async function deleteThings(caitlyn: Caitlyn, kbId: string, documentId: string, agentId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region delete-things
  await kb.documents(documentId).delete();
  await kb.folders('/archive/').delete().wait();
  await kb.delete().wait();
  await caitlyn.agents(agentId).delete();
  // #endregion
}

/** Fills in a metadata field for the documents that lack it: its estimate first, then the job, waited on. */
export async function fillInFields(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region fill-in-fields
  const estimate = await kb.fields.fillIn.estimate(['policyOwner']);
  if (estimate.cost) {
    const { low, high, unit } = estimate.cost; // in the form the organisation sees its costs
    console.log(`${estimate.documents} documents,`, unit === 'usd' ? `US$${low.toFixed(2)}–${high.toFixed(2)}` : `${low.toFixed(1)}–${high.toFixed(1)}% of usage`);
  }
  await kb.fields.fillIn(['policyOwner']).wait();
  // #endregion
}

/** Processes documents processed an older way again the newest way. */
export async function reprocess(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region reprocess
  const estimate = await kb.documents.reprocess.estimate({ outOfDate: true });
  console.log(`${estimate.documents} documents, about ${estimate.durationSeconds.high} s`);
  await kb.documents.reprocess({ outOfDate: true }).wait();
  // #endregion
}

/** Turns on layout-aware search, after its estimate. */
export async function layoutAwareSearch(caitlyn: Caitlyn, kbId: string) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region layout-aware-search
  const estimate = await kb.layoutAwareSearch.enable.estimate();
  if (estimate.cost) {
    const { low, high, unit } = estimate.cost; // in the form the organisation sees its costs
    console.log(unit === 'usd' ? `US$${low.toFixed(2)}–${high.toFixed(2)}` : `${low.toFixed(1)}–${high.toFixed(1)}% of usage`);
  }
  await kb.layoutAwareSearch.enable().wait();
  // #endregion
}

/** An agent whose avatar is a picture: the SDK uploads the file and sends the upload's ID where it goes. */
export async function avatarPicture(caitlyn: Caitlyn, picture: FileInput) {
  // #region avatar-picture
  // A PNG, JPEG or WebP of at most 1 MB: a path, a File, or UploadFile.fromBytes(…), where the identifier goes
  const agent = await caitlyn.agents.create({ name: 'HR assistant', avatar: { colour: 'sage', mark: { pictureUploadId: picture } } });
  await agent.update({ avatar: { colour: 'sage', mark: { pictureUploadId: picture } } }, { ifMatch: agent.etag });
  // #endregion
  return agent;
}

/** The building block under every file the SDK sends: a file uploaded on its own, then used by its ID. */
export async function sendUpload(caitlyn: Caitlyn, kbId: string, file: FileInput) {
  const kb = caitlyn.knowledgeBases(kbId);
  // #region send-upload
  const upload = await caitlyn.core.uploads.send(file);
  const doc = await kb.documents.create({ uploadId: upload.id }, { folder: '/hr/' });
  // #endregion
  return doc;
}
