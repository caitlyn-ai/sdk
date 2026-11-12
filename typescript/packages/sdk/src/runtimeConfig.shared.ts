// smithy-typescript generated code
import { caitlynEndpointProvider, CaitlynRestJsonProtocol, CaitlynRetryStrategy } from "@caitlyn-ai/sdk-core";
import { HttpBearerAuthSigner } from "@smithy/core";
import { NoOpLogger } from "@smithy/core/client";
import { parseUrl } from "@smithy/core/protocols";
import { fromBase64, fromUtf8, sdkStreamMixin, toBase64, toUtf8 } from "@smithy/core/serde";
import type { IdentityProviderConfig } from "@smithy/types";

import { defaultCaitlynHttpAuthSchemeProvider } from "./auth/httpAuthSchemeProvider";
import type { CaitlynClientConfig } from "./CaitlynClient";
import { errorTypeRegistries } from "./schemas/schemas_0";

/**
 * @internal
 */
export const getRuntimeConfig = (config: CaitlynClientConfig) => {
  return {
    apiVersion: "3.0.0",
    base64Decoder: config?.base64Decoder ?? fromBase64,
    base64Encoder: config?.base64Encoder ?? toBase64,
    caitlynSdkVersion: config?.caitlynSdkVersion ?? "0.3.0",
    disableHostPrefix: config?.disableHostPrefix ?? false,
    endpointProvider: config?.endpointProvider ?? caitlynEndpointProvider,
    extensions: config?.extensions ?? [],
    httpAuthSchemeProvider: config?.httpAuthSchemeProvider ?? defaultCaitlynHttpAuthSchemeProvider,
    httpAuthSchemes: config?.httpAuthSchemes ?? [
      {
        schemeId: "smithy.api#httpBearerAuth",
        identityProvider: (ipc: IdentityProviderConfig) =>
          ipc.getIdentityProvider("smithy.api#httpBearerAuth"),
        signer: new HttpBearerAuthSigner(),
      },
    ],
    logger: config?.logger ?? new NoOpLogger(),
    protocol: config?.protocol ?? CaitlynRestJsonProtocol,
    protocolSettings: config?.protocolSettings ?? { defaultNamespace: "ai.caitlyn.v3", errorTypeRegistries },
    retryStrategy: config?.retryStrategy ?? new CaitlynRetryStrategy(config?.maxAttempts ?? 3),
    sdkStreamMixin: config?.sdkStreamMixin ?? sdkStreamMixin,
    sha256: config?.sha256 ?? undefined as any,
    urlParser: config?.urlParser ?? parseUrl,
    utf8Decoder: config?.utf8Decoder ?? fromUtf8,
    utf8Encoder: config?.utf8Encoder ?? toUtf8,
  };
};
