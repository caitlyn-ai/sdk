// CaitlynRestJsonProtocol: the runtime half of ai.caitlyn.protocols#restJson (PROTOCOL.md), in place of
// @smithy/core's HttpBindingProtocol, JSON codec and NormalizedSchema, which also carry AWS event streams, big
// numbers and three timestamp formats. It reads the generated static schemas directly (./runtime/schema.ts) and
// implements the HTTP bindings and JSON bodies the way smithy-typescript's restJson1 support does, for what the
// Caitlyn model uses:
//
// - requests: method and path from @http, labels percent-encoded (greedy labels keep their slashes), @httpHeader
//   and @httpQuery members as text, @httpPayload, idempotency tokens filled in when absent, the other members as a
//   JSON object with @jsonName keys; timestamps as RFC 3339 date-time; numbers as plain JSON numbers;
// - responses: header-bound members, @httpResponseCode, a streaming payload (server-sent events) passed through as
//   the body, the other members from the JSON body; unknown members dropped from the output and kept on `raw`;
// - errors: RFC 9457 problem details. The typed error class is chosen by HTTP status against the model's
//   @error/@httpError shapes; the body's `code` stays a field. A body that is not problem details is still the
//   class for its status, with `rawBody`. No X-Amzn-Errortype.
// - $metadata.requestId comes from Caitlyn-Request-Id; a connection that fails while the body is read is a
//   connection failure (PROTOCOL.md 6.5).
//
// scripts/check-runtime-schemas.mjs (run by the package build) refuses a model that needs more: AWS event streams,
// non-streaming blobs, big numbers, other timestamp formats, strings with a media type, host prefixes.
import { HttpRequest, type HttpResponse } from '@smithy/core/transport';
import { decorateServiceException } from '@smithy/core/client';
import { TypeRegistry } from '@smithy/core/schema';
import { markNoResponse } from './plugin.js';
import { isJsonObject, rawBodyOf } from './raw-body.js';
import {
  isBlob,
  isBoolean,
  isDocument,
  isList,
  isMap,
  isNumber,
  isString,
  isStreaming,
  isStruct,
  isTimestamp,
  isUnion,
  members,
  shape,
  traitsOf,
  valueOf,
  type Shape,
} from './runtime/schema.js';
import { collectBody, parseDateTime, quoteHeader, splitHeader, uuid, writeDateTime } from './runtime/serde.js';

export { RAW_BODY_LIMIT, rawBodyOf } from './raw-body.js';

/** An output with the parsed response body, including fields this SDK version does not model. */
export type WithRaw<T> = T & { readonly raw?: Record<string, unknown> };

interface OperationSchema {
  name: string;
  namespace: string;
  traits: unknown;
  input: unknown;
  output: unknown;
}

type Endpoint = { url: URL; headers?: Record<string, string[]> } | { protocol: string; hostname: string; port?: number; path: string; query?: Record<string, string>; headers?: Record<string, string> };

const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/** encodeURIComponent, plus the characters RFC 3986 reserves that it leaves alone. */
const encodeLabel = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** A JSON value for a member, as smithy-typescript's JSON serializer writes it. */
function toJson(s: Shape, value: any): unknown {
  if (value == null) return null;
  if (isStruct(s)) {
    const out: Record<string, unknown> = {};
    for (const [name, m] of members(s)) {
      const v = value[name];
      if (v == null && !m.traits.idempotencyToken) continue;
      out[m.traits.jsonName ?? name] = v === undefined ? uuid() : toJson(m, v);
    }
    if (isUnion(s) && Object.keys(out).length === 0 && Array.isArray(value.$unknown)) out[value.$unknown[0]] = toJson(shape(15), value.$unknown[1]);
    return out;
  }
  if (Array.isArray(value) && (isList(s) || isDocument(s))) {
    const item = isDocument(s) ? s : valueOf(s);
    const sparse = !!s.traits.sparse;
    return value.filter((v) => (isDocument(s) ? v !== undefined : v != null || sparse)).map((v) => toJson(item, v));
  }
  if (typeof value === 'object' && (isMap(s) || (isDocument(s) && !(value instanceof Date) && !(value instanceof Uint8Array)))) {
    const item = isDocument(s) ? s : valueOf(s);
    const sparse = !!s.traits.sparse;
    const out: Record<string, unknown> = {};
    for (const k in value) if (hasOwn(value, k) && (isDocument(s) ? value[k] !== undefined : value[k] != null || sparse)) out[k] = toJson(item, value[k]);
    return out;
  }
  if (value instanceof Date) return writeDateTime(value);
  return value;
}

