// smithy-typescript generated code
/**
 * @public
 * @enum
 */
export const ReadersKind = {
  /**
   * Anyone signed in to the workspace who may read the knowledge base, but no guest or anonymous
   * visitor. For content every colleague may see.
   */
  EVERYONE: "everyone",
  /**
   * Follow the folder it is in, so a change there applies here too. Never on the root folder,
   * whose readers every folder falls back to. On a document it removes the document's own list,
   * which also needs the permission to delete readers (`files.permissions.delete`), as v2's revert
   * does; on a folder it is a change like any other.
   */
  INHERIT: "inherit",
  /**
   * Anyone who can reach the knowledge base, signed in or not: guests and anonymous visitors of a
   * public agent included. For content meant to be shared openly.
   */
  PUBLIC: "public",
  /**
   * Only the roles and people listed in `roles` and `people`. For restricted content.
   */
  SPECIFIC: "specific",
} as const;
/**
 * @public
 */
export type ReadersKind = (typeof ReadersKind)[keyof typeof ReadersKind] | (string & {});

/**
 * @public
 * @enum
 */
export const AccessAction = {
  /**
   * Delete the knowledge base, with all its documents.
   */
  DELETE: "delete",
  /**
   * Change its settings.
   */
  EDIT: "edit",
  /**
   * See it in a list.
   */
  FIND: "find",
  /**
   * Open it and read its documents.
   */
  READ: "read",
} as const;
/**
 * @public
 */
export type AccessAction = (typeof AccessAction)[keyof typeof AccessAction] | (string & {});

/**
 * @public
 * @enum
 */
export const AvatarColour = {
  /**
   * Amber.
   */
  AMBER: "amber",
  /**
   * Blue.
   */
  BLUE: "blue",
  /**
   * Sage.
   */
  SAGE: "sage",
} as const;
/**
 * @public
 */
export type AvatarColour = (typeof AvatarColour)[keyof typeof AvatarColour] | (string & {});

/**
 * @public
 * @enum
 */
export const AgentIconName = {
  /**
   * An open book.
   */
  BOOK: "book",
  /**
   * A speech bubble.
   */
  CHAT: "chat",
  /**
   * A document.
   */
  DOCUMENT: "document",
  /**
   * A leaf.
   */
  LEAF: "leaf",
  /**
   * A package.
   */
  PACKAGE: "package",
  /**
   * Two people.
   */
  PEOPLE: "people",
} as const;
/**
 * @public
 */
export type AgentIconName = (typeof AgentIconName)[keyof typeof AgentIconName] | (string & {});

/**
 * @public
 * @enum
 */
export const ReasoningEffort = {
  /**
   * High effort.
   */
  HIGH: "high",
  /**
   * The least effort.
   */
  LOW: "low",
  /**
   * The most effort the model offers.
   */
  MAX: "max",
  /**
   * Medium effort.
   */
  MEDIUM: "medium",
  /**
   * Higher than high.
   */
  XHIGH: "xhigh",
} as const;
/**
 * @public
 */
export type ReasoningEffort = (typeof ReasoningEffort)[keyof typeof ReasoningEffort] | (string & {});

/**
 * @public
 * @enum
 */
export const ResultEvaluationMethod = {
  /**
   * A language model judges each passage, following `guidance.resultEvaluation`.
   */
  MODEL: "model",
  /**
   * A reranking model scores and orders the passages. Fast, and ignores `guidance.resultEvaluation`.
   */
  RERANKER: "reranker",
} as const;
/**
 * @public
 */
export type ResultEvaluationMethod = (typeof ResultEvaluationMethod)[keyof typeof ResultEvaluationMethod] | (string & {});

/**
 * @public
 * @enum
 */
export const LiveAvatarProvider = {
  /**
   * HeyGen.
   */
  HEYGEN: "heygen",
} as const;
/**
 * @public
 */
export type LiveAvatarProvider = (typeof LiveAvatarProvider)[keyof typeof LiveAvatarProvider] | (string & {});

/**
 * @public
 * @enum
 */
export const SpeechToTextProvider = {
  /**
   * AssemblyAI.
   */
  ASSEMBLY_AI: "assembly_ai",
  /**
   * Deepgram.
   */
  DEEPGRAM: "deepgram",
  /**
   * ElevenLabs.
   */
  ELEVENLABS: "elevenlabs",
  /**
   * Gladia.
   */
  GLADIA: "gladia",
} as const;
/**
 * @public
 */
export type SpeechToTextProvider = (typeof SpeechToTextProvider)[keyof typeof SpeechToTextProvider] | (string & {});

/**
 * @public
 * @enum
 */
export const VoiceProvider = {
  /**
   * The person's browser speaks the answer.
   */
  BROWSER: "browser",
  /**
   * A cloud voice speaks the answer.
   */
  CLOUD: "cloud",
} as const;
/**
 * @public
 */
export type VoiceProvider = (typeof VoiceProvider)[keyof typeof VoiceProvider] | (string & {});

/**
 * @public
 * @enum
 */
