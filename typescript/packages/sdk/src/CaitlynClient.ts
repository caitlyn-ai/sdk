// smithy-typescript generated code
import { getCaitlynSdkPlugin } from "@caitlyn-ai/sdk-core";
import {
  DefaultIdentityProviderConfig,
  getHttpAuthSchemeEndpointRuleSetPlugin,
  getHttpSigningPlugin,
} from "@smithy/core";
import {
  type DefaultsMode as __DefaultsMode,
  type SmithyConfiguration as __SmithyConfiguration,
  type SmithyResolvedConfiguration as __SmithyResolvedConfiguration,
  Client as __Client,
} from "@smithy/core/client";
import {
  type EndpointInputConfig,
  type EndpointRequiredInputConfig,
  type EndpointRequiredResolvedConfig,
  type EndpointResolvedConfig,
  resolveEndpointConfig,
  resolveEndpointRequiredConfig,
} from "@smithy/core/endpoints";
import { type HttpHandlerUserInput as __HttpHandlerUserInput, getContentLengthPlugin } from "@smithy/core/protocols";
import {
  type RetryInputConfig,
  type RetryResolvedConfig,
  getRetryPlugin,
  resolveRetryConfig,
} from "@smithy/core/retry";
import { getSchemaSerdePlugin } from "@smithy/core/schema";
import type {
  BodyLengthCalculator as __BodyLengthCalculator,
  CheckOptionalClientConfig as __CheckOptionalClientConfig,
  ChecksumConstructor as __ChecksumConstructor,
  Decoder as __Decoder,
  Encoder as __Encoder,
  HashConstructor as __HashConstructor,
  HttpHandlerOptions as __HttpHandlerOptions,
  Logger as __Logger,
  Provider as __Provider,
  SdkStreamMixinInjector as __SdkStreamMixinInjector,
  StreamCollector as __StreamCollector,
  UrlParser as __UrlParser,
} from "@smithy/types";

