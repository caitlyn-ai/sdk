const _A = "Actor";
const _AC = "AgentConfiguration";
const _AS = "AttachmentSettings";
const _AVS = "AgentVersionSummary";
const _AVSL = "AgentVersionSummaryList";
const _BDD = "BatchDeleteDocuments";
const _BDDI = "BatchDeleteDocumentsInput";
const _BDDO = "BatchDeleteDocumentsOutput";
const _CAV = "Caitlyn-Api-Version";
const _CC = "CreateConversation";
const _CCI = "CreateConversationInput";
const _CCO = "CreateConversationOutput";
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
const _DAV = "DeleteAgentVersion";
const _DAVI = "DeleteAgentVersionInput";
const _DAVO = "DeleteAgentVersionOutput";
const _DD = "DeleteDocument";
const _DDI = "DeleteDocumentInput";
const _DDO = "DeleteDocumentOutput";
const _DDR = "DocumentDeleteResult";
const _DDRL = "DocumentDeleteResultList";
const _DF = "DocumentFailure";
const _DL = "DocumentList";
const _ESB = "EventStreamBody";
const _ET = "ETag";
const _FE = "FieldError";
const _FEL = "FieldErrorList";
const _GAV = "GetAgentVersion";
const _GAVI = "GetAgentVersionInput";
const _GAVO = "GetAgentVersionOutput";
const _GC = "GetCaller";
const _GCI = "GetCallerInput";
const _GCO = "GetCallerOutput";
const _GD = "GetDocument";
const _GDI = "GetDocumentInput";
const _GDO = "GetDocumentOutput";
const _GPHE = "GetProductionHistoryEntry";
const _GPHEI = "GetProductionHistoryEntryInput";
const _GPHEO = "GetProductionHistoryEntryOutput";
const _GU = "GetUpload";
const _GUI = "GetUploadInput";
const _GUO = "GetUploadOutput";
const _IE = "InternalError";
const _IK = "Idempotency-Key";
const _IM = "If-Match";
const _KBB = "KnowledgeBaseBinding";
const _KBBL = "KnowledgeBaseBindingList";
const _L = "Location";
const _LAV = "ListAgentVersions";
const _LAVI = "ListAgentVersionsInput";
const _LAVO = "ListAgentVersionsOutput";
const _LD = "ListDocuments";
const _LDI = "ListDocumentsInput";
const _LDO = "ListDocumentsOutput";
const _LEI = "Last-Event-ID";
const _LPHE = "ListProductionHistoryEntries";
const _LPHEI = "ListProductionHistoryEntriesInput";
const _LPHEO = "ListProductionHistoryEntriesOutput";
const _NFE = "NotFoundError";
const _O = "Operation";
const _OS = "OrganisationSummary";
const _PAV = "PublishAgentVersion";
const _PAVI = "PublishAgentVersionInput";
const _PAVO = "PublishAgentVersionOutput";
const _PDE = "PermissionDeniedError";
const _PDV = "PinDraftVersion";
const _PDVI = "PinDraftVersionInput";
const _PDVO = "PinDraftVersionOutput";
const _PF = "PartialFailure";
const _PFE = "PreconditionFailedError";
const _PFL = "PartialFailureList";
const _PHS = "ProductionHistorySummary";
const _PHSL = "ProductionHistorySummaryList";
const _PRE = "PreconditionRequiredError";
const _PTLE = "PayloadTooLargeError";
const _RA = "Retry-After";
const _RDV = "ResetDraftVersion";
const _RDVI = "ResetDraftVersionInput";
const _RDVO = "ResetDraftVersionOutput";
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
const _WC = "WatchConversation";
const _WCI = "WatchConversationInput";
const _WCO = "WatchConversationOutput";
const _WWE = "WatchWorkspaceEvents";
const _WWEI = "WatchWorkspaceEventsInput";
const _WWEO = "WatchWorkspaceEventsOutput";
const _a = "attachments";
const _aCI = "apiClientId";
const _aI = "agentId";
const _aV = "apiVersion";
const _af = "after";
const _bO = "basedOn";
const _bS = "byteSize";
const _c = "client";
const _cA = "createdAt";
const _cI = "conversationId";
const _cIo = "conversationIds";
const _cS = "contentSafety";
const _cT = "contentType";
const _cl = "clear";
const _co = "code";
const _con = "configuration";
const _cont = "context";
const _cr = "credential";
const _cu = "cursor";
const _d = "detail";
const _dD = "deniedDocuments";
const _dI = "documentIds";
const _dIo = "documentId";
const _dN = "displayName";
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
const _fa = "failure";
const _fi = "filter[folder][eq]";
const _fil = "filter[status][eq]";
const _fr = "from";
const _gI = "guardrailId";
const _h = "http";
const _hE = "httpError";
const _hEI = "historyEntryId";
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
const _or = "organisation";
const _p = "pointer";
const _pA = "publishedAt";
const _pB = "publishedBy";
const _pF = "partialFailures";
const _pa = "parameter";
const _r = "results";
const _rAS = "retryAfterSeconds";
const _rH = "requiredHeaders";
const _rI = "requestId";
const _s = "smithy.ts.sdk.synthetic.ai.caitlyn.v3";
const _sc = "scopes";
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
const _ty = "types";
const _u = "uri";
const _uA = "updatedAt";
const _uAn = "unpublishedAt";
const _uB = "unpublishedBy";
const _uI = "userId";
const _uIp = "uploadId";
const _uM = "uploadMethod";
const _uU = "uploadUrl";
const _v = "version";
const _vN = "versionName";
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
export var Actor$: StaticStructureSchema = [3, n0, _A,
  0,
  [_dN, _uI, _aCI],
  [0, 0, 0], 1
];
export var AgentConfiguration$: StaticStructureSchema = [3, n0, _AC,
  0,
  [_i, _id, _m, _kB, _a, _cS, _dD],
  [0, 0, 0, () => KnowledgeBaseBindingList, () => AttachmentSettings$, () => ContentSafety$, 2], 1
];
export var AgentVersionSummary$: StaticStructureSchema = [3, n0, _AVS,
  0,
  [_n, _cA, _so, _bO, _mP, _no],
  [0, 5, 0, 0, 2, 0], 2
];
export var AttachmentSettings$: StaticStructureSchema = [3, n0, _AS,
  0,
  [_en, _mF],
  [2, 1]
];
export var BatchDeleteDocumentsInput$: StaticStructureSchema = [3, n0, _BDDI,
  0,
  [_kBI, _dI],
  [[0, 1], 64 | 0], 2
];
export var BatchDeleteDocumentsOutput$: StaticStructureSchema = [3, n0, _BDDO,
  0,
  [_r, _rI, _aV],
  [() => DocumentDeleteResultList, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 1
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
export var CreateConversationInput$: StaticStructureSchema = [3, n0, _CCI,
  0,
  [_aI, _v, _iK, _ti],
  [0, 0, [0, { [_hH]: _IK, [_iT]: 1 }], 0], 2
];
export var CreateConversationOutput$: StaticStructureSchema = [3, n0, _CCO,
  0,
  [_id_, _aI, _v, _cA, _rI, _aV, _lo, _ti],
  [0, 0, 0, 5, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], [0, { [_hH]: _L }], 0], 4
];
export var CreateDocumentInput$: StaticStructureSchema = [3, n0, _CDI,
  0,
  [_kBI, _uIp, _f, _iK, _n],
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
export var DeleteAgentVersionInput$: StaticStructureSchema = [3, n0, _DAVI,
  0,
  [_aI, _v],
  [[0, 1], [0, 1]], 2
];
export var DeleteAgentVersionOutput$: StaticStructureSchema = [3, n0, _DAVO,
  0,
  [_rI, _aV],
  [[0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]]
];
export var DeleteDocumentInput$: StaticStructureSchema = [3, n0, _DDI,
  0,
  [_kBI, _dIo],
  [[0, 1], [0, 1]], 2
];
export var DeleteDocumentOutput$: StaticStructureSchema = [3, n0, _DDO,
  0,
  [_id_, _kBI, _n, _f, _st, _cA, _uA, _rI, _aV, _sta, _cT, _bS, _sh, _pF, _fa],
  [0, 0, 0, 0, 0, 5, 5, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 1, 0, () => PartialFailureList, () => DocumentFailure$], 7
];
export var Document$: StaticStructureSchema = [3, n0, _D,
  0,
  [_id_, _kBI, _n, _f, _st, _cA, _uA, _sta, _cT, _bS, _sh, _pF, _fa],
  [0, 0, 0, 0, 0, 5, 5, 0, 0, 1, 0, () => PartialFailureList, () => DocumentFailure$], 7
];
export var DocumentDeleteResult$: StaticStructureSchema = [3, n0, _DDR,
  0,
  [_dIo, _st, _co, _d],
  [0, 0, 0, 0], 2
];
export var DocumentFailure$: StaticStructureSchema = [3, n0, _DF,
  0,
  [_co, _me],
  [0, 0], 2
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
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _pA, _pB, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 5, () => Actor$, 0], 5
];
export var GetCallerInput$: StaticStructureSchema = [3, n0, _GCI,
  0,
  [],
  []
];
export var GetCallerOutput$: StaticStructureSchema = [3, n0, _GCO,
  0,
  [_dN, _cr, _sc, _or, _rI, _aV, _uI, _aCI],
  [0, 0, 64 | 0, () => OrganisationSummary$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0], 4
];
export var GetDocumentInput$: StaticStructureSchema = [3, n0, _GDI,
  0,
  [_kBI, _dIo],
  [[0, 1], [0, 1]], 2
];
export var GetDocumentOutput$: StaticStructureSchema = [3, n0, _GDO,
  0,
  [_id_, _kBI, _n, _f, _st, _cA, _uA, _rI, _aV, _sta, _cT, _bS, _sh, _pF, _fa],
  [0, 0, 0, 0, 0, 5, 5, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 1, 0, () => PartialFailureList, () => DocumentFailure$], 7
];
export var GetProductionHistoryEntryInput$: StaticStructureSchema = [3, n0, _GPHEI,
  0,
  [_aI, _hEI],
  [[0, 1], [0, 1]], 2
];
export var GetProductionHistoryEntryOutput$: StaticStructureSchema = [3, n0, _GPHEO,
  0,
  [_id_, _aI, _pA, _pB, _uAn, _uB, _con, _rI, _aV, _vN, _no],
  [0, 0, 5, () => Actor$, 5, () => Actor$, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0], 7
];
export var GetUploadInput$: StaticStructureSchema = [3, n0, _GUI,
  0,
  [_uIp],
  [[0, 1]], 1
];
export var GetUploadOutput$: StaticStructureSchema = [3, n0, _GUO,
  0,
  [_id_, _st, _eA, _rI, _aV],
  [0, 0, 5, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 3
];
export var KnowledgeBaseBinding$: StaticStructureSchema = [3, n0, _KBB,
  0,
  [_kBI, _nOR, _mS],
  [0, 1, 1], 1
];
export var ListAgentVersionsInput$: StaticStructureSchema = [3, n0, _LAVI,
  0,
  [_aI, _li, _cu],
  [[0, 1], [1, { [_hQ]: _li }], [0, { [_hQ]: _cu }]], 1
];
export var ListAgentVersionsOutput$: StaticStructureSchema = [3, n0, _LAVO,
  0,
  [_it, _rI, _aV, _nC],
  [() => AgentVersionSummaryList, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0], 1
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
export var ListProductionHistoryEntriesInput$: StaticStructureSchema = [3, n0, _LPHEI,
  0,
  [_aI, _li, _cu],
  [[0, 1], [1, { [_hQ]: _li }], [0, { [_hQ]: _cu }]], 1
];
export var ListProductionHistoryEntriesOutput$: StaticStructureSchema = [3, n0, _LPHEO,
  0,
  [_it, _rI, _aV, _nC],
  [() => ProductionHistorySummaryList, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0], 1
];
export var Operation$: StaticStructureSchema = [3, n0, _O,
  0,
  [_id_, _k, _st, _cA],
  [0, 0, 0, 5], 4
];
export var OrganisationSummary$: StaticStructureSchema = [3, n0, _OS,
  0,
  [_id_, _n],
  [0, 0], 2
];
export var PartialFailure$: StaticStructureSchema = [3, n0, _PF,
  0,
  [_co, _tI, _d],
  [0, 0, 0], 1
];
export var PinDraftVersionInput$: StaticStructureSchema = [3, n0, _PDVI,
  0,
  [_aI, _n, _iK, _iM, _no],
  [[0, 1], 0, [0, { [_hH]: _IK, [_iT]: 1 }], [0, { [_hH]: _IM }], 0], 2
];
export var PinDraftVersionOutput$: StaticStructureSchema = [3, n0, _PDVO,
  0,
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _pA, _pB, _no, _lo],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 5, () => Actor$, 0, [0, { [_hH]: _L }]], 5
];
export var ProductionHistorySummary$: StaticStructureSchema = [3, n0, _PHS,
  0,
  [_id_, _aI, _pA, _pB, _uAn, _uB, _vN, _no],
  [0, 0, 5, () => Actor$, 5, () => Actor$, 0, 0], 6
];
export var PublishAgentVersionInput$: StaticStructureSchema = [3, n0, _PAVI,
  0,
  [_aI, _v, _iM, _n, _no],
  [[0, 1], [0, 1], [0, { [_hH]: _IM }], 0, 0], 3
];
export var PublishAgentVersionOutput$: StaticStructureSchema = [3, n0, _PAVO,
  0,
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _pA, _pB, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 5, () => Actor$, 0], 5
];
export var ResetDraftVersionInput$: StaticStructureSchema = [3, n0, _RDVI,
  0,
  [_aI, _iM, _fr],
  [[0, 1], [0, { [_hH]: _IM }], 0], 3
];
export var ResetDraftVersionOutput$: StaticStructureSchema = [3, n0, _RDVO,
  0,
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _pA, _pB, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 5, () => Actor$, 0], 5
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
  [_et, _aI, _n, _cA, _con, _rI, _aV, _so, _bO, _mP, _pA, _pB, _no],
  [[0, { [_hH]: _ET }], 0, 0, 5, () => AgentConfiguration$, [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }], 0, 0, 2, 5, () => Actor$, 0], 5
];
export var WatchConversationInput$: StaticStructureSchema = [3, n0, _WCI,
  0,
  [_cI, _lEI],
  [[0, 1], [0, { [_hH]: _LEI }]], 1
];
export var WatchConversationOutput$: StaticStructureSchema = [3, n0, _WCO,
  0,
  [_ev, _rI, _aV],
  [[() => EventStreamBody, 16], [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 1
];
export var WatchWorkspaceEventsInput$: StaticStructureSchema = [3, n0, _WWEI,
  0,
  [_ty, _cIo, _af, _lEI],
  [[64 | 0, { [_hQ]: _t }], [64 | 0, { [_hQ]: _cI }], [0, { [_hQ]: _af }], [0, { [_hH]: _LEI }]]
];
export var WatchWorkspaceEventsOutput$: StaticStructureSchema = [3, n0, _WWEO,
  0,
  [_ev, _rI, _aV],
  [[() => EventStreamBody, 16], [0, { [_hH]: _CRI }], [0, { [_hH]: _CAV }]], 1
];
var AgentVersionSummaryList: StaticListSchema = [1, n0, _AVSL,
  0, () => AgentVersionSummary$
];
var ClearableDraftFieldList = 64 | 0;
var ContextItemList: StaticListSchema = [1, n0, _CIL,
  0, () => ContextItem$
];
var ConversationIdList = 64 | 0;
var DocumentDeleteResultList: StaticListSchema = [1, n0, _DDRL,
  0, () => DocumentDeleteResult$
];
var DocumentIdList = 64 | 0;
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
var ProductionHistorySummaryList: StaticListSchema = [1, n0, _PHSL,
  0, () => ProductionHistorySummary$
];
var ScopeList = 64 | 0;
var WorkspaceEventTypeList = 64 | 0;
var HeaderMap = 128 | 0;
export var BatchDeleteDocuments$: StaticOperationSchema = [9, n0, _BDD,
  { [_h]: ["POST", "/v3/knowledge-bases/{knowledgeBaseId}/documents:batch-delete", 200] }, () => BatchDeleteDocumentsInput$, () => BatchDeleteDocumentsOutput$
];
export var CreateConversation$: StaticOperationSchema = [9, n0, _CC,
  { [_h]: ["POST", "/v3/conversations", 201] }, () => CreateConversationInput$, () => CreateConversationOutput$
];
export var CreateDocument$: StaticOperationSchema = [9, n0, _CD,
  { [_h]: ["POST", "/v3/knowledge-bases/{knowledgeBaseId}/documents", 202] }, () => CreateDocumentInput$, () => CreateDocumentOutput$
];
export var CreateUpload$: StaticOperationSchema = [9, n0, _CU,
  { [_h]: ["POST", "/v3/uploads", 201] }, () => CreateUploadInput$, () => CreateUploadOutput$
];
export var DeleteAgentVersion$: StaticOperationSchema = [9, n0, _DAV,
  { [_h]: ["DELETE", "/v3/agents/{agentId}/versions/{version}", 204] }, () => DeleteAgentVersionInput$, () => DeleteAgentVersionOutput$
];
export var DeleteDocument$: StaticOperationSchema = [9, n0, _DD,
  { [_h]: ["DELETE", "/v3/knowledge-bases/{knowledgeBaseId}/documents/{documentId}", 202] }, () => DeleteDocumentInput$, () => DeleteDocumentOutput$
];
export var GetAgentVersion$: StaticOperationSchema = [9, n0, _GAV,
  { [_h]: ["GET", "/v3/agents/{agentId}/versions/{version}", 200] }, () => GetAgentVersionInput$, () => GetAgentVersionOutput$
];
export var GetCaller$: StaticOperationSchema = [9, n0, _GC,
  { [_h]: ["GET", "/v3/me", 200] }, () => GetCallerInput$, () => GetCallerOutput$
];
export var GetDocument$: StaticOperationSchema = [9, n0, _GD,
  { [_h]: ["GET", "/v3/knowledge-bases/{knowledgeBaseId}/documents/{documentId}", 200] }, () => GetDocumentInput$, () => GetDocumentOutput$
];
export var GetProductionHistoryEntry$: StaticOperationSchema = [9, n0, _GPHE,
  { [_h]: ["GET", "/v3/agents/{agentId}/production-history-entries/{historyEntryId}", 200] }, () => GetProductionHistoryEntryInput$, () => GetProductionHistoryEntryOutput$
];
export var GetUpload$: StaticOperationSchema = [9, n0, _GU,
  { [_h]: ["GET", "/v3/uploads/{uploadId}", 200] }, () => GetUploadInput$, () => GetUploadOutput$
];
export var ListAgentVersions$: StaticOperationSchema = [9, n0, _LAV,
  { [_h]: ["GET", "/v3/agents/{agentId}/versions", 200] }, () => ListAgentVersionsInput$, () => ListAgentVersionsOutput$
];
export var ListDocuments$: StaticOperationSchema = [9, n0, _LD,
  { [_h]: ["GET", "/v3/knowledge-bases/{knowledgeBaseId}/documents", 200] }, () => ListDocumentsInput$, () => ListDocumentsOutput$
];
export var ListProductionHistoryEntries$: StaticOperationSchema = [9, n0, _LPHE,
  { [_h]: ["GET", "/v3/agents/{agentId}/production-history-entries", 200] }, () => ListProductionHistoryEntriesInput$, () => ListProductionHistoryEntriesOutput$
];
export var PinDraftVersion$: StaticOperationSchema = [9, n0, _PDV,
  { [_h]: ["POST", "/v3/agents/{agentId}/versions/draft/pin", 201] }, () => PinDraftVersionInput$, () => PinDraftVersionOutput$
];
export var PublishAgentVersion$: StaticOperationSchema = [9, n0, _PAV,
  { [_h]: ["POST", "/v3/agents/{agentId}/versions/{version}/publish", 200] }, () => PublishAgentVersionInput$, () => PublishAgentVersionOutput$
];
export var ResetDraftVersion$: StaticOperationSchema = [9, n0, _RDV,
  { [_h]: ["POST", "/v3/agents/{agentId}/versions/draft/reset", 200] }, () => ResetDraftVersionInput$, () => ResetDraftVersionOutput$
];
export var SendMessage$: StaticOperationSchema = [9, n0, _SM,
  { [_h]: ["POST", "/v3/conversations/{conversationId}/send", 200] }, () => SendMessageInput$, () => SendMessageOutput$
];
export var UpdateDraftVersion$: StaticOperationSchema = [9, n0, _UDV,
  { [_h]: ["PATCH", "/v3/agents/{agentId}/versions/draft", 200] }, () => UpdateDraftVersionInput$, () => UpdateDraftVersionOutput$
];
export var WatchConversation$: StaticOperationSchema = [9, n0, _WC,
  { [_h]: ["GET", "/v3/conversations/{conversationId}/stream", 200] }, () => WatchConversationInput$, () => WatchConversationOutput$
];
export var WatchWorkspaceEvents$: StaticOperationSchema = [9, n0, _WWE,
  { [_h]: ["GET", "/v3/events/stream", 200] }, () => WatchWorkspaceEventsInput$, () => WatchWorkspaceEventsOutput$
];
