// A workspace has exactly one base URL (its hostname), so the endpoint is the configured URL, unchanged.
// Replaces smithy-typescript's rules-engine resolver (about 12 KB minified).
import type { EndpointV2 } from '@smithy/types';

export const caitlynEndpointProvider = (params: { endpoint?: string }): EndpointV2 => {
  if (!params.endpoint) throw new Error('Caitlyn: no endpoint. Pass `workspace` or `endpoint` when creating the client.');
  return { url: new URL(params.endpoint) };
};
