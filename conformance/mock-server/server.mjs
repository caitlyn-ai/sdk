// Mock Caitlyn v3 server for the SDK conformance suites.
//
// Serves the model's operations (model/model.json) with in-memory state, as model/PROTOCOL.md
// describes the wire: RFC 9457 problem details with build.caitlyn.ai error types, Caitlyn-Request-Id
// and Caitlyn-Api-Version on every response, server-sent events with ids and keep-alive comments.
//
// Fault injection and inspection live under /__mock/:
//   POST /__mock/reset              clear state, faults, the request log and any primed example
//   POST /__mock/faults             merge a fault configuration (see DEFAULT_FAULTS)
//   GET  /__mock/requests           the request log (method, path, selected headers, body)
//   POST /__mock/drop               cut the stream that dropOnSignal is holding (see DEFAULT_FAULTS)
//   POST /__mock/example            prime the next request with an example case from
//                                   conformance/cases/examples.json: {"id": "<case id>"}
//   GET  /__mock/example            the primed case's result: {"id", "served", "mismatches": [...]}
//   GET  /__mock/auth               sign-in counters (auth.mjs, which also serves /oauth/* and the STS
//                                   stand-in at /__sts/; fault key `auth`)
// With MOCK_CORS=1, cross-origin requests from a browser page are allowed (see CORS below).
//
// An example case checks the request against the one the case expects (method, path, query,
// headers, JSON body) and answers with the case's response. A request that does not match is
// answered with 400 EXAMPLE_REQUEST_MISMATCH, and the differences are kept for the harness.
//
// No dependencies; Node 20+.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { authFaults, authorised, handleAuth, refusalDelayMs, resetAuth } from './auth.mjs';

const API_VERSION_DEFAULT = '5.120.0';
const EXAMPLES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../cases/examples.json'), 'utf8')).cases;

const DEFAULT_FAULTS = {
  // Per operation, a queue of status faults served before the real response: [{status: 429, retryAfter: 1}].
  // A fault with `body` (a string) or `contentType` is served as that raw body instead of a problem, with no
  // Caitlyn-Request-Id or Caitlyn-Api-Version, as a proxy or a web framework's own error page would be. A fault
  // with `close: true` closes the connection without any response, as a failed TLS handshake or a reset would.
  status: {},
  // Close the SSE connection (without a final event) after this many events on the first stream only.
  dropAfterEvents: null,
  // With dropAfterEvents, wait for POST /__mock/drop before closing, so the client has read the events sent before
  // the cut (the harness posts once it has seen them). Held for at most 10 seconds.
  dropOnSignal: false,
  // End the first stream cleanly, without the final event, after this many events (a proxy cutting it).
  endAfterEvents: null,
  // Insert an event type the model does not define.
  unknownEvent: false,
  // End the chat stream with message.failed instead of message.completed.
  failStream: false,
  // Put an enum value the model does not define on one document, and on the draft's version source.
  unknownEnum: false,
  // Add response fields the model does not define.
  unknownField: false,
  // Also send X-Amzn-Errortype with the Smithy error shape name (what restJson1 clients expect).
  awsErrorTypeHeader: false,
  // Delay between SSE events, for cancellation tests.
  streamDelayMs: 0,
  // The answer finished while the SDK was disconnected: WatchConversation answers a Last-Event-ID inside it with
  // stream.reset (PROTOCOL.md 5.9).
  finishWhileAway: false,
  // End this many watch responses cleanly, as a server shutting down does, each after one event
  // (PROTOCOL.md 5.7). Applies to WatchConversation and WatchWorkspaceEvents.
  watchCloses: 0,
  // End this many watch responses cleanly at once, with no event (PROTOCOL.md 5.6: the backoff, and no
  // Last-Event-ID before any event).
  watchEmptyCloses: 0,
  // End this many watch responses cleanly after sending one event again: the one Last-Event-ID names (a duplicate),
  // or the first event when it names none (PROTOCOL.md 5.6: only a new event resets the reconnect count).
  watchReplayCloses: 0,
  // GetDocument's status over successive reads, per document: { "<documentId>": ["queued", "indexing", "indexed"] }.
  // Each read takes the next status and the last one repeats (for the Indexed waiter, PROTOCOL.md 10.1).
  documentStatus: {},
  // How many GetDocument reads still find a deleted document `deleting` before it is gone (404), for the Deleted
  // waiter (PROTOCOL.md 10.1). DeleteDocument and BatchDeleteDocuments mark it `deleting`.
  deletingReads: 1,
  // Caitlyn-Api-Version the server reports.
  apiVersion: API_VERSION_DEFAULT,
};

// The error catalogue (the model's errors.smithy): one shape per status.
const ERRORS = {
  400: ['ValidationError', 'The request is not valid'],
  401: ['UnauthenticatedError', 'Not signed in'],
  403: ['PermissionDeniedError', 'Permission denied'],
  404: ['NotFoundError', 'Not found'],
  409: ['ConflictError', 'Conflict'],
  412: ['PreconditionFailedError', 'The resource has changed'],
  413: ['PayloadTooLargeError', 'Payload too large'],
  422: ['UnprocessableContentError', 'Unprocessable content'],
  428: ['PreconditionRequiredError', 'If-Match required'],
  429: ['TooManyRequestsError', 'Too many requests'],
  500: ['InternalError', 'Internal error'],
  503: ['ServiceUnavailableError', 'Service unavailable'],
};

