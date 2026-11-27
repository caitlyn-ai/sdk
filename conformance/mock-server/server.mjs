// Mock Caitlyn v3 server for the SDK conformance suites.
//
// Serves the model's operations (model/model.json) with in-memory state, as model/PROTOCOL.md
// describes the wire: RFC 9457 problem details with build.caitlyn.ai error types, Caitlyn-Request-Id
// and Caitlyn-Api-Version on every response, server-sent events with ids and keep-alive comments.
//
// Fault injection and inspection live under /__mock/:
//   POST /__mock/reset              clear state, faults, the request log and any primed example
//   POST /__mock/faults             merge a fault configuration (see DEFAULT_FAULTS)
//   GET  /__mock/requests           the request log (method, path, selected headers, body, and the status once answered)
//   POST /__mock/drop               cut the stream that dropOnSignal is holding (see DEFAULT_FAULTS)
//   POST /__mock/example            prime the next request with an example case from
//                                   conformance/cases/examples.json: {"id": "<case id>"}
//   GET  /__mock/example            the primed case's result: {"id", "served", "mismatches": [...]}
//   GET  /__mock/auth               sign-in counters (auth.mjs, which also serves /oauth/* and the STS
//                                   stand-in at /__sts/; fault key `auth`)
//   GET  /__mock/uploads            the S3 stand-in's state: {maxInFlight (the most form POSTs held at once),
//                                   objects: [{key, sha256, byteSize, contentType}]}
//
// S3 stand-ins, outside /v3/ and unauthenticated as presigned requests are: PUT /__s3/<uploadId> takes the bytes of
// an upload (CreateUpload's uploadUrl), and POST /__s3/ takes an ingestion batch's form uploads (its upload
// policy's uploadUrl). Each request log entry has `bodySha256` (standard base64) and `bodyLength`, and a form POST
// also `form`: its parts in order, [{name, value} or {name, fileName, contentType, byteSize, sha256}].
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

// The version the mock reports: 5.120.0, or the model's release when that is later. The model's release is the lock's
// stampNext for a model built from an app branch (scripts/model-pull.sh --prerelease, as model:main pulls one, stamps
// "next" as that branch's app version), and the lock's version for a published model (every @since in it is that
// release or earlier). The SDKs refuse an operation a server too old for it would not have; the mock answers as the
// server of the model's release.
const later = (a, b) => {
  const [x, y] = [a, b].map((v) => v.split('.').map(Number));
  const i = x.findIndex((n, k) => n !== y[k]);
  return i >= 0 && y[i] > x[i] ? b : a;
};
// MOCK_MODEL_LOCK names another lock file (scripts/mock-version.test.mjs).
const modelLock = JSON.parse(fs.readFileSync(process.env.MOCK_MODEL_LOCK ?? path.join(import.meta.dirname, '../../model/model.lock.json'), 'utf8'));
const modelRelease = modelLock.stampNext || modelLock.version;
const API_VERSION_DEFAULT = modelRelease ? later('5.120.0', modelRelease) : '5.120.0';
const EXAMPLES = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '../cases/examples.json'), 'utf8')).cases;

const DEFAULT_FAULTS = {
  // Per operation, a queue of status faults served before the real response: [{status: 429, retryAfter: 1}].
  // A fault with `body` (a string) or `contentType` is served as that raw body instead of a problem, with no
  // Caitlyn-Request-Id or Caitlyn-Api-Version, as a proxy or a web framework's own error page would be. A fault
  // with `close: true` closes the connection without any response, as a failed TLS handshake or a reset would.
  // A fault with `hold: true` answers nothing and keeps the connection open, at most `holdMs` (default 30 s), as a
  // server that never answers does (client.request-timeout); a client that gives up and closes it is logged as
  // {event: 'request-aborted', op}. The S3 stand-ins take `hold` too, under `PutUpload` and `PostObject`.
  status: {},
  // `If-Match: *` ("any version", PROTOCOL.md 8) is answered 400 IF_MATCH_WILDCARD_NOT_ASKED unless this is true: no
  // SDK helper may send it on its own, so every case that does not ask for it guards that (if-match.never-wildcard).
  // With it, `*` matches whatever version the resource has.
  allowIfMatchWildcard: false,
  // Send an SSE keep-alive comment on WatchKnowledgeBase this often (ms), between its events; 0 sends none.
  watchKeepAliveMs: 0,
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
  // After this many events of an answer, the stream is held open (sending nothing) until the client leaves, at most
  // 10 s: a case that leaves a send() stream part way then knows the server was still sending (send.break-then-final).
  holdAfterEvents: null,
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

  // ---- Files and uploads (PROTOCOL.md 14 and 15). The S3 stand-ins (PUT /__s3/<uploadId> and the form POST to
  // /__s3/) take their status faults from `status` too, under the names `PutUpload` and `PostObject`, served as S3
  // serves errors (XML, no Caitlyn headers): [{status: 503, retryAfter: 0}].
  // Hold CreateUpload this long before answering, so a harness can change a file between hashing and sending
  // (files.changed) or look at the spool file while the call is under way (files.spool). The request is in the log
  // (GET /__mock/requests) as soon as it arrives, before the pause.
  reserveDelayMs: 0,
  // GetDocumentVersion's status over successive reads, per version: { "<documentId>:<number>": ["processing",
  // "indexed"] }; each read takes the next and the last repeats. Without it, a new version moves one step per read:
  // pending, processing, indexed (a version made indexed becomes the document's current one).
  versionStatus: {},
  // Ingestion batches. GetIngestionBatch reads that still find a batch `planning` before its plan is made.
  planningReads: 0,
  // GetIngestionBatch reads that still find an item `ingesting` after CompleteIngestionBatchUploads accepted it;
  // then it is `indexed`, and once no item is left to finish the batch is `succeeded` (or
  // `completed_with_failures` when one failed).
  ingestReads: 1,
  // The plan for particular items, by the item's path (or id): { "/hr/a.pdf": "duplicate_path" } makes the item a
  // `conflict` with that reason, resolved by the batch's policy (`ask`, the default, leaves it `unresolved`).
  planConflicts: {},
  // How long the policy StartIngestionBatch returns lasts, in seconds; renewals (CreateIngestionBatchUploadPolicy)
  // last renewedPolicySeconds: a batch's first one only, later renewals 1800. Under 300 makes the SDK renew before
  // its first upload (PROTOCOL.md 15).
  policySeconds: 1800,
  renewedPolicySeconds: 1800,
  // How long an Upload (CreateUpload) lasts unused, in seconds; then GetUpload reads it `expired`, and a document
  // made from it is refused with 409 CONFLICT.
  uploadSeconds: 900,
  // Caller-set windows (uploadWindowSeconds, expiresInSeconds) under the server's 60-second least, down to 1 second:
  // test mode, so a deadline runs out in seconds.
  shortWindows: false,
  // The form endpoint answers every upload signed with the policy Start returned with 403 "Policy expired", as S3
  // does when the policy's expiry has passed by its clock (a client whose clock is behind). A renewed policy works.
  startPolicyExpired: false,
  // The first policy CreateIngestionBatchUploadPolicy gives a batch is one storage says has expired (a 403), as
  // startPolicyExpired does for Start's: for batch.upload, which asks for its own policy (batch-upload.policy-renewal).
  firstCreatedPolicyExpired: false,
  // Hold each form POST this long before storing it, so uploads overlap (ingest.concurrency) and can be cancelled
  // in flight (ingest.cancel). A client that disconnects meanwhile stores nothing (`upload-aborted` in the log).
  uploadDelayMs: 0,
  // Answer this many form POSTs as usual, then hold each later one (no answer) until the client disconnects, which
  // logs `upload-aborted` and stores nothing, or 10 s pass, when it carries on as usual. A case that cancels a sync
  // then knows every upload past the first n is still in flight when the cancel lands (sync.cancel). null holds none.
  holdUploadsAfter: null,
  // With holdUploadsAfter, a held upload is let go (and stored as usual) once this many upload policies have been asked
  // for (CreateIngestionBatchUploadPolicy), instead of when the client lets go of it: a keep-alive case then knows the
  // renewals it counts all happened while the upload was in flight, however slowly the runner fires the timer. Held at
  // most 30 s. null holds until the client lets go.
  releaseUploadsAfterPolicies: null,
  // Every policy CreateIngestionBatchUploadPolicy gives (not Start's) carries this as its `expiresAt` instead of a
  // timestamp: a string ('not a date'), or null to leave the member out (batch-upload.unreadable-expiry). The policy
  // still works. undefined for the usual mock.
  policyExpiresAt: undefined,
  // The form endpoint reads each upload's body at most this many bytes a second, so a large file arrives slowly but
  // steadily (files.slow-not-stalled). 0 reads it at once.
  uploadReadBytesPerSecond: 0,
  // Upload reservations on a compressed clock (batch-upload.keep-alive): { policySeconds: 2, reservationSeconds: 2 }.
  // Every upload policy (Start's and each renewal's) expires policySeconds after it is issued, so an SDK's renewal
  // margin (half a short policy's life) falls due 1 second after each issue; the batch's uploadsExpireAt is the latest issue plus
  // reservationSeconds; and CompleteIngestionBatchUploads fails an item UPLOAD_EXPIRED when its object was stored
  // after the uploadsExpireAt in force at that moment. false for the usual mock.
  uploadReservation: false,
  // CompleteIngestionBatchUploads fails an item with CHECKSUM_MISMATCH (deleting its object) this many times, by the
  // item's path (or id): { "/hr/a.pdf": 1 }. The item stays `awaiting_upload`, to be uploaded again.
  checksumMismatch: {},
  // Hold each CompleteIngestionBatchUploads this long before answering, so uploads that finish meanwhile wait for
  // the next call (ingest.complete-groups: a call names at most 100).
  completeDelayMs: 0,
  // The form endpoint fails every upload of these items, by path (or id), with 500 InternalError: { "/hr/a.pdf": true }.
  // Such an item is never reported complete, so, as the server's sweep does once the policy has expired, the next
  // GetIngestionBatch read after the other items are final fails it with UPLOAD_EXPIRED and the batch can end.
  failUploads: {},
  // Planning ends the batch `failed`, as a policy rule of `fail` matching an item does.
  planFails: false,

  // ---- Jobs and the knowledge base's watch (PROTOCOL.md 16). A job (an Operation) moves on one step each time a
  // watch that sees it looks (every `watchTickMs`): queued, then running for `jobSteps` steps, then its final status.
  jobSteps: 2,
  // How a job ends, by its target's id (a document's id, a folder's path, a knowledge base's id) or by its kind
  // (`fill_in`, `reprocess`, …): `succeeded` (the default), `completed_with_failures`, `failed` or `cancelled`.
  jobOutcomes: {},
  // The error a `failed` job carries: {code, detail}. CONTENT_REJECTED is a 422 (UnprocessableContentError).
  jobError: { code: 'CONTENT_REJECTED', detail: 'The file could not be read as a PDF.' },
  // The pause between a watch's looks.
  watchTickMs: 10,
  // Cut this many WatchKnowledgeBase connections (no clean end: the socket is destroyed), each after this many
  // events, the snapshot included: {count, afterEvents}. The next connection starts with a new snapshot.
  watchDrops: { count: 0, afterEvents: 1 },
  // Start a running job on this document when a watch of it connects, so the watch has something to report.
  // { "<documentId>": true }
  busyDocuments: {},
  // CancelDocumentProcessing stops the document's running work, in place of its 409 "not available yet": each job on
  // it ends cancelled (a stopped version fails with failure.code cancelled), and the call answers 202 with the
  // document as it then stands (wait.cancel-returns).
  cancellableProcessing: false,
  // Jobs on these documents start running and stay running, whatever watches look meanwhile, until something ends
  // them (CancelDocumentProcessing). A case that cancels a running job then knows it is still running when the cancel
  // lands, even while a watch it has left stays connected (a browser slow to close an aborted stream). { "<documentId>": true }
  holdJobs: {},
  // A document that reads `processing` with no job listed on it, for this many looks of a watch, then `indexed`
  // (PROTOCOL.md 16: a busy status is busy even with no job). { "<documentId>": 3 }
  busyWithoutJob: {},
  // A single read sends a thing's ETag in the header only, not as its `etag` member: the SDK fills the member from it.
  etagHeaderOnly: false,
  // After a watchDrops cut, the next WatchKnowledgeBase connection is answered 404, as for a thing gone meanwhile.
  watchGoneAfterDrop: false,
  // A batch's upload deadline passes with nothing to end it but a read, as the v3 server works without its background
  // sweep (PROTOCOL.md 16): 'uploads' starts a batch whose `uploadsExpireAt` is a minute gone. The batch's watch then
  // sends no snapshot that shows it ending, and neither does anything else but GetIngestionBatch, which ends it: each
  // item still awaiting upload fails with UPLOAD_EXPIRED and the rest finish. false for the usual mock.
  deadlinePassed: false,
  // A path the server adds to every new batch as an item to ingest, beside the caller's: a sync then finds the batch
  // awaiting a file it has none for (errors.item-has-no-file). '/hr/stray.pdf', or false.
  strayItem: false,
  // Items, by path (or id), that end `cancelled` instead of indexed: their document was deleted while they were being
  // ingested. { "/hr/a.pdf": true }
  cancelItems: {},
  // Unattended runs. How a new run ends: { status: 'succeeded' } (default), or { status: 'failed', failure: {code,
  // detail, phase} }, { status: 'interrupted' }. `endedAtCreate: true` makes the run final before anyone watches it
  // (unattended.wait-ended-before-watch). A run moves on only as its watch sends its events, so a get() shows the run
  // as far as a watch has seen it.
  unattendedRun: { status: 'succeeded' },
  // CreateUnattendedRun's refusals, served once each: [{status: 403, code: 'RUN_AS_REQUIRED'}].
  unattendedStartErrors: [],
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
// A document's versions, oldest first, kept off the document so no response shows them: [{number, status,
// contentType, byteSize, sha256, note, createdAt}]. The document's own fields describe its current version.
const versionsOf = new WeakMap();

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
    // A conversation's own record (GetConversation, ListConversations), by id: {id, agentId, version, title, status,
    // createdAt}; its answers' events stay in `conversations`.
    conversationRecords: new Map(),
    // Unattended runs by id: {run, events, sent, request}. `events` is the run's whole stream (ids `<runId>:<n>`),
    // `sent` how many of them a watch has sent: the run's status follows it.
    unattendedRuns: new Map(),
    // Each knowledge base's own record (name, status, access, folders, fields), by id; its documents are in
    // `knowledgeBases`. See "Knowledge bases, folders, access and fields" below.
    kbs: new Map([['KB4T7YQ2WL', kbRecord('KB4T7YQ2WL', 'HR policies')]]),
    // Jobs (the building blocks' Operations), by id, in the order they were started. See "Jobs and the knowledge
    // base's watch" below.
    jobs: new Map(),
    agents: new Map([
      [
        'GHT7YRWXPL',
        {
          etagN: 1,
          agentEtagN: 1,
          agent: { id: 'GHT7YRWXPL', name: 'HR assistant', createdAt: '2026-11-03T22:14:05.120Z' },
          version: {
            agentId: 'GHT7YRWXPL',
            name: 'draft',
            matchesLive: false,
            createdAt: '2026-11-03T22:14:05.120Z',
            configuration: {
              guidance: { identity: 'You are the HR assistant.', instructions: 'Answer from the HR policies.' },
              models: { answer: { model: 'claude-sonnet-5-5' } },
              knowledgeBases: [{ knowledgeBaseId: 'KB4T7YQ2WL', numberOfResults: 6, minimumScore: 0.3 }],
              attachments: { enabled: true, maxFiles: 5 },
              contentSafety: { guardrail: 'default' },
              deniedDocuments: false,
            },
          },
        },
      ],
    ]),
    // Ingestion batches by id (see "Ingestion batches" below), and the objects form POSTs stored, by key.
    batches: new Map(),
    objects: new Map(),
    // Form POSTs in flight now, and the most there have been at once (GET /__mock/uploads).
    uploadsInFlight: 0,
    uploadsArrived: 0,
    policiesAsked: 0,
    maxUploadsInFlight: 0,
  };
}
reset();

