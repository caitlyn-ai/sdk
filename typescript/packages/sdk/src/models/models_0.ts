// smithy-typescript generated code
import type { DocumentType as __DocumentType, StreamingBlobTypes } from "@smithy/types";

import type {
  ClearableDraftField,
  CredentialKind,
  DocumentDeleteStatus,
  DocumentFailureCode,
  DocumentStatus,
  OperationKind,
  OperationStatus,
  UploadStatus,
  VersionSource,
} from "./enums";

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
export interface PinDraftVersionInput {
  /**
   * The agent whose draft is pinned.
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
   * The new version's name, unique within the agent, and never `draft`, `production` or
   * `latest`. A name already used is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  name: string;

  /**
   * Why it was pinned, at most 2,000 characters.
   * @public
   */
  note?: string | undefined;
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
 * @public
 */
export interface PinDraftVersionOutput {
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
   * When this configuration became production. Present only on `production`.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * Who made this configuration production. Present only on `production`.
   * @public
   */
  publishedBy?: Actor | undefined;

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

  /**
   * The new version, as `/api/v3/agents/\{agentId\}/versions/\{name\}`.
   * @public
   */
  location?: string | undefined;
}

/**
 * @public
 */
export interface GetProductionHistoryEntryInput {
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
 * @public
 */
export interface GetProductionHistoryEntryOutput {
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
   * The entry's identifier.
   * @public
   */
  id: string;

  /**
   * The agent whose production this was.
   * @public
   */
  agentId: string;

  /**
   * The name of the version production was published from, kept even if that version has since
   * been deleted. Absent when production did not come from a named version.
   * @public
   */
  versionName?: string | undefined;

  /**
   * When this configuration became production.
   * @public
   */
  publishedAt: Date;

  /**
   * Who made it production.
   * @public
   */
  publishedBy: Actor;

  /**
   * When a publish replaced it.
   * @public
   */
  unpublishedAt: Date;

  /**
   * Who published the version that replaced it.
   * @public
   */
  unpublishedBy: Actor;

  /**
   * The note written when it was published.
   * @public
   */
  note?: string | undefined;

  /**
   * The configuration production had.
   * @public
   */
  configuration: AgentConfiguration;
}

/**
 * @public
 */
export interface ListProductionHistoryEntriesInput {
  /**
   * The agent whose production history to list.
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
 * A production history entry, without its configuration (read that with GetProductionHistoryEntry).
 * @public
 */
export interface ProductionHistorySummary {
  /**
   * The entry's identifier.
   * @public
   */
  id: string;

  /**
   * The agent whose production this was.
   * @public
   */
  agentId: string;

  /**
   * The name of the version production was published from, kept even if that version has since
   * been deleted. Absent when production did not come from a named version.
   * @public
   */
  versionName?: string | undefined;

  /**
   * When this configuration became production.
   * @public
   */
  publishedAt: Date;

  /**
   * Who made it production.
   * @public
   */
  publishedBy: Actor;

  /**
   * When a publish replaced it.
   * @public
   */
  unpublishedAt: Date;

  /**
   * Who published the version that replaced it.
   * @public
   */
  unpublishedBy: Actor;

  /**
   * The note written when it was published.
   * @public
   */
  note?: string | undefined;
}

/**
 * @public
 */
export interface ListProductionHistoryEntriesOutput {
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
   * This page of entries, newest first.
   * @public
   */
  items: ProductionHistorySummary[];

  /**
   * The cursor for the next page. Absent on the last page.
   * @public
   */
  nextCursor?: string | undefined;
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
   * The version to copy: a version name, or `production`.
   * @public
   */
  from: string;
}

/**
 * @public
 */
export interface ResetDraftVersionOutput {
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
   * When this configuration became production. Present only on `production`.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * Who made this configuration production. Present only on `production`.
   * @public
   */
  publishedBy?: Actor | undefined;

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
   * When this configuration became production. Present only on `production`.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * Who made this configuration production. Present only on `production`.
   * @public
   */
  publishedBy?: Actor | undefined;

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
   * When this configuration became production. Present only on `production`.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * Who made this configuration production. Present only on `production`.
   * @public
   */
  publishedBy?: Actor | undefined;

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
 * A named version, without its configuration (read that with GetAgentVersion).
 * @public
 */
export interface AgentVersionSummary {
  /**
   * The version's name.
   * @public
   */
  name: string;

  /**
   * How the version was made.
   * @public
   */
  source?: VersionSource | undefined;

