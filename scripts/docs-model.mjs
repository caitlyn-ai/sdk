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
  const ast = JSON.parse(fs.readFileSync(file, 'utf8'));
  // Mixins' members are the structure's own, as the generators see them (mixin members first, then its own).
  const flat = (shape) => {
    if (!shape.mixins?.length) return shape.members ?? {};
    const members = {};
    for (const { target } of shape.mixins) Object.assign(members, flat(ast.shapes[target]));
    return Object.assign(members, shape.members ?? {});
  };
  const flattened = Object.entries(ast.shapes).filter(([, s]) => s.type === 'structure' && s.mixins?.length).map(([id, s]) => [id, flat(s)]);
  for (const [id, members] of flattened) {
    // A mixin's member is the structure's own copy: traits applied to it (apply Shape$member @required) are its alone.
    ast.shapes[id].members = Object.fromEntries(Object.entries(members).map(([name, m]) => {
      const applied = ast.shapes[`${id}$${name}`];
      return [name, applied?.type === 'apply' ? { ...m, traits: { ...m.traits, ...applied.traits } } : m];
    }));
  }
  for (const shape of Object.values(ast.shapes)) {
    for (const traits of [shape.traits, ...Object.values(shape.members ?? {}).map((m) => m.traits)]) {
      if (traits?.[T('documentation')]) traits[T('documentation')] = publicDoc(traits[T('documentation')]);
    }
  }
  return ast;
}

/** What marks a sentence of the model's documentation as written for the model's authors, not for readers. */
export const INTERNAL_DOC = /PROTOCOL\.md|`@[a-z][A-Za-z]*`|\bsmithy\b|code owners|stamp-since/i;

/**
 * The model's documentation as the public docs show it: a sentence that talks about the model itself (its traits,
 * PROTOCOL.md, who approves changes) is left out. scripts/docs-build.mjs fails on any that get through.
 */
