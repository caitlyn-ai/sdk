// The generated client's sign-in plumbing, as @smithy/core's root package exports it: choosing the auth scheme
// (httpAuthSchemeMiddleware), the identity provider config and memoisation, the bearer signer and the signing
// middleware. @smithy/core's root package re-exports these beside modules that import @smithy/core/protocols, and so
// reach its AWS event-stream support; these are the same functions without that.
import { HttpRequest, getSmithyContext } from '@smithy/core/transport';
import type { Pluggable } from '@smithy/types';

export class HttpBearerAuthSigner {
  async sign(httpRequest: HttpRequest, identity: { token?: string }): Promise<HttpRequest> {
    const request = HttpRequest.clone(httpRequest);
    if (!identity.token) throw new Error('request could not be signed with `token` since the `token` is not defined');
    request.headers['Authorization'] = `Bearer ${identity.token}`;
    return request;
  }
}

export function getHttpSigningPlugin(_config: unknown): Pluggable<any, any> {
  return {
    applyToStack(stack) {
      stack.addRelativeTo(
        (next: any, context: any) => async (args: any) => {
          if (!HttpRequest.isInstance(args.request)) return next(args);
          const scheme = (getSmithyContext(context) as any).selectedHttpAuthScheme;
          if (!scheme) throw new Error('No HttpAuthScheme was selected: unable to sign request');
          const { httpAuthOption: { signingProperties = {} }, identity, signer } = scheme;
          const output = await next({ ...args, request: await signer.sign(args.request, identity, signingProperties) }).catch(
            signer.errorHandler ? signer.errorHandler(signingProperties) : (e: unknown) => Promise.reject(e),
          );
          signer.successHandler?.(output.response, signingProperties);
          return output;
        },
        { step: 'finalizeRequest', tags: ['HTTP_SIGNING'], name: 'httpSigningMiddleware', aliases: ['apiKeyMiddleware', 'tokenMiddleware', 'awsAuthMiddleware'], override: true, relation: 'after', toMiddleware: 'retryMiddleware' } as any,
      );
    },
  };
}

export const doesIdentityRequireRefresh = (identity: { expiration?: Date }) => identity.expiration !== undefined;
export const isIdentityExpired = (identity: { expiration?: Date }) => doesIdentityRequireRefresh(identity) && identity.expiration!.getTime() - Date.now() < 300_000;

export function memoizeIdentityProvider<T>(provider: T | ((o?: any) => Promise<T>) | undefined, isExpired?: (t: T) => boolean, requiresRefresh?: (t: T) => boolean) {
  if (provider === undefined) return undefined;
  const normalized = typeof provider !== 'function' ? async () => provider : (provider as (o?: any) => Promise<T>);
  let resolved: T;
  let pending: Promise<T> | undefined;
  let hasResult = false;
  let isConstant = false;
  const coalesce = async (options?: any) => {
    pending ??= normalized(options);
    try {
      resolved = await pending;
      hasResult = true;
      isConstant = false;
    } finally {
      pending = undefined;
    }
    return resolved;
  };
  if (isExpired === undefined) {
    return async (options?: { forceRefresh?: boolean }) => {
      if (!hasResult || options?.forceRefresh) resolved = await coalesce(options);
      return resolved;
    };
  }
  return async (options?: { forceRefresh?: boolean }) => {
    if (!hasResult || options?.forceRefresh) resolved = await coalesce(options);
    if (isConstant) return resolved;
    if (!requiresRefresh!(resolved)) {
      isConstant = true;
      return resolved;
    }
    if (isExpired(resolved)) {
      await coalesce(options);
      return resolved;
    }
    return resolved;
  };
}

export class DefaultIdentityProviderConfig {
  private readonly authSchemes = new Map<string, unknown>();
  constructor(config: Record<string, unknown>) {
    for (const key of Object.keys(config)) if (config[key] !== undefined) this.authSchemes.set(key, config[key]);
  }
  getIdentityProvider(schemeId: string) {
    return this.authSchemes.get(schemeId);
  }
}

/** Chooses the request's auth scheme and identity (smithy.api#httpBearerAuth, for Caitlyn), before the endpoint. */
export function getHttpAuthSchemeEndpointRuleSetPlugin(
  config: any,
  mw: { httpAuthSchemeParametersProvider: (config: any, context: any, input: unknown) => Promise<unknown>; identityProviderConfigProvider: (config: any) => Promise<any> },
): Pluggable<any, any> {
  return {
    applyToStack(stack) {
      stack.addRelativeTo(
        (next: any, context: any) => async (args: any) => {
          let options: any[] = config.httpAuthSchemeProvider(await mw.httpAuthSchemeParametersProvider(config, context, args.input));
          const preference: string[] = config.authSchemePreference ? await config.authSchemePreference() : [];
          if (preference.length) {
            const preferred = preference.flatMap((name) => options.filter((o) => o.schemeId.split('#')[1] === name));
            options = [...preferred, ...options.filter((o) => !preferred.some((p) => p.schemeId === o.schemeId))];
          }
          const schemes = new Map((config.httpAuthSchemes as any[]).map((s) => [s.schemeId, s]));
          const smithyContext = getSmithyContext(context) as any;
          const failures: string[] = [];
          for (const option of options) {
            const scheme = schemes.get(option.schemeId);
            if (!scheme) {
              failures.push(`HttpAuthScheme \`${option.schemeId}\` was not enabled for this service.`);
              continue;
            }
            const identityProvider = scheme.identityProvider(await mw.identityProviderConfigProvider(config));
            if (!identityProvider) {
              failures.push(`HttpAuthScheme \`${option.schemeId}\` did not have an IdentityProvider configured.`);
              continue;
            }
            const { identityProperties = {}, signingProperties = {} } = option.propertiesExtractor?.(config, context) || {};
            option.identityProperties = Object.assign(option.identityProperties || {}, identityProperties);
            option.signingProperties = Object.assign(option.signingProperties || {}, signingProperties);
            smithyContext.selectedHttpAuthScheme = { httpAuthOption: option, identity: await identityProvider(option.identityProperties), signer: scheme.signer };
            break;
          }
          if (!smithyContext.selectedHttpAuthScheme) throw new Error(failures.join('\n'));
          return next(args);
        },
        { step: 'serialize', tags: ['HTTP_AUTH_SCHEME'], name: 'httpAuthSchemeMiddleware', override: true, relation: 'before', toMiddleware: 'endpointV2Middleware' } as any,
      );
    },
  };
}
