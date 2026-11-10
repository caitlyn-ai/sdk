// smithy-typescript generated code
import type { DocumentType as __DocumentType, StreamingBlobTypes } from "@smithy/types";

import type {
  ClearableDraftField,
  DocumentStatus,
  OperationKind,
  OperationStatus,
  UploadStatus,
  VersionSource,
} from "./enums";

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
 * Chat attachment settings.
 * @public
 */
export interface AttachmentSettings {
  /**
   * Whether people may attach files in chat. Defaults to false.
   * @public
   */
  enabled?: boolean | undefined;

  /**
   * The most files one message may carry, from 1 to 20.
   * @public
   */
  maxFiles?: number | undefined;
}

/**
 * The content safety setting on a version.
 * @public
 */
export interface ContentSafety {
  /**
   * The guardrail applied, from the guardrails list. Absent means none.
   * @public
   */
  guardrailId?: string | undefined;
}

/**
 * One knowledge base an agent searches, and how.
 * @public
 */
export interface KnowledgeBaseBinding {
  /**
   * The knowledge base searched.
   * @public
   */
  knowledgeBaseId: string;

  /**
   * How many passages to retrieve per search, from 1 to 100. Absent means the server default.
   * @public
   */
  numberOfResults?: number | undefined;

  /**
   * The lowest relevance score a passage needs to be used, from 0 to 1. Absent means the server
   * default.
   * @public
   */
  minimumScore?: number | undefined;
}

/**
 * @public
 */
export interface UpdateDraftVersionInput {
  /**
   * The agent whose draft is edited.
   * @public
   */
  agentId: string;

  /**
   * The draft's current ETag, from a Get or an earlier update. A stale value is refused with
   * 412; a missing one with 428.
   * @public
   */
  ifMatch: string;

  /**
   * The agent's identity statement, at most 4,000 characters.
   * @public
   */
  identity?: string | undefined;

  /**
   * The agent's instructions, at most 100,000 characters.
   * @public
   */
  instructions?: string | undefined;

  /**
   * The model the agent answers with, from the agent models list.
   * @public
   */
  model?: string | undefined;

  /**
   * The knowledge bases the agent searches. Replaces the whole list.
   * @public
   */
  knowledgeBases?: KnowledgeBaseBinding[] | undefined;

  /**
   * Whether people may attach files in chat, and how many.
   * @public
   */
  attachments?: AttachmentSettings | undefined;

  /**
   * The content safety setting applied to uploads and answers.
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
   * Draft members to return to their default.
   * @public
   */
  clear?: ClearableDraftField[] | undefined;
}

/**
 * An agent version's configuration.
 * @public
 */
export interface AgentConfiguration {
  /**
   * The agent's identity statement. Absent when it was never set or was cleared.
   * @public
   */
  identity?: string | undefined;

  /**
   * The agent's instructions. Empty when none are set.
   * @public
   */
  instructions: string;

  /**
   * The model the agent answers with.
   * @public
   */
  model?: string | undefined;

  /**
   * The knowledge bases the agent searches, in no particular order.
   * @public
   */
  knowledgeBases?: KnowledgeBaseBinding[] | undefined;

  /**
   * Whether people may attach files in chat, and how many.
   * @public
   */
  attachments?: AttachmentSettings | undefined;

  /**
   * The content safety setting applied to uploads and answers.
   * @public
   */
  contentSafety?: ContentSafety | undefined;

  /**
   * When true, the answer stream tells the caller which documents were withheld from them.
   * Defaults to false.
   * @public
   */
  deniedDocuments?: boolean | undefined;
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface UpdateDraftVersionOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
   * The version's current ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The agent the version belongs to.
   * @public
   */
  agentId: string;

  /**
   * `draft`, `production` or the version's name.
   * @public
   */
  name: string;

  /**
   * How a pinned or published version was made. Absent on the draft.
   * @public
   */
  source?: VersionSource | undefined;

  /**
   * The version this one was made from, where there is one.
   * @public
   */
  basedOn?: string | undefined;

  /**
   * True when this version's configuration is the one production currently answers with.
   * Defaults to false.
   * @public
   */
  matchesProduction?: boolean | undefined;

  /**
   * When the version was made; for the draft, when it was first created.
   * @public
   */
  createdAt: Date;

  /**
   * The note written when the version was pinned or published.
   * @public
   */
  note?: string | undefined;

  /**
   * The version's configuration.
   * @public
   */
  configuration: AgentConfiguration;
}

/**
 * @public
 */
export interface GetAgentVersionInput {
  /**
   * The agent's identifier.
   * @public
   */
  agentId: string;

  /**
   * `draft`, `production` or a version name.
   * @public
   */
  version: string;
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface GetAgentVersionOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
   * The version's current ETag; send it as `If-Match` to change it.
   * @public
   */
  etag: string;

  /**
   * The agent the version belongs to.
   * @public
   */
  agentId: string;

  /**
   * `draft`, `production` or the version's name.
   * @public
   */
  name: string;

  /**
   * How a pinned or published version was made. Absent on the draft.
   * @public
   */
  source?: VersionSource | undefined;

  /**
   * The version this one was made from, where there is one.
   * @public
   */
  basedOn?: string | undefined;

  /**
   * True when this version's configuration is the one production currently answers with.
   * Defaults to false.
   * @public
   */
  matchesProduction?: boolean | undefined;

  /**
   * When the version was made; for the draft, when it was first created.
   * @public
   */
  createdAt: Date;

  /**
   * The note written when the version was pinned or published.
   * @public
   */
  note?: string | undefined;

  /**
   * The version's configuration.
   * @public
   */
  configuration: AgentConfiguration;
}

/**
 * @public
 */
export interface ResumeConversationStreamInput {
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
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface ResumeConversationStreamOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface SendMessageOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
export interface CreateDocumentInput {
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
   * The upload holding the document's bytes. Each upload can be used once.
   * @public
   */
  uploadId: string;

  /**
   * The folder to put the document in.
   * @public
   */
  folder: string;

  /**
   * The document's name. Absent means the uploaded file's name.
   * @public
   */
  name?: string | undefined;
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
 * One document in a knowledge base, stable across new uploads of new bytes.
 * @public
 */
export interface Document {
  /**
   * The document's identifier.
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
   * Where the document is in its lifecycle.
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
}

/**
 * Background work that continues after the request that started it. Read it, wait on it or watch
 * it; never start the work again to find out how it went.
 * @public
 */
export interface Operation {
  /**
   * The Operation's identifier.
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
   * When the work was requested.
   * @public
   */
  createdAt: Date;
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface CreateDocumentOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
   * The Operation that tracks ingestion, as `/api/v3/operations/\{operationId\}`.
   * @public
   */
  location?: string | undefined;

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
   * Only documents directly in this folder.
   * @public
   */
  folder?: string | undefined;

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
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface ListDocumentsOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
   * The file's size in bytes.
   * @public
   */
  byteSize: number;

  /**
   * The base64-encoded SHA-256 of the file's bytes. The upload URL accepts only these bytes.
   * @public
   */
  sha256: string;
}

/**
 * Headers every v3 response carries. Every operation output uses this mixin.
 * @public
 */
export interface CreateUploadOutput {
  /**
   * The request's identifier. The same value is in every error body; quote it to support.
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
   * The upload, as `/api/v3/uploads/\{uploadId\}`.
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
