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
  type BatchCreateIngestionBatchItemsCommandInput,
  type BatchCreateIngestionBatchItemsCommandOutput,
  BatchCreateIngestionBatchItemsCommand,
} from "./commands/BatchCreateIngestionBatchItemsCommand";
import {
  type BatchDeleteDocumentsCommandInput,
  type BatchDeleteDocumentsCommandOutput,
  BatchDeleteDocumentsCommand,
} from "./commands/BatchDeleteDocumentsCommand";
import {
  type CancelDocumentProcessingCommandInput,
  type CancelDocumentProcessingCommandOutput,
  CancelDocumentProcessingCommand,
} from "./commands/CancelDocumentProcessingCommand";
import {
  type CancelIngestionBatchCommandInput,
  type CancelIngestionBatchCommandOutput,
  CancelIngestionBatchCommand,
} from "./commands/CancelIngestionBatchCommand";
import {
  type CancelOperationCommandInput,
  type CancelOperationCommandOutput,
  CancelOperationCommand,
} from "./commands/CancelOperationCommand";
import {
  type CompareAgentVersionsCommandInput,
  type CompareAgentVersionsCommandOutput,
  CompareAgentVersionsCommand,
} from "./commands/CompareAgentVersionsCommand";
import {
  type CompleteIngestionBatchUploadsCommandInput,
  type CompleteIngestionBatchUploadsCommandOutput,
  CompleteIngestionBatchUploadsCommand,
} from "./commands/CompleteIngestionBatchUploadsCommand";
import {
  type CreateAgentCommandInput,
  type CreateAgentCommandOutput,
  CreateAgentCommand,
} from "./commands/CreateAgentCommand";
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
  type CreateDocumentVersionCommandInput,
  type CreateDocumentVersionCommandOutput,
  CreateDocumentVersionCommand,
} from "./commands/CreateDocumentVersionCommand";
import {
  type CreateFieldCommandInput,
  type CreateFieldCommandOutput,
  CreateFieldCommand,
} from "./commands/CreateFieldCommand";
import {
  type CreateFolderCommandInput,
  type CreateFolderCommandOutput,
  CreateFolderCommand,
} from "./commands/CreateFolderCommand";
import {
  type CreateIngestionBatchCommandInput,
  type CreateIngestionBatchCommandOutput,
  CreateIngestionBatchCommand,
} from "./commands/CreateIngestionBatchCommand";
import {
  type CreateIngestionBatchUploadPolicyCommandInput,
  type CreateIngestionBatchUploadPolicyCommandOutput,
  CreateIngestionBatchUploadPolicyCommand,
} from "./commands/CreateIngestionBatchUploadPolicyCommand";
import {
  type CreateKnowledgeBaseCommandInput,
  type CreateKnowledgeBaseCommandOutput,
  CreateKnowledgeBaseCommand,
} from "./commands/CreateKnowledgeBaseCommand";
import {
  type CreateUploadCommandInput,
  type CreateUploadCommandOutput,
  CreateUploadCommand,
} from "./commands/CreateUploadCommand";
import {
  type DeleteAgentCommandInput,
  type DeleteAgentCommandOutput,
  DeleteAgentCommand,
} from "./commands/DeleteAgentCommand";
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
  type DeleteDocumentVersionCommandInput,
  type DeleteDocumentVersionCommandOutput,
  DeleteDocumentVersionCommand,
} from "./commands/DeleteDocumentVersionCommand";
import {
  type DeleteFieldCommandInput,
  type DeleteFieldCommandOutput,
  DeleteFieldCommand,
} from "./commands/DeleteFieldCommand";
import {
  type DeleteFolderCommandInput,
  type DeleteFolderCommandOutput,
  DeleteFolderCommand,
} from "./commands/DeleteFolderCommand";
import {
  type DeleteKnowledgeBaseCommandInput,
  type DeleteKnowledgeBaseCommandOutput,
  DeleteKnowledgeBaseCommand,
} from "./commands/DeleteKnowledgeBaseCommand";
import {
  type EnableLayoutAwareSearchCommandInput,
  type EnableLayoutAwareSearchCommandOutput,
  EnableLayoutAwareSearchCommand,
} from "./commands/EnableLayoutAwareSearchCommand";
import {
  type EstimateDocumentVersionCommandInput,
  type EstimateDocumentVersionCommandOutput,
  EstimateDocumentVersionCommand,
} from "./commands/EstimateDocumentVersionCommand";
import {
  type EstimateFillInFieldsCommandInput,
  type EstimateFillInFieldsCommandOutput,
  EstimateFillInFieldsCommand,
} from "./commands/EstimateFillInFieldsCommand";
import {
  type EstimateIngestionCommandInput,
  type EstimateIngestionCommandOutput,
  EstimateIngestionCommand,
} from "./commands/EstimateIngestionCommand";
import {
  type EstimateLayoutAwareSearchCommandInput,
  type EstimateLayoutAwareSearchCommandOutput,
  EstimateLayoutAwareSearchCommand,
} from "./commands/EstimateLayoutAwareSearchCommand";
import {
  type EstimateReprocessDocumentsCommandInput,
  type EstimateReprocessDocumentsCommandOutput,
  EstimateReprocessDocumentsCommand,
} from "./commands/EstimateReprocessDocumentsCommand";
import {
  type FillInFieldsCommandInput,
  type FillInFieldsCommandOutput,
  FillInFieldsCommand,
} from "./commands/FillInFieldsCommand";
import { type GetAccessCommandInput, type GetAccessCommandOutput, GetAccessCommand } from "./commands/GetAccessCommand";
import { type GetAgentCommandInput, type GetAgentCommandOutput, GetAgentCommand } from "./commands/GetAgentCommand";
import {
  type GetAgentVersionCommandInput,
  type GetAgentVersionCommandOutput,
  GetAgentVersionCommand,
} from "./commands/GetAgentVersionCommand";
import { type GetCallerCommandInput, type GetCallerCommandOutput, GetCallerCommand } from "./commands/GetCallerCommand";
import {
  type GetConversationCommandInput,
  type GetConversationCommandOutput,
  GetConversationCommand,
} from "./commands/GetConversationCommand";
import {
  type GetDocumentCommandInput,
  type GetDocumentCommandOutput,
  GetDocumentCommand,
} from "./commands/GetDocumentCommand";
import {
  type GetDocumentContentCommandInput,
  type GetDocumentContentCommandOutput,
  GetDocumentContentCommand,
} from "./commands/GetDocumentContentCommand";
import {
  type GetDocumentDownloadCommandInput,
  type GetDocumentDownloadCommandOutput,
  GetDocumentDownloadCommand,
} from "./commands/GetDocumentDownloadCommand";
import {
  type GetDocumentVersionCommandInput,
  type GetDocumentVersionCommandOutput,
  GetDocumentVersionCommand,
} from "./commands/GetDocumentVersionCommand";
import { type GetFieldCommandInput, type GetFieldCommandOutput, GetFieldCommand } from "./commands/GetFieldCommand";
import {
  type GetHistoryEntryCommandInput,
  type GetHistoryEntryCommandOutput,
  GetHistoryEntryCommand,
} from "./commands/GetHistoryEntryCommand";
import {
  type GetIngestionBatchCommandInput,
  type GetIngestionBatchCommandOutput,
  GetIngestionBatchCommand,
} from "./commands/GetIngestionBatchCommand";
import {
  type GetIngestionBatchItemCommandInput,
  type GetIngestionBatchItemCommandOutput,
  GetIngestionBatchItemCommand,
} from "./commands/GetIngestionBatchItemCommand";
import {
  type GetKnowledgeBaseCommandInput,
  type GetKnowledgeBaseCommandOutput,
  GetKnowledgeBaseCommand,
} from "./commands/GetKnowledgeBaseCommand";
import {
  type GetOperationCommandInput,
  type GetOperationCommandOutput,
  GetOperationCommand,
} from "./commands/GetOperationCommand";
import { type GetUploadCommandInput, type GetUploadCommandOutput, GetUploadCommand } from "./commands/GetUploadCommand";
import {
  type ListAgentsCommandInput,
  type ListAgentsCommandOutput,
  ListAgentsCommand,
} from "./commands/ListAgentsCommand";
import {
  type ListAgentVersionsCommandInput,
  type ListAgentVersionsCommandOutput,
  ListAgentVersionsCommand,
} from "./commands/ListAgentVersionsCommand";
import {
  type ListConversationsCommandInput,
  type ListConversationsCommandOutput,
  ListConversationsCommand,
} from "./commands/ListConversationsCommand";
import {
  type ListDocumentsCommandInput,
  type ListDocumentsCommandOutput,
  ListDocumentsCommand,
} from "./commands/ListDocumentsCommand";
import {
  type ListDocumentVersionsCommandInput,
  type ListDocumentVersionsCommandOutput,
  ListDocumentVersionsCommand,
} from "./commands/ListDocumentVersionsCommand";
import {
  type ListFieldsCommandInput,
  type ListFieldsCommandOutput,
  ListFieldsCommand,
} from "./commands/ListFieldsCommand";
import {
  type ListFoldersCommandInput,
  type ListFoldersCommandOutput,
  ListFoldersCommand,
} from "./commands/ListFoldersCommand";
import {
  type ListGuardrailsCommandInput,
  type ListGuardrailsCommandOutput,
  ListGuardrailsCommand,
} from "./commands/ListGuardrailsCommand";
import {
  type ListHistoryEntriesCommandInput,
  type ListHistoryEntriesCommandOutput,
  ListHistoryEntriesCommand,
} from "./commands/ListHistoryEntriesCommand";
import {
  type ListIngestionBatchesCommandInput,
  type ListIngestionBatchesCommandOutput,
  ListIngestionBatchesCommand,
} from "./commands/ListIngestionBatchesCommand";
import {
  type ListIngestionBatchItemsCommandInput,
  type ListIngestionBatchItemsCommandOutput,
  ListIngestionBatchItemsCommand,
} from "./commands/ListIngestionBatchItemsCommand";
import {
  type ListKnowledgeBasesCommandInput,
  type ListKnowledgeBasesCommandOutput,
  ListKnowledgeBasesCommand,
} from "./commands/ListKnowledgeBasesCommand";
import {
  type ListMemoryStoresCommandInput,
  type ListMemoryStoresCommandOutput,
  ListMemoryStoresCommand,
} from "./commands/ListMemoryStoresCommand";
import {
  type ListMessagesCommandInput,
  type ListMessagesCommandOutput,
  ListMessagesCommand,
} from "./commands/ListMessagesCommand";
import {
  type ListModelsCommandInput,
  type ListModelsCommandOutput,
  ListModelsCommand,
} from "./commands/ListModelsCommand";
import {
  type ListOperationsCommandInput,
  type ListOperationsCommandOutput,
  ListOperationsCommand,
} from "./commands/ListOperationsCommand";
import { type ListToolsCommandInput, type ListToolsCommandOutput, ListToolsCommand } from "./commands/ListToolsCommand";
import {
  type ListVoicesCommandInput,
  type ListVoicesCommandOutput,
  ListVoicesCommand,
} from "./commands/ListVoicesCommand";
import {
  type PublishAgentVersionCommandInput,
  type PublishAgentVersionCommandOutput,
  PublishAgentVersionCommand,
} from "./commands/PublishAgentVersionCommand";
import { type PutAccessCommandInput, type PutAccessCommandOutput, PutAccessCommand } from "./commands/PutAccessCommand";
import {
  type ReplaceDraftVersionCommandInput,
  type ReplaceDraftVersionCommandOutput,
  ReplaceDraftVersionCommand,
} from "./commands/ReplaceDraftVersionCommand";
import {
  type ReprocessDocumentsCommandInput,
  type ReprocessDocumentsCommandOutput,
  ReprocessDocumentsCommand,
} from "./commands/ReprocessDocumentsCommand";
import {
  type ResetDraftVersionCommandInput,
  type ResetDraftVersionCommandOutput,
  ResetDraftVersionCommand,
} from "./commands/ResetDraftVersionCommand";
import {
  type RetryDocumentCommandInput,
  type RetryDocumentCommandOutput,
  RetryDocumentCommand,
} from "./commands/RetryDocumentCommand";
import {
  type SaveDraftVersionCommandInput,
  type SaveDraftVersionCommandOutput,
  SaveDraftVersionCommand,
} from "./commands/SaveDraftVersionCommand";
import {
  type SendMessageCommandInput,
  type SendMessageCommandOutput,
  SendMessageCommand,
} from "./commands/SendMessageCommand";
import {
  type StartIngestionBatchCommandInput,
  type StartIngestionBatchCommandOutput,
  StartIngestionBatchCommand,
} from "./commands/StartIngestionBatchCommand";
import {
  type UpdateAgentCommandInput,
  type UpdateAgentCommandOutput,
  UpdateAgentCommand,
} from "./commands/UpdateAgentCommand";
import {
  type UpdateDocumentCommandInput,
  type UpdateDocumentCommandOutput,
  UpdateDocumentCommand,
} from "./commands/UpdateDocumentCommand";
import {
  type UpdateDraftVersionCommandInput,
  type UpdateDraftVersionCommandOutput,
  UpdateDraftVersionCommand,
} from "./commands/UpdateDraftVersionCommand";
import {
  type UpdateFieldCommandInput,
  type UpdateFieldCommandOutput,
  UpdateFieldCommand,
} from "./commands/UpdateFieldCommand";
import {
  type UpdateFolderCommandInput,
  type UpdateFolderCommandOutput,
  UpdateFolderCommand,
} from "./commands/UpdateFolderCommand";
import {
  type UpdateIngestionBatchCommandInput,
  type UpdateIngestionBatchCommandOutput,
  UpdateIngestionBatchCommand,
} from "./commands/UpdateIngestionBatchCommand";
import {
  type UpdateIngestionBatchItemCommandInput,
  type UpdateIngestionBatchItemCommandOutput,
  UpdateIngestionBatchItemCommand,
} from "./commands/UpdateIngestionBatchItemCommand";
import {
  type UpdateKnowledgeBaseCommandInput,
  type UpdateKnowledgeBaseCommandOutput,
  UpdateKnowledgeBaseCommand,
} from "./commands/UpdateKnowledgeBaseCommand";
import {
  type WatchConversationCommandInput,
  type WatchConversationCommandOutput,
  WatchConversationCommand,
} from "./commands/WatchConversationCommand";
import {
  type WatchKnowledgeBaseCommandInput,
  type WatchKnowledgeBaseCommandOutput,
  WatchKnowledgeBaseCommand,
} from "./commands/WatchKnowledgeBaseCommand";
import {
  type WatchOperationCommandInput,
  type WatchOperationCommandOutput,
  WatchOperationCommand,
} from "./commands/WatchOperationCommand";
import {
  type WatchWorkspaceEventsCommandInput,
  type WatchWorkspaceEventsCommandOutput,
  WatchWorkspaceEventsCommand,
} from "./commands/WatchWorkspaceEventsCommand";
import { paginateListAgents } from "./pagination/ListAgentsPaginator";
import { paginateListAgentVersions } from "./pagination/ListAgentVersionsPaginator";
import { paginateListConversations } from "./pagination/ListConversationsPaginator";
import { paginateListDocuments } from "./pagination/ListDocumentsPaginator";
import { paginateListDocumentVersions } from "./pagination/ListDocumentVersionsPaginator";
import { paginateListFields } from "./pagination/ListFieldsPaginator";
import { paginateListFolders } from "./pagination/ListFoldersPaginator";
import { paginateListGuardrails } from "./pagination/ListGuardrailsPaginator";
import { paginateListHistoryEntries } from "./pagination/ListHistoryEntriesPaginator";
import { paginateListIngestionBatches } from "./pagination/ListIngestionBatchesPaginator";
import { paginateListIngestionBatchItems } from "./pagination/ListIngestionBatchItemsPaginator";
import { paginateListKnowledgeBases } from "./pagination/ListKnowledgeBasesPaginator";
import { paginateListMemoryStores } from "./pagination/ListMemoryStoresPaginator";
import { paginateListMessages } from "./pagination/ListMessagesPaginator";
import { paginateListModels } from "./pagination/ListModelsPaginator";
import { paginateListOperations } from "./pagination/ListOperationsPaginator";
import { paginateListTools } from "./pagination/ListToolsPaginator";
import { paginateListVoices } from "./pagination/ListVoicesPaginator";