/** A member's value from its JSON, as smithy-typescript's JSON deserializer reads it. */
function fromJson(s: Shape, value: any): any {
  if (value !== null && typeof value === 'object') {
    if (isStruct(s)) {
      const out: Record<string, unknown> = {};
      const unknown = new Set(Object.keys(value));
      unknown.delete('__type');
      for (const [name, m] of members(s)) {
        const key = m.traits.jsonName ?? name;
        unknown.delete(key);
        if (value[key] != null) out[name] = fromJson(m, value[key]);
      }
      if (isUnion(s)) {
        if (unknown.size === 1 && Object.keys(out).length === 0) {
          const k = unknown.values().next().value!;
          out.$unknown = [k, value[k]];
        }
      } else if (typeof value.__type === 'string') {
        // smithy-typescript keeps a discriminated object's other fields
        const names = Object.fromEntries(members(s).map(([name, m]) => [m.traits.jsonName ?? name, name]));
        for (const k in value) if (hasOwn(value, k) && !((names[k] ?? k) in out)) out[names[k] ?? k] = value[k];
      }
      return out;
    }
    if (Array.isArray(value) && isList(s)) {
      const item = valueOf(s);
      return value.map((v) => fromJson(item, v));
    }
    if (isMap(s) || isDocument(s)) {
      const item = isMap(s) ? valueOf(s) : s;
      if (Array.isArray(value)) return value.map((v) => fromJson(item, v));
      const out: Record<string, unknown> = {};
      for (const k in value) if (hasOwn(value, k)) Object.defineProperty(out, k, { value: fromJson(item, value[k]), enumerable: true, writable: true, configurable: true });
      return out;
    }
  }
  if (isTimestamp(s) && value != null) return parseDateTime(value);
  return value;
}

/** A member bound to a label, header or query parameter, as text. */
function toText(s: Shape, value: any): string {
  if (value === null) return 'null';
  if (value instanceof Date) return writeDateTime(value);
  if (Array.isArray(value) && isList(s)) {
    const item = { type: valueOf(s).type, traits: { ...valueOf(s).traits, ...s.traits } };
    return value.map((v) => (isTimestamp(item) ? toText(item, v) : quoteHeader(toText(item, v)))).join(', ');
  }
  if (typeof value === 'object') return JSON.stringify(value, null, 2);
  if (value === undefined && s.traits.idempotencyToken) return uuid();
  return String(value);
}

/** A header's value as the member's type. */
function fromText(s: Shape, text: string): unknown {
  if (isList(s)) {
    const item = { type: valueOf(s).type, traits: { ...valueOf(s).traits, httpHeader: s.traits.httpHeader } };
    return splitHeader(text).map((part) => fromText(item, part.trim()));
  }
  if (isTimestamp(s)) return parseDateTime(text);
  if (isNumber(s)) return Number(text);
  if (isBoolean(s)) return text.toLowerCase() === 'true';
  return text;
}

/** The Content-Type for a request: the payload's media type, or JSON when members go in the body (PROTOCOL.md 3.1). */
function contentType(input: Shape): string | undefined {
  const all = members(input);
  const payload = all.find(([, m]) => m.traits.httpPayload)?.[1];
  if (payload) return payload.traits.mediaType ?? (isString(payload) ? 'text/plain' : isBlob(payload) ? 'application/octet-stream' : 'application/json');
  return all.some(([, m]) => !m.traits.httpQuery && !m.traits.httpQueryParams && !m.traits.httpHeader && !m.traits.httpLabel && m.traits.httpPrefixHeaders === undefined)
    ? 'application/json'
    : undefined;
}

