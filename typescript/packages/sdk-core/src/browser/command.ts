// The generated commands' base class and builder for the browser build: @smithy/core's makeBuilder and Command,
// without the AWS event-stream detection and the sensitive-data log filters, which read every schema through
// NormalizedSchema. A Caitlyn model has no AWS event streams (scripts/check-browser-schemas.mjs refuses one), and
// the SDK registers no logging middleware, so neither does anything here.
import { constructStack } from '@smithy/core/client';
import type { MiddlewareStack, Pluggable } from '@smithy/types';

const SMITHY_CONTEXT_KEY = '__smithy_context';
const identity = <T>(x: T) => x;

export class Command {
  middlewareStack: MiddlewareStack<any, any> = constructStack();
  input: object = {};
  schema: unknown;
}

type Supplier = (Command: any, clientStack: unknown, config: any, options: unknown) => Pluggable<any, any>[];

/** As @smithy/core's makeBuilder: one Command class per operation, with the endpoint plugin first. */
export function makeBuilder(common: object, service: string, clientName: string, ep: (config: any, instructions: object) => Pluggable<any, any>) {
  return function makeCommand(added: object, plugins: Supplier, op: string, schema: unknown, smithyContext: object = {}) {
    const instructions = { ...common, ...added };
    const commandName = `${op.charAt(0).toUpperCase()}${op.slice(1)}Command`;
    const Built = class extends Command {
      static getEndpointParameterInstructions() {
        return instructions;
      }
      constructor(input?: object) {
        super();
        this.input = input ?? {};
        this.schema = schema;
      }
      resolveMiddleware(clientStack: MiddlewareStack<any, any>, config: any, options?: { abortSignal?: AbortSignal; metricsRecorder?: unknown }) {
        for (const mw of [ep(config, instructions), ...plugins.call(this, Built, clientStack, config, options)]) this.middlewareStack.use(mw);
        const stack = clientStack.concat(this.middlewareStack);
        const { metricsRecorder, ...requestOptions } = options ?? {};
        const context = {
          logger: config.logger,
          clientName,
          commandName,
          inputFilterSensitiveLog: identity,
          outputFilterSensitiveLog: identity,
          [SMITHY_CONTEXT_KEY]: {
            commandInstance: this,
            service,
            operation: op,
            ...smithyContext,
            operationSchema: schema,
            ...(metricsRecorder === undefined ? {} : { metricsRecorder }),
            ...(options?.abortSignal === undefined ? {} : { abortSignal: options.abortSignal }),
          },
        };
        return stack.resolve((request: any) => config.requestHandler.handle(request.request, requestOptions), context as any);
      }
    };
    return Built;
  };
}