export function publicDoc(text) {
  return text
    .split(/\n\s*\n/)
    .map((para) => (INTERNAL_DOC.test(para) ? para.split(/(?<=[.!?])\s+(?=[A-Z`])/).filter((sentence) => !INTERNAL_DOC.test(sentence)).join(' ') : para))
    .filter((para) => para.trim())
    .join('\n\n');
}

/**
 * The operations no Caitlyn release serves yet: those the snapshot (model/model.json, before prepare-model stamps
 * it) still marks @since("next"). This is the pre-release case: a model built from a branch of the app, before the
 * release that ships it, as v3 is now. A model built from the app's main has every operation's @since as a released
 * version, so this set is empty and every page shows "Since Caitlyn X.Y.Z" instead. `raw` is the snapshot's shapes
 * (a test passes its own).
 */
export function unreleasedOperations(raw = JSON.parse(fs.readFileSync(path.join(root, 'model/model.json'), 'utf8')).shapes) {
  return new Set(Object.entries(raw).filter(([, s]) => s.type === 'operation' && s.traits?.[C('since')] === 'next').map(([id]) => local(id)));
}

/**
 * The release the operations still marked @since("next") arrive in: model/model.lock.json's `stampNext`, the number
 * prepare-model stamps on them and the SDKs' doc comments show ("Since Caitlyn 5.115.0"). Null when the lock names
 * none. `lock` is the lock file's contents (a test passes its own).
 */
export function nextRelease(lock = JSON.parse(fs.readFileSync(path.join(root, 'model/model.lock.json'), 'utf8'))) {
  return /^\d+\.\d+\.\d+$/.test(lock.stampNext ?? '') ? lock.stampNext : null;
}

/**
 * "Not available yet" for an operation no release serves (the pre-release case above), naming the release it arrives
 * in when the lock knows it. It says "arrives in Caitlyn 5.115.0", not "the next release": the public-wording check
 * (scripts/docs-wording.mjs) refuses talk of release plans.
 */
export function notYetNote(next = nextRelease()) {
  return next
    ? `> **Not available yet: arrives in Caitlyn ${next}.** The SDKs have this operation, but workspaces serve it only from that\n> release.`
    : '> **Not available yet.** The SDKs have this operation, but workspaces do not serve it yet.';
}
/**
 * A hand-written page's "Not available yet" callout: the line `<!-- not-available -->` (the page's front matter
 * `operations`) or `<!-- not-available: SendMessage, WatchConversation -->` (those operations) becomes the callout while
 * any of them is unreleased, naming the release from the lock as the reference's callout does, and nothing once they
 * all are released. `unreleased`, `next` and `operations` (the front matter's) are given; a test passes its own.
 */
export const NOT_AVAILABLE_MARKER = /^<!-- not-available(?::\s*([\w,\s]+?))?\s*-->$/;
export function fillNotAvailable(markdown, { operations = [], unreleased = unreleasedOperations(), next = nextRelease() } = {}) {
  return markdown.replace(/^<!-- not-available(?::\s*([\w,\s]+?))?\s*-->\n(\n?)/gm, (_, listed, gap) => {
    const ops = listed ? listed.split(/[,\s]+/).filter(Boolean) : operations;
    if (!ops.some((op) => unreleased.has(op))) return '';
    const callout = next
      ? `> **Not available yet: arrives in Caitlyn ${next}.** The SDKs have the operations this page describes, but workspaces serve\n> them only from that release.`
      : '> **Not available yet.** The SDKs have the operations this page describes, but workspaces do not serve them yet.';
    return `${callout}\n${gap}`;
  });
}
/** The operations on which `If-Match` is optional: the model's @ifMatchOptional set (prepared model's operations) */
export function ifMatchOptional(ast) {
  return Object.entries(ast.shapes).filter(([, s]) => s.type === 'operation' && s.traits?.[C('ifMatchOptional')] !== undefined).map(([id]) => local(id)).sort();
}
/**
 * A hand-written page's `<!-- if-match-optional -->` line: the operations on which `If-Match` is optional, read from
 * the model, as an indented list of links to their reference pages, so the conditional-writes rule (docs/errors.md)
 * names the set once and never by hand.
 */
export function fillIfMatchOptional(markdown, names) {
  return markdown.replace(/^<!-- if-match-optional -->$/m, () => names.map((n) => `  - [${n}](/reference/${kebab(n)}/)`).join('\n'));
}

/** The same, as the Stability row's words */
export const notYetWords = (next = nextRelease()) => (next ? `Not available yet: arrives in Caitlyn ${next}.` : 'Not available yet.');

/**
 * How each language reaches a namespace's client object: a dotted @clientMethod namespace (`agents.versions`) nests
 * one object per segment, outermost first (PROTOCOL.md 10). TypeScript and Python use properties, Go exported
 * fields, Rust methods.
 */
export function namespacePath(lang, namespace) {
  // An operation bound to no resource with only a @clientMethod name has no namespace: it is on the client itself.
  const parts = (namespace ?? '').split('.').filter(Boolean);
  if (lang === 'typescript') return parts.join('.');
  if (lang === 'python') return parts.map((p) => names.python(p)).join('.');
  if (lang === 'go') return parts.map((p) => names.go(p)).join('.');
  // A Rust accessor escapes only keywords (codegen Names.segment): `client.core().uploads()`, not `core_()`.
  if (lang === 'rust') return parts.map((p) => `${words(p).join('_')}()`).join('.');
  throw new Error(`namespacePath: no language ${lang}`);
}

export const local = (id) => id.split('#')[1];
const lowerFirst = (s) => s[0].toLowerCase() + s.slice(1);
export const kebab = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/([A-Z])([A-Z][a-z])/g, '$1-$2').toLowerCase();
const plural = (n) => (/[^aeiou]y$/.test(n) ? `${n.slice(0, -1)}ies` : /(s|x|z|ch|sh)$/.test(n) ? `${n}es` : `${n}s`);

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
  // PROTOCOL.md 10 (model-support's ClientMethod): namespaces follow the resource tree, a child named after its parent
  // drops the parent's part (IngestionBatchItem under IngestionBatch: ingestionBatches.items), and a bound operation's
  // method drops its resource's own name (StartIngestionBatch: ingestionBatches.start).
  const visit = (id, resource, parent) => {
    const s = S[id];
    const own = local(id).replace(/Resource$/, '');
    const up = parent ? parent.own : null;
    const name = up && own.startsWith(up) && own.length > up.length && /[A-Z]/.test(own[up.length]) ? own.slice(up.length) : own;
    const namespace = (parent ? `${parent.namespace}.` : '') + lowerFirst(plural(name));
    const identifiers = Object.keys(s.identifiers ?? {});
    const bind = (target, lifecycle) =>
      out.push({ id: target, resource, own, namespace, lifecycle, instance: !lifecycle && identifiers.length === 1 ? identifiers[0] : null });
    for (const k of ['create', 'put', 'read', 'update', 'delete', 'list']) if (s[k]) bind(s[k].target, k === 'read' ? 'get' : k);
    for (const { target } of s.operations ?? []) bind(target, null);
    for (const { target } of s.collectionOperations ?? []) out.push({ id: target, resource, own, namespace, lifecycle: null, instance: null });
    for (const { target } of s.resources ?? []) visit(target, target, { own, namespace });
  };
  const service = Object.keys(S).find((k) => S[k].type === 'service');
  for (const { target } of S[service].operations ?? []) out.push({ id: target, resource: null, lifecycle: null, instance: null });
  for (const { target } of S[service].resources ?? []) visit(target, target);

  return out
    .map((o) => {
      const shape = S[o.id];
      const t = shape.traits ?? {};
      const name = local(o.id);
      const override = t[C('clientMethod')];
      const namespace = override?.namespace ?? o.namespace;
      const rest = o.own ? name.replace(o.own, '') : name;
      const method = override?.name ?? o.lifecycle ?? lowerFirst(rest && rest !== name ? rest : name);
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
        stability: t[C('stability')] ?? 'beta',
        since: t[C('since')],
        doc: (t[T('documentation')] ?? '').trim(),
        // @noClientMethod(reason): a public operation the SDKs give no method (a webhook delivery, sent by a system
        // that holds no Caitlyn credential). It is in the HTTP API's reference only, with this reason.
        noClientMethod: t[C('noClientMethod')]?.reason ?? null,
      };
    })
    .map((o) => {
      if (!['ga', 'beta', 'internal'].includes(o.stability)) throw new Error(`${o.name}: @stability is ${o.stability}; every operation declares ga, beta or internal`);
      return o;
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