  /**
   * The version this one was made from, where there is one.
   * @public
   */
  basedOn?: string | undefined;

  /**
   * True when production's configuration is this version's. Defaults to false.
   * @public
   */
  matchesProduction?: boolean | undefined;

  /**
   * When the version was made.
   * @public
   */
  createdAt: Date;

  /**
   * The note written when the version was pinned or published.
   * @public
   */
  note?: string | undefined;
}

/**
 * @public
 */
export interface ListAgentVersionsOutput {
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
   * This page of versions, oldest first.
   * @public
   */
  items: AgentVersionSummary[];

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
   * Production's current ETag. A stale value is refused with 412; a missing one with 428. For
   * an agent's first publish, when it has no production yet, send `*`: that publish creates
   * production only where none exists, so two first publishes cannot both succeed. With
   * production present, `*` publishes without comparing.
   * @public
   */
  ifMatch: string;

  /**
   * When publishing `draft`: the name of the new version the draft is kept as. Required then,
   * and refused with 400 `VALIDATION_FAILED` for any other version. A name already used by
   * this agent is refused with 409 `ALREADY_EXISTS`.
   * @public
   */
  name?: string | undefined;

  /**
   * Why it was published, recorded with the production change, at most 2,000 characters.
   * @public
   */
  note?: string | undefined;
}

/**
 * @public
 */
export interface PublishAgentVersionOutput {
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
   * When this configuration became production. Present only on `production`.
   * @public
   */
  publishedAt?: Date | undefined;

  /**
   * Who made this configuration production. Present only on `production`.
   * @public
   */
  publishedBy?: Actor | undefined;

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
   * Why it failed, as a stable code, for example `NOT_FOUND` or `CONFLICT`. Present only when
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
   * One result per identifier, in request order.
   * @public
   */
  results: DocumentDeleteResult[];
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
   * The organisation's identifier.
   * @public
   */
  id: string;

  /**
   * The organisation's name.
   * @public
   */
  name: string;
}

/**
 * @public
 */
export interface GetCallerOutput {
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
 * @public
 */
export interface CreateConversationInput {
  /**
   * Makes the request safe to retry. The SDKs generate one per call when the caller does not
   * supply one.
   * @public
   */
  idempotencyKey?: string | undefined;

  /**
   * The agent to talk to.
   * @public
   */
  agentId: string;

  /**
   * The version of the agent that answers. Today only `draft`.
   * @public
   */
  version: string;

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
   * The conversation, as `/api/v3/conversations/\{conversationId\}`.
   * @public
   */
  location?: string | undefined;

  /**
   * The conversation's identifier.
   * @public
   */
  id: string;

  /**
   * The agent the conversation is with.
   * @public
   */
  agentId: string;

  /**
   * The version of the agent that answers.
   * @public
   */
  version: string;

  /**
   * The conversation's title, when it has one yet.
   * @public
   */
  title?: string | undefined;

  /**
   * When the conversation was created.
   * @public
   */
  createdAt: Date;
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
   * The events, as a stream of `WorkspaceEvent` events.
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
   * The document's name. Absent means the uploaded file's name. A name without an extension is
   * given the one the upload's content type maps to, because ingestion reads the file type
   * from it. Refused with 400 `VALIDATION_FAILED` when the type maps to no extension, or when
   * the extension is one a knowledge base cannot ingest.
   * @public
   */
  name?: string | undefined;
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

  /**
   * Why the document could not be made searchable. Present only when `status` is `failed`; a
   * document that is searchable with gaps lists them in `partialFailures` instead.
   * @public
   */
  failure?: DocumentFailure | undefined;
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
   * The document, as `/api/v3/knowledge-bases/\{knowledgeBaseId\}/documents/\{documentId\}`.
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

  /**
   * Why the document could not be made searchable. Present only when `status` is `failed`; a
   * document that is searchable with gaps lists them in `partialFailures` instead.
   * @public
   */
  failure?: DocumentFailure | undefined;
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

  /**
   * Why the document could not be made searchable. Present only when `status` is `failed`; a
   * document that is searchable with gaps lists them in `partialFailures` instead.
   * @public
   */
  failure?: DocumentFailure | undefined;
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
 * @public
 */
export interface GetUploadOutput {
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
   * The upload's identifier.
   * @public
   */
  id: string;

  /**
   * Where the upload is in its lifecycle.
   * @public
   */
  status: UploadStatus;

  /**
   * When the upload URL stops working. An upload not used by then becomes `expired`.
   * @public
   */
  expiresAt: Date;
}
