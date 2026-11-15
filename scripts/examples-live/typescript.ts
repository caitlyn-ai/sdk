// The TypeScript checks for scripts/examples-live.mjs: each runs the example the developer docs show
// (examples/typescript/conversations.ts) against a real server, and prints one line, `ok <check>` or
// `fail <check>: <why>`. It reads CAITLYN_WORKSPACE, CAITLYN_TOKEN and CAITLYN_AGENT_ID, and CAITLYN_ENDPOINT when
// set. What the examples print goes to stderr, so stdout carries only those lines.
import fs from 'node:fs';
import path from 'node:path';
import { Caitlyn, ConflictError, NotFoundError } from '@caitlyn-ai/sdk';
import * as examples from '../../examples/typescript/conversations';
import * as agents from '../../examples/typescript/agents';
import * as documents from '../../examples/typescript/documents';

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`set ${name}`);
  return value;
};
const agentId = required('CAITLYN_AGENT_ID');
// CAITLYN_ENDPOINT is optional: without it the client calls https://<workspace>/api, as an integrator's does.
const endpoint = process.env.CAITLYN_ENDPOINT || undefined;
const caitlyn = new Caitlyn({
  workspace: required('CAITLYN_WORKSPACE'),
  ...(endpoint ? { endpoint } : {}),
  auth: { mode: 'token', token: required('CAITLYN_TOKEN') },
});

// The examples' own output (answers, logs) goes to stderr.
const report = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr) as typeof process.stdout.write;

let failures = 0;
/**
 * A check this run is not set up for, reported as `skip <check>: <why>`. The runner accepts only two reasons here:
 * `no knowledge base configured` (CAITLYN_KNOWLEDGE_BASE_ID unset) and `publishing turned off`
 * (CAITLYN_PUBLISH_AGENT_ID unset). Every other failure, a 403 included, is reported as a failure.
 */
class Skip extends Error {}

/**
 * Runs one check with a deadline; any error, or a deadline passed, is a failure. The signal is aborted at the
 * deadline and once the check ends, so streams a check left open close; a check that ignores it still loses the
 * race, and the process exits after the last check.
 */
async function check(name: string, seconds: number, run: (signal: AbortSignal) => Promise<void>): Promise<void> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const reason = new Error(`no result within ${seconds} s`);
      controller.abort(reason);
      reject(reason);
    }, seconds * 1000);
  });
  try {
    await Promise.race([run(controller.signal), deadline]);
    report(`ok ${name}\n`);
  } catch (err) {
    if (err instanceof Skip) {
      report(`skip ${name}: ${err.message}\n`);
      return;
    }
    failures++;
    // An API error reads `<status> <code>: <detail>` (`403 PERMISSION_DENIED: You do not have …`), the form the
    // shared runner reads; anything else is its name and message.
    const e = err as { name?: string; code?: string; status?: number; detail?: string; message?: string };
    const why = e.status && e.code ? `${e.status} ${e.code}: ${e.detail ?? e.message ?? ''}` : [e.name, e.message].filter(Boolean).join(' ');
    report(`fail ${name}: ${why.replace(/\s+/g, ' ').slice(0, 300)}\n`);
  } finally {
    clearTimeout(timer);
    controller.abort(); // closes anything still open
  }
}

// A rejection nothing waits for (a stream closed under a check that already failed) must not end the run early.
process.on('unhandledRejection', (err) => console.error('unhandled:', err));
const expect = (ok: unknown, what: string) => {
  if (!ok) throw new Error(what);
};

/** A UUIDv7 for a given time: the form a workspace event cursor takes. */
function uuidv7(ms: number): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  let t = BigInt(ms);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

let conversationId: string | undefined;

await check('GetCaller', 30, async () => {
  const me = await examples.getCaller(caitlyn);
  expect(me.displayName && me.organisation.id && me.credential, `incomplete caller: ${JSON.stringify(me)}`);
});
await check('GetAgentVersion', 30, async () => {
  const draft = await examples.getAgentVersion(caitlyn, agentId);
  expect(draft.agentId === agentId && draft.etag, `agent ${draft.agentId}, ETag ${draft.etag}`);
});
await check('CreateConversation', 30, async () => {
  const conversation = await examples.createConversation(caitlyn, agentId);
  expect(conversation.id && conversation.agentId === agentId && conversation.version === 'draft', `conversation ${JSON.stringify(conversation)}`);
  conversationId = conversation.id;
});
/** SendMessage's answer, and when it finished: the conversation's earlier answer when WatchConversation runs. */
let earlier: { id: string; finishedAt: number } | undefined;
const t0 = Date.now();
const at = (t: number) => `+${((t - t0) / 1000).toFixed(1)} s`;

