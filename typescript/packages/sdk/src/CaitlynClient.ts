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
  BatchDeleteDocumentsCommandInput,
  BatchDeleteDocumentsCommandOutput,
} from "./commands/BatchDeleteDocumentsCommand";
import type {
  CreateConversationCommandInput,
  CreateConversationCommandOutput,
} from "./commands/CreateConversationCommand";
import type { CreateDocumentCommandInput, CreateDocumentCommandOutput } from "./commands/CreateDocumentCommand";
import type { CreateUploadCommandInput, CreateUploadCommandOutput } from "./commands/CreateUploadCommand";
import type {
  DeleteAgentVersionCommandInput,
  DeleteAgentVersionCommandOutput,
} from "./commands/DeleteAgentVersionCommand";
import type { DeleteDocumentCommandInput, DeleteDocumentCommandOutput } from "./commands/DeleteDocumentCommand";
import type { GetAgentVersionCommandInput, GetAgentVersionCommandOutput } from "./commands/GetAgentVersionCommand";
import type { GetCallerCommandInput, GetCallerCommandOutput } from "./commands/GetCallerCommand";
import type { GetDocumentCommandInput, GetDocumentCommandOutput } from "./commands/GetDocumentCommand";
import type {
  GetProductionHistoryEntryCommandInput,
  GetProductionHistoryEntryCommandOutput,
} from "./commands/GetProductionHistoryEntryCommand";
import type { GetUploadCommandInput, GetUploadCommandOutput } from "./commands/GetUploadCommand";
import type {
  ListAgentVersionsCommandInput,
  ListAgentVersionsCommandOutput,
} from "./commands/ListAgentVersionsCommand";
import type { ListDocumentsCommandInput, ListDocumentsCommandOutput } from "./commands/ListDocumentsCommand";
import type {
  ListProductionHistoryEntriesCommandInput,
  ListProductionHistoryEntriesCommandOutput,
} from "./commands/ListProductionHistoryEntriesCommand";
import type { PinDraftVersionCommandInput, PinDraftVersionCommandOutput } from "./commands/PinDraftVersionCommand";
import type {
  PublishAgentVersionCommandInput,
  PublishAgentVersionCommandOutput,
} from "./commands/PublishAgentVersionCommand";
import type {
  ResetDraftVersionCommandInput,
  ResetDraftVersionCommandOutput,
} from "./commands/ResetDraftVersionCommand";
import type { SendMessageCommandInput, SendMessageCommandOutput } from "./commands/SendMessageCommand";
import type {
  UpdateDraftVersionCommandInput,
  UpdateDraftVersionCommandOutput,
} from "./commands/UpdateDraftVersionCommand";
import type {
  WatchConversationCommandInput,
  WatchConversationCommandOutput,
} from "./commands/WatchConversationCommand";
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
  | BatchDeleteDocumentsCommandInput
  | CreateConversationCommandInput
  | CreateDocumentCommandInput
  | CreateUploadCommandInput
  | DeleteAgentVersionCommandInput
  | DeleteDocumentCommandInput
  | GetAgentVersionCommandInput
  | GetCallerCommandInput
  | GetDocumentCommandInput
  | GetProductionHistoryEntryCommandInput
  | GetUploadCommandInput
  | ListAgentVersionsCommandInput
  | ListDocumentsCommandInput
  | ListProductionHistoryEntriesCommandInput
  | PinDraftVersionCommandInput
  | PublishAgentVersionCommandInput
  | ResetDraftVersionCommandInput
  | SendMessageCommandInput
  | UpdateDraftVersionCommandInput
  | WatchConversationCommandInput
  | WatchWorkspaceEventsCommandInput;

/**
 * @public
 */
export type ServiceOutputTypes =
  | BatchDeleteDocumentsCommandOutput
  | CreateConversationCommandOutput
  | CreateDocumentCommandOutput
  | CreateUploadCommandOutput
  | DeleteAgentVersionCommandOutput
  | DeleteDocumentCommandOutput
  | GetAgentVersionCommandOutput
  | GetCallerCommandOutput
  | GetDocumentCommandOutput
  | GetProductionHistoryEntryCommandOutput
  | GetUploadCommandOutput
  | ListAgentVersionsCommandOutput
  | ListDocumentsCommandOutput
  | ListProductionHistoryEntriesCommandOutput
  | PinDraftVersionCommandOutput
  | PublishAgentVersionCommandOutput
  | ResetDraftVersionCommandOutput
  | SendMessageCommandOutput
  | UpdateDraftVersionCommandOutput
  | WatchConversationCommandOutput
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
      'retrySafeOperations': ['BatchDeleteDocuments', 'CreateConversation', 'CreateDocument', 'CreateUpload', 'DeleteAgentVersion', 'DeleteDocument', 'GetAgentVersion', 'GetCaller', 'GetDocument', 'GetProductionHistoryEntry', 'GetUpload', 'ListAgentVersions', 'ListDocuments', 'ListProductionHistoryEntries', 'PinDraftVersion', 'UpdateDraftVersion', 'WatchConversation', 'WatchWorkspaceEvents'], sdkModel: '5.115.0', 'since': ['BatchDeleteDocuments=5.115.0', 'CreateConversation=5.115.0', 'CreateDocument=5.115.0', 'CreateUpload=5.115.0', 'DeleteAgentVersion=5.115.0', 'DeleteDocument=5.115.0', 'GetAgentVersion=5.115.0', 'GetCaller=5.115.0', 'GetDocument=5.115.0', 'GetProductionHistoryEntry=5.115.0', 'GetUpload=5.115.0', 'ListAgentVersions=5.115.0', 'ListDocuments=5.115.0', 'ListProductionHistoryEntries=5.115.0', 'PinDraftVersion=5.115.0', 'PublishAgentVersion=5.115.0', 'ResetDraftVersion=5.115.0', 'SendMessage=5.115.0', 'UpdateDraftVersion=5.115.0', 'WatchConversation=5.115.0', 'WatchWorkspaceEvents=5.115.0'], }));
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