export const VoiceQuality = {
  /**
   * The most natural voice.
   */
  NATURAL: "natural",
  /**
   * The standard voice.
   */
  STANDARD: "standard",
} as const;
/**
 * @public
 */
export type VoiceQuality = (typeof VoiceQuality)[keyof typeof VoiceQuality] | (string & {});

/**
 * @public
 * @enum
 */
export const ConversationSharing = {
  /**
   * Every workspace of the organisation.
   */
  ORGANISATION: "organisation",
  /**
   * Only the workspace it started in.
   */
  WORKSPACE: "workspace",
} as const;
/**
 * @public
 */
export type ConversationSharing = (typeof ConversationSharing)[keyof typeof ConversationSharing] | (string & {});

/**
 * @public
 * @enum
 */
export const AttributionCheckMode = {
  /**
   * Rewrites the answer until it passes, or `maxRetries` runs out.
   */
  ENFORCE: "enforce",
  /**
   * Records the failure and keeps the answer.
   */
  RECORD: "record",
} as const;
/**
 * @public
 */
export type AttributionCheckMode = (typeof AttributionCheckMode)[keyof typeof AttributionCheckMode] | (string & {});

/**
 * @public
 * @enum
 */
export const PhaseFieldKind = {
  /**
   * A value the phase gathers.
   */
  FIELD: "field",
  /**
   * An earlier phase that must be done first.
   */
  PREREQUISITE: "prerequisite",
} as const;
/**
 * @public
 */
export type PhaseFieldKind = (typeof PhaseFieldKind)[keyof typeof PhaseFieldKind] | (string & {});

/**
 * @public
 * @enum
 */
export const FieldSourceKind = {
  /**
   * One of a fixed set of values.
   */
  ALLOWED_VALUES: "allowed_values",
  /**
   * A field an earlier phase gathered.
   */
  EARLIER_PHASE: "earlier_phase",
  /**
   * The person, in the chat.
   */
  PERSON: "person",
  /**
   * Read from the result of the tool `toolName` names, at `path`.
   */
  TOOL_RESULT: "tool_result",
} as const;
/**
 * @public
 */
export type FieldSourceKind = (typeof FieldSourceKind)[keyof typeof FieldSourceKind] | (string & {});

/**
 * @public
 * @enum
 */
export const PhaseFieldType = {
  /**
   * An attached document.
   */
  DOCUMENT: "document",
  /**
   * Free text.
   */
  TEXT: "text",
} as const;
/**
 * @public
 */
export type PhaseFieldType = (typeof PhaseFieldType)[keyof typeof PhaseFieldType] | (string & {});

/**
 * @public
 * @enum
 */
export const PhaseKind = {
  /**
   * Answers questions, searching the knowledge bases.
   */
  CONVERSATIONAL: "conversational",
  /**
   * Gathers the information its `fields` describe, from the person or from tools.
   */
  GATHER_INFO: "gather_info",
  /**
   * Reviews documents against a policy and writes a policy review.
   */
  POLICY_REVIEW: "policy_review",
  /**
   * Takes an action with its tools, once its `fields` are gathered.
   */
  TAKE_ACTION: "take_action",
} as const;
/**
 * @public
 */
export type PhaseKind = (typeof PhaseKind)[keyof typeof PhaseKind] | (string & {});

/**
 * @public
 * @enum
 */
export const PhaseEndType = {
  /**
   * The conversation takes no more messages.
   */
  CLOSE: "close",
  /**
   * The next message starts the conversation again.
   */
  RESTART: "restart",
} as const;
/**
 * @public
 */
export type PhaseEndType = (typeof PhaseEndType)[keyof typeof PhaseEndType] | (string & {});

/**
 * @public
 * @enum
 */
export const SearchMode = {
  /**
   * The results are judged as the knowledge base binding's `evaluation` says.
   */
  EVALUATED: "evaluated",
  /**
   * The results are returned as the search found them.
   */
  UNEVALUATED: "unevaluated",
} as const;
/**
 * @public
 */
export type SearchMode = (typeof SearchMode)[keyof typeof SearchMode] | (string & {});

/**
 * @public
 * @enum
 */
export const ToolUse = {
  /**
   * The result is the answer; the agent writes no more.
   */
  ANSWER: "answer",
  /**
   * The result is context the agent answers from.
   */
  CONTEXT: "context",
  /**
   * The tool's own setting decides.
   */
  DEFAULT: "default",
} as const;
/**
 * @public
 */
export type ToolUse = (typeof ToolUse)[keyof typeof ToolUse] | (string & {});

/**
 * @public
 * @enum
 */
export const TransitionKind = {
  /**
   * May be taken at any time, citing what the person said or a tool returned.
   */
  ALTERNATIVE: "alternative",
  /**
   * Taken once the phase's requirements are met.
   */
  COMPLETION: "completion",
  /**
   * Offered to the person as a skip button.
   */
  SKIP: "skip",
} as const;
/**
 * @public
 */
export type TransitionKind = (typeof TransitionKind)[keyof typeof TransitionKind] | (string & {});

/**
 * @public
 * @enum
 */
