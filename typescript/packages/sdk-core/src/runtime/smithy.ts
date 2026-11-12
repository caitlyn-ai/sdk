// Everything the generated client imports from @smithy/* (`@caitlyn-ai/sdk-core/smithy`, internal; the Node HTTP
// handler apart). scripts/build-packages.mjs points the generated code's @smithy/* imports here in every build.
//
// The small, self-contained parts of the Smithy runtime are re-exported as they are: the client and its middleware
// stack, the error base class, HTTP messages, the type registry and the schema serde middleware. Nothing comes from
// @smithy/core's root package or its protocols, retry, endpoints, serde, event-streams or checksum modules. The rest
// is this runtime's own, for what the Caitlyn model and protocol use:
//   - the protocol and its JSON codec (../protocol.ts, which runtimeConfig.shared names directly);
//   - retries, PROTOCOL.md 6.4 (../retry.ts), in place of AWS's standard and adaptive strategies and rate limiter;
//   - endpoints (./endpoints.ts), in place of the rules engine and its Amazon S3 customisations;
//   - commands (./command.ts), without the AWS event-stream detection;
//   - sign-in plumbing, pagination and the extension configuration (./auth.ts, ./client.ts), the fetch handler and
//     Content-Length (./http.ts) and serde helpers (./serde.ts), in place of modules that reach @smithy/core's AWS
//     event-stream and checksum code through @smithy/core/protocols.
export { Client, NoOpLogger, ServiceException, decorateServiceException, emitWarningIfUnsupportedVersion, createAggregatedClient } from '@smithy/core/client';
export { getSmithyContext, normalizeProvider, parseUrl, HttpRequest, HttpResponse } from '@smithy/core/transport';
export { getSchemaSerdePlugin, TypeRegistry } from '@smithy/core/schema';

export { Command, makeBuilder } from './command.js';
export { createPaginator, getDefaultExtensionConfiguration, resolveDefaultRuntimeConfig } from './client.js';
export {
  DefaultIdentityProviderConfig,
  doesIdentityRequireRefresh,
  getHttpAuthSchemeEndpointRuleSetPlugin,
  getHttpSigningPlugin,
  HttpBearerAuthSigner,
  isIdentityExpired,
  memoizeIdentityProvider,
} from './auth.js';
export { getEndpointPlugin, resolveEndpointConfig, resolveEndpointRequiredConfig } from './endpoints.js';
export { getRetryPlugin, resolveRetryConfig } from '../retry.js';
export { FetchHttpHandler, getContentLengthPlugin, getHttpHandlerExtensionConfiguration, resolveHttpHandlerRuntimeConfig } from './http.js';
export { calculateBodyLength, fromBase64, fromUtf8, sdkStreamMixin, streamCollector, toBase64, toUtf8 } from './serde.js';
