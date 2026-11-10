// smithy-typescript generated code
import { doesIdentityRequireRefresh, isIdentityExpired, memoizeIdentityProvider } from "@smithy/core";
import { getSmithyContext, normalizeProvider } from "@smithy/core/client";
import {
  type HandlerExecutionContext,
  type HttpAuthOption,
  type HttpAuthScheme,
  type HttpAuthSchemeParameters,
  type HttpAuthSchemeParametersProvider,
  type HttpAuthSchemeProvider,
  type Provider,
  TokenIdentity,
  TokenIdentityProvider,
} from "@smithy/types";

import type { CaitlynClientResolvedConfig } from "../CaitlynClient";

/**
 * @internal
 */
export interface CaitlynHttpAuthSchemeParameters extends HttpAuthSchemeParameters {}

/**
 * @internal
 */
export interface CaitlynHttpAuthSchemeParametersProvider
  extends HttpAuthSchemeParametersProvider<
    CaitlynClientResolvedConfig,
    HandlerExecutionContext,
    CaitlynHttpAuthSchemeParameters,
    object
  > {}

/**
 * @internal
 */
export const defaultCaitlynHttpAuthSchemeParametersProvider = async (
  config: CaitlynClientResolvedConfig,
  context: HandlerExecutionContext,
  input: object
): Promise<CaitlynHttpAuthSchemeParameters> => {
  return {
    operation: getSmithyContext(context).operation as string,
  };
};

function createSmithyApiHttpBearerAuthHttpAuthOption(authParameters: CaitlynHttpAuthSchemeParameters): HttpAuthOption {
  return {
    schemeId: "smithy.api#httpBearerAuth",
  };
}

/**
 * @internal
 */
export interface CaitlynHttpAuthSchemeProvider extends HttpAuthSchemeProvider<CaitlynHttpAuthSchemeParameters> {}

/**
 * @internal
 */
export const defaultCaitlynHttpAuthSchemeProvider: CaitlynHttpAuthSchemeProvider = (authParameters) => {
  const options: HttpAuthOption[] = [];
  switch (authParameters.operation) {
    default: {
      options.push(createSmithyApiHttpBearerAuthHttpAuthOption(authParameters));
    }
  }
  return options;
};

/**
 * @public
 */
export interface HttpAuthSchemeInputConfig {
  /**
   * A comma-separated list of case-sensitive auth scheme names.
   * An auth scheme name is a fully qualified auth scheme ID with the namespace prefix trimmed.
   * For example, the auth scheme with ID aws.auth#sigv4 is named sigv4.
   * @public
   */
  authSchemePreference?: string[] | Provider<string[]>;

  /**
   * Configuration of HttpAuthSchemes for a client which provides default identity providers and signers per auth scheme.
   * @internal
   */
  httpAuthSchemes?: HttpAuthScheme[];

  /**
   * Configuration of an HttpAuthSchemeProvider for a client which resolves which HttpAuthScheme to use.
   * @internal
   */
  httpAuthSchemeProvider?: CaitlynHttpAuthSchemeProvider;
  /**
   * The token used to authenticate requests.
   */
  token?: TokenIdentity | TokenIdentityProvider;
}

/**
 * @internal
 */
export interface HttpAuthSchemeResolvedConfig {
  /**
   * A comma-separated list of case-sensitive auth scheme names.
   * An auth scheme name is a fully qualified auth scheme ID with the namespace prefix trimmed.
   * For example, the auth scheme with ID aws.auth#sigv4 is named sigv4.
   * @public
   */
  readonly authSchemePreference: Provider<string[]>;

  /**
   * Configuration of HttpAuthSchemes for a client which provides default identity providers and signers per auth scheme.
   * @internal
   */
  readonly httpAuthSchemes: HttpAuthScheme[];

  /**
   * Configuration of an HttpAuthSchemeProvider for a client which resolves which HttpAuthScheme to use.
   * @internal
   */
  readonly httpAuthSchemeProvider: CaitlynHttpAuthSchemeProvider;
  /**
   * The token used to authenticate requests.
   */
  readonly token?: TokenIdentityProvider;
}

/**
 * @internal
 */
export const resolveHttpAuthSchemeConfig = <T>(
  config: T & HttpAuthSchemeInputConfig
): T & HttpAuthSchemeResolvedConfig => {
  const token = memoizeIdentityProvider(config.token, isIdentityExpired, doesIdentityRequireRefresh);
  return Object.assign(config, {
    authSchemePreference: normalizeProvider(config.authSchemePreference ?? []),
    token,
  }) as T & HttpAuthSchemeResolvedConfig;
};