const commands = {
  BatchCreateIngestionBatchItemsCommand,
  BatchDeleteDocumentsCommand,
  CancelDocumentProcessingCommand,
  CancelIngestionBatchCommand,
  CancelOperationCommand,
  CompareAgentVersionsCommand,
  CompleteIngestionBatchUploadsCommand,
  CreateAgentCommand,
  CreateConversationCommand,
  CreateDocumentCommand,
  CreateDocumentVersionCommand,
  CreateFieldCommand,
  CreateFolderCommand,
  CreateIngestionBatchCommand,
  CreateIngestionBatchUploadPolicyCommand,
  CreateKnowledgeBaseCommand,
  CreateUploadCommand,
  DeleteAgentCommand,
  DeleteAgentVersionCommand,
  DeleteDocumentCommand,
  DeleteDocumentVersionCommand,
  DeleteFieldCommand,
  DeleteFolderCommand,
  DeleteKnowledgeBaseCommand,
  EnableLayoutAwareSearchCommand,
  EstimateDocumentVersionCommand,
  EstimateFillInFieldsCommand,
  EstimateIngestionCommand,
  EstimateLayoutAwareSearchCommand,
  EstimateReprocessDocumentsCommand,
  FillInFieldsCommand,
  GetAccessCommand,
  GetAgentCommand,
  GetAgentVersionCommand,
  GetCallerCommand,
  GetConversationCommand,
  GetDocumentCommand,
  GetDocumentContentCommand,
  GetDocumentDownloadCommand,
  GetDocumentVersionCommand,
  GetFieldCommand,
  GetHistoryEntryCommand,
  GetIngestionBatchCommand,
  GetIngestionBatchItemCommand,
  GetKnowledgeBaseCommand,
  GetOperationCommand,
  GetUploadCommand,
  ListAgentsCommand,
  ListAgentVersionsCommand,
  ListConversationsCommand,
  ListDocumentsCommand,
  ListDocumentVersionsCommand,
  ListFieldsCommand,
  ListFoldersCommand,
  ListGuardrailsCommand,
  ListHistoryEntriesCommand,
  ListIngestionBatchesCommand,
  ListIngestionBatchItemsCommand,
  ListKnowledgeBasesCommand,
  ListMemoryStoresCommand,
  ListMessagesCommand,
  ListModelsCommand,
  ListOperationsCommand,
  ListToolsCommand,
  ListVoicesCommand,
  PublishAgentVersionCommand,
  PutAccessCommand,
  ReplaceDraftVersionCommand,
  ReprocessDocumentsCommand,
  ResetDraftVersionCommand,
  RetryDocumentCommand,
  SaveDraftVersionCommand,
  SendMessageCommand,
  StartIngestionBatchCommand,
  UpdateAgentCommand,
  UpdateDocumentCommand,
  UpdateDraftVersionCommand,
  UpdateFieldCommand,
  UpdateFolderCommand,
  UpdateIngestionBatchCommand,
  UpdateIngestionBatchItemCommand,
  UpdateKnowledgeBaseCommand,
  WatchConversationCommand,
  WatchKnowledgeBaseCommand,
  WatchOperationCommand,
  WatchWorkspaceEventsCommand,
};
const paginators = {
  paginateListAgents,
  paginateListAgentVersions,
  paginateListConversations,
  paginateListDocuments,
  paginateListDocumentVersions,
  paginateListFields,
  paginateListFolders,
  paginateListGuardrails,
  paginateListHistoryEntries,
  paginateListIngestionBatches,
  paginateListIngestionBatchItems,
  paginateListKnowledgeBases,
  paginateListMemoryStores,
  paginateListMessages,
  paginateListModels,
  paginateListOperations,
  paginateListTools,
  paginateListVoices,
};

