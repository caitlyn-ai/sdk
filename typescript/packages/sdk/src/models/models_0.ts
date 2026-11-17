// smithy-typescript generated code
import type { DocumentType as __DocumentType, StreamingBlobTypes } from "@smithy/types";

import type {
  AccessAction,
  AgentIconName,
  AttributionCheckMode,
  AvatarColour,
  ClearableAgentField,
  ClearableDocumentField,
  ClearableDraftField,
  ClearableKnowledgeBaseField,
  ConflictRule,
  ConversationSharing,
  ConversationStatus,
  CostUnit,
  CredentialKind,
  DocumentDeleteStatus,
  DocumentFailureCode,
  DocumentStatus,
  EngineInput,
  FieldLevel,
  FieldSourceKind,
  FieldType,
  HistoryChangeKind,
  IngestionBatchFailureCode,
  IngestionBatchStatus,
  IngestionItemAction,
  IngestionItemOutcome,
  IngestionItemReason,
  IngestionItemResolution,
  IngestionItemStatus,
  ItemCreateStatus,
  KnowledgeBaseStatus,
  LiveAvatarProvider,
  MessageRole,
  ModelReasoning,
  MovedRule,
  OperationKind,
  OperationStatus,
  OperationTargetType,
  PartialDates,
  PhaseEndType,
  PhaseFieldKind,
  PhaseFieldType,
  PhaseKind,
  ProcessingKind,
  ProcessingStep,
  ProgressUnit,
  ReadersKind,
  ReasoningEffort,
  RemoveRule,
  ResultEvaluationMethod,
  SearchMode,
  SearchType,
  SpeechToTextProvider,
  StartMode,
  ToolUse,
  TransitionKind,
  TransitionMatchSource,
  UnchangedRule,
  UploadCompletionStatus,
  UploadStatus,
  VersionResult,
  VersionSource,
  VoiceProvider,
  VoiceQuality,
} from "./enums";

/**
 * Who may read a folder's or a document's contents.
 * @public
 */
export interface Readers {
  /**
   * How the readers are decided. With `specific`, `roles` and `people` say who.
   * @public
   */
  kind: ReadersKind;

  /**
   * For `specific`: the roles that may read it.
   * @public
   */
  roles?: string[] | undefined;

  /**
   * For `specific`: the people who may read it.
   * @public
   */
  people?: string[] | undefined;
}

/**
 * What one role may do with a knowledge base.
 * @public
 */
export interface RoleAccess {
  /**
   * The role this grant is for.
   * @public
   */
  roleId: string;

  /**
   * The role's name, as people see it. Returned; ignored when sent.
   * @public
   */
  name?: string | undefined;

  /**
   * What the role may do with the knowledge base.
   * @public
   */
  can: AccessAction[];
}

/**
 * Who may use a knowledge base, or who may read a folder or a document in it.
 * @public
 */
export interface Access {
  /**
   * For the knowledge base: each role's grants. A role left out has none.
   * @public
   */
  roles?: RoleAccess[] | undefined;

  /**
   * For a folder or a document: who may read it.
   * @public
   */
  readers?: Readers | undefined;

  /**
   * The access's ETag; send it as `If-Match` to set it.
   * @public
   */
  etag: string;

  /**
   * For a folder or a document whose readers are inherited: the folder they come from.
   * @public
   */
  inheritedFrom?: string | undefined;
}

/**
 * @public
 */
export interface GetAccessInput {
  /**
   * The knowledge base whose access is read, or that holds the folder or document.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * A folder in it, for example `/hr/investigations/`. Filled from `kb.folders(path)`.
   * @public
   */
  folder?: string | undefined;

  /**
   * A document in it. Filled from `kb.documents(id)`.
   * @public
   */
  document?: string | undefined;
}

/**
 * @public
 */
export interface GetAccessOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The access's ETag; send it as `If-Match` to set it.
   * @public
   */
  etag: string;

  /**
   * The access as it stands now. It is the whole response body.
   * @public
   */
  access: Access;
}

/**
 * One problem with one request member or query parameter.
 * @public
 */
export interface FieldError {
  /**
   * A JSON Pointer (RFC 6901) into the request body, for example `/context/0/label`. Absent when
   * the problem is with a query parameter.
   * @public
   */
  pointer?: string | undefined;

  /**
   * The query parameter at fault, for example `filter[staus][eq]`. Absent when the problem is in
   * the body.
   * @public
   */
  parameter?: string | undefined;

  /**
   * The code for this field's problem, from the same catalogue as the response's own code.
   * @public
   */
  code: string;

  /**
   * What is wrong with the field, written for the integrator.
   * @public
   */
  detail?: string | undefined;
}

/**
 * @public
 */
export interface PutAccessInput {
  /**
   * For the knowledge base: each role's grants. A role left out has none.
   * @public
   */
  roles?: RoleAccess[] | undefined;

  /**
   * For a folder or a document: who may read it.
   * @public
   */
  readers?: Readers | undefined;

  /**
   * The knowledge base whose access is set, or that holds the folder or document.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * A folder in it. Filled from `kb.folders(path)`.
   * @public
   */
  folder?: string | undefined;

  /**
   * A document in it. Filled from `kb.documents(id)`.
   * @public
   */
  document?: string | undefined;

  /**
   * The access's ETag. When given, access that changed since is refused with 412; when absent,
   * the write is unconditional.
   * @public
   */
  ifMatch?: string | undefined;
}

/**
 * @public
 */
export interface PutAccessOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The access's new ETag.
   * @public
   */
  etag: string;

  /**
   * The access, set. It is the whole response body.
   * @public
   */
  access: Access;
}

/**
 * A person or an API client that made a change.
 * @public
 */
export interface Actor {
  /**
   * The person, when a person made the change.
   * @public
   */
  userId?: string | undefined;

  /**
   * The API client, when one made the change or a person made it through one.
   * @public
   */
  apiClientId?: string | undefined;

  /**
   * The person's or API client's name, as people saw it when the change was made.
   * @public
   */
  displayName: string;
}

/**
 * What an agent's avatar shows. Exactly one member is present.
 * @public
 */
export interface AgentMark {
  /**
   * A named icon from the platform's set.
   * @public
   */
  icon?: AgentIconName | undefined;

  /**
   * The uploaded picture's address, to show as an image. It may stop working after a time; read the
   * agent again for a fresh one.
   * @public
   */
  pictureUrl?: string | undefined;
}

/**
 * How an agent looks.
 * @public
 */
export interface AgentAvatar {
  /**
   * The colour behind the avatar's icon, picture or initials.
   * @public
   */
  colour?: AvatarColour | undefined;

  /**
   * What the avatar shows: a named icon, or a picture. Absent shows the agent's initials.
   * @public
   */
  mark?: AgentMark | undefined;
}

/**
 * An agent: its name, description, avatar and which version is live.
 * @public
 */
export interface Agent {
  /**
   * The identifier every call about this agent takes; it never changes.
   * @public
   */
  id: string;

  /**
   * What people see the agent called, in the app and in chat. Not versioned.
   * @public
   */
  name: string;

  /**
   * What the agent is for. Not versioned. Where a version's handover readers find no description of
   * their own, they use this one.
   * @public
   */
  description?: string | undefined;

  /**
   * How the agent looks in lists and in the chat. Not versioned.
   * @public
   */
  avatar?: AgentAvatar | undefined;

  /**
   * The version live points at. Absent until the agent's first publish.
   * @public
   */
  liveVersion?: string | undefined;

  /**
   * When the agent was created.
   * @public
   */
  createdAt: Date;

  /**
   * When the agent's name, description or avatar last changed.
   * @public
   */
  updatedAt?: Date | undefined;

  /**
   * The agent's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;
}

/**
 * What an agent's avatar should show. Exactly one of `icon` and `pictureUploadId`; both or neither
 * is refused with 400 `VALIDATION_FAILED`.
 * @public
 */
export interface AgentMarkInput {
  /**
   * A named icon from the platform's set.
   * @public
   */
  icon?: AgentIconName | undefined;

  /**
   * An upload holding the picture, reserved with CreateUpload and `purpose: \{agentAvatar: true\}`.
   * Each upload can be used once.
   * @public
   */
  pictureUploadId?: string | undefined;
}

/**
 * How an agent should look, as a caller sets it.
 * @public
 */
export interface AgentAvatarInput {
  /**
   * The colour behind the avatar's icon, picture or initials.
   * @public
   */
  colour?: AvatarColour | undefined;

  /**
   * What the avatar shows: a named icon, or a picture.
   * @public
   */
  mark?: AgentMarkInput | undefined;
}

/**
 * How an agent cites its sources.
 * @public
 */
export interface CitationSettings {
  /**
   * Whether the agent may cite the person's own earlier messages. Defaults to false.
   * @public
   */
  userMessages?: boolean | undefined;
}

/**
 * Images and media in answers.
 * @public
 */
export interface MediaEmbedSettings {
  /**
   * Whether answers show images and media from the passages they cite. Defaults to false.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * How many search results are kept for media, from 0 to 10. Defaults to 2.
   * @public
   */
  reservedResults?: number | undefined;
}

/**
 * How answers are shaped.
 * @public
 */
export interface AnswerSettings {
  /**
   * Whether the agent ends an answer by offering follow-up questions. Defaults to true.
   * @public
   */
  followUpQuestions?: boolean | undefined;

  /**
   * How the agent cites its sources.
   * @public
   */
  citations?: CitationSettings | undefined;

  /**
   * Whether the agent shows images and media from the passages it cites.
   * @public
   */
  mediaEmbeds?: MediaEmbedSettings | undefined;
}

/**
 * Chat attachment settings.
 * @public
 */
export interface AttachmentSettings {
  /**
   * Whether people may attach documents in chat. Defaults to false.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * The most documents one conversation may hold, from 1 to 10. Defaults to 5.
   * @public
   */
  maxFiles?: number | undefined;

  /**
   * The largest document accepted, in bytes, from 102,400 (100 KB) to 10,485,760 (10 MB).
   * Defaults to 4,718,592 (4.5 MB).
   * @public
   */
  maxByteSize?: number | undefined;

  /**
   * The file extensions accepted. Defaults to `pdf`, `docx`, `txt`, `csv` and `md`.
   * @public
   */
  acceptedTypes?: string[] | undefined;
}

/**
 * One of the workspace's connectors an agent version may use.
 * @public
 */
export interface ConnectorBinding {
  /**
   * Which of the workspace's connectors the version may use.
   * @public
   */
  connectorId: string;
}

/**
 * The guardrail that screens documents attached in chat.
 * @public
 */
export interface ContentSafety {
  /**
   * The ID of an entry in `GET /v3/guardrails`, `default` (the platform default, also used when
   * absent) or `none`.
   * @public
   */
  guardrail?: string | undefined;
}

/**
 * How the chat looks and behaves.
 * @public
 */
export interface ConversationSettings {
  /**
   * The hint in the empty chat box, at most 200 characters. Absent or empty uses the workspace
   * theme's.
   * @public
   */
  inputPlaceholder?: string | undefined;

  /**
   * The time zone dates and "today" are read in, as an IANA name. Defaults to `Pacific/Auckland`.
   * @public
   */
  timeZone?: string | undefined;
}

/**
 * Who the agent is and how it behaves, and the text it follows at particular points in an answer.
 * @public
 */
export interface AgentGuidance {
  /**
   * Who the agent is and whom it serves, at the top of every prompt, at most 4,000 characters.
   * Absent uses the platform's.
   * @public
   */
  identity?: string | undefined;

  /**
   * How the agent behaves, at most 100,000 characters. Always present when read; an empty string
   * means none.
   * @public
   */
  instructions?: string | undefined;

  /**
   * What makes an answer relevant to the people this agent serves, and what it should decline.
   * @public
   */
  relevance?: string | undefined;

  /**
   * A glossary of terms the agent reads the same way every time.
   * @public
   */
  definitions?: string | undefined;

  /**
   * How to turn a question into the topics it searches for.
   * @public
   */
  searchTopics?: string | undefined;

  /**
   * How to judge the passages a search finds, for example "prefer the most recent". Not used with
   * the `reranker` evaluation method.
   * @public
   */
  resultEvaluation?: string | undefined;

  /**
   * What to say when the knowledge bases hold too little to answer. When set, it replaces
   * `instructions` in the reply to a question with no evidence.
   * @public
   */
  limitedEvidence?: string | undefined;
}

/**
 * The poster on a journey page.
 * @public
 */
export interface JourneyPoster {
  /**
   * The words on the poster, such as "Onboarding".
   * @public
   */
  label: string;

  /**
   * Short lines at the foot of the poster, one per line, at most 6.
   * @public
   */
  footer?: string[] | undefined;
}

/**
 * The introduction on a journey page.
 * @public
 */
export interface JourneyIntroduction {
  /**
   * The small label above the title, such as "Getting started". Used on `start` only.
   * @public
   */
  eyebrow?: string | undefined;

  /**
   * The title, such as "Welcome. Let's set up Caitlyn for your organisation."
   * @public
   */
  title: string;

  /**
   * The paragraph under the title. Required on `start`.
   * @public
   */
  lead?: string | undefined;

  /**
   * The button, such as "Begin set-up" or "Continue in your set-up chat".
   * @public
   */
  buttonLabel: string;
}

/**
 * The page shown for a stepped workflow: a poster on one side, and an introduction that changes once
 * some steps are done. Its steps are the phases' `step` settings, numbered in the order their phases
 * are declared; a step is done when its phases complete, or when its `doneWhen` signal says so.
 * @public
 */
export interface JourneySettings {
  /**
   * The poster beside the introduction. Always present when read.
   * @public
   */
  poster?: JourneyPoster | undefined;

  /**
   * What a person sees before they start. Always present when read.
   * @public
   */
  start?: JourneyIntroduction | undefined;

  /**
   * What a person sees once some steps are done or skipped. Always present when read.
   * @public
   */
  resume?: JourneyIntroduction | undefined;
}

/**
 * Native reasoning ("extended thinking") for a model that supports it.
 * @public
 */
export interface ReasoningSettings {
  /**
   * Whether the model reasons before it answers. Defaults to false; a model whose `reasoning` is
   * `always` reasons whatever this says.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * How much effort the model spends reasoning. Absent uses the model's default. Refused with 400
   * for a level the model does not list in `effortLevels`.
   * @public
   */
  effort?: ReasoningEffort | undefined;
}

/**
 * One job's model and its settings.
 * @public
 */
export interface ModelSettings {
  /**
   * The model, from `GET /v3/models`. Absent uses the job's default.
   * @public
   */
  model?: string | undefined;

  /**
   * Sampling temperature, from 0 to 1. Absent uses the model's default. Refused with 400 for a
   * model that does not accept it (see `acceptsTemperature` in `GET /v3/models`).
   * @public
   */
  temperature?: number | undefined;

  /**
   * Nucleus sampling, from 0 to 1. Absent uses the model's default.
   * @public
   */
  topP?: number | undefined;

  /**
   * Top-K sampling, from 0 to 250. Absent uses the model's default.
   * @public
   */
  topK?: number | undefined;

  /**
   * The most tokens the job may write, from 1 to 16,384. Defaults to 2,048.
   * @public
   */
  maxOutputTokens?: number | undefined;

  /**
   * How many times a failed call to the model is tried, from 1 to 10. Defaults to 3.
   * @public
   */
  maxAttempts?: number | undefined;

  /**
   * Native reasoning, for a model that supports it; refused with 400 for one that does not.
   * @public
   */
  reasoning?: ReasoningSettings | undefined;
}

/**
 * How the passages a search finds are judged.
 * @public
 */
export interface ResultEvaluation {
  /**
   * What judges the search results. Defaults to `reranker`.
   * @public
   */
  method?: ResultEvaluationMethod | undefined;

  /**
   * The most passages each search keeps for evaluation, from 1 to 100. Defaults to 10.
   * @public
   */
  maxSearchResults?: number | undefined;

  /**
   * The most passages kept after evaluation, from 1 to 100, and at most `maxQueries` ×
   * `maxSearchResults`. Defaults to 10.
   * @public
   */
  maxResults?: number | undefined;

  /**
   * For `model`: the model that judges each passage. Unset members fall back to
   * `models.planning`.
   * @public
   */
  judge?: ModelSettings | undefined;

  /**
   * For `reranker`: the reranking model, from `GET /v3/models`. Absent uses the platform's
   * preference.
   * @public
   */
  reranker?: string | undefined;
}

/**
 * One knowledge base an agent searches, and how hard.
 * @public
 */
export interface KnowledgeBaseBinding {
  /**
   * The knowledge base searched. The caller must be able to read it.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * What it holds, so the agent knows when to search it, at most 2,000 characters. Absent uses
   * the knowledge base's own `agentDescription`.
   * @public
   */
  description?: string | undefined;

  /**
   * The most searches the agent may write for this knowledge base per question, from 1 to 20.
   * Defaults to 3.
   * @public
   */
  maxQueries?: number | undefined;

  /**
   * How many passages each search retrieves, from 1 to 50. Defaults to 6.
   * @public
   */
  numberOfResults?: number | undefined;

  /**
   * The lowest similarity score a passage needs before it is evaluated, from 0 to 1. Defaults to
   * 0.3.
   * @public
   */
  minimumScore?: number | undefined;

  /**
   * The lowest relevance an evaluated passage needs to reach the answer, from 0 to 1. Defaults to
   * 0.5.
   * @public
   */
  minimumRelevance?: number | undefined;

  /**
   * Whether an audio or video citation shows its transcript beside the player. Absent follows the
   * knowledge base.
   * @public
   */
  transcriptPanel?: boolean | undefined;

  /**
   * How the passages a search finds are judged before they reach the answer. One method per
   * search.
   * @public
   */
  evaluation?: ResultEvaluation | undefined;
}

/**
 * What a live avatar says while an answer is being written.
 * @public
 */
export interface HoldingPhrases {
  /**
   * Phrases that acknowledge the person has finished speaking.
   * @public
   */
  openers?: string[] | undefined;

  /**
   * Groups of phrases, said one group after another while the answer is written.
   * @public
   */
  groups?: string[][] | undefined;

  /**
   * What the avatar says when the answer is taking longer than usual.
   * @public
   */
  stillProcessing?: string | undefined;

  /**
   * What the avatar says to invite the person to clarify when no answer arrived.
   * @public
   */
  followUp?: string | undefined;

  /**
   * Milliseconds between holding phrases, from 1,000 to 60,000.
   * @public
   */
  intervalMs?: number | undefined;

