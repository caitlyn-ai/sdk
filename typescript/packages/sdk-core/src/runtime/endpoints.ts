// Endpoint configuration and middleware, in place of @smithy/core/endpoints, whose middleware carries the rules
// engine and Amazon S3's customisations. A Caitlyn client's endpoint is https://<workspace>/api or the `endpoint`
// override (caitlynEndpointProvider, ../endpoint.ts), so it needs only the `endpoint` built-in, resolved as
// @smithy/core resolves it. Endpoints from AWS configuration (AWS_ENDPOINT_URL, ~/.aws/config) are never read.
import { normalizeProvider, toEndpointV1 } from '@smithy/core/transport';
import type { Pluggable } from '@smithy/types';

type Instruction = { type: string; name?: string; value?: unknown; get?: (input: unknown) => unknown };

export function resolveEndpointConfig<T extends { endpoint?: unknown; tls?: boolean; useDualstackEndpoint?: unknown; useFipsEndpoint?: unknown; ignoreConfiguredEndpointUrls?: boolean }>(input: T) {
  const { endpoint } = input;
  return Object.assign(input, {
    endpoint: endpoint != null ? async () => toEndpointV1((await normalizeProvider(endpoint as never)()) as never) : undefined,
    tls: input.tls ?? true,
    isCustomEndpoint: !!endpoint,
    useDualstackEndpoint: normalizeProvider((input.useDualstackEndpoint ?? false) as never),
    useFipsEndpoint: normalizeProvider((input.useFipsEndpoint ?? false) as never),
    ignoreConfiguredEndpointUrls: !!input.ignoreConfiguredEndpointUrls,
    serviceConfiguredEndpoint: async () => undefined,
  });
}

export function resolveEndpointRequiredConfig<T extends { endpoint?: unknown }>(input: T): T {
  if (input.endpoint === undefined) {
    input.endpoint = async () => {
      throw new Error('@smithy/middleware-endpoint: (default endpointRuleSet) endpoint is not set - you must configure an endpoint.');
    };
  }
  return input;
}

/** A configuration value for an endpoint parameter; the `endpoint` built-in as a URL string. */
async function configValue(config: any, name: string, canonical: string, clientContext: boolean): Promise<unknown> {
  if (name === 'endpoint' || canonical === 'endpoint') {
    if (config.isCustomEndpoint === false) return undefined;
    const e = typeof config[name] === 'function' ? await config[name]() : (config[name] ?? config[canonical]);
    if (e && typeof e === 'object') {
      if ('url' in e) return e.url.href;
      if ('hostname' in e) return `${e.protocol}//${e.hostname}${e.port ? `:${e.port}` : ''}${e.path}`;
    }
    return e;
  }
  const v = (clientContext ? config.clientContextParams?.[name] : undefined) ?? config[name] ?? config[canonical];
  return typeof v === 'function' ? v() : v;
}

export function getEndpointPlugin(config: any, instructions: Record<string, Instruction>): Pluggable<any, any> {
  return {
    applyToStack(stack) {
      stack.addRelativeTo(
        (next: any, context: any) => async (args: any) => {
          const params: Record<string, unknown> = {};
          for (const [name, i] of Object.entries(instructions)) {
            if (i.type === 'staticContextParams') params[name] = i.value;
            else if (i.type === 'contextParams') params[name] = args.input[i.name!];
            else if (i.type === 'operationContextParams') params[name] = i.get!(args.input);
            else if (i.type === 'builtInParams' || i.type === 'clientContextParams') params[name] = await configValue(config, i.name!, name, i.type !== 'builtInParams');
            else throw new Error(`Unrecognized endpoint parameter instruction: ${JSON.stringify(i)}`);
          }
          if (Object.keys(instructions).length === 0) Object.assign(params, config);
          if (typeof config.endpointProvider !== 'function') throw new Error('config.endpointProvider is not set.');
          const endpoint = config.endpointProvider(params, context);
          if (config.isCustomEndpoint && config.endpoint) {
            const custom = await config.endpoint();
            for (const [k, v] of Object.entries(custom?.headers ?? {})) (endpoint.headers ??= {})[k] = Array.isArray(v) ? v : [v];
          }
          context.endpointV2 = endpoint;
          context.authSchemes = endpoint.properties?.authSchemes;
          return next({ ...args });
        },
        { step: 'serialize', tags: ['ENDPOINT_PARAMETERS', 'ENDPOINT_V2', 'ENDPOINT'], name: 'endpointV2Middleware', override: true, relation: 'before', toMiddleware: 'serializerMiddleware' } as any,
      );
    },
  };
}