/**
 * @public
 */
export interface CaitlynRequestOptions extends __HttpHandlerOptions {
  metricsRecorder?: __MetricsRecorder<unknown>;
}

export interface Caitlyn {
  /**
   * @see {@link BatchCreateIngestionBatchItemsCommand}
   */
  batchCreateIngestionBatchItems(
    args: BatchCreateIngestionBatchItemsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<BatchCreateIngestionBatchItemsCommandOutput>;
  batchCreateIngestionBatchItems(
    args: BatchCreateIngestionBatchItemsCommandInput,
    cb: (err: any, data?: BatchCreateIngestionBatchItemsCommandOutput) => void
  ): void;
  batchCreateIngestionBatchItems(
    args: BatchCreateIngestionBatchItemsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: BatchCreateIngestionBatchItemsCommandOutput) => void
  ): void;

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
   * @see {@link CancelDocumentProcessingCommand}
   */
  cancelDocumentProcessing(
    args: CancelDocumentProcessingCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CancelDocumentProcessingCommandOutput>;
  cancelDocumentProcessing(
    args: CancelDocumentProcessingCommandInput,
    cb: (err: any, data?: CancelDocumentProcessingCommandOutput) => void
  ): void;
  cancelDocumentProcessing(
    args: CancelDocumentProcessingCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CancelDocumentProcessingCommandOutput) => void
  ): void;