/** Every deserialised structure, at any depth, gets a non-enumerable `raw`: its JSON object, unknown fields included. */
function attachRaw(s: Shape, value: unknown, json: unknown): void {
  if (value === null || typeof value !== 'object' || json === null || typeof json !== 'object') return;
  if (isStruct(s)) {
    Object.defineProperty(value, 'raw', { value: json, enumerable: false, configurable: true });
    for (const [name, m] of members(s)) attachRaw(m, (value as Record<string, unknown>)[name], (json as Record<string, unknown>)[m.traits.jsonName ?? name]);
  } else if (isList(s) && Array.isArray(value) && Array.isArray(json)) {
    const item = valueOf(s);
    value.forEach((v, i) => attachRaw(item, v, json[i]));
  }
}

/** The body, read whole. A connection that fails while it is read is a connection failure, never retried. */
async function readBody(body: unknown, context: object): Promise<Uint8Array> {
  try {
    return await collectBody(body, context);
  } catch (err) {
    throw markNoResponse(err);
  }
}

function parseJson(bytes: Uint8Array): any {
  const text = new TextDecoder().decode(bytes);
  if (text.length === 0) return {};
  try {
    return JSON.parse(text);
  } catch (e) {
    if ((e as Error)?.name === 'SyntaxError') Object.defineProperty(e, '$responseBodyText', { value: text });
    throw e;
  }
}

export class CaitlynRestJsonProtocol {
  private readonly errors: TypeRegistry;
  private serdeContext?: { disableHostPrefix?: boolean };

  constructor(readonly options: { defaultNamespace: string; errorTypeRegistries?: TypeRegistry[] }) {
    this.errors = new TypeRegistry(options.defaultNamespace);
    for (const r of options.errorTypeRegistries ?? []) this.errors.copyFrom(r);
  }

  getShapeId(): string {
    return 'ai.caitlyn.protocols#restJson';
  }

  getDefaultContentType(): string {
    return 'application/json';
  }

  getRequestType() {
    return HttpRequest;
  }

  setSerdeContext(serdeContext: object): void {
    this.serdeContext = serdeContext;
  }