function makeDocuments(kb, n) {
  const docs = [];
  for (let i = 1; i <= n; i++) {
    const doc = {
      id: `doc-${String(i).padStart(4, '0')}`,
      knowledgeBaseId: kb,
      name: `policy-${i}.pdf`,
      folder: '/policies/',
      status: i === 3 ? 'partially_indexed' : 'indexed',
      contentType: 'application/pdf',
      byteSize: 1000 * i,
      sha256: crypto.createHash('sha256').update(`doc${i}`).digest('base64'),
      version: 1,
      versionCount: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-02T00:00:00.000Z',
      ...(i === 3 ? { partialFailures: [{ code: 'PICTURE_DESCRIPTION_FAILED', detail: 'page 4' }] } : {}),
      etag: `"doc-${String(i).padStart(4, '0')}-1"`,
    };
    versionsOf.set(doc, [
      { number: 1, status: doc.status, contentType: doc.contentType, byteSize: doc.byteSize, sha256: doc.sha256, createdAt: doc.createdAt },
    ]);
    docs.push(doc);
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

// Members that make a body a wrapper round things (or a page of them), not a thing itself
const WRAPPER_KEYS = ['items', 'results', 'operation', 'uploadPolicy', 'live', 'historyEntry', 'job', 'batch', 'document', 'knowledgeBase', 'estimate'];
/** A single read's body that is one thing: an object with an identity and no wrapper members. */
const isThing = (body) =>
  body !== null && typeof body === 'object' && !Array.isArray(body) && !WRAPPER_KEYS.some((k) => k in body) && ['id', 'path', 'name', 'readers'].some((k) => k in body);

/**
 * One type per thing: a thing's body carries its `etag`, the same value as the ETag header, as the server's single
 * reads do. The fault etagHeaderOnly sends it in the header alone, so an SDK has to fill the field from the header.
 */
function sendJson(res, rid, status, body, extra = {}) {
  if (extra.ETag && isThing(body)) {
    body = faults.etagHeaderOnly ? (({ etag, ...rest }) => rest)(body) : { ...body, etag: extra.ETag };
  }
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

/** Reads a body at most `bytesPerSecond`, pausing the request between chunks, so the client's sends slow to match. */
function readBodySlowly(req, bytesPerSecond) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => {
      chunks.push(c);
      req.pause();
      setTimeout(() => req.resume(), Math.ceil((c.length / bytesPerSecond) * 1000));
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
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

/**
 * A `hold` fault: no answer, the connection kept open until the client closes it (logged as request-aborted) or
 * holdMs passes (then the socket is destroyed, as an idle timeout at a proxy would). Returns true.
 */
function hold(op, res, holdMs = 30_000) {
  const at = Date.now();
  log.push({ event: 'request-held', op, at });
  const timer = setTimeout(() => res.socket?.destroy(), holdMs);
  res.on('close', () => {
    clearTimeout(timer);
    if (!res.writableFinished) log.push({ event: 'request-aborted', op, afterMs: Date.now() - at, at: Date.now() });
  });
  return true;
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
  if (f.hold) return hold(op, res, f.holdMs);
  const extra = f.retryAfter != null ? { 'Retry-After': String(f.retryAfter) } : {};
  if (f.body !== undefined || f.contentType !== undefined) {
    res.writeHead(f.status, { ...(f.contentType ? { 'Content-Type': f.contentType } : {}), ...extra });
    res.end(f.body ?? '');
    return true;
  }
  const code = f.code ?? (f.status === 429 ? 'RATE_LIMITED' : f.status === 503 ? 'SERVICE_UNAVAILABLE' : f.status === 500 ? 'INTERNAL' : `HTTP_${f.status}`);
  problem(res, rid, f.status, code, 'Injected fault', { extra });
  return true;
}

/** An S3 error: XML, with none of the Caitlyn headers. */
function s3Error(res, status, code, message, extra = {}, more = '') {
  res.writeHead(status, { 'Content-Type': 'application/xml', ...extra });
  res.end(`<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}</Code><Message>${message}</Message>${more}</Error>`);
}

/**
 * S3 needs a request body's length up front: it refuses a chunked body (501 NotImplemented, naming the
 * Transfer-Encoding header) and a body with no Content-Length (411 MissingContentLength), before reading it. Returns
 * true when it refused, and logs {event: 'storage-refused-length', op, reason}.
 */
function s3LengthRequired(op, req, res) {
  const chunked = /chunked/i.test(req.headers['transfer-encoding'] ?? '');
  if (!chunked && req.headers['content-length'] != null) return false;
  log.push({ event: 'storage-refused-length', op, reason: chunked ? 'chunked' : 'no-content-length', at: Date.now() });
  if (chunked) s3Error(res, 501, 'NotImplemented', 'A header you provided implies functionality that is not implemented', {}, '<Header>Transfer-Encoding</Header>');
  else s3Error(res, 411, 'MissingContentLength', 'You must provide the Content-Length HTTP header.');
  return true;
}

/** Serve a queued status fault for an S3 stand-in, as S3 would. Returns true when it did. */
function s3StatusFault(op, res) {
  const queue = faults.status[op];
  if (!queue || queue.length === 0) return false;
  const f = queue.shift();
  if (f.close) {
    res.socket.destroy();
    return true;
  }
  if (f.hold) return hold(op, res, f.holdMs);
  const extra = f.retryAfter != null ? { 'Retry-After': String(f.retryAfter) } : {};
  const code = f.status === 503 ? 'SlowDown' : f.status === 500 ? 'InternalError' : `Http${f.status}`;
  s3Error(res, f.status, code, 'Injected fault', extra);
  return true;
}

/** An If-Match value against a resource's ETag: equal, or `*` (any version of a resource that exists). */
const etagMatches = (ifMatch, etag) => ifMatch === etag || ifMatch === '*';
const sha256b64 = (buf) => crypto.createHash('sha256').update(buf).digest('base64');
/** URL-safe base64 with no padding: the form of a SHA-256 in an object key (PROTOCOL.md 14). */
const urlSafe = (b64) => b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// MOCK_NOW fixes the clock things the mock makes are stamped with, so a transcript of them doesn't change from day to
// day (scripts/cli-examples.mjs sets it)
const nowIso = () => process.env.MOCK_NOW ?? new Date().toISOString();

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
  if (r.stream && c.operation === 'WatchKnowledgeBase') {
    const kb = String(c.input.knowledgeBaseId ?? 'KB4T7YQ2WL');
    const events = [{ id: crypto.randomUUID(), type: 'snapshot', data: { knowledgeBase: { id: kb, name: 'HR policies', status: 'ready', createdAt: '2026-11-01T00:00:00.000Z', updatedAt: '2026-11-01T00:00:00.000Z', etag: '"kb-1"' }, jobs: [], progress: [] } }];
    return streamEvents(req, res, rid, 'example', events, 0, false);
  }
  if (r.stream && c.operation === 'WatchOperation') {
    return streamEvents(req, res, rid, 'example', operationWatchEvents(String(c.input.operationId ?? 'example')), 0, false);
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

// The OperationEvent stream (WatchOperation), for the example cases and the route below: an operation running,
// then finished.
function operationWatchEvents(operationId) {
  const operation = (status) => ({ id: operationId, kind: 'document_ingestion', status, createdAt: '2026-11-16T01:02:03.000Z' });
  return [
    { id: `${operationId}:1`, type: 'operation.updated', data: { operation: operation('running') } },
    { id: `${operationId}:2`, type: 'operation.finished', data: { operation: { ...operation('succeeded'), endedAt: '2026-11-16T01:05:00.000Z' } } },
  ];
}

// WatchOperation: an operation running, then finished (the final event); then the stream ends. The operation itself
// is finished too, so GetOperation afterwards agrees with what the watch said.
async function watchOperation(req, res, rid, [kb, id]) {
  if (statusFault('WatchOperation', res, rid)) return;
  const job = jobOr404(res, rid, kb, id);
  if (!job) return;
  for (let i = 0; i < 100 && !FINAL_JOB.has(job.status); i++) stepJob(job);
  const events = operationWatchEvents(decodeURIComponent(id));
  const at = events.findIndex((e) => e.id === req.headers['last-event-id']);
  return streamEvents(req, res, rid, id, events.slice(at + 1), 0, false);
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
    if (faults.holdAfterEvents != null && sent === faults.holdAfterEvents) {
      log.push({ event: 'server-holding-stream', conversationId, afterEventId: e.id, at: Date.now() });
      const until = Date.now() + 10_000;
      while (!closed && Date.now() < until) await new Promise((r) => setTimeout(r, 10));
      if (closed) return;
    }
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

const KB = '/v3/knowledge-bases/([^/]+)';
const routes = [
  ['GET', /^\/v3\/me$/, getCaller],
  ['GET', /^\/v3\/knowledge-bases$/, listKnowledgeBases],
  ['POST', /^\/v3\/knowledge-bases$/, createKnowledgeBase],
  ['GET', new RegExp(`^${KB}$`), getKnowledgeBase],
  ['PATCH', new RegExp(`^${KB}$`), updateKnowledgeBase],
  ['DELETE', new RegExp(`^${KB}$`), deleteKnowledgeBase],
  ['GET', new RegExp(`^${KB}/events$`), watchKnowledgeBase],
  ['GET', new RegExp(`^${KB}/access$`), getAccess],
  ['PUT', new RegExp(`^${KB}/access$`), putAccess],
  ['GET', new RegExp(`^${KB}/folders$`), listFolders],
  ['POST', new RegExp(`^${KB}/folders$`), createFolder],
  ['PATCH', new RegExp(`^${KB}/folders/(.+)$`), updateFolder],
  ['DELETE', new RegExp(`^${KB}/folders/(.+)$`), deleteFolder],
  ['GET', new RegExp(`^${KB}/fields$`), listFields],
  ['POST', new RegExp(`^${KB}/fields$`), createField],
  ['POST', new RegExp(`^${KB}/fields:fill-in$`), fillIn],
  ['POST', new RegExp(`^${KB}/fields:estimate-fill-in$`), estimateFillIn],
  ['GET', new RegExp(`^${KB}/fields/([^/]+)$`), getField],
  ['PATCH', new RegExp(`^${KB}/fields/([^/]+)$`), updateField],
  ['DELETE', new RegExp(`^${KB}/fields/([^/]+)$`), deleteField],
  ['POST', new RegExp(`^${KB}/ingestions:estimate$`), estimateIngestion],
  ['GET', new RegExp(`^${KB}/layout-aware-search-estimate$`), estimateLayoutAwareSearch],
  ['POST', new RegExp(`^${KB}/enable-layout-aware-search$`), enableLayoutAwareSearch],
  ['GET', new RegExp(`^${KB}/documents$`), listDocuments],
  ['POST', new RegExp(`^${KB}/documents$`), createDocument],
  ['POST', new RegExp(`^${KB}/documents:batch-delete$`), batchDeleteDocuments],
  ['POST', new RegExp(`^${KB}/documents:reprocess$`), reprocess],
  ['POST', new RegExp(`^${KB}/documents:estimate-reprocess$`), estimateReprocess],
  ['GET', new RegExp(`^${KB}/documents/([^/]+)$`), getDocument],
  ['PATCH', new RegExp(`^${KB}/documents/([^/]+)$`), updateDocument],
  ['DELETE', new RegExp(`^${KB}/documents/([^/]+)$`), deleteDocument],
  ['POST', new RegExp(`^${KB}/documents/([^/]+)/retry$`), retryDocument],
  ['POST', new RegExp(`^${KB}/documents/([^/]+)/cancel-processing$`), cancelDocumentProcessing],
  ['GET', new RegExp(`^${KB}/documents/([^/]+)/content$`), getDocumentContent],
  ['GET', new RegExp(`^${KB}/documents/([^/]+)/download$`), getDocumentDownload],
  ['POST', new RegExp(`^${KB}/documents/([^/]+)/versions$`), createDocumentVersion],
  ['POST', new RegExp(`^${KB}/documents/([^/]+)/versions:estimate$`), estimateDocumentVersion],
  ['GET', new RegExp(`^${KB}/documents/([^/]+)/versions$`), listDocumentVersions],
  ['GET', new RegExp(`^${KB}/documents/([^/]+)/versions/([^/]+)$`), getDocumentVersion],
  ['DELETE', new RegExp(`^${KB}/documents/([^/]+)/versions/([^/]+)$`), deleteDocumentVersion],
  ['POST', new RegExp(`^${KB}/ingestion-batches$`), createIngestionBatch],
  ['GET', new RegExp(`^${KB}/ingestion-batches$`), listIngestionBatches],
  ['GET', new RegExp(`^${KB}/ingestion-batches/([^/]+)$`), getIngestionBatch],
  ['PATCH', new RegExp(`^${KB}/ingestion-batches/([^/]+)$`), updateIngestionBatch],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/items:batch-create$`), batchCreateItems],
  ['GET', new RegExp(`^${KB}/ingestion-batches/([^/]+)/items$`), listItems],
  ['GET', new RegExp(`^${KB}/ingestion-batches/([^/]+)/items/([^/]+)$`), getItem],
  ['PATCH', new RegExp(`^${KB}/ingestion-batches/([^/]+)/items/([^/]+)$`), updateItem],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/items/([^/]+)/cancel$`), cancelItem],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/start$`), startIngestionBatch],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/upload-policies$`), createUploadPolicy],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/complete-uploads$`), completeUploads],
  ['POST', new RegExp(`^${KB}/ingestion-batches/([^/]+)/cancel$`), cancelIngestionBatch],
  ['GET', new RegExp(`^${KB}/operations$`), listOperations],
  ['GET', new RegExp(`^${KB}/operations/([^/]+)$`), getOperation],
  ['POST', new RegExp(`^${KB}/operations/([^/]+)/cancel$`), cancelOperation],
  ['GET', new RegExp(`^${KB}/operations/([^/]+)/stream$`), watchOperation],
  ['POST', /^\/v3\/conversations\/([^/]+)\/messages$/, sendMessage],
  ['GET', /^\/v3\/conversations\/([^/]+)\/messages$/, listMessages],
  ['GET', /^\/v3\/conversations\/([^/]+)\/stream$/, watchConversation],
  ['GET', /^\/v3\/conversations\/([^/]+)$/, getConversation],
  ['GET', /^\/v3\/events\/stream$/, watchWorkspaceEvents],
  ['POST', /^\/v3\/uploads$/, createUpload],
  ['GET', /^\/v3\/uploads\/([^/]+)$/, getUpload],
  ['GET', /^\/__s3\/content\/([^/]+)$/, getDocumentBytes],
  ['PUT', /^\/__s3\/([^/]+)$/, putUploadBytes],
  ['POST', /^\/__s3\/$/, postObjectForm],
  ['GET', /^\/v3\/agents$/, listAgents],
  ['POST', /^\/v3\/agents$/, createAgent],
  ['GET', /^\/v3\/agents\/([^/]+)$/, getAgent],
  ['PATCH', /^\/v3\/agents\/([^/]+)$/, updateAgent],
  ['DELETE', /^\/v3\/agents\/([^/]+)$/, deleteAgent],
  ['GET', /^\/v3\/agents\/([^/]+)\/versions$/, listAgentVersions],
  ['PATCH', /^\/v3\/agents\/([^/]+)\/versions\/draft$/, updateDraft],
  ['PUT', /^\/v3\/agents\/([^/]+)\/versions\/draft$/, replaceDraft],
  ['POST', /^\/v3\/agents\/([^/]+)\/versions\/draft\/reset$/, resetDraft],
  ['POST', /^\/v3\/agents\/([^/]+)\/versions\/draft\/save$/, saveDraftVersion],
  ['GET', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)$/, getAgentVersion],
  ['DELETE', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)$/, deleteAgentVersion],
  ['POST', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)\/publish$/, publishAgentVersion],
  ['GET', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)\/compare$/, compareAgentVersions],
  ['POST', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)\/conversations$/, createConversation],
  ['GET', /^\/v3\/agents\/([^/]+)\/conversations$/, listConversations],
  ['POST', /^\/v3\/agents\/([^/]+)\/versions\/([^/]+)\/unattended-runs$/, createUnattendedRun],
  ['GET', /^\/v3\/unattended-runs$/, listUnattendedRuns],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)$/, getUnattendedRun],
  ['PATCH', /^\/v3\/unattended-runs\/([^/]+)$/, updateUnattendedRun],
  ['DELETE', /^\/v3\/unattended-runs\/([^/]+)$/, deleteUnattendedRun],
  ['POST', /^\/v3\/unattended-runs\/([^/]+)\/cancel$/, cancelUnattendedRun],
  ['POST', /^\/v3\/unattended-runs\/([^/]+)\/replay$/, replayUnattendedRun],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/stream$/, watchUnattendedRun],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/messages$/, listUnattendedRunMessages],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/artefacts$/, listUnattendedRunArtefacts],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/artefacts\/([^/]+)\/download$/, getUnattendedRunArtefactDownload],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/attachments$/, listUnattendedRunAttachments],
  ['GET', /^\/v3\/unattended-runs\/([^/]+)\/policy-reviews$/, listUnattendedRunPolicyReviews],
  ['GET', /^\/v3\/agents\/([^/]+)\/history$/, listLiveHistory],
  ['GET', /^\/v3\/agents\/([^/]+)\/history\/([^/]+)$/, getLiveHistoryEntry],
];

// FolderPath (the model's pattern): a folder starts and ends in `/`; the root is `/`.
const FOLDER_PATH = /^\/([^/]+\/)*$/;
const FOLDER_DETAIL = 'Expected a folder path in a knowledge base, starting and ending in `/`, for example `/hr/leave/`. The root is `/`.';
// The file types a knowledge base ingests, as the server's list has them: PDF, images, audio, video, Markdown and Word.
const INGESTIBLE = new Set(['pdf', 'png', 'jpeg', 'jpg', 'gif', 'flac', 'ogg', 'mp3', 'm4a', 'mp4', 'webm', 'md', 'markdown', 'docx']);

const LIST_PARAMS = [
  'limit', 'cursor', 'sort', 'deep', 'q', 'filter[status][eq]', 'filter[folder][eq]', 'filter[name][startsWith]',
  'filter[externalId][eq]', 'filter[contentType][startsWith]', 'filter[sha256][eq]',
];

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
  const body = docBody(doc);
  if (Array.isArray(statuses) && statuses.length) {
    body.status = statuses.length > 1 ? statuses.shift() : statuses[0];
  }
  const { etag, ...rest } = body;
  sendJson(res, rid, 200, rest, { ETag: etag });
}

// A deleted document's GetDocument reads left before it is gone, kept off the document so no response shows it.
const readsBeforeGone = new WeakMap();

// Marks a document `deleting`; GetDocument finds it gone after faults.deletingReads more reads. A document still being
// processed can be deleted: its processing stops (the job ends cancelled) and it never comes back indexed.
function markDeleting(doc) {
  if (doc.status !== 'deleting') {
    doc.status = 'deleting';
    doc.updatedAt = new Date().toISOString();
    readsBeforeGone.set(doc, faults.deletingReads ?? 1);
    stopProcessing(doc);
  }
}

/** Ends every unfinished job on a document as cancelled, without its effects, and clears its processing. */
function stopProcessing(doc) {
  delete doc.processing;
  for (const job of state.jobs.values()) {
    if (FINAL_JOB.has(job.status) || job.target?.type !== 'document' || job.target.id !== doc.id || job.knowledgeBaseId !== doc.knowledgeBaseId) continue;
    job.status = 'cancelled';
    job.endedAt = job.updatedAt = nowIso();
    kbEvent(job.knowledgeBaseId, 'job.finished', { job: jobBody(job) }, { document: doc.id, folder: doc.folder });
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
  // filter[folder][eq]: the documents directly in the folder; with deep=true, every document below it too.
  const deep = url.searchParams.get('deep') === 'true';
  if (folder !== null) items = items.filter((d) => (deep ? d.folder.startsWith(folder) : d.folder === folder));
  const eq = { 'filter[externalId][eq]': 'externalId', 'filter[sha256][eq]': 'sha256' };
  for (const [param, field] of Object.entries(eq)) {
    const v = url.searchParams.get(param);
    if (v !== null) items = items.filter((d) => d[field] === v);
  }
  const prefixes = { 'filter[name][startsWith]': 'name', 'filter[contentType][startsWith]': 'contentType' };
  for (const [param, field] of Object.entries(prefixes)) {
    const v = url.searchParams.get(param);
    if (v !== null) items = items.filter((d) => (d[field] ?? '').startsWith(v));
  }
  const q = url.searchParams.get('q');
  if (q !== null) items = items.filter((d) => d.name.includes(q));
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(JSON.stringify({ offset: start + limit })).toString('base64url') : undefined;
  sendJson(res, rid, 200, { items: page, ...(next ? { nextCursor: next } : {}) });
}

async function sendMessage(req, res, rid, [conversationId], url, body) {
  if (statusFault('SendMessage', res, rid)) return;
  const input = parseJson(body);
  if (!input.message) return problem(res, rid, 400, 'VALIDATION_FAILED', 'message is required', { fieldErrors: [{ pointer: '/message', code: 'VALIDATION_FAILED', detail: 'Required' }] });
  const id = decodeURIComponent(conversationId);
  // attachments: 1 to 10 {uploadId}, each an upload reserved with purpose {conversationId} for this conversation, its
  // bytes sent and not yet used. All are checked before any is used; each is used up when the message is saved.
  let attachments;
  if (input.attachments !== undefined) {
    const refs = input.attachments;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 10 || refs.some((r) => typeof r?.uploadId !== 'string')) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'attachments holds 1 to 10 {uploadId}', { fieldErrors: [{ pointer: '/attachments', code: 'VALIDATION_FAILED' }] });
    }
    const ups = [];
    for (const [i, r] of refs.entries()) {
      const taken = consumeUpload(r.uploadId);
      if (taken.problem) return problem(res, rid, taken.status, ...taken.problem);
      if (taken.up.input.purpose?.conversationId !== id) {
        return problem(res, rid, 400, 'VALIDATION_FAILED', `Upload ${r.uploadId} was not reserved with purpose {conversationId: "${id}"}.`, { fieldErrors: [{ pointer: `/attachments/${i}/uploadId`, code: 'VALIDATION_FAILED' }] });
      }
      ups.push(taken.up);
    }
    for (const up of ups) up.status = 'consumed';
    attachments = ups.map((up) => ({ name: up.input.fileName, contentType: up.input.contentType, byteSize: Number(up.input.byteSize) }));
  }
  const events = chatEvents();
  state.conversations.set(id, events);
  // ListMessages: the message, then the answer once it completes.
  const transcript = (state.messages ??= new Map()).get(id) ?? [];
  transcript.push({ id: crypto.randomUUID(), role: 'user', text: input.message, createdAt: nowIso(), ...(attachments ? { attachments } : {}) });
  const completed = events.find((e) => e.type === 'message.completed');
  if (completed) transcript.push(structuredClone(completed.data.message));
  state.messages.set(id, transcript);
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

const MAX_FILE = 2_147_483_648; // 2 GB (PROTOCOL.md 14)

/**
 * A caller-set window (uploadWindowSeconds on CreateIngestionBatch, expiresInSeconds on CreateUpload): 60 to 3600
 * seconds, as the server takes them. Under faults.shortWindows an uploadWindowSeconds counts thirtieths of a second
 * (the least, 60, lasts 2 s), so a test of a deadline runs in seconds while sending a value the SDKs' range check
 * (PROTOCOL.md 3) lets through. Returns [seconds | undefined, problem | undefined].
 */
function windowSeconds(input, member) {
  const v = input?.[member];
  if (v === undefined || v === null) return [undefined, undefined];
  if (!Number.isInteger(v) || v < 60 || v > 3600) {
    return [undefined, { status: 400, problem: ['VALIDATION_FAILED', `${member} is from 60 to 3600 seconds`, { fieldErrors: [{ pointer: `/${member}`, code: 'VALIDATION_FAILED' }] }] }];
  }
  return [faults.shortWindows && member === 'uploadWindowSeconds' ? v / 30 : v, undefined];
}
const AVATAR_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);
const AVATAR_MAX = 1_048_576; // 1 MB

async function createUpload(req, res, rid, _m, url, body) {
  const key = req.headers['idempotency-key'];
  if (faults.reserveDelayMs) await sleep(faults.reserveDelayMs);
  if (statusFault('CreateUpload', res, rid)) return;
  const input = parseJson(body);
  const result = idempotent(key, 'CreateUpload', () => {
    const missing = ['fileName', 'contentType', 'byteSize', 'sha256'].filter((f) => input[f] == null);
    const [life, badLife] = windowSeconds(input, 'expiresInSeconds');
    if (badLife) return badLife;
    if (missing.length) return { status: 400, problem: ['VALIDATION_FAILED', 'Required members are missing', { fieldErrors: missing.map((f) => ({ pointer: `/${f}`, code: 'VALIDATION_FAILED', detail: 'Required' })) }] };
    if (Number(input.byteSize) > MAX_FILE) return { status: 413, problem: ['PAYLOAD_TOO_LARGE', 'Files can be at most 2 GB (2,147,483,648 bytes).'] };
    // purpose.agentAvatar: a PNG, JPEG or WebP image of at most 1 MB, checked here (UploadPurpose).
    if (input.purpose?.agentAvatar === true) {
      if (!AVATAR_TYPES.has(input.contentType) || Number(input.byteSize) > AVATAR_MAX) {
        return { status: 400, problem: ['VALIDATION_FAILED', 'An avatar picture is a PNG, JPEG or WebP image of at most 1 MB.', { fieldErrors: [{ pointer: '/purpose/agentAvatar', code: 'VALIDATION_FAILED' }] }] };
      }
    }
    const id = crypto.randomUUID();
    const upload = {
      id,
      uploadUrl: `http://${req.headers.host}/__s3/${id}?X-Amz-Signature=mock`,
      uploadMethod: 'PUT',
      requiredHeaders: { 'content-type': input.contentType, 'x-amz-checksum-sha256': input.sha256 },
      expiresAt: new Date(Date.now() + (life ?? faults.uploadSeconds ?? 900) * 1000).toISOString(),
      status: 'awaiting_bytes',
    };
    state.uploads.set(id, { ...upload, input });
    return { status: 201, body: upload };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { Location: `/api/v3/uploads/${result.body.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

// GetUpload: the upload's status and when its upload URL expires; 404 for one never reserved.
/** An Upload not used by its expiresAt becomes `expired`, a final status (UploadStatus). */
function expireIfDue(up) {
  if (up.status !== 'consumed' && up.status !== 'expired' && Date.parse(up.expiresAt) <= Date.now()) up.status = 'expired';
  return up;
}

async function getUpload(req, res, rid, [id]) {
  if (statusFault('GetUpload', res, rid)) return;
  const up = state.uploads.get(decodeURIComponent(id));
  if (!up) return problem(res, rid, 404, 'NOT_FOUND', `No upload ${id}`);
  expireIfDue(up);
  sendJson(res, rid, 200, { id: up.id, status: up.status, expiresAt: up.expiresAt });
}

// The presigned PUT: the bytes must match the reserved checksum and size, and carry the checksum header.
// Status faults: `PutUpload`.
async function putUploadBytes(req, res, rid, [id], url, body) {
  if (s3LengthRequired('PutUpload', req, res)) return;
  if (s3StatusFault('PutUpload', res)) return;
  const up = state.uploads.get(id);
  if (!up) return s3Error(res, 404, 'NoSuchUpload', 'The upload does not exist');
  const sha = sha256b64(body);
  const headerSha = req.headers['x-amz-checksum-sha256'];
  if (req.headers['content-type'] !== up.input.contentType) return s3Error(res, 403, 'SignatureDoesNotMatch', 'Content-Type is not the signed one');
  if (headerSha !== up.input.sha256 || sha !== up.input.sha256 || body.length !== Number(up.input.byteSize)) {
    return s3Error(res, 400, 'BadDigest', 'The bytes do not match the checksum');
  }
  if (up.status === 'awaiting_bytes') up.status = 'received';
  res.writeHead(200, { ETag: `"${sha}"` });
  res.end();
}

// GET /__s3/content/<document>: the bytes GetDocumentDownload's url names, as S3 serves an object: the document's
// content type, and bytes made from its id and version (the mock keeps no uploaded bytes). Faults: `GetObject`.
async function getDocumentBytes(req, res, rid, [documentId], url) {
  if (s3StatusFault('GetObject', res)) return;
  const id = decodeURIComponent(documentId);
  const doc = [...state.knowledgeBases.values()].flat().find((d) => d.id === id);
  if (!doc) return s3Error(res, 404, 'NoSuchKey', 'The specified key does not exist.');
  const bytes = Buffer.from(`mock bytes of ${doc.id}, version ${url.searchParams.get('version') ?? 'current'}\n`);
  res.writeHead(200, { 'Content-Type': doc.contentType ?? 'application/octet-stream', 'Content-Length': String(bytes.length) });
  res.end(bytes);
}

/** Takes an upload for an operation: 404 when unknown, 409 when it has no bytes or was used. */
function consumeUpload(uploadId) {
  const up = state.uploads.get(uploadId);
  if (!up) return { status: 404, problem: ['NOT_FOUND', `No upload ${uploadId}`] };
  if (expireIfDue(up).status === 'expired') return { status: 409, problem: ['CONFLICT', `Upload ${up.id} has expired. Reserve a new upload.`] };
  if (up.status === 'awaiting_bytes') return { status: 409, problem: ['CONFLICT', `Upload ${up.id} has no bytes yet. Send the file to its uploadUrl first.`] };
  if (up.status === 'consumed') return { status: 409, problem: ['CONFLICT', `Upload ${up.id} has already been used. Reserve a new upload.`] };
  return { up };
}

// ---------------------------------------------------------------------------
// Documents and their versions
// ---------------------------------------------------------------------------

const docEtag = (doc) => doc.etag;
function bumpDoc(doc) {
  const n = Number(/-(\d+)"$/.exec(doc.etag ?? '')?.[1] ?? 0) + 1;
  doc.etag = `"${doc.id}-${n}"`;
  doc.updatedAt = nowIso();
}

/** Makes a document from an upload's input (or an ingestion item), version 1 `pending`. */
function newDocument(kb, { name, folder, contentType, byteSize, sha256, externalId, sourceUrl, metadata }) {
  const now = nowIso();
  const id = `doc-${crypto.randomUUID().slice(0, 8)}`;
  const doc = {
    id,
    knowledgeBaseId: kb,
    name,
    folder,
    status: 'pending',
    contentType,
    byteSize: Number(byteSize),
    sha256,
    versionCount: 1,
    ...(externalId ? { externalId } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(metadata ? { metadata } : {}),
    createdAt: now,
    updatedAt: now,
    etag: `"${id}-1"`,
  };
  versionsOf.set(doc, [{ number: 1, status: 'pending', contentType, byteSize: Number(byteSize), sha256, createdAt: now }]);
  return doc;
}

/**
 * A path a started batch has reserved for a new document (an `add` item still awaiting its upload): a write onto it
 * is refused with 409 TARGET_IN_USE and a Retry-After until the batch's upload arrives. Returns the problem, if any.
 */
function reservedPath(kb, folder, name) {
  const path = `${folder ?? '/'}${name}`;
  const holder = [...state.batches.values()].find(
    (b) => b.knowledgeBaseId === kb && b.status === 'running' && b.items.some((it) => it.resolution === 'add' && it.status === 'awaiting_upload' && it.path === path),
  );
  if (!holder) return undefined;
  return { status: 409, problem: ['TARGET_IN_USE', `${path} is reserved for a new document by ingestion batch ${holder.id}. Try again once its upload has arrived.`, { extra: { 'Retry-After': '30' } }] };
}

async function createDocument(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateDocument', res, rid)) return;
  const input = parseJson(body);
  kb = decodeURIComponent(kb);
  const docs = state.knowledgeBases.get(kb);
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
    const taken = consumeUpload(input.uploadId);
    if (taken.problem) return taken;
    const { up } = taken;
    // The upload is checked first, then the path; the upload is not consumed when the path is refused.
    const reserved = reservedPath(kb, input.folder, input.name ?? up.input.fileName);
    if (reserved) return reserved;
    up.status = 'consumed';
    const doc = newDocument(kb, { ...up.input, ...input, name: input.name ?? up.input.fileName });
    docs.push(doc);
    return { status: 202, body: { document: docBody(doc), operation: jobBody(ingestionJob(doc, versionsOf.get(doc)[0])) } };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  const doc = result.body.document;
  sendJson(res, rid, result.status, result.body, {
    Location: `/api/v3/knowledge-bases/${kb}/documents/${doc.id}`,
    ETag: doc.etag,
    ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

function versionSummary(doc, v) {
  const all = versionsOf.get(doc) ?? [];
  return {
    number: v.number,
    documentId: doc.id,
    status: v.status,
    ...(v.contentType ? { contentType: v.contentType } : {}),
    ...(v.byteSize !== undefined ? { byteSize: v.byteSize } : {}),
    ...(v.sha256 ? { sha256: v.sha256 } : {}),
    current: doc.version === v.number,
    latest: all.at(-1)?.number === v.number,
    ...(v.note ? { note: v.note } : {}),
    createdAt: v.createdAt,
  };
}

/** A version that has become indexed becomes the document's current one. */
function makeCurrent(doc, v) {
  doc.version = v.number;
  doc.status = v.status;
  doc.contentType = v.contentType;
  doc.byteSize = v.byteSize;
  doc.sha256 = v.sha256;
  bumpDoc(doc);
}

function findDoc(kb, documentId) {
  return state.knowledgeBases.get(decodeURIComponent(kb))?.find((d) => d.id === decodeURIComponent(documentId));
}

// CreateDocumentVersion: the rules of the operation's documentation. The same bytes as the current version are
// `unchanged` (no operation); an earlier version's are `restored`; a version still processing refuses another (409
// DOCUMENT_INGESTION_IN_PROGRESS, Retry-After 5); another file type is 400 VALIDATION_FAILED.
async function createDocumentVersion(req, res, rid, [kb, documentId], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateDocumentVersion', res, rid)) return;
  const input = parseJson(body);
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${documentId}`);
  const ifMatch = req.headers['if-match'];
  if (ifMatch && !etagMatches(ifMatch, docEtag(doc))) return problem(res, rid, 412, 'PRECONDITION_FAILED', `Document ${doc.id} changed since you read it.`);
  const result = idempotent(key, `CreateDocumentVersion:${doc.id}`, () => {
    const versions = versionsOf.get(doc);
    if (versions.some((v) => v.status === 'pending' || v.status === 'processing')) {
      return { status: 409, problem: ['DOCUMENT_INGESTION_IN_PROGRESS', `A version of document ${doc.id} is still processing. Try again once it has finished.`, { extra: { 'Retry-After': '5' } }] };
    }
    const taken = consumeUpload(input.uploadId);
    if (taken.problem) return taken;
    const { up } = taken;
    if (up.input.contentType !== doc.contentType) {
      return { status: 400, problem: ['VALIDATION_FAILED', `The new bytes are ${up.input.contentType}, not ${doc.contentType}: another file type is a new document.`, { fieldErrors: [{ pointer: '/uploadId', code: 'VALIDATION_FAILED' }] }] };
    }
    up.status = 'consumed';
    const current = versions.find((v) => v.number === doc.version);
    if (current && current.sha256 === up.input.sha256) return { status: 200, body: { result: 'unchanged', version: versionSummary(doc, current) } };
    const earlier = versions.find((v) => v.sha256 === up.input.sha256);
    const v = { number: versions.length + 1, status: 'pending', contentType: up.input.contentType, byteSize: Number(up.input.byteSize), sha256: up.input.sha256, ...(input.note ? { note: input.note } : {}), createdAt: nowIso(), ...(earlier ? { restores: earlier.number } : {}) };
    versions.push(v);
    doc.versionCount = versions.length;
    bumpDoc(doc);
    return { status: 202, body: { result: earlier ? 'restored' : 'created', version: versionSummary(doc, v), operation: jobBody(ingestionJob(doc, v)) } };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, {
    Location: `/api/v3/knowledge-bases/${doc.knowledgeBaseId}/documents/${doc.id}/versions/${result.body.version.number}`,
    ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

async function listDocumentVersions(req, res, rid, [kb, documentId]) {
  if (statusFault('ListDocumentVersions', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${documentId}`);
  sendJson(res, rid, 200, { items: [...versionsOf.get(doc)].reverse().map((v) => versionSummary(doc, v)) });
}

// GetDocumentVersion: a number, `current` or `latest`. A version not yet final moves one step per read (pending,
// processing, indexed), or follows the versionStatus fault; one that becomes indexed becomes current.
async function getDocumentVersion(req, res, rid, [kb, documentId, ref]) {
  if (statusFault('GetDocumentVersion', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${documentId}`);
  const versions = versionsOf.get(doc);
  ref = decodeURIComponent(ref);
  const v = ref === 'latest' ? versions.at(-1) : ref === 'current' ? versions.find((x) => x.number === doc.version) : versions.find((x) => String(x.number) === ref);
  if (!v) return problem(res, rid, 404, 'NOT_FOUND', `Document ${doc.id} has no version ${ref}`);
  const scripted = faults.versionStatus?.[`${doc.id}:${v.number}`];
  if (Array.isArray(scripted) && scripted.length) {
    v.status = scripted.length > 1 ? scripted.shift() : scripted[0];
  } else if (v.status === 'pending') {
    v.status = 'processing';
  } else if (v.status === 'processing') {
    v.status = 'indexed';
  }
  if ((v.status === 'indexed' || v.status === 'partially_indexed') && doc.version !== v.number) makeCurrent(doc, v);
  sendJson(res, rid, 200, versionSummary(doc, v), { ETag: doc.etag });
}

// ---------------------------------------------------------------------------
// Agents: the agent resource (name, description, avatar) and its draft
// ---------------------------------------------------------------------------

const agentEtag = (a) => `"agent-${a.agentEtagN}"`;

function agentBody(a) {
  return structuredClone(a.agent);
}

/**
 * An avatar input as stored: `mark.pictureUploadId` takes an upload reserved with purpose {agentAvatar: true} whose
 * bytes have arrived, and is shown as `mark.pictureUrl`. Exactly one of `icon` and `pictureUploadId`.
 */
function avatarFrom(input) {
  if (input === undefined) return { avatar: undefined };
  const out = {};
  if (input.colour) out.colour = input.colour;
  const mark = input.mark;
  if (mark) {
    const both = mark.icon !== undefined && mark.pictureUploadId !== undefined;
    const neither = mark.icon === undefined && mark.pictureUploadId === undefined;
    if (both || neither) return { status: 400, problem: ['VALIDATION_FAILED', 'avatar.mark takes exactly one of icon and pictureUploadId.', { fieldErrors: [{ pointer: '/avatar/mark', code: 'VALIDATION_FAILED' }] }] };
    if (mark.icon !== undefined) out.mark = { icon: mark.icon };
    else {
      const up = state.uploads.get(mark.pictureUploadId);
      if (up && up.input.purpose?.agentAvatar !== true) {
        return { status: 400, problem: ['VALIDATION_FAILED', `Upload ${up.id} was not reserved with purpose {agentAvatar: true}.`, { fieldErrors: [{ pointer: '/avatar/mark/pictureUploadId', code: 'VALIDATION_FAILED' }] }] };
      }
      const taken = consumeUpload(mark.pictureUploadId);
      if (taken.problem) return taken;
      taken.up.status = 'consumed';
      out.mark = { pictureUrl: `https://cdn.example.com/avatars/${taken.up.id}?X-Amz-Signature=mock` };
    }
  }
  return { avatar: out };
}

async function createAgent(req, res, rid, _m, url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateAgent', res, rid)) return;
  const input = parseJson(body);
  const result = idempotent(key, 'CreateAgent', () => {
    if (!input.name) return { status: 400, problem: ['VALIDATION_FAILED', 'name is required', { fieldErrors: [{ pointer: '/name', code: 'VALIDATION_FAILED', detail: 'Required' }] }] };
    const av = avatarFrom(input.avatar);
    if (av.problem) return av;
    const id = crypto.randomBytes(5).toString('hex').toUpperCase();
    const now = nowIso();
    const entry = {
      etagN: 1,
      agentEtagN: 1,
      agent: { id, name: input.name, ...(input.description ? { description: input.description } : {}), ...(av.avatar ? { avatar: av.avatar } : {}), createdAt: now },
      version: { agentId: id, name: 'draft', matchesLive: false, createdAt: now, configuration: { guidance: { instructions: '' } } },
    };
    state.agents.set(id, entry);
    return { status: 201, body: agentBody(entry), entry };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, {
    ETag: agentEtag(result.entry),
    Location: `/api/v3/agents/${result.body.id}`,
    ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

async function getAgent(req, res, rid, [agentId]) {
  if (statusFault('GetAgent', res, rid)) return;
  const a = state.agents.get(decodeURIComponent(agentId));
  if (!a) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${agentId}`);
  sendJson(res, rid, 200, agentBody(a), { ETag: agentEtag(a) });
}

// UpdateAgent: If-Match required; `avatar` replaces the whole avatar; clear takes description and avatar.
async function updateAgent(req, res, rid, [agentId], url, body) {
  if (statusFault('UpdateAgent', res, rid)) return;
  const a = state.agents.get(decodeURIComponent(agentId));
  if (!a) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${agentId}`);
  const ifMatch = req.headers['if-match'];
  if (!ifMatch) return problem(res, rid, 428, 'PRECONDITION_REQUIRED', 'Send the ETag you last read in If-Match.');
  if (!etagMatches(ifMatch, agentEtag(a))) return problem(res, rid, 412, 'PRECONDITION_FAILED', `Agent ${a.agent.id} changed since you read it.`);
  const { clear = [], ...patch } = parseJson(body);
  const fieldErrors = [];
  clear.forEach((k, i) => {
    if (!['description', 'avatar'].includes(k)) fieldErrors.push({ pointer: `/clear/${i}`, code: 'VALIDATION_FAILED', detail: `${k} cannot be cleared` });
    else if (k in patch) fieldErrors.push({ pointer: `/${k}`, code: 'VALIDATION_FAILED', detail: `${k} is both set and cleared` });
  });
  if (fieldErrors.length) return problem(res, rid, 400, 'VALIDATION_FAILED', 'The update is not valid', { fieldErrors });
  const av = avatarFrom(patch.avatar);
  if (av.problem) return problem(res, rid, av.status, ...av.problem);
  if (patch.name !== undefined) a.agent.name = patch.name;
  if (patch.description !== undefined) a.agent.description = patch.description;
  if (av.avatar !== undefined) a.agent.avatar = av.avatar;
  for (const k of clear) delete a.agent[k];
  a.agent.updatedAt = nowIso();
  a.agentEtagN++;
  sendJson(res, rid, 200, agentBody(a), { ETag: agentEtag(a) });
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


function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (typeof v === 'object' && v !== null && !Array.isArray(v) && typeof target[k] === 'object' && target[k] !== null && !Array.isArray(target[k])) merge(target[k], v);
    else target[k] = v;
  }
}

// UpdateDraftVersion's writable members, and the paths `clear` takes (the model's ClearableDraftField).
const DRAFT_FIELDS = ['guidance', 'models', 'knowledgeBases', 'policies', 'connectors', 'workflow', 'answers', 'conversation', 'attachments', 'contentSafety', 'deniedDocuments', 'memory', 'voice', 'liveAvatar', 'journey', 'runAs'];
const CLEARABLE = [
  'guidance.identity', 'guidance.instructions', 'guidance.relevance', 'guidance.definitions', 'guidance.searchTopics', 'guidance.resultEvaluation', 'guidance.limitedEvidence',
  'models.answer', 'models.planning', 'models.summary', 'models.classification', 'models.searchTopics', 'models.title',
  'conversation.inputPlaceholder', 'workflow.capabilities', 'memory', 'voice', 'liveAvatar', 'journey', 'runAs',
];
const hasPath = (obj, segs) => segs.reduce((o, s) => (o !== null && typeof o === 'object' && s in o ? o[s] : undefined), obj) !== undefined;

async function updateDraft(req, res, rid, [agentId], url, body) {
  if (statusFault('UpdateDraftVersion', res, rid)) return;
  const agent = state.agents.get(decodeURIComponent(agentId));
  if (!agent) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${agentId}`);
  // If-Match is optional here (@ifMatchOptional): without it the change applies to the draft as it is.
  const ifMatch = req.headers['if-match'];
  if (ifMatch && !etagMatches(ifMatch, etagOf(agent)))
    return problem(res, rid, 412, 'PRECONDITION_FAILED', `The draft of agent ${agentId} changed since you read it. Read it again and reapply your change.`);
  const { clear = [], ...patch } = parseJson(body);
  const fieldErrors = [];
  for (const k of Object.keys(patch)) if (!DRAFT_FIELDS.includes(k)) fieldErrors.push({ pointer: `/${k}`, code: 'UNKNOWN_FIELD' });
  clear.forEach((k, i) => {
    // PROTOCOL.md 8: both problems are VALIDATION_FAILED, with the field in `errors` (a nested member by its pointer).
    const segs = k.split('.');
    if (!CLEARABLE.includes(k)) fieldErrors.push({ pointer: `/clear/${i}`, code: 'VALIDATION_FAILED', detail: `${k} cannot be cleared` });
    else if (hasPath(patch, segs)) fieldErrors.push({ pointer: `/${segs.join('/')}`, code: 'VALIDATION_FAILED', detail: `${k} is both set and cleared` });
  });
  if (fieldErrors.length) {
    const code = fieldErrors.every((e) => e.code === 'UNKNOWN_FIELD') ? 'UNKNOWN_FIELD' : 'VALIDATION_FAILED';
    return problem(res, rid, 400, code, 'The update is not valid', { fieldErrors });
  }
  merge(agent.version.configuration, patch);
  for (const k of clear) {
    const segs = k.split('.');
    const parent = segs.slice(0, -1).reduce((o, s) => o?.[s], agent.version.configuration);
    // guidance.instructions is always present when read: cleared, it becomes empty.
    if (parent && typeof parent === 'object') {
      if (k === 'guidance.instructions') parent.instructions = '';
      else delete parent[segs.at(-1)];
    }
  }
  agent.etagN++;
  sendJson(res, rid, 200, versionBody(agent), { ETag: etagOf(agent) });
}

// ---------------------------------------------------------------------------
// Ingestion batches (PROTOCOL.md 15)
// ---------------------------------------------------------------------------
//
// A batch is `draft` while awaitMoreItems is true, then `planning` (for faults.planningReads GetIngestionBatch
// reads), then `planned`: each item gets an outcome against the knowledge base's documents (by externalId, else by
// path): `new` (resolution `add`), `unchanged` (`skip`), `changed` (`new_version`), `to_remove` (`remove`), or the
// `conflict` faults.planConflicts names, resolved by the policy's onConflict rules (`ask` leaves it `unresolved`,
// `fail` fails the batch). StartIngestionBatch (If-Match required) refuses unresolved items with 409
// INGESTION_BATCH_UNRESOLVED, makes each item to upload `awaiting_upload` with objectKey = keyPrefix +
// URL-safe-base64(sha256) + "." + extension, finishes the others (skipped, removed), and returns an upload policy.
// Files go to POST /__s3/ as forms (postObjectForm). CompleteIngestionBatchUploads checks each stored object against
// the item; accepted items are `ingesting`, then `indexed` after faults.ingestReads GetIngestionBatch reads, and the
// batch is `succeeded` (or `completed_with_failures`) once every item is final.

const FINAL_ITEM = new Set(['indexed', 'skipped', 'moved', 'updated', 'removed', 'failed', 'cancelled']);
const FINAL_BATCH = new Set(['succeeded', 'completed_with_failures', 'failed', 'cancelled']);
const RULE_KEY = { path_taken: 'pathTaken', ambiguous_content: 'ambiguousContent', duplicate_path: 'duplicatePath', duplicate_external_id: 'duplicateExternalKey', duplicate_in_batch: 'duplicateInBatch', changed_since_plan: 'changedSincePlan' };
// The resolutions each outcome accepts by hand (UpdateIngestionBatchItem).
const RESOLUTIONS = {
  new: ['add', 'skip'],
  unchanged: ['skip', 'update_metadata', 'new_version'],
  changed: ['new_version', 'skip'],
  moved: ['move', 'skip'],
  in_progress: ['skip'],
  to_remove: ['remove', 'skip'],
  fetch_failed: ['skip'],
  conflict: ['new_version', 'overwrite', 'add', 'skip'],
};
const UPLOAD_SECRET = 'mock-upload-policy-secret';
// An upload policy's formFields, as the AWS SDK's createPresignedPost returns them for a Key: `bucket`, the signing
// fields, then `key` (the prefix and S3's ${filename} template), the policy and its signature. The `key` is the policy's
// own, which a client must not send as well as the item's (PROTOCOL.md 15, step 6): the POST refuses a repeated field.
const FORM_FIELD_ORDER = ['bucket', 'x-amz-algorithm', 'x-amz-credential', 'x-amz-date', 'key', 'policy', 'x-amz-signature'];
/** The fields a client sends itself after the policy's, lower-cased. */
const OWN_FORM_FIELDS = new Set(['key', 'content-type', 'x-amz-checksum-algorithm', 'x-amz-checksum-sha256', 'file']);

const batchEtag = (b) => `"batch-${b.etagN}"`;
const itemEtag = (it) => `"${it.id}-${it.etagN}"`;
const splitPath = (p) => ({ folder: p.slice(0, p.lastIndexOf('/') + 1), name: p.slice(p.lastIndexOf('/') + 1) });
const docPath = (d) => `${d.folder}${d.name}`;
const extensionOf = (p) => (p.includes('.') ? p.split('.').pop().toLowerCase() : 'bin');

function counts(b) {
  const byOutcome = {};
  const byStatus = {};
  for (const it of b.items) {
    if (it.outcome) byOutcome[it.outcome] = (byOutcome[it.outcome] ?? 0) + 1;
    if (b.startedAt) byStatus[it.status] = (byStatus[it.status] ?? 0) + 1;
  }
  return { byOutcome, byStatus };
}

function batchBody(b, withEtag = false) {
  return {
    id: b.id,
    knowledgeBaseId: b.knowledgeBaseId,
    status: b.status,
    start: b.start,
    awaitMoreItems: b.awaitMoreItems,
    policy: b.policy,
    ...(b.scope ? { scope: b.scope } : {}),
    ...(b.uploadWindowSeconds ? { uploadWindowSeconds: b.uploadWindowSeconds } : {}),
    itemCount: b.items.length,
    ...(b.planned ? { counts: counts(b) } : {}),
    ...(b.planExpiresAt ? { planExpiresAt: b.planExpiresAt } : {}),
    ...(b.uploadsExpireAt && b.items.some((it) => it.status === 'awaiting_upload') ? { uploadsExpireAt: b.uploadsExpireAt } : {}),
    createdBy: { displayName: 'Mock caller' },
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    ...(b.startedAt ? { startedAt: b.startedAt } : {}),
    ...(b.endedAt ? { endedAt: b.endedAt } : {}),
    ...(b.failure ? { failure: b.failure } : {}),
    ...(withEtag ? { etag: batchEtag(b) } : {}),
  };
}

function itemBody(it) {
  const { etagN, mismatchesLeft, readsLeft, handResolved, ...rest } = it;
  return { ...rest, etag: itemEtag(it) };
}

function touch(b) {
  b.etagN++;
  b.updatedAt = nowIso();
}

/** Adds items (at most 1,000 a call) to a batch; one result each, in request order. */
function addItems(b, items) {
  return items.map((input, index) => {
    const ingest = (input.action ?? 'ingest') === 'ingest';
    let problemCode;
    if (!input.path && !input.externalId) problemCode = ['VALIDATION_FAILED', 'An item needs a path or an externalId'];
    else if (input.path && !/^\/([^/]+\/)*[^/]+$/.test(input.path)) problemCode = ['VALIDATION_FAILED', `${input.path} is not a document path`];
    else if (ingest && !input.fetchUrl && (!input.sha256 || !input.byteSize || !input.contentType)) problemCode = ['VALIDATION_FAILED', 'Described content needs sha256, byteSize and contentType'];
    else if (ingest && input.fetchUrl && input.sha256) problemCode = ['BATCH_ITEM_CONTENT_AMBIGUOUS', 'An item gives fetchUrl or described content, not both'];
    else if (b.scope && input.path && !input.path.startsWith(b.scope.folderPath)) problemCode = ['VALIDATION_FAILED', `${input.path} is outside the batch's scope ${b.scope.folderPath}`];
    if (problemCode) return { index, status: 'failed', code: problemCode[0], detail: problemCode[1] };
    const n = ++b.itemSeq;
    const it = { id: `item-${String(n).padStart(5, '0')}`, ...input, status: 'draft', etagN: 1 };
    b.items.push(it);
    return { index, status: 'created', item: itemBody(it) };
  });
}

/** Works out each item's outcome and resolution under the batch's policy. */
function plan(b) {
  const docs = state.knowledgeBases.get(b.knowledgeBaseId) ?? [];
  const rules = b.policy?.onConflict ?? {};
  let failed = false;
  for (const it of b.items) {
    const match = (it.externalId && docs.find((d) => d.externalId === it.externalId)) || (it.path && docs.find((d) => docPath(d) === it.path));
    const matches = match ? [{ documentId: match.id, path: docPath(match), ...(match.version ? { version: match.version } : {}), ...(match.sha256 ? { sha256: match.sha256 } : {}) }] : [];
    const conflict = faults.planConflicts?.[it.path] ?? faults.planConflicts?.[it.id];
    delete it.reason;
    if (conflict) {
      it.outcome = 'conflict';
      it.reason = conflict;
      const rule = rules[RULE_KEY[conflict]] ?? rules.default ?? 'ask';
      if (rule === 'fail') failed = true;
      if (!it.handResolved) it.resolution = rule === 'ask' ? 'unresolved' : rule === 'fail' ? 'unresolved' : rule;
    } else if ((it.action ?? 'ingest') === 'remove') {
      it.outcome = match ? 'to_remove' : 'unchanged';
      if (!it.handResolved) it.resolution = match ? (b.policy?.onRemove ?? 'remove') === 'ask' ? 'unresolved' : (b.policy?.onRemove ?? 'remove') : 'skip';
    } else if (!match) {
      it.outcome = 'new';
      if (!it.handResolved) it.resolution = 'add';
    } else if (match.sha256 === it.sha256) {
      it.outcome = 'unchanged';
      if (!it.handResolved) it.resolution = (b.policy?.onUnchanged ?? 'skip') === 'reingest' ? 'new_version' : 'skip';
    } else {
      it.outcome = 'changed';
      if (!it.handResolved) it.resolution = 'new_version';
    }
    if (matches.length) it.matches = matches;
    else delete it.matches;
  }
  // A failed batch says why, as IngestionBatch.failure does: a conflict whose rule is `fail`, or planning that could
  // not finish (the planFails fault). The messages are the model's fixed ones for each code.
  const failure = faults.planFails ? 'planning_failed' : failed ? 'conflict_policy_fail' : null;
  b.planned = true;
  b.status = failure ? 'failed' : 'planned';
  if (failure) {
    b.endedAt = nowIso();
    b.failure = { code: failure, message: BATCH_FAILURES[failure] };
  }
  b.planExpiresAt = new Date(Date.now() + 5 * 60_000).toISOString();
  touch(b);
  if (b.status === 'planned' && b.startsWhenPlanned && !b.items.some((it) => it.resolution === 'unresolved')) startBatch(b, { headers: { host: b.host } });
}

/** IngestionBatchFailureCode's fixed messages (the model's IngestionBatchFailure). */
const BATCH_FAILURES = {
  conflict_policy_fail:
    'An item had a conflict whose policy rule is `fail`, so the batch stopped before anything was changed. List the items with `filter[outcome][eq]=conflict` to see which, then make a new batch with a different policy or fix the clashes.',
  planning_failed: 'Planning could not finish, for example because the knowledge base stopped being `ready`. Nothing was changed; make a new batch.',
};

function startPlanning(b) {
  b.status = 'planning';
  b.planningReadsLeft = faults.planningReads ?? 0;
  touch(b);
}

function newPolicy(b, req, seconds) {
  b.policyGeneration++;
  const reservation = faults.uploadReservation;
  if (reservation) {
    seconds = reservation.policySeconds;
    b.uploadsExpireAt = new Date(Date.now() + reservation.reservationSeconds * 1000).toISOString();
    b.reservedByPolicy = true;
  }
  // A batch made with uploadWindowSeconds: every policy lasts the window, and each issue moves the deadline to the
  // policy's expiry plus a grace of 5 minutes, or of the window when that is shorter (PROTOCOL.md 15, short windows).
  if (b.uploadWindowSeconds && !reservation) {
    seconds = b.uploadWindowSeconds;
    b.uploadsExpireAt = new Date(Date.now() + (seconds + Math.min(300, b.uploadWindowSeconds)) * 1000).toISOString();
  }
  const expiresAt = new Date(Date.now() + seconds * 1000).toISOString();
  const doc = { expiration: expiresAt, batchId: b.id, generation: b.policyGeneration, conditions: [['starts-with', '$key', b.keyPrefix], ['eq', '$x-amz-checksum-algorithm', 'SHA256'], ['content-length-range', 1, MAX_FILE]] };
  const policy = Buffer.from(JSON.stringify(doc)).toString('base64');
  const signature = crypto.createHmac('sha256', UPLOAD_SECRET).update(policy).digest('hex');
  const date = expiresAt.replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const values = { bucket: 'mock-bucket', key: `${b.keyPrefix}${'${filename}'}`, 'x-amz-algorithm': 'AWS4-HMAC-SHA256', 'x-amz-credential': `MOCKKEY/${date.slice(0, 8)}/ap-southeast-2/s3/aws4_request`, 'x-amz-date': date, policy, 'x-amz-signature': signature };
  const formFields = Object.fromEntries(FORM_FIELD_ORDER.map((k) => [k, values[k]]));
  return { uploadUrl: `http://${req.headers.host}/__s3/`, formFields, keyPrefix: b.keyPrefix, maxByteSize: MAX_FILE, expiresAt };
}

/** Moves a running batch on by one read: items ingesting count down, then are indexed; then the batch ends. */
function advance(b) {
  if (b.status !== 'running') return;

  for (const it of b.items) {
    if (it.status !== 'ingesting') continue;
    if (it.readsLeft > 0) it.readsLeft--;
    else if (faults.cancelItems?.[it.path] || faults.cancelItems?.[it.id]) {
      it.status = 'cancelled';
      it.etagN++;
    } else finishItem(b, it);
  }
  // The deadline sweep, for a batch with a caller-set window: once its uploadsExpireAt has passed, each item still
  // awaiting its upload, whose bytes did not arrive in time, fails UPLOAD_EXPIRED, as the server's sweep does. (Bytes
  // that arrived before the deadline keep their item, whenever Complete reports them: the arrival rule.)
  if (b.uploadWindowSeconds && b.uploadsExpireAt && Date.now() > Date.parse(b.uploadsExpireAt)) {
    const deadline = Date.parse(b.uploadsExpireAt);
    for (const it of b.items) {
      const arrived = it.objectKey && state.objects.get(it.objectKey);
      if (it.status === 'awaiting_upload' && !(arrived && arrived.arrivedAt <= deadline)) {
        Object.assign(it, { status: 'failed', failureCode: 'UPLOAD_EXPIRED', failureDetail: 'No bytes arrived before the upload policy expired.', etagN: it.etagN + 1 });
      }
    }
  }
  // The sweep: items whose uploads always fail (failUploads) are failed once nothing else is left to finish.
  const rest = b.items.filter((it) => !FINAL_ITEM.has(it.status));
  const doomed = (it) => it.status === 'awaiting_upload' && (faults.failUploads?.[it.path] || faults.failUploads?.[it.id]);
  if (rest.length && rest.every(doomed)) {
    for (const it of rest) Object.assign(it, { status: 'failed', failureCode: 'UPLOAD_EXPIRED', failureDetail: 'No bytes arrived before the upload policy expired.', etagN: it.etagN + 1 });
  }
  if (b.items.every((it) => FINAL_ITEM.has(it.status))) {
    b.status = b.items.some((it) => it.status === 'failed') ? 'completed_with_failures' : 'succeeded';
    b.endedAt = nowIso();
    touch(b);
  }
}

/** faults.deadlinePassed: the read that finds a batch past its deadline ends it, as the v3 server's reads do. */
function endOnRead(b) {
  delete b.endsOnRead;
  b.endedOnRead = true;
  if (b.status === 'running') {
    for (const it of b.items) {
      if (it.status === 'awaiting_upload') Object.assign(it, { status: 'failed', failureCode: 'UPLOAD_EXPIRED', failureDetail: 'No bytes arrived before the upload policy expired.', etagN: it.etagN + 1 });
      else if (it.status === 'ingesting') finishItem(b, it);
    }
    b.status = b.items.some((it) => it.status === 'failed') ? 'completed_with_failures' : 'succeeded';
    b.endedAt = nowIso();
    touch(b);
  }
}

/** An ingesting item is indexed: its document is made (add) or given a new version (new_version, overwrite). */
function finishItem(b, it) {
  const docs = state.knowledgeBases.get(b.knowledgeBaseId);
  const { folder, name } = splitPath(it.path);
  const existing = docs.find((d) => d.id === it.matches?.[0]?.documentId);
  if (it.resolution === 'add' || !existing) {
    const doc = newDocument(b.knowledgeBaseId, { name, folder, contentType: it.contentType, byteSize: it.byteSize, sha256: it.sha256, externalId: it.externalId, sourceUrl: it.sourceUrl, metadata: it.metadata });
    const v = versionsOf.get(doc)[0];
    v.status = 'indexed';
    makeCurrent(doc, v);
    docs.push(doc);
    it.documentId = doc.id;
    it.version = 1;
  } else {
    const doc = existing;
    {
      const versions = versionsOf.get(doc);
      const v = { number: versions.length + 1, status: 'indexed', contentType: it.contentType, byteSize: Number(it.byteSize), sha256: it.sha256, createdAt: nowIso() };
      versions.push(v);
      doc.versionCount = versions.length;
      makeCurrent(doc, v);
      it.documentId = doc.id;
      it.version = v.number;
    }
  }
  it.status = 'indexed';
  it.etagN++;
}

function findBatch(id, kb) {
  const b = state.batches.get(decodeURIComponent(id));
  return b && (kb === undefined || b.knowledgeBaseId === decodeURIComponent(kb)) ? b : undefined;
}

async function createIngestionBatch(req, res, rid, [kbId], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateIngestionBatch', res, rid)) return;
  const input = parseJson(body);
  const result = idempotent(key, 'CreateIngestionBatch', () => {
    const knowledgeBaseId = decodeURIComponent(kbId);
    if (!state.knowledgeBases.has(knowledgeBaseId)) return { status: 404, problem: ['NOT_FOUND', `No knowledge base ${knowledgeBaseId}`] };
    if (input.start !== undefined && !['when_planned', 'manual'].includes(input.start)) return { status: 400, problem: ['VALIDATION_FAILED', 'start is when_planned or manual', { fieldErrors: [{ pointer: '/start', code: 'VALIDATION_FAILED' }] }] };
    const items = input.items ?? [];
    if (items.length > 10_000) return { status: 400, problem: ['VALIDATION_FAILED', 'A request takes at most 10,000 items', { fieldErrors: [{ pointer: '/items', code: 'VALIDATION_FAILED' }] }] };
    const [uploadWindowSeconds, badWindow] = windowSeconds(input, 'uploadWindowSeconds');
    if (badWindow) return badWindow;
    const id = crypto.randomUUID();
    const now = nowIso();
    const b = {
      id,
      knowledgeBaseId,
      status: 'draft',
      start: input.start ?? 'when_planned',
      // A batch created with start: when_planned said so is started by the mock once it is planned with nothing
      // unresolved, as the server does (batch-upload.not-started). Left unsaid, it stays planned, as before.
      startsWhenPlanned: input.start === 'when_planned',
      awaitMoreItems: input.awaitMoreItems === true,
      policy: input.policy ?? { onConflict: { default: 'ask' } },
      ...(input.scope ? { scope: input.scope } : {}),
      ...(uploadWindowSeconds ? { uploadWindowSeconds } : {}),
      items: [],
      itemSeq: 0,
      etagN: 1,
      policyGeneration: 0,
      keyPrefix: `batches/${id}/`,
      createdAt: now,
      updatedAt: now,
    };
    const results = addItems(b, items);
    if (faults.strayItem) addItems(b, [{ action: 'ingest', path: faults.strayItem, sha256: crypto.createHash('sha256').update('stray').digest('base64'), byteSize: 5, contentType: 'application/pdf' }]);
    const failed = results.find((r) => r.status === 'failed');
    if (failed) return { status: 400, problem: ['VALIDATION_FAILED', `Item ${failed.index}: ${failed.detail}`, { fieldErrors: [{ pointer: `/items/${failed.index}`, code: failed.code }] }] };
    state.batches.set(id, b);
    if (!b.awaitMoreItems) startPlanning(b);
    return { status: 202, body: batchBody(b), batch: b };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { ETag: batchEtag(result.batch), Location: `/api/v3/knowledge-bases/${result.batch.knowledgeBaseId}/ingestion-batches/${result.body.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

async function listIngestionBatches(req, res, rid, [kb]) {
  if (statusFault('ListIngestionBatches', res, rid)) return;
  sendJson(res, rid, 200, { items: [...state.batches.values()].filter((b) => b.knowledgeBaseId === decodeURIComponent(kb)).map((b) => batchBody(b, true)) });
}

/** Starts a planned batch: each item that needs bytes awaits its upload, the rest end now. Returns the upload policy. */
function startBatch(b, req) {
  const docs = state.knowledgeBases.get(b.knowledgeBaseId);
  for (const it of b.items) {
    if (['add', 'new_version', 'overwrite'].includes(it.resolution)) {
      it.status = 'awaiting_upload';
      it.objectKey = `${b.keyPrefix}${urlSafe(it.sha256)}.${extensionOf(it.path ?? '')}`;
    } else if (it.resolution === 'remove') {
      const doc = docs.find((d) => d.id === it.matches?.[0]?.documentId);
      if (doc) docs.splice(docs.indexOf(doc), 1);
      it.status = 'removed';
    } else if (it.resolution === 'move') it.status = 'moved';
    else if (it.resolution === 'update_metadata') it.status = 'updated';
    else it.status = 'skipped';
    it.etagN++;
  }
  b.status = 'running';
  b.startedAt = nowIso();
  touch(b);
  const needsBytes = b.items.some((it) => it.status === 'awaiting_upload');
  const uploadPolicy = needsBytes ? newPolicy(b, req, faults.policySeconds ?? 1800) : undefined;
  // When the items awaiting upload are given up: the policy's expiry plus the server's grace, here 15 minutes.
  if (!b.reservedByPolicy && !(b.uploadWindowSeconds && needsBytes)) b.uploadsExpireAt = new Date(Date.now() + (faults.deadlinePassed === 'uploads' ? -60_000 : ((faults.policySeconds ?? 1800) + 900) * 1000)).toISOString();
  if (faults.deadlinePassed === 'uploads') b.endsOnRead = 'uploads';
  if (needsBytes && faults.startPolicyExpired) b.expiredGeneration = b.policyGeneration;
  if (!needsBytes) advance(b);
  return uploadPolicy;
}

// GetIngestionBatch: each read moves the batch on (planning, then ingesting items).
async function getIngestionBatch(req, res, rid, [kb, id]) {
  if (statusFault('GetIngestionBatch', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (b.endsOnRead) {
    endOnRead(b);
    return sendJson(res, rid, 200, batchBody(b), { ETag: batchEtag(b) });
  }
  if (b.status === 'planning') {
    if (b.planningReadsLeft > 0) b.planningReadsLeft--;
    else plan(b);
  } else advance(b);
  sendJson(res, rid, 200, batchBody(b), { ETag: batchEtag(b) });
}

function preconditions(req, res, rid, etag, { optional = false } = {}) {
  const ifMatch = req.headers['if-match'];
  if (!ifMatch && optional) return false; // @ifMatchOptional: no If-Match writes unconditionally
  if (!ifMatch) return problem(res, rid, 428, 'PRECONDITION_REQUIRED', 'Send the ETag you last read in If-Match.'), true;
  if (!etagMatches(ifMatch, etag)) return problem(res, rid, 412, 'PRECONDITION_FAILED', 'The resource changed since you read it. Read it again and reapply your change.'), true;
  return false;
}

// UpdateIngestionBatch: policy while draft or planned (a planned batch is resolved again); awaitMoreItems false ends
// the draft and starts planning.
async function updateIngestionBatch(req, res, rid, [kb, id], url, body) {
  if (statusFault('UpdateIngestionBatch', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (preconditions(req, res, rid, batchEtag(b))) return;
  const input = parseJson(body);
  if (!['draft', 'planned'].includes(b.status) || (input.awaitMoreItems !== undefined && b.status !== 'draft')) {
    return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} is ${b.status}.`);
  }
  if (input.policy) b.policy = input.policy;
  if (input.awaitMoreItems === false) {
    b.awaitMoreItems = false;
    startPlanning(b);
  } else if (b.status === 'planned' && input.policy) plan(b);
  else touch(b);
  sendJson(res, rid, 200, batchBody(b), { ETag: batchEtag(b) });
}

// BatchCreateIngestionBatchItems: up to 1,000 more items while the batch is draft. It does not change the batch's
// ETag: items added to a draft change nothing the ETag guards, so the ETag from CreateIngestionBatch still holds
// for the UpdateIngestionBatch that ends the draft.
async function batchCreateItems(req, res, rid, [kb, id], url, body) {
  if (statusFault('BatchCreateIngestionBatchItems', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (b.status !== 'draft') return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} is ${b.status}, not draft.`);
  const input = parseJson(body);
  const items = input.items ?? [];
  if (items.length < 1 || items.length > 10_000) return problem(res, rid, 400, 'VALIDATION_FAILED', 'A request takes 1 to 10,000 items', { fieldErrors: [{ pointer: '/items', code: 'VALIDATION_FAILED' }] });
  if (b.items.length + items.length > 100_000) return problem(res, rid, 400, 'VALIDATION_FAILED', 'A batch takes at most 100,000 items', { fieldErrors: [{ pointer: '/items', code: 'VALIDATION_FAILED' }] });
  b.updatedAt = nowIso();
  const results = addItems(b, items);
  // `last: true`: the batch stops taking items and is planned (UpdateIngestionBatch's awaitMoreItems false, before).
  if (input.last === true) {
    b.awaitMoreItems = false;
    startPlanning(b);
  }
  sendJson(res, rid, 200, { results });
}

const ITEM_FILTERS = { 'filter[action][eq]': (it) => it.action ?? 'ingest', 'filter[outcome][eq]': (it) => it.outcome, 'filter[status][eq]': (it) => it.status, 'filter[resolution][eq]': (it) => it.resolution };

async function listItems(req, res, rid, [kb, id], url) {
  if (statusFault('ListIngestionBatchItems', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  for (const key of url.searchParams.keys()) {
    if (!['limit', 'cursor', ...Object.keys(ITEM_FILTERS)].includes(key)) return problem(res, rid, 400, 'UNKNOWN_FILTER', `Unknown query parameter ${key}`, { fieldErrors: [{ parameter: key, code: 'UNKNOWN_FILTER' }] });
  }
  let items = b.items;
  for (const [param, get] of Object.entries(ITEM_FILTERS)) {
    const v = url.searchParams.get(param);
    if (v !== null) items = items.filter((it) => get(it) === v);
  }
  const limit = Math.min(Number(url.searchParams.get('limit') ?? 100), 1000);
  const cursor = url.searchParams.get('cursor');
  const start = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()).offset : 0;
  const page = items.slice(start, start + limit);
  const next = start + limit < items.length ? Buffer.from(JSON.stringify({ offset: start + limit })).toString('base64url') : undefined;
  sendJson(res, rid, 200, { items: page.map(itemBody), ...(next ? { nextCursor: next } : {}) });
}

async function getItem(req, res, rid, [kb, id, itemId]) {
  if (statusFault('GetIngestionBatchItem', res, rid)) return;
  const it = findBatch(id, kb)?.items.find((x) => x.id === decodeURIComponent(itemId));
  if (!it) return problem(res, rid, 404, 'NOT_FOUND', `No item ${itemId}`);
  const { etag, ...rest } = itemBody(it);
  sendJson(res, rid, 200, rest, { ETag: etag });
}

// UpdateIngestionBatchItem: a resolution by hand, while the batch is planned (the batch's ETag changes too).
async function updateItem(req, res, rid, [kb, id, itemId], url, body) {
  if (statusFault('UpdateIngestionBatchItem', res, rid)) return;
  const b = findBatch(id, kb);
  const it = b?.items.find((x) => x.id === decodeURIComponent(itemId));
  if (!it) return problem(res, rid, 404, 'NOT_FOUND', `No item ${itemId}`);
  if (preconditions(req, res, rid, itemEtag(it), { optional: true })) return; // @ifMatchOptional
  if (b.status !== 'planned') return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} is ${b.status}, not planned.`);
  const { resolution, ...other } = parseJson(body);
  if (Object.keys(other).length) return problem(res, rid, 409, 'CONFLICT', 'Only resolution can change');
  if (!(RESOLUTIONS[it.outcome] ?? []).includes(resolution)) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', `${resolution} does not fit a ${it.outcome} item`, { fieldErrors: [{ pointer: '/resolution', code: 'VALIDATION_FAILED' }] });
  }
  it.resolution = resolution;
  it.handResolved = true;
  it.etagN++;
  touch(b);
  const { etag, ...rest } = itemBody(it);
  sendJson(res, rid, 200, rest, { ETag: etag });
}

// CancelIngestionBatchItem: an item of a running batch still awaiting its upload becomes `cancelled`, and the path it
// reserved is free again; any other item is 409 CONFLICT. If-Match is optional. Once no item is left unfinished, the
// batch ends, as it would after its last upload.
async function cancelItem(req, res, rid, [kb, id, itemId]) {
  if (statusFault('CancelIngestionBatchItem', res, rid)) return;
  const b = findBatch(id, kb);
  const it = b?.items.find((x) => x.id === decodeURIComponent(itemId));
  if (!it) return problem(res, rid, 404, 'NOT_FOUND', `No item ${decodeURIComponent(itemId)}`);
  if (preconditions(req, res, rid, itemEtag(it), { optional: true })) return; // @ifMatchOptional
  if (b.status !== 'running' || it.status !== 'awaiting_upload') {
    return problem(res, rid, 409, 'CONFLICT', `Item ${it.id} is ${it.status}; only an item waiting for its upload can be cancelled.`);
  }
  it.status = 'cancelled';
  it.etagN++;
  touch(b);
  const { etag, ...rest } = itemBody(it);
  sendJson(res, rid, 200, { item: { ...rest, etag } }, { ETag: etag });
}

async function startIngestionBatch(req, res, rid, [kb, id]) {
  if (statusFault('StartIngestionBatch', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (preconditions(req, res, rid, batchEtag(b), { optional: true })) return; // @ifMatchOptional: no If-Match starts the batch as it stands
  if (b.status !== 'planned') return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} is ${b.status}, not planned.`);
  const unresolved = b.items.filter((it) => it.resolution === 'unresolved').length;
  if (unresolved) {
    return problem(res, rid, 409, 'INGESTION_BATCH_UNRESOLVED', `${unresolved} item${unresolved === 1 ? ' is' : 's are'} unresolved. Resolve ${unresolved === 1 ? 'it' : 'them'} with UpdateIngestionBatchItem, or change the batch's policy.`);
  }
  const uploadPolicy = startBatch(b, req);
  sendJson(res, rid, 202, { batch: batchBody(b, true), ...(uploadPolicy ? { uploadPolicy } : {}) }, { ETag: batchEtag(b) });
}

async function createUploadPolicy(req, res, rid, [kb, id]) {
  state.policiesAsked++;
  if (statusFault('CreateIngestionBatchUploadPolicy', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (b.status !== 'running' || !b.items.some((it) => it.status === 'awaiting_upload')) {
    return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} has nothing left to upload.`);
  }
  // Only a batch's first created policy is short, so the renewal it causes lasts and the upload keep-alive (which
  // renews at most once a second while any policy is short) has nothing more to do: the count stays exact.
  b.createdPolicies = (b.createdPolicies ?? 0) + 1;
  const uploadPolicy = newPolicy(b, req, b.createdPolicies === 1 ? (faults.renewedPolicySeconds ?? 1800) : 1800);
  if (faults.policyExpiresAt === null) delete uploadPolicy.expiresAt;
  else if (faults.policyExpiresAt !== undefined) uploadPolicy.expiresAt = faults.policyExpiresAt;
  if (faults.firstCreatedPolicyExpired && !b.createdPolicyExpired) {
    b.createdPolicyExpired = true;
    b.expiredGeneration = b.policyGeneration;
  }
  sendJson(res, rid, 201, { uploadPolicy }, { Location: `/api/v3/knowledge-bases/${b.knowledgeBaseId}/ingestion-batches/${b.id}` });
}

// CompleteIngestionBatchUploads: 1 to 100 distinct item ids; a result for each, in request order.
async function completeUploads(req, res, rid, [kb, id], url, body) {
  if (faults.completeDelayMs) await sleep(faults.completeDelayMs);
  if (statusFault('CompleteIngestionBatchUploads', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  const ids = parseJson(body).itemIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || new Set(ids).size !== ids.length) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', 'itemIds must hold 1 to 100 identifiers, each at most once', { fieldErrors: [{ pointer: '/itemIds', code: 'VALIDATION_FAILED' }] });
  }
  const results = ids.map((itemId) => {
    const it = b.items.find((x) => x.id === itemId);
    if (!it || it.status !== 'awaiting_upload') return { itemId, status: 'failed', code: 'CONFLICT', detail: `Item ${itemId} is not awaiting upload.` };
    const obj = state.objects.get(it.objectKey);
    if (!obj) return { itemId, status: 'failed', code: 'NOT_FOUND', detail: `Nothing was uploaded to ${it.objectKey}.` };
    if (obj.late) {
      Object.assign(it, { status: 'failed', failureCode: 'UPLOAD_EXPIRED', failureDetail: 'The bytes arrived after the batch stopped waiting for them.', etagN: it.etagN + 1 });
      return { itemId, status: 'failed', code: 'UPLOAD_EXPIRED', detail: `The bytes for ${it.objectKey} arrived after the upload deadline.` };
    }
    const key = it.path in (faults.checksumMismatch ?? {}) ? it.path : it.id;
    const injected = (faults.checksumMismatch?.[key] ?? 0) > 0;
    if (injected) faults.checksumMismatch[key]--;
    if (injected || obj.sha256 !== it.sha256 || obj.byteSize !== Number(it.byteSize)) {
      state.objects.delete(it.objectKey);
      return { itemId, status: 'failed', code: 'CHECKSUM_MISMATCH', detail: `The object at ${it.objectKey} does not match the item's SHA-256 and size. Upload it again.` };
    }
    it.status = 'ingesting';
    it.readsLeft = faults.ingestReads ?? 1;
    it.etagN++;
    return { itemId, status: 'accepted' };
  });
  b.updatedAt = nowIso();
  sendJson(res, rid, 200, { results });
}

// CancelIngestionBatch: items not yet uploaded stop; with ingestion: stop, so do those ingesting. 409 when final.
async function cancelIngestionBatch(req, res, rid, [kb, id], url, body) {
  if (statusFault('CancelIngestionBatch', res, rid)) return;
  const b = findBatch(id, kb);
  if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${id}`);
  if (FINAL_BATCH.has(b.status)) return problem(res, rid, 409, 'CONFLICT', `Ingestion batch ${b.id} is ${b.status}.`);
  const stop = parseJson(body).stopRunning === true;
  b.cancelledWith = stop ? 'stop' : 'finish';
  for (const it of b.items) {
    if (FINAL_ITEM.has(it.status)) continue;
    if (it.status === 'ingesting' && !stop) {
      finishItem(b, it);
      continue;
    }
    it.status = 'failed';
    it.failureCode = 'CANCELLED';
    it.failureDetail = 'The batch was cancelled.';
    it.etagN++;
  }
  b.status = 'cancelled';
  b.endedAt = nowIso();
  touch(b);
  sendJson(res, rid, 202, batchBody(b), { ETag: batchEtag(b) });
}

// ---------------------------------------------------------------------------
// Knowledge bases, folders, access and fields
// ---------------------------------------------------------------------------
//
// Each knowledge base has a record (state.kbs): its name and status, the roles' access to it, its folders (the root
// `/` included, whose readers are the whole knowledge base's) and its metadata fields. Its documents stay in
// state.knowledgeBases. Folders, documents and the knowledge base each have an access ETag of their own.

function folderRecord(path, readers = { kind: 'inherit' }) {
  const parent = path === '/' ? '/' : path.slice(0, path.slice(0, -1).lastIndexOf('/') + 1);
  const name = path === '/' ? '/' : path.slice(parent.length, -1);
  return { path, parent, name, readers, etagN: 1, accessEtagN: 1, updatedAt: '2026-11-01T00:00:00.000Z' };
}

function kbRecord(id, name, status = 'ready') {
  const now = '2026-11-01T00:00:00.000Z';
  return {
    id,
    name,
    status,
    createdAt: now,
    updatedAt: now,
    etagN: 1,
    accessEtagN: 1,
    roles: [
      { roleId: 'staff', name: 'Staff', can: ['find', 'read'] },
      { roleId: 'hr-team', name: 'HR team', can: ['find', 'read', 'edit', 'delete'] },
    ],
    folders: new Map(
      ['/', '/policies/', '/hr/', '/hr/investigations/', '/archive/'].map((p) => [p, folderRecord(p, p === '/' ? { kind: 'everyone' } : { kind: 'inherit' })]),
    ),
    fields: new Map([['policyOwner', { key: 'policyOwner', name: 'Policy owner', type: 'text', scope: 'document', filterable: true, etagN: 1 }]]),
    layoutAwareSearch: false,
    // CreateKnowledgeBase: watch looks left before a `creating` knowledge base is `ready`.
    creatingTicks: 0,
  };
}

const kbEtag = (rec) => `"kb-${rec.id}-${rec.etagN}"`;
const folderEtag = (kb, f) => `"folder-${kb}-${f.path}-${f.etagN}"`;
const accessEtagOf = (n) => `"access-${n}"`;

function kbBody(rec, withEtag = true) {
  const docs = state.knowledgeBases.get(rec.id) ?? [];
  const body = {
    id: rec.id,
    name: rec.name,
    ...(rec.description ? { description: rec.description } : {}),
    status: rec.status,
    documentCounts: {
      processing: docs.filter((d) => d.status === 'pending' || d.status === 'processing').length,
      failed: docs.filter((d) => d.status === 'failed').length,
      outOfDate: docs.filter((d) => d.outOfDate).length,
    },
    ...(rec.layoutAwareSearch ? { engine: { embeddingModel: 'cohere.embed-v4', reads: 'text_and_images', dimensions: 1536, region: 'ap-southeast-2', searchType: 'layout_aware' } } : {}),
    createdAt: rec.createdAt,
    updatedAt: rec.updatedAt,
  };
  if (faults.unknownField) body.retentionPolicy = { keepDays: 365 };
  return withEtag ? { ...body, etag: kbEtag(rec) } : body;
}

/** The folder a document or folder inherits its readers from: the nearest one above with readers of its own. */
function inheritedFrom(rec, folderPath) {
  let p = folderPath;
  for (;;) {
    const f = rec.folders.get(p);
    if (f && f.readers.kind !== 'inherit') return p;
    if (p === '/') return '/';
    p = p.slice(0, p.slice(0, -1).lastIndexOf('/') + 1);
  }
}

function folderBody(kb, f) {
  const rec = state.kbs.get(kb);
  const docs = state.knowledgeBases.get(kb) ?? [];
  return {
    path: f.path,
    parent: f.parent,
    name: f.name,
    etag: folderEtag(kb, f),
    readers: f.readers,
    ...(f.readers.kind === 'inherit' && f.path !== '/' ? { inheritedFrom: inheritedFrom(rec, f.parent) } : {}),
    folderCount: [...rec.folders.values()].filter((x) => x.path !== '/' && x.parent === f.path).length,
    documentCount: docs.filter((d) => d.folder === f.path).length,
    updatedAt: f.updatedAt,
  };
}

/** A document as responses show it: its readers (inherited unless set) and where they come from. */
function docBody(d) {
  const rec = state.kbs.get(d.knowledgeBaseId);
  const { accessEtagN, ...rest } = d;
  const readers = d.readers ?? { kind: 'inherit' };
  return { ...rest, readers, ...(readers.kind === 'inherit' && rec ? { inheritedFrom: inheritedFrom(rec, d.folder) } : {}) };
}

/** The knowledge base's record and documents, or a 404 already sent. */
function kbOr404(res, rid, kb) {
  const id = decodeURIComponent(kb);
  const rec = state.kbs.get(id);
  if (!rec || !state.knowledgeBases.has(id)) {
    problem(res, rid, 404, 'NOT_FOUND', `No knowledge base ${id}`);
    return null;
  }
  return rec;
}

/** A folder label in a request path (`hr/leave`, without its first and last `/`) as the folder's path. */
const labelToFolder = (label) => `/${decodeURIComponent(label)}/`;

async function listKnowledgeBases(req, res, rid, _m, url) {
  if (statusFault('ListKnowledgeBases', res, rid)) return;
  const status = url.searchParams.get('filter[status][eq]');
  const items = [...state.kbs.values()].filter((r) => !status || r.status === status).map((r) => kbBody(r));
  sendJson(res, rid, 200, { items });
}

// CreateKnowledgeBase: 202 with the knowledge base `creating`; it is `ready` after `jobSteps` looks of a watch.
async function createKnowledgeBase(req, res, rid, _m, url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateKnowledgeBase', res, rid)) return;
  const input = parseJson(body);
  const result = idempotent(key, 'CreateKnowledgeBase', () => {
    if (input.name !== undefined && (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 128)) {
      return { status: 400, problem: ['VALIDATION_FAILED', 'name is 1 to 128 characters', { fieldErrors: [{ pointer: '/name', code: 'VALIDATION_FAILED' }] }] };
    }
    const id = `KB${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
    const rec = kbRecord(id, input.name ?? 'Untitled knowledge base', 'creating');
    rec.createdAt = rec.updatedAt = nowIso();
    if (input.description) rec.description = input.description;
    rec.creatingTicks = faults.jobSteps ?? 2;
    state.kbs.set(id, rec);
    state.knowledgeBases.set(id, []);
    return { status: 202, body: kbBody(rec, false), rec };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { ETag: kbEtag(result.rec), Location: `/api/v3/knowledge-bases/${result.body.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

async function getKnowledgeBase(req, res, rid, [kb]) {
  if (statusFault('GetKnowledgeBase', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  sendJson(res, rid, 200, kbBody(rec, false), { ETag: kbEtag(rec) });
}

async function updateKnowledgeBase(req, res, rid, [kb], url, body) {
  if (statusFault('UpdateKnowledgeBase', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  if (preconditions(req, res, rid, kbEtag(rec))) return;
  const { clear = [], ...patch } = parseJson(body);
  if (patch.name !== undefined) rec.name = patch.name;
  if (patch.description !== undefined) rec.description = patch.description;
  if (clear.includes('description')) delete rec.description;
  rec.etagN++;
  rec.updatedAt = nowIso();
  kbEvent(rec.id, 'knowledge_base.updated', { knowledgeBase: kbBody(rec) }, {});
  sendJson(res, rid, 200, kbBody(rec, false), { ETag: kbEtag(rec) });
}

// DeleteKnowledgeBase: 202 with the Operation; the knowledge base reads `deleting` until its job ends, then 404.
async function deleteKnowledgeBase(req, res, rid, [kb]) {
  if (statusFault('DeleteKnowledgeBase', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  rec.status = 'deleting';
  rec.etagN++;
  const job = rec.deletion ?? (rec.deletion = newJob(rec.id, 'knowledge_base_deletion', { type: 'knowledge_base', id: rec.id }, {
    finish: (status) => {
      if (status !== 'succeeded') return [];
      state.kbs.delete(rec.id);
      state.knowledgeBases.delete(rec.id);
      return [];
    },
  }));
  sendJson(res, rid, 202, { operation: jobBody(job) }, { Location: `/api/v3/knowledge-bases/${rec.id}/operations/${job.id}` });
}

// GetAccess and PutAccess: the knowledge base's roles, or (with `folder` or `document`) a folder's or a document's
// readers. One ETag for each. `readers: {kind: inherit}` is refused on the root folder, which has no parent.
function accessTarget(req, res, rid, kb, url) {
  const rec = kbOr404(res, rid, kb);
  if (!rec) return null;
  for (const k of url.searchParams.keys()) {
    if (!['folder', 'document'].includes(k)) return problem(res, rid, 400, 'UNKNOWN_FILTER', `Unknown query parameter ${k}`, { fieldErrors: [{ parameter: k, code: 'UNKNOWN_FILTER' }] }), null;
  }
  const folder = url.searchParams.get('folder');
  const document = url.searchParams.get('document');
  if (folder !== null && document !== null) return problem(res, rid, 400, 'VALIDATION_FAILED', 'Give folder or document, not both.'), null;
  if (folder !== null) {
    if (!FOLDER_PATH.test(folder)) return problem(res, rid, 400, 'VALIDATION_FAILED', FOLDER_DETAIL, { fieldErrors: [{ parameter: 'folder', code: 'VALIDATION_FAILED' }] }), null;
    const f = rec.folders.get(folder);
    if (!f) return problem(res, rid, 404, 'NOT_FOUND', `No folder ${folder}`), null;
    return { rec, kind: 'folder', f };
  }
  if (document !== null) {
    const d = state.knowledgeBases.get(rec.id).find((x) => x.id === document);
    if (!d) return problem(res, rid, 404, 'NOT_FOUND', `No document ${document}`), null;
    return { rec, kind: 'document', d };
  }
  return { rec, kind: 'knowledgeBase' };
}

function accessBody(t) {
  if (t.kind === 'knowledgeBase') return { body: { roles: t.rec.roles }, etag: accessEtagOf(`kb-${t.rec.accessEtagN}`) };
  if (t.kind === 'folder') {
    const readers = t.f.readers;
    return { body: { readers, ...(readers.kind === 'inherit' ? { inheritedFrom: inheritedFrom(t.rec, t.f.parent) } : {}) }, etag: accessEtagOf(`folder-${t.f.path}-${t.f.accessEtagN}`) };
  }
  const readers = t.d.readers ?? { kind: 'inherit' };
  return { body: { readers, ...(readers.kind === 'inherit' ? { inheritedFrom: inheritedFrom(t.rec, t.d.folder) } : {}) }, etag: accessEtagOf(`document-${t.d.id}-${t.d.accessEtagN ?? 1}`) };
}

async function getAccess(req, res, rid, [kb], url) {
  if (statusFault('GetAccess', res, rid)) return;
  const t = accessTarget(req, res, rid, kb, url);
  if (!t) return;
  const { body, etag } = accessBody(t);
  sendJson(res, rid, 200, body, { ETag: etag });
}

const READERS_KINDS = new Set(['inherit', 'public', 'everyone', 'specific']);

async function putAccess(req, res, rid, [kb], url, body) {
  if (statusFault('PutAccess', res, rid)) return;
  const t = accessTarget(req, res, rid, kb, url);
  if (!t) return;
  if (preconditions(req, res, rid, accessBody(t).etag, { optional: true })) return;
  const input = parseJson(body) ?? {};
  if (t.kind === 'knowledgeBase') {
    if (!Array.isArray(input.roles) || input.readers !== undefined) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'A knowledge base takes roles; readers are for a folder or a document.', { fieldErrors: [{ pointer: '/roles', code: 'VALIDATION_FAILED' }] });
    }
    t.rec.roles = input.roles;
    t.rec.accessEtagN++;
  } else {
    // A knowledge base's role grants are set only without a target (PutAccess): roles with a folder or document is 400.
    if (input.roles !== undefined) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'roles are the knowledge base\'s own: send them without folder or document.', { fieldErrors: [{ pointer: '/roles', code: 'VALIDATION_FAILED' }] });
    }
    const r = input.readers;
    if (!r || typeof r !== 'object' || !READERS_KINDS.has(r.kind)) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'readers is {kind: inherit | public | everyone | specific, roles?, people?}', { fieldErrors: [{ pointer: '/readers', code: 'VALIDATION_FAILED' }] });
    }
    if (r.kind === 'specific' && !(r.roles?.length || r.people?.length)) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', '`specific` readers name at least one role or person.', { fieldErrors: [{ pointer: '/readers', code: 'VALIDATION_FAILED' }] });
    }
    if (r.kind !== 'specific' && (r.roles !== undefined || r.people !== undefined)) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'Only `specific` readers list roles and people.', { fieldErrors: [{ pointer: '/readers', code: 'VALIDATION_FAILED' }] });
    }
    if (t.kind === 'folder' && t.f.path === '/' && r.kind === 'inherit') {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'The root folder has no parent to inherit from.', { fieldErrors: [{ pointer: '/readers/kind', code: 'VALIDATION_FAILED' }] });
    }
    const readers = { kind: r.kind, ...(r.roles ? { roles: r.roles } : {}), ...(r.people ? { people: r.people } : {}) };
    if (t.kind === 'folder') {
      t.f.readers = readers;
      t.f.accessEtagN++;
      t.f.etagN++;
      t.f.updatedAt = nowIso();
      kbEvent(t.rec.id, 'folder.updated', { folder: folderBody(t.rec.id, t.f) }, { folder: t.f.path });
    } else {
      t.d.readers = readers;
      t.d.accessEtagN = (t.d.accessEtagN ?? 1) + 1;
      bumpDoc(t.d);
      kbEvent(t.rec.id, 'document.updated', { document: docBody(t.d) }, { document: t.d.id, folder: t.d.folder });
    }
  }
  const { body: out, etag } = accessBody(t);
  sendJson(res, rid, 200, out, { ETag: etag });
}

// ---- Folders

async function listFolders(req, res, rid, [kb], url) {
  if (statusFault('ListFolders', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const parent = url.searchParams.get('filter[parent][eq]');
  const deep = url.searchParams.get('deep') === 'true';
  let items = [...rec.folders.values()].filter((f) => f.path !== '/');
  if (parent !== null) items = items.filter((f) => (deep ? f.path.startsWith(parent) && f.path !== parent : f.parent === parent));
  sendJson(res, rid, 200, { items: items.map((f) => folderBody(rec.id, f)) });
}

// CreateFolder: the folder exists at once (with its parents); a folder_change job follows it.
async function createFolder(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateFolder', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const input = parseJson(body);
  if (!FOLDER_PATH.test(input?.path ?? '') || input.path === '/') return problem(res, rid, 400, 'VALIDATION_FAILED', FOLDER_DETAIL, { fieldErrors: [{ pointer: '/path', code: 'VALIDATION_FAILED' }] });
  const result = idempotent(key, `CreateFolder:${rec.id}`, () => {
    if (rec.folders.has(input.path)) return { status: 409, problem: ['ALREADY_EXISTS', `Folder ${input.path} already exists.`] };
    const segs = input.path.split('/').filter(Boolean);
    for (let i = 1; i <= segs.length; i++) {
      const p = `/${segs.slice(0, i).join('/')}/`;
      if (!rec.folders.has(p)) rec.folders.set(p, folderRecord(p));
    }
    const f = rec.folders.get(input.path);
    const job = newJob(rec.id, 'folder_change', { type: 'folder', id: f.path, knowledgeBaseId: rec.id }, {
      finish: () => [['folder.created', { folder: folderBody(rec.id, f) }, { folder: f.path }]],
    });
    return { status: 202, body: { operation: jobBody(job) } };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { Location: `/api/v3/knowledge-bases/${rec.id}/folders/${input.path.slice(1, -1)}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

// UpdateFolder: rename (`name`) or move (`parent`); applied at once, with a folder_change job.
async function updateFolder(req, res, rid, [kb, label], url, body) {
  if (statusFault('UpdateFolder', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const path = labelToFolder(label);
  const f = rec.folders.get(path);
  if (!f) return problem(res, rid, 404, 'NOT_FOUND', `No folder ${path}`);
  if (preconditions(req, res, rid, folderEtag(rec.id, f))) return;
  const input = parseJson(body);
  const parent = input.parent ?? f.parent;
  const name = input.name ?? f.name;
  const next = `${parent}${name}/`;
  if (next !== path) {
    if (rec.folders.has(next)) return problem(res, rid, 409, 'ALREADY_EXISTS', `Folder ${next} already exists.`);
    for (const [p, x] of [...rec.folders]) {
      if (!p.startsWith(path)) continue;
      rec.folders.delete(p);
      const moved = folderRecord(next + p.slice(path.length), x.readers);
      moved.etagN = x.etagN + 1;
      rec.folders.set(moved.path, moved);
    }
    for (const d of state.knowledgeBases.get(rec.id)) if (d.folder.startsWith(path)) d.folder = next + d.folder.slice(path.length);
  } else f.etagN++;
  const moved = rec.folders.get(next);
  const job = newJob(rec.id, 'folder_change', { type: 'folder', id: next, knowledgeBaseId: rec.id }, {
    finish: () => [['folder.updated', { folder: folderBody(rec.id, moved) }, { folder: next }]],
  });
  sendJson(res, rid, 202, { operation: jobBody(job) }, { ETag: folderEtag(rec.id, moved), Location: `/api/v3/knowledge-bases/${rec.id}/folders/${next.slice(1, -1)}` });
}

// DeleteFolder: a folder_change job; when it ends, the folder and everything in it are gone.
async function deleteFolder(req, res, rid, [kb, label]) {
  if (statusFault('DeleteFolder', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const path = labelToFolder(label);
  if (!rec.folders.has(path)) return problem(res, rid, 404, 'NOT_FOUND', `No folder ${path}`);
  const job = newJob(rec.id, 'folder_change', { type: 'folder', id: path, knowledgeBaseId: rec.id }, {
    finish: (status) => {
      if (status !== 'succeeded') return [];
      const events = [];
      const docs = state.knowledgeBases.get(rec.id) ?? [];
      for (const d of docs.filter((x) => x.folder.startsWith(path))) {
        stopProcessing(d); // a document still being processed goes too: its processing stops
        docs.splice(docs.indexOf(d), 1);
        events.push(['document.deleted', { documentId: d.id }, { document: d.id, folder: d.folder }]);
      }
      for (const p of [...rec.folders.keys()]) if (p.startsWith(path)) rec.folders.delete(p);
      events.push(['folder.deleted', { path }, { folder: path }]);
      return events;
    },
  });
  sendJson(res, rid, 202, { operation: jobBody(job) }, { Location: `/api/v3/knowledge-bases/${rec.id}/operations/${job.id}` });
}

// ---- Fields, fill-ins, reprocessing, layout-aware search and estimates

const fieldEtag = (kb, f) => `"field-${kb}-${f.key}-${f.etagN}"`;
function fieldBody(kb, f, withEtag = true) {
  const { etagN, ...rest } = f;
  const docs = state.knowledgeBases.get(kb) ?? [];
  const missing = docs.filter((d) => d.metadata?.[f.key] === undefined).length;
  return { ...rest, needsWork: { values: missing, index: 0, embed: 0, documents: missing }, ...(withEtag ? { etag: fieldEtag(kb, f) } : {}) };
}
const FIELD_MEMBERS = ['name', 'description', 'type', 'scope', 'choices', 'partialDates', 'instructions', 'filterable', 'givenToAgent', 'visibleOnDocuments'];

async function listFields(req, res, rid, [kb]) {
  if (statusFault('ListFields', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  sendJson(res, rid, 200, { items: [...rec.fields.values()].map((f) => fieldBody(rec.id, f)) });
}

async function createField(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateField', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const input = parseJson(body);
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(input?.key ?? '')) return problem(res, rid, 400, 'VALIDATION_FAILED', 'key is letters, digits and _, starting with a letter', { fieldErrors: [{ pointer: '/key', code: 'VALIDATION_FAILED' }] });
  const result = idempotent(key, `CreateField:${rec.id}`, () => {
    if (rec.fields.has(input.key)) return { status: 409, problem: ['ALREADY_EXISTS', `Field ${input.key} already exists.`] };
    const f = { key: input.key, etagN: 1 };
    for (const m of FIELD_MEMBERS) if (input[m] !== undefined) f[m] = input[m];
    rec.fields.set(f.key, f);
    return { status: 201, body: fieldBody(rec.id, f, false), f };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { ETag: fieldEtag(rec.id, result.f), Location: `/api/v3/knowledge-bases/${rec.id}/fields/${result.f.key}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

function fieldOr404(res, rid, rec, key) {
  const f = rec.fields.get(decodeURIComponent(key));
  if (!f) problem(res, rid, 404, 'NOT_FOUND', `No field ${decodeURIComponent(key)}`);
  return f;
}

async function getField(req, res, rid, [kb, key]) {
  if (statusFault('GetField', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  const f = rec && fieldOr404(res, rid, rec, key);
  if (!f) return;
  sendJson(res, rid, 200, fieldBody(rec.id, f, false), { ETag: fieldEtag(rec.id, f) });
}

// UpdateField: If-Match is optional (@ifMatchOptional); a stale one is still refused.
async function updateField(req, res, rid, [kb, key], url, body) {
  if (statusFault('UpdateField', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  const f = rec && fieldOr404(res, rid, rec, key);
  if (!f) return;
  const ifMatch = req.headers['if-match'];
  if (ifMatch && !etagMatches(ifMatch, fieldEtag(rec.id, f))) return problem(res, rid, 412, 'PRECONDITION_FAILED', `Field ${f.key} changed since you read it.`);
  const input = parseJson(body);
  for (const m of FIELD_MEMBERS) if (input[m] !== undefined) f[m] = input[m];
  f.etagN++;
  sendJson(res, rid, 200, fieldBody(rec.id, f, false), { ETag: fieldEtag(rec.id, f) });
}

async function deleteField(req, res, rid, [kb, key]) {
  if (statusFault('DeleteField', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  const f = rec && fieldOr404(res, rid, rec, key);
  if (!f) return;
  rec.fields.delete(f.key);
  res.writeHead(204, baseHeaders(rid));
  res.end();
}

/** The one estimate shape (Estimate): documents, pages, time and, for callers who may see it, cost. */
function estimateBody({ documents, pages, mediaSeconds, unknown = 0, details }) {
  const seconds = 20 * documents + 2 * (pages ?? 0) + 0.5 * (mediaSeconds ?? 0);
  const cents = 0.4 * documents + 0.05 * (pages ?? 0);
  return {
    documents,
    ...(pages !== undefined ? { pages } : {}),
    ...(mediaSeconds !== undefined ? { mediaSeconds } : {}),
    ...(unknown ? { documentsOfUnknownLength: unknown } : {}),
    durationSeconds: { low: Math.round(seconds * 0.7), high: Math.round(seconds * 1.3) },
    cost: { low: Math.round(cents * 0.7) / 100, high: Math.round(cents * 1.3) / 100, unit: 'usd' },
    ...(details ? { details } : {}),
  };
}

/** UploadDescription checked as the model has it: name, contentType, byteSize (>= 1), and hints. */
function badDescription(d) {
  return !d || typeof d.name !== 'string' || typeof d.contentType !== 'string' || !(Number(d.byteSize) >= 1);
}

function describedEstimate(descriptions) {
  let pages;
  let mediaSeconds;
  let unknown = 0;
  for (const d of descriptions) {
    const h = d.hints ?? {};
    if (h.pages !== undefined) pages = (pages ?? 0) + h.pages;
    if (h.mediaSeconds !== undefined) mediaSeconds = (mediaSeconds ?? 0) + h.mediaSeconds;
    if (h.pages === undefined && h.mediaSeconds === undefined && h.characters === undefined) unknown++;
  }
  return estimateBody({ documents: descriptions.length, pages, mediaSeconds, unknown });
}

// EstimateIngestion: what adding the described files would take, before anything is uploaded.
async function estimateIngestion(req, res, rid, [kb], url, body) {
  if (statusFault('EstimateIngestion', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const docs = parseJson(body)?.documents;
  if (!Array.isArray(docs) || docs.length < 1 || docs.some(badDescription)) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', 'documents lists 1 or more files, each {name, contentType, byteSize, hints?}', { fieldErrors: [{ pointer: '/documents', code: 'VALIDATION_FAILED' }] });
  }
  sendJson(res, rid, 200, describedEstimate(docs));
}

async function estimateDocumentVersion(req, res, rid, [kb, documentId], url, body) {
  if (statusFault('EstimateDocumentVersion', res, rid)) return;
  if (!findDoc(kb, documentId)) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  const file = parseJson(body)?.file;
  if (badDescription(file)) return problem(res, rid, 400, 'VALIDATION_FAILED', 'file is {name, contentType, byteSize, hints?}', { fieldErrors: [{ pointer: '/file', code: 'VALIDATION_FAILED' }] });
  sendJson(res, rid, 200, describedEstimate([file]));
}

function unknownKeys(rec, keys) {
  return keys.filter((k) => !rec.fields.has(k));
}

async function estimateFillIn(req, res, rid, [kb], url, body) {
  if (statusFault('EstimateFillInFields', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const keys = parseJson(body)?.keys;
  if (!Array.isArray(keys) || !keys.length) return problem(res, rid, 400, 'VALIDATION_FAILED', 'keys names 1 or more fields', { fieldErrors: [{ pointer: '/keys', code: 'VALIDATION_FAILED' }] });
  const unknown = unknownKeys(rec, keys);
  if (unknown.length) return problem(res, rid, 422, 'METADATA_FIELD_UNDEFINED', `The knowledge base defines no field ${unknown.join(', ')}.`);
  const docs = state.knowledgeBases.get(rec.id).filter((d) => keys.some((k) => d.metadata?.[k] === undefined));
  sendJson(res, rid, 200, estimateBody({ documents: docs.length, pages: docs.length * 4, details: { passages: docs.length * 12 } }));
}

async function fillIn(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('FillInFields', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const keys = parseJson(body)?.keys;
  if (!Array.isArray(keys) || !keys.length) return problem(res, rid, 400, 'VALIDATION_FAILED', 'keys names 1 or more fields', { fieldErrors: [{ pointer: '/keys', code: 'VALIDATION_FAILED' }] });
  const unknown = unknownKeys(rec, keys);
  if (unknown.length) return problem(res, rid, 422, 'METADATA_FIELD_UNDEFINED', `The knowledge base defines no field ${unknown.join(', ')}.`);
  const result = idempotent(key, `FillInFields:${rec.id}`, () => {
    const job = newJob(rec.id, 'fill_in', { type: 'knowledge_base', id: rec.id }, {
      finish: (status) => {
        if (status !== 'succeeded' && status !== 'completed_with_failures') return [];
        for (const d of state.knowledgeBases.get(rec.id) ?? []) for (const k of keys) (d.metadata ??= {})[k] ??= 'Filled in';
        return [];
      },
    });
    return { status: 202, body: { job: jobBody(job) } };
  });
  sendJson(res, rid, result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
}

function reprocessTargets(rec, input) {
  if ((input.outOfDate === true) === Array.isArray(input.documentIds)) return null;
  const docs = state.knowledgeBases.get(rec.id);
  return input.outOfDate ? docs.filter((d) => d.outOfDate) : docs.filter((d) => input.documentIds.includes(d.id));
}

async function estimateReprocess(req, res, rid, [kb], url, body) {
  if (statusFault('EstimateReprocessDocuments', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const docs = reprocessTargets(rec, parseJson(body) ?? {});
  if (!docs) return problem(res, rid, 400, 'VALIDATION_FAILED', 'Give outOfDate: true or documentIds, not both.', { fieldErrors: [{ pointer: '', code: 'VALIDATION_FAILED' }] });
  sendJson(res, rid, 200, estimateBody({ documents: docs.length, pages: docs.length * 4, details: { improvements: ['Tables are read as tables', 'Pictures are described'] } }));
}

// ReprocessDocuments: one reprocess job for the knowledge base; when it ends the documents are no longer out of date.
async function reprocess(req, res, rid, [kb], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('ReprocessDocuments', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const docs = reprocessTargets(rec, parseJson(body) ?? {});
  if (!docs) return problem(res, rid, 400, 'VALIDATION_FAILED', 'Give outOfDate: true or documentIds, not both.', { fieldErrors: [{ pointer: '', code: 'VALIDATION_FAILED' }] });
  const result = idempotent(key, `ReprocessDocuments:${rec.id}`, () => {
    const job = newJob(rec.id, 'reprocess', { type: 'knowledge_base', id: rec.id }, {
      finish: (status) => {
        if (status === 'succeeded' || status === 'completed_with_failures') for (const d of docs) delete d.outOfDate;
        return docs.map((d) => ['document.updated', { document: docBody(d) }, { document: d.id, folder: d.folder }]);
      },
    });
    job.progress = { completed: 0, total: docs.length, unit: 'documents' };
    return { status: 202, body: { job: jobBody(job) } };
  });
  sendJson(res, rid, result.status, result.body, result.replayed ? { 'Idempotent-Replayed': 'true' } : {});
}

async function estimateLayoutAwareSearch(req, res, rid, [kb]) {
  if (statusFault('EstimateLayoutAwareSearch', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  const n = state.knowledgeBases.get(rec.id).length;
  sendJson(res, rid, 200, estimateBody({ documents: n, pages: n * 4 }));
}

async function enableLayoutAwareSearch(req, res, rid, [kb]) {
  if (statusFault('EnableLayoutAwareSearch', res, rid)) return;
  const rec = kbOr404(res, rid, kb);
  if (!rec) return;
  if (rec.layoutAwareSearch) return problem(res, rid, 409, 'CONFLICT', 'Layout-aware search is already on.');
  const job = newJob(rec.id, 'layout_aware_search', { type: 'knowledge_base', id: rec.id }, {
    finish: (status) => {
      if (status !== 'succeeded') return [];
      rec.layoutAwareSearch = true;
      rec.etagN++;
      return [['knowledge_base.updated', { knowledgeBase: kbBody(rec) }, {}]];
    },
  });
  sendJson(res, rid, 202, { operation: jobBody(job) }, { Location: `/api/v3/knowledge-bases/${rec.id}/operations/${job.id}` });
}

// ---- Documents: details, retry, stopping, download, and deleting a version

async function updateDocument(req, res, rid, [kb, documentId], url, body) {
  if (statusFault('UpdateDocument', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  if (preconditions(req, res, rid, doc.etag)) return;
  const { clear = [], ...patch } = parseJson(body);
  if (patch.folder !== undefined && !FOLDER_PATH.test(patch.folder)) return problem(res, rid, 400, 'VALIDATION_FAILED', FOLDER_DETAIL, { fieldErrors: [{ pointer: '/folder', code: 'VALIDATION_FAILED' }] });
  if (patch.name !== undefined || patch.folder !== undefined) {
    const reserved = reservedPath(doc.knowledgeBaseId, patch.folder ?? doc.folder, patch.name ?? doc.name);
    if (reserved) return problem(res, rid, reserved.status, ...reserved.problem);
  }
  if (patch.name !== undefined) doc.name = patch.name;
  for (const k of ['metadata', 'extraMetadata', 'sourceUrl', 'externalId']) if (patch[k] !== undefined) doc[k] = patch[k];
  for (const k of clear) delete doc[k];
  let job;
  if (patch.folder !== undefined && patch.folder !== doc.folder) {
    doc.folder = patch.folder;
    job = newJob(doc.knowledgeBaseId, 'document_update', { type: 'document', id: doc.id, knowledgeBaseId: doc.knowledgeBaseId }, {});
  }
  bumpDoc(doc);
  kbEvent(doc.knowledgeBaseId, 'document.updated', { document: docBody(doc) }, { document: doc.id, folder: doc.folder });
  sendJson(res, rid, 200, { document: docBody(doc), ...(job ? { operation: jobBody(job) } : {}) }, { ETag: doc.etag });
}

async function retryDocument(req, res, rid, [kb, documentId]) {
  if (statusFault('RetryDocument', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  if (doc.status === 'pending' || doc.status === 'processing') return problem(res, rid, 409, 'DOCUMENT_INGESTION_IN_PROGRESS', `Document ${doc.id} is still processing.`);
  doc.status = 'pending';
  delete doc.failure;
  bumpDoc(doc);
  const job = ingestionJob(doc, versionsOf.get(doc).at(-1));
  sendJson(res, rid, 202, { document: docBody(doc), operation: jobBody(job) }, { ETag: doc.etag });
}

// CancelDocumentProcessing: refused until stopping a document's processing is built (the design's decision 10).
async function cancelDocumentProcessing(req, res, rid, [kb, documentId]) {
  if (statusFault('CancelDocumentProcessing', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  if (!faults.cancellableProcessing) return problem(res, rid, 409, 'OPERATION_NOT_CANCELLABLE', 'Stopping a document’s processing is not available yet.');
  delete faults.busyDocuments?.[doc.id];
  const now = nowIso();
  for (const job of [...state.jobs.values()]) {
    if (FINAL_JOB.has(job.status) || job.target?.type !== 'document' || job.target.id !== doc.id) continue;
    job.status = 'cancelled';
    job.endedAt = now;
    job.updatedAt = now;
    delete doc.processing;
    for (const [type, data, a] of job.effects.finish?.('cancelled', job) ?? []) kbEvent(doc.knowledgeBaseId, type, data, a);
    kbEvent(doc.knowledgeBaseId, 'job.finished', { job: jobBody(job) }, jobAbout(job));
  }
  sendJson(res, rid, 202, docBody(doc), { ETag: doc.etag });
}

// GetDocumentContent: 302 to the bytes, with the same address in the body for a client that does not follow it.
async function getDocumentContent(req, res, rid, [kb, documentId], url) {
  if (statusFault('GetDocumentContent', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  const version = url.searchParams.get('version') ?? 'current';
  const address = `http://${req.headers.host}/__s3/content/${doc.id}?version=${encodeURIComponent(version)}&X-Amz-Signature=mock`;
  sendJson(res, rid, 302, { url: address, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }, { Location: address });
}

// GetDocumentDownload: 200 with the address of the bytes and when it stops working; nothing to follow.
async function getDocumentDownload(req, res, rid, [kb, documentId], url) {
  if (statusFault('GetDocumentDownload', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  const version = url.searchParams.get('version') ?? 'current';
  const address = `http://${req.headers.host}/__s3/content/${doc.id}?version=${encodeURIComponent(version)}&X-Amz-Signature=mock`;
  sendJson(res, rid, 200, { url: address, expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() });
}

async function deleteDocumentVersion(req, res, rid, [kb, documentId, ref]) {
  if (statusFault('DeleteDocumentVersion', res, rid)) return;
  const doc = findDoc(kb, documentId);
  if (!doc) return problem(res, rid, 404, 'NOT_FOUND', `No document ${decodeURIComponent(documentId)}`);
  const versions = versionsOf.get(doc);
  const name = decodeURIComponent(ref);
  // As !2062's server does: the version a reference names first (a number, `current` or `latest`), then a number on a
  // document whose versions are not numbered yet (faults.versionsNotNumbered) is 409 VERSIONS_NOT_NUMBERED, since it is
  // a place in upload order that the delete would shift; `latest` and `current` work either way. The current version
  // is 409 CONFLICT, and a version still processing 409 CONFLICT with Retry-After.
  const number = name === 'current' ? doc.version : name === 'latest' ? Math.max(...versions.map((x) => x.number)) : Number(name);
  const v = versions.find((x) => x.number === number);
  if (!v) return problem(res, rid, 404, 'NOT_FOUND', `Document ${doc.id} has no version ${name} you can see.`);
  if (/^\d+$/.test(name) && faults.versionsNotNumbered?.[doc.id]) {
    return problem(res, rid, 409, 'VERSIONS_NOT_NUMBERED', `The versions of document ${doc.id} are not numbered yet, so version ${name} cannot be deleted by its number. Try again once they are numbered.`);
  }
  if (v.number === doc.version) return problem(res, rid, 409, 'CONFLICT', `Version ${v.number} is the current version of document ${doc.id}. Delete the document to remove it.`);
  if (v.status === 'pending' || v.status === 'processing') {
    return problem(res, rid, 409, 'CONFLICT', `Version ${v.number} of document ${doc.id} is still processing. Try again when it has finished.`, { extra: { 'Retry-After': '30' } });
  }
  versions.splice(versions.indexOf(v), 1);
  doc.versionCount = versions.length;
  res.writeHead(204, baseHeaders(rid));
  res.end();
}

// ---------------------------------------------------------------------------
// Jobs and the knowledge base's watch (PROTOCOL.md 16)
// ---------------------------------------------------------------------------
//
// A job is the building blocks' Operation. It moves on one step each time a watch that sees it looks (every
// faults.watchTickMs): queued, running (faults.jobSteps steps, each with job.progress and, for a document,
// document.progress), then its final status from faults.jobOutcomes (job.finished), when its `finish` effect runs:
// a document is indexed (or partially indexed, or failed), a folder deleted, a knowledge base gone.
//
// Every change is appended to the knowledge base's event log (kbEvent) with what it is about ({document, folder});
// each WatchKnowledgeBase connection sends a snapshot first, then the log's entries after that point which match
// its filter. A batch's watch has no change event for the batch itself in the model: the mock sends a new snapshot
// whenever the batch changes.

const FINAL_JOB = new Set(['succeeded', 'completed_with_failures', 'failed', 'cancelled']);

function newJob(kb, kind, target, effects = {}) {
  const now = nowIso();
  const job = { id: crypto.randomUUID(), kind, status: 'queued', target: { knowledgeBaseId: kb, ...target }, createdAt: now, updatedAt: now, createdBy: { displayName: 'Mock caller' }, knowledgeBaseId: kb, stepsLeft: faults.jobSteps ?? 2, effects };
  if (target.type !== 'knowledge_base') job.target.knowledgeBaseId = kb;
  else delete job.target.knowledgeBaseId;
  state.jobs.set(job.id, job);
  return job;
}

function jobBody(job) {
  const { knowledgeBaseId, stepsLeft, effects, ...rest } = job;
  return structuredClone(rest);
}

/** Appends an event to the knowledge base's log, with what it is about: {document?, folder?, batch?}. */
function kbEvent(kb, type, data, about) {
  (state.kbLog ??= []).push({ kb, type, data: structuredClone(data), about, id: crypto.randomUUID() });
}

/** Does a watch with this filter see something about `about`? */
function matches(filter, about) {
  if (filter.document) return about.document === filter.document;
  if (filter.folder) return (about.folder ?? '').startsWith(filter.folder) || (about.document && findDoc(filter.kb, about.document)?.folder.startsWith(filter.folder));
  if (filter.batch) return about.batch === filter.batch;
  return true;
}

function jobAbout(job) {
  const t = job.target ?? {};
  if (t.type === 'document') return { document: t.id, folder: findDoc(job.knowledgeBaseId, t.id)?.folder };
  if (t.type === 'folder') return { folder: t.id };
  return {};
}

function processingOf(job, doc) {
  return { kind: job.kind === 'reprocess' ? 'reprocess' : job.kind === 'fill_in' ? 'fill_in' : 'ingest', stage: job.status === 'queued' ? 'pages' : 'passages', percent: job.percent ?? 0, startedAt: job.startedAt ?? job.createdAt, updatedAt: job.updatedAt, ...(doc ? {} : {}) };
}

/** Moves a job on one step, logging its events. */
function stepJob(job) {
  if (FINAL_JOB.has(job.status)) return;
  const kb = job.knowledgeBaseId;
  const about = jobAbout(job);
  const now = nowIso();
  job.updatedAt = now;
  const doc = job.target?.type === 'document' ? findDoc(kb, job.target.id) : undefined;
  if (job.status === 'queued') {
    job.status = 'running';
    job.startedAt = now;
    job.percent = 0;
  } else if (job.target?.type === 'document' && faults.holdJobs?.[job.target.id]) {
    // Held running (holdJobs): a look reports it as it is.
  } else if (job.stepsLeft > 0) {
    job.stepsLeft--;
    job.percent = Math.min(99, (job.percent ?? 0) + Math.ceil(100 / ((faults.jobSteps ?? 2) + 1)));
    if (job.progress) job.progress.completed = Math.min(job.progress.total ?? Infinity, job.progress.completed + 1);
  } else {
    const outcome = faults.jobOutcomes?.[job.target?.id] ?? faults.jobOutcomes?.[job.kind] ?? 'succeeded';
    job.status = outcome;
    job.endedAt = now;
    if (outcome === 'succeeded' || outcome === 'completed_with_failures') job.percent = 100;
    if (outcome === 'failed') job.error = structuredClone(faults.jobError ?? { code: 'INTERNAL', detail: 'The job failed.' });
    if (outcome === 'completed_with_failures') job.partialFailures = [{ targetId: 'picture-4', code: 'PICTURE_DESCRIPTION_FAILED', detail: 'The picture on page 4 could not be described.' }];
    if (job.progress && outcome !== 'failed' && outcome !== 'cancelled') job.progress.completed = job.progress.total ?? job.progress.completed;
    if (doc) delete doc.processing;
    const effects = job.effects.finish?.(outcome, job) ?? [];
    for (const [type, data, a] of effects) kbEvent(kb, type, data, a);
    kbEvent(kb, 'job.finished', { job: jobBody(job) }, about);
    return;
  }
  if (doc) {
    doc.processing = processingOf(job, doc);
    if (doc.status === 'pending') doc.status = 'processing';
    kbEvent(kb, 'document.progress', { documentId: doc.id, processing: doc.processing }, about);
  }
  kbEvent(kb, 'job.progress', { job: jobBody(job) }, about);
}

/** The ingestion job a new document or version starts: when it ends, the version is indexed (or not). */
function ingestionJob(doc, v) {
  return newJob(doc.knowledgeBaseId, 'document_ingestion', { type: 'document', id: doc.id }, {
    finish: (status) => {
      if (!findDoc(doc.knowledgeBaseId, doc.id) || doc.status === 'deleting') return [];
      if (status === 'succeeded' || status === 'completed_with_failures') {
        if (v) v.status = status === 'succeeded' ? 'indexed' : 'partially_indexed';
        if (v && doc.version !== v.number) makeCurrent(doc, v);
        doc.status = status === 'succeeded' ? 'indexed' : 'partially_indexed';
        if (status === 'completed_with_failures') doc.partialFailures = [{ targetId: 'picture-4', code: 'PICTURE_DESCRIPTION_FAILED', detail: 'The picture on page 4 could not be described.' }];
      } else {
        if (v) v.status = 'failed';
        doc.status = 'failed';
        doc.failure = status === 'cancelled'
          ? { code: 'cancelled', message: 'Processing was stopped.' }
          : { code: 'file_unreadable', message: 'The file could not be read. Check that it opens, then upload it again.' };
      }
      bumpDoc(doc);
      return [
        ...(v && (status === 'succeeded' || status === 'completed_with_failures') ? [['document_version.indexed', { documentId: doc.id, version: v.number }, { document: doc.id, folder: doc.folder }]] : []),
        ['document.updated', { document: docBody(doc) }, { document: doc.id, folder: doc.folder }],
      ];
    },
  });
}

/** What a watch with this filter is about now, for its snapshot; a 404 already sent when it is gone. */
function snapshotOf(res, rid, filter) {
  const rec = state.kbs.get(filter.kb);
  if (!rec || !state.knowledgeBases.has(filter.kb)) return problem(res, rid, 404, 'NOT_FOUND', `No knowledge base ${filter.kb}`), null;
  const docs = state.knowledgeBases.get(filter.kb);
  const jobs = [...state.jobs.values()].filter((j) => j.knowledgeBaseId === filter.kb && matches(filter, jobAbout(j))).map(jobBody);
  const progress = docs.filter((d) => d.processing && matches(filter, { document: d.id, folder: d.folder })).map((d) => ({ documentId: d.id, processing: d.processing }));
  if (filter.document) {
    const d = docs.find((x) => x.id === filter.document);
    if (!d) return problem(res, rid, 404, 'NOT_FOUND', `No document ${filter.document}`), null;
    return { document: docBody(d), jobs, progress };
  }
  if (filter.folder) {
    const f = rec.folders.get(filter.folder);
    if (!f) return problem(res, rid, 404, 'NOT_FOUND', `No folder ${filter.folder}`), null;
    return { folder: folderBody(filter.kb, f), jobs, progress };
  }
  if (filter.batch) {
    const b = findBatch(filter.batch, filter.kb);
    if (!b) return problem(res, rid, 404, 'NOT_FOUND', `No ingestion batch ${filter.batch}`), null;
    return { batch: batchBody(b, true), jobs: [], progress };
  }
  return { knowledgeBase: kbBody(rec), jobs, progress };
}

/** One look of a watch: jobs move on, a knowledge base being created becomes ready, documents being deleted go. */
function look(filter) {
  const rec = state.kbs.get(filter.kb);
  if (!rec) return;
  if (rec.status === 'creating' && !filter.document && !filter.folder && !filter.batch) {
    if (--rec.creatingTicks <= 0) {
      rec.status = 'ready';
      rec.etagN++;
      rec.updatedAt = nowIso();
      kbEvent(rec.id, 'knowledge_base.updated', { knowledgeBase: kbBody(rec) }, {});
    }
  }
  const docs = state.knowledgeBases.get(filter.kb) ?? [];
  for (const d of docs) {
    const left = faults.busyWithoutJob?.[d.id];
    if (left === undefined || !matches(filter, { document: d.id, folder: d.folder })) continue;
    if (left > 0) faults.busyWithoutJob[d.id] = left - 1;
    else {
      delete faults.busyWithoutJob[d.id];
      d.status = 'indexed';
      bumpDoc(d);
      kbEvent(filter.kb, 'document.updated', { document: docBody(d) }, { document: d.id, folder: d.folder });
    }
  }
  for (const d of [...docs]) {
    if (d.status === 'deleting' && matches(filter, { document: d.id, folder: d.folder })) {
      docs.splice(docs.indexOf(d), 1);
      kbEvent(filter.kb, 'document.deleted', { documentId: d.id }, { document: d.id, folder: d.folder });
    }
  }
  for (const job of [...state.jobs.values()]) {
    if (job.knowledgeBaseId === filter.kb && !FINAL_JOB.has(job.status) && matches(filter, jobAbout(job))) stepJob(job);
  }
  if (filter.batch) {
    const b = findBatch(filter.batch, filter.kb);
    if (b?.endsOnRead) return; // only a read ends it
    if (b?.status === 'planning') {
      if (b.planningReadsLeft > 0) b.planningReadsLeft--;
      else plan(b);
    } else if (b) advance(b);
  }
}

// WatchKnowledgeBase: GET /v3/knowledge-bases/{kb}/events[?document=…|?folder=…|?batch=…]. A snapshot first, then
// each change; it looks again every faults.watchTickMs and stays open until the client closes it (at most 30 s).
// With watchDrops, the connection is cut after its first events, and the next one starts with a new snapshot.
async function watchKnowledgeBase(req, res, rid, [kbId], url) {
  if (statusFault('WatchKnowledgeBase', res, rid)) return;
  if (state.goneAfterDrop) {
    state.goneAfterDrop = false;
    return problem(res, rid, 404, 'NOT_FOUND', 'Not found');
  }
  const filter = { kb: decodeURIComponent(kbId) };
  for (const k of url.searchParams.keys()) {
    if (!['document', 'folder', 'batch'].includes(k)) return problem(res, rid, 400, 'UNKNOWN_FILTER', `Unknown query parameter ${k}`, { fieldErrors: [{ parameter: k, code: 'UNKNOWN_FILTER' }] });
  }
  for (const k of ['document', 'folder', 'batch']) if (url.searchParams.has(k)) filter[k] = url.searchParams.get(k);
  if (Object.keys(filter).length > 2) return problem(res, rid, 400, 'VALIDATION_FAILED', 'Give at most one of document, folder and batch.');
  if (filter.document && faults.busyWithoutJob?.[filter.document] !== undefined) {
    const d = findDoc(filter.kb, filter.document);
    if (d) d.status = 'processing';
  }
  if (filter.document && faults.busyDocuments?.[filter.document]) {
    delete faults.busyDocuments[filter.document];
    const d = findDoc(filter.kb, filter.document);
    if (d) {
      // Running already, so the snapshot carries the document's processing (its first progress, at 0%).
      d.status = 'processing';
      stepJob(ingestionJob(d, undefined));
    }
  }
  let snapshot = snapshotOf(res, rid, filter);
  if (!snapshot) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...baseHeaders(rid) });
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      log.push({ event: 'client-disconnected', subject: `kb:${filter.kb}`, at: Date.now() });
    }
  });
  const drop = faults.watchDrops?.count > 0 ? (faults.watchDrops.count--, faults.watchDrops.afterEvents ?? 1) : null;
  let sent = 0;
  const send = (type, data) => {
    res.write(`id: ${crypto.randomUUID()}\nevent: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
    sent++;
    if (drop !== null && sent >= drop) {
      log.push({ event: 'server-dropped-stream', subject: `kb:${filter.kb}`, at: Date.now() });
      if (faults.watchGoneAfterDrop) state.goneAfterDrop = true;
      setTimeout(() => res.socket?.destroy(), 20);
      closed = true;
    }
  };
  res.write('retry: 2000\n\n');
  // A reset (POST /__mock/reset) starts a new state: a watch opened before it ends, as a server restarting would end it.
  const born = state;
  let at = (state.kbLog ??= []).length;
  send('snapshot', snapshot);
  let last = JSON.stringify(snapshot.batch ?? null);
  const until = Date.now() + 30_000;
  let keptAlive = Date.now();
  while (!closed && Date.now() < until && state === born) {
    await sleep(faults.watchTickMs ?? 10);
    if (closed || state !== born) break;
    if (faults.watchKeepAliveMs && Date.now() - keptAlive >= faults.watchKeepAliveMs) {
      res.write(': keep-alive\n\n');
      keptAlive = Date.now();
    }
    look(filter);
    for (; at < (state.kbLog ??= []).length && !closed; at++) {
      const e = state.kbLog[at];
      if (e.kb === filter.kb && !filter.batch && matches(filter, e.about)) send(e.type, e.data);
    }
    if (filter.batch && !closed) {
      const b = findBatch(filter.batch, filter.kb);
      const now = JSON.stringify(b ? batchBody(b, true) : null);
      // faults.deadlinePassed: the change a read made is never sent, so only the SDK's own read can show it.
      if (b && now !== last && !b.endedOnRead) {
        last = now;
        send('snapshot', { batch: batchBody(b, true), jobs: [], progress: [] });
      }
    }
  }
  if (!closed) res.end();
}

// ---- Operations: the building blocks' view of jobs

function jobOr404(res, rid, kb, id) {
  const job = state.jobs.get(decodeURIComponent(id));
  if (!job || job.knowledgeBaseId !== decodeURIComponent(kb)) return problem(res, rid, 404, 'NOT_FOUND', `No operation ${decodeURIComponent(id)}`), null;
  return job;
}

async function listOperations(req, res, rid, [kb], url) {
  if (statusFault('ListOperations', res, rid)) return;
  if (!kbOr404(res, rid, kb)) return;
  const f = (p) => url.searchParams.get(p);
  const items = [...state.jobs.values()].filter((j) => j.knowledgeBaseId === decodeURIComponent(kb)
    && (!f('filter[status][eq]') || j.status === f('filter[status][eq]'))
    && (!f('filter[kind][eq]') || j.kind === f('filter[kind][eq]'))
    && (!f('filter[target.type][eq]') || j.target?.type === f('filter[target.type][eq]'))
    && (!f('filter[target.id][eq]') || j.target?.id === f('filter[target.id][eq]'))).map(jobBody);
  sendJson(res, rid, 200, { items });
}

// GetOperation: each read moves an unfinished operation on one step, as a watch would see it progress, so a caller
// that polls instead of watching sees it finish.
async function getOperation(req, res, rid, [kb, id]) {
  if (statusFault('GetOperation', res, rid)) return;
  const job = jobOr404(res, rid, kb, id);
  if (!job) return;
  if (!FINAL_JOB.has(job.status)) stepJob(job);
  sendJson(res, rid, 200, jobBody(job));
}

async function cancelOperation(req, res, rid, [kb, id]) {
  if (statusFault('CancelOperation', res, rid)) return;
  const job = jobOr404(res, rid, kb, id);
  if (!job) return;
  if (FINAL_JOB.has(job.status)) return problem(res, rid, 409, 'OPERATION_NOT_CANCELLABLE', `Operation ${job.id} has ended.`);
  job.status = 'cancelled';
  job.endedAt = job.updatedAt = nowIso();
  kbEvent(job.knowledgeBaseId, 'job.finished', { job: jobBody(job) }, jobAbout(job));
  res.writeHead(202, baseHeaders(rid));
  res.end();
}

// ---------------------------------------------------------------------------
// Agents: versions (draft, live and named), publishing, history, and conversations
// ---------------------------------------------------------------------------
//
// An agent keeps its draft (agent.version), its named versions (agent.named: name -> {configuration, note, source,
// createdAt}), which version live points at (agent.live) and live's history. The seeded agent GHT7YRWXPL has v12
// and v13, with live on v13.

function seedVersions(entry) {
  if (entry.named) return entry;
  entry.named = new Map();
  entry.history = [];
  entry.liveEtagN = 1;
  if (entry.agent.id === 'GHT7YRWXPL') {
    for (const [name, at] of [['v12', '2026-11-04T00:00:00.000Z'], ['v13', '2026-11-05T00:00:00.000Z']]) {
      entry.named.set(name, { configuration: structuredClone(entry.version.configuration), source: 'publish', createdAt: at, etagN: 1 });
    }
    entry.live = 'v13';
    entry.history.push({ id: 'lh-0002', agentId: 'GHT7YRWXPL', version: 'v13', previousVersion: 'v12', kind: 'publish', changedAt: '2026-11-05T00:00:00.000Z', changedBy: { displayName: 'Mock caller' } });
  }
  return entry;
}

function agentOr404(res, rid, agentId) {
  const a = state.agents.get(decodeURIComponent(agentId));
  if (!a) return problem(res, rid, 404, 'NOT_FOUND', `No agent ${decodeURIComponent(agentId)}`), null;
  return seedVersions(a);
}

const namedEtag = (a, name) => `"version-${a.agent.id}-${name}-${a.named.get(name)?.etagN ?? 0}"`;
const liveEtag = (a) => `"live-${a.agent.id}-${a.liveEtagN}"`;

function namedBody(a, name) {
  const v = a.named.get(name);
  return { agentId: a.agent.id, name, source: v.source, matchesLive: a.live === name, createdAt: v.createdAt, createdBy: { displayName: 'Mock caller' }, ...(v.note ? { note: v.note } : {}), configuration: structuredClone(v.configuration) };
}

function versionSummaryOf(a, name) {
  const { configuration, agentId, ...rest } = namedBody(a, name);
  return rest;
}

async function listAgents(req, res, rid) {
  if (statusFault('ListAgents', res, rid)) return;
  sendJson(res, rid, 200, { items: [...state.agents.values()].map((a) => ({ ...agentBody(a), etag: agentEtag(a) })) });
}

async function deleteAgent(req, res, rid, [agentId]) {
  if (statusFault('DeleteAgent', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  state.agents.delete(a.agent.id);
  res.writeHead(204, baseHeaders(rid));
  res.end();
}

// GetAgentVersion: `draft`, `live` (the version live points at, named `live`, with liveVersion) or a version name.
async function getAgentVersion(req, res, rid, [agentId, version]) {
  if (statusFault('GetAgentVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  version = decodeURIComponent(version);
  if (version === 'draft') return sendJson(res, rid, 200, versionBody(a), { ETag: etagOf(a) });
  if (version === 'live') {
    if (!a.live) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has nothing live yet.`);
    const v = a.named.get(a.live);
    return sendJson(res, rid, 200, { ...namedBody(a, a.live), name: 'live', liveVersion: a.live, publishedAt: v.publishedAt ?? v.createdAt, publishedBy: { displayName: 'Mock caller' } }, { ETag: liveEtag(a) });
  }
  if (!a.named.has(version)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${version}.`);
  sendJson(res, rid, 200, namedBody(a, version), { ETag: namedEtag(a, version) });
}

async function listAgentVersions(req, res, rid, [agentId]) {
  if (statusFault('ListAgentVersions', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  // Each row is the version as reading it gives it, less its configuration, with the same ETag a read gives
  const items = [
    { agentId: a.agent.id, name: 'draft', matchesLive: false, createdAt: a.version.createdAt, etag: etagOf(a) },
    ...[...a.named.keys()].reverse().map((n) => ({ ...versionSummaryOf(a, n), agentId: a.agent.id, etag: namedEtag(a, n) })),
  ];
  sendJson(res, rid, 200, { items });
}

// ReplaceDraftVersion: If-Match required; the body is the whole configuration.
async function replaceDraft(req, res, rid, [agentId], url, body) {
  if (statusFault('ReplaceDraftVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  if (preconditions(req, res, rid, etagOf(a), { optional: true })) return; // @ifMatchOptional
  const input = parseJson(body);
  const unknown = Object.keys(input).filter((k) => !DRAFT_FIELDS.includes(k));
  if (unknown.length) return problem(res, rid, 400, 'UNKNOWN_FIELD', 'The configuration is not valid', { fieldErrors: unknown.map((k) => ({ pointer: `/${k}`, code: 'UNKNOWN_FIELD' })) });
  a.version.configuration = { guidance: { instructions: '' }, ...input };
  a.etagN++;
  sendJson(res, rid, 200, versionBody(a), { ETag: etagOf(a) });
}

// ResetDraftVersion: If-Match required; the draft becomes a copy of `from` (a version name, or `live`).
async function resetDraft(req, res, rid, [agentId], url, body) {
  if (statusFault('ResetDraftVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  if (preconditions(req, res, rid, etagOf(a))) return;
  const from = parseJson(body)?.from;
  const name = from === 'live' ? a.live : from;
  if (!name || !a.named.has(name)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${from}.`);
  a.version.configuration = structuredClone(a.named.get(name).configuration);
  a.version.basedOn = name;
  a.etagN++;
  sendJson(res, rid, 200, versionBody(a), { ETag: etagOf(a) });
}

/** Keeps the draft as a named version. */
function saveDraft(a, name, note, source) {
  a.named.set(name, { configuration: structuredClone(a.version.configuration), source, createdAt: nowIso(), etagN: 1, ...(note ? { note } : {}) });
}

const VERSION_NAME = /^[a-z0-9][a-z0-9._-]{0,62}$/;

// SaveDraftVersion: 201 with the new version; If-Match optional; a taken name is 409 ALREADY_EXISTS.
async function saveDraftVersion(req, res, rid, [agentId], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('SaveDraftVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  const ifMatch = req.headers['if-match'];
  if (ifMatch && !etagMatches(ifMatch, etagOf(a))) return problem(res, rid, 412, 'PRECONDITION_FAILED', `The draft of agent ${a.agent.id} changed since you read it.`);
  const { name, note } = parseJson(body) ?? {};
  if (!VERSION_NAME.test(name ?? '') || ['draft', 'live'].includes(name)) return problem(res, rid, 400, 'VALIDATION_FAILED', 'name is a version name, not draft or live', { fieldErrors: [{ pointer: '/name', code: 'VALIDATION_FAILED' }] });
  const result = idempotent(key, `SaveDraftVersion:${a.agent.id}`, () => {
    if (a.named.has(name)) return { status: 409, problem: ['ALREADY_EXISTS', `Agent ${a.agent.id} already has a version ${name}.`] };
    saveDraft(a, name, note, 'save');
    return { status: 201, body: namedBody(a, name) };
  });
  if (result.problem) return problem(res, rid, result.status, ...result.problem);
  sendJson(res, rid, result.status, result.body, { ETag: namedEtag(a, name), Location: `/api/v3/agents/${a.agent.id}/versions/${name}` });
}

// PublishAgentVersion: points live at a version. On the draft, `name` saves it first. If-Match (live's ETag) and
// expectedLive are both optional checks; either stale is 412. Publishing the version live was on before is a rollback.
async function publishAgentVersion(req, res, rid, [agentId, version], url, body) {
  if (statusFault('PublishAgentVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  version = decodeURIComponent(version);
  const input = parseJson(body) ?? {};
  const ifMatch = req.headers['if-match'];
  if (ifMatch && ifMatch !== '*' && ifMatch !== liveEtag(a)) return problem(res, rid, 412, 'PRECONDITION_FAILED', 'Live changed since you read it.');
  if ('expectedLive' in input && (input.expectedLive ?? null) !== (a.live ?? null)) return problem(res, rid, 412, 'PRECONDITION_FAILED', `Live is ${a.live ?? 'not set'}, not ${input.expectedLive}.`);
  let target = version;
  if (version === 'draft') {
    if (!VERSION_NAME.test(input.name ?? '') || ['draft', 'live'].includes(input.name)) return problem(res, rid, 400, 'VALIDATION_FAILED', 'Publishing the draft takes a name for the new version', { fieldErrors: [{ pointer: '/name', code: 'VALIDATION_FAILED' }] });
    if (a.named.has(input.name)) return problem(res, rid, 409, 'ALREADY_EXISTS', `Agent ${a.agent.id} already has a version ${input.name}.`);
    saveDraft(a, input.name, input.note, 'publish');
    target = input.name;
  } else if (version === 'live' || !a.named.has(version)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${version}.`);
  const previous = a.live;
  const kind = a.history.some((h) => h.version === target) ? 'rollback' : 'publish';
  a.live = target;
  a.liveEtagN++;
  const now = nowIso();
  a.named.get(target).publishedAt = now;
  const entry = { id: `lh-${String(a.history.length + 1).padStart(4, '0')}`, agentId: a.agent.id, version: target, ...(previous ? { previousVersion: previous } : {}), kind, changedAt: now, changedBy: { displayName: 'Mock caller' }, ...(input.note ? { note: input.note } : {}) };
  a.history.push(entry);
  sendJson(res, rid, 200, { live: { version: target, publishedAt: now, publishedBy: { displayName: 'Mock caller' } }, version: { ...namedBody(a, target), etag: namedEtag(a, target) }, historyEntry: entry }, { ETag: liveEtag(a) });
}

async function compareAgentVersions(req, res, rid, [agentId, version], url) {
  if (statusFault('CompareAgentVersions', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  const configOf = (n) => (n === 'draft' ? a.version.configuration : a.named.get(n === 'live' ? a.live : n)?.configuration);
  const left = configOf(decodeURIComponent(version));
  const right = configOf(url.searchParams.get('with') ?? '');
  if (!left || !right) return problem(res, rid, 404, 'NOT_FOUND', 'No such version.');
  const changes = Object.keys({ ...left, ...right }).filter((k) => JSON.stringify(left[k]) !== JSON.stringify(right[k])).sort().map((path) => ({ path, before: left[path] ?? null, after: right[path] ?? null }));
  sendJson(res, rid, 200, { changes });
}

async function deleteAgentVersion(req, res, rid, [agentId, version]) {
  if (statusFault('DeleteAgentVersion', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  version = decodeURIComponent(version);
  if (version === 'draft' || version === 'live') return problem(res, rid, 400, 'VERSION_NOT_DELETABLE', `${version} cannot be deleted.`);
  if (!a.named.has(version)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${version}.`);
  if (a.live === version) return problem(res, rid, 409, 'VERSION_IN_USE', `Live points at ${version}.`);
  a.named.delete(version);
  res.writeHead(204, baseHeaders(rid));
  res.end();
}

async function listLiveHistory(req, res, rid, [agentId]) {
  if (statusFault('ListHistoryEntries', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (a) sendJson(res, rid, 200, { items: [...a.history].reverse() });
}

async function getLiveHistoryEntry(req, res, rid, [agentId, entryId]) {
  if (statusFault('GetHistoryEntry', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  const e = a.history.find((h) => h.id === decodeURIComponent(entryId));
  if (!e) return problem(res, rid, 404, 'NOT_FOUND', `No history entry ${decodeURIComponent(entryId)}`);
  sendJson(res, rid, 200, { ...e, configuration: structuredClone(a.named.get(e.version)?.configuration ?? {}) });
}

// CreateConversation: under the version that answers (`live`, `draft` or a name); 404 when there is no such version.
async function createConversation(req, res, rid, [agentId, version], url, body) {
  const key = req.headers['idempotency-key'];
  if (statusFault('CreateConversation', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  version = decodeURIComponent(version);
  if (version === 'live' ? !a.live : version !== 'draft' && !a.named.has(version)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${version}.`);
  const input = parseJson(body) ?? {};
  const result = idempotent(key, `CreateConversation:${a.agent.id}`, () => {
    const id = `conv-${crypto.randomUUID().slice(0, 8)}`;
    const record = { id, agentId: a.agent.id, version, ...(input.title ? { title: input.title } : {}), status: 'idle', createdAt: nowIso() };
    state.conversationRecords.set(id, record);
    return { status: 201, body: record };
  });
  sendJson(res, rid, result.status, result.body, { Location: `/api/v3/conversations/${result.body.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

async function listConversations(req, res, rid, [agentId]) {
  if (statusFault('ListConversations', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  sendJson(res, rid, 200, { items: [...state.conversationRecords.values()].filter((c) => c.agentId === a.agent.id) });
}

async function getConversation(req, res, rid, [conversationId]) {
  if (statusFault('GetConversation', res, rid)) return;
  const c = state.conversationRecords.get(decodeURIComponent(conversationId));
  if (!c) return problem(res, rid, 404, 'NOT_FOUND', `No conversation ${decodeURIComponent(conversationId)}`);
  sendJson(res, rid, 200, c);
}

// ListMessages: each message sent, and each answer that completed, oldest first.
async function listMessages(req, res, rid, [conversationId]) {
  if (statusFault('ListMessages', res, rid)) return;
  const id = decodeURIComponent(conversationId);
  if (!state.conversationRecords.has(id) && !state.conversations.has(id)) return problem(res, rid, 404, 'NOT_FOUND', `No conversation ${id}`);
  sendJson(res, rid, 200, { items: state.messages?.get(id) ?? [] });
}

// ---------------------------------------------------------------------------
// Unattended runs
// ---------------------------------------------------------------------------
//
// A run is created `pending` and moves on only as a watch sends its events: `unattended_run.status_changed`
// (running), the answer (the conversation stream's events, without `message.failed`: a failed run is told by its
// end, not raised), then `unattended_run.ended` with the run in its final status. Every connection starts with a
// `snapshot` of the run as far as it has gone, with no id, then the events after Last-Event-ID (all of them without
// one). The stream ends after `unattended_run.ended`.

const RUN_FINAL = new Set(['succeeded', 'failed', 'cancelled', 'interrupted', 'untracked']);

/** The run's whole stream, from `running` to its end as faults.unattendedRun says. */
function unattendedRunEvents(run) {
  const outcome = faults.unattendedRun ?? { status: 'succeeded' };
  const failStream = faults.failStream;
  faults.failStream = false;
  const answer = chatEvents().filter((e) => !e.comment);
  faults.failStream = failStream;
  const raw = [['unattended_run.status_changed', { unattendedRun: { ...run, status: 'running' } }]];
  for (const e of answer) {
    if (outcome.status !== 'succeeded' && e.type === 'message.completed') continue;
    raw.push([e.type, e.data]);
  }
  const message = answer.find((e) => e.type === 'message.completed')?.data.message;
  raw.push(['unattended_run.ended', { unattendedRun: endedRun(run, outcome, message) }]);
  return raw.map(([type, data], i) => ({ id: `${run.id}:${i + 1}`, type, data }));
}

function endedRun(run, outcome, message) {
  const ended = { ...run, status: outcome.status, endedAt: nowIso() };
  if (outcome.status === 'succeeded' && message) ended.result = message;
  if (outcome.failure) ended.failure = outcome.failure;
  return ended;
}

/** The run as far as its watch has gone: the last run an event carried, or the run as created. */
function runNow(r) {
  let run = r.run;
  for (let i = r.sent - 1; i >= 0; i--) {
    if (r.events[i].data.unattendedRun) {
      run = r.events[i].data.unattendedRun;
      break;
    }
  }
  return { ...run, ...(r.title !== undefined ? { title: r.title } : {}), etag: runEtag(r, r.sent) };
}

/** The run's etag once its watch has sent `sent` events: it moves with every change a caller can see, a rename too. */
const runEtag = (r, sent) => `"${r.run.id}-${sent}-${r.renames ?? 0}"`;

/** An event as the watch sends it: a run it carries has its etag, as every read of the run does. */
const runEventData = (r, e, at) =>
  e.data.unattendedRun ? { unattendedRun: { ...e.data.unattendedRun, ...(r.title !== undefined ? { title: r.title } : {}), etag: runEtag(r, at) } } : e.data;

function runOr404(res, rid, id) {
  const r = state.unattendedRuns.get(decodeURIComponent(id));
  if (!r) problem(res, rid, 404, 'NOT_FOUND', `No unattended run ${decodeURIComponent(id)}`);
  return r;
}

/** A new run of `agentId` at `version`, recorded with its request; final at once with faults.unattendedRun.endedAtCreate. */
function newUnattendedRun(agentId, version, input, attachments, replayOf) {
  const id = `run-${crypto.randomUUID().slice(0, 8)}`;
  // As the model's UnattendedRun: the agent and the version asked for, the named version it resolved to, who
  // started it, and the message it started with.
  const run = {
    id,
    agent: { id: agentId, version },
    agentVersion: version === 'live' || version === 'draft' ? 'v12' : version,
    startedBy: { type: 'person', id: 'mock-caller' },
    prompt: input.message,
    ...(input.title ? { title: input.title } : {}),
    status: 'pending',
    ...(replayOf ? { replayedFrom: replayOf } : {}),
    startedAt: nowIso(),
  };
  const r = { run, request: input, attachments: attachments ?? [], sent: 0, events: [] };
  r.events = unattendedRunEvents(run);
  if (faults.unattendedRun?.endedAtCreate) r.sent = r.events.length;
  state.unattendedRuns.set(id, r);
  return r;
}

// CreateUnattendedRun: under the version that answers (`live`, `draft` or a name), 202 with the run. One
// Idempotency-Key gives one run; the same key with a different request is 422 IDEMPOTENCY_KEY_REUSED.
async function createUnattendedRun(req, res, rid, [agentId, version], url, body) {
  if (statusFault('CreateUnattendedRun', res, rid)) return;
  const a = agentOr404(res, rid, agentId);
  if (!a) return;
  version = decodeURIComponent(version);
  if (version === 'live' ? !a.live : version !== 'draft' && !a.named.has(version)) return problem(res, rid, 404, 'NOT_FOUND', `Agent ${a.agent.id} has no version ${version}.`);
  const refusal = faults.unattendedStartErrors?.shift();
  if (refusal) return problem(res, rid, refusal.status, refusal.code, refusal.detail ?? `Refused: ${refusal.code}`);
  const input = parseJson(body) ?? {};
  if (typeof input.message !== 'string' || !input.message) {
    return problem(res, rid, 400, 'VALIDATION_FAILED', 'message is required', { fieldErrors: [{ pointer: '/message', code: 'VALIDATION_FAILED', detail: 'Required' }] });
  }
  const key = req.headers['idempotency-key'];
  const fingerprint = JSON.stringify({ agentId: a.agent.id, version, input });
  if (key) {
    const seen = state.idempotency.get(`CreateUnattendedRun:${key}`);
    if (seen && seen.fingerprint !== fingerprint) return problem(res, rid, 422, 'IDEMPOTENCY_KEY_REUSED', `Idempotency-Key ${key} was used with a different request.`);
  }
  let attachments;
  if (input.attachments !== undefined) {
    const refs = input.attachments;
    if (!Array.isArray(refs) || refs.length < 1 || refs.length > 10 || refs.some((r) => typeof r?.uploadId !== 'string')) {
      return problem(res, rid, 400, 'VALIDATION_FAILED', 'attachments holds 1 to 10 {uploadId}', { fieldErrors: [{ pointer: '/attachments', code: 'VALIDATION_FAILED' }] });
    }
    // A replayed create finds its uploads already used by the first: they are not checked again.
    if (!(key && state.idempotency.has(`CreateUnattendedRun:${key}`))) {
      const ups = [];
      for (const [i, r] of refs.entries()) {
        const taken = consumeUpload(r.uploadId);
        if (taken.problem) return problem(res, rid, taken.status, ...taken.problem);
        // Reserved with purpose {unattendedRun: {agentId, version}} for this agent and version.
        const purpose = taken.up.input.purpose?.unattendedRun;
        if (purpose?.agentId !== a.agent.id || purpose?.version !== version) {
          return problem(res, rid, 400, 'VALIDATION_FAILED', `Upload ${r.uploadId} was not reserved with purpose {unattendedRun: {agentId: "${a.agent.id}", version: "${version}"}}.`, { fieldErrors: [{ pointer: `/attachments/${i}/uploadId`, code: 'VALIDATION_FAILED' }] });
        }
        ups.push(taken.up);
      }
      for (const up of ups) up.status = 'consumed';
      attachments = ups.map((up) => ({ name: up.input.fileName, contentType: up.input.contentType, byteSize: Number(up.input.byteSize) }));
    }
  }
  const result = idempotent(key, 'CreateUnattendedRun', () => {
    const r = newUnattendedRun(a.agent.id, version, input, attachments);
    return { status: 202, body: runNow(r), fingerprint };
  });
  const run = runNow(state.unattendedRuns.get(result.body.id));
  sendJson(res, rid, result.status, run, { Location: `/api/v3/unattended-runs/${run.id}`, ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}) });
}

// ListUnattendedRuns: newest first, across agents; agentId, status, triggerId, earliestStartedAt (inclusive) and
// latestStartedAt (exclusive) filter it.
async function listUnattendedRuns(req, res, rid, _m, url) {
  if (statusFault('ListUnattendedRuns', res, rid)) return;
  const q = url.searchParams;
  for (const k of q.keys()) {
    if (!['agentId', 'status', 'triggerId', 'earliestStartedAt', 'latestStartedAt', 'limit', 'cursor'].includes(k)) return problem(res, rid, 400, 'UNKNOWN_FILTER', `Unknown query parameter ${k}`, { fieldErrors: [{ parameter: k, code: 'UNKNOWN_FILTER' }] });
  }
  let items = [...state.unattendedRuns.values()].map(runNow).reverse();
  if (q.has('agentId')) items = items.filter((r) => r.agent.id === q.get('agentId'));
  if (q.has('status')) items = items.filter((r) => r.status === q.get('status'));
  if (q.has('triggerId')) items = items.filter((r) => r.startedBy.type === 'trigger' && r.startedBy.id === q.get('triggerId'));
  if (q.has('earliestStartedAt')) items = items.filter((r) => Date.parse(r.startedAt) >= Date.parse(q.get('earliestStartedAt')));
  if (q.has('latestStartedAt')) items = items.filter((r) => Date.parse(r.startedAt) < Date.parse(q.get('latestStartedAt')));
  const limit = Number(q.get('limit') ?? 50);
  const start = q.has('cursor') ? JSON.parse(Buffer.from(q.get('cursor'), 'base64url').toString()).offset : 0;
  const next = start + limit < items.length ? Buffer.from(JSON.stringify({ offset: start + limit })).toString('base64url') : undefined;
  sendJson(res, rid, 200, { items: items.slice(start, start + limit), ...(next ? { nextCursor: next } : {}) });
}

async function getUnattendedRun(req, res, rid, [id]) {
  if (statusFault('GetUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (r) sendJson(res, rid, 200, runNow(r));
}

// UpdateUnattendedRun: the title only.
async function updateUnattendedRun(req, res, rid, [id], url, body) {
  if (statusFault('UpdateUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  const input = parseJson(body) ?? {};
  const unknown = Object.keys(input).find((k) => k !== 'title');
  if (unknown) return problem(res, rid, 400, 'VALIDATION_FAILED', `Only title can be changed, not ${unknown}.`, { fieldErrors: [{ pointer: `/${unknown}`, code: 'VALIDATION_FAILED' }] });
  if (typeof input.title !== 'string') return problem(res, rid, 400, 'VALIDATION_FAILED', 'title is required', { fieldErrors: [{ pointer: '/title', code: 'VALIDATION_FAILED' }] });
  r.title = input.title;
  r.renames = (r.renames ?? 0) + 1;
  sendJson(res, rid, 200, runNow(r));
}

// DeleteUnattendedRun: 204; 409 CONFLICT while the run is pending or running (cancel it first).
async function deleteUnattendedRun(req, res, rid, [id]) {
  if (statusFault('DeleteUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  if (!RUN_FINAL.has(runNow(r).status)) return problem(res, rid, 409, 'CONFLICT', `Unattended run ${r.run.id} is still running. Cancel it first.`);
  state.unattendedRuns.delete(r.run.id);
  res.writeHead(204, baseHeaders(rid));
  res.end();
}

// CancelUnattendedRun: 202 with the run. The run stops at its next step: what its watch has not sent yet is
// replaced by its end, `cancelled`. A run already final is answered as it stands.
async function cancelUnattendedRun(req, res, rid, [id]) {
  if (statusFault('CancelUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  const now = runNow(r);
  if (!RUN_FINAL.has(now.status)) {
    r.events = r.events.slice(0, r.sent);
    r.events.push({ id: `${r.run.id}:${r.sent + 1}`, type: 'unattended_run.ended', data: { unattendedRun: { ...now, status: 'cancelled', endedAt: nowIso() } } });
    r.cancelled = true;
    log.push({ event: 'unattended-run-cancelled', runId: r.run.id, afterEvents: r.sent, at: Date.now() });
  }
  sendJson(res, rid, 202, runNow(r));
}

// ReplayUnattendedRun: a new run with the same message, context and attachments, at `version` or, without one,
// the original run's version. 202 with the new run.
async function replayUnattendedRun(req, res, rid, [id], url, body) {
  if (statusFault('ReplayUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  const input = parseJson(body) ?? {};
  const key = req.headers['idempotency-key'];
  const result = idempotent(key, `ReplayUnattendedRun:${r.run.id}`, () => {
    const next = newUnattendedRun(r.run.agent.id, input.version ?? r.run.agent.version, r.request, r.attachments, r.run.id);
    return { status: 202, body: runNow(next) };
  });
  sendJson(res, rid, result.status, runNow(state.unattendedRuns.get(result.body.id)), {
    Location: `/api/v3/unattended-runs/${result.body.id}`,
    ...(result.replayed ? { 'Idempotent-Replayed': 'true' } : {}),
  });
}

// WatchUnattendedRun: a snapshot, then the events after Last-Event-ID, each moving the run on; it ends after
// `unattended_run.ended`. faults.dropAfterEvents (once) drops the connection, as a load balancer would. A cancel
// while the watch is open takes effect at its next event.
async function watchUnattendedRun(req, res, rid, [id]) {
  if (statusFault('WatchUnattendedRun', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', ...baseHeaders(rid) });
  let closed = false;
  res.on('close', () => {
    if (!res.writableFinished) {
      closed = true;
      log.push({ event: 'client-disconnected', subject: `run:${r.run.id}`, at: Date.now() });
    }
  });
  res.write('retry: 2000\n\n');
  const last = req.headers['last-event-id'];
  let at = last ? r.events.findIndex((e) => e.id === last) + 1 : 0;
  res.write(`event: snapshot\ndata: ${JSON.stringify({ unattendedRun: runNow(r) })}\n\n`);
  // faults.resetOnResume (once): a reconnect's cursor cannot be carried on from, as when the answer can no longer be
  // replayed. After the snapshot comes stream.reset, then only the run's end: the answer's other events are not sent.
  if (last && faults.resetOnResume) {
    faults.resetOnResume = false;
    const cursor = `${r.run.id}:reset`;
    res.write(`id: ${cursor}\nevent: stream.reset\ndata: ${JSON.stringify({ cursor })}\n\n`);
    log.push({ event: 'server-reset-stream', subject: `run:${r.run.id}`, at: Date.now() });
    at = r.events.findIndex((e) => e.type === 'unattended_run.ended');
  }
  let sent = 0;
  while (!closed && at < r.events.length) {
    if (faults.streamDelayMs) await sleep(faults.streamDelayMs);
    if (closed) return;
    // A cancel may have cut the events short: carry on from what is there now.
    if (at >= r.events.length) break;
    const e = r.events[at++];
    // The run ends when its end is first sent, not when the mock wrote its script.
    if (at > r.sent && e.type === 'unattended_run.ended') e.data.unattendedRun.endedAt = nowIso();
    r.sent = Math.max(r.sent, at);
    res.write(`id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(runEventData(r, e, at))}\n\n`);
    sent++;
    if (faults.dropAfterEvents != null && sent >= faults.dropAfterEvents && e.type !== 'unattended_run.ended') {
      faults.dropAfterEvents = null;
      log.push({ event: 'server-dropped-stream', subject: `run:${r.run.id}`, afterEventId: e.id, at: Date.now() });
      await sleep(20);
      res.socket?.destroy();
      return;
    }
    if (faults.holdAfterEvents != null && sent === faults.holdAfterEvents) {
      log.push({ event: 'server-holding-stream', subject: `run:${r.run.id}`, afterEventId: e.id, at: Date.now() });
      const until = Date.now() + 10_000;
      // Until a cancel arrives (unattended.cancel), or 10 s.
      while (!closed && Date.now() < until && !r.cancelled) await sleep(10);
    }
  }
  if (!closed) res.end();
}

// ListUnattendedRunMessages: the message the run started with, then its result once it has one.
async function listUnattendedRunMessages(req, res, rid, [id]) {
  if (statusFault('ListUnattendedRunMessages', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  const now = runNow(r);
  const items = [{ id: `${r.run.id}-m1`, role: 'user', text: r.request.message, createdAt: r.run.startedAt, ...(r.attachments.length ? { attachments: r.attachments } : {}) }];
  if (now.result) items.push(now.result);
  sendJson(res, rid, 200, { items });
}

// ListUnattendedRunArtefacts: one report for a run that succeeded, none otherwise.
const runArtefacts = (r) =>
  runNow(r).status === 'succeeded' ? [{ id: 'art-1', fileName: 'review.docx', contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', byteSize: 18_432, createdAt: runNow(r).endedAt }] : [];

async function listUnattendedRunArtefacts(req, res, rid, [id]) {
  if (statusFault('ListUnattendedRunArtefacts', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (r) sendJson(res, rid, 200, { items: runArtefacts(r) });
}

// GetUnattendedRunArtefactDownload: {url, expiresAt} as JSON, as GetDocumentDownload answers.
async function getUnattendedRunArtefactDownload(req, res, rid, [id, artefactId], url) {
  if (statusFault('GetUnattendedRunArtefactDownload', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (!r) return;
  const a = runArtefacts(r).find((x) => x.id === decodeURIComponent(artefactId));
  if (!a) return problem(res, rid, 404, 'NOT_FOUND', `No artefact ${decodeURIComponent(artefactId)}`);
  sendJson(res, rid, 200, { url: `${url.origin}/__s3/artefacts/${r.run.id}/${a.id}`, expiresAt: new Date(Date.now() + 300_000).toISOString() });
}

async function listUnattendedRunAttachments(req, res, rid, [id]) {
  if (statusFault('ListUnattendedRunAttachments', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (r) sendJson(res, rid, 200, { items: r.attachments });
}

async function listUnattendedRunPolicyReviews(req, res, rid, [id]) {
  if (statusFault('ListUnattendedRunPolicyReviews', res, rid)) return;
  const r = runOr404(res, rid, id);
  if (r) sendJson(res, rid, 200, { items: [] });
}

async function getCaller(req, res, rid) {
  if (statusFault('GetCaller', res, rid)) return;
  sendJson(res, rid, 200, { displayName: 'Mock caller', credential: 'personal', scopes: ['knowledge-bases', 'agents'], organisation: { id: 'org-1', name: 'Harbour Freight' } });
}

// ---------------------------------------------------------------------------
// The S3 form POST endpoint (an ingestion batch's upload policy)
// ---------------------------------------------------------------------------

/** multipart/form-data parts, in order: [{name, value} or {name, fileName, contentType, data}]. */
function parseMultipart(req, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/.exec(req.headers['content-type'] ?? '');
  if (!boundary) return null;
  const sep = Buffer.from(`--${boundary[1] ?? boundary[2]}`);
  const parts = [];
  let at = body.indexOf(sep);
  while (at !== -1) {
    const start = at + sep.length;
    if (body.slice(start, start + 2).toString() === '--') break;
    const next = body.indexOf(sep, start);
    if (next === -1) break;
    const part = body.slice(start + 2, next - 2); // past the CRLF after the boundary; before the CRLF ending the part
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.slice(0, headEnd).toString();
    const data = part.slice(headEnd + 4);
    const disposition = /content-disposition:([^\r\n]*)/i.exec(head)?.[1] ?? '';
    const name = /\bname="([^"]*)"/.exec(disposition)?.[1];
    const fileName = /\bfilename="([^"]*)"/.exec(disposition)?.[1];
    const contentType = /content-type:\s*([^\r\n]*)/i.exec(head)?.[1];
    parts.push(fileName !== undefined ? { name, fileName, contentType, data } : { name, value: data.toString() });
    at = next;
  }
  return parts;
}

/** The parts as the request log keeps them: values, and each file's size and SHA-256 in place of its bytes. */
const loggedParts = (parts) =>
  parts.map((p) => (p.data ? { name: p.name, fileName: p.fileName, contentType: p.contentType, byteSize: p.data.length, sha256: sha256b64(p.data) } : { name: p.name, value: p.value.length > 500 ? `${p.value.slice(0, 500)}…` : p.value }));

// POST /__s3/: one file of an ingestion batch, as S3 checks a browser-based upload: the policy's fields in the
// order the upload policy gave them, then key, Content-Type, x-amz-checksum-algorithm (exactly SHA256),
// x-amz-checksum-sha256 (standard base64) and the file, last. The signature must match the policy; the policy must
// not have expired (403 "Invalid according to Policy: Policy expired."); the key must start with its prefix; the
// bytes must match the checksum (400 BadDigest). Status faults: `PostObject`. Answers 204, as S3 does.
async function postObjectForm(req, res, rid, _m, url, body) {
  // The policy is judged when the request arrives, as S3 reads the policy field before the file: a slow upload
  // (uploadDelayMs) that began under a policy is not refused because the policy expired while its bytes were moving.
  const arrived = Date.now();
  state.uploadsInFlight++;
  state.maxUploadsInFlight = Math.max(state.maxUploadsInFlight, state.uploadsInFlight);
  let aborted = false;
  res.on('close', () => {
    if (!res.writableFinished) aborted = true;
  });
  const held = faults.holdUploadsAfter != null && state.uploadsArrived++ >= faults.holdUploadsAfter;
  try {
    const release = faults.releaseUploadsAfterPolicies;
    const released = () => release != null && state.policiesAsked >= release;
    if (held) for (const until = Date.now() + (release != null ? 30_000 : 10_000); !aborted && !released() && Date.now() < until; ) await sleep(10);
    else if (faults.uploadDelayMs) await sleep(faults.uploadDelayMs);
    if (aborted) {
      log.push({ event: 'upload-aborted', requestId: rid, at: Date.now() });
      return;
    }
    if (s3LengthRequired('PostObject', req, res)) return;
    if (s3StatusFault('PostObject', res)) return;
    const parts = parseMultipart(req, body);
    const failing = parts && [...state.batches.values()].flatMap((x) => x.items).find((it) => it.objectKey && it.objectKey === parts.find((p) => p.name === 'key')?.value);
    if (failing && (faults.failUploads?.[failing.path] || faults.failUploads?.[failing.id])) return s3Error(res, 500, 'InternalError', 'Injected failure for this key');
    if (!parts) return s3Error(res, 400, 'MalformedPOSTRequest', 'The body of your POST request is not well-formed multipart/form-data.');
    const fields = Object.fromEntries(parts.filter((p) => !p.data).map((p) => [p.name, p.value]));
    let doc;
    try {
      doc = JSON.parse(Buffer.from(fields.policy ?? '', 'base64').toString());
    } catch {
      return s3Error(res, 403, 'AccessDenied', 'Invalid according to Policy: the policy could not be read.');
    }
    const b = state.batches.get(doc.batchId);
    // S3 compares form field names without regard to case, and refuses a POST that repeats one.
    const got = parts.map((p) => p.name);
    const repeated = got.find((n, i) => got.findIndex((m) => m.toLowerCase() === n.toLowerCase()) !== i);
    if (repeated) {
      log.push({ event: 'storage-refused-repeated-field', field: repeated, at: Date.now() });
      return s3Error(res, 400, 'InvalidArgument', `POST requires exactly one value for each form field; ${repeated} was sent more than once.`);
    }
    const expected = [...FORM_FIELD_ORDER.filter((k) => !OWN_FORM_FIELDS.has(k)), 'key', 'Content-Type', 'x-amz-checksum-algorithm', 'x-amz-checksum-sha256', 'file'];
    if (got.join('\n') !== expected.join('\n')) {
      return s3Error(res, 400, 'InvalidArgument', `The form fields are not in the policy's order: expected ${expected.join(', ')}; got ${got.join(', ')}.`);
    }
    if (crypto.createHmac('sha256', UPLOAD_SECRET).update(fields.policy).digest('hex') !== fields['x-amz-signature']) {
      return s3Error(res, 403, 'SignatureDoesNotMatch', 'The request signature we calculated does not match the signature you provided.');
    }
    if (!b || Date.parse(doc.expiration) <= arrived || b.expiredGeneration === doc.generation) {
      return s3Error(res, 403, 'AccessDenied', 'Invalid according to Policy: Policy expired.');
    }
    if (!fields.key.startsWith(doc.conditions[0][2])) return s3Error(res, 403, 'AccessDenied', 'Invalid according to Policy: Policy Condition failed: ["starts-with", "$key", ...]');
    if (fields['x-amz-checksum-algorithm'] !== 'SHA256') return s3Error(res, 403, 'AccessDenied', 'Invalid according to Policy: Policy Condition failed: ["eq", "$x-amz-checksum-algorithm", "SHA256"]');
    const file = parts.at(-1).data;
    if (file.length < 1 || file.length > MAX_FILE) return s3Error(res, 400, 'EntityTooLarge', 'Your proposed upload exceeds the maximum allowed size');
    const sha = sha256b64(file);
    if (sha !== fields['x-amz-checksum-sha256']) return s3Error(res, 400, 'BadDigest', 'The SHA256 you specified did not match the calculated checksum.');
    // When the bytes arrived, against the reservation in force then (faults.uploadReservation).
    const late = b.reservedByPolicy && Date.now() > Date.parse(b.uploadsExpireAt);
    state.objects.set(fields.key, { key: fields.key, sha256: sha, byteSize: file.length, contentType: fields['Content-Type'], arrivedAt: Date.now(), late });
    res.writeHead(204, { ETag: `"${sha}"` });
    res.end();
  } finally {
    state.uploadsInFlight--;
  }
}

// ---------------------------------------------------------------------------

const LOGGED_HEADERS = ['authorization', 'cookie', 'origin', 'idempotency-key', 'if-match', 'last-event-id', 'accept', 'content-type', 'content-length', 'user-agent', 'traceparent', 'caitlyn-sdk-model', 'caitlyn-api-version', 'x-amz-checksum-sha256'];

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
    if (url.pathname === '/__mock/uploads' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ maxInFlight: state.maxUploadsInFlight, objects: [...state.objects.values()] }));
    }
    if (url.pathname === '/__mock/example' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(primed ? { id: primed.case.id, served: primed.served, mismatches: primed.mismatches } : null));
    }
    const body = req.method === 'POST' && url.pathname === '/__s3/' && faults.uploadReadBytesPerSecond ? await readBodySlowly(req, faults.uploadReadBytesPerSecond) : await readBody(req);
    const multipart = req.method === 'POST' && url.pathname === '/__s3/' ? parseMultipart(req, body) : null;
    const entry = {
      headerNames: Object.keys(req.headers),
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: {},
      // JSON bodies are kept whole up to 4 MB (a batch of 1,000 items is about 200 KB); bytes are not.
      body: body.length && !multipart && (body.length < 10_000 || (body.length < 4_000_000 && String(req.headers['content-type']).startsWith('application/json'))) ? body.toString() : undefined,
      bodyLength: body.length,
      bodySha256: sha256b64(body),
      ...(multipart ? { form: loggedParts(multipart) } : {}),
      at: Date.now(),
      requestId: rid,
    };
    for (const h of LOGGED_HEADERS) if (req.headers[h] != null) entry.headers[h] = req.headers[h];
    // The status it was answered with, once it has been (the CLI's agent evaluation grades on it)
    res.on('finish', () => {
      entry.status = res.statusCode;
    });
    log.push(entry);
    if (await handleAuth(req, res, url, body)) return;
    if (url.pathname.startsWith('/v3/') && !authorised(req)) {
      const delay = refusalDelayMs();
      if (delay) await new Promise((r) => setTimeout(r, delay));
      return problem(res, rid, 401, 'UNAUTHENTICATED', 'The bearer token is missing, expired or not valid for this workspace');
    }
    if (req.headers['if-match'] === '*' && !faults.allowIfMatchWildcard) {
      return problem(res, rid, 400, 'IF_MATCH_WILDCARD_NOT_ASKED', 'If-Match: * was sent, and this case did not ask for it: no SDK helper may send it on its own (PROTOCOL.md 8).');
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