  /**
   * The chance, from 0 to 1, that any one holding phrase is skipped, so the rhythm sounds less
   * mechanical.
   * @public
   */
  skipChance?: number | undefined;
}

/**
 * Pausing a live avatar conversation and carrying on later.
 * @public
 */
export interface PauseAndResume {
  /**
   * What the avatar says when a conversation starts fresh, at most 1,000 characters.
   * @public
   */
  openingIntro: string;

  /**
   * What the avatar says in place of the intro when a paused conversation resumes, at most 500
   * characters.
   * @public
   */
  resumeIntro: string;

  /**
   * Milliseconds a paused conversation stays resumable, from 60,000 to 3,600,000. Defaults to ten
   * minutes.
   * @public
   */
  pausedTimeoutMs?: number | undefined;
}

/**
 * Adjustments to a live avatar's voice.
 * @public
 */
export interface AvatarVoiceTuning {
  /**
   * How fast the avatar speaks, from 0.8 to 1.2. Defaults to 1.
   * @public
   */
  speed?: number | undefined;

  /**
   * Which of the provider's voice models speaks. Absent uses the provider's default.
   * @public
   */
  model?: string | undefined;

  /**
   * How steady the voice is, from 0 to 1. Absent uses the provider's default.
   * @public
   */
  stability?: number | undefined;

  /**
   * How much the voice exaggerates its style, from 0 to 1. Absent uses the provider's default.
   * @public
   */
  style?: number | undefined;
}

/**
 * A live video avatar that speaks for the agent. Its provider's key is referenced by `secretId`,
 * never copied, so publishing or resetting from an old version cannot bring back an old key.
 * @public
 */
export interface LiveAvatarSettings {
  /**
   * Which company's service runs the avatar. Defaults to `heygen`, the only one.
   * @public
   */
  provider?: LiveAvatarProvider | undefined;

  /**
   * The stored secret holding the provider's key. Exported as a template variable.
   * @public
   */
  secretId: string;

  /**
   * The version of this agent that answers for the avatar. Absent means this version. `draft` and
   * `live` follow their moving target: edits to the draft, and each publish, take effect without
   * this setting changing. A saved version's name never moves.
   * @public
   */
  answerVersion?: string | undefined;

  /**
   * Phrases that hand the conversation to the answering version when the avatar says one, at
   * least one.
   * @public
   */
  triggerPhrases: string[];

  /**
   * Which of the provider's avatars appears.
   * @public
   */
  avatarId: string;

  /**
   * Which of the provider's voices the avatar speaks with.
   * @public
   */
  voiceId: string;

  /**
   * The provider's conversation context.
   * @public
   */
  contextId: string;

  /**
   * The language the avatar speaks, as a BCP 47 tag, for example `en-NZ`.
   * @public
   */
  language: string;

  /**
   * What the avatar says while an answer is being written.
   * @public
   */
  holdingPhrases?: HoldingPhrases | undefined;

  /**
   * When true (the default), the microphone is muted whenever the avatar speaks; when false, only
   * while an answer is being written, so the person can interrupt.
   * @public
   */
  muteWhileSpeaking?: boolean | undefined;

  /**
   * Which service turns what people say into text. Absent uses the platform's.
   * @public
   */
  speechToText?: SpeechToTextProvider | undefined;

  /**
   * Milliseconds of silence before the avatar ends the conversation. 0 never ends it.
   * @public
   */
  inactivityTimeoutMs?: number | undefined;

  /**
   * Which part of the video stays in view on a narrow screen: `left`, `centre`, `right`, or a whole
   * percentage from the left edge, such as `40`.
   * @public
   */
  videoAlignment?: string | undefined;

  /**
   * Adjustments to the provider's voice.
   * @public
   */
  voiceTuning?: AvatarVoiceTuning | undefined;

  /**
   * When set, people can pause the conversation and carry on later.
   * @public
   */
  pauseAndResume?: PauseAndResume | undefined;
}

/**
 * Whether, and how, the agent remembers people between conversations.
 * @public
 */
export interface MemorySettings {
  /**
   * Whether the agent remembers. Defaults to false.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * The memory store, from `GET /v3/memory-stores`. Required when `enabled`.
   * @public
   */
  memoryStoreId?: string | undefined;

  /**
   * The lowest relevance a memory needs to be recalled, from 0 to 1. Defaults to 0.4.
   * @public
   */
  minimumRelevance?: number | undefined;

  /**
   * The most memories recalled for one answer, from 1 to 100. Defaults to 10.
   * @public
   */
  maxResults?: number | undefined;

  /**
   * Whether the agent remembers what people prefer. Defaults to false.
   * @public
   */
  preferences?: boolean | undefined;

  /**
   * Whether the agent remembers summaries of earlier conversations. Defaults to false.
   * @public
   */
  summaries?: boolean | undefined;
}

/**
 * The answer job's model and its settings.
 * @public
 */
export interface AnswerModelSettings {
  /**
   * The model, from `GET /v3/models`. Absent uses the job's default.
   * @public
   */
  model?: string | undefined;

  /**
   * Sampling temperature, from 0 to 1. Absent uses the model's default. Refused with 400 for a
   * model that does not accept it (see `acceptsTemperature` in `GET /v3/models`).
   * @public
   */
  temperature?: number | undefined;

  /**
   * Nucleus sampling, from 0 to 1. Absent uses the model's default.
   * @public
   */
  topP?: number | undefined;

  /**
   * Top-K sampling, from 0 to 250. Absent uses the model's default.
   * @public
   */
  topK?: number | undefined;

  /**
   * The most tokens the job may write, from 1 to 16,384. Defaults to 2,048.
   * @public
   */
  maxOutputTokens?: number | undefined;

  /**
   * How many times a failed call to the model is tried, from 1 to 10. Defaults to 3.
   * @public
   */
  maxAttempts?: number | undefined;

  /**
   * Native reasoning, for a model that supports it; refused with 400 for one that does not.
   * @public
   */
  reasoning?: ReasoningSettings | undefined;

  /**
   * How many times an answer that ran out of output may be continued, from 0 to 5. Defaults to
   * 0, which is off.
   * @public
   */
  maxContinuations?: number | undefined;
}

/**
 * The model that names conversations.
 * @public
 */
export interface TitleModelSettings {
  /**
   * The model, from `GET /v3/models`. Absent uses a small, fast model.
   * @public
   */
  model?: string | undefined;

  /**
   * The most tokens a title may take, from 1 to 512. Defaults to 32.
   * @public
   */
  maxOutputTokens?: number | undefined;

  /**
   * How many times a failed call to the model is tried, from 1 to 10. Defaults to 2.
   * @public
   */
  maxAttempts?: number | undefined;
}

/**
 * The model for each job in an answer. A job left unset uses its default.
 * @public
 */
export interface AgentModels {
  /**
   * Writes the answer. The other jobs fall back to this one's model when their own is unset.
   * @public
   */
  answer?: AnswerModelSettings | undefined;

  /**
   * Plans the answer: reads the question, plans the searches and reads attached documents.
   * @public
   */
  planning?: ModelSettings | undefined;

  /**
   * Summarises a long conversation so the answer stays within the model's limits.
   * @public
   */
  summary?: ModelSettings | undefined;

  /**
   * Decides what kind of message arrived, and whether the question is in scope.
   * @public
   */
  classification?: ModelSettings | undefined;

  /**
   * Writes the search topics for a question. Falls back to `planning`, then `answer`.
   * @public
   */
  searchTopics?: ModelSettings | undefined;

  /**
   * Names a conversation, once. Defaults to a small, fast model, not the answer model.
   * @public
   */
  title?: TitleModelSettings | undefined;
}

/**
 * One policy an agent version uses.
 * @public
 */
export interface PolicyBinding {
  /**
   * Which policy the version may review documents against.
   * @public
   */
  policyId: string;
}

/**
 * Whose permissions an unattended run of this version uses.
 * @public
 */
export interface RunAs {
  /**
   * The role whose permissions unattended runs use. The caller may name only a role it could
   * assign.
   * @public
   */
  roleId: string;
}

/**
 * Whether, and how, the agent speaks its answers.
 * @public
 */
export interface VoiceSettings {
  /**
   * What speaks the agent's answers. Defaults to `browser`. The voices on offer are listed by
   * `GET /v3/voices`.
   * @public
   */
  provider?: VoiceProvider | undefined;

  /**
   * For `cloud`: the voice, from `GET /v3/voices`, for example `Aria`.
   * @public
   */
  voiceId?: string | undefined;

  /**
   * For a cloud voice: how natural it sounds. Defaults to `natural`.
   * @public
   */
  quality?: VoiceQuality | undefined;

  /**
   * The language and accent, as a BCP 47 tag, for example `en-NZ`. Defaults to `en-NZ`.
   * @public
   */
  language?: string | undefined;
}

/**
 * A group of phases the agent handles as one area of work. While a conversation is in one of its
 * phases, the model sees only the capability's instructions and its phases' tools. Moving into a
 * phase of another capability hands the conversation over, with a summary for the next one.
 * @public
 */
export interface Capability {
  /**
   * The capability's identifier, unique within the workflow.
   * @public
   */
  id: string;

  /**
   * What this capability does, in one sentence. The capability that receives a handover reads it.
   * @public
   */
  description: string;

  /**
   * Added after the agent's instructions while the capability is active.
   * @public
   */
  instructions?: string | undefined;

  /**
   * The phases it owns, at least one. When capabilities are declared, every phase belongs to
   * exactly one.
   * @public
   */
  phases: string[];

  /**
   * Who a conversation in this capability is shared with. Absent decides nothing: the
   * conversation keeps its sharing until it enters a capability that sets one.
   * @public
   */
  conversationScope?: ConversationSharing | undefined;
}

/**
 * The action a `take_action` phase takes.
 * @public
 */
export interface PhaseAction {
  /**
   * What the action is, in plain words.
   * @public
   */
  description: string;

  /**
   * Tools the agent must call, at least one of them, before the action counts as done. Empty means
   * the agent's own account of what it did is enough.
   * @public
   */
  requiredTools?: string[] | undefined;

  /**
   * When true, the phase completes as soon as one of `requiredTools` succeeds. Defaults to false.
   * @public
   */
  completesOnRequiredTool?: boolean | undefined;
}

/**
 * Checks that an answer's claims are supported by what it cites.
 * @public
 */
export interface AttributionChecks {
  /**
   * The model that checks. Absent uses `models.planning`.
   * @public
   */
  model?: string | undefined;

  /**
   * How many times an answer that fails the check may be rewritten, from 0 to 10. Defaults to 2.
   * @public
   */
  maxRetries?: number | undefined;

  /**
   * What happens when an answer fails a check. Defaults to `record`.
   * @public
   */
  mode?: AttributionCheckMode | undefined;
}

/**
 * One place a phase field's value may come from.
 * @public
 */
export interface FieldSource {
  /**
   * Which place the value comes from. The other members name the tool, the fixed values or the
   * earlier phase.
   * @public
   */
  kind: FieldSourceKind;

  /**
   * For `tool_result`: the tool whose result holds the value.
   * @public
   */
  toolName?: string | undefined;

  /**
   * For `tool_result`: a path into the tool's output, for example `results[0].id`. Empty means the
   * whole output.
   * @public
   */
  path?: string | undefined;

  /**
   * For `allowed_values`: the values the field may take, at least one.
   * @public
   */
  values?: string[] | undefined;

  /**
   * For `earlier_phase`: the phase that gathered the value.
   * @public
   */
  phase?: string | undefined;

  /**
   * For `earlier_phase`: the field it was gathered as.
   * @public
   */
  field?: string | undefined;
}

/**
 * One thing a phase asks for or needs: a field to gather, or an earlier phase that must be done.
 * @public
 */
export interface PhaseField {
  /**
   * The field's identifier, unique within the phase.
   * @public
   */
  id: string;

  /**
   * Whether the entry is a value the phase gathers or an earlier phase that must be done first.
   * Defaults to `field`.
   * @public
   */
  kind?: PhaseFieldKind | undefined;

  /**
   * For `field`: what the value is. Required on a field.
   * @public
   */
  description?: string | undefined;

  /**
   * For `field`: how the agent asks for it. Required on a field.
   * @public
   */
  request?: string | undefined;

  /**
   * For `field`: when true, the phase may finish without it. Defaults to false.
   * @public
   */
  optional?: boolean | undefined;

  /**
   * For a `field`: what kind of value it holds. Defaults to `text`.
   * @public
   */
  type?: PhaseFieldType | undefined;

  /**
   * For a `document` field: the file extensions accepted, for example `pdf`.
   * @public
   */
  acceptedTypes?: string[] | undefined;

  /**
   * For a `document` field: the largest file accepted, in bytes.
   * @public
   */
  maxByteSize?: number | undefined;

  /**
   * For a `document` field: the document metadata field the value fills.
   * @public
   */
  documentField?: string | undefined;

  /**
   * For `field`: where the value may come from, in order. Absent means the person.
   * @public
   */
  sources?: FieldSource[] | undefined;

  /**
   * For `prerequisite`: the phase that must be done first. Required on a prerequisite.
   * @public
   */
  prerequisite?: string | undefined;
}

/**
 * What happens when a phase ends the conversation.
 * @public
 */
export interface PhaseEnd {
  /**
   * What happens to the conversation when the phase ends it.
   * @public
   */
  type: PhaseEndType;

  /**
   * For `restart`: the phase the next message starts in. Defaults to the conversation's entry
   * phase.
   * @public
   */
  restartIn?: string | undefined;

  /**
   * For `close`: what the person is told.
   * @public
   */
  closingMessage?: string | undefined;
}

/**
 * What the person sees when a conversation starts in, or enters, a phase.
 * @public
 */
export interface PhaseOpening {
  /**
   * A message shown before the person types anything. `@user:firstName`, `@user:lastName` and
   * `@user:email` are replaced with the person's details.
   * @public
   */
  message?: string | undefined;

  /**
   * A form, buttons or choices shown with the message, as `input.requested` carries one.
   * @public
   */
  input?: __DocumentType | undefined;

  /**
   * When true, the opening is shown whenever the conversation enters the phase, not only when a
   * conversation starts in it. Defaults to false.
   * @public
   */
  onEveryEntry?: boolean | undefined;
}

/**
 * A set reply a phase may give, chosen by its description.
 * @public
 */
export interface PhaseResponse {
  /**
   * The reply's identifier, unique within the phase.
   * @public
   */
  id: string;

  /**
   * When the agent gives this reply.
   * @public
   */
  description: string;

  /**
   * What the agent says.
   * @public
   */
  request: string;
}

/**
 * The policy a `policy_review` phase reviews against.
 * @public
 */
export interface PolicyReviewSettings {
  /**
   * Which policy the phase reviews against. It must be in `policies`.
   * @public
   */
  policyId: string;

  /**
   * The rules to check. Absent means every rule in the policy, read again each time a review
   * starts.
   * @public
   */
  ruleIds?: string[] | undefined;

  /**
   * The policy's review stage this phase reviews at. Absent for a policy with no review stages.
   * @public
   */
  reviewStageId?: string | undefined;
}

/**
 * A phase's step on the journey page.
 * @public
 */
export interface JourneyStep {
  /**
   * Groups phases into steps on the journey page. Phases that share one form one step.
   * @public
   */
  id: string;

  /**
   * What the journey page calls the step, such as "Knowledge base".
   * @public
   */
  label: string;

  /**
   * A named signal that shows the step done outside the chat, such as `workspaceHasCustomTheme`.
   * Absent: the step is done when its phases complete.
   * @public
   */
  doneWhen?: string | undefined;
}

/**
 * Checks each tool call against a rule before it runs.
 * @public
 */
export interface ToolCallChecks {
  /**
   * The rule, in plain words, every tool call is checked against.
   * @public
   */
  policy: string;

  /**
   * The model that checks. Absent uses `models.planning`.
   * @public
   */
  model?: string | undefined;

  /**
   * How many times a refused call may be corrected, from 0 to 10. Defaults to 2.
   * @public
   */
  maxRetries?: number | undefined;
}

/**
 * How Caitlyn's knowledge base search tool searches.
 * @public
 */
export interface ToolSearchSettings {
  /**
   * The search modes the agent may choose from, at least one.
   * @public
   */
  modes: SearchMode[];

  /**
   * The version of this agent whose knowledge bases and search settings the tool uses. `draft` and
   * `live` follow their moving target: edits to the draft, and each publish, take effect without
   * this setting changing. A saved version's name never moves.
   * @public
   */
  version: string;
}

/**
 * A tool a phase may use: one of Caitlyn's own, or the tools on an MCP server.
 * @public
 */
export interface PhaseTool {
  /**
   * One of Caitlyn's own tools, from `GET /v3/tools`. Exactly one of `name` and `mcpServerId`.
   * @public
   */
  name?: string | undefined;

  /**
   * An MCP server whose tools the phase may use. Exactly one of `name` and `mcpServerId`. With no
   * `tools`, every tool on the server, including tools it adds later; otherwise only those
   * listed. Exported as a template variable.
   * @public
   */
  mcpServerId?: string | undefined;

  /**
   * With `mcpServerId`: only these of the server's tools.
   * @public
   */
  tools?: string[] | undefined;

  /**
   * With `mcpServerId` and no `tools`: the server's tools the phase may not use.
   * @public
   */
  excludedTools?: string[] | undefined;

  /**
   * What the tool is for, in the agent's words. Absent uses the tool's own description.
   * @public
   */
  description?: string | undefined;

  /**
   * Whether the phase may use the tool. Defaults to true.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * How the agent uses what the tool returns. Defaults to `default`.
   * @public
   */
  use?: ToolUse | undefined;

  /**
   * What a citation of this tool's results is called, for example "Policy register".
   * @public
   */
  citationLabel?: string | undefined;

  /**
   * For Caitlyn's knowledge base search tool: how it searches.
   * @public
   */
  search?: ToolSearchSettings | undefined;
}

/**
 * A value that takes a way out of a phase automatically.
 * @public
 */
export interface TransitionMatch {
  /**
   * Where the value is read from. Defaults to `tool_result`.
   * @public
   */
  source?: TransitionMatchSource | undefined;

  /**
   * For `tool_result`, a dotted path into the tool's output, for example `isCovered`; for
   * `saved_field`, a field of this phase.
   * @public
   */
  field: string;

  /**
   * The value the field must hold: a string, number or boolean. A saved field is compared as a
   * string.
   * @public
   */
  equals: __DocumentType;
}

/**
 * A way out of a phase.
 * @public
 */
export interface PhaseTransition {
  /**
   * The phase it leads to.
   * @public
   */
  to: string;

