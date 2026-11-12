// CaitlynRestJsonProtocol: the runtime half of ai.caitlyn.protocols#restJson, on @smithy/core only.
//
// - HTTP bindings and JSON bodies as restJson1 (reusing Smithy's JsonCodec2 and HTTP binding serde).
// - Errors are RFC 9457 problem details. The typed error class is chosen by HTTP status against the
//   model's @error/@httpError shapes; the body's `code` stays a field (the stable product code), never
//   a shape name. No X-Amzn-Errortype.
// - Unknown response fields are kept: every non-streaming output carries `raw`, the parsed JSON body.
// - $metadata.requestId comes from Caitlyn-Request-Id.
import {
  HttpBindingProtocol,
  HttpInterceptingShapeDeserializer,
  HttpInterceptingShapeSerializer,
  JsonCodec2,
  collectBody,
} from '@smithy/core/protocols';
import { NormalizedSchema, TypeRegistry } from '@smithy/core/schema';
import { decorateServiceException } from '@smithy/core/client';
import type {
  HandlerExecutionContext,
  HttpRequest,
  HttpResponse,
  MetadataBearer,
  OperationSchema,
  ResponseMetadata,
  SerdeFunctions,
  StaticErrorSchema,
} from '@smithy/types';

/** An output with the parsed response body, including fields this SDK version does not model. */
export type WithRaw<T> = T & { readonly raw?: Record<string, unknown> };

const SETTINGS = {
  timestampFormat: { useTrait: true, default: 5 /* date-time (RFC 3339) */ },
  httpBindings: true,
  jsonName: true,
} as const;

type ErrorSchemaTuple = StaticErrorSchema & [number, string, string, Record<string, unknown> | number, ...unknown[]];

export class CaitlynRestJsonProtocol extends HttpBindingProtocol {
  protected serializer;
  protected deserializer;
  private readonly codec: JsonCodec2;

  constructor({ defaultNamespace, errorTypeRegistries }: { defaultNamespace: string; errorTypeRegistries?: TypeRegistry[] }) {
    super({ defaultNamespace, errorTypeRegistries });
    this.codec = new JsonCodec2(SETTINGS as never);
    this.serializer = new HttpInterceptingShapeSerializer(this.codec.createSerializer(), SETTINGS as never);
    this.deserializer = new HttpInterceptingShapeDeserializer(this.codec.createDeserializer(), SETTINGS as never);
  }

  getShapeId(): string {
    return 'ai.caitlyn.protocols#restJson';
  }

  getDefaultContentType(): string {
    return 'application/json';
  }

  getPayloadCodec() {
    return this.codec;
  }

  override setSerdeContext(serdeContext: SerdeFunctions): void {
    this.codec.setSerdeContext(serdeContext);
    super.setSerdeContext(serdeContext);
  }

  override async serializeRequest<Input extends object>(operationSchema: OperationSchema, input: Input, context: Parameters<HttpBindingProtocol['serializeRequest']>[2]): Promise<HttpRequest> {
    const request = await super.serializeRequest(operationSchema, input, context);
    if (!request.headers['content-type']) {
      const contentType = resolveContentType(NormalizedSchema.of(operationSchema.input));
      if (contentType) request.headers['content-type'] = contentType;
    }
    if (request.body == null && request.headers['content-type'] === 'application/json') request.body = '{}';
    // SSE operations (a streaming payload with mediaType text/event-stream) ask for it: proxies and CDNs key
    // on Accept to stop buffering, and the proposal's re-join wire form depends on it. PROTOCOL.md 3.1.
    const out = NormalizedSchema.of(operationSchema.output);
    for (const [, member] of out.structIterator()) {
      if (member.getMemberTraits().httpPayload && member.isStreaming() && member.getMergedTraits().mediaType === 'text/event-stream') {
        request.headers['accept'] = 'text/event-stream';
      }
    }
    return request;
  }

  override async deserializeResponse<Output extends MetadataBearer>(operationSchema: OperationSchema, context: HandlerExecutionContext & SerdeFunctions, response: HttpResponse): Promise<Output> {
    const ns = NormalizedSchema.of(operationSchema.output);
    const streaming = [...ns.structIterator()].some(([, m]) => m.getMemberTraits().httpPayload && m.isStreaming());
    if (response.statusCode >= 300) {
      // A body that is not a JSON object (a proxy's or a web framework's own error page, or no body) is still
      // the typed error for its status, never a parse error (PROTOCOL.md 6.1).
      const bytes = await collectBody(response.body, context);
      response.body = bytes;
      if (!isJsonObject(bytes)) {
        await this.handleError(operationSchema, context, response, {}, this.deserializeMetadata(response));
      }
      return super.deserializeResponse(operationSchema, context, response);
    }
    if (streaming) return super.deserializeResponse(operationSchema, context, response);
    const bytes = await collectBody(response.body, context);
    response.body = bytes;
    const output = await super.deserializeResponse<Output>(operationSchema, context, response);
    if (bytes.byteLength > 0) {
      let json: unknown;
      try {
        json = JSON.parse(new TextDecoder().decode(bytes));
      } catch {
        return output; // not JSON: no raw view
      }
      attachRaw(ns, output, json);
    }
    return output;
  }