  async serializeRequest(op: OperationSchema, rawInput: unknown, context: { endpoint: () => Promise<Endpoint> }): Promise<HttpRequest> {
    const input = (rawInput && typeof rawInput === 'object' ? rawInput : {}) as Record<string, any>;
    const query: Record<string, string | string[]> = {};
    const headers: Record<string, string> = {};
    const request = new HttpRequest({ protocol: '', hostname: '', port: undefined, path: '', fragment: undefined, query, headers, body: undefined });
    const endpoint = await context.endpoint();
    const ns = shape(op.input);
    if (endpoint) {
      if ('url' in endpoint) {
        const u = endpoint.url;
        Object.assign(request, { protocol: u.protocol, hostname: u.hostname, port: u.port ? Number(u.port) : undefined, path: u.pathname, fragment: u.hash || undefined, username: u.username || undefined, password: u.password || undefined });
        for (const [k, v] of u.searchParams.entries()) query[k] = v;
        for (const name in endpoint.headers ?? {}) headers[name] = endpoint.headers![name]!.join(', ');
      } else {
        Object.assign(request, { protocol: endpoint.protocol, hostname: endpoint.hostname, port: endpoint.port ? Number(endpoint.port) : undefined, path: endpoint.path });
        Object.assign(query, endpoint.query);
        Object.assign(headers, endpoint.headers);
      }
      const http = traitsOf(op.traits).http as [string, string] | undefined;
      if (http) {
        request.method = http[0];
        const [path, search] = http[1].split('?');
        request.path = request.path === '/' ? path! : request.path + path;
        for (const [k, v] of new URLSearchParams(search ?? '')) query[k] = v;
      }
    }
    const bodyMembers: [string, Shape][] = [];
    let payload: unknown;
    for (const [name, m] of members(ns)) {
      const t = m.traits;
      const value = input[name];
      if (value == null && !t.idempotencyToken) {
        if (t.httpLabel && (request.path.includes(`{${name}+}`) || request.path.includes(`{${name}}`))) throw new Error(`No value provided for input HTTP label: ${name}.`);
        continue;
      }
      if (t.httpPayload) {
        if (isStreaming(m) || isString(m) || isBlob(m)) payload = value;
        else payload = JSON.stringify(toJson(m, value));
      } else if (t.httpLabel) {
        const text = toText(m, value);
        if (request.path.includes(`{${name}+}`)) request.path = request.path.replace(`{${name}+}`, text.split('/').map(encodeLabel).join('/'));
        else request.path = request.path.replace(`{${name}}`, encodeLabel(text));
      } else if (t.httpHeader) {
        headers[String(t.httpHeader).toLowerCase()] = toText(m, value);
      } else if (typeof t.httpPrefixHeaders === 'string') {
        for (const key in value) if (hasOwn(value, key)) headers[(t.httpPrefixHeaders + key).toLowerCase()] = toText({ type: valueOf(m).type, traits: { httpHeader: t.httpPrefixHeaders + key } }, value[key]);
      } else if (t.httpQueryParams) {
        for (const key in value) if (hasOwn(value, key) && !(key in query)) this.query({ type: valueOf(m).type, traits: { ...valueOf(m).traits, ...t, httpQuery: key, httpQueryParams: undefined } }, value[key], query);
      } else if (t.httpQuery) {
        this.query(m, value, query);
      } else {
        bodyMembers.push([name, m]);
      }
    }
    if (bodyMembers.length) {
      const body: Record<string, unknown> = {};
      for (const [name, m] of bodyMembers) {
        const v = input[name];
        if (v == null && !m.traits.idempotencyToken) continue;
        body[m.traits.jsonName ?? name] = v === undefined ? uuid() : toJson(m, v);
      }
      payload = JSON.stringify(body);
    }
    request.headers = headers;
    request.query = query;
    request.body = payload;
    if (!headers['content-type']) {
      const type = contentType(ns);
      if (type) headers['content-type'] = type;
    }
    if (request.body == null && headers['content-type'] === 'application/json') request.body = '{}';
    // SSE operations ask for it: proxies and CDNs key on Accept to stop buffering (PROTOCOL.md 3.1).
    for (const [, m] of members(shape(op.output))) {
      if (m.traits.httpPayload && isStreaming(m) && m.traits.mediaType === 'text/event-stream') headers['accept'] = 'text/event-stream';
    }
    return request;
  }

  private query(m: Shape, value: any, query: Record<string, string | string[]>): void {
    const name = m.traits.httpQuery as string;
    if (isList(m)) {
      const item = { type: valueOf(m).type, traits: { ...valueOf(m).traits, ...m.traits } };
      query[name] = (value as unknown[]).map((v) => toText(item, v));
    } else {
      query[name] = toText(m, value);
    }
  }