let faults;
let dropSignalled = false; // POST /__mock/drop: see dropOnSignal
let log;
let state;
let primed;

function reset() {
  faults = structuredClone(DEFAULT_FAULTS);
  dropSignalled = false;
  log = [];
  primed = null;
  state = {
    knowledgeBases: new Map([['KB4T7YQ2WL', makeDocuments('KB4T7YQ2WL', 7)]]),
    uploads: new Map(),
    idempotency: new Map(),
    conversations: new Map(),
    agents: new Map([
      [
        'GHT7YRWXPL',
        {
          etagN: 1,
          version: {
            agentId: 'GHT7YRWXPL',
            name: 'draft',
            matchesProduction: false,
            createdAt: '2026-11-03T22:14:05.120Z',
            configuration: {
              identity: 'You are the HR assistant.',
              instructions: 'Answer from the HR policies.',
              model: 'claude-sonnet-5-5',
              knowledgeBases: [{ knowledgeBaseId: 'KB4T7YQ2WL', numberOfResults: 6, minimumScore: 0.3 }],
              attachments: { enabled: true, maxFiles: 5 },
              contentSafety: { guardrailId: 'default' },
              deniedDocuments: false,
            },
          },
        },
      ],
    ]),
  };
}
reset();

function makeDocuments(kb, n) {
  const docs = [];
  for (let i = 1; i <= n; i++) {
    docs.push({
      id: `doc-${String(i).padStart(4, '0')}`,
      knowledgeBaseId: kb,
      name: `policy-${i}.pdf`,
      folder: 'policies/',
      status: i === 3 ? 'partially_indexed' : 'indexed',
      contentType: 'application/pdf',
      byteSize: 1000 * i,
      sha256: crypto.createHash('sha256').update(`doc${i}`).digest('base64'),
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      ...(i === 3 ? { partialFailures: [{ code: 'PICTURE_DESCRIPTION_FAILED', detail: 'page 4' }] } : {}),
    });
  }
  return docs;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const requestId = () => `01${crypto.randomBytes(12).toString('hex').toUpperCase().slice(0, 24)}`;

function baseHeaders(rid) {
  return { 'Caitlyn-Request-Id': rid, 'Caitlyn-Api-Version': faults.apiVersion };
}

function sendJson(res, rid, status, body, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...baseHeaders(rid), ...extra });
  res.end(JSON.stringify(body));
}

function sendProblem(res, rid, body, extra = {}) {
  const headers = { 'Content-Type': 'application/problem+json', ...baseHeaders(rid), ...extra };
  if (faults.awsErrorTypeHeader) headers['X-Amzn-Errortype'] = ERRORS[body.status]?.[0] ?? 'ValidationError';
  res.writeHead(body.status, headers);
  res.end(JSON.stringify(body));
}

