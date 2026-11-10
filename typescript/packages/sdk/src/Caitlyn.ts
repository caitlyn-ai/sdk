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
  type GetAgentVersionCommandInput,
  type GetAgentVersionCommandOutput,
  GetAgentVersionCommand,
} from "./commands/GetAgentVersionCommand";
import {
  type ListDocumentsCommandInput,
  type ListDocumentsCommandOutput,
  ListDocumentsCommand,
} from "./commands/ListDocumentsCommand";
import {
  type ResumeConversationStreamCommandInput,
  type ResumeConversationStreamCommandOutput,
  ResumeConversationStreamCommand,
} from "./commands/ResumeConversationStreamCommand";
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
import { paginateListDocuments } from "./pagination/ListDocumentsPaginator";

const commands = {
  CreateDocumentCommand,
  CreateUploadCommand,
  GetAgentVersionCommand,
  ListDocumentsCommand,
  ResumeConversationStreamCommand,
  SendMessageCommand,
  UpdateDraftVersionCommand,
};
const paginators = {
  paginateListDocuments,
};

/**
 * @public
 */
export interface CaitlynRequestOptions extends __HttpHandlerOptions {
  metricsRecorder?: __MetricsRecorder<unknown>;
}

export interface Caitlyn {
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
   * @see {@link ResumeConversationStreamCommand}
   */
  resumeConversationStream(
    args: ResumeConversationStreamCommandInput,
    options?: CaitlynRequestOptions
  ): Promise<ResumeConversationStreamCommandOutput>;
  resumeConversationStream(
    args: ResumeConversationStreamCommandInput,
    cb: (err: any, data?: ResumeConversationStreamCommandOutput) => void
  ): void;
  resumeConversationStream(
    args: ResumeConversationStreamCommandInput,
    options: CaitlynRequestOptions,
    cb: (err: any, data?: ResumeConversationStreamCommandOutput) => void
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
   * @see {@link ListDocumentsCommand}
   * @param args - command input.
   * @param paginationConfig - optional pagination config.
   * @returns AsyncIterable of {@link ListDocumentsCommandOutput}.
   */
  paginateListDocuments(
    args: ListDocumentsCommandInput,
    paginationConfig?: Omit<PaginationConfiguration, "client">
  ): Paginator<ListDocumentsCommandOutput>;
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
