const _AC = "AgentConfiguration";
const _AS = "AttachmentSettings";
const _CAV = "Caitlyn-Api-Version";
const _CD = "CreateDocument";
const _CDI = "CreateDocumentInput";
const _CDO = "CreateDocumentOutput";
const _CE = "ConflictError";
const _CI = "ContextItem";
const _CIL = "ContextItemList";
const _CRI = "Caitlyn-Request-Id";
const _CS = "ContentSafety";
const _CU = "CreateUpload";
const _CUI = "CreateUploadInput";
const _CUO = "CreateUploadOutput";
const _D = "Document";
const _DL = "DocumentList";
const _ESB = "EventStreamBody";
const _ET = "ETag";
const _FE = "FieldError";
const _FEL = "FieldErrorList";
const _GAV = "GetAgentVersion";
const _GAVI = "GetAgentVersionInput";
const _GAVO = "GetAgentVersionOutput";
const _IE = "InternalError";
const _IK = "Idempotency-Key";
const _IM = "If-Match";
const _KBB = "KnowledgeBaseBinding";
const _KBBL = "KnowledgeBaseBindingList";
const _L = "Location";
const _LD = "ListDocuments";
const _LDI = "ListDocumentsInput";
const _LDO = "ListDocumentsOutput";
const _LEI = "Last-Event-ID";
const _NFE = "NotFoundError";
const _O = "Operation";
const _PDE = "PermissionDeniedError";
const _PF = "PartialFailure";
const _PFE = "PreconditionFailedError";
const _PFL = "PartialFailureList";
const _PRE = "PreconditionRequiredError";
const _PTLE = "PayloadTooLargeError";
const _RA = "Retry-After";
const _RCS = "ResumeConversationStream";
const _RCSI = "ResumeConversationStreamInput";
const _RCSO = "ResumeConversationStreamOutput";
const _SM = "SendMessage";
const _SMI = "SendMessageInput";
const _SMO = "SendMessageOutput";
const _SUE = "ServiceUnavailableError";
const _TMRE = "TooManyRequestsError";
const _UCE = "UnprocessableContentError";
const _UDV = "UpdateDraftVersion";
const _UDVI = "UpdateDraftVersionInput";
const _UDVO = "UpdateDraftVersionOutput";
const _UE = "UnauthenticatedError";
const _VE = "ValidationError";
const _a = "attachments";
const _aI = "agentId";
const _aV = "apiVersion";
const _bO = "basedOn";
const _bS = "byteSize";
const _c = "client";
const _cA = "createdAt";
const _cI = "conversationId";
const _cS = "contentSafety";
const _cT = "contentType";
const _cl = "clear";
const _co = "code";
const _con = "configuration";
const _cont = "context";
const _cu = "cursor";
const _d = "detail";
const _dD = "deniedDocuments";
const _da = "data";
const _do = "document";
const _e = "error";
const _eA = "expiresAt";
const _en = "enabled";
const _er = "errors";
const _et = "etag";
const _ev = "events";
const _f = "folder";
const _fN = "fileName";
const _fW = "filter[name][startsWith]";
const _fi = "filter[folder][eq]";
const _fil = "filter[status][eq]";
const _gI = "guardrailId";
const _h = "http";
const _hE = "httpError";
const _hH = "httpHeader";
const _hQ = "httpQuery";
const _i = "instructions";
const _iK = "idempotencyKey";
const _iM = "ifMatch";
const _iT = "idempotencyToken";
const _id = "identity";
const _id_ = "id";
const _it = "items";
const _k = "kind";
const _kB = "knowledgeBases";
const _kBI = "knowledgeBaseId";
const _l = "label";
const _lEI = "lastEventId";
const _li = "limit";
const _lo = "location";
const _m = "model";
const _mF = "maxFiles";
const _mP = "matchesProduction";
const _mS = "minimumScore";
const _mT = "mediaType";
const _me = "message";
const _n = "name";
const _nC = "nextCursor";
const _nOR = "numberOfResults";
const _nP = "namePrefix";
const _no = "note";
const _o = "operation";
const _p = "pointer";
const _pF = "partialFailures";
const _pa = "parameter";
const _rAS = "retryAfterSeconds";
const _rH = "requiredHeaders";
const _rI = "requestId";
const _s = "smithy.ts.sdk.synthetic.ai.caitlyn.v3";
const _se = "server";
const _sh = "sha256";
const _so = "source";
const _sor = "sort";
const _st = "status";
const _sta = "stage";
const _str = "streaming";
const _t = "type";
const _tI = "targetId";
const _ti = "title";
const _ts = "text/event-stream";
const _u = "uri";
const _uA = "updatedAt";
const _uI = "uploadId";
const _uM = "uploadMethod";
const _uU = "uploadUrl";
const _v = "version";
const n0 = "ai.caitlyn.v3";