  /**
   * The condition, in plain words, that makes this the way out. The agent decides by it.
   * @public
   */
  condition: string;

  /**
   * How the way out is gated. Defaults to `alternative`.
   * @public
   */
  kind?: TransitionKind | undefined;

  /**
   * For `skip`: the words on the chat's skip button, such as "Skip theme configuration". Required
   * on a skip.
   * @public
   */
  skipLabel?: string | undefined;

  /**
   * When true, the agent may take this way out only on the person's express choice. Defaults to
   * false.
   * @public
   */
  requiresUserChoice?: boolean | undefined;

  /**
   * Takes this way out automatically when a value matches, without the agent deciding.
   * @public
   */
  when?: TransitionMatch | undefined;

  /**
   * How this phase wraps up before it hands over through this way out.
   * @public
   */
  handover?: string | undefined;

  /**
   * Only when the conversation started in one of these phases.
   * @public
   */
  startedIn?: string[] | undefined;

  /**
   * Never when the conversation started in one of these phases.
   * @public
   */
  notStartedIn?: string[] | undefined;
}

/**
 * One phase of a workflow. `kind` decides which kind-specific members apply; a member that does not
 * apply to the kind is refused with 400, never ignored.
 * @public
 */
export interface Phase {
  /**
   * The phase's identifier, unique within the workflow.
   * @public
   */
  id: string;

  /**
   * What the phase does, which decides which of its other members apply.
   * @public
   */
  kind: PhaseKind;

  /**
   * The phase's own instructions, added to the agent's while it runs.
   * @public
   */
  instructions?: string | undefined;

  /**
   * The tools the phase may use, at most 30.
   * @public
   */
  tools?: PhaseTool[] | undefined;

  /**
   * Where the conversation may go from this phase.
   * @public
   */
  transitions?: PhaseTransition[] | undefined;

  /**
   * The most model calls the phase may make in one answer, from 1 to 50. Defaults to 10, or 30
   * for `policy_review`.
   * @public
   */
  maxSteps?: number | undefined;

  /**
   * Native reasoning while the phase runs.
   * @public
   */
  reasoning?: ReasoningSettings | undefined;

  /**
   * What the person sees when a conversation starts in, or enters, this phase.
   * @public
   */
  opening?: PhaseOpening | undefined;

  /**
   * This phase's step on the journey page, when it is part of one.
   * @public
   */
  step?: JourneyStep | undefined;

  /**
   * What happens when the phase ends the conversation. Absent means the conversation carries on.
   * @public
   */
  onEnd?: PhaseEnd | undefined;

  /**
   * When true, the phase runs with no person: it asks the person nothing, and must finish with its
   * own tools. Defaults to false. For `gather_info`, `take_action` and `policy_review`.
   * @public
   */
  unattended?: boolean | undefined;

  /**
   * For `conversational`: when true, the phase replies as soon as an earlier phase hands over,
   * rather than waiting for the person. Defaults to false.
   * @public
   */
  repliesOnEntry?: boolean | undefined;

  /**
   * Checks each tool call against a rule before it runs.
   * @public
   */
  toolCallChecks?: ToolCallChecks | undefined;

  /**
   * Checks that each answer's claims are supported by what it cites.
   * @public
   */
  attributionChecks?: AttributionChecks | undefined;

  /**
   * For `gather_info` and `take_action`: what the phase asks for or needs.
   * @public
   */
  fields?: PhaseField[] | undefined;

  /**
   * For `gather_info`, `take_action` and `policy_review`: the phase to move to when this one is
   * done.
   * @public
   */
  next?: string | undefined;

  /**
   * For `gather_info`, `take_action` and `policy_review`: how this phase wraps up before it hands
   * over to `next`.
   * @public
   */
  handover?: string | undefined;

  /**
   * For `gather_info`, `take_action` and `policy_review`: what the phase's outcome is, and how
   * later phases should use it.
   * @public
   */
  outcomeDescription?: string | undefined;

  /**
   * Set replies the phase may give, each chosen by its description.
   * @public
   */
  responses?: PhaseResponse[] | undefined;

  /**
   * For `take_action`: the action the phase takes.
   * @public
   */
  action?: PhaseAction | undefined;

  /**
   * For `take_action`: the policy rules this phase checks, as `<policyId>/<ruleId>`. Each policy
   * must be in `policies`.
   * @public
   */
  policyRules?: string[] | undefined;

  /**
   * For `policy_review`: the policy the phase reviews against, and which of its rules.
   * @public
   */
  review?: PolicyReviewSettings | undefined;
}

/**
 * The agent's workflow: the phases a conversation moves through.
 * @public
 */
export interface AgentWorkflow {
  /**
   * The phase a new conversation starts in. Defaults to `answer`, the phase every agent has.
   * @public
   */
  entryPhase?: string | undefined;

  /**
   * The phases, in the order their journey steps are numbered. Always present when read. Lists
   * are replaced whole: to change one phase, send them all back.
   * @public
   */
  phases?: Phase[] | undefined;

  /**
   * Groups of phases that each run with their own instructions and only their own tools. Absent:
   * every phase shares one set of instructions and one set of tools.
   * @public
   */
  capabilities?: Capability[] | undefined;
}

/**
 * An agent version's configuration: everything about how the agent behaves that a version holds.
 *
 * The agent's name, description and avatar belong to the agent and are not versioned; who may use
 * the draft and saved versions belongs to the versions' access grant. A configuration is at most
 * 256 KiB as UTF-8 JSON; anything larger is refused with 400 `CONFIGURATION_TOO_LARGE`.
 * @public
 */
export interface AgentConfiguration {
  /**
   * Who the agent is and how it behaves, and the text it follows at particular points in an
   * answer. Always present when read.
   * @public
   */
  guidance?: AgentGuidance | undefined;

  /**
   * The model for each job in an answer. A job left unset uses its default.
   * @public
   */
  models?: AgentModels | undefined;

  /**
   * The knowledge bases the agent searches, and how hard, at most 50, each at most once.
   * @public
   */
  knowledgeBases?: KnowledgeBaseBinding[] | undefined;

  /**
   * The policies the agent's policy reviews and checked phases use, at most 20. Exported as a
   * template variable.
   * @public
   */
  policies?: PolicyBinding[] | undefined;

  /**
   * The workspace's connectors the agent may use, at most 20. Exported as a template variable.
   * @public
   */
  connectors?: ConnectorBinding[] | undefined;

  /**
   * The phases a conversation moves through, and how they are grouped. Absent means one
   * conversational phase, `answer`.
   * @public
   */
  workflow?: AgentWorkflow | undefined;

  /**
   * How answers are shaped: follow-up questions, citations and media embeds.
   * @public
   */
  answers?: AnswerSettings | undefined;

  /**
   * How the chat looks and behaves: the input placeholder and the time zone.
   * @public
   */
  conversation?: ConversationSettings | undefined;

  /**
   * Whether people may attach documents in chat, how many and which kinds.
   * @public
   */
  attachments?: AttachmentSettings | undefined;

  /**
   * The guardrail that screens documents attached in chat. Exported as a template variable.
   * @public
   */
  contentSafety?: ContentSafety | undefined;

  /**
   * When true, the answer stream tells the caller which documents were withheld from them.
   * Defaults to false.
   * @public
   */
  deniedDocuments?: boolean | undefined;

  /**
   * Whether the agent remembers people between conversations. Absent means it does not.
   * @public
   */
  memory?: MemorySettings | undefined;

  /**
   * Whether the agent speaks its answers, and in which voice. Absent means the browser's own
   * voice.
   * @public
   */
  voice?: VoiceSettings | undefined;

  /**
   * A live video avatar that speaks for the agent. Absent means none.
   * @public
   */
  liveAvatar?: LiveAvatarSettings | undefined;

  /**
   * The page people see before and while they work through a stepped workflow, such as
   * onboarding. Absent means the agent has no such page.
   * @public
   */
  journey?: JourneySettings | undefined;

  /**
   * Whose permissions the agent's unattended runs use. Exported as a template variable. Absent
   * means the agent cannot run unattended.
   * @public
   */
  runAs?: RunAs | undefined;
}

/**
 * @public
 */
export interface CreateAgentInput {
  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The agent's name, 1 to 128 characters.
   * @public
   */
  name: string;

  /**
   * What the agent is for.
   * @public
   */
  description?: string | undefined;

  /**
   * How the agent looks.
   * @public
   */
  avatar?: AgentAvatarInput | undefined;

  /**
   * The first draft's configuration, set as ReplaceDraftVersion sets one. Absent: the default
   * configuration. Exported as a template variable where its members are.
   * @public
   */
  configuration?: AgentConfiguration | undefined;
}

/**
 * @public
 */
export interface CreateAgentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The agent, as `/api/v3/agents/\{agentId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The agent's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The new agent. It is the whole response body.
   * @public
   */
  agent: Agent;
}

/**
 * @public
 */
export interface DeleteAgentInput {
  /**
   * The agent to delete.
   * @public
   */
  agentId: string;
}

/**
 * @public
 */
export interface DeleteAgentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;
}

/**
 * The members of an agent configuration, shared by the configuration a version returns and by the
 * draft's update and replace operations.
 * @public
 */
export interface ReplaceDraftVersionInput {
  /**
   * Who the agent is and how it behaves, and the text it follows at particular points in an
   * answer. Always present when read.
   * @public
   */
  guidance?: AgentGuidance | undefined;

  /**
   * The model for each job in an answer. A job left unset uses its default.
   * @public
   */
  models?: AgentModels | undefined;

  /**
   * The knowledge bases the agent searches, and how hard, at most 50, each at most once.
   * @public
   */
  knowledgeBases?: KnowledgeBaseBinding[] | undefined;

  /**
   * The policies the agent's policy reviews and checked phases use, at most 20. Exported as a
   * template variable.
   * @public
   */
  policies?: PolicyBinding[] | undefined;

  /**
   * The workspace's connectors the agent may use, at most 20. Exported as a template variable.
   * @public
   */
  connectors?: ConnectorBinding[] | undefined;

  /**
   * The phases a conversation moves through, and how they are grouped. Absent means one
   * conversational phase, `answer`.
   * @public
   */
  workflow?: AgentWorkflow | undefined;

  /**
   * How answers are shaped: follow-up questions, citations and media embeds.
   * @public
   */
  answers?: AnswerSettings | undefined;

  /**
   * How the chat looks and behaves: the input placeholder and the time zone.
   * @public
   */
  conversation?: ConversationSettings | undefined;

  /**
   * Whether people may attach documents in chat, how many and which kinds.
   * @public
   */
  attachments?: AttachmentSettings | undefined;

  /**
   * The guardrail that screens documents attached in chat. Exported as a template variable.
   * @public
   */
  contentSafety?: ContentSafety | undefined;

  /**
   * When true, the answer stream tells the caller which documents were withheld from them.
   * Defaults to false.
   * @public
   */
  deniedDocuments?: boolean | undefined;

  /**
   * Whether the agent remembers people between conversations. Absent means it does not.
   * @public
   */
  memory?: MemorySettings | undefined;

  /**
   * Whether the agent speaks its answers, and in which voice. Absent means the browser's own
   * voice.
   * @public
   */
  voice?: VoiceSettings | undefined;

  /**
   * A live video avatar that speaks for the agent. Absent means none.
   * @public
   */
  liveAvatar?: LiveAvatarSettings | undefined;

  /**
   * The page people see before and while they work through a stepped workflow, such as
   * onboarding. Absent means the agent has no such page.
   * @public
   */
  journey?: JourneySettings | undefined;

  /**
   * Whose permissions the agent's unattended runs use. Exported as a template variable. Absent
   * means the agent cannot run unattended.
   * @public
   */
  runAs?: RunAs | undefined;

  /**
   * The agent whose draft is replaced.
   * @public
   */
  agentId: string;

  /**
   * The draft's current ETag. When given, a draft that changed since is refused with 412;
   * without it, the draft is replaced as it is.
   * @public
   */
  ifMatch?: string | undefined;
}

/**
 * A named version of an agent: `draft`, `live` or a saved version. A list leaves `configuration`
 * out; read one version to get it.
 * @public
 */
export interface AgentVersion {
  /**
   * The agent the version belongs to.
   * @public
   */
  agentId: string;

  /**
   * `draft`, `live` or the version's name.
   * @public
   */
  name: string;

  /**
   * On `live`: the name of the version live points at.
   * @public
   */
  liveVersion?: string | undefined;

  /**
   * How a named version was made. Absent on the draft.
   * @public
   */
  source?: VersionSource | undefined;

  /**
   * The version this one was made from, where there is one.
   * @public
   */
  basedOn?: string | undefined;

  /**
   * True on the version live points at, and on `live` itself. Defaults to false.
   * @public
   */
  matchesLive?: boolean | undefined;

  /**
   * When the version was made; for the draft, when it was first created.
   * @public
   */
  createdAt: Date;

  /**
   * Who made the version. Absent on the draft and on versions carried over from before v3.
   * @public
   */
  createdBy?: Actor | undefined;

  /**
   * On `live`: when live was pointed at this version.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * On `live`: who pointed live at this version.
   * @public
   */
  publishedBy?: Actor | undefined;

  /**
   * The note written when the version was saved or published.
   * @public
   */
  note?: string | undefined;

  /**
   * The members that differ from the version this one was made from (`basedOn`); for the draft,
   * from live. Lists are compared by their items' keys.
   * @public
   */
  changedMembers?: string[] | undefined;

  /**
   * The version's configuration. Present on a single read and on the draft operations; absent in
   * ListAgentVersions rows and in PublishAgentVersion's `version`.
   * @public
   */
  configuration?: AgentConfiguration | undefined;

  /**
   * The version's current ETag; send it as `If-Match` to change it. On `live`, it changes whenever
   * live moves to another version.
   * @public
   */
  etag: string;
}

/**
 * @public
 */
export interface ReplaceDraftVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The draft, replaced. It is the whole response body.
   * @public
   */
  version: AgentVersion;
}

/**
 * @public
 */
export interface ResetDraftVersionInput {
  /**
   * The agent whose draft is reset.
   * @public
   */
  agentId: string;

  /**
   * The draft's current ETag. A stale value is refused with 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The version to reset the draft to: a version name, or `live`.
   * @public
   */
  from: string;
}

/**
 * @public
 */
export interface ResetDraftVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The draft, reset. It is the whole response body.
   * @public
   */
  version: AgentVersion;
}

/**
 * @public
 */
export interface SaveDraftVersionInput {
  /**
   * The agent whose draft is saved.
   * @public
   */
  agentId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The draft's ETag. When given, a draft that has changed since is refused with 412.
   * @public
   */
  ifMatch?: string | undefined;

  /**
   * The new version's name, unique within the agent, and never `draft`, `live`, `latest` or `none`. A
   * name already used is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  name: string;

  /**
   * Why it was saved, at most 2,000 characters.
   * @public
   */
  note?: string | undefined;
}

/**
 * @public
 */
export interface SaveDraftVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The new version, as `/api/v3/agents/\{agentId\}/versions/\{name\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The new saved version. It is the whole response body.
   * @public
   */
  version: AgentVersion;
}

/**
 * The members of an agent configuration, shared by the configuration a version returns and by the
 * draft's update and replace operations.
 * @public
 */
export interface UpdateDraftVersionInput {
  /**
   * Who the agent is and how it behaves, and the text it follows at particular points in an
   * answer. Always present when read.
   * @public
   */
  guidance?: AgentGuidance | undefined;

  /**
   * The model for each job in an answer. A job left unset uses its default.
   * @public
   */
  models?: AgentModels | undefined;

  /**
   * The knowledge bases the agent searches, and how hard, at most 50, each at most once.
   * @public
   */
  knowledgeBases?: KnowledgeBaseBinding[] | undefined;

  /**
   * The policies the agent's policy reviews and checked phases use, at most 20. Exported as a
   * template variable.
   * @public
   */
  policies?: PolicyBinding[] | undefined;

  /**
   * The workspace's connectors the agent may use, at most 20. Exported as a template variable.
   * @public
   */
  connectors?: ConnectorBinding[] | undefined;

  /**
   * The phases a conversation moves through, and how they are grouped. Absent means one
   * conversational phase, `answer`.
   * @public
   */
  workflow?: AgentWorkflow | undefined;

  /**
   * How answers are shaped: follow-up questions, citations and media embeds.
   * @public
   */
  answers?: AnswerSettings | undefined;

  /**
   * How the chat looks and behaves: the input placeholder and the time zone.
   * @public
   */
  conversation?: ConversationSettings | undefined;

  /**
   * Whether people may attach documents in chat, how many and which kinds.
   * @public
   */
  attachments?: AttachmentSettings | undefined;

  /**
   * The guardrail that screens documents attached in chat. Exported as a template variable.
   * @public
   */
  contentSafety?: ContentSafety | undefined;

  /**
   * When true, the answer stream tells the caller which documents were withheld from them.
   * Defaults to false.
   * @public
   */
  deniedDocuments?: boolean | undefined;

  /**
   * Whether the agent remembers people between conversations. Absent means it does not.
   * @public
   */
  memory?: MemorySettings | undefined;

  /**
   * Whether the agent speaks its answers, and in which voice. Absent means the browser's own
   * voice.
   * @public
   */
  voice?: VoiceSettings | undefined;

  /**
   * A live video avatar that speaks for the agent. Absent means none.
   * @public
   */
  liveAvatar?: LiveAvatarSettings | undefined;

  /**
   * The page people see before and while they work through a stepped workflow, such as
   * onboarding. Absent means the agent has no such page.
   * @public
   */
  journey?: JourneySettings | undefined;

  /**
   * Whose permissions the agent's unattended runs use. Exported as a template variable. Absent
   * means the agent cannot run unattended.
   * @public
   */
  runAs?: RunAs | undefined;

  /**
   * The agent whose draft is edited.
   * @public
   */
  agentId: string;

  /**
   * The draft's current ETag, from a Get or an earlier update. When given, a draft that changed
   * since is refused with 412; without it, the change applies to the draft as it is.
   * @public
   */
  ifMatch?: string | undefined;

  /**
   * Draft members to return to their default, as paths.
   * @public
   */
  clear?: ClearableDraftField[] | undefined;
}

/**
 * @public
 */
export interface UpdateDraftVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The draft, changed. It is the whole response body.
   * @public
   */
  version: AgentVersion;
}

/**
 * @public
 */