  async deserializeResponse(op: OperationSchema, context: object, response: HttpResponse): Promise<any> {
    const out = shape(op.output);
    const all = members(out);
    const metadata = this.deserializeMetadata(response);
    if (response.statusCode >= 300) {
      // A body that is not a JSON object (a proxy's or a web framework's own error page, or no body) is still the
      // typed error for its status, never a parse error (PROTOCOL.md 6.1).
      const bytes = await readBody(response.body, context);
      response.body = bytes;
      return this.handleError(response, isJsonObject(bytes) ? parseJson(bytes) : {}, metadata);
    }
    for (const header of Object.keys(response.headers)) {
      const value = response.headers[header]!;
      delete response.headers[header];
      response.headers[header.toLowerCase()] = value;
    }
    const output: Record<string, any> = {};
    const fromBody: string[] = [];
    let streaming = false;
    for (const [name, m] of all) {
      const t = m.traits;
      if (t.httpPayload) {
        if (isStreaming(m)) {
          streaming = true;
          output[name] = response.body;
        } else {
          const bytes = await readBody(response.body, context);
          response.body = bytes;
          if (bytes.byteLength > 0) output[name] = isString(m) ? new TextDecoder().decode(bytes) : fromJson(m, parseJson(bytes));
        }
      } else if (t.httpHeader) {
        const value = response.headers[String(t.httpHeader).toLowerCase()];
        if (value != null) output[name] = fromText(m, value);
      } else if (typeof t.httpPrefixHeaders === 'string') {
        output[name] = {};
        for (const header in response.headers) {
          if (header.startsWith(t.httpPrefixHeaders)) output[name][header.slice(t.httpPrefixHeaders.length)] = fromText({ type: valueOf(m).type, traits: { httpHeader: header } }, response.headers[header]!);
        }
      } else if (t.httpResponseCode) {
        output[name] = response.statusCode;
      } else {
        fromBody.push(name);
      }
    }
    if (!streaming) {
      const bytes = await readBody(response.body, context);
      response.body = bytes;
      if (fromBody.length && bytes.byteLength > 0) {
        const json = parseJson(bytes);
        const data = fromJson(out, json);
        for (const name of fromBody) if (data[name] != null) output[name] = data[name];
        attachRaw(out, output, json);
      } else if (bytes.byteLength > 0) {
        try {
          attachRaw(out, output, JSON.parse(new TextDecoder().decode(bytes)));
        } catch {
          // not JSON: no raw view
        }
      }
    }
    output.$metadata = metadata;
    return output;
  }

  deserializeMetadata(response: HttpResponse) {
    return { httpStatusCode: response.statusCode, requestId: response.headers['caitlyn-request-id'] as string | undefined };
  }

  private handleError(response: HttpResponse, data: Record<string, any>, metadata: { httpStatusCode: number; requestId?: string }): never {
    const registry = this.errors;
    registry.copyFrom(TypeRegistry.for(this.options.defaultNamespace));
    const errorMetadata = { $metadata: metadata, $fault: response.statusCode < 500 ? 'client' : 'server' };
    const { rawBody, rawBodyTruncated } = rawBodyOf(response.body instanceof Uint8Array ? response.body : new Uint8Array());
    const body: Record<string, unknown> = {
      ...data,
      // Always the HTTP status: a body's `status` can be wrong (a proxy, a faulty handler), and the class is chosen
      // by the HTTP status too (PROTOCOL.md 6.3).
      status: response.statusCode,
      code: typeof data.code === 'string' && data.code ? data.code : `HTTP_${response.statusCode}`,
      requestId: data.requestId ?? response.headers['caitlyn-request-id'],
      rawBody,
      rawBodyTruncated,
    };
    const message = (body.detail ?? body.title ?? `HTTP ${response.statusCode}`) as string;
    const schema = registry.find((s) => Array.isArray(s) && s[0] === -3 && traitsOf((s as unknown[])[3]).httpError === response.statusCode);
    if (!schema) {
      const base = registry.getBaseException();
      const Ctor = (base && registry.getErrorCtor(base)) || Error;
      throw decorateServiceException(Object.assign(new (Ctor as any)({ name: 'CaitlynError', message }), errorMetadata), body);
    }
    const s = shape(schema);
    const exception = new (registry.getErrorCtor(schema as never) ?? (Error as any))({ message });
    const fields: Record<string, unknown> = {};
    for (const [name, m] of members(s)) {
      if (m.traits.httpHeader) {
        // header-bound members, e.g. Retry-After, which the body carries too, as the Node build's does
        const value = response.headers[String(m.traits.httpHeader).toLowerCase()];
        if (value != null) body[name] = fromText(m, value);
        if (body[name] !== undefined) fields[name] = body[name];
      } else if (body[m.traits.jsonName ?? name] !== undefined) {
        fields[name] = fromJson(m, body[m.traits.jsonName ?? name]);
      }
    }
    throw decorateServiceException(Object.assign(exception, errorMetadata, { $fault: s.traits.error, message }, fields), body);
  }
}
