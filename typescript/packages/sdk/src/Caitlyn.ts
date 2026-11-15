// smithy-typescript generated code
import { createAggregatedClient } from "@smithy/core/client";
import type {
  HttpHandlerOptions as __HttpHandlerOptions,
  MetricsRecorder as __MetricsRecorder,
  PaginationConfiguration,
  Paginator,
} from "@smithy/types";

import { CaitlynClient } from "./CaitlynClient";
import {
  type BatchDeleteDocumentsCommandInput,
  type BatchDeleteDocumentsCommandOutput,
  BatchDeleteDocumentsCommand,
} from "./commands/BatchDeleteDocumentsCommand";
import {
  type CreateConversationCommandInput,
  type CreateConversationCommandOutput,
  CreateConversationCommand,
} from "./commands/CreateConversationCommand";
import {
  type CreateDocumentCommandInput,
  type CreateDocumentCommandOutput,
  CreateDocumentCommand,
} from "./commands/CreateDocumentCommand";
import {
  type CreateUploadCommandInput,
  type CreateUploadCommandOutput,
  CreateUploadCommand,
} from "./commands/CreateUploadCommand";
import {
  type DeleteAgentVersionCommandInput,
  type DeleteAgentVersionCommandOutput,
  DeleteAgentVersionCommand,
} from "./commands/DeleteAgentVersionCommand";
import {
  type DeleteDocumentCommandInput,
  type DeleteDocumentCommandOutput,
  DeleteDocumentCommand,
} from "./commands/DeleteDocumentCommand";
import {
  type GetAgentVersionCommandInput,
  type GetAgentVersionCommandOutput,
  GetAgentVersionCommand,
} from "./commands/GetAgentVersionCommand";
import { type GetCallerCommandInput, type GetCallerCommandOutput, GetCallerCommand } from "./commands/GetCallerCommand";
import {
  type GetDocumentCommandInput,
  type GetDocumentCommandOutput,
  GetDocumentCommand,
} from "./commands/GetDocumentCommand";
import {
  type GetProductionHistoryEntryCommandInput,
  type GetProductionHistoryEntryCommandOutput,
  GetProductionHistoryEntryCommand,
} from "./commands/GetProductionHistoryEntryCommand";
import { type GetUploadCommandInput, type GetUploadCommandOutput, GetUploadCommand } from "./commands/GetUploadCommand";
import {
  type ListAgentVersionsCommandInput,
  type ListAgentVersionsCommandOutput,
  ListAgentVersionsCommand,
} from "./commands/ListAgentVersionsCommand";
import {
  type ListDocumentsCommandInput,
  type ListDocumentsCommandOutput,
  ListDocumentsCommand,
} from "./commands/ListDocumentsCommand";
import {
  type ListProductionHistoryEntriesCommandInput,
  type ListProductionHistoryEntriesCommandOutput,
  ListProductionHistoryEntriesCommand,
} from "./commands/ListProductionHistoryEntriesCommand";
import {
  type PinDraftVersionCommandInput,
  type PinDraftVersionCommandOutput,
  PinDraftVersionCommand,
} from "./commands/PinDraftVersionCommand";
import {
  type PublishAgentVersionCommandInput,
  type PublishAgentVersionCommandOutput,
  PublishAgentVersionCommand,
} from "./commands/PublishAgentVersionCommand";
import {
  type ResetDraftVersionCommandInput,
  type ResetDraftVersionCommandOutput,
  ResetDraftVersionCommand,
} from "./commands/ResetDraftVersionCommand";
import {
  type SendMessageCommandInput,
  type SendMessageCommandOutput,
  SendMessageCommand,
} from "./commands/SendMessageCommand";
import {
  type UpdateDraftVersionCommandInput,
  type UpdateDraftVersionCommandOutput,
  UpdateDraftVersionCommand,
} from "./commands/UpdateDraftVersionCommand";
import {
  type WatchConversationCommandInput,
  type WatchConversationCommandOutput,
  WatchConversationCommand,
} from "./commands/WatchConversationCommand";
import {
  type WatchWorkspaceEventsCommandInput,
  type WatchWorkspaceEventsCommandOutput,
  WatchWorkspaceEventsCommand,
} from "./commands/WatchWorkspaceEventsCommand";
import type { CaitlynServiceException } from "./models/CaitlynServiceException";
import type { NotFoundError } from "./models/errors";
import { paginateListAgentVersions } from "./pagination/ListAgentVersionsPaginator";
import { paginateListDocuments } from "./pagination/ListDocumentsPaginator";
import { paginateListProductionHistoryEntries } from "./pagination/ListProductionHistoryEntriesPaginator";

const commands = {
  BatchDeleteDocumentsCommand,
  CreateConversationCommand,
  CreateDocumentCommand,
  CreateUploadCommand,
  DeleteAgentVersionCommand,
  DeleteDocumentCommand,
  GetAgentVersionCommand,
  GetCallerCommand,
  GetDocumentCommand,
  GetProductionHistoryEntryCommand,
  GetUploadCommand,
  ListAgentVersionsCommand,
  ListDocumentsCommand,
  ListProductionHistoryEntriesCommand,
  PinDraftVersionCommand,
  PublishAgentVersionCommand,
  ResetDraftVersionCommand,
  SendMessageCommand,
  UpdateDraftVersionCommand,
  WatchConversationCommand,
  WatchWorkspaceEventsCommand,
};
const paginators = {
  paginateListAgentVersions,
  paginateListDocuments,
  paginateListProductionHistoryEntries,
};

