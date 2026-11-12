// Everything the generated client and this runtime import from @smithy/*, for the browser build
// (`@caitlyn-ai/sdk-core/smithy`, internal). scripts/build-packages.mjs points every @smithy/* import in the
// browser build of both packages here.
//
// The small, self-contained parts of the Smithy runtime are re-exported as they are: the client and its middleware
// stack, the error base class, HTTP messages, sign-in and signing middleware, pagination, the type registry, the
// schema serde middleware and the fetch handler. The heavy parts are replaced with this folder's own: the
// protocol and its JSON codec (./protocol.ts, through runtimeConfig.shared's CaitlynRestJsonProtocol), commands
// (./command.ts), endpoints (./endpoints.ts), retries (./retry.ts) and serde helpers (./serde.ts).
export { Client, NoOpLogger, ServiceException, decorateServiceException, getDefaultExtensionConfiguration, resolveDefaultRuntimeConfig, createAggregatedClient } from '@smithy/core/client';
export { getSmithyContext, normalizeProvider, parseUrl, HttpRequest, HttpResponse } from '@smithy/core/transport';
export {
  createPaginator,
  doesIdentityRequireRefresh,
  isIdentityExpired,
  memoizeIdentityProvider,
  DefaultIdentityProviderConfig,
  getHttpAuthSchemeEndpointRuleSetPlugin,
  getHttpSigningPlugin,
  HttpBearerAuthSigner,
} from '@smithy/core';
export { getContentLengthPlugin, getHttpHandlerExtensionConfiguration, resolveHttpHandlerRuntimeConfig } from '@smithy/core/protocols';
export { getSchemaSerdePlugin, TypeRegistry } from '@smithy/core/schema';
export { FetchHttpHandler } from '@smithy/fetch-http-handler';

export { Command, makeBuilder } from './command.js';
export { getEndpointPlugin, resolveEndpointConfig, resolveEndpointRequiredConfig } from './endpoints.js';
export { getRetryPlugin, getOmitRetryHeadersPlugin, resolveRetryConfig } from './retry.js';
export { calculateBodyLength, fromBase64, fromUtf8, sdkStreamMixin, streamCollector, toBase64, toUtf8 } from './serde.js';