  /**
   * @see {@link CancelIngestionBatchCommand}
   */
  cancelIngestionBatch(
    args: CancelIngestionBatchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CancelIngestionBatchCommandOutput>;
  cancelIngestionBatch(
    args: CancelIngestionBatchCommandInput,
    cb: (err: any, data?: CancelIngestionBatchCommandOutput) => void
  ): void;
  cancelIngestionBatch(
    args: CancelIngestionBatchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CancelIngestionBatchCommandOutput) => void
  ): void;

  /**
   * @see {@link CancelOperationCommand}
   */
  cancelOperation(
    args: CancelOperationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CancelOperationCommandOutput>;
  cancelOperation(
    args: CancelOperationCommandInput,
    cb: (err: any, data?: CancelOperationCommandOutput) => void
  ): void;
  cancelOperation(
    args: CancelOperationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CancelOperationCommandOutput) => void
  ): void;

  /**
   * @see {@link CompareAgentVersionsCommand}
   */
  compareAgentVersions(
    args: CompareAgentVersionsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CompareAgentVersionsCommandOutput>;
  compareAgentVersions(
    args: CompareAgentVersionsCommandInput,
    cb: (err: any, data?: CompareAgentVersionsCommandOutput) => void
  ): void;
  compareAgentVersions(
    args: CompareAgentVersionsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CompareAgentVersionsCommandOutput) => void
  ): void;