export const TransitionMatchSource = {
  /**
   * A field this phase gathered.
   */
  SAVED_FIELD: "saved_field",
  /**
   * The result of a tool the phase called.
   */
  TOOL_RESULT: "tool_result",
} as const;
/**
 * @public
 */
export type TransitionMatchSource = (typeof TransitionMatchSource)[keyof typeof TransitionMatchSource] | (string & {});

/**
 * @public
 * @enum
 */
export const VersionSource = {
  /**
   * Created from an imported agent file.
   */
  IMPORT: "import",
  /**
   * Carried over from the version model before v3.
   */
  MIGRATION: "migration",
  /**
   * Made by a publish, which also pointed live at it.
   */
  PUBLISH: "publish",
  /**
   * Saved from the draft, without changing live.
   */
  SAVE: "save",
} as const;
/**
 * @public
 */
export type VersionSource = (typeof VersionSource)[keyof typeof VersionSource] | (string & {});

/**
 * @public
 * @enum
 */
export const ClearableDraftField = {
  /**
   * The chat box hint.
   */
  CONVERSATION_INPUT_PLACEHOLDER: "conversation.inputPlaceholder",
  /**
   * The glossary.
   */
  GUIDANCE_DEFINITIONS: "guidance.definitions",
  /**
   * The agent's identity statement.
   */
  GUIDANCE_IDENTITY: "guidance.identity",
  /**
   * The agent's instructions, which become empty.
   */
  GUIDANCE_INSTRUCTIONS: "guidance.instructions",
  /**
   * What to say when there is too little evidence.
   */
  GUIDANCE_LIMITED_EVIDENCE: "guidance.limitedEvidence",
  /**
   * What makes an answer relevant.
   */
  GUIDANCE_RELEVANCE: "guidance.relevance",
  /**
   * How to judge search results.
   */
  GUIDANCE_RESULT_EVALUATION: "guidance.resultEvaluation",
  /**
   * How to write search topics.
   */
  GUIDANCE_SEARCH_TOPICS: "guidance.searchTopics",
  /**
   * The journey page.
   */
  JOURNEY: "journey",
  /**
   * Returns the live avatar settings to their default.
   */
  LIVE_AVATAR: "liveAvatar",
  /**
   * Returns the memory settings to their default.
   */
  MEMORY: "memory",
  /**
   * The answer job's model settings.
   */
  MODELS_ANSWER: "models.answer",
  /**
   * The classification job's model settings.
   */
  MODELS_CLASSIFICATION: "models.classification",
  /**
   * The planning job's model settings.
   */
  MODELS_PLANNING: "models.planning",
  /**
   * The search topics job's model settings.
   */
  MODELS_SEARCH_TOPICS: "models.searchTopics",
  /**
   * The summary job's model settings.
   */
  MODELS_SUMMARY: "models.summary",
  /**
   * The title job's model settings.
   */
  MODELS_TITLE: "models.title",
  /**
   * The role unattended runs use.
   */
  RUN_AS: "runAs",
  /**
   * Returns the voice settings to their default.
   */
  VOICE: "voice",
  /**
   * Returns the workflow's capabilities to their default.
   */
  WORKFLOW_CAPABILITIES: "workflow.capabilities",
} as const;
/**
 * @public
 */
export type ClearableDraftField = (typeof ClearableDraftField)[keyof typeof ClearableDraftField] | (string & {});

/**
 * @public
 * @enum
 */
export const HistoryChangeKind = {
  /**
   * Live was set when the agent was carried over from before v3.
   */
  MIGRATION: "migration",
  /**
   * A version was published that live had not pointed at before.
   */
  PUBLISH: "publish",
  /**
   * Live was pointed back at a version it had pointed at before.
   */
  ROLLBACK: "rollback",
} as const;
/**
 * @public
 */
export type HistoryChangeKind = (typeof HistoryChangeKind)[keyof typeof HistoryChangeKind] | (string & {});

/**
 * @public
 * @enum
 */
export const ConversationStatus = {
  /**
   * No answer is being written.
   */
  IDLE: "idle",
  /**
   * An answer is being written; watch the conversation to follow it.
   */
  RESPONDING: "responding",
} as const;
/**
 * @public
 */