import {
  type HttpAuthSchemeInputConfig,
  type HttpAuthSchemeResolvedConfig,
  defaultCaitlynHttpAuthSchemeParametersProvider,
  resolveHttpAuthSchemeConfig,
} from "./auth/httpAuthSchemeProvider";
import type {
  BatchCreateIngestionBatchItemsCommandInput,
  BatchCreateIngestionBatchItemsCommandOutput,
} from "./commands/BatchCreateIngestionBatchItemsCommand";
import type {
  BatchDeleteDocumentsCommandInput,
  BatchDeleteDocumentsCommandOutput,
} from "./commands/BatchDeleteDocumentsCommand";
import type {
  CancelDocumentProcessingCommandInput,
  CancelDocumentProcessingCommandOutput,
} from "./commands/CancelDocumentProcessingCommand";
import type {
  CancelIngestionBatchCommandInput,
  CancelIngestionBatchCommandOutput,
} from "./commands/CancelIngestionBatchCommand";
import type { CancelOperationCommandInput, CancelOperationCommandOutput } from "./commands/CancelOperationCommand";
import type {
  CompareAgentVersionsCommandInput,
  CompareAgentVersionsCommandOutput,
} from "./commands/CompareAgentVersionsCommand";
import type {
  CompleteIngestionBatchUploadsCommandInput,
  CompleteIngestionBatchUploadsCommandOutput,
} from "./commands/CompleteIngestionBatchUploadsCommand";
import type { CreateAgentCommandInput, CreateAgentCommandOutput } from "./commands/CreateAgentCommand";
import type {
  CreateConversationCommandInput,
  CreateConversationCommandOutput,
} from "./commands/CreateConversationCommand";
import type { CreateDocumentCommandInput, CreateDocumentCommandOutput } from "./commands/CreateDocumentCommand";
import type {
  CreateDocumentVersionCommandInput,
  CreateDocumentVersionCommandOutput,
} from "./commands/CreateDocumentVersionCommand";
import type { CreateFieldCommandInput, CreateFieldCommandOutput } from "./commands/CreateFieldCommand";
import type { CreateFolderCommandInput, CreateFolderCommandOutput } from "./commands/CreateFolderCommand";
import type {
  CreateIngestionBatchCommandInput,
  CreateIngestionBatchCommandOutput,
} from "./commands/CreateIngestionBatchCommand";
import type {
  CreateIngestionBatchUploadPolicyCommandInput,
  CreateIngestionBatchUploadPolicyCommandOutput,
} from "./commands/CreateIngestionBatchUploadPolicyCommand";
import type {
  CreateKnowledgeBaseCommandInput,
  CreateKnowledgeBaseCommandOutput,
} from "./commands/CreateKnowledgeBaseCommand";
import type { CreateUploadCommandInput, CreateUploadCommandOutput } from "./commands/CreateUploadCommand";
import type { DeleteAgentCommandInput, DeleteAgentCommandOutput } from "./commands/DeleteAgentCommand";
import type {
  DeleteAgentVersionCommandInput,
  DeleteAgentVersionCommandOutput,
} from "./commands/DeleteAgentVersionCommand";
import type { DeleteDocumentCommandInput, DeleteDocumentCommandOutput } from "./commands/DeleteDocumentCommand";
import type {
  DeleteDocumentVersionCommandInput,
  DeleteDocumentVersionCommandOutput,
} from "./commands/DeleteDocumentVersionCommand";
import type { DeleteFieldCommandInput, DeleteFieldCommandOutput } from "./commands/DeleteFieldCommand";
import type { DeleteFolderCommandInput, DeleteFolderCommandOutput } from "./commands/DeleteFolderCommand";
import type {
  DeleteKnowledgeBaseCommandInput,
  DeleteKnowledgeBaseCommandOutput,
} from "./commands/DeleteKnowledgeBaseCommand";
import type {
  EnableLayoutAwareSearchCommandInput,
  EnableLayoutAwareSearchCommandOutput,
} from "./commands/EnableLayoutAwareSearchCommand";
import type {
  EstimateDocumentVersionCommandInput,
  EstimateDocumentVersionCommandOutput,
} from "./commands/EstimateDocumentVersionCommand";
import type {
  EstimateFillInFieldsCommandInput,
  EstimateFillInFieldsCommandOutput,
} from "./commands/EstimateFillInFieldsCommand";
import type {
  EstimateIngestionCommandInput,
  EstimateIngestionCommandOutput,
} from "./commands/EstimateIngestionCommand";
import type {
  EstimateLayoutAwareSearchCommandInput,
  EstimateLayoutAwareSearchCommandOutput,
} from "./commands/EstimateLayoutAwareSearchCommand";
import type {
  EstimateReprocessDocumentsCommandInput,
  EstimateReprocessDocumentsCommandOutput,
} from "./commands/EstimateReprocessDocumentsCommand";
import type { FillInFieldsCommandInput, FillInFieldsCommandOutput } from "./commands/FillInFieldsCommand";
import type { GetAccessCommandInput, GetAccessCommandOutput } from "./commands/GetAccessCommand";
import type { GetAgentCommandInput, GetAgentCommandOutput } from "./commands/GetAgentCommand";
import type { GetAgentVersionCommandInput, GetAgentVersionCommandOutput } from "./commands/GetAgentVersionCommand";
import type { GetCallerCommandInput, GetCallerCommandOutput } from "./commands/GetCallerCommand";
import type { GetConversationCommandInput, GetConversationCommandOutput } from "./commands/GetConversationCommand";
import type { GetDocumentCommandInput, GetDocumentCommandOutput } from "./commands/GetDocumentCommand";
import type {
  GetDocumentContentCommandInput,
  GetDocumentContentCommandOutput,
} from "./commands/GetDocumentContentCommand";
import type {
  GetDocumentDownloadCommandInput,
  GetDocumentDownloadCommandOutput,
} from "./commands/GetDocumentDownloadCommand";
import type {
  GetDocumentVersionCommandInput,
  GetDocumentVersionCommandOutput,
} from "./commands/GetDocumentVersionCommand";
import type { GetFieldCommandInput, GetFieldCommandOutput } from "./commands/GetFieldCommand";
import type { GetHistoryEntryCommandInput, GetHistoryEntryCommandOutput } from "./commands/GetHistoryEntryCommand";
import type {
  GetIngestionBatchCommandInput,
  GetIngestionBatchCommandOutput,
} from "./commands/GetIngestionBatchCommand";
import type {
  GetIngestionBatchItemCommandInput,
  GetIngestionBatchItemCommandOutput,
} from "./commands/GetIngestionBatchItemCommand";
import type { GetKnowledgeBaseCommandInput, GetKnowledgeBaseCommandOutput } from "./commands/GetKnowledgeBaseCommand";
import type { GetOperationCommandInput, GetOperationCommandOutput } from "./commands/GetOperationCommand";
import type { GetUploadCommandInput, GetUploadCommandOutput } from "./commands/GetUploadCommand";
import type { ListAgentsCommandInput, ListAgentsCommandOutput } from "./commands/ListAgentsCommand";
import type {
  ListAgentVersionsCommandInput,
  ListAgentVersionsCommandOutput,
} from "./commands/ListAgentVersionsCommand";
import type {
  ListConversationsCommandInput,
  ListConversationsCommandOutput,
} from "./commands/ListConversationsCommand";
import type { ListDocumentsCommandInput, ListDocumentsCommandOutput } from "./commands/ListDocumentsCommand";
import type {
  ListDocumentVersionsCommandInput,
  ListDocumentVersionsCommandOutput,
} from "./commands/ListDocumentVersionsCommand";
import type { ListFieldsCommandInput, ListFieldsCommandOutput } from "./commands/ListFieldsCommand";
import type { ListFoldersCommandInput, ListFoldersCommandOutput } from "./commands/ListFoldersCommand";
import type { ListGuardrailsCommandInput, ListGuardrailsCommandOutput } from "./commands/ListGuardrailsCommand";
import type {
  ListHistoryEntriesCommandInput,
  ListHistoryEntriesCommandOutput,
} from "./commands/ListHistoryEntriesCommand";
import type {
  ListIngestionBatchesCommandInput,
  ListIngestionBatchesCommandOutput,
} from "./commands/ListIngestionBatchesCommand";
import type {
  ListIngestionBatchItemsCommandInput,
  ListIngestionBatchItemsCommandOutput,
} from "./commands/ListIngestionBatchItemsCommand";
import type {
  ListKnowledgeBasesCommandInput,
  ListKnowledgeBasesCommandOutput,
} from "./commands/ListKnowledgeBasesCommand";
import type { ListMemoryStoresCommandInput, ListMemoryStoresCommandOutput } from "./commands/ListMemoryStoresCommand";
import type { ListMessagesCommandInput, ListMessagesCommandOutput } from "./commands/ListMessagesCommand";
import type { ListModelsCommandInput, ListModelsCommandOutput } from "./commands/ListModelsCommand";
import type { ListOperationsCommandInput, ListOperationsCommandOutput } from "./commands/ListOperationsCommand";
import type { ListToolsCommandInput, ListToolsCommandOutput } from "./commands/ListToolsCommand";
import type { ListVoicesCommandInput, ListVoicesCommandOutput } from "./commands/ListVoicesCommand";
import type {
  PublishAgentVersionCommandInput,
  PublishAgentVersionCommandOutput,
} from "./commands/PublishAgentVersionCommand";
import type { PutAccessCommandInput, PutAccessCommandOutput } from "./commands/PutAccessCommand";
import type {
  ReplaceDraftVersionCommandInput,
  ReplaceDraftVersionCommandOutput,
} from "./commands/ReplaceDraftVersionCommand";
import type {
  ReprocessDocumentsCommandInput,
  ReprocessDocumentsCommandOutput,
} from "./commands/ReprocessDocumentsCommand";
import type {
  ResetDraftVersionCommandInput,
  ResetDraftVersionCommandOutput,
} from "./commands/ResetDraftVersionCommand";
import type { RetryDocumentCommandInput, RetryDocumentCommandOutput } from "./commands/RetryDocumentCommand";
import type { SaveDraftVersionCommandInput, SaveDraftVersionCommandOutput } from "./commands/SaveDraftVersionCommand";
import type { SendMessageCommandInput, SendMessageCommandOutput } from "./commands/SendMessageCommand";
import type {
  StartIngestionBatchCommandInput,
  StartIngestionBatchCommandOutput,
} from "./commands/StartIngestionBatchCommand";
import type { UpdateAgentCommandInput, UpdateAgentCommandOutput } from "./commands/UpdateAgentCommand";
import type { UpdateDocumentCommandInput, UpdateDocumentCommandOutput } from "./commands/UpdateDocumentCommand";
import type {
  UpdateDraftVersionCommandInput,
  UpdateDraftVersionCommandOutput,
} from "./commands/UpdateDraftVersionCommand";
import type { UpdateFieldCommandInput, UpdateFieldCommandOutput } from "./commands/UpdateFieldCommand";
import type { UpdateFolderCommandInput, UpdateFolderCommandOutput } from "./commands/UpdateFolderCommand";
import type {
  UpdateIngestionBatchCommandInput,
  UpdateIngestionBatchCommandOutput,
} from "./commands/UpdateIngestionBatchCommand";
import type {
  UpdateIngestionBatchItemCommandInput,
  UpdateIngestionBatchItemCommandOutput,
} from "./commands/UpdateIngestionBatchItemCommand";
import type {
  UpdateKnowledgeBaseCommandInput,
  UpdateKnowledgeBaseCommandOutput,
} from "./commands/UpdateKnowledgeBaseCommand";
import type {
  WatchConversationCommandInput,
  WatchConversationCommandOutput,
} from "./commands/WatchConversationCommand";
import type {
  WatchKnowledgeBaseCommandInput,
  WatchKnowledgeBaseCommandOutput,
} from "./commands/WatchKnowledgeBaseCommand";
import type { WatchOperationCommandInput, WatchOperationCommandOutput } from "./commands/WatchOperationCommand";
import type {
  WatchWorkspaceEventsCommandInput,
  WatchWorkspaceEventsCommandOutput,
} from "./commands/WatchWorkspaceEventsCommand";
import {
  type ClientInputEndpointParameters,
  type ClientResolvedEndpointParameters,
  type EndpointParameters,
  resolveClientEndpointParameters,
} from "./endpoint/EndpointParameters";
import { getRuntimeConfig as __getRuntimeConfig } from "./runtimeConfig";
import { type RuntimeExtension, type RuntimeExtensionsConfig, resolveRuntimeExtensions } from "./runtimeExtensions";