  protected override deserializeMetadata(response: HttpResponse): ResponseMetadata {
    return { httpStatusCode: response.statusCode, requestId: response.headers['caitlyn-request-id'] };
  }

  protected async handleError(
    _operationSchema: OperationSchema,
    context: HandlerExecutionContext & SerdeFunctions,
    response: HttpResponse,
    dataObject: Record<string, unknown>,
    metadata: ResponseMetadata,
  ): Promise<never> {
    const registry = this.compositeErrorRegistry;
    registry.copyFrom(TypeRegistry.for(this.options.defaultNamespace));
    const errorMetadata = { $metadata: metadata, $fault: response.statusCode < 500 ? 'client' : 'server' };
    const rawBody = response.body instanceof Uint8Array ? new TextDecoder().decode(response.body) : '';
    const body: Record<string, unknown> = {
      ...dataObject,
      status: typeof dataObject.status === 'number' ? dataObject.status : response.statusCode,
      code: typeof dataObject.code === 'string' && dataObject.code ? dataObject.code : `HTTP_${response.statusCode}`,
      requestId: dataObject.requestId ?? response.headers['caitlyn-request-id'],
      rawBody,
    };
    const message = (body.detail ?? body.title ?? `HTTP ${response.statusCode}`) as string;

    const schema = registry.find((s) => {
      const tuple = s as unknown as ErrorSchemaTuple;
      if (!Array.isArray(tuple) || tuple[0] !== -3) return false;
      return NormalizedSchema.of(s as never).getMergedTraits().httpError === response.statusCode;
    }) as StaticErrorSchema | undefined;

    if (!schema) {
      const base = registry.getBaseException();
      const Ctor = (base && registry.getErrorCtor(base)) || Error;
      const name = body.code as string;
      throw decorateServiceException(Object.assign(new (Ctor as any)({ name, message }), errorMetadata), body);
    }

    const ns = NormalizedSchema.of(schema as never);
    const Ctor = registry.getErrorCtor(schema) ?? Error;
    const exception = new (Ctor as any)({ message });
    await this.deserializeHttpMessage(schema as never, context, response, body); // header-bound members, e.g. Retry-After
    const reader = this.codec.createDeserializer() as unknown as { readObject(schema: unknown, value: unknown): unknown };
    const fields: Record<string, unknown> = {};
    for (const [name, member] of ns.structIterator()) {
      const key = member.getMergedTraits().jsonName ?? name;
      if (body[name] !== undefined && member.getMergedTraits().httpHeader) fields[name] = body[name];
      else if (body[key] !== undefined) fields[name] = reader.readObject(member, body[key]);
    }
    throw decorateServiceException(Object.assign(exception, errorMetadata, { $fault: ns.getMergedTraits().error, message }, fields), body);
  }
}

/** Whether a response body parses as a JSON object, the only body problem details can be read from. */
function isJsonObject(bytes: Uint8Array): boolean {
  if (bytes.byteLength === 0) return false;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  } catch {
    return false;
  }
}

/** Every deserialised structure, at any depth, gets a non-enumerable `raw`: its JSON object, unknown fields included. */
function attachRaw(schema: NormalizedSchema, value: unknown, json: unknown): void {
  if (value === null || typeof value !== 'object' || json === null || typeof json !== 'object') return;
  if (schema.isStructSchema()) {
    Object.defineProperty(value, 'raw', { value: json, enumerable: false, configurable: true });
    for (const [name, member] of schema.structIterator()) {
      const key = (member.getMergedTraits().jsonName as string | undefined) ?? name;
      attachRaw(member, (value as Record<string, unknown>)[name], (json as Record<string, unknown>)[key]);
    }
  } else if (schema.isListSchema() && Array.isArray(value) && Array.isArray(json)) {
    const item = schema.getValueSchema();
    value.forEach((v, i) => attachRaw(item, v, json[i]));
  }
}

function resolveContentType(input: NormalizedSchema): string | undefined {
  const members = input.getMemberSchemas();
  const payload = Object.values(members).find((m) => m.getMergedTraits().httpPayload);
  if (payload) {
    const mediaType = payload.getMergedTraits().mediaType as string | undefined;
    if (mediaType) return mediaType;
    if (payload.isStringSchema()) return 'text/plain';
    if (payload.isBlobSchema()) return 'application/octet-stream';
    return 'application/json';
  }
  if (input.isUnitSchema()) return undefined;
  const hasBody = Object.values(members).some((m) => {
    const t = m.getMergedTraits();
    return !t.httpQuery && !t.httpQueryParams && !t.httpHeader && !t.httpLabel && t.httpPrefixHeaders === undefined;
  });
  return hasBody ? 'application/json' : undefined;
}