/** A problem from the catalogue. `fieldErrors` fills `errors` on a 400 VALIDATION_FAILED. */
function problem(res, rid, status, code, detail, { extra = {}, fieldErrors } = {}) {
  const body = {
    type: `https://build.caitlyn.ai/errors/${code}`,
    title: ERRORS[status]?.[1] ?? 'Error',
    status,
    code,
    ...(detail ? { detail } : {}),
    requestId: rid,
    ...(fieldErrors ? { errors: fieldErrors } : {}),
  };
  sendProblem(res, rid, body, extra);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function parseJson(buf) {
  if (!buf.length) return {};
  return JSON.parse(buf.toString('utf8'));
}

/** Serve a queued status fault for this operation, if any. Returns true when it did. */
function statusFault(op, res, rid) {
  const queue = faults.status[op];
  if (!queue || queue.length === 0) return false;
  const f = queue.shift();
  if (f.close) {
    res.socket.destroy();
    return true;
  }
  const extra = f.retryAfter != null ? { 'Retry-After': String(f.retryAfter) } : {};
  if (f.body !== undefined || f.contentType !== undefined) {
    res.writeHead(f.status, { ...(f.contentType ? { 'Content-Type': f.contentType } : {}), ...extra });
    res.end(f.body ?? '');
    return true;
  }
  const code = f.status === 429 ? 'RATE_LIMITED' : f.status === 503 ? 'SERVICE_UNAVAILABLE' : f.status === 500 ? 'INTERNAL' : `HTTP_${f.status}`;
  problem(res, rid, f.status, code, 'Injected fault', { extra });
  return true;
}

function idempotent(key, op, compute) {
  if (!key) return compute();
  const k = `${op}:${key}`;
  if (state.idempotency.has(k)) return { ...state.idempotency.get(k), replayed: true };
  const result = compute();
  if (result.status < 500) state.idempotency.set(k, result);
  return result;
}

// ---------------------------------------------------------------------------
// Example cases
// ---------------------------------------------------------------------------

function compareJson(expected, actual, at, out) {
  if (expected !== null && typeof expected === 'object') {
    if (actual === null || typeof actual !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) {
      out.push(`${at || '/'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
      return;
    }
    const keys = new Set([...Object.keys(expected), ...Object.keys(actual)]);
    for (const k of keys) {
      if (!(k in expected)) out.push(`${at}/${k}: not expected, got ${JSON.stringify(actual[k])}`);
      else if (!(k in actual)) out.push(`${at}/${k}: missing, expected ${JSON.stringify(expected[k])}`);
      else compareJson(expected[k], actual[k], `${at}/${k}`, out);
    }
    return;
  }
  if (expected !== actual) out.push(`${at || '/'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

function checkExampleRequest(c, req, url, body) {
  const want = c.request;
  const out = [];
  if (req.method !== want.method) out.push(`method: expected ${want.method}, got ${req.method}`);
  if (url.pathname !== want.path) out.push(`path: expected ${want.path}, got ${url.pathname}`);
  const query = {};
  for (const [k, v] of url.searchParams) query[k] = k in query ? [].concat(query[k], v) : v;
  // A list parameter with one value is one `key=value` on the wire, so it compares as a list of one.
  for (const [k, v] of Object.entries(want.query ?? {})) if (Array.isArray(v) && typeof query[k] === 'string') query[k] = [query[k]];
  compareJson(want.query, query, 'query', out);
  for (const [h, v] of Object.entries(want.headers)) {
    const got = req.headers[h];
    if (got === undefined) out.push(`header ${h}: missing`);
    else if (v !== '*' && got !== v) out.push(`header ${h}: expected ${v}, got ${got}`);
  }
  if (want.body !== undefined) {
    if (!(req.headers['content-type'] ?? '').startsWith('application/json')) out.push(`content-type: expected application/json, got ${req.headers['content-type']}`);
    let parsed;
    try {
      parsed = parseJson(body);
    } catch {
      out.push('body: not JSON');
    }
    if (parsed !== undefined) compareJson(want.body, parsed, 'body', out);
  } else if (body.length) {
    out.push(`body: expected none, got ${body.toString().slice(0, 200)}`);
  }
  return out;
}

async function serveExample(req, res, url, body) {
  const c = primed.case;
  primed.served = true;
  primed.mismatches = checkExampleRequest(c, req, url, body);
  const r = c.response;
  const rid = r.requestId ?? requestId();
  if (primed.mismatches.length) {
    return problem(res, rid, 400, 'EXAMPLE_REQUEST_MISMATCH', primed.mismatches.join('; '));
  }
  if (r.body?.type && r.status >= 400) return sendProblem(res, rid, r.body);
  if (r.stream && c.operation === 'WatchWorkspaceEvents') {
    const id = crypto.randomUUID();
    const events = [
      {
        id,
        type: 'conversation.created',
        data: {
          id,
          type: 'conversation.created',
          occurredAt: '2026-11-10T00:00:00.000Z',
          subject: { type: 'conversation', id: 'example' },
          actor: { type: 'person' },
          data: { id: 'example', agentId: 'GHT7YRWXPL', version: 'draft' },
        },
      },
    ];
    return streamEvents(req, res, rid, 'example', events, 0, false);
  }
  if (r.stream) {
    const id = crypto.randomUUID();
    const events = [
      { id: `${id}:1`, type: 'message.started', data: { messageId: id } },
      { id: `${id}:2`, type: 'message.completed', data: { message: { id, role: 'assistant', text: 'An example answer.', createdAt: '2026-11-10T00:00:00.000Z' } } },
    ];
    return streamEvents(req, res, rid, 'example', events, 0, false);
  }
  sendJson(res, rid, r.status, r.body, r.headers);
}

// ---------------------------------------------------------------------------
// Chat stream
// ---------------------------------------------------------------------------

function chatEvents() {
  const messageId = crypto.randomUUID();
  const ev = [
    ['message.started', { messageId, agentVersion: 'v12', phase: 'answer' }],
    ['progress.updated', { id: 'search-1', label: 'Searching', details: 'Looking in HR policies', status: 'running', section: 'kb' }],
    ['tool.started', { toolCallId: 'tc-1', toolName: 'searchKnowledgeBase', arguments: { query: 'annual leave' } }],
    ['tool.finished', { toolCallId: 'tc-1', toolName: 'searchKnowledgeBase', status: 'succeeded', result: { hits: 3 }, durationMs: 812 }],
  ];
  if (faults.unknownEvent) ev.push(['memory.saved', { memoryId: 'm-1', note: 'An event type this SDK has never heard of' }]);
  ev.push(
    ['text.delta', { delta: 'Staff receive ' }],
    ['citation.added', { citation: { number: 1, documentId: 'doc-0001', knowledgeBaseId: 'KB4T7YQ2WL', documentName: 'leave-policy.pdf', pageNumber: 3 } }],
    ['keep-alive', null],
    ['text.delta', { delta: '20 days of annual leave.' }],
  );
  if (faults.failStream) {
    ev.push([
      'message.failed',
      {
        type: 'https://build.caitlyn.ai/errors/SERVICE_UNAVAILABLE',
        title: 'Service unavailable',
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        detail: 'The model provider is briefly unavailable.',
        requestId: '01JC9Q2W7R4M0H2T6N1S8V3B80',
      },
    ]);
  } else {
    ev.push([
      'message.completed',
      {
        message: {
          id: messageId,
          role: 'assistant',
          text: 'Staff receive 20 days of annual leave.',
          agentVersion: 'v12',
          citations: [{ number: 1, documentId: 'doc-0001', knowledgeBaseId: 'KB4T7YQ2WL', documentName: 'leave-policy.pdf', pageNumber: 3 }],
          createdAt: '2026-11-09T00:00:00.000Z',
          ...(faults.unknownField ? { sentiment: 'neutral' } : {}),
        },
      },
    ]);
  }
  let n = 0;
  // Keep-alives are SSE comments (PROTOCOL.md 5.5): they carry no id and are not events.
  return ev.map(([type, data]) => (type === 'keep-alive' ? { comment: 'keep-alive' } : { id: `${messageId}:${++n}`, type, data }));
}

async function streamEvents(req, res, rid, conversationId, events, startIndex, firstStream, holdOpen = false) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...baseHeaders(rid),
  });
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      log.push({ event: 'client-disconnected', conversationId, at: Date.now() });
    }
  });
  res.write('retry: 2000\n\n');
  let sent = 0;
  for (let i = startIndex; i < events.length; i++) {
    if (closed) return;
    if (faults.streamDelayMs) await new Promise((r) => setTimeout(r, faults.streamDelayMs));
    if (closed) return;
    const e = events[i];
    if (e.comment) {
      res.write(`: ${e.comment}\n\n`);
      continue;
    }
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e.data)}\n\n`);
    sent++;
    if (firstStream && faults.dropAfterEvents != null && sent >= faults.dropAfterEvents) {
      faults.dropAfterEvents = null; // drop only once
      if (faults.dropOnSignal) {
        const until = Date.now() + 10_000;
        while (!dropSignalled && !closed && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
        dropSignalled = false;
      }
      log.push({ event: 'server-dropped-stream', conversationId, afterEventId: e.id, at: Date.now() });
      await new Promise((r) => setTimeout(r, 20));
      res.socket?.destroy();
      return;
    }
    if (firstStream && faults.endAfterEvents != null && sent >= faults.endAfterEvents) {
      faults.endAfterEvents = null;
      log.push({ event: 'server-ended-stream', conversationId, afterEventId: e.id, at: Date.now() });
      return res.end();
    }
  }
  if (holdOpen && !closed) {
    const until = Date.now() + 10_000;
    while (!closed && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    if (closed) return;
  }
  res.end();
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

const routes = [
  ['GET', /^\/v3\/knowledge-bases\/([^/]+)\/documents$/, listDocuments],
  ['POST', /^\/v3\/conversations\/([^/]+)\/send$/, sendMessage],
  ['GET', /^\/v3\/conversations\/([^/]+)\/stream$/, watchConversation],
  ['GET', /^\/v3\/events\/stream$/, watchWorkspaceEvents],
  ['POST', /^\/v3\/uploads$/, createUpload],
  ['GET', /^\/v3\/uploads\/([^/]+)$/, getUpload],
  ['PUT', /^\/__s3\/([^/]+)$/, putUploadBytes],
  ['POST', /^\/v3\/knowledge-bases\/([^/]+)\/documents$/, createDocument],
  ['GET', /^\/v3\/knowledge-bases\/([^/]+)\/documents\/([^/]+)$/, getDocument],
  ['DELETE', /^\/v3\/knowledge-bases\/([^/]+)\/documents\/([^/]+)$/, deleteDocument],
  ['POST', /^\/v3\/knowledge-bases\/([^/]+)\/documents:batch-delete$/, batchDeleteDocuments],
  ['GET', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)$/, getAgentVersion],
  ['PATCH', /^\/v3\/agents\/([^/]+)\/versions\/draft$/, updateDraft],
];

// FolderPath (the model's pattern): a folder starts and ends in `/`; the root is `/`.
const FOLDER_PATH = /^\/([^/]+\/)*$/;
const FOLDER_DETAIL = 'Expected a folder path in a knowledge base, starting and ending in `/`, for example `/hr/leave/`. The root is `/`.';
// The file types a knowledge base ingests, as the server's list has them: PDF, images, audio, video, Markdown and Word.
const INGESTIBLE = new Set(['pdf', 'png', 'jpeg', 'jpg', 'gif', 'flac', 'ogg', 'mp3', 'm4a', 'mp4', 'webm', 'md', 'markdown', 'docx']);

const LIST_PARAMS = ['limit', 'cursor', 'sort', 'filter[status][eq]', 'filter[folder][eq]', 'filter[name][startsWith]'];

// GetDocument: a document in the knowledge base, 404 otherwise. With the documentStatus fault, the status moves on
// with each read.
async function getDocument(req, res, rid, [kb, documentId]) {
  if (statusFault('GetDocument', res, rid)) return;
  const docs = state.knowledgeBases.get(decodeURIComponent(kb));
  const id = decodeURIComponent(documentId);
  const doc = docs?.find((d) => d.id === id);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${id}`);
  const left = readsBeforeGone.get(doc);
  if (left !== undefined) readsBeforeGone.set(doc, left - 1);
  if (left !== undefined && left <= 0) {
    docs.splice(docs.indexOf(doc), 1);
    return problem(res, rid, 404, 'NOT_FOUND', `No document ${id}`);
  }
  const statuses = faults.documentStatus?.[id];
  const body = { ...doc };
  if (Array.isArray(statuses) && statuses.length) {
    body.status = statuses.length > 1 ? statuses.shift() : statuses[0];
  }
  sendJson(res, rid, 200, body);
}