await check('SendMessage', 180, async () => {
  expect(conversationId, 'no conversation (CreateConversation failed)');
  const answer = await examples.sendMessage(caitlyn, conversationId!);
  earlier = { id: answer.id, finishedAt: Date.now() };
  expect(answer.text, 'the final message has no text');
});
await check('WatchConversation', 180, async (signal) => {
  expect(conversationId, 'no conversation (CreateConversation failed)');
  // An observer beside the example's own watch, opened the same way, records every completion the server sends
  // after the watch opened. A watch shows "the answer being written, if any, then every answer after it"; a
  // completion for any other answer (the server has been seen delivering one that finished just before the watch
  // opened) is reported on stderr. The check itself passes or fails on whether the watch delivered the answer
  // the example sent: the example waits for its own answer, as an integrator's code should.
  const observer = caitlyn.conversations.watch(conversationId!, {}, { signal });
  await observer.opened();
  const openedAt = Date.now();
  const completions: { id: string; role: string; eventId?: string; at: number }[] = [];
  const observing = (async () => {
    for await (const event of observer) {
      console.error(`observer ${at(Date.now())} ${event.type} ${event.eventId ?? ''}`);
      if (event.type === 'message.started') console.error(`observer   messageId ${event.messageId}`);
      if (event.type === 'message.completed') completions.push({ id: event.message.id, role: event.message.role, eventId: event.eventId, at: Date.now() });
    }
  })().catch(() => undefined);
  const { watched, answer } = await examples.watchConversation(caitlyn, conversationId!);
  const settle = Date.now() + 5000; // let the observer see the same completion
  while (!completions.some((c) => c.id === answer.id) && Date.now() < settle) await new Promise((r) => setTimeout(r, 100));
  void observing;
  const describe = (c: (typeof completions)[number]) =>
    `${c.id} (role ${c.role}, event ${c.eventId}, ${at(c.at)}${earlier && c.id === earlier.id ? `: SendMessage's answer, finished at ${at(earlier.finishedAt)}` : ''})`;
  const foreign = completions.filter((c) => c.id !== answer.id);
  if (foreign.length)
    console.error(
      `note: the watch, opened at ${at(openedAt)}, also delivered message.completed for ${foreign.map(describe).join(', ')}, besides the answer sent after it opened, ${answer.id}`,
    );
  expect(watched?.id === answer.id, `the example's watch did not complete the answer it sent (${answer.id})`);
});
await check('WatchWorkspaceEvents', 60, async () => {
  const { conversation, created } = await examples.watchWorkspaceEvents(caitlyn, agentId);
  expect(created?.data.id === conversation.id, `no conversation.created for ${conversation.id}`);
});
await check('stream.reset', 60, async () => {
  const twoDaysAgo = uuidv7(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const seen: { type: string; eventId?: string; cursor?: string }[] = [];
  const stop = new Error('stop');
  let resynced = false;
  try {
    await examples.followEvents(
      caitlyn,
      twoDaysAgo,
      (event) => {
        seen.push(event as (typeof seen)[number]);
        throw stop; // the first event is all this check needs; throwing closes the stream
      },
      async () => void (resynced = true),
    );
  } catch (err) {
    if (err !== stop) throw err;
  }
  const first = seen[0];
  expect(first?.type === 'stream.reset', `the first event was ${first?.type ?? 'none'}`);
  expect(first!.cursor && first!.cursor === first!.eventId, `cursor ${first!.cursor}, eventId ${first!.eventId}`);
  expect(resynced, 'stream.reset did not lead to a resync');
});

// ---------------------------------------------------------------- uploads and documents

const knowledgeBaseId = process.env.CAITLYN_KNOWLEDGE_BASE_ID || undefined;
const noKnowledgeBase = () => {
  if (!knowledgeBaseId) throw new Skip('no knowledge base configured (CAITLYN_KNOWLEDGE_BASE_ID is not set)');
};
let uploadId: string | undefined;
let documentId: string | undefined;
/** Documents this run created that are not yet known to be gone: the clean-up deletes whatever is left. */
const created = new Set<string>();
// A one-page leave policy as a PDF: a knowledge base ingests PDFs (and Word, Markdown, images, audio and video),
// not plain text. The repository root is fixed when typescript.sh bundles this file.
const ROOT = process.env.CAITLYN_REPO_ROOT ?? path.resolve(import.meta.dirname, '../..');
const leavePolicy = () => new Blob([fs.readFileSync(path.join(ROOT, 'examples/fixtures/leave-policy.pdf'))], { type: 'application/pdf' });
// The examples put documents in '/policies/', as the docs show, so each run's documents have names of their own: a
// name already used in a folder is refused.
const runId = `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

await check('CreateUpload', 60, async () => {
  const upload = await documents.createUpload(caitlyn, leavePolicy(), `leave-policy-${runId}.pdf`);
  expect(upload.id, `no upload id: ${JSON.stringify(upload)}`);
  uploadId = upload.id;
});
await check('GetUpload', 30, async () => {
  expect(uploadId, 'no upload (CreateUpload failed)');
  const upload = await documents.getUpload(caitlyn, uploadId!);
  expect(upload.id === uploadId && upload.status, `upload ${JSON.stringify(upload)}`);
});
await check('CreateDocument', 60, async () => {
  noKnowledgeBase();
  expect(uploadId, 'no upload (CreateUpload failed)');
  const document = await documents.createDocument(caitlyn, knowledgeBaseId!, uploadId!);
  expect(document.id && document.knowledgeBaseId === knowledgeBaseId, `document ${JSON.stringify(document)}`);
  documentId = document.id;
  created.add(document.id);
});
// A document still being processed cannot be deleted yet: 409 CONFLICT. A third document is deleted the moment it is
// created, while it is pending. A one-page PDF can index quickly, so if it has already finished processing, the delete
// is accepted instead; that passes too, and says so on stderr. The clean-up at the end deletes it once it is indexed.
await check('DeleteDocument.processing', 60, async () => {
  noKnowledgeBase();
  const upload = await caitlyn.uploads.create({ file: leavePolicy(), fileName: `leave-policy-${runId}-3.pdf` });
  const { document: third } = await caitlyn.documents.create({ knowledgeBaseId: knowledgeBaseId!, uploadId: upload.id, folder: '/policies/' });
  created.add(third.id);
  try {
    const deleted = await caitlyn.documents.delete({ knowledgeBaseId: knowledgeBaseId!, documentId: third.id });
    expect(deleted.status === 'deleting', `the delete was neither refused nor accepted: ${deleted.status}`);
    console.error(`DeleteDocument.processing: ${third.id} had already finished processing (${third.status} when created); the delete was accepted`);
  } catch (err) {
    if (!(err instanceof ConflictError)) throw err;
    expect(err.code === 'CONFLICT', `409 with code ${err.code}`);
  }
});
await check('GetDocument', 30, async () => {
  noKnowledgeBase();
  expect(documentId, 'no document (CreateDocument failed)');
  const document = await documents.getDocument(caitlyn, knowledgeBaseId!, documentId!);
  expect(document.id === documentId, `document ${document.id}`);
});
await check('WaitUntilIndexed', 900, async () => {
  noKnowledgeBase();
  expect(documentId, 'no document (CreateDocument failed)');
  const document = await documents.waitUntilIndexed(caitlyn, knowledgeBaseId!, documentId!);
  expect(document.status === 'indexed' || document.status === 'partially_indexed', `status ${document.status}`);
});
await check('ListDocuments', 60, async () => {
  noKnowledgeBase();
  // Passes when the run's document is listed, whatever its status: indexing need not have finished
  expect(documentId, 'no document to look for (CreateDocument failed)');
  const ids = await documents.listDocuments(caitlyn, knowledgeBaseId!);
  expect(ids.includes(documentId!), `the list does not include ${documentId}`);
});
await check('DeleteDocument', 30, async () => {
  noKnowledgeBase();
  expect(documentId, 'no document (CreateDocument failed)');
  const document = await documents.deleteDocument(caitlyn, knowledgeBaseId!, documentId!);
  expect(document.status === 'deleting', `the deleted document is ${document.status}`);
});
/**
 * Diagnostics, not a check: prints each change in a document's status to stderr, read every 15 s until stopped or
 * the check's signal is aborted, so a delete that does not finish shows what the document did instead.
 */
function logStatusChanges(knowledgeBaseId: string, documentId: string, signal: AbortSignal): () => void {
  const started = Date.now();
  let last = '';
  let stopped = false;
  const read = async () => {
    let now: string;
    try {
      const d = await caitlyn.documents.get({ knowledgeBaseId, documentId });
      now = [d.status, d.stage, d.failure?.code].filter(Boolean).join(' ');
    } catch (err) {
      now = err instanceof NotFoundError ? '404' : `error ${(err as Error).name}`;
    }
    if (!stopped && now !== last) console.error(`status: ${documentId} at ${Math.round((Date.now() - started) / 1000)} s: ${now}`);
    last = now;
  };
  void read();
  const timer = setInterval(() => void read(), 15_000);
  const stop = () => {
    stopped = true;
    clearInterval(timer);
  };
  signal.addEventListener('abort', stop, { once: true });
  return stop;
}
await check('BatchDeleteDocuments', 900, async (signal) => {
  noKnowledgeBase();
  // A second document, from a new upload, deleted together with an identifier that does not exist
  const upload = await caitlyn.uploads.create({ file: leavePolicy(), fileName: `leave-policy-${runId}-2.pdf` });
  const { document: second } = await caitlyn.documents.create({ knowledgeBaseId: knowledgeBaseId!, uploadId: upload.id, folder: '/policies/' });
  created.add(second.id);
  // Only a document that has finished processing can be deleted
  await caitlyn.documents.waitUntilIndexed({ knowledgeBaseId: knowledgeBaseId!, documentId: second.id }, { signal });
  const missing = `doc-missing-${Date.now()}`;
  const stopLogging = logStatusChanges(knowledgeBaseId!, second.id, signal);
  const results = await documents.batchDeleteDocuments(caitlyn, knowledgeBaseId!, [second.id, missing]);
  expect(results.length === 2 && results[0]!.documentId === second.id && results[1]!.documentId === missing, `results not in request order: ${JSON.stringify(results)}`);
  expect(results[0]!.status === 'accepted', `${second.id}: ${results[0]!.status} ${results[0]!.code ?? ''}`);
  expect(results[1]!.status === 'failed' && results[1]!.code === 'NOT_FOUND', `${missing}: ${results[1]!.status} ${results[1]!.code ?? ''}`);
  try {
    await caitlyn.documents.waitUntilDeleted({ knowledgeBaseId: knowledgeBaseId!, documentId: second.id });
  } finally {
    stopLogging();
  }
  created.delete(second.id);
});
await check('WaitUntilDeleted', 900, async () => {
  noKnowledgeBase();
  expect(documentId, 'no document (CreateDocument failed)');
  await documents.waitUntilDeleted(caitlyn, knowledgeBaseId!, documentId!);
  created.delete(documentId!);
});
// Whatever is left (DeleteDocument.processing's document, and anything a failed check left): wait until each has
// finished processing, since only then can it be deleted, then batch-delete them and wait until each is gone. Not a
// check: it prints to stderr.
if (knowledgeBaseId && created.size) {
  const left = [...created];
  console.error(`clean-up: deleting ${left.join(', ')}`);
  try {
    for (const id of left) {
      // A failed document can be deleted too, and one already deleting is accepted again: only the wait is wanted
      await caitlyn.documents.waitUntilIndexed({ knowledgeBaseId, documentId: id }, { maxWaitMs: 900_000 }).catch(() => undefined);
    }
    await caitlyn.documents.batchDelete({ knowledgeBaseId, documentIds: left });
    for (const id of left) await caitlyn.documents.waitUntilDeleted({ knowledgeBaseId, documentId: id }, { maxWaitMs: 900_000 });
  } catch (err) {
    console.error(`clean-up: could not delete ${left.join(', ')}: ${(err as Error).message}`);
  }
}

// ---------------------------------------------------------------- agent versions and production history
// Every change is put back: the draft is restored, the pin made here is the version the draft is reset from,
// and it is then deleted.

let pinned: string | undefined;
let historyEntryId: string | undefined;

await check('UpdateDraftVersion', 30, async () => {
  const before = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
  const original = before.configuration.instructions ?? '';
  const changed = `${original}\n(Checked by the SDK examples; this line is removed straight away.)`;
  let restoreFrom: string | undefined;
  try {
    const updated = await agents.updateDraft(caitlyn, agentId, changed);
    restoreFrom = updated.etag;
    expect(updated.configuration.instructions === changed, 'the draft does not have the new instructions');
  } finally {
    if (restoreFrom) await caitlyn.agents.versions.updateDraft(agentId, { instructions: original }, { ifMatch: restoreFrom });
  }
});
await check('PinDraftVersion', 30, async () => {
  const name = `live-check-${Date.now()}`;
  const version = await agents.pinDraft(caitlyn, agentId, name);
  expect(version.name === name, `pinned ${version.name}, asked for ${name}`);
  pinned = name;
});
await check('ListAgentVersions', 30, async () => {
  // The list holds the named versions only: the draft and production are not entries.
  expect(pinned, 'no pinned version to list (PinDraftVersion failed)');
  const names = await agents.listVersions(caitlyn, agentId);
  expect(names.includes(pinned!), `the list does not include ${pinned}: ${names.join(', ')}`);
});
// Publishing changes what an agent answers with, so it happens only on CAITLYN_PUBLISH_AGENT_ID, an agent kept for
// it, never on CAITLYN_AGENT_ID. Its production history is where GetProductionHistory reads an entry from.
const publishAgentId = process.env.CAITLYN_PUBLISH_AGENT_ID || undefined;
const publishingOff = () => {
  if (!publishAgentId) throw new Skip('publishing turned off (CAITLYN_PUBLISH_AGENT_ID is not set)');
};

await check('PublishAgentVersion', 60, async () => {
  publishingOff();
  const name = `live-publish-${Date.now()}`;
  await caitlyn.agents.versions.pin(publishAgentId!, { name, note: 'Published by the SDK examples' });
  try {
    // An agent's first publish sends '*': with no production yet there is nothing for the example to read.
    const hasProduction = await caitlyn.agents.versions
      .get({ agentId: publishAgentId!, version: 'production' })
      .then(() => true, (e) => (e instanceof NotFoundError ? false : Promise.reject(e)));
    if (!hasProduction) await caitlyn.agents.versions.publish({ agentId: publishAgentId!, version: name }, { ifMatch: '*' });
    const production = await agents.publishVersion(caitlyn, publishAgentId!, name);
    expect(production.publishedAt, `publish returned ${production.name} with no publishedAt`);
  } finally {
    await caitlyn.agents.versions.delete({ agentId: publishAgentId!, version: name }); // production is its own copy
  }
});
await check('ListProductionHistory', 30, async () => {
  // An agent that has never been republished has an empty history: that is a pass, as long as the list runs.
  const ids = await agents.listProductionHistory(caitlyn, agentId);
  expect(Array.isArray(ids), 'the list did not run');
});
await check('GetProductionHistory', 30, async () => {
  publishingOff();
  const ids = await agents.listProductionHistory(caitlyn, publishAgentId!);
  historyEntryId = ids[0];
  expect(historyEntryId, `the publish agent ${publishAgentId} has no production history entries`);
  const entry = await agents.getProductionHistory(caitlyn, publishAgentId!, historyEntryId!);
  expect(entry.id === historyEntryId && entry.configuration, `entry ${entry.id}`);
});
await check('ResetDraftVersion', 30, async () => {
  expect(pinned, 'no pinned version (PinDraftVersion failed)');
  // The pin is a copy of the draft as it is, so resetting from it leaves the draft's configuration as it was.
  const pin = await caitlyn.agents.versions.get({ agentId, version: pinned! });
  const draft = await agents.resetDraft(caitlyn, agentId, pinned!);
  expect(draft.name === 'draft', `reset returned ${draft.name}`);
  expect(JSON.stringify(draft.configuration) === JSON.stringify(pin.configuration), 'the draft is not a copy of the pinned version');
});
await check('DeleteAgentVersion', 30, async () => {
  expect(pinned, 'no pinned version (PinDraftVersion failed)');
  await agents.deleteVersion(caitlyn, agentId, pinned!);
  const names = await agents.listVersions(caitlyn, agentId);
  expect(!names.includes(pinned!), `${pinned} is still listed`);
  pinned = undefined;
});
if (pinned) await caitlyn.agents.versions.delete({ agentId, version: pinned }).catch(() => undefined); // a pin a failed check left

process.exit(failures ? 1 : 0);