/**
 * @public
 */
export interface CaitlynRequestOptions extends __HttpHandlerOptions {
  metricsRecorder?: __MetricsRecorder<unknown>;
}

export interface Caitlyn {
  /**
   * @see {@link BatchDeleteDocumentsCommand}
   */
  batchDeleteDocuments(
    args: BatchDeleteDocumentsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<BatchDeleteDocumentsCommandOutput>;
  batchDeleteDocuments(
    args: BatchDeleteDocumentsCommandInput,
    cb: (err: any, data?: BatchDeleteDocumentsCommandOutput) => void
  ): void;
  batchDeleteDocuments(
    args: BatchDeleteDocumentsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: BatchDeleteDocumentsCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateConversationCommand}
   */
  createConversation(
    args: CreateConversationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateConversationCommandOutput>;
  createConversation(
    args: CreateConversationCommandInput,
    cb: (err: any, data?: CreateConversationCommandOutput) => void
  ): void;
  createConversation(
    args: CreateConversationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateConversationCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateDocumentCommand}
   */
  createDocument(
    args: CreateDocumentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateDocumentCommandOutput>;
  createDocument(
    args: CreateDocumentCommandInput,
    cb: (err: any, data?: CreateDocumentCommandOutput) => void
  ): void;
  createDocument(
    args: CreateDocumentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateDocumentCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateUploadCommand}
   */
  createUpload(
    args: CreateUploadCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateUploadCommandOutput>;
  createUpload(
    args: CreateUploadCommandInput,
    cb: (err: any, data?: CreateUploadCommandOutput) => void
  ): void;
  createUpload(
    args: CreateUploadCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateUploadCommandOutput) => void
  ): void;

  /**
   * @see {@link DeleteAgentVersionCommand}
   */
  deleteAgentVersion(
    args: DeleteAgentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteAgentVersionCommandOutput>;
  deleteAgentVersion(
    args: DeleteAgentVersionCommandInput,
    cb: (err: any, data?: DeleteAgentVersionCommandOutput) => void
  ): void;
  deleteAgentVersion(
    args: DeleteAgentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteAgentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link DeleteDocumentCommand}
   */
  deleteDocument(
    args: DeleteDocumentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteDocumentCommandOutput>;
  deleteDocument(
    args: DeleteDocumentCommandInput,
    cb: (err: any, data?: DeleteDocumentCommandOutput) => void
  ): void;
  deleteDocument(
    args: DeleteDocumentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteDocumentCommandOutput) => void
  ): void;

  /**
   * @see {@link GetAgentVersionCommand}
   */
  getAgentVersion(
    args: GetAgentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetAgentVersionCommandOutput>;
  getAgentVersion(
    args: GetAgentVersionCommandInput,
    cb: (err: any, data?: GetAgentVersionCommandOutput) => void
  ): void;
  getAgentVersion(
    args: GetAgentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetAgentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link GetCallerCommand}
   */
  getCaller(): Promise<GetCallerCommandOutput>;
  getCaller(
    args: GetCallerCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetCallerCommandOutput>;
  getCaller(
    args: GetCallerCommandInput,
    cb: (err: any, data?: GetCallerCommandOutput) => void
  ): void;
  getCaller(
    args: GetCallerCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetCallerCommandOutput) => void
  ): void;

  /**
   * @see {@link GetDocumentCommand}
   */
  getDocument(
    args: GetDocumentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetDocumentCommandOutput>;
  getDocument(
    args: GetDocumentCommandInput,
    cb: (err: any, data?: GetDocumentCommandOutput) => void
  ): void;
  getDocument(
    args: GetDocumentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetDocumentCommandOutput) => void
  ): void;

  /**
   * @see {@link GetProductionHistoryEntryCommand}
   */
  getProductionHistoryEntry(
    args: GetProductionHistoryEntryCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetProductionHistoryEntryCommandOutput>;
  getProductionHistoryEntry(
    args: GetProductionHistoryEntryCommandInput,
    cb: (err: any, data?: GetProductionHistoryEntryCommandOutput) => void
  ): void;
  getProductionHistoryEntry(
    args: GetProductionHistoryEntryCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetProductionHistoryEntryCommandOutput) => void
  ): void;

  /**
   * @see {@link GetUploadCommand}
   */
  getUpload(
    args: GetUploadCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetUploadCommandOutput>;
  getUpload(
    args: GetUploadCommandInput,
    cb: (err: any, data?: GetUploadCommandOutput) => void
  ): void;
  getUpload(
    args: GetUploadCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetUploadCommandOutput) => void
  ): void;

  /**
   * @see {@link ListAgentVersionsCommand}
   */
  listAgentVersions(
    args: ListAgentVersionsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListAgentVersionsCommandOutput>;
  listAgentVersions(
    args: ListAgentVersionsCommandInput,
    cb: (err: any, data?: ListAgentVersionsCommandOutput) => void
  ): void;
  listAgentVersions(
    args: ListAgentVersionsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListAgentVersionsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListDocumentsCommand}
   */
  listDocuments(
    args: ListDocumentsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListDocumentsCommandOutput>;
  listDocuments(
    args: ListDocumentsCommandInput,
    cb: (err: any, data?: ListDocumentsCommandOutput) => void
  ): void;
  listDocuments(
    args: ListDocumentsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListDocumentsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListProductionHistoryEntriesCommand}
   */
  listProductionHistoryEntries(
    args: ListProductionHistoryEntriesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListProductionHistoryEntriesCommandOutput>;
  listProductionHistoryEntries(
    args: ListProductionHistoryEntriesCommandInput,
    cb: (err: any, data?: ListProductionHistoryEntriesCommandOutput) => void
  ): void;
  listProductionHistoryEntries(
    args: ListProductionHistoryEntriesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListProductionHistoryEntriesCommandOutput) => void
  ): void;

  /**
   * @see {@link PinDraftVersionCommand}
   */
  pinDraftVersion(
    args: PinDraftVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<PinDraftVersionCommandOutput>;
  pinDraftVersion(
    args: PinDraftVersionCommandInput,
    cb: (err: any, data?: PinDraftVersionCommandOutput) => void
  ): void;
  pinDraftVersion(
    args: PinDraftVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: PinDraftVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link PublishAgentVersionCommand}
   */
  publishAgentVersion(
    args: PublishAgentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<PublishAgentVersionCommandOutput>;
  publishAgentVersion(
    args: PublishAgentVersionCommandInput,
    cb: (err: any, data?: PublishAgentVersionCommandOutput) => void
  ): void;
  publishAgentVersion(
    args: PublishAgentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: PublishAgentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link ResetDraftVersionCommand}
   */
  resetDraftVersion(
    args: ResetDraftVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ResetDraftVersionCommandOutput>;
  resetDraftVersion(
    args: ResetDraftVersionCommandInput,
    cb: (err: any, data?: ResetDraftVersionCommandOutput) => void
  ): void;
  resetDraftVersion(
    args: ResetDraftVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ResetDraftVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link SendMessageCommand}
   */
  sendMessage(
    args: SendMessageCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<SendMessageCommandOutput>;
  sendMessage(
    args: SendMessageCommandInput,
    cb: (err: any, data?: SendMessageCommandOutput) => void
  ): void;
  sendMessage(
    args: SendMessageCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: SendMessageCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateDraftVersionCommand}
   */
  updateDraftVersion(
    args: UpdateDraftVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateDraftVersionCommandOutput>;
  updateDraftVersion(
    args: UpdateDraftVersionCommandInput,
    cb: (err: any, data?: UpdateDraftVersionCommandOutput) => void
  ): void;
  updateDraftVersion(
    args: UpdateDraftVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateDraftVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link WatchConversationCommand}
   */
  watchConversation(
    args: WatchConversationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<WatchConversationCommandOutput>;
  watchConversation(
    args: WatchConversationCommandInput,
    cb: (err: any, data?: WatchConversationCommandOutput) => void
  ): void;
  watchConversation(
    args: WatchConversationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: WatchConversationCommandOutput) => void
  ): void;

  /**
   * @see {@link WatchWorkspaceEventsCommand}
   */
  watchWorkspaceEvents(): Promise<WatchWorkspaceEventsCommandOutput>;
  watchWorkspaceEvents(
    args: WatchWorkspaceEventsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<WatchWorkspaceEventsCommandOutput>;
  watchWorkspaceEvents(
    args: WatchWorkspaceEventsCommandInput,
    cb: (err: any, data?: WatchWorkspaceEventsCommandOutput) => void
  ): void;
  watchWorkspaceEvents(
    args: WatchWorkspaceEventsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: WatchWorkspaceEventsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListAgentVersionsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListAgentVersionsCommandOutput}.
   */
  paginateListAgentVersions(
    args: ListAgentVersionsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListAgentVersionsCommandOutput>;

  /**
   * @see {@link ListDocumentsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListDocumentsCommandOutput}.
   */
  paginateListDocuments(
    args: ListDocumentsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListDocumentsCommandOutput>;

  /**
   * @see {@link ListProductionHistoryEntriesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListProductionHistoryEntriesCommandOutput}.
   */
  paginateListProductionHistoryEntries(
    args: ListProductionHistoryEntriesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListProductionHistoryEntriesCommandOutput>;


}

/**
 * The Caitlyn v3 API.
 *
 * Every request is made to a workspace's own hostname, which names the workspace, and carries a
 * short-lived Caitlyn bearer token, however the caller signed in. The `session` sign-in mode (the
 * browser cookie) is handled by the SDKs' runtime and is not modelled per operation.
 * @public
 */
export class Caitlyn extends CaitlynClient implements Caitlyn {}
createAggregatedClient(commands, Caitlyn, { paginators });