// A deleted document's GetDocument reads left before it is gone, kept off the document so no response shows it.
const readsBeforeGone = new WeakMap();

// Marks a document `deleting`; GetDocument finds it gone after faults.deletingReads more reads.
function markDeleting(doc) {
  if (doc.status !== 'deleting') {
    doc.status = 'deleting';
    doc.updatedAt = new Date().toISOString();
    readsBeforeGone.set(doc, faults.deletingReads ?? 1);
  }
}

// DeleteDocument: 202 with the document `deleting` (again while it still is); 404 once it is gone.
async function deleteDocument(req, res, rid, [kb, documentId]) {
  if (statusFault('DeleteDocument', res, rid)) return;
  const docs = state.knowledgeBases.get(decodeURIComponent(kb));
  const id = decodeURIComponent(documentId);
  const doc = docs?.find((d) => d.id === id);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${id}`);
  markDeleting(doc);
  sendJson(res, rid, 202, doc);
}

// BatchDeleteDocuments: 1 to 100 distinct identifiers, one result each in request order; 200 even when all fail.
async function batchDeleteDocuments(req, res, rid, [kb], url, body) {
  if (statusFault('BatchDeleteDocuments', res, rid)) return;
  const ids = parseJson(body)?.documentIds;
  const docs = state.knowledgeBases.get(decodeURIComponent(kb));
  if (!docs) return problem(res, rid, 404, 'NOT_FOUND', `No knowledge base ${kb}`);
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', 'documentIds must hold 1 to 100 identifiers, each at most once', {
      fieldErrors: [{ field: 'documentIds', code: 'VALIDATION_FAILED' }],
    });
  }
  const results = ids.map((id) => {
    const doc = docs.find((d) => d.id === id);
    if (!doc) return { documentId: id, status: 'failed', code: 'NOT_FOUND', detail: `No document ${id}` };
    markDeleting(doc);
    return { documentId: id, status: 'accepted' };
  });
  sendJson(res, rid, 200, { results });
}

async function listDocuments(req, res, rid, [kb], url) {
  if (statusFault('ListDocuments', res, rid)) return;
  const docs = state.knowledgeBases.get(decodeURIComponent(kb));
  if (!docs) return problem(res, rid, 404, 'NOT_FOUND', `No knowledge base ${kb}`);
  for (const key of url.searchParams.keys()) {
    if (!LIST_PARAMS.includes(key)) return problem(res, rid, 400, 'UNKNOWN_FILTER', `Unknown query parameter ${key}`, { fieldErrors: [{ parameter: key, code: 'UNKNOWN_FILTER' }] });
  }
  const folder = url.searchParams.get('filter[folder][eq]');
  if (folder !== null && !FOLDER_PATH.test(folder)) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', FOLDER_DETAIL, { fieldErrors: [{ parameter: 'filter[folder][eq]', code: 'VALIDATION_FAILED' }] });
  }
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 20), 100);
  const cursor = url.searchParams.get('cursor');
  const status = url.searchParams.get('filter[status][eq]');
  let start = 0;
  if (cursor) {
    try {
      start = JSON.parse(Buffer.from(cursor, 'base64url').toString()).offset;
    } catch {
      return problem(res, rid, 400, 'INVALID_CURSOR', 'The cursor could not be read', { fieldErrors: [{ parameter: 'cursor', code: 'INVALID_CURSOR' }] });
    }
  }
  let items = docs.map((d, i) => {
    const doc = { ...d };
    if (faults.unknownEnum && i === 1) doc.status = 'archived';
    if (faults.unknownField) doc.retentionPolicy = { keepDays: 365 };
    return doc;
  });
  if (status) items = items.filter((d) => d.status === status);
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(JSON.stringify({ offset: start + limit })).toString('base64url') : undefined;
  sendJson(res, rid, 200, { items: page, ...(next ? { nextCursor: next } : {}) });
}

async function sendMessage(req, res, rid, [conversationId], url, body) {
  if (statusFault('SendMessage', res, rid)) return;
  const input = parseJson(body);
  if (!input.message) return problem(res, rid, 400, 'VALIDATION_FAILED', 'message is required', { fieldErrors: [{ pointer: '/message', code: 'VALIDATION_FAILED', detail: 'Required' }] });
  const events = chatEvents();
  state.conversations.set(decodeURIComponent(conversationId), events);
  await streamEvents(req, res, rid, conversationId, events, 0, true);
}

// WatchConversation, as the real server behaves: open-ended (it stays open after an answer, for the next one, until
// the caller closes it), and a Last-Event-ID it cannot carry on from is answered with stream.reset (PROTOCOL.md 5.11):
// one naming an answer that has ended, or, with finishWhileAway, any event of the answer. After the reset comes the
// next answer. A Last-Event-ID naming no event of the answer (a reset's own cursor) is "from now": nothing yet.
async function watchConversation(req, res, rid, [conversationId]) {
  if (statusFault('WatchConversation', res, rid)) return;
  const id = decodeURIComponent(conversationId);
  const events = state.conversations.get(id);
  if (!events) return problem(res, rid, 404, 'NOT_FOUND', `No conversation ${conversationId}`);
  const last = req.headers['last-event-id'];
  const at = last ? events.findIndex((e) => e.id === last) : -1;
  const finalId = [...events].reverse().find((e) => e.id)?.id;
  if (last && at >= 0 && (last === finalId || faults.finishWhileAway)) {
    const cursor = `reset-${crypto.randomUUID()}`;
    const next = chatEvents();
    state.conversations.set(id, next);
    return streamEvents(req, res, rid, conversationId, [{ id: cursor, type: 'stream.reset', data: { cursor } }, ...next], 0, false, true);
  }
  if (last && at < 0) return streamEvents(req, res, rid, conversationId, [], 0, false, true);
  // After a failed answer the watch carries on (PROTOCOL.md 5.5): the next answer follows.
  if (events.at(-1)?.type === 'message.failed') {
    const failStream = faults.failStream;
    faults.failStream = false;
    events.push(...chatEvents());
    faults.failStream = failStream;
  }
  await watchResponse(req, res, rid, conversationId, events.slice(at + 1), events);
}

/**
 * A watch response: with watchEmptyCloses, closes cleanly at once; with watchReplayCloses, sends the event
 * Last-Event-ID names again (or the first) and closes; with watchCloses, closes cleanly after one event; else
 * sends them all and stays open. `all` is the whole list the cursor indexes into.
 */
async function watchResponse(req, res, rid, subject, events, all = events) {
  if (faults.watchEmptyCloses > 0) {
    faults.watchEmptyCloses--;
    log.push({ event: 'server-closed-watch', subject, at: Date.now() });
    return streamEvents(req, res, rid, subject, [], 0, false, false);
  }
  if (faults.watchReplayCloses > 0) {
    faults.watchReplayCloses--;
    const named = all.find((e) => e.id && e.id === req.headers['last-event-id']);
    log.push({ event: 'server-closed-watch', subject, at: Date.now() });
    return streamEvents(req, res, rid, subject, [named ?? all.find((e) => e.id)], 0, false, false);
  }
  if (faults.watchCloses > 0) {
    faults.watchCloses--;
    const sent = [];
    for (const e of events) {
      sent.push(e);
      if (sent.filter((x) => !x.comment).length === 1) break;
    }
    log.push({ event: 'server-closed-watch', subject, at: Date.now() });
    return streamEvents(req, res, rid, subject, sent, 0, false, false);
  }
  return streamEvents(req, res, rid, subject, events, 0, false, true);
}

// WatchWorkspaceEvents. A cursor the server cannot carry on from (STALE_CURSOR) is answered with stream.reset
// and a new cursor, then the events after it (PROTOCOL.md 5.11). The stream then ends cleanly.
const STALE_CURSOR = '0190d2a1-0000-7000-8000-000000000001';
const RESET_CURSOR = '0193a6f3-0a1b-7c2d-8e3f-000000000010';

async function watchWorkspaceEvents(req, res, rid, _m, url) {
  if (statusFault('WatchWorkspaceEvents', res, rid)) return;
  // Last-Event-ID wins over after, as on the real server.
  const cursor = req.headers['last-event-id'] ?? url.searchParams.get('after');
  const all = [];
  if (cursor === STALE_CURSOR) all.push({ id: RESET_CURSOR, type: 'stream.reset', data: { cursor: RESET_CURSOR } });
  for (const [n, type] of [
    [11, 'conversation.created'],
    [12, 'conversation.created'],
    [13, 'conversation.created'],
  ]) {
    const id = `0193a6f3-0a1b-7c2d-8e3f-0000000000${n}`;
    all.push({
      id,
      type,
      data: {
        id,
        type,
        occurredAt: '2026-11-13T01:02:03.000Z',
        subject: { type: 'conversation', id: `c-${n}` },
        actor: { type: 'person', userId: '3c9e2f4a-6b1d-4e8f-a2c7-5d0b9e1f3a64' },
        data: { id: `c-${n}`, agentId: 'GHT7YRWXPL', version: 'draft' },
      },
    });
  }
  // Carry on after the cursor when it names one of these events.
  const at = all.findIndex((e) => e.id === cursor);
  await watchResponse(req, res, rid, 'workspace', all.slice(at + 1), all);
}

async function createUpload(req, res, rid, _m, url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateUpload', res, rid)) return;
  const input = parseJson(body);
  const result = idempotent(key, 'CreateUpload', () => {
    const missing = ['fileName', 'contentType', 'byteSize', 'sha256'].filter((f) => input[f] == null);
    if (missing.length) return { status: 400, problem: ['VALIDATION_FAILED', 'Required members are missing', { fieldErrors: missing.map((f) => ({ pointer: `/${f}`, code: 'VALIDATION_FAILED', detail: 'Required' })) }] };
    const id = crypto.randomUUID();
    const upload = {
      id,
      uploadUrl: `http://${req.headers.host}/__s3/${id}?X-Amz-Signature=mock`,
      uploadMethod: 'PUT',
      requiredHeaders: { 'content-type': input.contentType, 'x-amz-checksum-sha256': input.sha256 },
      expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      status: 'awaiting_bytes',
    };
    state.uploads.set(id, { ...upload, input });
    return { status: 201, body: upload };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { Location: `/api/v3/uploads/${result.body.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

// GetUpload: the upload's status and when its upload URL expires; 404 for one never reserved.
async function getUpload(req, res, rid, [id]) {
  if (statusFault('GetUpload', res, rid)) return;
  const up = state.uploads.get(decodeURIComponent(id));
  if (!up) return problem(res, rid, 404, 'NOT_FOUND', `No upload ${id}`);
  sendJson(res, rid, 200, { id: up.id, status: up.status, expiresAt: up.expiresAt });
}

async function putUploadBytes(req, res, rid, [id], url, body) {
  const up = state.uploads.get(id);
  if (!up) {
    res.writeHead(404, { 'Content-Type': 'application/xml' });
    return res.end('<Error><Code>NoSuchUpload</Code></Error>');
  }
  const sha = crypto.createHash('sha256').update(body).digest('base64');
  const headerSha = req.headers['x-amz-checksum-sha256'];
  if (headerSha !== up.input.sha256 || sha !== up.input.sha256 || body.length !== Number(up.input.byteSize)) {
    res.writeHead(400, { 'Content-Type': 'application/xml' });
    return res.end('<Error><Code>BadDigest</Code></Error>');
  }
  up.status = 'received';
  res.writeHead(200, { ETag: `"${sha}"` });
  res.end();
}

async function createDocument(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateDocument', res, rid)) return;
  const input = parseJson(body);
  const docs = state.knowledgeBases.get(decodeURIComponent(kb));
  if (!docs) return problem(res, rid, 404, 'NOT_FOUND', `No knowledge base ${kb}`);
  if (input?.folder !== undefined && !FOLDER_PATH.test(input.folder)) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', FOLDER_DETAIL, { fieldErrors: [{ field: 'folder', code: 'VALIDATION_FAILED' }] });
  }
  const named = input?.name ?? state.uploads.get(input?.uploadId)?.input?.fileName ?? '';
  const extension = named.includes('.') ? named.split('.').pop().toLowerCase() : '';
  if (extension && !INGESTIBLE.has(extension)) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', `A knowledge base cannot ingest .${extension} files.`, { fieldErrors: [{ field: 'name', code: 'VALIDATION_FAILED' }] });
  }
  const result = idempotent(key, `CreateDocument:${kb}`, () => {
    const up = state.uploads.get(input.uploadId);
    if (!up) return { status: 404, problem: ['NOT_FOUND', `No upload ${input.uploadId}`] };
    if (up.status === 'awaiting_bytes') return { status: 409, problem: ['CONFLICT', `Upload ${up.id} has no bytes yet. Send the file to its uploadUrl first.`] };
    if (up.status === 'consumed') return { status: 409, problem: ['CONFLICT', `Upload ${up.id} has already been used. Reserve a new upload.`] };
    up.status = 'consumed';
    const now = new Date().toISOString();
    const doc = {
      id: `doc-${crypto.randomUUID().slice(0, 8)}`,
      knowledgeBaseId: kb,
      name: input.name ?? up.input.fileName,
      folder: input.folder,
      status: 'pending',
      contentType: up.input.contentType,
      byteSize: up.input.byteSize,
      sha256: up.input.sha256,
      createdAt: now,
      updatedAt: now,
    };
    docs.push(doc);
    const operation = { id: crypto.randomUUID(), kind: 'document_ingestion', status: 'queued', createdAt: now };
    return { status: 202, body: { document: doc, operation } };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, {
    Location: `/api/v3/operations/${result.body.operation.id}`,
    ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

function versionBody(agent) {
  const v = structuredClone(agent.version);
  if (faults.unknownEnum) v.source = 'cloned_from_template';
  if (faults.unknownField) {
    v.reviewState = { required: false };
    v.configuration.knowledgeBases[0].reranker = 'cohere';
  }
  return v;
}

const etagOf = (agent) => `"draft-${agent.etagN}"`;

async function getAgentVersion(req, res, rid, [agentId, version]) {
  if (statusFault('GetAgentVersion', res, rid)) return;
  const agent = state.agents.get(agentId);
  if (!agent) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${agentId}`);
  if (version !== 'draft') return problem(res, rid, 404, 'NOT_FOUND', `Agent ${agentId} has no version ${version}.`);
  sendJson(res, rid, 200, versionBody(agent), { ETag: etagOf(agent) });
}