export type ConversationStatus = (typeof ConversationStatus)[keyof typeof ConversationStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const ClearableAgentField = {
  /**
   * Returns the agent's avatar to its default.
   */
  AVATAR: "avatar",
  /**
   * Removes the agent's description.
   */
  DESCRIPTION: "description",
} as const;
/**
 * @public
 */
export type ClearableAgentField = (typeof ClearableAgentField)[keyof typeof ClearableAgentField] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionItemAction = {
  /**
   * Ingest the item's bytes.
   */
  INGEST: "ingest",
  /**
   * Remove the document the item names.
   */
  REMOVE: "remove",
} as const;
/**
 * @public
 */
export type IngestionItemAction = (typeof IngestionItemAction)[keyof typeof IngestionItemAction] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionItemOutcome = {
  /**
   * The same document, with different current bytes; `matches[0].restoresVersion` is set when the
   * bytes are an earlier version's. Resolved `new_version` by default.
   */
  CHANGED: "changed",
  /**
   * The plan cannot decide safely; `reason` says why.
   */
  CONFLICT: "conflict",
  /**
   * A `fetchUrl` item that could not be fetched; `reason` says why.
   */
  FETCH_FAILED: "fetch_failed",
  /**
   * The document is being ingested.
   */
  IN_PROGRESS: "in_progress",
  /**
   * The document is at another path: its `externalId` matches, or, without one, the one current
   * document with these bytes is elsewhere.
   */
  MOVED: "moved",
  /**
   * No document at this path or `externalId`. Resolved `add` by default.
   */
  NEW: "new",
  /**
   * A `remove` item that matches a document.
   */
  TO_REMOVE: "to_remove",
  /**
   * The same document, with the same current bytes.
   */
  UNCHANGED: "unchanged",
} as const;
/**
 * @public
 */
export type IngestionItemOutcome = (typeof IngestionItemOutcome)[keyof typeof IngestionItemOutcome] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionItemReason = {
  /**
   * No `externalId`, and several current documents have these bytes; all are in `matches`. No
   * document is at the item's own path, so there is nothing to version: `new_version` and
   * `overwrite` resolve the item to `add`, a new document at its path.
   */
  AMBIGUOUS_CONTENT: "ambiguous_content",
  /**
   * The document changed between planning and Start.
   */
  CHANGED_SINCE_PLAN: "changed_since_plan",
  /**
   * Two documents share the `externalId`.
   */
  DUPLICATE_EXTERNAL_ID: "duplicate_external_id",
  /**
   * Two items in the batch name the same document. `new_version` and `overwrite` leave each such
   * item `unresolved`: the caller picks the item that wins, and skips the others.
   */
  DUPLICATE_IN_BATCH: "duplicate_in_batch",
  /**
   * Two documents share the path.
   */
  DUPLICATE_PATH: "duplicate_path",
  /**
   * The address is not allowed: not `http` or `https`, or not public.
   */
  FETCH_BLOCKED: "fetch_blocked",
  /**
   * The address answered with an error.
   */
  FETCH_HTTP_ERROR: "fetch_http_error",
  /**
   * The address took too long to answer.
   */
  FETCH_TIMEOUT: "fetch_timeout",
  /**
   * The file at the address is over 100 MB.
   */
  FETCH_TOO_LARGE: "fetch_too_large",
  /**
   * The address redirected more than 5 times.
   */
  FETCH_TOO_MANY_REDIRECTS: "fetch_too_many_redirects",
  /**
   * The file at the address is not a type a knowledge base can ingest.
   */
  FETCH_UNSUPPORTED_TYPE: "fetch_unsupported_type",
  /**
   * The path and the `externalId` name different documents. Never used for a path held by a
   * document the caller may not read: that item is `failed` with `PERMISSION_DENIED`, and its
   * detail says only that the path cannot be written, so the document is not revealed.
   */
  PATH_TAKEN: "path_taken",
} as const;
/**
 * @public
 */
export type IngestionItemReason = (typeof IngestionItemReason)[keyof typeof IngestionItemReason] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionItemResolution = {
  /**
   * Add the bytes as a new document. Only for `new` items, and the default for them.
   */
  ADD: "add",
  /**
   * Move the document to the item's path, keeping its versions and history.
   */
  MOVE: "move",
  /**
   * Upload the bytes as a new version of the existing document the item matches (`matches[0]`):
   * the same document at the same path or `externalId`, which keeps its identifier and history. The
   * rules are CreateDocumentVersion's: bytes of another file type than the document's fail the item
   * with `VALIDATION_FAILED`; bytes that equal an earlier version's restore that version (its number
   * is the item's `version`); and while a version of the document is still processing the item fails
   * with `DOCUMENT_INGESTION_IN_PROGRESS`. The current version keeps serving until the new one is
   * indexed. The default for `changed` items; also allowed for `in_progress` items and for
   * `conflict` items whose reason is `path_taken` or `changed_since_plan`.
   */
  NEW_VERSION: "new_version",
  /**
   * For `duplicate_path` and `duplicate_external_id` conflicts: a new version of the newest of the
   * duplicated documents, removing the others. An `ambiguous_content` item resolved this way, or as
   * `new_version`, becomes `add`; a `duplicate_in_batch` item stays `unresolved`. Any other item
   * takes `new_version` instead.
   */
  OVERWRITE: "overwrite",
  /**
   * Remove the document.
   */
  REMOVE: "remove",
  /**
   * Do nothing.
   */
  SKIP: "skip",
  /**
   * Waiting for the caller to decide.
   */
  UNRESOLVED: "unresolved",
  /**
   * Change only the document's metadata or `sourceUrl`; nothing is ingested.
   */
  UPDATE_METADATA: "update_metadata",
} as const;
/**
 * @public
 */
export type IngestionItemResolution = (typeof IngestionItemResolution)[keyof typeof IngestionItemResolution] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionItemStatus = {
  /**
   * Waiting for its bytes, under the batch's upload policy.
   */
  AWAITING_UPLOAD: "awaiting_upload",
  /**
   * Stopped: its document was deleted while it was being ingested, or the item was cancelled
   * (CancelIngestionBatchItem) while it waited for its upload. Final.
   */
  CANCELLED: "cancelled",
  /**
   * Not started.
   */
  DRAFT: "draft",
  /**
   * Failed; `failureCode` says why. Final.
   */
  FAILED: "failed",
  /**
   * Ingested and searchable. Final.
   */
  INDEXED: "indexed",
  /**
   * Being ingested.
   */
  INGESTING: "ingesting",
  /**
   * Its document was moved to the item's path. Final.
   */
  MOVED: "moved",
  /**
   * Its document was removed. Final.
   */
  REMOVED: "removed",
  /**
   * Left alone, as the plan and its policy decided. Final.
   */
  SKIPPED: "skipped",
  /**
   * Its metadata was updated. Final.
   */
  UPDATED: "updated",
} as const;
/**
 * @public
 */
export type IngestionItemStatus = (typeof IngestionItemStatus)[keyof typeof IngestionItemStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const ItemCreateStatus = {
  /**
   * The item was added.
   */
  CREATED: "created",
  /**
   * The item was not added; `code` says why.
   */
  FAILED: "failed",
} as const;
/**
 * @public
 */
export type ItemCreateStatus = (typeof ItemCreateStatus)[keyof typeof ItemCreateStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const DocumentDeleteStatus = {
  /**
   * The document is now `deleting`, or already was.
   */
  ACCEPTED: "accepted",
  /**
   * The document was not deleted; `code` says why.
   */
  FAILED: "failed",
} as const;
/**
 * @public
 */
export type DocumentDeleteStatus = (typeof DocumentDeleteStatus)[keyof typeof DocumentDeleteStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const MessageRole = {
  /**
   * The agent.
   */
  ASSISTANT: "assistant",
  /**
   * The person or client that sent it.
   */
  USER: "user",
} as const;
/**
 * @public
 */
export type MessageRole = (typeof MessageRole)[keyof typeof MessageRole] | (string & {});

/**
 * @public
 * @enum
 */
export const CredentialKind = {
  /**
   * An API client's own credential, acting for no person.
   */
  API_CLIENT: "api_client",
  /**
   * A person signed in through a browser: the Caitlyn app, or an SDK in its `session` sign-in mode.
   */
  BROWSER: "browser",
  /**
   * A token issued to an application that a person signed in to with OAuth; it acts for that
   * person, limited to the scopes they approved.
   */
  OAUTH: "oauth",
  /**
   * A personal access token, acting for the person who created it.
   */
  PERSONAL: "personal",
} as const;
/**
 * @public
 */
export type CredentialKind = (typeof CredentialKind)[keyof typeof CredentialKind] | (string & {});

/**
 * @public
 * @enum
 */
export const EngineInput = {
  /**
   * Only each passage's text.
   */
  TEXT: "text",
  /**
   * Each passage's text and the pictures in it.
   */
  TEXT_AND_IMAGES: "text_and_images",
} as const;
/**
 * @public
 */
export type EngineInput = (typeof EngineInput)[keyof typeof EngineInput] | (string & {});

/**
 * @public
 * @enum
 */
export const SearchType = {
  /**
   * Each passage is searched with the headings and layout around it.
   */
  LAYOUT_AWARE: "layout_aware",
  /**
   * Each passage is searched on its own text.
   */
  STANDARD: "standard",
} as const;
/**
 * @public
 */
export type SearchType = (typeof SearchType)[keyof typeof SearchType] | (string & {});

/**
 * @public
 * @enum
 */
export const KnowledgeBaseStatus = {
  /**
   * Being set up; documents cannot be added yet.
   */
  CREATING: "creating",
  /**
   * Being deleted.
   */
  DELETING: "deleting",
  /**
   * Could not be set up.
   */
  FAILED: "failed",
  /**
   * Being moved to new storage; searches still work.
   */
  MOVING: "moving",
  /**
   * Ready for documents and searches.
   */
  READY: "ready",
} as const;
/**
 * @public
 */
export type KnowledgeBaseStatus = (typeof KnowledgeBaseStatus)[keyof typeof KnowledgeBaseStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const CostUnit = {
  /**
   * A percentage of the organisation's monthly usage allowance. 100 is the whole month.
   */
  PERCENT_OF_PLAN: "percent_of_plan",
  /**
   * US dollars, at list price.
   */
  USD: "usd",
} as const;
/**
 * @public
 */
export type CostUnit = (typeof CostUnit)[keyof typeof CostUnit] | (string & {});

/**
 * @public
 * @enum
 */
export const OperationKind = {
  /**
   * A document's ingestion: reading, enriching and indexing its content. Can be cancelled.
   */
  DOCUMENT_INGESTION: "document_ingestion",
  /**
   * Applying a change to a document's name, folder or metadata to search.
   */
  DOCUMENT_UPDATE: "document_update",
  /**
   * Filling in metadata fields.
   */
  FILL_IN: "fill_in",
  /**
   * Creating, moving, renaming or deleting a folder.
   */
  FOLDER_CHANGE: "folder_change",
  /**
   * Deleting a knowledge base and everything in it.
   */
  KNOWLEDGE_BASE_DELETION: "knowledge_base_deletion",
  /**
   * Rebuilding a knowledge base's search vectors for layout-aware search.
   */
  LAYOUT_AWARE_SEARCH: "layout_aware_search",
  /**
   * Applying new permissions to a document's or folder's passages.
   */
  PERMISSIONS_CHANGE: "permissions_change",
  /**
   * Processing documents again the newest way.
   */
  REPROCESS: "reprocess",
} as const;
/**
 * @public
 */
export type OperationKind = (typeof OperationKind)[keyof typeof OperationKind] | (string & {});

/**
 * @public
 * @enum
 */
export const ProgressUnit = {
  /**
   * Each unit is one document.
   */
  DOCUMENTS: "documents",
  /**
   * Each unit is one passage.
   */
  PASSAGES: "passages",
  /**
   * Processing stages of one document.
   */
  STAGES: "stages",
} as const;
/**
 * @public
 */
export type ProgressUnit = (typeof ProgressUnit)[keyof typeof ProgressUnit] | (string & {});

/**
 * @public
 * @enum
 */
export const OperationStatus = {
  /**
   * Cancelled before it finished: by CancelOperation, or by deleting the thing the work is on.
   * Final.
   */
  CANCELLED: "cancelled",
  /**
   * Finished, but some enrichments did not complete. Final.
   */
  COMPLETED_WITH_FAILURES: "completed_with_failures",
  /**
   * The core work failed. Final.
   */
  FAILED: "failed",
  /**
   * Waiting to start.
   */
  QUEUED: "queued",
  /**
   * The work has started and has not ended.
   */
  RUNNING: "running",
  /**
   * Finished with no failures. Final.
   */
  SUCCEEDED: "succeeded",
} as const;
/**
 * @public
 */
export type OperationStatus = (typeof OperationStatus)[keyof typeof OperationStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const OperationTargetType = {
  /**
   * A document in a knowledge base.
   */
  DOCUMENT: "document",
  /**
   * A folder in a knowledge base; its `id` is the folder's path.
   */
  FOLDER: "folder",
  /**
   * A knowledge base itself; `id` is its identifier.
   */
  KNOWLEDGE_BASE: "knowledge_base",
} as const;
/**
 * @public
 */
export type OperationTargetType = (typeof OperationTargetType)[keyof typeof OperationTargetType] | (string & {});

/**
 * @public
 * @enum
 */
export const DocumentFailureCode = {
  /**
   * Processing was cancelled before it finished.
   */
  CANCELLED: "cancelled",
  /**
   * The file could not be read: it may be damaged, password-protected or not the file type its
   * name says. Check the file, then delete the document and add it again.
   */
  FILE_UNREADABLE: "file_unreadable",
  /**
   * Caitlyn could not finish processing the document. This is not a problem with the file;
   * contact support with the document's identifier.
   */
  PROCESSING_FAILED: "processing_failed",
  /**
   * A temporary problem stopped the document being processed. Delete it and add it again; if it
   * fails again, contact support.
   */
  PROCESSING_INTERRUPTED: "processing_interrupted",
} as const;
/**
 * @public
 */
export type DocumentFailureCode = (typeof DocumentFailureCode)[keyof typeof DocumentFailureCode] | (string & {});

/**
 * @public
 * @enum
 */
export const DocumentStatus = {
  /**
   * Being deleted.
   */
  DELETING: "deleting",
  /**
   * The document's content could not be processed; `failure` says why. Final.
   */
  FAILED: "failed",
  /**
   * Searchable. Final.
   */
  INDEXED: "indexed",
  /**
   * Searchable, but some enrichments did not complete; see `partialFailures`. Final.
   */
  PARTIALLY_INDEXED: "partially_indexed",
  /**
   * Created; processing has not started.
   */
  PENDING: "pending",
  /**
   * Being processed. `stage` says what the server is doing.
   */
  PROCESSING: "processing",
} as const;
/**
 * @public
 */
export type DocumentStatus = (typeof DocumentStatus)[keyof typeof DocumentStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const ProcessingKind = {
  /**
   * Filling in metadata fields.
   */
  FILL_IN: "fill_in",
  /**
   * Ingesting a new document or version.
   */
  INGEST: "ingest",
  /**
   * Making its search vectors again.
   */
  REEMBED: "reembed",
  /**
   * Processing it again the newest way.
   */
  REPROCESS: "reprocess",
} as const;
/**
 * @public
 */
export type ProcessingKind = (typeof ProcessingKind)[keyof typeof ProcessingKind] | (string & {});

/**
 * @public
 * @enum
 */
export const ProcessingStep = {
  /**
   * Making search pieces.
   */
  CHUNKS: "chunks",
  /**
   * Reading the content.
   */
  CONTENT: "content",
  /**
   * Updating the document's own record.
   */
  DOCUMENT: "document",
  /**
   * Reading video frames.
   */
  FRAMES: "frames",
  /**
   * Writing to the search index.
   */
  INDEX: "index",
  /**
   * Extracting metadata.
   */
  METADATA: "metadata",
  /**
   * Reading pages.
   */
  PAGES: "pages",
  /**
   * Making passages.
   */
  PASSAGES: "passages",
  /**
   * Describing pictures.
   */
  PICTURES: "pictures",
  /**
   * Making search vectors again.
   */
  REEMBED: "reembed",
  /**
   * Finding where sections join.
   */
  SEAMS: "seams",
  /**
   * Splitting into segments.
   */
  SEGMENTS: "segments",
  /**
   * Transcribing audio.
   */
  TRANSCRIPT: "transcript",
} as const;
/**
 * @public
 */
export type ProcessingStep = (typeof ProcessingStep)[keyof typeof ProcessingStep] | (string & {});

/**
 * @public
 * @enum
 */
export const VersionResult = {
  /**
   * A new version was made.
   */
  CREATED: "created",
  /**
   * The bytes were an earlier version's, which becomes current again once indexed.
   */
  RESTORED: "restored",
  /**
   * The bytes were the current version's; nothing was done.
   */
  UNCHANGED: "unchanged",
} as const;
/**
 * @public
 */
export type VersionResult = (typeof VersionResult)[keyof typeof VersionResult] | (string & {});

/**
 * @public
 * @enum
 */
export const ClearableDocumentField = {
  /**
   * The caller's own key.
   */
  EXTERNAL_ID: "externalId",
  /**
   * Every key the knowledge base does not define.
   */
  EXTRA_METADATA: "extraMetadata",
  /**
   * Every supplied metadata value, which processing may then fill again.
   */
  METADATA: "metadata",
  /**
   * The citation address.
   */
  SOURCE_URL: "sourceUrl",
} as const;
/**
 * @public
 */
export type ClearableDocumentField = (typeof ClearableDocumentField)[keyof typeof ClearableDocumentField] | (string & {});

/**
 * @public
 * @enum
 */
export const PartialDates = {
  /**
   * Nothing.
   */
  EMPTY: "empty",
  /**
   * The first day of the period.
   */
  START: "start",
} as const;
/**
 * @public
 */
export type PartialDates = (typeof PartialDates)[keyof typeof PartialDates] | (string & {});

/**
 * @public
 * @enum
 */
export const FieldLevel = {
  /**
   * One value per document.
   */
  DOCUMENT: "document",
  /**
   * A value for each passage, inferred by ingestion.
   */
  PASSAGE: "passage",
} as const;
/**
 * @public
 */
export type FieldLevel = (typeof FieldLevel)[keyof typeof FieldLevel] | (string & {});

/**
 * @public
 * @enum
 */
export const FieldType = {
  /**
   * A yes-or-no fact about a document, such as whether it is current.
   */
  BOOLEAN: "boolean",
  /**
   * An ISO 8601 date, which searches can filter by range.
   */
  DATE: "date",
  /**
   * One or more of the field's `choices`.
   */
  LIST: "list",
  /**
   * A quantity, such as an amount or a count.
   */
  NUMBER: "number",
  /**
   * Free text.
   */
  TEXT: "text",
} as const;
/**
 * @public
 */
export type FieldType = (typeof FieldType)[keyof typeof FieldType] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionBatchFailureCode = {
  /**
   * An item had a conflict whose policy rule is `fail`, so the batch stopped before anything was
   * changed. List the items with `filter[outcome][eq]=conflict` to see which, then make a new
   * batch with a different policy or fix the clashes.
   */
  CONFLICT_POLICY_FAIL: "conflict_policy_fail",
  /**
   * Caitlyn could not finish the batch. This is not a problem with the items; contact support with
   * the batch's identifier.
   */
  INTERNAL_ERROR: "internal_error",
  /**
   * Planning could not finish, for example because the knowledge base stopped being `ready`.
   * Nothing was changed; make a new batch.
   */
  PLANNING_FAILED: "planning_failed",
} as const;
/**
 * @public
 */
export type IngestionBatchFailureCode = (typeof IngestionBatchFailureCode)[keyof typeof IngestionBatchFailureCode] | (string & {});

/**
 * @public
 * @enum
 */
export const ConflictRule = {
  /**
   * Leave the item `unresolved` for the caller to decide.
   */
  ASK: "ask",
  /**
   * End planning `failed`.
   */
  FAIL: "fail",
  /**
   * Add the item's bytes as a new version of the document it clashes with, as the item
   * resolution `new_version` does. For `ambiguous_content` it resolves the item to `add`, and for
   * `duplicate_in_batch` it leaves the item `unresolved`.
   */
  NEW_VERSION: "new_version",
  /**
   * For `duplicate_path` and `duplicate_external_id`: a new version of the newest of the
   * duplicated documents, removing the others. For `ambiguous_content` it resolves the item to
   * `add`, and for `duplicate_in_batch` it leaves the item `unresolved`. For any other reason, the
   * same as `new_version`.
   */
  OVERWRITE: "overwrite",
  /**
   * Skip the item.
   */
  SKIP: "skip",
} as const;
/**
 * @public
 */
export type ConflictRule = (typeof ConflictRule)[keyof typeof ConflictRule] | (string & {});

/**
 * @public
 * @enum
 */
export const MovedRule = {
  /**
   * Make a new document at the item's path and keep the other.
   */
  COPY: "copy",
  /**
   * Move the document to the item's path.
   */
  MOVE: "move",
  /**
   * Leave things as they are.
   */
  SKIP: "skip",
} as const;
/**
 * @public
 */
export type MovedRule = (typeof MovedRule)[keyof typeof MovedRule] | (string & {});

/**
 * @public
 * @enum
 */
export const RemoveRule = {
  /**
   * Leave the item `unresolved`.
   */
  ASK: "ask",
  /**
   * Remove the document.
   */
  REMOVE: "remove",
  /**
   * Keep the document.
   */
  SKIP: "skip",
} as const;
/**
 * @public
 */
export type RemoveRule = (typeof RemoveRule)[keyof typeof RemoveRule] | (string & {});

/**
 * @public
 * @enum
 */
export const UnchangedRule = {
  /**
   * Ingest the bytes again.
   */
  REINGEST: "reingest",
  /**
   * Ingest nothing.
   */
  SKIP: "skip",
} as const;
/**
 * @public
 */
export type UnchangedRule = (typeof UnchangedRule)[keyof typeof UnchangedRule] | (string & {});

/**
 * @public
 * @enum
 */
export const StartMode = {
  /**
   * When StartIngestionBatch is called.
   */
  MANUAL: "manual",
  /**
   * As soon as it is planned with no item `unresolved`.
   */
  WHEN_PLANNED: "when_planned",
} as const;
/**
 * @public
 */
export type StartMode = (typeof StartMode)[keyof typeof StartMode] | (string & {});

/**
 * @public
 * @enum
 */
export const IngestionBatchStatus = {
  /**
   * Stopped by a cancel before every item finished. Final.
   */
  CANCELLED: "cancelled",
  /**
   * Every item finished, and at least one is `failed`. Final.
   */
  COMPLETED_WITH_FAILURES: "completed_with_failures",
  /**
   * Taking items, while `awaitMoreItems` is true.
   */
  DRAFT: "draft",
  /**
   * The batch failed, for example because a policy rule said `fail`; `failure` says why. Final.
   */
  FAILED: "failed",
  /**
   * Every item has an outcome; waiting for StartIngestionBatch, or for unresolved items.
   */
  PLANNED: "planned",
  /**
   * Working out each item's outcome.
   */
  PLANNING: "planning",
  /**
   * Started: items are being uploaded and ingested.
   */
  RUNNING: "running",
  /**
   * Every item finished and none failed: each is `indexed`, `skipped`, `moved`, `updated`,
   * `removed` or `cancelled`. A cancelled item, whose document was deleted while it was being
   * ingested, is not a failure. Final.
   */
  SUCCEEDED: "succeeded",
} as const;
/**
 * @public
 */
export type IngestionBatchStatus = (typeof IngestionBatchStatus)[keyof typeof IngestionBatchStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const UploadCompletionStatus = {
  /**
   * The bytes matched and ingestion started.
   */
  ACCEPTED: "accepted",
  /**
   * The upload was not accepted; `code` says why.
   */
  FAILED: "failed",
} as const;
/**
 * @public
 */
export type UploadCompletionStatus = (typeof UploadCompletionStatus)[keyof typeof UploadCompletionStatus] | (string & {});

/**
 * @public
 * @enum
 */
export const ClearableKnowledgeBaseField = {
  /**
   * The description agents read.
   */
  AGENT_DESCRIPTION: "agentDescription",
  /**
   * The description people see.
   */
  DESCRIPTION: "description",
} as const;
/**
 * @public
 */
export type ClearableKnowledgeBaseField = (typeof ClearableKnowledgeBaseField)[keyof typeof ClearableKnowledgeBaseField] | (string & {});

/**
 * @public
 * @enum
 */
export const ModelReasoning = {
  /**
   * It always reasons, whatever `reasoning.enabled` says.
   */
  ALWAYS: "always",
  /**
   * It never reasons; `reasoning` is refused.
   */
  NONE: "none",
  /**
   * It reasons when `reasoning.enabled` is true.
   */
  OPTIONAL: "optional",
} as const;
/**
 * @public
 */
export type ModelReasoning = (typeof ModelReasoning)[keyof typeof ModelReasoning] | (string & {});

/**
 * @public
 * @enum
 */
export const UploadStatus = {
  /**
   * Reserved; the bytes have not arrived.
   */
  AWAITING_BYTES: "awaiting_bytes",
  /**
   * Used by an operation. Final.
   */
  CONSUMED: "consumed",
  /**
   * Not used before `expiresAt`. Final.
   */
  EXPIRED: "expired",
  /**
   * The bytes arrived and matched the checksum.
   */
  RECEIVED: "received",
} as const;
/**
 * @public
 */
export type UploadStatus = (typeof UploadStatus)[keyof typeof UploadStatus] | (string & {});