export { __Client };

/**
 * @public
 */
export type ServiceInputTypes =
  | BatchCreateIngestionBatchItemsCommandInput
  | BatchDeleteDocumentsCommandInput
  | CancelDocumentProcessingCommandInput
  | CancelIngestionBatchCommandInput
  | CancelOperationCommandInput
  | CompareAgentVersionsCommandInput
  | CompleteIngestionBatchUploadsCommandInput
  | CreateAgentCommandInput
  | CreateConversationCommandInput
  | CreateDocumentCommandInput
  | CreateDocumentVersionCommandInput
  | CreateFieldCommandInput
  | CreateFolderCommandInput
  | CreateIngestionBatchCommandInput
  | CreateIngestionBatchUploadPolicyCommandInput
  | CreateKnowledgeBaseCommandInput
  | CreateUploadCommandInput
  | DeleteAgentCommandInput
  | DeleteAgentVersionCommandInput
  | DeleteDocumentCommandInput
  | DeleteDocumentVersionCommandInput
  | DeleteFieldCommandInput
  | DeleteFolderCommandInput
  | DeleteKnowledgeBaseCommandInput
  | EnableLayoutAwareSearchCommandInput
  | EstimateDocumentVersionCommandInput
  | EstimateFillInFieldsCommandInput
  | EstimateIngestionCommandInput
  | EstimateLayoutAwareSearchCommandInput
  | EstimateReprocessDocumentsCommandInput
  | FillInFieldsCommandInput
  | GetAccessCommandInput
  | GetAgentCommandInput
  | GetAgentVersionCommandInput
  | GetCallerCommandInput
  | GetConversationCommandInput
  | GetDocumentCommandInput
  | GetDocumentContentCommandInput
  | GetDocumentDownloadCommandInput
  | GetDocumentVersionCommandInput
  | GetFieldCommandInput
  | GetHistoryEntryCommandInput
  | GetIngestionBatchCommandInput
  | GetIngestionBatchItemCommandInput
  | GetKnowledgeBaseCommandInput
  | GetOperationCommandInput
  | GetUploadCommandInput
  | ListAgentVersionsCommandInput
  | ListAgentsCommandInput
  | ListConversationsCommandInput
  | ListDocumentVersionsCommandInput
  | ListDocumentsCommandInput
  | ListFieldsCommandInput
  | ListFoldersCommandInput
  | ListGuardrailsCommandInput
  | ListHistoryEntriesCommandInput
  | ListIngestionBatchItemsCommandInput
  | ListIngestionBatchesCommandInput
  | ListKnowledgeBasesCommandInput
  | ListMemoryStoresCommandInput
  | ListMessagesCommandInput
  | ListModelsCommandInput
  | ListOperationsCommandInput
  | ListToolsCommandInput
  | ListVoicesCommandInput
  | PublishAgentVersionCommandInput
  | PutAccessCommandInput
  | ReplaceDraftVersionCommandInput
  | ReprocessDocumentsCommandInput
  | ResetDraftVersionCommandInput
  | RetryDocumentCommandInput
  | SaveDraftVersionCommandInput
  | SendMessageCommandInput
  | StartIngestionBatchCommandInput
  | UpdateAgentCommandInput
  | UpdateDocumentCommandInput
  | UpdateDraftVersionCommandInput
  | UpdateFieldCommandInput
  | UpdateFolderCommandInput
  | UpdateIngestionBatchCommandInput
  | UpdateIngestionBatchItemCommandInput
  | UpdateKnowledgeBaseCommandInput
  | WatchConversationCommandInput
  | WatchKnowledgeBaseCommandInput
  | WatchOperationCommandInput
  | WatchWorkspaceEventsCommandInput;

