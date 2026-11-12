// What every sign-in mode shares, kept apart from auth.ts so that the server-only modes (auth-server.ts) can use
// it without an import cycle.

/** A sign-in failure: the token endpoint's OAuth error, or a failure to get the identity it exchanges. */
export class CaitlynAuthError extends Error {
  override readonly name = 'CaitlynAuthError';
  constructor(
    message: string,
    /** The OAuth error code (`invalid_client`, `invalid_grant`…), or `sign_in_required`. */
    readonly code: string,
    readonly status?: number,
    readonly requestId?: string,
  ) {
    super(message);
  }
}

/**
 * Whether this is a browser page: a `window` and a `document`. Node, Deno and Bun have no `document`, and web,
 * service and shared workers have neither. A test environment that simulates a DOM (jsdom) counts as a browser.
 */
export const isBrowser = (): boolean => {
  const g = globalThis as { window?: unknown; document?: unknown };
  return typeof g.window !== 'undefined' && typeof g.document !== 'undefined';
};