export interface GetAgentInput {
  /**
   * The agent to get.
   * @public
   */
  agentId: string;
}

/**
 * @public
 */
export interface GetAgentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The agent's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The agent as it stands now. It is the whole response body.
   * @public
   */
  agent: Agent;
}

/**
 * @public
 */
export interface GetHistoryEntryInput {
  /**
   * The agent the entry belongs to.
   * @public
   */
  agentId: string;

  /**
   * The entry to get.
   * @public
   */
  historyEntryId: string;
}

/**
 * A live history entry. A list leaves `configuration` out; read one entry to get it.
 * @public
 */
export interface HistoryEntry {
  /**
   * The identifier GetHistoryEntry takes to read this entry with its configuration.
   * @public
   */
  id: string;

  /**
   * The agent whose live version changed.
   * @public
   */
  agentId: string;

  /**
   * The version live pointed at after the change.
   * @public
   */
  version: string;

  /**
   * The version live pointed at before the change. Absent for an agent's first publish.
   * @public
   */
  previousVersion?: string | undefined;

  /**
   * What kind of change it was.
   * @public
   */
  kind: HistoryChangeKind;

  /**
   * When live changed.
   * @public
   */
  changedAt: Date;

  /**
   * Who changed it.
   * @public
   */
  changedBy: Actor;

  /**
   * The note written with the change.
   * @public
   */
  note?: string | undefined;

  /**
   * The members that differ between `previousVersion` and `version`, computed when the entry was
   * written. Lists are compared by their items' keys.
   * @public
   */
  changedMembers?: string[] | undefined;

  /**
   * The configuration of `version`. Present only when the caller may read that version, as
   * GetAgentVersion checks: the permission to read versions, and the agent grant if it is live now
   * or the agent's version access grant if it is not. Absent otherwise, in a list, and when that
   * version no longer exists.
   * @public
   */
  configuration?: AgentConfiguration | undefined;
}

/**
 * @public
 */
export interface GetHistoryEntryOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The history entry, with the configuration of the version it names. It is the whole
   * response body.
   * @public
   */
  historyEntry: HistoryEntry;
}

/**
 * @public
 */
export interface ListHistoryEntriesInput {
  /**
   * The agent whose live history to list.
   * @public
   */
  agentId: string;