/**
 * @public
 */
export type ServiceOutputTypes =
  | BatchCreateIngestionBatchItemsCommandOutput
  | BatchDeleteDocumentsCommandOutput
  | CancelDocumentProcessingCommandOutput
  | CancelIngestionBatchCommandOutput
  | CancelOperationCommandOutput
  | CompareAgentVersionsCommandOutput
  | CompleteIngestionBatchUploadsCommandOutput
  | CreateAgentCommandOutput
  | CreateConversationCommandOutput
  | CreateDocumentCommandOutput
  | CreateDocumentVersionCommandOutput
  | CreateFieldCommandOutput
  | CreateFolderCommandOutput
  | CreateIngestionBatchCommandOutput
  | CreateIngestionBatchUploadPolicyCommandOutput
  | CreateKnowledgeBaseCommandOutput
  | CreateUploadCommandOutput
  | DeleteAgentCommandOutput
  | DeleteAgentVersionCommandOutput
  | DeleteDocumentCommandOutput
  | DeleteDocumentVersionCommandOutput
  | DeleteFieldCommandOutput
  | DeleteFolderCommandOutput
  | DeleteKnowledgeBaseCommandOutput
  | EnableLayoutAwareSearchCommandOutput
  | EstimateDocumentVersionCommandOutput
  | EstimateFillInFieldsCommandOutput
  | EstimateIngestionCommandOutput
  | EstimateLayoutAwareSearchCommandOutput
  | EstimateReprocessDocumentsCommandOutput
  | FillInFieldsCommandOutput
  | GetAccessCommandOutput
  | GetAgentCommandOutput
  | GetAgentVersionCommandOutput
  | GetCallerCommandOutput
  | GetConversationCommandOutput
  | GetDocumentCommandOutput
  | GetDocumentContentCommandOutput
  | GetDocumentDownloadCommandOutput
  | GetDocumentVersionCommandOutput
  | GetFieldCommandOutput
  | GetHistoryEntryCommandOutput
  | GetIngestionBatchCommandOutput
  | GetIngestionBatchItemCommandOutput
  | GetKnowledgeBaseCommandOutput
  | GetOperationCommandOutput
  | GetUploadCommandOutput
  | ListAgentVersionsCommandOutput
  | ListAgentsCommandOutput
  | ListConversationsCommandOutput
  | ListDocumentVersionsCommandOutput
  | ListDocumentsCommandOutput
  | ListFieldsCommandOutput
  | ListFoldersCommandOutput
  | ListGuardrailsCommandOutput
  | ListHistoryEntriesCommandOutput
  | ListIngestionBatchItemsCommandOutput
  | ListIngestionBatchesCommandOutput
  | ListKnowledgeBasesCommandOutput
  | ListMemoryStoresCommandOutput
  | ListMessagesCommandOutput
  | ListModelsCommandOutput
  | ListOperationsCommandOutput
  | ListToolsCommandOutput
  | ListVoicesCommandOutput
  | PublishAgentVersionCommandOutput
  | PutAccessCommandOutput
  | ReplaceDraftVersionCommandOutput
  | ReprocessDocumentsCommandOutput
  | ResetDraftVersionCommandOutput
  | RetryDocumentCommandOutput
  | SaveDraftVersionCommandOutput
  | SendMessageCommandOutput
  | StartIngestionBatchCommandOutput
  | UpdateAgentCommandOutput
  | UpdateDocumentCommandOutput
  | UpdateDraftVersionCommandOutput
  | UpdateFieldCommandOutput
  | UpdateFolderCommandOutput
  | UpdateIngestionBatchCommandOutput
  | UpdateIngestionBatchItemCommandOutput
  | UpdateKnowledgeBaseCommandOutput
  | WatchConversationCommandOutput
  | WatchKnowledgeBaseCommandOutput
  | WatchOperationCommandOutput
  | WatchWorkspaceEventsCommandOutput;

