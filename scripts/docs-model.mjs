// Reads the prepared model (build/model/model.json) for the developer docs: the public operations, the client
// method each SDK gives them (PROTOCOL.md section 10), their members and how each is sent, and the names each
// language uses. The naming functions port the generators' own (codegen/*/Names.java), so the docs show the
// identifiers the generated SDKs have; scripts/docs-snippets.mjs then compiles every snippet against the SDKs.
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
const T = (s) => `smithy.api#${s}`;
const C = (s) => `ai.caitlyn.traits#${s}`;
export { T, C };

export function loadModel() {
  const file = path.join(root, 'build/model/model.json');
  if (!fs.existsSync(file)) throw new Error('build/model/model.json is missing: run node scripts/prepare-model.mjs first');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export const local = (id) => id.split('#')[1];
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
export const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const plural = (n) => (n.endsWith('y') ? `${n.slice(0, -1)}ies` : n.endsWith('s') ? `${n}es` : `${n}s`);

/** codegen Names.words: camelCase, PascalCase, UPPER_SNAKE and dotted names as lower-case words. */
export function words(name) {
  const out = [];
  let cur = '';
  const isUpper = (ch) => ch >= 'A' && ch <= 'Z';
  const isLower = (ch) => ch >= 'a' && ch <= 'z';
  const isDigit = (ch) => ch >= '0' && ch <= '9';
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    if ('_-. /'.includes(ch)) {
      if (cur) out.push(cur);
      cur = '';
      continue;
    }
    if (isUpper(ch) && cur) {
      const prevLower = isLower(name[i - 1]) || isDigit(name[i - 1]);
      const nextLower = i + 1 < name.length && isLower(name[i + 1]);
      const prevUpper = isUpper(name[i - 1]);
      if (prevLower || (prevUpper && nextLower)) {
        out.push(cur);
        cur = '';
      }
    }
    cur += ch.toLowerCase();
  }
  if (cur) out.push(cur);
  return out;
}

const GO_INITIALISMS = {
  id: 'ID', ids: 'IDs', url: 'URL', uri: 'URI', api: 'API', http: 'HTTP', https: 'HTTPS', json: 'JSON', sha256: 'SHA256',
  etag: 'ETag', uuid: 'UUID', sse: 'SSE', ip: 'IP', html: 'HTML', sql: 'SQL', ttl: 'TTL', oauth: 'OAuth', kms: 'KMS',
};
const PY_KEYWORDS = new Set(['False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def',
  'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or',
  'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case']);
const RUST_KEYWORDS = new Set(['as', 'async', 'await', 'break', 'const', 'continue', 'dyn', 'else', 'enum', 'extern', 'false', 'fn', 'for',
  'if', 'impl', 'in', 'let', 'loop', 'match', 'mod', 'move', 'mut', 'pub', 'ref', 'return', 'static', 'struct', 'trait', 'true', 'type',
  'unsafe', 'use', 'where', 'while', 'abstract', 'become', 'box', 'do', 'final', 'gen', 'macro', 'override', 'priv', 'try', 'typeof',
  'unsized', 'virtual', 'yield']);
const RUST_RESERVED = new Set(['self', 'super', 'crate', 'Self', 'input', 'opts', 'core', 'req', 'resp', 'out', 'this']);

/** The name of a model member or method in each language. */
export const names = {
  ts: (n) => n,
  /** Python Names.snake (then member(): a keyword gets a trailing underscore). */
  python(n) {
    let out = '';
    const isUpper = (ch) => ch >= 'A' && ch <= 'Z';
    const isLower = (ch) => ch >= 'a' && ch <= 'z';
    for (let i = 0; i < n.length; i++) {
      const ch = n[i];
      if (isUpper(ch)) {
        const prevLower = i > 0 && (isLower(n[i - 1]) || (n[i - 1] >= '0' && n[i - 1] <= '9'));
        const nextLower = i + 1 < n.length && isLower(n[i + 1]);
        const prevUpper = i > 0 && isUpper(n[i - 1]);
        if (i > 0 && (prevLower || (prevUpper && nextLower)) && !out.endsWith('_')) out += '_';
        out += ch.toLowerCase();
      } else out += '-. '.includes(ch) ? '_' : ch;
    }
    return PY_KEYWORDS.has(out) ? `${out}_` : out;
  },
  /** Go Names.exported: knowledgeBaseId -> KnowledgeBaseID. */
  go: (n) => words(n).map((w) => GO_INITIALISMS[w] ?? w[0].toUpperCase() + w.slice(1)).join(''),
  /** Go Names.unexported, for method parameters. */
  goParam(n) {
    const ws = words(n);
    return ws[0] + ws.slice(1).map((w) => GO_INITIALISMS[w] ?? w[0].toUpperCase() + w.slice(1)).join('');
  },
  /** Rust Names.snake. */
  rust(n) {
    let s = words(n).join('_');
    if (!s || /^\d/.test(s)) s = `v_${s}`;
    if (RUST_RESERVED.has(s)) return `${s}_`;
    return RUST_KEYWORDS.has(s) ? `r#${s}` : s;
  },
  /** Rust Names.pascal, for enum variants. */
  rustPascal(n) {
    const s = words(n).map((w) => w[0].toUpperCase() + w.slice(1)).join('');
    return !s || /^\d/.test(s) ? `V${s}` : s;
  },
};