function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
}

const DRAFT_FIELDS = ['identity', 'instructions', 'model', 'knowledgeBases', 'attachments', 'contentSafety', 'deniedDocuments'];
const CLEARABLE = ['identity'];

async function updateDraft(req, res, rid, [agentId], url, body) {
  if (statusFault('UpdateDraftVersion', res, rid)) return;
  const agent = state.agents.get(agentId);
  if (!agent) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${agentId}`);
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) return problem(res, rid, 428, 'PRECONDITION_REQUIRED', 'Send the ETag you last read in If-Match.');
  if (ifMatch !== etagOf(agent))
    return problem(res, rid, 412, 'PRECONDITION_FAILED', `The draft of agent ${agentId} changed since you read it. Read it again and reapply your change.`);
  const { clear = [], ...patch } = parseJson(body);
  const fieldErrors = [];
  for (const k of Object.keys(patch)) if (!DRAFT_FIELDS.includes(k)) fieldErrors.push({ pointer: `/${k}`, code: 'UNKNOWN_FIELD' });
  clear.forEach((k, i) => {
    // PROTOCOL.md 8: both problems are VALIDATION_FAILED, with the field in `errors`.
    if (!CLEARABLE.includes(k)) fieldErrors.push({ pointer: `/clear/${i}`, code: 'VALIDATION_FAILED', detail: `${k} cannot be cleared` });
    else if (k in patch) fieldErrors.push({ pointer: `/${k}`, code: 'VALIDATION_FAILED', detail: `${k} is both set and cleared` });
  });
  if (fieldErrors.length) {
    const code = fieldErrors.every((e) => e.code === 'UNKNOWN_FIELD') ? 'UNKNOWN_FIELD' : 'VALIDATION_FAILED';
    return problem(res, rid, 400, code, 'The update is not valid', { fieldErrors });
  }
  merge(agent.version.configuration, patch);
  for (const k of clear) delete agent.version.configuration[k];
  agent.etagN++;
  sendJson(res, rid, 200, versionBody(agent), { ETag: etagOf(agent) });
}

// ---------------------------------------------------------------------------

const LOGGED_HEADERS = ['authorization', 'cookie', 'origin', 'idempotency-key', 'if-match', 'last-event-id', 'accept', 'content-type', 'user-agent', 'traceparent', 'caitlyn-sdk-model', 'caitlyn-api-version'];

// MOCK_CORS=1 (the browser conformance run, whose page is on another origin): every response allows the page's
// origin and exposes the headers the SDK reads, and CORS preflights are answered here, not logged, and never
// consume a fault. The headers listed are what a browser needs from the real server too.
const CORS = process.env.MOCK_CORS === '1';
const EXPOSED = 'Caitlyn-Request-Id, Caitlyn-Api-Version, ETag, Location, Retry-After, Idempotent-Replayed';

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const rid = requestId();
  if (CORS && req.headers.origin) {
    res.setHeader('Access-Control-Allow-Origin', req.headers.origin);
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, PATCH, DELETE',
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] ?? '',
        'Access-Control-Max-Age': '600',
      });
      return res.end();
    }
    res.setHeader('Access-Control-Expose-Headers', EXPOSED);
  }
  try {
    if (url.pathname === '/__mock/reset' && req.method === 'POST') {
      reset();
      resetAuth();
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/__mock/drop' && req.method === 'POST') {
      dropSignalled = true;
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/__mock/faults' && req.method === 'POST') {
      const { auth, ...patch } = parseJson(await readBody(req));
      if (auth) authFaults(auth);
      faults = { ...faults, ...patch, status: { ...faults.status, ...(patch.status ?? {}) } };
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/__mock/requests' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(log));
    }
    if (url.pathname === '/__mock/example' && req.method === 'POST') {
      const { id } = parseJson(await readBody(req));
      const c = EXAMPLES.find((e) => e.id === id);
      if (!c) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: `No example case ${JSON.stringify(id)}` }));
      }
      primed = { case: c, served: false, mismatches: [] };
      res.writeHead(204);
      return res.end();
    }
    if (url.pathname === '/__mock/example' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(primed ? { id: primed.case.id, served: primed.served, mismatches: primed.mismatches } : null));
    }
    const body = await readBody(req);
    const entry = { headerNames: Object.keys(req.headers), method: req.method, path: url.pathname, query: url.search, headers: {}, body: body.length && body.length < 10_000 ? body.toString() : undefined, at: Date.now(), requestId: rid };
    for (const h of LOGGED_HEADERS) if (req.headers[h] != null) entry.headers[h] = req.headers[h];
    log.push(entry);
    if (await handleAuth(req, res, url, body)) return;
    if (url.pathname.startsWith('/v3/') && !authorised(req)) {
      const delay = refusalDelayMs();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return problem(res, rid, 401, 'UNAUTHENTICATED', 'The bearer token is missing, expired or not valid for this workspace');
    }
    if (primed && !primed.served && !url.pathname.startsWith('/__s3/')) return await serveExample(req, res, url, body);
    for (const [method, re, handler] of routes) {
      if (req.method !== method) continue;
      const m = url.pathname.match(re);
      if (m) return await handler(req, res, rid, m.slice(1), url, body);
    }
    problem(res, rid, 404, 'NOT_FOUND', `No route ${req.method} ${url.pathname}`);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) problem(res, rid, 500, 'INTERNAL', String(err));
  }
});

const port = Number(process.env.PORT ?? 4010);
server.listen(port, '127.0.0.1', () => console.log(`mock Caitlyn v3 listening on http://127.0.0.1:${port}`));