/**
 * @public
 */
export interface ClientDefaults extends Partial<__SmithyConfiguration<__HttpHandlerOptions>> {
  /**
   * The HTTP handler to use or its constructor options. Fetch in browser and Https in Nodejs.
   */
  requestHandler?: __HttpHandlerUserInput;

  /**
   * A constructor for a class implementing the {@link @smithy/types#ChecksumConstructor} interface
   * that computes the SHA-256 HMAC or checksum of a string or binary buffer.
   * @internal
   */
  sha256?: __ChecksumConstructor | __HashConstructor;

  /**
   * The function that will be used to convert strings into HTTP endpoints.
   * @internal
   */
  urlParser?: __UrlParser;

  /**
   * A function that can calculate the length of a request body.
   * @internal
   */
  bodyLengthChecker?: __BodyLengthCalculator;

  /**
   * A function that converts a stream into an array of bytes.
   * @internal
   */
  streamCollector?: __StreamCollector;

  /**
   * The function that will be used to convert a base64-encoded string to a byte array.
   * @internal
   */
  base64Decoder?: __Decoder;

  /**
   * The function that will be used to convert binary data to a base64-encoded string.
   * @internal
   */
  base64Encoder?: __Encoder;

  /**
   * The function that will be used to convert a UTF8-encoded string to a byte array.
   * @internal
   */
  utf8Decoder?: __Decoder;

