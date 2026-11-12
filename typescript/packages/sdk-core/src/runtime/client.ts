// The client-level pieces of @smithy/core the generated client uses, without what they carry for AWS services:
// the paginator (createPaginator) and the default runtime extension configuration, whose AWS request-checksum part
// a Caitlyn client has no use for (only the retry strategy is configurable here).
export function createPaginator(ClientCtor: new (...a: any[]) => any, CommandCtor: new (input: any) => any, inputToken: string, outputToken: string, pageSizeToken?: string) {
  return async function* paginate(config: any, input: any, ...rest: any[]) {
    let token = config.startingToken ?? input[inputToken];
    let hasNext = true;
    while (hasNext) {
      input[inputToken] = token;
      if (pageSizeToken) input[pageSizeToken] = input[pageSizeToken] ?? config.pageSize;
      if (!(config.client instanceof ClientCtor)) throw new Error(`Invalid client, expected instance of ${ClientCtor.name}`);
      let command = new CommandCtor(input);
      command = config.withCommand?.(command) ?? command;
      const page = await config.client.send(command, ...rest);
      yield page;
      const previous = token;
      token = outputToken.split('.').reduce((o: any, k) => (o && typeof o === 'object' ? o[k] : undefined), page);
      hasNext = !!(token && (!config.stopOnSameToken || token !== previous));
    }
    return undefined;
  };
}

export const getDefaultExtensionConfiguration = (runtimeConfig: { retryStrategy?: unknown }) => ({
  setRetryStrategy(retryStrategy: unknown) {
    runtimeConfig.retryStrategy = retryStrategy;
  },
  retryStrategy() {
    return runtimeConfig.retryStrategy;
  },
});

export const resolveDefaultRuntimeConfig = (c: { retryStrategy(): unknown }) => ({ retryStrategy: c.retryStrategy() });