  /**
   * @see {@link CompleteIngestionBatchUploadsCommand}
   */
  completeIngestionBatchUploads(
    args: CompleteIngestionBatchUploadsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CompleteIngestionBatchUploadsCommandOutput>;
  completeIngestionBatchUploads(
    args: CompleteIngestionBatchUploadsCommandInput,
    cb: (err: any, data?: CompleteIngestionBatchUploadsCommandOutput) => void
  ): void;
  completeIngestionBatchUploads(
    args: CompleteIngestionBatchUploadsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CompleteIngestionBatchUploadsCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateAgentCommand}
   */
  createAgent(
    args: CreateAgentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateAgentCommandOutput>;
  createAgent(
    args: CreateAgentCommandInput,
    cb: (err: any, data?: CreateAgentCommandOutput) => void
  ): void;
  createAgent(
    args: CreateAgentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateAgentCommandOutput) => void
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
   * @see {@link CreateDocumentVersionCommand}
   */
  createDocumentVersion(
    args: CreateDocumentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateDocumentVersionCommandOutput>;
  createDocumentVersion(
    args: CreateDocumentVersionCommandInput,
    cb: (err: any, data?: CreateDocumentVersionCommandOutput) => void
  ): void;
  createDocumentVersion(
    args: CreateDocumentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateDocumentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateFieldCommand}
   */
  createField(
    args: CreateFieldCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateFieldCommandOutput>;
  createField(
    args: CreateFieldCommandInput,
    cb: (err: any, data?: CreateFieldCommandOutput) => void
  ): void;
  createField(
    args: CreateFieldCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateFieldCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateFolderCommand}
   */
  createFolder(
    args: CreateFolderCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateFolderCommandOutput>;
  createFolder(
    args: CreateFolderCommandInput,
    cb: (err: any, data?: CreateFolderCommandOutput) => void
  ): void;
  createFolder(
    args: CreateFolderCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateFolderCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateIngestionBatchCommand}
   */
  createIngestionBatch(
    args: CreateIngestionBatchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateIngestionBatchCommandOutput>;
  createIngestionBatch(
    args: CreateIngestionBatchCommandInput,
    cb: (err: any, data?: CreateIngestionBatchCommandOutput) => void
  ): void;
  createIngestionBatch(
    args: CreateIngestionBatchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateIngestionBatchCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateIngestionBatchUploadPolicyCommand}
   */
  createIngestionBatchUploadPolicy(
    args: CreateIngestionBatchUploadPolicyCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateIngestionBatchUploadPolicyCommandOutput>;
  createIngestionBatchUploadPolicy(
    args: CreateIngestionBatchUploadPolicyCommandInput,
    cb: (err: any, data?: CreateIngestionBatchUploadPolicyCommandOutput) => void
  ): void;
  createIngestionBatchUploadPolicy(
    args: CreateIngestionBatchUploadPolicyCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateIngestionBatchUploadPolicyCommandOutput) => void
  ): void;

  /**
   * @see {@link CreateKnowledgeBaseCommand}
   */
  createKnowledgeBase(
    args: CreateKnowledgeBaseCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<CreateKnowledgeBaseCommandOutput>;
  createKnowledgeBase(
    args: CreateKnowledgeBaseCommandInput,
    cb: (err: any, data?: CreateKnowledgeBaseCommandOutput) => void
  ): void;
  createKnowledgeBase(
    args: CreateKnowledgeBaseCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: CreateKnowledgeBaseCommandOutput) => void
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
   * @see {@link DeleteAgentCommand}
   */
  deleteAgent(
    args: DeleteAgentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteAgentCommandOutput>;
  deleteAgent(
    args: DeleteAgentCommandInput,
    cb: (err: any, data?: DeleteAgentCommandOutput) => void
  ): void;
  deleteAgent(
    args: DeleteAgentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteAgentCommandOutput) => void
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
   * @see {@link DeleteDocumentVersionCommand}
   */
  deleteDocumentVersion(
    args: DeleteDocumentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteDocumentVersionCommandOutput>;
  deleteDocumentVersion(
    args: DeleteDocumentVersionCommandInput,
    cb: (err: any, data?: DeleteDocumentVersionCommandOutput) => void
  ): void;
  deleteDocumentVersion(
    args: DeleteDocumentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteDocumentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link DeleteFieldCommand}
   */
  deleteField(
    args: DeleteFieldCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteFieldCommandOutput>;
  deleteField(
    args: DeleteFieldCommandInput,
    cb: (err: any, data?: DeleteFieldCommandOutput) => void
  ): void;
  deleteField(
    args: DeleteFieldCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteFieldCommandOutput) => void
  ): void;

  /**
   * @see {@link DeleteFolderCommand}
   */
  deleteFolder(
    args: DeleteFolderCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteFolderCommandOutput>;
  deleteFolder(
    args: DeleteFolderCommandInput,
    cb: (err: any, data?: DeleteFolderCommandOutput) => void
  ): void;
  deleteFolder(
    args: DeleteFolderCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteFolderCommandOutput) => void
  ): void;

  /**
   * @see {@link DeleteKnowledgeBaseCommand}
   */
  deleteKnowledgeBase(
    args: DeleteKnowledgeBaseCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<DeleteKnowledgeBaseCommandOutput>;
  deleteKnowledgeBase(
    args: DeleteKnowledgeBaseCommandInput,
    cb: (err: any, data?: DeleteKnowledgeBaseCommandOutput) => void
  ): void;
  deleteKnowledgeBase(
    args: DeleteKnowledgeBaseCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: DeleteKnowledgeBaseCommandOutput) => void
  ): void;

  /**
   * @see {@link EnableLayoutAwareSearchCommand}
   */
  enableLayoutAwareSearch(
    args: EnableLayoutAwareSearchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EnableLayoutAwareSearchCommandOutput>;
  enableLayoutAwareSearch(
    args: EnableLayoutAwareSearchCommandInput,
    cb: (err: any, data?: EnableLayoutAwareSearchCommandOutput) => void
  ): void;
  enableLayoutAwareSearch(
    args: EnableLayoutAwareSearchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EnableLayoutAwareSearchCommandOutput) => void
  ): void;

  /**
   * @see {@link EstimateDocumentVersionCommand}
   */
  estimateDocumentVersion(
    args: EstimateDocumentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EstimateDocumentVersionCommandOutput>;
  estimateDocumentVersion(
    args: EstimateDocumentVersionCommandInput,
    cb: (err: any, data?: EstimateDocumentVersionCommandOutput) => void
  ): void;
  estimateDocumentVersion(
    args: EstimateDocumentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EstimateDocumentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link EstimateFillInFieldsCommand}
   */
  estimateFillInFields(
    args: EstimateFillInFieldsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EstimateFillInFieldsCommandOutput>;
  estimateFillInFields(
    args: EstimateFillInFieldsCommandInput,
    cb: (err: any, data?: EstimateFillInFieldsCommandOutput) => void
  ): void;
  estimateFillInFields(
    args: EstimateFillInFieldsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EstimateFillInFieldsCommandOutput) => void
  ): void;

  /**
   * @see {@link EstimateIngestionCommand}
   */
  estimateIngestion(
    args: EstimateIngestionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EstimateIngestionCommandOutput>;
  estimateIngestion(
    args: EstimateIngestionCommandInput,
    cb: (err: any, data?: EstimateIngestionCommandOutput) => void
  ): void;
  estimateIngestion(
    args: EstimateIngestionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EstimateIngestionCommandOutput) => void
  ): void;

  /**
   * @see {@link EstimateLayoutAwareSearchCommand}
   */
  estimateLayoutAwareSearch(
    args: EstimateLayoutAwareSearchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EstimateLayoutAwareSearchCommandOutput>;
  estimateLayoutAwareSearch(
    args: EstimateLayoutAwareSearchCommandInput,
    cb: (err: any, data?: EstimateLayoutAwareSearchCommandOutput) => void
  ): void;
  estimateLayoutAwareSearch(
    args: EstimateLayoutAwareSearchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EstimateLayoutAwareSearchCommandOutput) => void
  ): void;

  /**
   * @see {@link EstimateReprocessDocumentsCommand}
   */
  estimateReprocessDocuments(
    args: EstimateReprocessDocumentsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<EstimateReprocessDocumentsCommandOutput>;
  estimateReprocessDocuments(
    args: EstimateReprocessDocumentsCommandInput,
    cb: (err: any, data?: EstimateReprocessDocumentsCommandOutput) => void
  ): void;
  estimateReprocessDocuments(
    args: EstimateReprocessDocumentsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: EstimateReprocessDocumentsCommandOutput) => void
  ): void;

  /**
   * @see {@link FillInFieldsCommand}
   */
  fillInFields(
    args: FillInFieldsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<FillInFieldsCommandOutput>;
  fillInFields(
    args: FillInFieldsCommandInput,
    cb: (err: any, data?: FillInFieldsCommandOutput) => void
  ): void;
  fillInFields(
    args: FillInFieldsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: FillInFieldsCommandOutput) => void
  ): void;

  /**
   * @see {@link GetAccessCommand}
   */
  getAccess(
    args: GetAccessCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetAccessCommandOutput>;
  getAccess(
    args: GetAccessCommandInput,
    cb: (err: any, data?: GetAccessCommandOutput) => void
  ): void;
  getAccess(
    args: GetAccessCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetAccessCommandOutput) => void
  ): void;

  /**
   * @see {@link GetAgentCommand}
   */
  getAgent(
    args: GetAgentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetAgentCommandOutput>;
  getAgent(
    args: GetAgentCommandInput,
    cb: (err: any, data?: GetAgentCommandOutput) => void
  ): void;
  getAgent(
    args: GetAgentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetAgentCommandOutput) => void
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
   * @see {@link GetConversationCommand}
   */
  getConversation(
    args: GetConversationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetConversationCommandOutput>;
  getConversation(
    args: GetConversationCommandInput,
    cb: (err: any, data?: GetConversationCommandOutput) => void
  ): void;
  getConversation(
    args: GetConversationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetConversationCommandOutput) => void
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
   * @see {@link GetDocumentContentCommand}
   */
  getDocumentContent(
    args: GetDocumentContentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetDocumentContentCommandOutput>;
  getDocumentContent(
    args: GetDocumentContentCommandInput,
    cb: (err: any, data?: GetDocumentContentCommandOutput) => void
  ): void;
  getDocumentContent(
    args: GetDocumentContentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetDocumentContentCommandOutput) => void
  ): void;

  /**
   * @see {@link GetDocumentDownloadCommand}
   */
  getDocumentDownload(
    args: GetDocumentDownloadCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetDocumentDownloadCommandOutput>;
  getDocumentDownload(
    args: GetDocumentDownloadCommandInput,
    cb: (err: any, data?: GetDocumentDownloadCommandOutput) => void
  ): void;
  getDocumentDownload(
    args: GetDocumentDownloadCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetDocumentDownloadCommandOutput) => void
  ): void;

  /**
   * @see {@link GetDocumentVersionCommand}
   */
  getDocumentVersion(
    args: GetDocumentVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetDocumentVersionCommandOutput>;
  getDocumentVersion(
    args: GetDocumentVersionCommandInput,
    cb: (err: any, data?: GetDocumentVersionCommandOutput) => void
  ): void;
  getDocumentVersion(
    args: GetDocumentVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetDocumentVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link GetFieldCommand}
   */
  getField(
    args: GetFieldCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetFieldCommandOutput>;
  getField(
    args: GetFieldCommandInput,
    cb: (err: any, data?: GetFieldCommandOutput) => void
  ): void;
  getField(
    args: GetFieldCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetFieldCommandOutput) => void
  ): void;

  /**
   * @see {@link GetHistoryEntryCommand}
   */
  getHistoryEntry(
    args: GetHistoryEntryCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetHistoryEntryCommandOutput>;
  getHistoryEntry(
    args: GetHistoryEntryCommandInput,
    cb: (err: any, data?: GetHistoryEntryCommandOutput) => void
  ): void;
  getHistoryEntry(
    args: GetHistoryEntryCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetHistoryEntryCommandOutput) => void
  ): void;

  /**
   * @see {@link GetIngestionBatchCommand}
   */
  getIngestionBatch(
    args: GetIngestionBatchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetIngestionBatchCommandOutput>;
  getIngestionBatch(
    args: GetIngestionBatchCommandInput,
    cb: (err: any, data?: GetIngestionBatchCommandOutput) => void
  ): void;
  getIngestionBatch(
    args: GetIngestionBatchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetIngestionBatchCommandOutput) => void
  ): void;

  /**
   * @see {@link GetIngestionBatchItemCommand}
   */
  getIngestionBatchItem(
    args: GetIngestionBatchItemCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetIngestionBatchItemCommandOutput>;
  getIngestionBatchItem(
    args: GetIngestionBatchItemCommandInput,
    cb: (err: any, data?: GetIngestionBatchItemCommandOutput) => void
  ): void;
  getIngestionBatchItem(
    args: GetIngestionBatchItemCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetIngestionBatchItemCommandOutput) => void
  ): void;

  /**
   * @see {@link GetKnowledgeBaseCommand}
   */
  getKnowledgeBase(
    args: GetKnowledgeBaseCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetKnowledgeBaseCommandOutput>;
  getKnowledgeBase(
    args: GetKnowledgeBaseCommandInput,
    cb: (err: any, data?: GetKnowledgeBaseCommandOutput) => void
  ): void;
  getKnowledgeBase(
    args: GetKnowledgeBaseCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetKnowledgeBaseCommandOutput) => void
  ): void;

  /**
   * @see {@link GetOperationCommand}
   */
  getOperation(
    args: GetOperationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<GetOperationCommandOutput>;
  getOperation(
    args: GetOperationCommandInput,
    cb: (err: any, data?: GetOperationCommandOutput) => void
  ): void;
  getOperation(
    args: GetOperationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: GetOperationCommandOutput) => void
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
   * @see {@link ListAgentsCommand}
   */
  listAgents(): Promise<ListAgentsCommandOutput>;
  listAgents(
    args: ListAgentsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListAgentsCommandOutput>;
  listAgents(
    args: ListAgentsCommandInput,
    cb: (err: any, data?: ListAgentsCommandOutput) => void
  ): void;
  listAgents(
    args: ListAgentsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListAgentsCommandOutput) => void
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
   * @see {@link ListConversationsCommand}
   */
  listConversations(
    args: ListConversationsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListConversationsCommandOutput>;
  listConversations(
    args: ListConversationsCommandInput,
    cb: (err: any, data?: ListConversationsCommandOutput) => void
  ): void;
  listConversations(
    args: ListConversationsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListConversationsCommandOutput) => void
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
   * @see {@link ListDocumentVersionsCommand}
   */
  listDocumentVersions(
    args: ListDocumentVersionsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListDocumentVersionsCommandOutput>;
  listDocumentVersions(
    args: ListDocumentVersionsCommandInput,
    cb: (err: any, data?: ListDocumentVersionsCommandOutput) => void
  ): void;
  listDocumentVersions(
    args: ListDocumentVersionsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListDocumentVersionsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListFieldsCommand}
   */
  listFields(
    args: ListFieldsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListFieldsCommandOutput>;
  listFields(
    args: ListFieldsCommandInput,
    cb: (err: any, data?: ListFieldsCommandOutput) => void
  ): void;
  listFields(
    args: ListFieldsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListFieldsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListFoldersCommand}
   */
  listFolders(
    args: ListFoldersCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListFoldersCommandOutput>;
  listFolders(
    args: ListFoldersCommandInput,
    cb: (err: any, data?: ListFoldersCommandOutput) => void
  ): void;
  listFolders(
    args: ListFoldersCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListFoldersCommandOutput) => void
  ): void;

  /**
   * @see {@link ListGuardrailsCommand}
   */
  listGuardrails(): Promise<ListGuardrailsCommandOutput>;
  listGuardrails(
    args: ListGuardrailsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListGuardrailsCommandOutput>;
  listGuardrails(
    args: ListGuardrailsCommandInput,
    cb: (err: any, data?: ListGuardrailsCommandOutput) => void
  ): void;
  listGuardrails(
    args: ListGuardrailsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListGuardrailsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListHistoryEntriesCommand}
   */
  listHistoryEntries(
    args: ListHistoryEntriesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListHistoryEntriesCommandOutput>;
  listHistoryEntries(
    args: ListHistoryEntriesCommandInput,
    cb: (err: any, data?: ListHistoryEntriesCommandOutput) => void
  ): void;
  listHistoryEntries(
    args: ListHistoryEntriesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListHistoryEntriesCommandOutput) => void
  ): void;

  /**
   * @see {@link ListIngestionBatchesCommand}
   */
  listIngestionBatches(
    args: ListIngestionBatchesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListIngestionBatchesCommandOutput>;
  listIngestionBatches(
    args: ListIngestionBatchesCommandInput,
    cb: (err: any, data?: ListIngestionBatchesCommandOutput) => void
  ): void;
  listIngestionBatches(
    args: ListIngestionBatchesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListIngestionBatchesCommandOutput) => void
  ): void;

  /**
   * @see {@link ListIngestionBatchItemsCommand}
   */
  listIngestionBatchItems(
    args: ListIngestionBatchItemsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListIngestionBatchItemsCommandOutput>;
  listIngestionBatchItems(
    args: ListIngestionBatchItemsCommandInput,
    cb: (err: any, data?: ListIngestionBatchItemsCommandOutput) => void
  ): void;
  listIngestionBatchItems(
    args: ListIngestionBatchItemsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListIngestionBatchItemsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListKnowledgeBasesCommand}
   */
  listKnowledgeBases(): Promise<ListKnowledgeBasesCommandOutput>;
  listKnowledgeBases(
    args: ListKnowledgeBasesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListKnowledgeBasesCommandOutput>;
  listKnowledgeBases(
    args: ListKnowledgeBasesCommandInput,
    cb: (err: any, data?: ListKnowledgeBasesCommandOutput) => void
  ): void;
  listKnowledgeBases(
    args: ListKnowledgeBasesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListKnowledgeBasesCommandOutput) => void
  ): void;

  /**
   * @see {@link ListMemoryStoresCommand}
   */
  listMemoryStores(): Promise<ListMemoryStoresCommandOutput>;
  listMemoryStores(
    args: ListMemoryStoresCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListMemoryStoresCommandOutput>;
  listMemoryStores(
    args: ListMemoryStoresCommandInput,
    cb: (err: any, data?: ListMemoryStoresCommandOutput) => void
  ): void;
  listMemoryStores(
    args: ListMemoryStoresCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListMemoryStoresCommandOutput) => void
  ): void;

  /**
   * @see {@link ListMessagesCommand}
   */
  listMessages(
    args: ListMessagesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListMessagesCommandOutput>;
  listMessages(
    args: ListMessagesCommandInput,
    cb: (err: any, data?: ListMessagesCommandOutput) => void
  ): void;
  listMessages(
    args: ListMessagesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListMessagesCommandOutput) => void
  ): void;

  /**
   * @see {@link ListModelsCommand}
   */
  listModels(): Promise<ListModelsCommandOutput>;
  listModels(
    args: ListModelsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListModelsCommandOutput>;
  listModels(
    args: ListModelsCommandInput,
    cb: (err: any, data?: ListModelsCommandOutput) => void
  ): void;
  listModels(
    args: ListModelsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListModelsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListOperationsCommand}
   */
  listOperations(
    args: ListOperationsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListOperationsCommandOutput>;
  listOperations(
    args: ListOperationsCommandInput,
    cb: (err: any, data?: ListOperationsCommandOutput) => void
  ): void;
  listOperations(
    args: ListOperationsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListOperationsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListToolsCommand}
   */
  listTools(): Promise<ListToolsCommandOutput>;
  listTools(
    args: ListToolsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListToolsCommandOutput>;
  listTools(
    args: ListToolsCommandInput,
    cb: (err: any, data?: ListToolsCommandOutput) => void
  ): void;
  listTools(
    args: ListToolsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListToolsCommandOutput) => void
  ): void;

  /**
   * @see {@link ListVoicesCommand}
   */
  listVoices(): Promise<ListVoicesCommandOutput>;
  listVoices(
    args: ListVoicesCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ListVoicesCommandOutput>;
  listVoices(
    args: ListVoicesCommandInput,
    cb: (err: any, data?: ListVoicesCommandOutput) => void
  ): void;
  listVoices(
    args: ListVoicesCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ListVoicesCommandOutput) => void
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
   * @see {@link PutAccessCommand}
   */
  putAccess(
    args: PutAccessCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<PutAccessCommandOutput>;
  putAccess(
    args: PutAccessCommandInput,
    cb: (err: any, data?: PutAccessCommandOutput) => void
  ): void;
  putAccess(
    args: PutAccessCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: PutAccessCommandOutput) => void
  ): void;

  /**
   * @see {@link ReplaceDraftVersionCommand}
   */
  replaceDraftVersion(
    args: ReplaceDraftVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ReplaceDraftVersionCommandOutput>;
  replaceDraftVersion(
    args: ReplaceDraftVersionCommandInput,
    cb: (err: any, data?: ReplaceDraftVersionCommandOutput) => void
  ): void;
  replaceDraftVersion(
    args: ReplaceDraftVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ReplaceDraftVersionCommandOutput) => void
  ): void;

  /**
   * @see {@link ReprocessDocumentsCommand}
   */
  reprocessDocuments(
    args: ReprocessDocumentsCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ReprocessDocumentsCommandOutput>;
  reprocessDocuments(
    args: ReprocessDocumentsCommandInput,
    cb: (err: any, data?: ReprocessDocumentsCommandOutput) => void
  ): void;
  reprocessDocuments(
    args: ReprocessDocumentsCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ReprocessDocumentsCommandOutput) => void
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
   * @see {@link RetryDocumentCommand}
   */
  retryDocument(
    args: RetryDocumentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<RetryDocumentCommandOutput>;
  retryDocument(
    args: RetryDocumentCommandInput,
    cb: (err: any, data?: RetryDocumentCommandOutput) => void
  ): void;
  retryDocument(
    args: RetryDocumentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: RetryDocumentCommandOutput) => void
  ): void;

  /**
   * @see {@link SaveDraftVersionCommand}
   */
  saveDraftVersion(
    args: SaveDraftVersionCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<SaveDraftVersionCommandOutput>;
  saveDraftVersion(
    args: SaveDraftVersionCommandInput,
    cb: (err: any, data?: SaveDraftVersionCommandOutput) => void
  ): void;
  saveDraftVersion(
    args: SaveDraftVersionCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: SaveDraftVersionCommandOutput) => void
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
   * @see {@link StartIngestionBatchCommand}
   */
  startIngestionBatch(
    args: StartIngestionBatchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<StartIngestionBatchCommandOutput>;
  startIngestionBatch(
    args: StartIngestionBatchCommandInput,
    cb: (err: any, data?: StartIngestionBatchCommandOutput) => void
  ): void;
  startIngestionBatch(
    args: StartIngestionBatchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: StartIngestionBatchCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateAgentCommand}
   */
  updateAgent(
    args: UpdateAgentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateAgentCommandOutput>;
  updateAgent(
    args: UpdateAgentCommandInput,
    cb: (err: any, data?: UpdateAgentCommandOutput) => void
  ): void;
  updateAgent(
    args: UpdateAgentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateAgentCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateDocumentCommand}
   */
  updateDocument(
    args: UpdateDocumentCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateDocumentCommandOutput>;
  updateDocument(
    args: UpdateDocumentCommandInput,
    cb: (err: any, data?: UpdateDocumentCommandOutput) => void
  ): void;
  updateDocument(
    args: UpdateDocumentCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateDocumentCommandOutput) => void
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
   * @see {@link UpdateFieldCommand}
   */
  updateField(
    args: UpdateFieldCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateFieldCommandOutput>;
  updateField(
    args: UpdateFieldCommandInput,
    cb: (err: any, data?: UpdateFieldCommandOutput) => void
  ): void;
  updateField(
    args: UpdateFieldCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateFieldCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateFolderCommand}
   */
  updateFolder(
    args: UpdateFolderCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateFolderCommandOutput>;
  updateFolder(
    args: UpdateFolderCommandInput,
    cb: (err: any, data?: UpdateFolderCommandOutput) => void
  ): void;
  updateFolder(
    args: UpdateFolderCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateFolderCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateIngestionBatchCommand}
   */
  updateIngestionBatch(
    args: UpdateIngestionBatchCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateIngestionBatchCommandOutput>;
  updateIngestionBatch(
    args: UpdateIngestionBatchCommandInput,
    cb: (err: any, data?: UpdateIngestionBatchCommandOutput) => void
  ): void;
  updateIngestionBatch(
    args: UpdateIngestionBatchCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateIngestionBatchCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateIngestionBatchItemCommand}
   */
  updateIngestionBatchItem(
    args: UpdateIngestionBatchItemCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateIngestionBatchItemCommandOutput>;
  updateIngestionBatchItem(
    args: UpdateIngestionBatchItemCommandInput,
    cb: (err: any, data?: UpdateIngestionBatchItemCommandOutput) => void
  ): void;
  updateIngestionBatchItem(
    args: UpdateIngestionBatchItemCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateIngestionBatchItemCommandOutput) => void
  ): void;

  /**
   * @see {@link UpdateKnowledgeBaseCommand}
   */
  updateKnowledgeBase(
    args: UpdateKnowledgeBaseCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<UpdateKnowledgeBaseCommandOutput>;
  updateKnowledgeBase(
    args: UpdateKnowledgeBaseCommandInput,
    cb: (err: any, data?: UpdateKnowledgeBaseCommandOutput) => void
  ): void;
  updateKnowledgeBase(
    args: UpdateKnowledgeBaseCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: UpdateKnowledgeBaseCommandOutput) => void
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
   * @see {@link WatchKnowledgeBaseCommand}
   */
  watchKnowledgeBase(
    args: WatchKnowledgeBaseCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<WatchKnowledgeBaseCommandOutput>;
  watchKnowledgeBase(
    args: WatchKnowledgeBaseCommandInput,
    cb: (err: any, data?: WatchKnowledgeBaseCommandOutput) => void
  ): void;
  watchKnowledgeBase(
    args: WatchKnowledgeBaseCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: WatchKnowledgeBaseCommandOutput) => void
  ): void;

  /**
   * @see {@link WatchOperationCommand}
   */
  watchOperation(
    args: WatchOperationCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<WatchOperationCommandOutput>;
  watchOperation(
    args: WatchOperationCommandInput,
    cb: (err: any, data?: WatchOperationCommandOutput) => void
  ): void;
  watchOperation(
    args: WatchOperationCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: WatchOperationCommandOutput) => void
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
   * @see {@link ListAgentsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListAgentsCommandOutput}.
   */
  paginateListAgents(
    args?: ListAgentsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListAgentsCommandOutput>;

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
   * @see {@link ListConversationsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListConversationsCommandOutput}.
   */
  paginateListConversations(
    args: ListConversationsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListConversationsCommandOutput>;

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
   * @see {@link ListDocumentVersionsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListDocumentVersionsCommandOutput}.
   */
  paginateListDocumentVersions(
    args: ListDocumentVersionsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListDocumentVersionsCommandOutput>;

  /**
   * @see {@link ListFieldsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListFieldsCommandOutput}.
   */
  paginateListFields(
    args: ListFieldsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListFieldsCommandOutput>;

  /**
   * @see {@link ListFoldersCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListFoldersCommandOutput}.
   */
  paginateListFolders(
    args: ListFoldersCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListFoldersCommandOutput>;

  /**
   * @see {@link ListGuardrailsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListGuardrailsCommandOutput}.
   */
  paginateListGuardrails(
    args?: ListGuardrailsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListGuardrailsCommandOutput>;

  /**
   * @see {@link ListHistoryEntriesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListHistoryEntriesCommandOutput}.
   */
  paginateListHistoryEntries(
    args: ListHistoryEntriesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListHistoryEntriesCommandOutput>;

  /**
   * @see {@link ListIngestionBatchesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListIngestionBatchesCommandOutput}.
   */
  paginateListIngestionBatches(
    args: ListIngestionBatchesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListIngestionBatchesCommandOutput>;

  /**
   * @see {@link ListIngestionBatchItemsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListIngestionBatchItemsCommandOutput}.
   */
  paginateListIngestionBatchItems(
    args: ListIngestionBatchItemsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListIngestionBatchItemsCommandOutput>;

  /**
   * @see {@link ListKnowledgeBasesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListKnowledgeBasesCommandOutput}.
   */
  paginateListKnowledgeBases(
    args?: ListKnowledgeBasesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListKnowledgeBasesCommandOutput>;

  /**
   * @see {@link ListMemoryStoresCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListMemoryStoresCommandOutput}.
   */
  paginateListMemoryStores(
    args?: ListMemoryStoresCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListMemoryStoresCommandOutput>;

  /**
   * @see {@link ListMessagesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListMessagesCommandOutput}.
   */
  paginateListMessages(
    args: ListMessagesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListMessagesCommandOutput>;

  /**
   * @see {@link ListModelsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListModelsCommandOutput}.
   */
  paginateListModels(
    args?: ListModelsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListModelsCommandOutput>;

  /**
   * @see {@link ListOperationsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListOperationsCommandOutput}.
   */
  paginateListOperations(
    args: ListOperationsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListOperationsCommandOutput>;

  /**
   * @see {@link ListToolsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListToolsCommandOutput}.
   */
  paginateListTools(
    args?: ListToolsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListToolsCommandOutput>;

  /**
   * @see {@link ListVoicesCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListVoicesCommandOutput}.
   */
  paginateListVoices(
    args?: ListVoicesCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListVoicesCommandOutput>;
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