  /**
   * The function that will be used to convert binary data to a UTF-8 encoded string.
   * @internal
   */
  utf8Encoder?: __Encoder;

  /**
   * The runtime environment.
   * @internal
   */
  runtime?: string;

  /**
   * Disable dynamically changing the endpoint of the client based on the hostPrefix
   * trait of an operation.
   */
  disableHostPrefix?: boolean;

  /**
   * Value for how many times a request will be made at most in case of retry.
   */
  maxAttempts?: number | __Provider<number>;

  /**
   * Specifies which retry algorithm to use.
   * Accepted values are "standard" and "adaptive".
   * @see https://docs.aws.amazon.com/sdkref/latest/guide/feature-retry-behavior.html
   *
   */
  retryMode?: string | __Provider<string>;

  /**
   * Optional logger for logging debug/info/warn/error.
   */
  logger?: __Logger;

  /**
   * Optional extensions
   */
  extensions?: RuntimeExtension[];

  /**
   * The {@link @smithy/smithy-client#DefaultsMode} that will be used to determine how certain default configuration options are resolved in the SDK.
   */
  defaultsMode?: __DefaultsMode | __Provider<__DefaultsMode>;
  /**
   * The internal function that inject utilities to runtime-specific stream to help users consume the data
   * @internal
   */
  sdkStreamMixin?: __SdkStreamMixinInjector;

  /**
   * The SDK package version, sent in the user agent.
   * @internal
   */
  caitlynSdkVersion?: string;

}

/**
 * @public
 */
export type CaitlynClientConfigType = Partial<__SmithyConfiguration<__HttpHandlerOptions>> &
  ClientDefaults &
  RetryInputConfig &
  EndpointInputConfig<EndpointParameters> &
  EndpointRequiredInputConfig &
  HttpAuthSchemeInputConfig &
  ClientInputEndpointParameters;
/**
 * @public
 *
 *  The configuration interface of CaitlynClient class constructor that set the region, credentials and other options.
 */
export interface CaitlynClientConfig extends CaitlynClientConfigType {}

/**
 * @public
 */
export type CaitlynClientResolvedConfigType = __SmithyResolvedConfiguration<__HttpHandlerOptions> &
  Required<ClientDefaults> &
  RuntimeExtensionsConfig &
  RetryResolvedConfig &
  EndpointResolvedConfig<EndpointParameters> &
  EndpointRequiredResolvedConfig &
  HttpAuthSchemeResolvedConfig &
  ClientResolvedEndpointParameters;