/**
 * Every public operation, in a stable order, with the resource it is bound to and its client method:
 * { id, name, shape, resource, namespace, method, positional, http, stability, since, doc }.
 */
export function operations(ast) {
  const S = ast.shapes;
  const out = [];
  const visit = (id, resource) => {
    const s = S[id];
    const identifiers = Object.keys(s.identifiers ?? {});
    const bind = (target, lifecycle) => out.push({ id: target, resource, lifecycle, instance: !lifecycle && identifiers.length === 1 ? identifiers[0] : null });
    for (const k of ['create', 'put', 'read', 'update', 'delete', 'list']) if (s[k]) bind(s[k].target, k === 'read' ? 'get' : k);
    for (const { target } of s.operations ?? []) bind(target, null);
    for (const { target } of s.collectionOperations ?? []) out.push({ id: target, resource, lifecycle: null, instance: null });
    for (const { target } of s.resources ?? []) visit(target, target);
  };
  const service = Object.keys(S).find((k) => S[k].type === 'service');
  for (const { target } of S[service].operations ?? []) out.push({ id: target, resource: null, lifecycle: null, instance: null });
  for (const { target } of S[service].resources ?? []) visit(target, target);

  return out
    .map((o) => {
      const shape = S[o.id];
      const t = shape.traits ?? {};
      const name = local(o.id);
      const resourceName = o.resource ? local(o.resource).replace(/Resource$/, '') : null;
      const override = t[C('clientMethod')];
      const namespace = override?.namespace ?? lowerFirst(plural(resourceName));
      const method = override?.name ?? o.lifecycle ?? lowerFirst(name);
      // PROTOCOL.md 10: a non-lifecycle instance operation of a resource with exactly one identifier takes it
      // positionally. A @clientMethod override keeps that rule (conversations.send, versions.updateDraft).
      const input = S[shape.input.target];
      const label = o.instance && input.members?.[o.instance]?.traits?.[T('httpLabel')] ? o.instance : null;
      return {
        id: o.id,
        name,
        shape,
        resource: o.resource,
        namespace,
        method,
        positional: label,
        http: t[T('http')],
        stability: t[C('stability')] ?? 'ga',
        since: t[C('since')],
        doc: (t[T('documentation')] ?? '').trim(),
      };
    })
    .filter((o) => o.stability !== 'internal')
    .sort((a, b) => a.namespace.localeCompare(b.namespace) || a.name.localeCompare(b.name));
}

/** How a member is sent: path, query (with its parameter), header (with its name), or body. */
export function binding(member) {
  const t = member.traits ?? {};
  if (t[T('httpLabel')]) return { in: 'path' };
  if (t[T('httpQuery')]) return { in: 'query', name: t[T('httpQuery')] };
  if (t[T('httpHeader')]) return { in: 'header', name: t[T('httpHeader')] };
  if (t[T('httpPayload')]) return { in: 'payload' };
  if (t[T('httpResponseCode')]) return { in: 'status' };
  return { in: 'body', name: t[T('jsonName')] };
}

/** The input member that is a call option rather than an input field: `ifMatch` or `idempotencyKey`, else null. */
export function callOption(name, member) {
  const t = member.traits ?? {};
  if (t[T('idempotencyToken')]) return 'idempotencyKey';
  if (t[T('httpHeader')]?.toLowerCase() === 'if-match') return 'ifMatch';
  return null;
}

/** The SSE events union of an operation's output, or null. */
export function eventsUnion(ast, op) {
  const sse = op.shape.traits?.[C('sseEvents')];
  if (!sse) return null;
  return { id: sse.events, shape: ast.shapes[sse.events], final: sse.final, resumeWith: sse.resumeWith };
}

/** The error shapes an operation can raise: its own, then the service's (PROTOCOL.md 6.2). */
export function operationErrors(ast, op) {
  const S = ast.shapes;
  const service = Object.values(S).find((s) => s.type === 'service');
  const own = (op.shape.errors ?? []).map((e) => e.target);
  const shared = (service.errors ?? []).map((e) => e.target).filter((e) => !own.includes(e));
  const info = (id) => ({ id, name: local(id), status: S[id].traits[T('httpError')], codes: S[id].traits[C('errorCodes')] ?? [], doc: S[id].traits[T('documentation')] ?? '', retryable: !!S[id].traits[T('retryable')], own: own.includes(id) });
  return [...own, ...shared].map(info).sort((a, b) => a.status - b.status);
}

/** Every error shape in the service. */
export function allErrors(ast) {
  const S = ast.shapes;
  return Object.entries(S)
    .filter(([, s]) => s.traits?.[T('error')])
    .map(([id, s]) => ({ id, name: local(id), status: s.traits[T('httpError')], codes: s.traits[C('errorCodes')] ?? [], doc: s.traits[T('documentation')] ?? '', retryable: !!s.traits[T('retryable')] }))
    .sort((a, b) => a.status - b.status);
}

/** Whether the SDKs retry an operation (PROTOCOL.md 6.4). */
export function retrySafe(op, ast) {
  const t = op.shape.traits ?? {};
  if (t[T('readonly')] || t[T('idempotent')]) return true;
  const input = ast.shapes[op.shape.input.target];
  return Object.values(input.members ?? {}).some((m) => m.traits?.[T('idempotencyToken')]);
}