// smithy-typescript generated code
import { TypeRegistry } from "@smithy/core/schema";
import type {
  StaticErrorSchema,
  StaticListSchema,
  StaticMapSchema,
  StaticOperationSchema,
  StaticSimpleSchema,
  StaticStructureSchema,
} from "@smithy/types";

import { CaitlynServiceException } from "../models/CaitlynServiceException";
import {
  ConflictError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionDeniedError,
  PreconditionFailedError,
  PreconditionRequiredError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthenticatedError,
  UnprocessableContentError,
  ValidationError,
} from "../models/errors";

/* eslint no-var: 0 */
const _s_registry = new TypeRegistry(_s);
export var CaitlynServiceException$: StaticErrorSchema = [-3, _s, "CaitlynServiceException", 0, [], []];
_s_registry.registerError(CaitlynServiceException$, CaitlynServiceException);
const n0_registry = new TypeRegistry(n0);
export var ConflictError$: StaticErrorSchema = [-3, n0, _CE,
  { [_e]: _c, [_hE]: 409 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(ConflictError$, ConflictError);
export var InternalError$: StaticErrorSchema = [-3, n0, _IE,
  { [_e]: _se, [_hE]: 500 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(InternalError$, InternalError);
export var NotFoundError$: StaticErrorSchema = [-3, n0, _NFE,
  { [_e]: _c, [_hE]: 404 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(NotFoundError$, NotFoundError);
export var PayloadTooLargeError$: StaticErrorSchema = [-3, n0, _PTLE,
  { [_e]: _c, [_hE]: 413 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(PayloadTooLargeError$, PayloadTooLargeError);
export var PermissionDeniedError$: StaticErrorSchema = [-3, n0, _PDE,
  { [_e]: _c, [_hE]: 403 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(PermissionDeniedError$, PermissionDeniedError);
export var PreconditionFailedError$: StaticErrorSchema = [-3, n0, _PFE,
  { [_e]: _c, [_hE]: 412 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(PreconditionFailedError$, PreconditionFailedError);
export var PreconditionRequiredError$: StaticErrorSchema = [-3, n0, _PRE,
  { [_e]: _c, [_hE]: 428 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(PreconditionRequiredError$, PreconditionRequiredError);
export var ServiceUnavailableError$: StaticErrorSchema = [-3, n0, _SUE,
  { [_e]: _se, [_hE]: 503 },
  [_t, _ti, _st, _co, _rI, _d, _er, _rAS],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList, [1, { [_hH]: _RA }]], 5
];
n0_registry.registerError(ServiceUnavailableError$, ServiceUnavailableError);
export var TooManyRequestsError$: StaticErrorSchema = [-3, n0, _TMRE,
  { [_e]: _c, [_hE]: 429 },
  [_t, _ti, _st, _co, _rI, _d, _er, _rAS],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList, [1, { [_hH]: _RA }]], 5
];
n0_registry.registerError(TooManyRequestsError$, TooManyRequestsError);
export var UnauthenticatedError$: StaticErrorSchema = [-3, n0, _UE,
  { [_e]: _c, [_hE]: 401 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(UnauthenticatedError$, UnauthenticatedError);
export var UnprocessableContentError$: StaticErrorSchema = [-3, n0, _UCE,
  { [_e]: _c, [_hE]: 422 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(UnprocessableContentError$, UnprocessableContentError);
export var ValidationError$: StaticErrorSchema = [-3, n0, _VE,
  { [_e]: _c, [_hE]: 400 },
  [_t, _ti, _st, _co, _rI, _d, _er],
  [0, 0, 1, 0, 0, 0, () => FieldErrorList], 5
];
n0_registry.registerError(ValidationError$, ValidationError);
/**
 * TypeRegistry instances containing modeled errors.
 * @internal
 *
 */
export const errorTypeRegistries = [
  _s_registry,
  n0_registry,
]
var EventStreamBody: StaticSimpleSchema = [0, n0, _ESB, { [_mT]: _ts, [_str]: 1 }, 42];
export var AgentConfiguration$: StaticStructureSchema = [3, n0, _AC,
  0,
  [_i, _id, _m, _kB, _a, _cS, _dD],
  [0, 0, 0, () => KnowledgeBaseBindingList, () => AttachmentSettings$, () => ContentSafety$, 2], 1
];
export var AttachmentSettings$: StaticStructureSchema = [3, n0, _AS,
  0,
  [_en, _mF],
  [2, 1]
];
export var ContentSafety$: StaticStructureSchema = [3, n0, _CS,
  0,
  [_gI],
  [0]
];
export var ContextItem$: StaticStructureSchema = [3, n0, _CI,
  0,
  [_t, _l, _u, _da],
  [0, 0, 0, 15], 2
];
export var CreateDocumentInput$: StaticStructureSchema = [3, n0, _CDI,
  0,
  [_kBI, _uI, _f, _iK, _n],
  [[0, 1], 0, 0, [0, { [_hH]: _IK, [_iT]: 1 }], 0], 3
];
export var CreateDocumentOutput$: StaticStructureSchema = [3, n0, _CDO,
  0,
  [_do, _o, _rI, _aV, _lo],
  [() => Document$, () => Operation$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], [0, { [_hH]: _L }]], 2
];
export var CreateUploadInput$: StaticStructureSchema = [3, n0, _CUI,
  0,
  [_fN, _cT, _bS, _sh, _iK],
  [0, 0, 1, 0, [0, { [_hH]: _IK, [_iT]: 1 }]], 4
];
export var CreateUploadOutput$: StaticStructureSchema = [3, n0, _CUO,
  0,
  [_id_, _uU, _uM, _rH, _eA, _st, _rI, _aV, _lo],
  [0, 0, 0, 128 | 0, 5, 0, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], [0, { [_hH]: _L }]], 6
];
export var Document$: StaticStructureSchema = [3, n0, _D,
  0,
  [_id_, _kBI, _n, _f, _st, _cA, _uA, _sta, _cT, _bS, _sh, _pF],
  [0, 0, 0, 0, 0, 5, 5, 0, 0, 1, 0, () => PartialFailureList], 7
];
export var FieldError$: StaticStructureSchema = [3, n0, _FE,
  0,
  [_co, _p, _pa, _d],
  [0, 0, 0, 0], 1
];
export var GetAgentVersionInput$: StaticStructureSchema = [3, n0, _GAVI,
  0,
  [_aI, _v],
  [[0, 1], [0, 1]], 2
];
export var GetAgentVersionOutput$: StaticStructureSchema = [3, n0, _GAVO,
  0,
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 0], 5
];
export var KnowledgeBaseBinding$: StaticStructureSchema = [3, n0, _KBB,
  0,
  [_kBI, _nOR, _mS],
  [0, 1, 1], 1
];
export var ListDocumentsInput$: StaticStructureSchema = [3, n0, _LDI,
  0,
  [_kBI, _li, _cu, _sor, _f, _st, _nP],
  [[0, 1], [1, { [_hQ]: _li }], [0, { [_hQ]: _cu }], [0, { [_hQ]: _sor }], [0, { [_hQ]: _fi }], [0, { [_hQ]: _fil }], [0, { [_hQ]: _fW }]], 1
];
export var ListDocumentsOutput$: StaticStructureSchema = [3, n0, _LDO,
  0,
  [_it, _rI, _aV, _nC],
  [() => DocumentList, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0], 1
];
export var Operation$: StaticStructureSchema = [3, n0, _O,
  0,
  [_id_, _k, _st, _cA],
  [0, 0, 0, 5], 4
];
export var PartialFailure$: StaticStructureSchema = [3, n0, _PF,
  0,
  [_co, _tI, _d],
  [0, 0, 0], 1
];
export var ResumeConversationStreamInput$: StaticStructureSchema = [3, n0, _RCSI,
  0,
  [_cI, _lEI],
  [[0, 1], [0, { [_hH]: _LEI }]], 1
];
export var ResumeConversationStreamOutput$: StaticStructureSchema = [3, n0, _RCSO,
  0,
  [_ev, _rI, _aV],
  [[() => EventStreamBody, 16], [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 1
];
export var SendMessageInput$: StaticStructureSchema = [3, n0, _SMI,
  0,
  [_cI, _me, _cont],
  [[0, 1], 0, () => ContextItemList], 2
];
export var SendMessageOutput$: StaticStructureSchema = [3, n0, _SMO,
  0,
  [_ev, _rI, _aV],
  [[() => EventStreamBody, 16], [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 1
];
export var UpdateDraftVersionInput$: StaticStructureSchema = [3, n0, _UDVI,
  0,
  [_aI, _iM, _id, _i, _m, _kB, _a, _cS, _dD, _cl],
  [[0, 1], [0, { [_hH]: _IM }], 0, 0, 0, () => KnowledgeBaseBindingList, () => AttachmentSettings$, () => ContentSafety$, 2, 64 | 0], 2
];
export var UpdateDraftVersionOutput$: StaticStructureSchema = [3, n0, _UDVO,
  0,
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 0], 5
];
var ClearableDraftFieldList = 64 | 0;
var ContextItemList: StaticListSchema = [1, n0, _CIL,
  0, () => ContextItem$
];
var DocumentList: StaticListSchema = [1, n0, _DL,
  0, () => Document$
];
var FieldErrorList: StaticListSchema = [1, n0, _FEL,
  0, () => FieldError$
];
var KnowledgeBaseBindingList: StaticListSchema = [1, n0, _KBBL,
  0, () => KnowledgeBaseBinding$
];
var PartialFailureList: StaticListSchema = [1, n0, _PFL,
  0, () => PartialFailure$
];
var HeaderMap = 128 | 0;
export var CreateDocument$: StaticOperationSchema = [9, n0, _CD,
  { [_h]: ["POST", "/v3/knowledge-bases/{knowledgeBaseId}/documents", 202] }, () => CreateDocumentInput$, () => CreateDocumentOutput$
];
export var CreateUpload$: StaticOperationSchema = [9, n0, _CU,
  { [_h]: ["POST", "/v3/uploads", 201] }, () => CreateUploadInput$, () => CreateUploadOutput$
];
export var GetAgentVersion$: StaticOperationSchema = [9, n0, _GAV,
  { [_h]: ["GET", "/v3/agents/{agentId}/versions/{version}", 200] }, () => GetAgentVersionInput$, () => GetAgentVersionOutput$
];
export var ListDocuments$: StaticOperationSchema = [9, n0, _LD,
  { [_h]: ["GET", "/v3/knowledge-bases/{knowledgeBaseId}/documents", 200] }, () => ListDocumentsInput$, () => ListDocumentsOutput$
];
export var ResumeConversationStream$: StaticOperationSchema = [9, n0, _RCS,
  { [_h]: ["GET", "/v3/conversations/{conversationId}/stream", 200] }, () => ResumeConversationStreamInput$, () => ResumeConversationStreamOutput$
];
export var SendMessage$: StaticOperationSchema = [9, n0, _SM,
  { [_h]: ["POST", "/v3/conversations/{conversationId}/send", 200] }, () => SendMessageInput$, () => SendMessageOutput$
];
export var UpdateDraftVersion$: StaticOperationSchema = [9, n0, _UDV,
  { [_h]: ["PATCH", "/v3/agents/{agentId}/versions/draft", 200] }, () => UpdateDraftVersionInput$, () => UpdateDraftVersionOutput$
];