  /**
   * The most entries to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * @public
 */
export interface ListHistoryEntriesOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of entries, newest first.
   * @public
   */
  items: HistoryEntry[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListAgentsInput {
  /**
   * The most agents to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * @public
 */
export interface ListAgentsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of agents.
   * @public
   */
  items: Agent[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListConversationsInput {
  /**
   * The agent whose conversations to list.
   * @public
   */
  agentId: string;

  /**
   * The most conversations to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A conversation between a caller and an agent version.
 * @public
 */
export interface Conversation {
  /**
   * The identifier every call about this conversation takes; it never changes.
   * @public
   */
  id: string;

  /**
   * The agent the conversation is with.
   * @public
   */
  agentId: string;

  /**
   * The version of the agent that answers, as it was asked for: `live`, `draft` or a version name.
   * @public
   */
  version: string;

  /**
   * The conversation's title, when it has one yet.
   * @public
   */
  title?: string | undefined;

  /**
   * Whether an answer is being written now.
   * @public
   */
  status: ConversationStatus;

  /**
   * When the conversation was created.
   * @public
   */
  createdAt: Date;

  /**
   * When the last message was written.
   * @public
   */
  updatedAt?: Date | undefined;
}

/**
 * @public
 */
export interface ListConversationsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of conversations, newest first.
   * @public
   */
  items: Conversation[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface UpdateAgentInput {
  /**
   * The agent to change.
   * @public
   */
  agentId: string;

  /**
   * The agent's current ETag. A stale value is refused with 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The agent's new name, 1 to 128 characters.
   * @public
   */
  name?: string | undefined;

  /**
   * What the agent is for.
   * @public
   */
  description?: string | undefined;

  /**
   * How the agent looks. Replaces the whole avatar.
   * @public
   */
  avatar?: AgentAvatarInput | undefined;

  /**
   * Members to remove.
   * @public
   */
  clear?: ClearableAgentField[] | undefined;
}

/**
 * @public
 */
export interface UpdateAgentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The agent's new ETag.
   * @public
   */
  etag: string;

  /**
   * The agent, changed. It is the whole response body.
   * @public
   */
  agent: Agent;
}

/**
 * @public
 */
export interface CompareAgentVersionsInput {
  /**
   * The agent whose versions are compared.
   * @public
   */
  agentId: string;

  /**
   * The version compared from: `draft`, `live` or a version name.
   * @public
   */
  version: string;

  /**
   * The version compared to: `draft`, `live` or a version name.
   * @public
   */
  withVersion: string;
}

/**
 * One member that differs between two versions.
 * @public
 */
export interface AgentVersionChange {
  /**
   * The member, as a path.
   * @public
   */
  path: string;

  /**
   * Its value in the version compared from. Absent when the other version added it.
   * @public
   */
  before?: __DocumentType | undefined;

  /**
   * Its value in the version compared to. Absent when the other version removed it.
   * @public
   */
  after?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface CompareAgentVersionsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * One change per member that differs, in path order.
   * @public
   */
  changes: AgentVersionChange[];
}

/**
 * @public
 */
export interface CreateConversationInput {
  /**
   * The agent to talk to.
   * @public
   */
  agentId: string;

  /**
   * The version of the agent that answers: `live`, `draft` or a version name.
   * @public
   */
  version: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * A title for the conversation. Absent means the app titles it from the first message.
   * @public
   */
  title?: string | undefined;
}

/**
 * @public
 */
export interface CreateConversationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The conversation, as `/api/v3/conversations/\{conversationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The new conversation. It is the whole response body.
   * @public
   */
  conversation: Conversation;
}

/**
 * @public
 */
export interface DeleteAgentVersionInput {
  /**
   * The agent whose version is deleted.
   * @public
   */
  agentId: string;

  /**
   * The version to delete: a version name.
   * @public
   */
  version: string;
}

/**
 * @public
 */
export interface DeleteAgentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;
}

/**
 * @public
 */
export interface GetAgentVersionInput {
  /**
   * The agent whose version is read.
   * @public
   */
  agentId: string;

  /**
   * `draft`, `live` or a version name.
   * @public
   */
  version: string;
}

/**
 * @public
 */
export interface GetAgentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The version as it stands now. It is the whole response body.
   * @public
   */
  version: AgentVersion;
}

/**
 * @public
 */
export interface ListAgentVersionsInput {
  /**
   * The agent whose versions to list.
   * @public
   */
  agentId: string;

  /**
   * The most versions to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * @public
 */
export interface ListAgentVersionsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of versions, oldest first.
   * @public
   */
  items: AgentVersion[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface PublishAgentVersionInput {
  /**
   * The agent whose version is published.
   * @public
   */
  agentId: string;

  /**
   * The version to publish: a version name, or `draft`.
   * @public
   */
  version: string;

  /**
   * Live's current ETag. When given and stale, the publish is refused with 412. `*` matches
   * only when live already points at a version, so a first publish that sends it is refused
   * with 412; guard a first publish with `expectedLive: none` instead.
   * @public
   */
  ifMatch?: string | undefined;

  /**
   * The version the caller expects live to point at now, or `none` before the agent's first
   * publish. When live points elsewhere, the publish is refused with 412.
   * @public
   */
  expectedLive?: string | undefined;

  /**
   * When publishing `draft`: the name of the new version the draft is kept as. Required then,
   * and refused with 400 `VALIDATION_FAILED` for any other version. A name already used by
   * this agent is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  name?: string | undefined;

  /**
   * Why it was published, recorded in the live history entry, at most 2,000 characters.
   * @public
   */
  note?: string | undefined;
}

/**
 * Which version live points at, and since when.
 * @public
 */
export interface LiveState {
  /**
   * The version live points at.
   * @public
   */
  version: string;

  /**
   * When live was pointed at it.
   * @public
   */
  publishedAt: Date;

  /**
   * Who pointed live at it.
   * @public
   */
  publishedBy: Actor;
}

/**
 * @public
 */
export interface PublishAgentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * Live's new ETag.
   * @public
   */
  etag: string;

  /**
   * Live after the publish.
   * @public
   */
  live: LiveState;

  /**
   * The version live now points at.
   * @public
   */
  version: AgentVersion;

  /**
   * The history entry the publish wrote.
   * @public
   */
  historyEntry: HistoryEntry;
}

/**
 * An upload attached to a message.
 * @public
 */
export interface AttachmentReference {
  /**
   * The upload holding the document.
   * @public
   */
  uploadId: string;
}

/**
 * One item a caller adds to a batch.
 * @public
 */
export interface IngestionItemInput {
  /**
   * What the item does to its document. Defaults to `ingest`.
   * @public
   */
  action?: IngestionItemAction | undefined;

  /**
   * The document's path: its folder and name, for example `/hr/leave-policy.pdf`. A re-upload at a
   * path is a new version of the document there.
   * @public
   */
  path?: string | undefined;

  /**
   * The caller's own key for the document. When given, it identifies the document wherever it is,
   * so a renamed file keeps its document.
   * @public
   */
  externalId?: string | undefined;

  /**
   * For described content: the base64-encoded SHA-256 of the bytes.
   * @public
   */
  sha256?: string | undefined;

  /**
   * For described content: the size of the bytes, at most 2 GB.
   * @public
   */
  byteSize?: number | undefined;

  /**
   * For described content: the media type of the bytes.
   * @public
   */
  contentType?: string | undefined;

  /**
   * For fetched content: the `http` or `https` address the server fetches the bytes from while
   * planning, at most 100 MB. Needs the files create permission, which the server checks when the
   * item is added.
   * @public
   */
  fetchUrl?: string | undefined;

  /**
   * The address a citation of the document links to. Defaults to `fetchUrl`.
   * @public
   */
  sourceUrl?: string | undefined;

  /**
   * Values for the metadata fields the knowledge base defines, checked as CreateDocument checks
   * them, and kept as sent.
   * @public
   */
  metadata?: Record<string, __DocumentType> | undefined;

  /**
   * Keys the knowledge base does not define, within the limits on ExtraMetadata.
   * @public
   */
  extraMetadata?: Record<string, __DocumentType> | undefined;
}

/**
 * @public
 */
export interface BatchCreateIngestionBatchItemsInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch to add to.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The items, at most 10,000.
   * @public
   */
  items: IngestionItemInput[];

  /**
   * True when these are the last items: the batch then stops taking items and is planned.
   * Defaults to false.
   * @public
   */
  last?: boolean | undefined;
}

/**
 * An existing document a planned item refers to.
 * @public
 */
export interface DocumentMatch {
  /**
   * The existing document the item would act on.
   * @public
   */
  documentId: string;

  /**
   * Where that document is now, which may differ from the item's path.
   * @public
   */
  path: string;

  /**
   * The document's current version number.
   * @public
   */
  version?: number | undefined;

  /**
   * The base64-encoded SHA-256 of the document's current bytes.
   * @public
   */
  sha256?: string | undefined;

  /**
   * For `changed`: the earlier version whose bytes the item's equal.
   * @public
   */
  restoresVersion?: number | undefined;
}

/**
 * An ingestion batch item.
 * @public
 */
export interface IngestionBatchItem {
  /**
   * What the item does to its document. Defaults to `ingest`.
   * @public
   */
  action?: IngestionItemAction | undefined;

  /**
   * The document's path: its folder and name, for example `/hr/leave-policy.pdf`. A re-upload at a
   * path is a new version of the document there.
   * @public
   */
  path?: string | undefined;

  /**
   * The caller's own key for the document. When given, it identifies the document wherever it is,
   * so a renamed file keeps its document.
   * @public
   */
  externalId?: string | undefined;

  /**
   * For described content: the base64-encoded SHA-256 of the bytes.
   * @public
   */
  sha256?: string | undefined;

  /**
   * For described content: the size of the bytes, at most 2 GB.
   * @public
   */
  byteSize?: number | undefined;

  /**
   * For described content: the media type of the bytes.
   * @public
   */
  contentType?: string | undefined;

  /**
   * For fetched content: the `http` or `https` address the server fetches the bytes from while
   * planning, at most 100 MB. Needs the files create permission, which the server checks when the
   * item is added.
   * @public
   */
  fetchUrl?: string | undefined;

  /**
   * The address a citation of the document links to. Defaults to `fetchUrl`.
   * @public
   */
  sourceUrl?: string | undefined;

  /**
   * Values for the metadata fields the knowledge base defines, checked as CreateDocument checks
   * them, and kept as sent.
   * @public
   */
  metadata?: Record<string, __DocumentType> | undefined;

  /**
   * Keys the knowledge base does not define, within the limits on ExtraMetadata.
   * @public
   */
  extraMetadata?: Record<string, __DocumentType> | undefined;

  /**
   * The identifier every call about this item takes, within its batch.
   * @public
   */
  id: string;

  /**
   * What the plan found. Absent until the batch is planned.
   * @public
   */
  outcome?: IngestionItemOutcome | undefined;

  /**
   * For `conflict`: why the plan could not decide. For `fetch_failed`: why the fetch failed.
   * @public
   */
  reason?: IngestionItemReason | undefined;

  /**
   * For `unchanged`: true when the supplied metadata or `sourceUrl` differ from the document's.
   * @public
   */
  metadataChanged?: boolean | undefined;

  /**
   * The existing documents the outcome refers to. Never a document the caller may not read.
   * @public
   */
  matches?: DocumentMatch[] | undefined;

  /**
   * What will be done: set by the policy, or by hand with UpdateIngestionBatchItem.
   * @public
   */
  resolution?: IngestionItemResolution | undefined;

  /**
   * Where the item is. `draft` before Start.
   * @public
   */
  status: IngestionItemStatus;

  /**
   * After Start, for an item awaiting upload: the key to upload its bytes to, under the batch's
   * upload policy.
   * @public
   */
  objectKey?: string | undefined;

  /**
   * The document the item made or changed.
   * @public
   */
  documentId?: string | undefined;

  /**
   * The document version the item made or changed.
   * @public
   */
  version?: number | undefined;

  /**
   * Why the item failed, as a stable code: for example `UPLOAD_EXPIRED` (no bytes arrived by the
   * batch's `uploadsExpireAt`), `CHECKSUM_MISMATCH`, `PERMISSION_DENIED`, for `new_version`
   * `VALIDATION_FAILED` (another file type) or `DOCUMENT_INGESTION_IN_PROGRESS`, or a document's
   * failure code. Present only when `status` is `failed`.
   * @public
   */
  failureCode?: string | undefined;

  /**
   * What went wrong, written for the integrator. Present only when `status` is `failed`.
   * @public
   */
  failureDetail?: string | undefined;

  /**
   * The item's ETag; send it as `If-Match` to resolve it.
   * @public
   */
  etag: string;
}

/**
 * The result of adding one item.
 * @public
 */
export interface ItemCreateResult {
  /**
   * The item's position in the request, from 0.
   * @public
   */
  index: number;

  /**
   * Whether the item was added.
   * @public
   */
  status: ItemCreateStatus;

  /**
   * The item, when `created`.
   * @public
   */
  item?: IngestionBatchItem | undefined;

  /**
   * Why it failed, as a stable code. Present only when `failed`.
   * @public
   */
  code?: string | undefined;

  /**
   * What went wrong, written for the integrator. Present only when `failed`.
   * @public
   */
  detail?: string | undefined;
}

/**
 * @public
 */
export interface BatchCreateIngestionBatchItemsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * One result per item, in request order.
   * @public
   */
  results: ItemCreateResult[];
}

/**
 * @public
 */
export interface BatchDeleteDocumentsInput {
  /**
   * The knowledge base the documents are in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The documents to delete: 1 to 100 identifiers, each at most once.
   * @public
   */
  documentIds: string[];
}

/**
 * The result of deleting one document in a batch.
 * @public
 */
export interface DocumentDeleteResult {
  /**
   * The document the result is for.
   * @public
   */
  documentId: string;

  /**
   * Whether the delete was accepted.
   * @public
   */
  status: DocumentDeleteStatus;

  /**
   * Why it failed, as a stable code, for example `NOT_FOUND` or `SERVICE_UNAVAILABLE`. Present only when
   * `failed`.
   * @public
   */
  code?: string | undefined;

  /**
   * What went wrong, written for the integrator. Present only when `failed`.
   * @public
   */
  detail?: string | undefined;
}

/**
 * @public
 */
export interface BatchDeleteDocumentsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * One result per identifier, in request order.
   * @public
   */
  results: DocumentDeleteResult[];
}

/**
 * @public
 */
export interface ListMessagesInput {
  /**
   * The conversation whose messages to list.
   * @public
   */
  conversationId: string;

  /**
   * The most messages to return, from 1 to 100. Defaults to 50.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A document a message carries.
 * @public
 */
export interface MessageAttachment {
  /**
   * The document's name, as it was on the sender's machine.
   * @public
   */
  name: string;

  /**
   * The document's media type.
   * @public
   */
  contentType: string;

  /**
   * The document's size in bytes.
   * @public
   */
  byteSize: number;
}

/**
 * A passage the answer cites.
 * @public
 */
export interface Citation {
  /**
   * The citation's number in the answer text, starting at 1.
   * @public
   */
  number: number;

  /**
   * The cited document.
   * @public
   */
  documentId?: string | undefined;

  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId?: string | undefined;

  /**
   * The cited document's name.
   * @public
   */
  documentName?: string | undefined;

  /**
   * The page the passage is on, starting at 1, for paged documents.
   * @public
   */
  pageNumber?: number | undefined;
}

/**
 * A message in a conversation.
 * @public
 */
export interface Message {
  /**
   * The identifier that matches the message across its events and ListMessages.
   * @public
   */
  id: string;

  /**
   * Who wrote the message.
   * @public
   */
  role: MessageRole;

  /**
   * What the message says. For an answer, the whole text the deltas built up.
   * @public
   */
  text: string;

  /**
   * The agent version that wrote an answer.
   * @public
   */
  agentVersion?: string | undefined;

  /**
   * The passages an answer cites, in citation number order.
   * @public
   */
  citations?: Citation[] | undefined;

  /**
   * The documents the message carries, in the order they were sent.
   * @public
   */
  attachments?: MessageAttachment[] | undefined;

  /**
   * When the message was written.
   * @public
   */
  createdAt: Date;
}

/**
 * @public
 */
export interface ListMessagesOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of messages, oldest first.
   * @public
   */
  items: Message[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface GetConversationInput {
  /**
   * The conversation to get.
   * @public
   */
  conversationId: string;
}

/**
 * @public
 */
export interface GetConversationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The conversation as it stands now. It is the whole response body.
   * @public
   */
  conversation: Conversation;
}

/**
 * One item of structured context, for example the page or record the person is looking at.
 * @public
 */
export interface ContextItem {
  /**
   * What kind of thing the item describes, for example `page`.
   * @public
   */
  type: string;

  /**
   * A short label the agent can refer to.
   * @public
   */
  label: string;

  /**
   * Where the item lives, when it has an address.
   * @public
   */
  uri?: string | undefined;

  /**
   * The item's data, as JSON. Counts towards the 16 KB limit.
   * @public
   */
  data?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface SendMessageInput {
  /**
   * The conversation to send to.
   * @public
   */
  conversationId: string;

  /**
   * The message, at most 32,000 characters.
   * @public
   */
  message: string;

  /**
   * Structured context for this message only, at most 20 items and 16 KB in total. Not
   * stored on the conversation.
   * @public
   */
  context?: ContextItem[] | undefined;

  /**
   * Documents the message carries. The answering agent version's `attachments.maxFiles`
   * limits the whole conversation: a message carrying more than `maxFiles` on its own is
   * refused with 400 `VALIDATION_FAILED` at `/attachments`, and an upload that would take the
   * conversation over its limit with 400 `VALIDATION_FAILED` at `/attachments/N/uploadId`.
   * Each upload must be the caller's, reserved for this conversation (CreateUpload with
   * `purpose.conversationId`), received and not yet used; otherwise the call is refused with
   * 400 `VALIDATION_FAILED` at `/attachments/N/uploadId`. Each upload is used up when the
   * message is saved.
   * @public
   */
  attachments?: AttachmentReference[] | undefined;
}

/**
 * @public
 */
export interface SendMessageOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The answer, as a stream of `ConversationEvent` events.
   * @public
   */
  events: StreamingBlobTypes;
}

/**
 * @public
 */
export interface WatchConversationInput {
  /**
   * The conversation whose answer to re-attach to.
   * @public
   */
  conversationId: string;

  /**
   * The `id` of the last event received. Absent means from the start of the answer.
   * @public
   */
  lastEventId?: string | undefined;
}

/**
 * @public
 */
export interface WatchConversationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The rest of the answer, as a stream of `ConversationEvent` events.
   * @public
   */
  events: StreamingBlobTypes;
}

/**
 * @public
 */
export interface WatchWorkspaceEventsInput {
  /**
   * The event types to receive.
   * @public
   */
  types?: string[] | undefined;

  /**
   * The conversations to receive events about.
   * @public
   */
  conversationIds?: string[] | undefined;

  /**
   * Carry on after this event. Absent means from now.
   * @public
   */
  after?: string | undefined;

  /**
   * The `id` of the last event received, sent by a reconnecting client in place of `after`.
   * @public
   */
  lastEventId?: string | undefined;
}

/**
 * @public
 */
export interface WatchWorkspaceEventsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The events, as a stream of `WorkspaceEvent` events.
   * @public
   */
  events: StreamingBlobTypes;
}

/**
 * @public
 */
export interface GetCallerInput {}

/**
 * The identifier and name of an organisation.
 * @public
 */
export interface OrganisationSummary {
  /**
   * The identifier calls about the organisation take.
   * @public
   */
  id: string;

  /**
   * What people see the organisation called.
   * @public
   */
  name: string;
}

/**
 * @public
 */
export interface GetCallerOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The person the credential acts for. Absent for an API client's own credential, which
   * acts for no person.
   * @public
   */
  userId?: string | undefined;

  /**
   * The API client the credential was issued to: an API client's own credential, or an
   * application a person signed in to with OAuth. Absent otherwise.
   * @public
   */
  apiClientId?: string | undefined;

  /**
   * The person's name, or the API client's name when no person is involved.
   * @public
   */
  displayName: string;

  /**
   * What kind of credential made the request.
   * @public
   */
  credential: CredentialKind;

  /**
   * The scopes the credential was granted, in no particular order. Empty for a browser
   * sign-in, which scopes do not limit; what the caller may do still depends on its roles.
   * @public
   */
  scopes: string[];

  /**
   * The organisation the credential belongs to.
   * @public
   */
  organisation: OrganisationSummary;
}

/**
 * The passages next to each one a search finds.
 * @public
 */
export interface NearbyPassages {
  /**
   * Whether they are returned. Defaults to false.
   * @public
   */
  enabled: boolean;

  /**
   * How many on each side, from 0 to 2. Defaults to 1.
   * @public
   */
  count?: number | undefined;
}

/**
 * Transcripts of audio and video documents.
 * @public
 */
export interface TranscriptSettings {
  /**
   * Whether a citation shows the transcript beside the player. Defaults to true.
   * @public
   */
  enabled: boolean;
}

/**
 * A knowledge base's optional features.
 * @public
 */
export interface KnowledgeBaseFeatures {
  /**
   * Whether a search also returns the passages next to each one it finds.
   * @public
   */
  nearbyPassages?: NearbyPassages | undefined;

  /**
   * Whether audio and video citations show their transcripts.
   * @public
   */
  transcripts?: TranscriptSettings | undefined;
}

/**
 * A knowledge base's default search settings.
 * @public
 */
export interface RetrievalDefaults {
  /**
   * How many passages each search retrieves, from 1 to 50.
   * @public
   */
  resultsPerSearch?: number | undefined;

  /**
   * The lowest similarity score a passage needs, from 0 to 1.
   * @public
   */
  minimumMatch?: number | undefined;

  /**
   * The lowest relevance an evaluated passage needs, from 0 to 1.
   * @public
   */
  minimumRelevance?: number | undefined;
}

/**
 * The settings a caller sets on a knowledge base, shared by its create and update.
 * @public
 */
export interface CreateKnowledgeBaseInput {
  /**
   * The knowledge base's name, 1 to 128 characters.
   * @public
   */
  name: string;

  /**
   * What the knowledge base holds, in words for the people who use it.
   * @public
   */
  description?: string | undefined;

  /**
   * What the knowledge base holds, in the words an agent reads to decide when to search it.
   * @public
   */
  agentDescription?: string | undefined;

  /**
   * The search settings an agent uses unless its binding says otherwise.
   * @public
   */
  retrieval?: RetrievalDefaults | undefined;

  /**
   * Optional search and viewing features.
   * @public
   */
  features?: KnowledgeBaseFeatures | undefined;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;
}

/**
 * How many of a knowledge base's documents need attention.
 * @public
 */
export interface DocumentCounts {
  /**
   * Documents being processed.
   * @public
   */
  processing: number;

  /**
   * Documents whose latest attempt failed.
   * @public
   */
  failed: number;

  /**
   * Documents processed in an older way than the newest, which `ReprocessDocuments` would update.
   * @public
   */
  outOfDate?: number | undefined;
}

/**
 * How a knowledge base reads and searches its documents.
 * @public
 */
export interface KnowledgeBaseEngine {
  /**
   * The model that turns passages into search vectors.
   * @public
   */
  embeddingModel: string;

  /**
   * What the embedding model reads from each passage.
   * @public
   */
  reads: EngineInput;

  /**
   * The size of each search vector.
   * @public
   */
  dimensions: number;

  /**
   * The AWS Region the model runs in, for example `ap-southeast-2`.
   * @public
   */
  region: string;

  /**
   * How passages are matched to a search. Layout-aware search is turned on with
   * EnableLayoutAwareSearch.
   * @public
   */
  searchType: SearchType;
}

/**
 * A knowledge base: documents an agent can search, with their settings.
 * @public
 */
export interface KnowledgeBase {
  /**
   * The identifier every call about this knowledge base takes.
   * @public
   */
  id: string;

  /**
   * What people see the knowledge base called in the app.
   * @public
   */
  name: string;

  /**
   * What the knowledge base holds, in words for the people who use it.
   * @public
   */
  description?: string | undefined;

  /**
   * What the knowledge base holds, in the words an agent reads to decide when to search it. Shown
   * only to callers who may change the knowledge base.
   * @public
   */
  agentDescription?: string | undefined;

  /**
   * Where the knowledge base is in its lifecycle.
   * @public
   */
  status: KnowledgeBaseStatus;

  /**
   * How many documents are processing, and how many failed, counting each document's latest
   * attempt.
   * @public
   */
  documentCounts?: DocumentCounts | undefined;

  /**
   * The search settings an agent uses unless its binding says otherwise.
   * @public
   */
  retrieval?: RetrievalDefaults | undefined;

  /**
   * Optional search and viewing features.
   * @public
   */
  features?: KnowledgeBaseFeatures | undefined;

  /**
   * How the knowledge base reads and searches its documents. Read-only, and shown only to callers
   * who may change the knowledge base.
   * @public
   */
  engine?: KnowledgeBaseEngine | undefined;

  /**
   * When the knowledge base was created.
   * @public
   */
  createdAt: Date;

  /**
   * When the knowledge base's settings last changed.
   * @public
   */
  updatedAt: Date;

  /**
   * The knowledge base's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;
}

/**
 * @public
 */
export interface CreateKnowledgeBaseOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The knowledge base, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The knowledge base's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The new knowledge base. It is the whole response body.
   * @public
   */
  knowledgeBase: KnowledgeBase;
}

/**
 * @public
 */
export interface DeleteKnowledgeBaseInput {
  /**
   * The knowledge base to delete.
   * @public
   */
  knowledgeBaseId: string;
}

/**
 * What work is expected to cost, as a range, in the form the organisation sees its costs.
 * @public
 */
export interface Cost {
  /**
   * The lowest the cost is likely to be.
   * @public
   */
  low: number;

  /**
   * The highest the cost is likely to be.
   * @public
   */
  high: number;

  /**
   * Which form `low` and `high` are in: the one the organisation sees its costs in, `usd` for
   * dollars or `percent_of_plan` for usage.
   * @public
   */
  unit: CostUnit;
}

/**
 * Why an Operation failed: a problem with a stable code.
 * @public
 */
export interface OperationError {
  /**
   * What went wrong, as a stable code.
   * @public
   */
  code: string;

  /**
   * What went wrong and what to do, written for the integrator.
   * @public
   */
  detail?: string | undefined;
}

/**
 * A range of numbers, low to high.
 * @public
 */
export interface NumberRange {
  /**
   * The low end.
   * @public
   */
  low: number;

  /**
   * The high end.
   * @public
   */
  high: number;
}

/**
 * How long is left.
 * @public
 */
export interface Eta {
  /**
   * Seconds left, as a range.
   * @public
   */
  seconds: NumberRange;
}

/**
 * An enrichment that did not complete. It never fails the document.
 * @public
 */
export interface PartialFailure {
  /**
   * The part of the document the enrichment was for, where there is one.
   * @public
   */
  targetId?: string | undefined;

  /**
   * What went wrong, as a stable code.
   * @public
   */
  code: string;

  /**
   * What went wrong, written for the integrator.
   * @public
   */
  detail?: string | undefined;
}

/**
 * How far an Operation's work has got.
 * @public
 */
export interface OperationProgress {
  /**
   * Units of work done.
   * @public
   */
  completed: number;

  /**
   * Units of work in all, when known.
   * @public
   */
  total?: number | undefined;

  /**
   * Units of work that failed.
   * @public
   */
  failed?: number | undefined;

  /**
   * What `completed`, `failed` and `total` count.
   * @public
   */
  unit: ProgressUnit;
}

/**
 * What an Operation's work is on.
 * @public
 */
export interface OperationTarget {
  /**
   * What kind of thing `id` names.
   * @public
   */
  type: OperationTargetType;

  /**
   * The thing's identifier.
   * @public
   */
  id: string;

  /**
   * The knowledge base it is in, for a document or folder.
   * @public
   */
  knowledgeBaseId?: string | undefined;
}

/**
 * Background work that continues after the request that started it: a job, as the building blocks
 * see it. Read it, wait on it or watch it; never start the work again to find out how it went. An
 * Operation is kept for at least 7 days after it ends.
 * @public
 */
export interface Operation {
  /**
   * The identifier GetOperation, WatchOperation and CancelOperation take.
   * @public
   */
  id: string;

  /**
   * What kind of work it is.
   * @public
   */
  kind: OperationKind;

  /**
   * Where the work is.
   * @public
   */
  status: OperationStatus;

  /**
   * What the work is on.
   * @public
   */
  target?: OperationTarget | undefined;

  /**
   * How far the work has got, where it can say.
   * @public
   */
  progress?: OperationProgress | undefined;

  /**
   * How far the work has got, from 0 to 100, weighted by how long each part takes; never moves
   * back.
   * @public
   */
  percent?: number | undefined;

  /**
   * How long is left, once the work has run long enough to say.
   * @public
   */
  eta?: Eta | undefined;

  /**
   * What the work has cost so far. Present only for callers who may see cost.
   * @public
   */
  costSoFar?: Cost | undefined;

  /**
   * When the work was requested.
   * @public
   */
  createdAt: Date;

  /**
   * When the work started.
   * @public
   */
  startedAt?: Date | undefined;

  /**
   * When the Operation last changed.
   * @public
   */
  updatedAt?: Date | undefined;

  /**
   * When the work ended. Present once `status` is final.
   * @public
   */
  endedAt?: Date | undefined;

  /**
   * Who asked for the work.
   * @public
   */
  createdBy?: Actor | undefined;

  /**
   * Why the work failed. Present only when `status` is `failed`.
   * @public
   */
  error?: OperationError | undefined;

  /**
   * Parts of the work that did not complete, at most the first 100. They never fail the whole.
   * @public
   */
  partialFailures?: PartialFailure[] | undefined;
}

/**
 * @public
 */
export interface DeleteKnowledgeBaseOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The Operation that tracks the deletion.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface CancelDocumentProcessingInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document whose work to stop.
   * @public
   */
  documentId: string;
}

/**
 * Why a document failed, as a stable code and a message telling the caller what to do.
 * @public
 */
export interface DocumentFailure {
  /**
   * What went wrong.
   * @public
   */
  code: DocumentFailureCode;

  /**
   * What went wrong and what to do, written for the integrator. The same for every document
   * with the same code.
   * @public
   */
  message: string;
}

/**
 * The newest version of a document, when it is not the current one.
 * @public
 */
export interface LatestVersion {
  /**
   * The version's number.
   * @public
   */
  number: number;

  /**
   * Where it is in its lifecycle.
   * @public
   */
  status: DocumentStatus;

  /**
   * While `processing`, what the server is doing, for display only.
   * @public
   */
  stage?: string | undefined;

  /**
   * Why it failed. Present only when `status` is `failed`.
   * @public
   */
  failure?: DocumentFailure | undefined;

  /**
   * When it was added.
   * @public
   */
  createdAt: Date;
}

/**
 * What the work on a document was expected to take and cost.
 * @public
 */
export interface ProcessingEstimate {
  /**
   * How long it was expected to take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What it was expected to cost. Absent for callers who may not see cost.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * True once refined from what ingestion measured of this document.
   * @public
   */
  refined: boolean;
}

/**
 * The work running on one document.
 * @public
 */
export interface DocumentProcessing {
  /**
   * What the work running on the document is doing.
   * @public
   */
  kind: ProcessingKind;

  /**
   * The stage the work is at, for display. Open: stages are added as ingestion changes.
   * @public
   */
  stage?: ProcessingStep | undefined;

  /**
   * How far the work has got, from 0 to 100, as the server weights it by how long each stage takes:
   * never moving back, and 100 only once the document can be searched. Clients show this figure,
   * easing between reports, and never compute their own.
   * @public
   */
  percent: number;

  /**
   * How long is left, once the work has run long enough to say.
   * @public
   */
  eta?: Eta | undefined;

  /**
   * What the work was expected to take and cost: first from the file, then refined from what
   * ingestion measured.
   * @public
   */
  estimate?: ProcessingEstimate | undefined;

  /**
   * When the work started.
   * @public
   */
  startedAt: Date;

  /**
   * When the progress last changed.
   * @public
   */
  updatedAt: Date;
}

/**
 * One document in a knowledge base, stable across new uploads of new bytes.
 * @public
 */
export interface Document {
  /**
   * The identifier every call about this document takes; it stays the same across new versions.
   * @public
   */
  id: string;

  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document's name, as people see it.
   * @public
   */
  name: string;

  /**
   * The folder the document is in.
   * @public
   */
  folder: string;

  /**
   * Where the current version is in its lifecycle.
   * @public
   */
  status: DocumentStatus;

  /**
   * While `processing`, what the server is doing, for display only.
   * @public
   */
  stage?: string | undefined;

  /**
   * The media type of the current bytes.
   * @public
   */
  contentType?: string | undefined;

  /**
   * The size of the current bytes, in bytes.
   * @public
   */
  byteSize?: number | undefined;

  /**
   * The base64-encoded SHA-256 of the current bytes.
   * @public
   */
  sha256?: string | undefined;

  /**
   * The current version's number. Absent until the first version is indexed.
   * @public
   */
  version?: number | undefined;

  /**
   * How many versions the document has.
   * @public
   */
  versionCount?: number | undefined;

  /**
   * The newest version, when it is not the current one: uploading, processing or failed. Shown only
   * to callers who may add versions.
   * @public
   */
  latestVersion?: LatestVersion | undefined;

  /**
   * True when a newer version than the current one exists. Shown only to callers who may add
   * versions.
   * @public
   */
  superseded?: boolean | undefined;

  /**
   * The address a citation of this document links to.
   * @public
   */
  sourceUrl?: string | undefined;

  /**
   * The caller's own key for the document, unique within the knowledge base.
   * @public
   */
  externalId?: string | undefined;

  /**
   * Values for the metadata fields the knowledge base defines, including `title`, `summary`,
   * `keywords`, `author` and `publishedDate`.
   * @public
   */
  metadata?: Record<string, __DocumentType> | undefined;

  /**
   * Keys the knowledge base does not define. Stored and returned, but never searched on or given to
   * an agent.
   * @public
   */
  extraMetadata?: Record<string, __DocumentType> | undefined;

  /**
   * Who may read the document.
   * @public
   */
  readers?: Readers | undefined;

  /**
   * When `readers` is `inherit`: the folder whose readers apply.
   * @public
   */
  inheritedFrom?: string | undefined;

  /**
   * True when a newer way of processing documents is available, and processing the document again
   * would use it.
   * @public
   */
  outOfDate?: boolean | undefined;

  /**
   * The number of pages, for a paged document.
   * @public
   */
  pageCount?: number | undefined;

  /**
   * How long it plays, in seconds, for audio and video.
   * @public
   */
  durationSeconds?: number | undefined;

  /**
   * The work running on the document, while there is some: what kind, which stage, how far it has
   * got and how long is left. Absent when nothing is running.
   * @public
   */
  processing?: DocumentProcessing | undefined;

  /**
   * When the document was created.
   * @public
   */
  createdAt: Date;

  /**
   * When the document or its bytes last changed.
   * @public
   */
  updatedAt: Date;

  /**
   * Enrichments that did not complete (a picture description, metadata extraction, a table).
   * They never fail the document. At most the first 100.
   * @public
   */
  partialFailures?: PartialFailure[] | undefined;

  /**
   * Why the document could not be made searchable. Present only when `status` is `failed`; a
   * document that is searchable with gaps lists them in `partialFailures` instead.
   * @public
   */
  failure?: DocumentFailure | undefined;

  /**
   * The document's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;
}

/**
 * @public
 */
export interface CancelDocumentProcessingOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document's ETag.
   * @public
   */
  etag: string;

  /**
   * The document as it stands after the request. It is the whole response body.
   * @public
   */
  document: Document;
}

/**
 * The document settings a caller sets, shared by CreateDocument and UpdateDocument.
 * @public
 */
export interface CreateDocumentInput {
  /**
   * The address a citation of this document links to: `https`, at most 2,048 characters. Changing
   * it needs no processing.
   * @public
   */
  sourceUrl?: string | undefined;

  /**
   * The caller's own key for the document, unique within the knowledge base. A key another document
   * has is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  externalId?: string | undefined;

  /**
   * Values for the metadata fields the knowledge base defines. Each value is checked against its
   * field's definition and the whole request is refused with 422 when any is wrong:
   * `METADATA_FIELD_UNDEFINED`, `METADATA_VALUE_INVALID` or `METADATA_FIELD_PASSAGE_SCOPED`, each
   * with a JSON pointer. A value set here is kept as sent: processing never replaces it.
   * @public
   */
  metadata?: Record<string, __DocumentType> | undefined;

  /**
   * Keys the knowledge base does not define, within the limits on ExtraMetadata; breaking one is
   * refused with 422 `METADATA_LIMIT_EXCEEDED`.
   * @public
   */
  extraMetadata?: Record<string, __DocumentType> | undefined;

  /**
   * The knowledge base to add the document to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The upload holding the document's bytes. Each upload can be used once. Refused with 400
   * `VALIDATION_FAILED` when the bytes are not the file type the document's name says.
   * @public
   */
  uploadId: string;

  /**
   * The folder to put the document in.
   * @public
   */
  folder: string;

  /**
   * What the document is called in the knowledge base and in citations. Absent means the
   * uploaded file's name. A name without an extension is given the one the upload's content
   * type maps to, because ingestion reads the file type from it. Refused with 400
   * `VALIDATION_FAILED` when the type maps to no extension, or when the extension is one a
   * knowledge base cannot ingest.
   * @public
   */
  name?: string | undefined;
}

/**
 * @public
 */
export interface CreateDocumentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/documents/\{documentId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The document's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The document in its initial state.
   * @public
   */
  document: Document;

  /**
   * The Operation that tracks ingestion.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface CreateDocumentVersionInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to add a version to.
   * @public
   */
  documentId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The document's ETag. When given, a document that has changed since is refused with 412.
   * @public
   */
  ifMatch?: string | undefined;

  /**
   * The upload holding the new bytes. Each upload can be used once.
   * @public
   */
  uploadId: string;

  /**
   * Why the version was added, at most 2,000 characters.
   * @public
   */
  note?: string | undefined;
}

/**
 * One version of a document's bytes.
 * @public
 */
export interface DocumentVersion {
  /**
   * The version's number: `1` is the first.
   * @public
   */
  number: number;

  /**
   * The document the version belongs to.
   * @public
   */
  documentId: string;

  /**
   * Where the version is in its lifecycle.
   * @public
   */
  status: DocumentStatus;

  /**
   * While `processing`, what the server is doing, for display only.
   * @public
   */
  stage?: string | undefined;

  /**
   * The media type of the version's bytes.
   * @public
   */
  contentType?: string | undefined;

  /**
   * The size of the version's bytes, in bytes.
   * @public
   */
  byteSize?: number | undefined;

  /**
   * The base64-encoded SHA-256 of the version's bytes.
   * @public
   */
  sha256?: string | undefined;

  /**
   * True when this is the version search uses.
   * @public
   */
  current: boolean;

  /**
   * True when this is the newest version.
   * @public
   */
  latest: boolean;

  /**
   * The note written when the version was added.
   * @public
   */
  note?: string | undefined;

  /**
   * Why the version failed. Present only when `status` is `failed`.
   * @public
   */
  failure?: DocumentFailure | undefined;

  /**
   * When the version was added.
   * @public
   */
  createdAt: Date;
}

/**
 * @public
 */
export interface CreateDocumentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/documents/\{documentId\}/versions/\{number\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * What adding the version did, given how its bytes compare with the document's versions.
   * @public
   */
  result: VersionResult;

  /**
   * The version that was made, matched or restored.
   * @public
   */
  version: DocumentVersion;

  /**
   * The Operation that tracks ingestion. Absent when `result` is `unchanged`.
   * @public
   */
  operation?: Operation | undefined;
}

/**
 * @public
 */
export interface DeleteDocumentInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to delete.
   * @public
   */
  documentId: string;
}

/**
 * @public
 */
export interface DeleteDocumentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document's ETag.
   * @public
   */
  etag: string;

  /**
   * The document, now `deleting`. It is the whole response body.
   * @public
   */
  document: Document;
}

/**
 * @public
 */
export interface DeleteDocumentVersionInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document whose version is deleted.
   * @public
   */
  documentId: string;

  /**
   * The version to delete: its number, or `current` or `latest` as GetDocumentVersion takes them.
   * The current version itself is refused, as above.
   * @public
   */
  version: string;
}

/**
 * @public
 */
export interface DeleteDocumentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;
}

/**
 * @public
 */
export interface GetDocumentVersionInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document whose version is read.
   * @public
   */
  documentId: string;

  /**
   * The version: a number, `current` or `latest`.
   * @public
   */
  version: string;
}

/**
 * @public
 */
export interface GetDocumentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The version as it stands now. It is the whole response body.
   * @public
   */
  version: DocumentVersion;
}

/**
 * @public
 */
export interface ListDocumentVersionsInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document whose versions to list.
   * @public
   */
  documentId: string;

  /**
   * The most versions to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * @public
 */
export interface ListDocumentVersionsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of versions, newest first.
   * @public
   */
  items: DocumentVersion[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * What a client read of a file before uploading it.
 * @public
 */
export interface IngestionHints {
  /**
   * Pages, for a paged document.
   * @public
   */
  pages?: number | undefined;

  /**
   * Pages with a text layer.
   * @public
   */
  textPages?: number | undefined;

  /**
   * Pages that are mostly graphics.
   * @public
   */
  graphicPages?: number | undefined;

  /**
   * Pages with no text layer, read from the image.
   * @public
   */
  scannedPages?: number | undefined;

  /**
   * Pictures to describe.
   * @public
   */
  pictures?: number | undefined;

  /**
   * Seconds of audio or video.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Characters, for a Markdown or Word document.
   * @public
   */
  characters?: number | undefined;
}

/**
 * A file described for an estimate, before it is uploaded.
 * @public
 */
export interface UploadDescription {
  /**
   * The name the file will be uploaded with.
   * @public
   */
  name: string;

  /**
   * The file's media type.
   * @public
   */
  contentType: string;

  /**
   * The file's size in bytes.
   * @public
   */
  byteSize: number;

  /**
   * What the SDK could read of the file cheaply, which makes the estimate closer.
   * @public
   */
  hints?: IngestionHints | undefined;
}

/**
 * @public
 */
export interface EstimateDocumentVersionInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document whose file would be replaced.
   * @public
   */
  documentId: string;

  /**
   * The new file, described.
   * @public
   */
  file: UploadDescription;

  /**
   * The note the new version would carry. It does not change the estimate.
   * @public
   */
  note?: string | undefined;
}

/**
 * @public
 */
export interface EstimateDocumentVersionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The documents the job would work on.
   * @public
   */
  documents: number;

  /**
   * The pages in them, where known.
   * @public
   */
  pages?: number | undefined;

  /**
   * The seconds of audio and video in them, where known.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Documents whose length could not be told, priced as a typical file.
   * @public
   */
  documentsOfUnknownLength?: number | undefined;

  /**
   * How long the job would take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What the job would cost. Present only for callers who may see cost: those who may open the
   * knowledge base's settings. Every other caller still gets the documents, pages and time.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * What is particular to the job, for example a fill-in's passages to read, or the improvements
   * reprocessing would bring.
   * @public
   */
  details?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface EstimateReprocessDocumentsInput {
  /**
   * The knowledge base whose documents would be processed again.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * True for every document processed in an older way than the newest.
   * @public
   */
  outOfDate?: boolean | undefined;

  /**
   * Particular documents, 1 to 100.
   * @public
   */
  documentIds?: string[] | undefined;
}

/**
 * @public
 */
export interface EstimateReprocessDocumentsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The documents the job would work on.
   * @public
   */
  documents: number;

  /**
   * The pages in them, where known.
   * @public
   */
  pages?: number | undefined;

  /**
   * The seconds of audio and video in them, where known.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Documents whose length could not be told, priced as a typical file.
   * @public
   */
  documentsOfUnknownLength?: number | undefined;

  /**
   * How long the job would take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What the job would cost. Present only for callers who may see cost: those who may open the
   * knowledge base's settings. Every other caller still gets the documents, pages and time.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * What is particular to the job, for example a fill-in's passages to read, or the improvements
   * reprocessing would bring.
   * @public
   */
  details?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface GetDocumentInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to get.
   * @public
   */
  documentId: string;
}

/**
 * @public
 */
export interface GetDocumentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The document as it stands now. It is the whole response body.
   * @public
   */
  document: Document;
}

/**
 * @public
 */
export interface GetDocumentContentInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to download.
   * @public
   */
  documentId: string;

  /**
   * The version to download: a number, `current` (the default) or `latest`.
   * @public
   */
  version?: string | undefined;
}

/**
 * @public
 */
export interface GetDocumentContentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The address of the bytes, which the client follows.
   * @public
   */
  location: string;

  /**
   * The same address, for a client that does not follow redirects.
   * @public
   */
  url: string;

  /**
   * When the address stops working.
   * @public
   */
  expiresAt: Date;
}

/**
 * @public
 */
export interface GetDocumentDownloadInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to download.
   * @public
   */
  documentId: string;

  /**
   * The version to download: a number, `current` (the default) or `latest`.
   * @public
   */
  version?: string | undefined;
}

/**
 * @public
 */
export interface GetDocumentDownloadOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The address of the bytes. It needs no credential.
   * @public
   */
  url: string;

  /**
   * When the address stops working.
   * @public
   */
  expiresAt: Date;
}

/**
 * @public
 */
export interface ListDocumentsInput {
  /**
   * The knowledge base to list.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The most documents to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * The order: `name`, `updatedAt` or `byteSize`, comma-separated, with a leading `-` for
   * descending (for example `-updatedAt`). Any other field is refused with 400 `UNKNOWN_SORT`.
   * @public
   */
  sort?: string | undefined;

  /**
   * Only documents directly in this folder, or below it with `deep`.
   * @public
   */
  folder?: string | undefined;

  /**
   * When true, with `filter[folder][eq]`, every document below the folder, not only those
   * directly in it. Defaults to false.
   * @public
   */
  deep?: boolean | undefined;

  /**
   * Only documents whose name contains this text, ignoring case.
   * @public
   */
  q?: string | undefined;

  /**
   * Only documents with this status.
   * @public
   */
  status?: DocumentStatus | undefined;

  /**
   * Only documents whose name starts with this text.
   * @public
   */
  namePrefix?: string | undefined;

  /**
   * Only the document with this `externalId`.
   * @public
   */
  externalId?: string | undefined;

  /**
   * Only documents whose media type starts with this text, for example `audio/`.
   * @public
   */
  contentTypePrefix?: string | undefined;

  /**
   * Only documents whose current bytes have this base64-encoded SHA-256.
   * @public
   */
  sha256?: string | undefined;

  /**
   * Only documents that are (`true`) or are not (`false`) processed in an older way than the
   * newest.
   * @public
   */
  outOfDate?: boolean | undefined;
}

/**
 * @public
 */
export interface ListDocumentsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of documents.
   * @public
   */
  items: Document[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ReprocessDocumentsInput {
  /**
   * The knowledge base whose documents are processed again.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * True for every document processed in an older way than the newest. Exactly one of
   * `outOfDate` and `documentIds`.
   * @public
   */
  outOfDate?: boolean | undefined;

  /**
   * Particular documents, 1 to 100.
   * @public
   */
  documentIds?: string[] | undefined;
}

/**
 * Work running on a knowledge base: ingesting documents, filling in fields, reprocessing, layout-aware
 * search, a folder change or an access change. The building blocks call it an Operation. Each reports
 * on the knowledge base's watch: ingests and fill-ins through the ingestion progress feed, and
 * layout-aware search from its own record.
 *
 * Deleting the thing a job works on stops the job, which ends `cancelled`.
 * @public
 */
export interface Job {
  /**
   * The identifier GetOperation, WatchOperation and CancelOperation take.
   * @public
   */
  id: string;

  /**
   * What kind of work it is.
   * @public
   */
  kind: OperationKind;

  /**
   * Where the work is.
   * @public
   */
  status: OperationStatus;

  /**
   * What the work is on.
   * @public
   */
  target?: OperationTarget | undefined;

  /**
   * How far the work has got, where it can say.
   * @public
   */
  progress?: OperationProgress | undefined;

  /**
   * How far the work has got, from 0 to 100, weighted by how long each part takes; never moves
   * back.
   * @public
   */
  percent?: number | undefined;

  /**
   * How long is left, once the work has run long enough to say.
   * @public
   */
  eta?: Eta | undefined;

  /**
   * What the work has cost so far. Present only for callers who may see cost.
   * @public
   */
  costSoFar?: Cost | undefined;

  /**
   * When the work was requested.
   * @public
   */
  createdAt: Date;

  /**
   * When the work started.
   * @public
   */
  startedAt?: Date | undefined;

  /**
   * When the Operation last changed.
   * @public
   */
  updatedAt?: Date | undefined;

  /**
   * When the work ended. Present once `status` is final.
   * @public
   */
  endedAt?: Date | undefined;

  /**
   * Who asked for the work.
   * @public
   */
  createdBy?: Actor | undefined;

  /**
   * Why the work failed. Present only when `status` is `failed`.
   * @public
   */
  error?: OperationError | undefined;

  /**
   * Parts of the work that did not complete, at most the first 100. They never fail the whole.
   * @public
   */
  partialFailures?: PartialFailure[] | undefined;
}

/**
 * @public
 */
export interface ReprocessDocumentsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The job that processes them.
   * @public
   */
  job: Job;
}

/**
 * @public
 */
export interface RetryDocumentInput {
  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to process again.
   * @public
   */
  documentId: string;
}

/**
 * @public
 */
export interface RetryDocumentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document's new ETag.
   * @public
   */
  etag: string;

  /**
   * The document in its new state.
   * @public
   */
  document: Document;

  /**
   * The Operation that tracks ingestion.
   * @public
   */
  operation: Operation;
}

/**
 * The document settings a caller sets, shared by CreateDocument and UpdateDocument.
 * @public
 */
export interface UpdateDocumentInput {
  /**
   * The address a citation of this document links to: `https`, at most 2,048 characters. Changing
   * it needs no processing.
   * @public
   */
  sourceUrl?: string | undefined;

  /**
   * The caller's own key for the document, unique within the knowledge base. A key another document
   * has is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  externalId?: string | undefined;

  /**
   * Values for the metadata fields the knowledge base defines. Each value is checked against its
   * field's definition and the whole request is refused with 422 when any is wrong:
   * `METADATA_FIELD_UNDEFINED`, `METADATA_VALUE_INVALID` or `METADATA_FIELD_PASSAGE_SCOPED`, each
   * with a JSON pointer. A value set here is kept as sent: processing never replaces it.
   * @public
   */
  metadata?: Record<string, __DocumentType> | undefined;

  /**
   * Keys the knowledge base does not define, within the limits on ExtraMetadata; breaking one is
   * refused with 422 `METADATA_LIMIT_EXCEEDED`.
   * @public
   */
  extraMetadata?: Record<string, __DocumentType> | undefined;

  /**
   * The knowledge base the document is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The document to change.
   * @public
   */
  documentId: string;

  /**
   * The document's current ETag. A stale value is refused with 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The document's new name.
   * @public
   */
  name?: string | undefined;

  /**
   * The folder to move the document to. It keeps its identifier, versions and history.
   * @public
   */
  folder?: string | undefined;

  /**
   * Members to return to their default. Also takes `metadata.<key>` and `extraMetadata.<key>`
   * to remove one key.
   * @public
   */
  clear?: ClearableDocumentField[] | undefined;
}

/**
 * @public
 */
export interface UpdateDocumentOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The document's new ETag.
   * @public
   */
  etag: string;

  /**
   * The document as it now reads.
   * @public
   */
  document: Document;

  /**
   * The Operation that applies the change to search, when it needs processing.
   * @public
   */
  operation?: Operation | undefined;
}

/**
 * @public
 */
export interface EnableLayoutAwareSearchInput {
  /**
   * The knowledge base to switch.
   * @public
   */
  knowledgeBaseId: string;
}

/**
 * @public
 */
export interface EnableLayoutAwareSearchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The Operation that rebuilds the knowledge base's search vectors.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface EstimateIngestionInput {
  /**
   * The knowledge base the files would go into.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The documents to add, each described as its file, 1 to 10,000.
   * @public
   */
  documents: UploadDescription[];
}

/**
 * @public
 */
export interface EstimateIngestionOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The documents the job would work on.
   * @public
   */
  documents: number;

  /**
   * The pages in them, where known.
   * @public
   */
  pages?: number | undefined;

  /**
   * The seconds of audio and video in them, where known.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Documents whose length could not be told, priced as a typical file.
   * @public
   */
  documentsOfUnknownLength?: number | undefined;

  /**
   * How long the job would take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What the job would cost. Present only for callers who may see cost: those who may open the
   * knowledge base's settings. Every other caller still gets the documents, pages and time.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * What is particular to the job, for example a fill-in's passages to read, or the improvements
   * reprocessing would bring.
   * @public
   */
  details?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface EstimateLayoutAwareSearchInput {
  /**
   * The knowledge base to estimate for.
   * @public
   */
  knowledgeBaseId: string;
}

/**
 * @public
 */
export interface EstimateLayoutAwareSearchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The documents the job would work on.
   * @public
   */
  documents: number;

  /**
   * The pages in them, where known.
   * @public
   */
  pages?: number | undefined;

  /**
   * The seconds of audio and video in them, where known.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Documents whose length could not be told, priced as a typical file.
   * @public
   */
  documentsOfUnknownLength?: number | undefined;

  /**
   * How long the job would take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What the job would cost. Present only for callers who may see cost: those who may open the
   * knowledge base's settings. Every other caller still gets the documents, pages and time.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * What is particular to the job, for example a fill-in's passages to read, or the improvements
   * reprocessing would bring.
   * @public
   */
  details?: __DocumentType | undefined;
}

/**
 * One choice of a list field.
 * @public
 */
export interface MetadataChoice {
  /**
   * The stored value.
   * @public
   */
  key: string;

  /**
   * What people see.
   * @public
   */
  value: string;
}

/**
 * How a metadata field is filled and used.
 * @public
 */
export interface FieldInstructions {
  /**
   * How ingestion works out the field's value from a document.
   * @public
   */
  howToFill?: string | undefined;

  /**
   * How an agent should use the value when it reads it.
   * @public
   */
  whenToUse?: string | undefined;
}

/**
 * The settings of a metadata field, shared by its create, update and reads.
 * @public
 */
export interface CreateFieldInput {
  /**
   * The field's name, as people see it.
   * @public
   */
  name: string;

  /**
   * What the field holds, for people.
   * @public
   */
  description?: string | undefined;

  /**
   * How the field's values are entered and checked; a list field offers its `choices`.
   * @public
   */
  type: FieldType;

  /**
   * Where the field's values belong. Defaults to `document`. A value that belongs to each
   * passage cannot be set on a document.
   * @public
   */
  scope?: FieldLevel | undefined;

  /**
   * For `list`: the values it may take.
   * @public
   */
  choices?: MetadataChoice[] | undefined;

  /**
   * For a `date` field: what is stored when a document gives only a month or a year. Defaults to
   * `start`.
   * @public
   */
  partialDates?: PartialDates | undefined;

  /**
   * How ingestion fills the field, and how an agent uses it.
   * @public
   */
  instructions?: FieldInstructions | undefined;

  /**
   * Whether searches can filter on the field. Defaults to false.
   * @public
   */
  filterable?: boolean | undefined;

  /**
   * Whether the field's value is given to the agent with each passage. Defaults to false.
   * @public
   */
  givenToAgent?: boolean | undefined;

  /**
   * Whether the field is shown in a document's settings. Defaults to true.
   * @public
   */
  visibleOnDocuments?: boolean | undefined;

  /**
   * The knowledge base the field is added to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The field's key, as documents' `metadata` will name it: letters, digits and `_`, starting
   * with a letter.
   * @public
   */
  key: string;
}

/**
 * How many documents still need work for one field.
 * @public
 */
export interface FieldWork {
  /**
   * Documents with no value yet, which a fill-in would fill.
   * @public
   */
  values: number;

  /**
   * Documents whose value is not yet written to the search index.
   * @public
   */
  index: number;

  /**
   * Documents whose passages need new search vectors for the field.
   * @public
   */
  embed: number;

  /**
   * Documents needing any of these.
   * @public
   */
  documents: number;
}

/**
 * A metadata field: a value each document in the knowledge base can carry.
 * @public
 */
export interface Field {
  /**
   * The field's name, as people see it.
   * @public
   */
  name: string;

  /**
   * What the field holds, for people.
   * @public
   */
  description?: string | undefined;

  /**
   * How the field's values are entered and checked; a list field offers its `choices`.
   * @public
   */
  type: FieldType;

  /**
   * Where the field's values belong. Defaults to `document`. A value that belongs to each
   * passage cannot be set on a document.
   * @public
   */
  scope?: FieldLevel | undefined;

  /**
   * For `list`: the values it may take.
   * @public
   */
  choices?: MetadataChoice[] | undefined;

  /**
   * For a `date` field: what is stored when a document gives only a month or a year. Defaults to
   * `start`.
   * @public
   */
  partialDates?: PartialDates | undefined;

  /**
   * How ingestion fills the field, and how an agent uses it.
   * @public
   */
  instructions?: FieldInstructions | undefined;

  /**
   * Whether searches can filter on the field. Defaults to false.
   * @public
   */
  filterable?: boolean | undefined;

  /**
   * Whether the field's value is given to the agent with each passage. Defaults to false.
   * @public
   */
  givenToAgent?: boolean | undefined;

  /**
   * Whether the field is shown in a document's settings. Defaults to true.
   * @public
   */
  visibleOnDocuments?: boolean | undefined;

  /**
   * The field's key, as documents' `metadata` names it.
   * @public
   */
  key: string;

  /**
   * How many documents still need work for this field: values to fill in, index writes and new
   * search vectors.
   * @public
   */
  needsWork?: FieldWork | undefined;

  /**
   * The field's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;
}

/**
 * @public
 */
export interface CreateFieldOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The field, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/fields/\{key\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The field's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The new field. It is the whole response body.
   * @public
   */
  field: Field;
}

/**
 * @public
 */
export interface DeleteFieldInput {
  /**
   * The knowledge base the field is removed from.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Which field to delete, by the key documents store its values under.
   * @public
   */
  fieldKey: string;
}

/**
 * @public
 */
export interface DeleteFieldOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;
}

/**
 * @public
 */
export interface EstimateFillInFieldsInput {
  /**
   * The knowledge base whose fields would be filled in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The fields to fill in.
   * @public
   */
  keys: string[];
}

/**
 * @public
 */
export interface EstimateFillInFieldsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The documents the job would work on.
   * @public
   */
  documents: number;

  /**
   * The pages in them, where known.
   * @public
   */
  pages?: number | undefined;

  /**
   * The seconds of audio and video in them, where known.
   * @public
   */
  mediaSeconds?: number | undefined;

  /**
   * Documents whose length could not be told, priced as a typical file.
   * @public
   */
  documentsOfUnknownLength?: number | undefined;

  /**
   * How long the job would take, in seconds.
   * @public
   */
  durationSeconds: NumberRange;

  /**
   * What the job would cost. Present only for callers who may see cost: those who may open the
   * knowledge base's settings. Every other caller still gets the documents, pages and time.
   * @public
   */
  cost?: Cost | undefined;

  /**
   * What is particular to the job, for example a fill-in's passages to read, or the improvements
   * reprocessing would bring.
   * @public
   */
  details?: __DocumentType | undefined;
}

/**
 * @public
 */
export interface FillInFieldsInput {
  /**
   * The knowledge base whose fields are filled in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The fields to fill in.
   * @public
   */
  keys: string[];
}

/**
 * @public
 */
export interface FillInFieldsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The job that fills them in.
   * @public
   */
  job: Job;
}

/**
 * @public
 */
export interface GetFieldInput {
  /**
   * The knowledge base the field belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Which field to read, by the key documents store its values under.
   * @public
   */
  fieldKey: string;
}

/**
 * @public
 */
export interface GetFieldOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The field's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The field as it stands now. It is the whole response body.
   * @public
   */
  field: Field;
}

/**
 * @public
 */
export interface ListFieldsInput {
  /**
   * The knowledge base whose fields are listed.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The most fields to return, from 1 to 100. Defaults to 100.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * @public
 */
export interface ListFieldsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of fields.
   * @public
   */
  items: Field[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * The settings of a metadata field, shared by its create, update and reads.
 * @public
 */
export interface UpdateFieldInput {
  /**
   * The field's name, as people see it.
   * @public
   */
  name?: string | undefined;

  /**
   * What the field holds, for people.
   * @public
   */
  description?: string | undefined;

  /**
   * How the field's values are entered and checked; a list field offers its `choices`.
   * @public
   */
  type?: FieldType | undefined;

  /**
   * Where the field's values belong. Defaults to `document`. A value that belongs to each
   * passage cannot be set on a document.
   * @public
   */
  scope?: FieldLevel | undefined;

  /**
   * For `list`: the values it may take.
   * @public
   */
  choices?: MetadataChoice[] | undefined;

  /**
   * For a `date` field: what is stored when a document gives only a month or a year. Defaults to
   * `start`.
   * @public
   */
  partialDates?: PartialDates | undefined;

  /**
   * How ingestion fills the field, and how an agent uses it.
   * @public
   */
  instructions?: FieldInstructions | undefined;

  /**
   * Whether searches can filter on the field. Defaults to false.
   * @public
   */
  filterable?: boolean | undefined;

  /**
   * Whether the field's value is given to the agent with each passage. Defaults to false.
   * @public
   */
  givenToAgent?: boolean | undefined;

  /**
   * Whether the field is shown in a document's settings. Defaults to true.
   * @public
   */
  visibleOnDocuments?: boolean | undefined;

  /**
   * The knowledge base the field belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Which field to change, by the key documents store its values under.
   * @public
   */
  fieldKey: string;

  /**
   * The field's ETag. When given, a field that changed since is refused with 412.
   * @public
   */
  ifMatch?: string | undefined;
}

/**
 * @public
 */
export interface UpdateFieldOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The field's new ETag.
   * @public
   */
  etag: string;

  /**
   * The field, changed. It is the whole response body.
   * @public
   */
  field: Field;
}

/**
 * @public
 */
export interface CreateFolderInput {
  /**
   * The knowledge base to add the folder to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The new folder's path, for example `/hr/leave/`. Folders above it are created too.
   * @public
   */
  path: string;
}

/**
 * @public
 */
export interface CreateFolderOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The Operation that tracks the folder's creation.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface DeleteFolderInput {
  /**
   * The knowledge base the folder is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The folder, as its path without the first and last `/`, for example `hr/leave`.
   * @public
   */
  folderPath: string;
}

/**
 * @public
 */
export interface DeleteFolderOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The Operation that tracks the deletion.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface ListFoldersInput {
  /**
   * The knowledge base whose folders to list.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The most folders to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Only folders directly in this folder, or below it with `deep`. Defaults to `/`.
   * @public
   */
  parent?: string | undefined;

  /**
   * When true, every folder below `parent`, not only those directly in it. Defaults to false.
   * @public
   */
  deep?: boolean | undefined;

  /**
   * Only folders whose name contains this text, ignoring case.
   * @public
   */
  q?: string | undefined;
}

/**
 * A folder in a knowledge base.
 * @public
 */
export interface Folder {
  /**
   * The folder's path, for example `/hr/leave/`.
   * @public
   */
  path: string;

  /**
   * The folder it is in.
   * @public
   */
  parent: string;

  /**
   * The folder's own name, the last part of its path.
   * @public
   */
  name: string;

  /**
   * The folder's ETag; send it as `If-Match` to rename or move it.
   * @public
   */
  etag: string;

  /**
   * Who may read the folder's documents.
   * @public
   */
  readers: Readers;

  /**
   * When `readers` is `inherit`: the folder whose readers apply.
   * @public
   */
  inheritedFrom?: string | undefined;

  /**
   * How many folders are directly in it.
   * @public
   */
  folderCount: number;

  /**
   * How many documents are directly in it.
   * @public
   */
  documentCount: number;

  /**
   * When the folder last changed.
   * @public
   */
  updatedAt: Date;
}

/**
 * @public
 */
export interface ListFoldersOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of folders.
   * @public
   */
  items: Folder[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface UpdateFolderInput {
  /**
   * The knowledge base the folder is in.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The folder, as its path without the first and last `/`, for example `hr/leave`.
   * @public
   */
  folderPath: string;

  /**
   * The folder's current ETag. A stale value is refused with 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The folder's new name, the last part of its path, for example `time-off`.
   * @public
   */
  name?: string | undefined;

  /**
   * The folder to move it into, for example `/people/`.
   * @public
   */
  parent?: string | undefined;
}

/**
 * @public
 */
export interface UpdateFolderOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The folder's new ETag.
   * @public
   */
  etag: string;

  /**
   * The Operation, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The Operation that tracks the move.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface GetKnowledgeBaseInput {
  /**
   * The knowledge base to get.
   * @public
   */
  knowledgeBaseId: string;
}

/**
 * @public
 */
export interface GetKnowledgeBaseOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The knowledge base's ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The knowledge base as it stands now. It is the whole response body.
   * @public
   */
  knowledgeBase: KnowledgeBase;
}

/**
 * @public
 */
export interface CancelIngestionBatchInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch to cancel.
   * @public
   */
  ingestionBatchId: string;

  /**
   * True stops ingestion already running too; false (the default) lets it finish.
   * @public
   */
  stopRunning?: boolean | undefined;
}

/**
 * How many of a batch's items have each outcome and status.
 * @public
 */
export interface IngestionBatchCounts {
  /**
   * Items by their planned outcome.
   * @public
   */
  byOutcome?: Partial<Record<IngestionItemOutcome, number>> | undefined;

  /**
   * Items by their status after Start.
   * @public
   */
  byStatus?: Partial<Record<IngestionItemStatus, number>> | undefined;
}

/**
 * Why an ingestion batch failed, as a stable code and a message telling the caller what to do.
 * @public
 */
export interface IngestionBatchFailure {
  /**
   * What went wrong.
   * @public
   */
  code: IngestionBatchFailureCode;

  /**
   * What went wrong and what to do, written for the integrator. The same for every batch with the
   * same code.
   * @public
   */
  message: string;
}

/**
 * What to do with each kind of conflict. A kind with no rule uses `default`.
 * @public
 */
export interface ConflictRules {
  /**
   * The rule for a kind of conflict with no rule of its own. Defaults to `ask`.
   * @public
   */
  default?: ConflictRule | undefined;

  /**
   * The path and the `externalId` name different documents, or the path holds one the caller may
   * not read.
   * @public
   */
  pathTaken?: ConflictRule | undefined;

  /**
   * No `externalId`, and several current documents have these bytes.
   * @public
   */
  ambiguousContent?: ConflictRule | undefined;

  /**
   * Two documents share the path.
   * @public
   */
  duplicatePath?: ConflictRule | undefined;

  /**
   * Two documents share the `externalId` (reason `duplicate_external_id`). Named "key" because
   * a member ending "Id" must hold an identifier.
   * @public
   */
  duplicateExternalKey?: ConflictRule | undefined;

  /**
   * Two items in the batch name the same document.
   * @public
   */
  duplicateInBatch?: ConflictRule | undefined;

  /**
   * The document changed between planning and Start.
   * @public
   */
  changedSincePlan?: ConflictRule | undefined;
}

/**
 * The rules that resolve each item's outcome. A rule applies to every item not resolved by hand.
 * @public
 */
export interface IngestionPolicy {
  /**
   * What to do with each kind of conflict. Defaults to `\{default: "ask"\}`.
   * @public
   */
  onConflict?: ConflictRules | undefined;

  /**
   * What to do with a `remove` item that matches a document. Defaults to `remove`.
   * @public
   */
  onRemove?: RemoveRule | undefined;

  /**
   * What to do with an item whose bytes are the current version's. Defaults to `skip`. Supplied
   * metadata that differs is still updated without ingesting.
   * @public
   */
  onUnchanged?: UnchangedRule | undefined;

  /**
   * What to do with content found at another path. Defaults to `move`, which keeps the document
   * and its history.
   * @public
   */
  onMoved?: MovedRule | undefined;
}

/**
 * The folder a batch is kept inside, so that a batch cannot change documents anywhere else in the
 * knowledge base.
 * @public
 */
export interface IngestionBoundary {
  /**
   * Every item must lie inside this folder; any other item is refused. The boundary only refuses
   * items: it never removes anything.
   * @public
   */
  folderPath: string;
}

/**
 * An ingestion batch: a planned set of document changes to a knowledge base, and their progress.
 * @public
 */
export interface IngestionBatch {
  /**
   * The identifier every call about this batch takes.
   * @public
   */
  id: string;

  /**
   * The knowledge base the batch ingests into.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Where the batch is in its lifecycle.
   * @public
   */
  status: IngestionBatchStatus;

  /**
   * When the batch starts once it is planned.
   * @public
   */
  start: StartMode;

  /**
   * While true, the batch stays `draft` and takes more items.
   * @public
   */
  awaitMoreItems: boolean;

  /**
   * The rules that resolve each item's outcome.
   * @public
   */
  policy: IngestionPolicy;

  /**
   * When set, every item must lie inside this folder.
   * @public
   */
  scope?: IngestionBoundary | undefined;

  /**
   * How many items the batch holds.
   * @public
   */
  itemCount: number;

  /**
   * Items by outcome after planning, and by status after Start.
   * @public
   */
  counts?: IngestionBatchCounts | undefined;

  /**
   * How far the batch has got, from 0 to 100: its documents' progress, weighted by how long each
   * is expected to take. Never moves back.
   * @public
   */
  percent?: number | undefined;

  /**
   * How long is left: the longest of its documents' times left.
   * @public
   */
  eta?: Eta | undefined;

  /**
   * When the plan goes stale, 5 minutes after planning. A stale plan does not end the batch:
   * StartIngestionBatch on a stale plan plans again first.
   * @public
   */
  planExpiresAt?: Date | undefined;

  /**
   * When uploads must arrive by: at or after the upload policy's `expiresAt`. An item whose bytes
   * have not arrived by then fails with `UPLOAD_EXPIRED`; bytes that arrived in time are accepted
   * when they are reported, however late. A caller watching the batch can read it again after this
   * time to see which items failed. Renewing the upload policy moves it later. Absent when no item
   * is awaiting upload.
   * @public
   */
  uploadsExpireAt?: Date | undefined;

  /**
   * Who made the batch.
   * @public
   */
  createdBy?: Actor | undefined;

  /**
   * When the batch was made.
   * @public
   */
  createdAt: Date;

  /**
   * When the batch last changed.
   * @public
   */
  updatedAt: Date;

  /**
   * When the batch was started.
   * @public
   */
  startedAt?: Date | undefined;

  /**
   * When the batch reached a final state.
   * @public
   */
  endedAt?: Date | undefined;

  /**
   * Why the batch failed, as a stable code and a fixed message. Present only when `status` is
   * `failed`.
   * @public
   */
  failure?: IngestionBatchFailure | undefined;

  /**
   * The batch's ETag.
   * @public
   */
  etag: string;
}

/**
 * @public
 */
export interface CancelIngestionBatchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch's new ETag.
   * @public
   */
  etag: string;

  /**
   * The batch as it stands after the cancel. It is the whole response body.
   * @public
   */
  batch: IngestionBatch;
}

/**
 * @public
 */
export interface CompleteIngestionBatchUploadsInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch the items are in.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The items whose bytes are in place: 1 to 100, each at most once.
   * @public
   */
  itemIds: string[];
}

/**
 * The result of reporting one item's upload.
 * @public
 */
export interface UploadCompletionResult {
  /**
   * The item the result is for.
   * @public
   */
  itemId: string;

  /**
   * Whether the upload was accepted for ingestion.
   * @public
   */
  status: UploadCompletionStatus;

  /**
   * Why it failed, as a stable code. Present only when `failed`.
   * @public
   */
  code?: string | undefined;

  /**
   * What went wrong, written for the integrator. Present only when `failed`.
   * @public
   */
  detail?: string | undefined;
}

/**
 * @public
 */
export interface CompleteIngestionBatchUploadsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * One result per item, in request order.
   * @public
   */
  results: UploadCompletionResult[];
}

/**
 * @public
 */
export interface CreateIngestionBatchInput {
  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The knowledge base to ingest into. It must be `ready`.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * When the batch starts once it is planned. Defaults to `when_planned`.
   * @public
   */
  start?: StartMode | undefined;

  /**
   * When true, the batch stays `draft` and takes more items until it is set false. Defaults to
   * false.
   * @public
   */
  awaitMoreItems?: boolean | undefined;

  /**
   * The rules that resolve each item's outcome.
   * @public
   */
  policy?: IngestionPolicy | undefined;

  /**
   * When set, every item must lie inside this folder.
   * @public
   */
  scope?: IngestionBoundary | undefined;

  /**
   * The first items, at most 10,000.
   * @public
   */
  items?: IngestionItemInput[] | undefined;
}

/**
 * @public
 */
export interface CreateIngestionBatchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/ingestion-batches/\{ingestionBatchId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The batch's ETag; send it as `If-Match` to change or start it.
   * @public
   */
  etag: string;

  /**
   * The new batch. It is the whole response body.
   * @public
   */
  batch: IngestionBatch;
}

/**
 * @public
 */
export interface CreateIngestionBatchUploadPolicyInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch whose policy to renew.
   * @public
   */
  ingestionBatchId: string;

  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;
}

/**
 * An upload policy: one signature that lets the caller upload every item of a batch that needs
 * bytes, each as an HTML form POST.
 * @public
 */
export interface UploadPolicy {
  /**
   * Where to POST each file.
   * @public
   */
  uploadUrl: string;

  /**
   * The form fields every upload sends first, in this order, before its own `key`,
   * `Content-Type`, `x-amz-checksum-algorithm` (`SHA256`), `x-amz-checksum-sha256` and the file.
   * @public
   */
  formFields: Record<string, string>;

  /**
   * The prefix every item's `objectKey` starts with.
   * @public
   */
  keyPrefix: string;

  /**
   * The largest file the policy accepts, in bytes.
   * @public
   */
  maxByteSize: number;

  /**
   * When the policy stops working. Renew it with CreateIngestionBatchUploadPolicy.
   * @public
   */
  expiresAt: Date;
}

/**
 * @public
 */
export interface CreateIngestionBatchUploadPolicyOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch the policy is for, as
   * `/api/v3/knowledge-bases/\{knowledgeBaseId\}/ingestion-batches/\{ingestionBatchId\}`. A policy
   * has no address of its own; the batch's items say which still need their bytes.
   * @public
   */
  location?: string | undefined;

  /**
   * The new policy.
   * @public
   */
  uploadPolicy: UploadPolicy;
}

/**
 * @public
 */
export interface GetIngestionBatchInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch to get.
   * @public
   */
  ingestionBatchId: string;
}

/**
 * @public
 */
export interface GetIngestionBatchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch's ETag; send it as `If-Match` to change or start it.
   * @public
   */
  etag: string;

  /**
   * The batch as it stands now. It is the whole response body.
   * @public
   */
  batch: IngestionBatch;
}

/**
 * @public
 */
export interface GetIngestionBatchItemInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch the item is in.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The item to get.
   * @public
   */
  itemId: string;
}

/**
 * @public
 */
export interface GetIngestionBatchItemOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The item's ETag; send it as `If-Match` to resolve it.
   * @public
   */
  etag: string;

  /**
   * The item as it stands now. It is the whole response body.
   * @public
   */
  item: IngestionBatchItem;
}

/**
 * @public
 */
export interface ListIngestionBatchItemsInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch whose items to list.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The most items to return, from 1 to 1,000. Defaults to 100.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Only items with this action.
   * @public
   */
  action?: IngestionItemAction | undefined;

  /**
   * Only items with this outcome.
   * @public
   */
  outcome?: IngestionItemOutcome | undefined;

  /**
   * Only items with this status.
   * @public
   */
  status?: IngestionItemStatus | undefined;

  /**
   * Only items with this resolution.
   * @public
   */
  resolution?: IngestionItemResolution | undefined;
}

/**
 * @public
 */
export interface ListIngestionBatchItemsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of items.
   * @public
   */
  items: IngestionBatchItem[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface UpdateIngestionBatchItemInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch the item is in.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The item to resolve.
   * @public
   */
  itemId: string;

  /**
   * The item's ETag. When given, an item that changed since is refused with 412.
   * @public
   */
  ifMatch?: string | undefined;

  /**
   * What to do with the item.
   * @public
   */
  resolution: IngestionItemResolution;
}

/**
 * @public
 */
export interface UpdateIngestionBatchItemOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The item's new ETag.
   * @public
   */
  etag: string;

  /**
   * The item, resolved. It is the whole response body.
   * @public
   */
  item: IngestionBatchItem;
}

/**
 * @public
 */
export interface ListIngestionBatchesInput {
  /**
   * The most batches to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * The knowledge base whose batches to list.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Only batches with this status.
   * @public
   */
  status?: IngestionBatchStatus | undefined;
}

/**
 * @public
 */
export interface ListIngestionBatchesOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of batches, newest first.
   * @public
   */
  items: IngestionBatch[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface StartIngestionBatchInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch to start.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The batch's ETag, as read after planning. When given, a batch that changed since is
   * refused with 412; when absent, the batch starts as it stands.
   * @public
   */
  ifMatch?: string | undefined;
}

/**
 * @public
 */
export interface StartIngestionBatchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch's new ETag.
   * @public
   */
  etag: string;

  /**
   * The batch, now `running`.
   * @public
   */
  batch: IngestionBatch;

  /**
   * The policy every item that needs bytes is uploaded with. Absent when no item needs bytes.
   * @public
   */
  uploadPolicy?: UploadPolicy | undefined;
}

/**
 * @public
 */
export interface UpdateIngestionBatchInput {
  /**
   * The knowledge base the batch belongs to.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The batch to change.
   * @public
   */
  ingestionBatchId: string;

  /**
   * The batch's current ETag. A stale value is refused with 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The rules that resolve each item's outcome, replacing the batch's.
   * @public
   */
  policy?: IngestionPolicy | undefined;
}

/**
 * @public
 */
export interface UpdateIngestionBatchOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The batch's new ETag.
   * @public
   */
  etag: string;

  /**
   * The batch, changed. It is the whole response body.
   * @public
   */
  batch: IngestionBatch;
}

/**
 * @public
 */
export interface ListKnowledgeBasesInput {
  /**
   * The most knowledge bases to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * Only knowledge bases in this state.
   * @public
   */
  status?: KnowledgeBaseStatus | undefined;
}

/**
 * @public
 */
export interface ListKnowledgeBasesOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of knowledge bases.
   * @public
   */
  items: KnowledgeBase[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface CancelOperationInput {
  /**
   * The knowledge base the Operation's work is on.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The Operation to cancel.
   * @public
   */
  operationId: string;
}

/**
 * @public
 */
export interface CancelOperationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation as it stands after the request. It is the whole response body.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface GetOperationInput {
  /**
   * The knowledge base the Operation's work is on.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The Operation to get.
   * @public
   */
  operationId: string;
}

/**
 * @public
 */
export interface GetOperationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation as it stands now. It is the whole response body.
   * @public
   */
  operation: Operation;
}

/**
 * @public
 */
export interface ListOperationsInput {
  /**
   * The most Operations to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;

  /**
   * The knowledge base whose Operations to list.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Only Operations on this kind of thing.
   * @public
   */
  targetType?: OperationTargetType | undefined;

  /**
   * Only Operations on this thing.
   * @public
   */
  targetId?: string | undefined;

  /**
   * Only Operations of this kind.
   * @public
   */
  kind?: OperationKind | undefined;

  /**
   * Only Operations with this status.
   * @public
   */
  status?: OperationStatus | undefined;
}

/**
 * @public
 */
export interface ListOperationsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of Operations, newest first.
   * @public
   */
  items: Operation[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface WatchOperationInput {
  /**
   * The knowledge base the Operation's work is on.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The Operation to watch.
   * @public
   */
  operationId: string;

  /**
   * The `id` of the last event received. Absent means from the Operation as it is now.
   * @public
   */
  lastEventId?: string | undefined;
}

/**
 * @public
 */
export interface WatchOperationOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The Operation's changes, as a stream of `OperationEvent` events.
   * @public
   */
  events: StreamingBlobTypes;
}

/**
 * The settings a caller sets on a knowledge base, shared by its create and update.
 * @public
 */
export interface UpdateKnowledgeBaseInput {
  /**
   * The knowledge base's name, 1 to 128 characters.
   * @public
   */
  name?: string | undefined;

  /**
   * What the knowledge base holds, in words for the people who use it.
   * @public
   */
  description?: string | undefined;

  /**
   * What the knowledge base holds, in the words an agent reads to decide when to search it.
   * @public
   */
  agentDescription?: string | undefined;

  /**
   * The search settings an agent uses unless its binding says otherwise.
   * @public
   */
  retrieval?: RetrievalDefaults | undefined;

  /**
   * Optional search and viewing features.
   * @public
   */
  features?: KnowledgeBaseFeatures | undefined;

  /**
   * The knowledge base to change.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * The knowledge base's current ETag. A stale value is refused with 412; a missing one with
   * 428.
   * @public
   */
  ifMatch: string;

  /**
   * Members to return to their default.
   * @public
   */
  clear?: ClearableKnowledgeBaseField[] | undefined;
}

/**
 * @public
 */
export interface UpdateKnowledgeBaseOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The knowledge base's new ETag.
   * @public
   */
  etag: string;

  /**
   * The knowledge base, changed. It is the whole response body.
   * @public
   */
  knowledgeBase: KnowledgeBase;
}

/**
 * @public
 */
export interface WatchKnowledgeBaseInput {
  /**
   * The knowledge base to watch.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * Only this document's events.
   * @public
   */
  document?: string | undefined;

  /**
   * Only events about this folder and what is in it, for example `/hr/`.
   * @public
   */
  folder?: string | undefined;

  /**
   * Only this ingestion batch's events, and its documents'.
   * @public
   */
  batch?: string | undefined;
}

/**
 * @public
 */
export interface WatchKnowledgeBaseOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The events, as a stream of `KnowledgeBaseEvent` events.
   * @public
   */
  events: StreamingBlobTypes;
}

/**
 * @public
 */
export interface ListGuardrailsInput {
  /**
   * The most guardrails to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A guardrail an agent version can screen attached documents with.
 * @public
 */
export interface GuardrailSummary {
  /**
   * The guardrail's identifier, as `contentSafety.guardrail` names it.
   * @public
   */
  id: string;

  /**
   * The guardrail's name, as people see it.
   * @public
   */
  name: string;

  /**
   * The guardrail version that screens documents.
   * @public
   */
  version: string;
}

/**
 * @public
 */
export interface ListGuardrailsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of guardrails.
   * @public
   */
  items: GuardrailSummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListMemoryStoresInput {
  /**
   * The most memory stores to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A memory store an agent can remember people in.
 * @public
 */
export interface MemoryStoreSummary {
  /**
   * The memory store's identifier, as an agent configuration names it.
   * @public
   */
  id: string;

  /**
   * The memory store's name, as people see it.
   * @public
   */
  name: string;
}

/**
 * @public
 */
export interface ListMemoryStoresOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of memory stores.
   * @public
   */
  items: MemoryStoreSummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListModelsInput {
  /**
   * The most models to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A model an agent can use, and the settings it accepts.
 * @public
 */
export interface ModelSummary {
  /**
   * The model's identifier, as an agent configuration names it.
   * @public
   */
  id: string;

  /**
   * The model's name, as people see it.
   * @public
   */
  name: string;

  /**
   * Whether the model reasons before it answers, and whether an agent's `reasoning` setting can
   * change that.
   * @public
   */
  reasoning: ModelReasoning;

  /**
   * The reasoning effort levels it offers. Empty when it offers none.
   * @public
   */
  effortLevels?: ReasoningEffort[] | undefined;

  /**
   * Whether it accepts `temperature`.
   * @public
   */
  acceptsTemperature: boolean;

  /**
   * Whether it accepts `topP`.
   * @public
   */
  acceptsTopP: boolean;

  /**
   * Whether it accepts `topK`.
   * @public
   */
  acceptsTopK: boolean;

  /**
   * The most tokens it can write in one answer.
   * @public
   */
  maxOutputTokens: number;
}

/**
 * @public
 */
export interface ListModelsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of models.
   * @public
   */
  items: ModelSummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListToolsInput {
  /**
   * The most tools to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * One of Caitlyn's own tools.
 * @public
 */
export interface ToolSummary {
  /**
   * The tool's name, as a phase names it.
   * @public
   */
  name: string;

  /**
   * What the tool does, in the words the agent reads unless a phase gives its own.
   * @public
   */
  description: string;
}

/**
 * @public
 */
export interface ListToolsOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of tools.
   * @public
   */
  items: ToolSummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * @public
 */
export interface ListVoicesInput {
  /**
   * The most voices to return, from 1 to 100. Defaults to 20.
   * @public
   */
  limit?: number | undefined;

  /**
   * The `nextCursor` from the previous page. Absent for the first page.
   * @public
   */
  cursor?: string | undefined;
}

/**
 * A cloud voice an agent can speak in.
 * @public
 */
export interface VoiceSummary {
  /**
   * The voice's identifier, as an agent configuration names it.
   * @public
   */
  id: string;

  /**
   * The voice's name, as people see it.
   * @public
   */
  name: string;

  /**
   * The language and accent it speaks, as a BCP 47 tag, for example `en-NZ`.
   * @public
   */
  language: string;

  /**
   * The qualities it comes in.
   * @public
   */
  qualities: VoiceQuality[];
}

/**
 * @public
 */
export interface ListVoicesOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * This page of voices.
   * @public
   */
  items: VoiceSummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
}

/**
 * What an upload is for. At most one member is set.
 * @public
 */
export interface UploadPurpose {
  /**
   * True when the file is an agent's avatar picture: a PNG, JPEG or WebP image of at most 1 MB,
   * checked when the upload is reserved. Use the upload as `avatar.mark.pictureUploadId` on
   * CreateAgent or UpdateAgent.
   * @public
   */
  agentAvatar?: boolean | undefined;

  /**
   * The conversation the file will be attached to. The caller must be able to send to it (its
   * update grant, as SendMessage needs); otherwise the call is refused with 404, as for a
   * conversation it may not see. Its agent's attachment settings (whether it takes attachments, how
   * many, how large and which types) are checked before the upload is reserved, and a file they
   * refuse is refused with 400 `ATTACHMENTS_NOT_ACCEPTED` or `VALIDATION_FAILED`.
   * @public
   */
  conversationId?: string | undefined;
}

/**
 * @public
 */
export interface CreateUploadInput {
  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The file's name on the caller's machine.
   * @public
   */
  fileName: string;

  /**
   * The file's media type.
   * @public
   */
  contentType: string;

  /**
   * The file's size in bytes, at most 2 GB (2,147,483,648 bytes). A larger file is refused
   * with 413 `PAYLOAD_TOO_LARGE`.
   * @public
   */
  byteSize: number;

  /**
   * The base64-encoded SHA-256 of the file's bytes. The upload URL accepts only these bytes.
   * @public
   */
  sha256: string;

  /**
   * What the upload is for, when that decides whether it is accepted. Absent means a document.
   * @public
   */
  purpose?: UploadPurpose | undefined;
}

/**
 * @public
 */
export interface CreateUploadOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The upload, as `/api/v3/uploads/\{uploadId\}`: read its status with GetUpload.
   * @public
   */
  location?: string | undefined;

  /**
   * The upload's identifier, passed to the operation that uses it.
   * @public
   */
  id: string;

  /**
   * Where to send the bytes. Expires at `expiresAt`.
   * @public
   */
  uploadUrl: string;

  /**
   * The HTTP method to send the bytes with, usually `PUT`.
   * @public
   */
  uploadMethod: string;

  /**
   * Headers that must be sent with the bytes, exactly as given.
   * @public
   */
  requiredHeaders: Record<string, string>;

  /**
   * When the upload URL stops working.
   * @public
   */
  expiresAt: Date;

  /**
   * Where the upload is in its lifecycle.
   * @public
   */
  status: UploadStatus;
}

/**
 * @public
 */
export interface GetUploadInput {
  /**
   * The upload to read.
   * @public
   */
  uploadId: string;
}

/**
 * A short-lived slot for the bytes of one file.
 * @public
 */
export interface Upload {
  /**
   * The identifier the operation that uses the upload takes, for example CreateDocument's
   * `uploadId`.
   * @public
   */
  id: string;

  /**
   * Where the upload is in its lifecycle.
   * @public
   */
  status: UploadStatus;

  /**
   * When the upload URL stops working.
   * @public
   */
  expiresAt: Date;
}

/**
 * @public
 */
export interface GetUploadOutput {
  /**
   * The identifier support uses to find this request. The same value is in every error body;
   * quote it to support.
   * @public
   */
  requestId?: string | undefined;

  /**
   * The server's model version, for example `5.120.0`. The SDKs keep the latest value they have
   * seen and refuse to call operations or send members newer than it.
   * @public
   */
  apiVersion?: string | undefined;

  /**
   * The upload, with its status. It is the whole response body.
   * @public
   */
  upload: Upload;
}