/**
 * @public
 *
 *  The resolved configuration interface of CaitlynClient class. This is resolved and normalized from the {@link CaitlynClientConfig | constructor configuration interface}.
 */
export interface CaitlynClientResolvedConfig extends CaitlynClientResolvedConfigType {}

/**
 * The Caitlyn v3 API.
 *
 * Every request is made to a workspace's own hostname, which names the workspace, and carries a
 * short-lived Caitlyn bearer token, however the caller signed in. The `session` sign-in mode (the
 * browser cookie) is handled by the SDKs' runtime and is not modelled per operation.
 * @public
 */
export class CaitlynClient extends __Client<
  __HttpHandlerOptions,
  ServiceInputTypes,
  ServiceOutputTypes,
  CaitlynClientResolvedConfig
> {
  /**
   * The resolved configuration of CaitlynClient class. This is resolved and normalized from the {@link CaitlynClientConfig | constructor configuration interface}.
   */
  readonly config: CaitlynClientResolvedConfig;

  constructor(...[configuration]: __CheckOptionalClientConfig<CaitlynClientConfig>) {
    const _config_0 = __getRuntimeConfig(configuration || {});
    super(_config_0 as any);
    this.initConfig = _config_0;
    const _config_1 = resolveClientEndpointParameters(_config_0);
    const _config_2 = resolveRetryConfig(_config_1);
    const _config_3 = resolveEndpointConfig(_config_2);
    const _config_4 = resolveEndpointRequiredConfig(_config_3);
    const _config_5 = resolveHttpAuthSchemeConfig(_config_4);
    const _config_6 = resolveRuntimeExtensions(_config_5, configuration?.extensions || []);
    this.config = _config_6;
    this.middlewareStack.use(getSchemaSerdePlugin(this.config));
    this.middlewareStack.use(getRetryPlugin(this.config));
    this.middlewareStack.use(getContentLengthPlugin(this.config));
    this.middlewareStack.use(
      getHttpAuthSchemeEndpointRuleSetPlugin(this.config, {
        httpAuthSchemeParametersProvider: defaultCaitlynHttpAuthSchemeParametersProvider,
        identityProviderConfigProvider: async (config: CaitlynClientResolvedConfig) =>
          new DefaultIdentityProviderConfig({
            "smithy.api#httpBearerAuth": config.token,
          }),
      })
    );
    this.middlewareStack.use(getHttpSigningPlugin(this.config));
    this.middlewareStack.use(getCaitlynSdkPlugin(this.config, {
      'retrySafeOperations': ['BatchDeleteDocuments', 'CancelDocumentProcessing', 'CancelIngestionBatch', 'CancelOperation', 'CompareAgentVersions', 'CompleteIngestionBatchUploads', 'CreateAgent', 'CreateConversation', 'CreateDocument', 'CreateDocumentVersion', 'CreateField', 'CreateFolder', 'CreateIngestionBatch', 'CreateIngestionBatchUploadPolicy', 'CreateKnowledgeBase', 'CreateUpload', 'DeleteAgent', 'DeleteAgentVersion', 'DeleteDocument', 'DeleteDocumentVersion', 'DeleteField', 'DeleteFolder', 'DeleteKnowledgeBase', 'EstimateDocumentVersion', 'EstimateFillInFields', 'EstimateIngestion', 'EstimateLayoutAwareSearch', 'EstimateReprocessDocuments', 'FillInFields', 'GetAccess', 'GetAgent', 'GetAgentVersion', 'GetCaller', 'GetConversation', 'GetDocument', 'GetDocumentContent', 'GetDocumentDownload', 'GetDocumentVersion', 'GetField', 'GetHistoryEntry', 'GetIngestionBatch', 'GetIngestionBatchItem', 'GetKnowledgeBase', 'GetOperation', 'GetUpload', 'ListAgentVersions', 'ListAgents', 'ListConversations', 'ListDocumentVersions', 'ListDocuments', 'ListFields', 'ListFolders', 'ListGuardrails', 'ListHistoryEntries', 'ListIngestionBatchItems', 'ListIngestionBatches', 'ListKnowledgeBases', 'ListMemoryStores', 'ListMessages', 'ListModels', 'ListOperations', 'ListTools', 'ListVoices', 'PutAccess', 'ReplaceDraftVersion', 'ReprocessDocuments', 'SaveDraftVersion', 'UpdateAgent', 'UpdateDocument', 'UpdateDraftVersion', 'UpdateField', 'UpdateFolder', 'UpdateIngestionBatch', 'UpdateIngestionBatchItem', 'UpdateKnowledgeBase', 'WatchConversation', 'WatchKnowledgeBase', 'WatchOperation', 'WatchWorkspaceEvents'], sdkModel: '5.115.0', 'since': ['BatchCreateIngestionBatchItems=5.115.0', 'BatchDeleteDocuments=5.115.0', 'CancelDocumentProcessing=5.115.0', 'CancelIngestionBatch=5.115.0', 'CancelOperation=5.115.0', 'CompareAgentVersions=5.115.0', 'CompleteIngestionBatchUploads=5.115.0', 'CreateAgent=5.115.0', 'CreateConversation=5.115.0', 'CreateDocument=5.115.0', 'CreateDocumentVersion=5.115.0', 'CreateField=5.115.0', 'CreateFolder=5.115.0', 'CreateIngestionBatch=5.115.0', 'CreateIngestionBatchUploadPolicy=5.115.0', 'CreateKnowledgeBase=5.115.0', 'CreateUpload.purpose=5.115.0', 'CreateUpload=5.115.0', 'DeleteAgent=5.115.0', 'DeleteAgentVersion=5.115.0', 'DeleteDocument=5.115.0', 'DeleteDocumentVersion=5.115.0', 'DeleteField=5.115.0', 'DeleteFolder=5.115.0', 'DeleteKnowledgeBase=5.115.0', 'EnableLayoutAwareSearch=5.115.0', 'EstimateDocumentVersion=5.115.0', 'EstimateFillInFields=5.115.0', 'EstimateIngestion=5.115.0', 'EstimateLayoutAwareSearch=5.115.0', 'EstimateReprocessDocuments=5.115.0', 'FillInFields=5.115.0', 'GetAccess=5.115.0', 'GetAgent=5.115.0', 'GetAgentVersion=5.115.0', 'GetCaller=5.115.0', 'GetConversation=5.115.0', 'GetDocument=5.115.0', 'GetDocumentContent=5.115.0', 'GetDocumentDownload=5.115.0', 'GetDocumentVersion=5.115.0', 'GetField=5.115.0', 'GetHistoryEntry=5.115.0', 'GetIngestionBatch=5.115.0', 'GetIngestionBatchItem=5.115.0', 'GetKnowledgeBase=5.115.0', 'GetOperation=5.115.0', 'GetUpload=5.115.0', 'ListAgentVersions=5.115.0', 'ListAgents=5.115.0', 'ListConversations=5.115.0', 'ListDocumentVersions=5.115.0', 'ListDocuments=5.115.0', 'ListFields=5.115.0', 'ListFolders=5.115.0', 'ListGuardrails=5.115.0', 'ListHistoryEntries=5.115.0', 'ListIngestionBatchItems=5.115.0', 'ListIngestionBatches=5.115.0', 'ListKnowledgeBases=5.115.0', 'ListMemoryStores=5.115.0', 'ListMessages=5.115.0', 'ListModels=5.115.0', 'ListOperations=5.115.0', 'ListTools=5.115.0', 'ListVoices=5.115.0', 'PublishAgentVersion=5.115.0', 'PutAccess=5.115.0', 'ReplaceDraftVersion=5.115.0', 'ReprocessDocuments=5.115.0', 'ResetDraftVersion=5.115.0', 'RetryDocument=5.115.0', 'SaveDraftVersion=5.115.0', 'SendMessage=5.115.0', 'StartIngestionBatch=5.115.0', 'UpdateAgent=5.115.0', 'UpdateDocument=5.115.0', 'UpdateDraftVersion=5.115.0', 'UpdateField=5.115.0', 'UpdateFolder=5.115.0', 'UpdateIngestionBatch=5.115.0', 'UpdateIngestionBatchItem=5.115.0', 'UpdateKnowledgeBase=5.115.0', 'WatchConversation=5.115.0', 'WatchKnowledgeBase=5.115.0', 'WatchOperation=5.115.0', 'WatchWorkspaceEvents=5.115.0'], }));
  }

  /**
   * Destroy underlying resources, like sockets. It's usually not necessary to do this.
   * However in Node.js, it's best to explicitly shut down the client's agent when it is no longer needed.
   * Otherwise, sockets might stay open for quite a long time before the server terminates them.
   */
  destroy(): void {
    super.destroy();
  }
}
