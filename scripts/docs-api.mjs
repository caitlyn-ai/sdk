// The HTTP API's reference at /api/, built by the site from its copy of the OpenAPI document, in the SDK reference's
// layout and with its row builder (scripts/docs-reference.mjs paramRow). It writes
//   publishedOpenapi()  the site's copy of model/openapi.json, published at /api/openapi.json: the operations grouped
//                       and titled as in the SDK reference, each opening with a link to the same operation there and
//                       carrying its SDK examples as x-codeSamples, and the bearer scheme named plainly
//   apiPages()          an overview (the API, its server, authentication, every operation by resource) and one page
//                       per operation: its request and responses as stacked rows, wire names first with the SDK's
//                       name as a chip, and a code panel with curl and the SDKs' examples beside the HTTP response
// The few things the OpenAPI document does not carry come from the model through a small adapter: a member's
// description where the document has only a $ref, its SDK name, an error's codes, and a stream's events.
import fs from 'node:fs';
import path from 'node:path';
import { T, allErrors, eventsUnion, kebab, local, nextRelease, notYetNote, publicDoc, root, unreleasedOperations, words } from './docs-model.mjs';
import { LANGUAGES } from './docs-snippets.mjs';
import { groupLabel, headingId, limitParts, members, memberTree, paramRow, statusRow, typeSlug, withoutRepeats } from './docs-reference.mjs';

export const API_STATUS_TEXT = {
  200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content', 400: 'Bad request', 401: 'Unauthenticated', 403: 'Forbidden',
  404: 'Not found', 409: 'Conflict', 412: 'Precondition failed', 413: 'Payload too large', 422: 'Unprocessable content',
  428: 'Precondition required', 429: 'Too many requests', 500: 'Internal error', 503: 'Unavailable',
};
const WORKSPACE = 'your-company.getcaitlyn.ai';
const oneLine = (s) => (s ?? '').replace(/\s*\n\s*/g, ' ').trim();
const cell = (s) => oneLine(s).replace(/\|/g, '\\|');
const firstSentence = (s) => (/^(.+?\.)(\s|$)/s.exec(oneLine(s))?.[1] ?? oneLine(s));
const METHODS = ['get', 'put', 'post', 'patch', 'delete'];

// Where an operation sits in the sidebars, the overviews and the OpenAPI document's tags follows the client tree every
// generator uses (conformance/cases/scope-tree.json): a group per collection, namespace or named scope, to any depth,
// keyed by its full path (`knowledgeBases.documents.versions`), and a scope (`knowledgeBases(…)`) the same group as its
// collection. An operation the client has in more than one place (GetAccess on a knowledge base, a folder and a
// document) sits where those places agree: the segments they share, in order, when they end alike (Knowledge bases >
// Access); otherwise the place not reached through a named version scope (agent.draft, agent.live), shortest first
// (Agents > Versions). An estimate sits beside its job. A method on the client itself (caitlyn.me()) is a group of
// its own, named by the method. Groups are labelled in words; building blocks (@lowLevel, under `core` in the client)
// come last, collapsed.
const TREE_FILE = path.join(root, 'conformance/cases/scope-tree.json');
const LOW_LEVEL = 'ai.caitlyn.traits#lowLevel';
const ESTIMATE = 'ai.caitlyn.traits#estimate';
/** Labels that are not the segment in words, by the group's full path */
const LABELS = {
  'agents.options': 'Configuration options',
  core: 'Building blocks',
  'core.documents': 'Document content',
  'core.ingestion': 'Ingestion uploads',
  'knowledgeBases.layoutAwareSearch': 'Layout-aware search',
};
/** The order of the top-level groups (rule 1 of the client), and of the groups inside a parent; others follow in the
 * client's order */
const TOP_ORDER = ['agents', 'conversations', 'knowledgeBases', 'events', 'me', 'core'];
const NESTED_ORDER = ['uploads', 'draft', 'versions', 'history', 'conversations', 'options', 'messages', 'access', 'fields', 'documents', 'folders', 'layoutAwareSearch', 'ingestion', 'batches', 'items', 'operations'];

/** A segment in words: knowledgeBases -> Knowledge bases */
export const segmentLabel = (s) => {
  const w = words(s).join(' ');
  return w.charAt(0).toUpperCase() + w.slice(1);
};
/** A group's label, by its full path */
export const treeLabel = (key) => LABELS[key] ?? segmentLabel(key.split('.').pop());
/**
 * The label the live site's API reference gave an operation's tag before the groups followed the client: its model
 * namespace's last segment (a method on the client itself: the method). Only the old /api/#tag/... addresses use it.
 */
export const namespaceLabel = (ns, op) => (ns ? ns.split('.').pop().replace(/^./, (c) => c.toUpperCase()).replace(/^LiveHistory$/, 'Live history') : segmentLabel(op?.method ?? ''));

/** Every place the client has an operation, in the client's order: { path (segments), viaNamedScope, order } */
function clientPlaces() {
  const tree = JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));
  const places = new Map();
  let order = 0;
  const add = (operation, place) => {
    if (!places.has(operation)) places.set(operation, []);
    places.get(operation).push({ ...place, order: order++ });
  };
  const walk = (node, parent, segments, viaNamedScope) => {
    let here = segments;
    let named = viaNamedScope;
    if (node.kind !== 'root') {
      // A collection's scope (knowledgeBases(…)) is the collection's group
      if (!(node.kind === 'scope' && parent?.kind === 'collection' && parent.scope === node)) here = [...segments, node.name];
      if (node.kind === 'scope' && node.identifiers?.some((i) => i.fixed !== undefined)) named = true;
    }
    for (const m of node.methods ?? []) {
      // A method on the client itself is a group of its own, named by the method
      const at = node.kind === 'root' ? [m.name] : here;
      add(m.operation, { path: at, viaNamedScope: named, call: `${node.path}.${m.name}` });
      if (m.estimate) add(m.estimate, { path: at, viaNamedScope: named, call: `${node.path}.${m.name}.estimate` });
    }
    for (const c of Object.values(node.children ?? {})) walk(c, node, here, named);
    if (node.scope) walk(node.scope, node, here, named);
  };
  walk(tree, null, [], false);
  return places;
}

/** The longest run of segments every path has, in order */
function shared(paths) {
  const lcs = (a, b) => {
    const t = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) t[i][j] = a[i] === b[j] ? t[i + 1][j + 1] + 1 : Math.max(t[i + 1][j], t[i][j + 1]);
    const out = [];
    for (let i = 0, j = 0; i < a.length && j < b.length; ) {
      if (a[i] === b[j]) {
        out.push(a[i]);
        i++;
        j++;
      } else if (t[i + 1][j] >= t[i][j + 1]) i++;
      else j++;
    }
    return out;
  };
  return paths.reduce(lcs);
}

/** An operation's page title: its @title, else its name */
export const operationTitle = (op) => op.shape.traits?.['smithy.api#title'] ?? op.name;

/**
 * Sidebar labels for the pages whose title is cut off at the sidebar's width (measured in the built site, where
 * src/scripts/sidebar-cut.ts marks a cut link data-cut), by operation name or helper id. The page keeps its title;
 * only its sidebar entry is shorter. A title not listed is its own label.
 */
export const SIDEBAR_LABELS = {
  ListConversations: 'List conversations',
  ListDocumentVersions: 'List versions',
};
/** A call without its last argument list: `kb.ingestion.sync(directoryOrItems, { … })` -> `kb.ingestion.sync` */
const callName = (call) => {
  let depth = 0;
  for (let i = call.length - 1; i >= 0; i--) {
    if (call[i] === ')') depth++;
    else if (call[i] === '(' && --depth === 0) return call.slice(0, i);
  }
  return call;
};
/** The knowledge base's scope as the examples name it, `kb`, in each language */
const KB_SCOPE = /^(caitlyn\.knowledgeBases\(knowledgeBaseId\)|caitlyn\.knowledge_bases\(knowledge_base_id\)|client\.KnowledgeBase\(knowledgeBaseID\)|client\.knowledge_base\(knowledge_base_id\))/;
/**
 * An operation's or SDK helper's sidebar tooltip (src/scripts/sidebar-cut.ts shows it on hover and focus): its title and
 * the operation's name, `Create an ingestion batch (CreateIngestionBatch)`, or for a helper its call in each SDK language
 * (data-full-<lang>), TypeScript's the default: `Sync a folder (kb.ingestion.sync)`.
 */
export function entryTips(page) {
  const attrs = { 'data-tip': '' };
  if (page.operation) attrs['data-full'] = `${page.title} (${page.operation.name})`;
  else for (const [lang, call] of Object.entries(page.calls ?? {})) attrs[lang === 'typescript' ? 'data-full' : `data-full-${lang}`] = `${page.title} (${callName(call.replace(KB_SCOPE, 'kb'))})`;
  return attrs;
}

/** A page's sidebar label: SIDEBAR_LABELS, else its title */
export const sidebarLabel = (name, title) => SIDEBAR_LABELS[name] ?? title;

/**
 * The groups as the sidebars nest them: [{ key, label, entries, children, lowLevel, collapsed }], where `entries` are
 * { op } for an operation and { helper } for an SDK helper (docs/helpers.json), in the client's order with an estimate
 * after its job. `groupOf` maps each operation's (and helper's) name to its group's key, `callOf` each operation's
 * name to its TypeScript call without arguments (`caitlyn.knowledgeBases(knowledgeBaseId).documents.create`).
 * ops: the public operations (scripts/docs-model.mjs); ast: the model, for @lowLevel on a resource; helpers: docs/helpers.json's.
 */
export function namespaceTree(ops, { ast, helpers = [] } = {}) {
  const places = clientPlaces();
  const lowLevel = (op) => !!(op.shape.traits?.[LOW_LEVEL] || (op.resource && ast?.shapes[op.resource]?.traits?.[LOW_LEVEL]));
  const placed = new Map();
  for (const op of ops) {
    const all = places.get(op.name);
    if (!all?.length) throw new Error(`docs-api: ${op.name} has no place in the client (conformance/cases/scope-tree.json)`);
    let path;
    let order;
    const last = (p) => p[p.length - 1];
    if (all.every((p) => last(p.path) === last(all[0].path))) {
      path = shared(all.map((p) => p.path));
      order = Math.min(...all.map((p) => p.order));
    } else {
      const plain = all.filter((p) => !p.viaNamedScope);
      ({ path, order } = (plain.length ? plain : all).reduce((a, b) => (b.path.length < a.path.length ? b : a)));
    }
    const call = (all.find((p) => !p.viaNamedScope) ?? all[0]).call;
    placed.set(op.name, { op, path, order, call });
  }
  // An estimate sits beside its job, in the job's group
  for (const op of ops) {
    const forId = op.shape.traits?.[ESTIMATE]?.for;
    const job = forId && placed.get(forId.split('#')[1]);
    if (job) Object.assign(placed.get(op.name), { path: job.path, order: job.order + 0.5 });
  }
  const nodes = new Map();
  const roots = [];
  const node = (path) => {
    const key = path.join('.');
    if (nodes.has(key)) return nodes.get(key);
    const n = { key, segment: path[path.length - 1], label: treeLabel(key), entries: [], children: [], order: Infinity };
    nodes.set(key, n);
    if (path.length === 1) roots.push(n);
    else node(path.slice(0, -1)).children.push(n);
    return n;
  };
  const groupOf = new Map();
  const callOf = new Map([...placed.values()].map((p) => [p.op.name, p.call]));
  for (const { op, path, order } of [...placed.values()].sort((a, b) => a.order - b.order)) {
    const n = node(path);
    n.entries.push({ op, order, lowLevel: lowLevel(op) });
    groupOf.set(op.name, n.key);
    for (let i = path.length; i > 0; i--) nodes.get(path.slice(0, i).join('.')).order = Math.min(nodes.get(path.slice(0, i).join('.')).order, order);
  }
  // A helper sits in the group of the client path it is on (`scope`), or after an operation or helper (`after`)
  const byPath = new Map();
  const tree = JSON.parse(fs.readFileSync(TREE_FILE, 'utf8'));
  (function index(n, parent, segments) {
    let here = segments;
    if (n.kind !== 'root' && !(n.kind === 'scope' && parent?.kind === 'collection' && parent.scope === n)) here = [...segments, n.name];
    byPath.set(n.path, here);
    for (const c of Object.values(n.children ?? {})) index(c, n, here);
    if (n.scope) index(n.scope, n, here);
  })(tree, null, []);
  for (const h of helpers) {
    let target;
    let order;
    if (h.after) {
      const key = groupOf.get(h.after);
      if (!key) throw new Error(`docs/helpers.json: ${h.id} comes after ${h.after}, which is no operation or helper`);
      target = nodes.get(key);
      const at = target.entries.findIndex((e) => (e.op?.name ?? e.helper?.id) === h.after);
      order = target.entries[at].order + 0.25;
      target.entries.splice(at + 1, 0, { helper: h, order, lowLevel: false });
    } else {
      const path = byPath.get(h.scope);
      if (!path?.length) throw new Error(`docs/helpers.json: ${h.id} is on ${h.scope}, which is no place in the client`);
      target = node(path);
      target.entries.push({ helper: h, order: -1, lowLevel: false });
      target.entries.sort((a, b) => a.order - b.order);
    }
    groupOf.set(h.id, target.key);
  }
  const rank = (list, n) => {
    const i = list.indexOf(n.segment);
    return i < 0 ? list.length : i;
  };
  const finish = (n, depth) => {
    n.children.forEach((c) => finish(c, depth + 1));
    n.children.sort((a, b) => rank(NESTED_ORDER, a) - rank(NESTED_ORDER, b) || a.order - b.order);
    n.lowLevel = n.entries.every((e) => e.lowLevel) && n.children.every((c) => c.lowLevel);
  };
  roots.forEach((r) => finish(r, 0));
  roots.sort((a, b) => Number(a.lowLevel) - Number(b.lowLevel) || rank(TOP_ORDER, a) - rank(TOP_ORDER, b) || a.order - b.order);
  for (const r of roots) if (r.lowLevel) r.collapsed = true;
  return Object.assign(roots, { groupOf, callOf, nodes });
}

/** Each group of the tree, depth first: visit(node, depth, parents) */
export function walkTree(tree, visit, depth = 0, parents = []) {
  for (const n of tree) {
    visit(n, depth, parents);
    walkTree(n.children, visit, depth + 1, [...parents, n]);
  }
}

/**
 * The tree as Starlight sidebar groups. linkFor(entry) gives an entry's link, or null to leave it out (a helper in the
 * HTTP reference). A group's own entries sit at its root, then the groups inside it (Agents: List agents, …, then
 * Draft, Versions, …), so no group repeats its parent's name; an empty group is left out. Building blocks stay
 * collapsed.
 */
export function sidebarGroups(tree, linkFor) {
  const build = (n) => {
    const own = n.entries.map(linkFor).filter(Boolean);
    const inner = n.children.map(build).filter(Boolean);
    const items = [...own, ...inner];
    if (!items.length) return null;
    return { label: n.label, ...(n.collapsed ? { collapsed: true } : {}), items };
  };
  return tree.map(build).filter(Boolean);
}

/** A tag's slug as Scalar wrote it in the old /api/#tag/... addresses: lower case, punctuation dropped, spaces as
 * hyphens */
export const tagSlug = (group) => group.toLowerCase().replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, '').replace(/[\s_-]+/g, '-').replace(/^-+|-+$/g, '');

/** Every operation in the document: { route, method, operation } in the document's order. */
export function apiOperations(doc) {
  return Object.entries(doc.paths ?? {}).flatMap(([route, methods]) =>
    Object.entries(methods)
      .filter(([m]) => METHODS.includes(m))
      .map(([method, operation]) => ({ route, method: method.toUpperCase(), operation })),
  );
}

/**
 * The site's copy of the OpenAPI document. The model's file is unchanged.
 * ctx: { ops (the model's operations), tree (namespaceTree), sdkSlug(op) (its SDK reference page), examples (each
 * operation's programs), base (the site's base path) }
 */
export function publishedOpenapi(raw, { ops, tree, sdkSlug, examples, base = '/' }) {
  const doc = structuredClone(raw);
  const problems = [];
  // Its descriptions as the pages give the model's: a sentence written for the model's authors is left out
  (function clean(v) {
    if (!v || typeof v !== 'object') return;
    for (const [k, x] of Object.entries(v)) {
      if (k === 'description' && typeof x === 'string') v[k] = publicDoc(x);
      else clean(x);
    }
  })(doc);
  const opByName = new Map(ops.map((o) => [o.name, o]));
  // Each group is a tag, in the sidebars' order with the building blocks last. The document stays OpenAPI 3.1, which
  // has no nested tags (3.2's `parent`, `summary` and `kind`), and nothing here reads the tags to nest: the site's
  // sidebars come from the same tree (sidebarGroups). So a tag's name is the group's path in words, unique and
  // nested by its reading (Knowledge bases / Documents / Versions). A group with no operations of its own or below it
  // (one holding only SDK helpers) has no tag.
  doc.tags = [];
  const tagOf = new Map();
  const hasOps = (n) => n.entries.some((e) => e.op) || n.children.some(hasOps);
  walkTree(tree, (n, depth, parents) => {
    if (!hasOps(n)) return;
    const name = [...parents, n].map((x) => x.label).join(' / ');
    tagOf.set(n.key, name);
    doc.tags.push({ name });
  });
  for (const { operation } of apiOperations(doc)) {
    const op = opByName.get(operation.operationId);
    if (!op) {
      problems.push(`${operation.operationId} is not an operation of the SDK reference`);
      continue;
    }
    operation.summary = operationTitle(op);
    operation.tags = [tagOf.get(tree.groupOf.get(op.name))];
    const example = examples.find((e) => e.op.id === op.id);
    if (example) operation['x-codeSamples'] = LANGUAGES.map((l) => ({ lang: l.key, label: l.label, source: example.code[l.key].trimEnd() }));
    operation.description = [`Using an SDK? See [\`${tree.callOf.get(op.name)}()\`](${base}${sdkSlug(op)}/) in the SDK reference.`, operation.description].filter(Boolean).join('\n\n');
  }
  const SCHEME = 'bearerAuth';
  const schemes = doc.components?.securitySchemes ?? {};
  for (const name of Object.keys(schemes)) {
    if (name === SCHEME) continue;
    schemes[SCHEME] = { ...schemes[name], description: 'A Caitlyn access token, sent as `Authorization: Bearer <token>`. See [Authentication](/authentication/).' };
    delete schemes[name];
  }
  const rename = (security) => security?.map((req) => Object.fromEntries(Object.entries(req).map(([k, v]) => [k in schemes ? k : SCHEME, v])));
  doc.security = rename(doc.security);
  for (const { operation } of apiOperations(doc)) if (operation.security) operation.security = rename(operation.security);
  return { doc, problems };
}

// ---------------------------------------------------------------------------- what each SDK call returns

// An operation page's response pane says, in the reader's SDK language, what the call returns beside each status: for a
// success the object the call hands back (a result, a list, a stream, a new scope or the handle of work it started), and
// for an error the class it raises. The types are read from the generated SDKs themselves (their client methods, as
// the generators wrote them), never guessed, and a type is linked where the site documents it: a type page, or the
// operation's own Response section for the result of that one call. Scopes, handles, streams and error classes have no
// page of their own, so they are plain text.
const SDK_SOURCES = {
  typescript: ['typescript/packages/sdk/src/sdk/client.ts', 'typescript/packages/sdk/src/sdk/operations.ts'],
  python: ['python/caitlyn/caitlyn/_client.py'],
  go: ['go'],
  rust: ['rust/caitlyn-sdk/src/operations.rs'],
};
const lowerFirst = (s) => s.charAt(0).toLowerCase() + s.slice(1);

/** Whether s[j] is the > of an arrow (=> or ->), not a bracket */
const arrow = (s, j) => s[j] === '>' && (s[j - 1] === '=' || s[j - 1] === '-');
/** The index of the bracket that closes the one at i, counting ()<>[]{} */
function closing(s, i) {
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const ch = s[j];
    if ('(<[{'.includes(ch)) depth++;
    else if (')>]}'.includes(ch) && !arrow(s, j)) {
      depth--;
      if (depth === 0) return j;
    }
  }
  return -1;
}
/** The arguments of a generic written `Name<a, b>` (or `Name[a, b]`), split at the top level */
function typeArgs(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('(<[{'.includes(ch)) depth++;
    if (')>]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
/** `Name<…>` (or Python's `Name[…]`) split into its name and arguments, or null */
function generic(s) {
  const m = /^([\w:.*]+)\s*(<|\[(?!"))/.exec(s.trim());
  if (!m) return null;
  const t = s.trim();
  const end = closing(t, m[0].length - 1);
  if (end !== t.length - 1) return null;
  return { name: m[1], args: typeArgs(t.slice(m[0].length, end)) };
}

/** Each SDK's source, read once */
function sdkSource() {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const goDir = path.join(root, 'go');
  return {
    tsClient: read(SDK_SOURCES.typescript[0]).split('\n'),
    tsOps: read(SDK_SOURCES.typescript[1]),
    tsModels: [...fs.readdirSync(path.join(root, 'typescript/packages/sdk/src/models')).filter((f) => f.endsWith('.ts')).map((f) => read(`typescript/packages/sdk/src/models/${f}`)), read('typescript/packages/sdk/src/sdk/events.ts'), read('typescript/packages/sdk/src/sdk/results.ts')].join('\n'),
    py: read(SDK_SOURCES.python[0]).split('\n'),
    go: fs.readdirSync(goDir).filter((f) => f.endsWith('.go') && !f.endsWith('_test.go')).map((f) => fs.readFileSync(path.join(goDir, f), 'utf8')).join('\n'),
    rust: read(SDK_SOURCES.rust[0]),
    rustScopes: read('rust/caitlyn-sdk/src/scope.rs'),
    tsErrors: read('typescript/packages/sdk/src/models/errors.ts'),
    pyErrors: read('python/caitlyn/caitlyn/errors.py'),
    rsErrors: read('rust/caitlyn-sdk/src/error.rs'),
  };
}

/** TypeScript: the client method's declared return type (src/sdk/client.ts), with ReturnType<typeof ops.x> resolved
 * through src/sdk/operations.ts and the SDK's own wrappers (WithRaw, Out, Created's scope) unwrapped */
function tsReturn(src, op, method) {
  const name = method.split('.').pop() === 'estimate' ? 'estimate' : method.split('.').pop();
  const lines = op.name === 'GetCaller' ? src.tsClient.filter((l) => /^\s+me\(/.test(l)) : src.tsClient.filter((l) => new RegExp(`^\\s+${name}: `).test(l) && l.includes(`ops.${lowerFirst(op.name)}(c`));
  for (const line of lines) {
    let at = line.indexOf(name) + name.length;
    const assign = line.indexOf('Object.assign(', at);
    if (assign >= 0 && assign < line.indexOf('(', at) + 1) at = assign + 'Object.assign('.length;
    const open = line.indexOf('(', at);
    const close = closing(line, open);
    if (close < 0 || line.slice(close + 1, close + 3) !== ': ') continue;
    const rest = line.slice(close + 3);
    let depth = 0;
    let j = 0;
    for (; j < rest.length; j++) {
      const ch = rest[j];
      if (depth === 0 && (rest.startsWith(' =>', j) || rest.startsWith(' {', j))) break;
      if ('(<[{'.includes(ch)) depth++;
      else if (')>]}'.includes(ch) && !arrow(rest, j)) depth--;
    }
    return tsSimplify(src, rest.slice(0, j));
  }
  return null;
}
function tsSimplify(src, t) {
  t = t.trim();
  let m;
  if ((m = /^ReturnType<typeof ops\.(\w+)>$/.exec(t))) {
    const sig = new RegExp(`^export (?:async )?function ${m[1]}\\(.*\\): (.*) \\{$`, 'm').exec(src.tsOps);
    return sig ? tsSimplify(src, sig[1]) : t;
  }
  if ((m = /^\((.*)\)$/.exec(t))) return tsSimplify(src, m[1]);
  // A member of a model type, `Out<CreateDocumentOutput>["document"]`: that member's own type in the SDK's models
  if ((m = /^(.*)\["(\w+)"\]$/.exec(t))) {
    let owner = tsSimplify(src, m[1]);
    // Through a type alias (`export type CreateDocumentResult = CreateDocumentOutput;`) to the interface
    for (let alias; (alias = new RegExp(`export type ${owner} = (\\w+);`).exec(src.tsModels)?.[1]); ) owner = alias;
    const body = new RegExp(`export interface ${owner} \\{([\\s\\S]*?)\\n\\}`).exec(src.tsModels)?.[1] ?? '';
    const member = new RegExp(`^\\s+${m[2]}\\??: ([^;]+);`, 'm').exec(body)?.[1];
    return member ? tsSimplify(src, member.replace(/ \| undefined$/, '')) : t;
  }
  const amp = typeArgs(t.replace(/ & /g, ',')).length > 1 && !generic(t) ? t.split(' & ')[0] : null;
  if (amp) return tsSimplify(src, amp);
  const g = generic(t);
  if (!g) return t;
  const [a, b] = g.args;
  if (g.name === 'Awaited') return tsSimplify(src, a).replace(/^Promise<(.*)>$/, '$1');
  if (['WithRaw', 'Out'].includes(g.name)) return tsSimplify(src, a.replace(/ & __MetadataBearer$/, ''));
  if (g.name === 'NonNullable') return tsSimplify(src, a);
  // Created<Scope, Thing> is the scope with the new thing's fields: `KnowledgeBaseFieldScope & Field`
  if (g.name === 'Created') return b ? `${tsSimplify(src, a)} & ${tsSimplify(src, b)}` : tsSimplify(src, a);
  if (g.name === 'SseStream') return `SseStream<${tsSimplify(src, a)}${b && b !== 'never' ? `, ${tsSimplify(src, b)}` : ''}>`;
  if (g.name === 'WorkPromise') return `WorkPromise<${tsSimplify(src, a)}, ${tsSimplify(src, b)}>`;
  return `${g.name}<${g.args.map((x) => tsSimplify(src, x)).join(', ')}>`;
}

/** Python: the synchronous client's method for the operation (its docstring names it), and its annotation */
function pyReturn(src, op) {
  let cls = null;
  const found = [];
  for (let i = 0; i < src.py.length; i++) {
    const c = /^class (\w+)/.exec(src.py[i]);
    if (c) cls = c[1];
    const d = /^ {4}def (\w+)\(/.exec(src.py[i]);
    if (!d || !cls || cls.startsWith('Async')) continue;
    let sig = src.py[i];
    let k = i;
    while (!/\) -> .*:\s*$/.test(sig) && k < i + 40) sig += src.py[++k].trim();
    const ret = /\) -> (.*):\s*$/.exec(sig)?.[1];
    let named = null;
    for (let b = k + 1; b < src.py.length && !/^ {4}(def|@)|^class /.test(src.py[b]); b++) {
      const n = /Stability: \w+\..*\((\w+)\)\.?\s*$/.exec(src.py[b]);
      if (n) named = n[1];
    }
    if (named === op.name) found.push({ ret, overload: /@overload/.test(src.py[i - 1] ?? '') });
  }
  return (found.find((f) => !f.overload) ?? found[0])?.ret ?? null;
}

/** Python: a synchronous class's method's annotation */
function pyMethod(src, cls, name) {
  const at = src.py.findIndex((l) => l === `class ${cls}:` || l.startsWith(`class ${cls}(`));
  for (let i = at + 1; at >= 0 && i < src.py.length && !/^class /.test(src.py[i]); i++) {
    if (!src.py[i].startsWith(`    def ${name}(`)) continue;
    let sig = src.py[i];
    for (let k = i; !/\) -> .*:\s*$/.test(sig) && k < i + 20; ) sig += src.py[++k].trim();
    return /\) -> (.*):\s*$/.exec(sig)?.[1] ?? null;
  }
  return null;
}

/** Go: the exported method whose body builds the operation's parameters, and what it returns besides the error; a
 * handle's Wait says what waiting gives */
function goReturn(src, op) {
  const funcs = [...src.go.matchAll(/^func \(\w+ \*(\w+)\) (\w+)\([^\n]*\) (\([^\n]*?\)|[^\n{]*?) \{\n([\s\S]*?)^\}/gm)].map((m) => ({ recv: m[1], name: m[2], ret: m[3], body: m[4] }));
  // SendMessage's Send is written by hand (go/send.go)
  const own = { SendMessage: ['ConversationScope', 'Send'] }[op.name];
  let list = own ? funcs.filter((f) => f.recv === own[0] && f.name === own[1]) : funcs.filter((f) => /^[A-Z]/.test(f.name) && f.body.includes(`&${lowerFirst(op.name)}Params{}`));
  if (!list.length) return null;
  list.sort((a, b) => a.body.length - b.body.length);
  let f = list[0];
  if (f.name.endsWith('Pages')) f = funcs.find((g) => g.recv === f.recv && g.name === f.name.slice(0, -'Pages'.length)) ?? f;
  const ret = f.ret.replace(/^\((.*), error\)$/, '$1').replace(/^error$/, '');
  const handle = /^\*(\w+)$/.exec(ret)?.[1];
  const wait = handle && new RegExp(`^func \\(\\w+ \\*${handle}\\) Wait\\([^\\n]*\\) (\\([^\\n]*?\\)|error) \\{`, 'm').exec(src.go)?.[1];
  return { type: ret, wait: wait === undefined ? undefined : wait.replace(/^\((.*), error\)$/, '$1').replace(/^error$/, '') };
}

/** Rust: the operation's request builder, what awaiting it gives, and a list's items */
function rsReturn(src, op) {
  const req = `${op.name}Request`;
  const start = src.rust.indexOf(`impl ${req} {`);
  if (start < 0) return null;
  const block = src.rust.slice(start, closing(src.rust, src.rust.indexOf('{', start)));
  const output = new RegExp(`impl std::future::IntoFuture for ${req} \\{\\n\\s+type Output = ([\\s\\S]*?);\\n`).exec(src.rust)?.[1];
  const items = /pub fn items\(self\) -> ([^{]*?) \{/.exec(block)?.[1];
  const clean = (t) => t?.replace(/\s+/g, ' ').replace(/(crate::(types|scope|operations)|rt)::/g, '').replace(/,\s*>/g, '>').trim();
  const awaited = clean(output)?.replace(/^Result<(.*), Error>$/, '$1');
  return { type: req, awaited, items: clean(items) };
}

/** A type expression as code, each name linked where the site documents it. Returns HTML. */
function typeHtml(expr, linkOf) {
  const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const parts = expr.split(/([A-Za-z_][\w]*)/);
  return `<code>${parts.map((p, i) => (i % 2 && linkOf(p) ? `<a href="${linkOf(p)}">${esc(p)}</a>` : esc(p))).join('')}</code>`;
}

/**
 * What each SDK call returns and raises, for the operation pages' response panes: { [operation]: { returns: { [lang]:
 * html }, errorClasses: { [status]: { [lang]: the class raised } }, unlinked: { [lang]: [type names shown as plain
 * text] } } }. Error classes have no page of their own: the panel links them to Errors.
 * ctx: { ast, ops, tree, typePages (the type ids with a page), sdkSlug(op) }
 */
export function sdkReturns({ ast, ops, tree, typePages, sdkSlug }) {
  const src = sdkSource();
  const pageOf = new Map([...typePages].map((id) => [local(id), `/sdk/types/${kebab(local(id))}/`]));
  const errors = allErrors(ast);
  const opNames = new Set(ops.map((o) => o.name));
  // The SDK types each response pane names, by family, for the SDK types area (sdkTypePages)
  const used = {};
  // The SDKs' own wrappers: what the call hands back around a result, never a result itself
  const WRAPPER = /(Scope|Stream|Started|Request|Page)$|^Created|^(WorkPromise|SseStream|AsyncIterable|Paginator|EventStream|Promise)$/;
  const out = {};
  for (const op of ops) {
    const method = tree.callOf.get(op.name) ?? '';
    const response = `/${sdkSlug(op)}/#response`;
    const unlinked = { typescript: [], python: [], go: [], rust: [] };
    // A name is linked to its type page; an operation's result (TypeScript's GetDocumentOutput, the others'
    // GetDocumentResult) and the call's own result under another name (AgentVersion) to that operation's Response
    // section; anything else (a scope, a handle, a stream, a list) is plain text, and noted
    // A name is linked to its type page; an operation's result (TypeScript's GetDocumentOutput, the others'
    // GetDocumentResult) and the call's own result under another name (AgentVersion) to that operation's Response
    // section; a type the SDKs write around a result (a scope, a handle, a stream, a list, a request) to its entry in
    // the SDK types area; a standard type (Promise, iter.Seq2) is plain text. Anything else is noted as unlinked.
    const linker = (lang, own, scopes = new Set()) => (name) => {
      const sdkType = (family) => {
        const key = `${lang} ${name}`;
        ((used[family] ??= {})[key] ??= { lang, name, by: [] }).by.push(op.name);
        return `/${sdkTypeSlug(family).replace(/^reference\//, 'sdk/')}/#${sdkTypeAnchor(lang, name)}`;
      };
      if (scopes.has(name)) return sdkType('scopes');
      if (pageOf.has(name)) return pageOf.get(name);
      if (own.has(name) && !WRAPPER.test(name)) return response;
      const of = /^(\w+?)(Output|Result)$/.exec(name);
      if (of && opNames.has(of[1]) && (of[2] === 'Result' || lang === 'typescript')) return `/${sdkSlug({ name: of[1] })}/#response`;
      if (!/^[A-Z]/.test(name) || ['Promise', 'Error', 'Result', 'None', 'Seq2'].includes(name)) return null;
      const family = sdkTypeFamily(lang, name, scopes);
      if (family) return sdkType(family);
      if (!unlinked[lang].includes(name)) unlinked[lang].push(name);
      return null;
    };
    const ret = {};

    // TypeScript
    const ts = tsReturn(src, op, method);
    if (ts) {
      const g = generic(ts);
      const own = new Set([`${op.name}Output`]);
      const link = linker('typescript', own);
      if (g?.name === 'WorkPromise') {
        const [now, done] = g.args;
        own.add(now);
        ret.typescript = `returns ${typeHtml(`WorkPromise`, link)}: awaits to ${typeHtml(now, link)}; <code>.wait()</code> gives ${done === 'void' ? 'nothing once it is gone' : typeHtml(done, link)}`;
      } else if (g?.name === 'SseStream') ret.typescript = `returns ${typeHtml(ts, link)}`;
      else if (g?.name === 'AsyncIterable') ret.typescript = `returns ${typeHtml(ts, link)}`;
      else {
        const inner = g?.name === 'Promise' ? g.args[0] : ts;
        own.add(inner);
        ret.typescript = `returns ${typeHtml(g?.name === 'Promise' ? ts : `Promise<${ts}>`, link)}`;
      }
    }

    // Python
    const py = pyReturn(src, op);
    if (py) {
      const g = generic(py);
      const own = new Set([`${op.name}Result`]);
      const link = linker('python', own);
      if (g?.name === 'Started') {
        own.add(g.args[0]);
        ret.python = `returns ${typeHtml(py, link)}; <code>.wait()</code> gives ${g.args[1] === 'None' ? 'nothing once it is gone' : typeHtml(g.args[1], link)}`;
      } else {
        if (!g) own.add(py);
        ret.python = `returns ${typeHtml(py, link)}`;
        // A new thing's scope carries what the call returned as `result` (the new thing itself, where there is one)
        const created = /Scope$/.test(py) && new RegExp(`^class ${py}\\([\\s\\S]*?^ {4}result: (\\w+)`, 'm').exec(src.py.join('\n').slice(src.py.join('\n').search(new RegExp(`^class ${py}\\(`, 'm'))))?.[1];
        if (created) ret.python += `, whose <code>.result</code> is ${typeHtml(created, link)}`;
        // A new scope for work the call started: its wait() (the scope's class's) says what waiting gives
        const base = op.shape.traits?.['ai.caitlyn.traits#longRunning'] && new RegExp(`^class ${py}\\((\\w+)\\)`, 'm').exec(src.py.join('\n'))?.[1];
        const wait = base && pyMethod(src, base, 'wait');
        if (wait) ret.python += `; <code>.wait()</code> gives ${wait === 'None' ? 'nothing once it is gone' : typeHtml(wait, link)}`;
      }
    }

    // Go
    const go = goReturn(src, op);
    if (go) {
      const name = (t) => t.replace(/\b([A-Z]\w*)/g, (n) => (['Seq2'].includes(n) ? n : `caitlyn.${n}`));
      const own = new Set([`${op.name}Result`]);
      const plain = /^\*(\w+)$/.exec(go.type)?.[1];
      const handle = go.wait !== undefined;
      if (plain && !handle) own.add(plain);
      const link = linker('go', own);
      const linkGo = (n) => (n === 'caitlyn' ? null : link(n));
      const events = eventsUnion(ast, op);
      const of = events && /Stream$/.test(go.type) ? ` of ${typeHtml(name(local(events.id)), linkGo)}` : '';
      // A new thing's handle carries the call's result as Result (the new thing itself, where there is one)
      const result = plain && /^Created/.test(plain) && new RegExp(`^type ${plain} struct \\{[^}]*?\\n\\s+Result (\\*?\\w+)`, 'm').exec(src.go)?.[1];
      const carries = result ? `, whose <code>Result</code> is ${typeHtml(name(result), linkGo)}` : '';
      ret.go = `returns ${typeHtml(name(go.type), linkGo)}${carries}${of}${handle ? `; <code>Wait</code> ${go.wait ? `gives ${typeHtml(name(go.wait), linkGo)}` : 'returns once it is gone'}` : ''}`;
    }

    // Rust
    const rs = rsReturn(src, op);
    if (rs) {
      const own = new Set([`${op.name}Result`]);
      const link = linker('rust', own);
      const g = rs.awaited && generic(rs.awaited);
      let text = `returns ${typeHtml(rs.type, link)}`;
      if (rs.items) {
        const item = generic(rs.items)?.args[1];
        text += `; <code>.items()</code> yields ${typeHtml(item ?? rs.items, link)}`;
      } else if (g?.name === 'Started') {
        own.add(g.args[0]);
        text += `, which awaits to ${typeHtml(`Started<${g.args[0]}, ${g.args[1]}>`, link)}; <code>.wait()</code> gives ${g.args[1] === '()' ? 'nothing once it is gone' : typeHtml(g.args[1], link)}`;
      } else if (g?.name === 'Created') {
        // Created<the new thing's scope, the response>: the scope's name can be a type's too (Document), so it is
        // never linked
        own.add(g.args[1]);
        const scope = linker('rust', own, new Set([g.args[0]]))(g.args[0]);
        const inner = typeHtml(g.args[1], link).replace(/^<code>|<\/code>$/g, '');
        text += `, which awaits to <code><a href="${link('Created')}">Created</a>&lt;<a href="${scope}">${g.args[0]}</a>, ${inner}&gt;</code>`;
        // Work the call started: the new scope's wait() says what waiting gives
        if (op.shape.traits?.['ai.caitlyn.traits#longRunning']) {
          const at = src.rustScopes.indexOf(`impl ${g.args[0]} {`);
          const block = at < 0 ? '' : src.rustScopes.slice(at, closing(src.rustScopes, src.rustScopes.indexOf('{', at)));
          const waits = /pub fn wait\(&self\) -> rt::Waiting<(?:crate::types::)?(\w+),/.exec(block)?.[1];
          if (waits) text += `; <code>.wait()</code> gives ${typeHtml(waits, link)}`;
        }
      } else if (rs.awaited) {
        if (!generic(rs.awaited)) own.add(rs.awaited);
        const events = eventsUnion(ast, op);
        text += `, which awaits to ${typeHtml(rs.awaited, link)}${events && /Stream$/.test(rs.awaited) ? ` of ${typeHtml(local(events.id), link)}` : ''}`;
      }
      ret.rust = text;
    }

    // The error classes, by status (the SDKs choose the class by HTTP status, the base class for any other)
    const byStatus = {};
    for (const status of [400, 401, 403, 404, 409, 412, 413, 422, 428, 429, 500, 503]) {
      const e = errors.find((x) => x.status === status);
      const cls = e?.name;
      const has = {
        typescript: cls && new RegExp(`export class ${cls}\\b`).test(src.tsErrors),
        python: cls && new RegExp(`^class ${cls}\\(`, 'm').test(src.pyErrors),
        go: cls && new RegExp(`^type ${cls} struct`, 'm').test(src.go),
        rust: cls && new RegExp(`^\\s+${cls.replace(/Error$/, '')}\\(`, 'm').test(src.rsErrors),
      };
      byStatus[status] = {
        typescript: has.typescript ? cls : 'CaitlynError',
        python: has.python ? cls : 'CaitlynError',
        go: has.go ? `*caitlyn.${cls}` : '*caitlyn.Error',
        rust: has.rust ? `Error::${cls.replace(/Error$/, '')}` : 'Error::Api',
      };
    }
    out[op.name] = { returns: ret, errorClasses: byStatus, unlinked };
    // The error classes, each under its language in the SDK types area
    for (const [status, classes] of Object.entries(byStatus)) {
      for (const [lang, cls] of Object.entries(classes)) {
        const e = errors.find((x) => x.status === Number(status));
        const entry = ((used['error-classes'] ??= {})[`${lang} ${cls}`] ??= { lang, name: cls, by: [], info: { doc: '', methods: [] } });
        entry.doc = `Raised for HTTP ${status}${e?.codes.length ? `, with the code ${e.codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(', ')}` : ''}.`;
      }
    }
  }
  // The base classes, for a status the API has no class for
  for (const [lang, cls] of [['typescript', 'CaitlynError'], ['python', 'CaitlynError'], ['go', '*caitlyn.Error'], ['rust', 'Error::Api']]) {
    (used['error-classes'] ??= {})[`${lang} ${cls}`] = { lang, name: cls, by: [], info: { doc: '', methods: [] }, doc: 'Raised for any other error response, such as a status the API has no class for (a 405, or a proxy\'s 502). Every error class is one of these.' };
  }
  return Object.assign(out, { [SDK_TYPES]: used });
}
/** Where sdkReturns keeps the SDK types its panes name (for sdkTypePages) */
export const SDK_TYPES = Symbol('sdkTypes');

// ------------------------------------------------------------------------------------- "New to ingestion?"

// One line under the summary of every ingestion page in both references (ingestion.sync and its estimate, the
// batches and their items, and their watch and wait) and of Add a document and Delete many documents, pointing at the
// guide that explains the whole flow. It is added only once that guide is a page of the site, so no page links to a
// guide that is not there yet.
export const INGESTION_GUIDE = 'guides/how-ingestion-works';
export const INGESTION_INTRO = `New to ingestion? Start with [How ingestion works](/${INGESTION_GUIDE}/).`;
export const isIngestionPage = (p) => (p.kind === 'reference' || p.kind === 'api') && (/^knowledgeBases\.ingestion(\.|$)/.test(p.group ?? '') || ['CreateDocument', 'BatchDeleteDocuments'].includes(p.operation?.name));
/** Adds the line to every ingestion page among `pages` (in place); false, adding nothing, when the guide is no page */
export function addIngestionIntro(pages) {
  if (!pages.some((p) => p.slug === INGESTION_GUIDE)) return false;
  const afterSummary = (body) => body.replace(/^([\s\S]*?\S[\s\S]*?)(\n\n|$)/, (_, first, gap) => `${first}\n\n${INGESTION_INTRO}${gap || '\n'}`);
  for (const p of pages.filter(isIngestionPage)) {
    p.body = afterSummary(p.body);
    if (p.siteBody) p.siteBody = afterSummary(p.siteBody);
  }
  return true;
}

// ------------------------------------------------------------------------------------------- the SDK types

// The types the SDKs write around the API's results, which the model has no shape for: handles of work a call started,
// scopes, streams, lists and pages, Rust's request builders, and the error classes. The reference's "SDK types" area
// has a page per family, and each type an anchor on it, read from the generated SDKs and their runtime cores (the type's
// doc comment and its public methods), so the response pane can link every type it names.
export const SDK_TYPE_FAMILIES = [
  { key: 'handles', title: 'Handles', lead: 'What a call that starts work returns: the call\'s response, with `wait()` for the work to finish and `watch()` for its events. A handle for a new thing is also that thing\'s scope.' },
  { key: 'scopes', title: 'Scopes', lead: 'A scope is one thing in the client, `caitlyn.knowledgeBases(kbId).documents(documentId)`, with every call about it. Making a scope sends nothing. The scope a `create` returns also carries the response\'s fields.' },
  { key: 'streams', title: 'Streams', lead: 'What a stream or a watch returns: its events in order, one at a time, reconnecting by itself when a connection drops. A stream with a final event (an answer) also gives that final message.' },
  { key: 'lists', title: 'Lists and pages', lead: 'What a list returns: every item, fetching each page as it is needed, or the pages themselves.' },
  { key: 'requests', title: 'Request builders', lead: 'In Rust, a call returns a request builder: set any options on it, then await it (or call `send()`) to make the request.' },
  { key: 'error-classes', title: 'Error classes', lead: 'The class each SDK raises for an error response, chosen by its HTTP status. Each carries the error\'s `code`, `detail` and `requestId`; [Errors](/errors/#handling-errors) shows how to handle them.' },
];
const LANG_LABEL = { typescript: 'TypeScript', python: 'Python', go: 'Go', rust: 'Rust' };
/** A type's anchor on its family's page: the language and the name, `typescript-workpromise` */
export const sdkTypeAnchor = (lang, name) => `${lang}-${name.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase()}`;
export const sdkTypeSlug = (family) => `reference/sdk-types/${family}`;

/** The family a type the SDKs return belongs to, by its name in that language, or null */
function sdkTypeFamily(lang, name, scopeNames) {
  if (scopeNames.has(name)) return 'scopes';
  if (lang === 'rust' && /Request$/.test(name)) return 'requests';
  if (/(Stream|EventStream)$/.test(name) || name === 'SseStream') return 'streams';
  if (/Page$/.test(name) || ['Paginator', 'AsyncIterable', 'Items', 'Pages'].includes(name)) return 'lists';
  if (/Scope$/.test(name)) return 'scopes';
  if (['WorkPromise', 'Started', 'Created'].includes(name) || /Started$/.test(name) || (lang === 'go' && /^Created/.test(name))) return 'handles';
  return null;
}

/** A doc comment as public text: its first paragraph, with parenthetical pointers at the protocol left out */
const typeDoc = (text) => publicDoc((text ?? '').replace(/\s*\((?:PROTOCOL\.md|conformance)[^)]*\)/g, '').replace(/\s*\n\s*/g, ' ').trim()).split(/\n\s*\n/)[0] ?? '';

/** A type's doc comment and public methods in one language's generated SDK or runtime core */
function sdkTypeInfo(src, lang, name) {
  const methods = new Set();
  let doc = '';
  if (lang === 'typescript') {
    if (name === 'AsyncIterable') return { doc: 'JavaScript\'s async iterable: read it with `for await (const item of …)`. The SDK fetches each page as the loop needs it.', methods: [] };
    for (const text of src.tsAll) {
      const m = new RegExp(`(?:/\\*\\*((?:[^*]|\\*(?!/))*)\\*/\\s*\\n)?export (?:interface|class) ${name}\\b`).exec(text);
      if (!m) continue;
      doc = (m[1] ?? '').replace(/^\s*\* ?/gm, '');
      // The body's brace is the first at the top level, after any type parameters (`<E extends { type: string }>`)
      let open = m.index + m[0].length;
      for (let depth = 0; open < text.length; open++) {
        if (text[open] === '<') depth++;
        else if (text[open] === '>' && !arrow(text, open)) depth--;
        else if (text[open] === '{' && depth === 0) break;
      }
      const body = text.slice(open, closing(text, open));
      for (const [, n] of body.matchAll(/^ {2}(?:async |get |readonly )?([a-z]\w*)[?]?(?:\(|:|<)/gm)) if (n !== 'constructor') methods.add(n);
      break;
    }
  } else if (lang === 'python') {
    for (const text of src.pyAll) {
      const at = text.search(new RegExp(`^class ${name}(?:\\[|\\(|:)`, 'm'));
      if (at < 0) continue;
      const rest = text.slice(at).split('\n');
      doc = /^\s+"""([\s\S]*?)"""/m.exec(rest.slice(1, 40).join('\n'))?.[1] ?? '';
      for (let i = 1; i < rest.length && !/^\S/.test(rest[i]); i++) {
        const d = /^ {4}def ([a-z]\w*)\(/.exec(rest[i]);
        if (d && !d[1].startsWith('_')) methods.add(d[1]);
      }
      break;
    }
  } else if (lang === 'go') {
    const m = new RegExp(`((?:^//.*\\n)*)^type ${name}(?: =| struct|\\[| interface)([^\\n]*)`, 'm').exec(src.go);
    if (m) {
      doc = m[1].replace(/^\/\/ ?/gm, '');
      for (const [, n] of src.go.matchAll(new RegExp(`^func \\(\\w+ \\*${name}\\) ([A-Z]\\w*)\\(`, 'gm'))) methods.add(n);
      // An alias of the runtime core's type (KnowledgeBaseEventStream = core.Stream[…]) has that type's methods
      const alias = /core\.(\w+)/.exec(m[2])?.[1];
      if (alias) for (const [, n] of src.go.matchAll(new RegExp(`^func \\(\\w+ \\*${alias}\\[[^\\]]*\\]\\) ([A-Z]\\w*)\\(`, 'gm'))) methods.add(n);
    }
  } else if (lang === 'rust') {
    const m = new RegExp(`((?:^///.*\\n)*)(?:^#\\[.*\\n)*^pub (?:struct|type|enum) ${name}\\b([^\\n]*)`, 'm').exec(src.rustAll);
    if (m) {
      doc = m[1].replace(/^\/\/\/ ?/gm, '');
      const target = /= rt::(\w+)/.exec(m[2])?.[1] ?? name;
      for (const im of src.rustAll.matchAll(new RegExp(`^impl(?:<[^>]*>)? ${target}(?:<[^{]*>)? \\{`, 'gm'))) {
        const body = src.rustAll.slice(im.index + im[0].length - 1, closing(src.rustAll, im.index + im[0].length - 1));
        for (const [, n] of body.matchAll(/^ {4}pub (?:async )?fn ([a-z]\w*)/gm)) methods.add(n);
      }
      if (/Request$/.test(name) && new RegExp(`impl std::future::IntoFuture for ${name}\\b`).test(src.rustAll)) methods.add('await');
    }
  }
  // Rust's intra-doc links ([`Message`]) and reStructuredText's double backticks read as code
  return { doc: typeDoc(doc.replace(/\[`?([\w:]+)`?\](\([^)]*\))?/g, '`$1`').replace(/``/g, '`')), methods: [...methods] };
}

/** Every source the SDK types are read from, beside sdkSource()'s */
function sdkTypeSources(src) {
  const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
  const dir = (d, ext) => fs.readdirSync(path.join(root, d)).filter((f) => f.endsWith(ext) && !/_test\.go$|\.test\.ts$/.test(f)).map((f) => read(`${d}/${f}`));
  return {
    tsAll: [src.tsClient.join('\n'), ...dir('typescript/packages/sdk-core/src', '.ts')],
    pyAll: [src.py.join('\n'), read('python/caitlyn/caitlyn/models.py'), ...dir('python/caitlyn-core/src/caitlyn_core', '.py')],
    go: [src.go, ...dir('go/core', '.go')].join('\n'),
    rustAll: [src.rust, src.rustScopes, ...dir('rust/caitlyn-sdk-core/src', '.rs')].join('\n'),
  };
}

/**
 * The SDK types area's pages, one per family: each type the response panes name, under its language, with its doc
 * comment, its methods, and the calls that return it. `used` is sdkReturns' record: { family: { "lang name": { lang,
 * name, by: [operation names] } } }.
 */
export function sdkTypePages(used) {
  const src = sdkSource();
  const sources = sdkTypeSources(src);
  const pages = [];
  for (const family of SDK_TYPE_FAMILIES) {
    const types = Object.values(used[family.key] ?? {}).sort((a, b) => Object.keys(LANG_LABEL).indexOf(a.lang) - Object.keys(LANG_LABEL).indexOf(b.lang) || a.name.localeCompare(b.name));
    const out = [family.lead, ''];
    for (const lang of Object.keys(LANG_LABEL)) {
      const list = types.filter((t) => t.lang === lang);
      if (!list.length) continue;
      out.push(`## ${LANG_LABEL[lang]}`, '');
      for (const t of list) {
        const info = t.info ?? sdkTypeInfo({ ...src, ...sources }, lang, t.raw ?? t.name);
        out.push(`### \`${t.name}\` {#${sdkTypeAnchor(lang, t.name)}}`, '');
        if (t.doc ?? info.doc) out.push(t.doc ?? info.doc, '');
        if (info.methods.length) out.push(`Methods: ${info.methods.map((m) => `\`${m}\``).join(', ')}.`, '');
        if (t.by?.length) out.push(`Returned by ${[...new Set(t.by)].map((n) => `[${n}](/reference/${kebab(n)}/)`).join(', ')}.`, '');
      }
    }
    pages.push({
      slug: sdkTypeSlug(family.key),
      title: family.title,
      metadata: { pageType: 'sdk', sinceVersion: 0, resources: [], integrations: [], operations: [...new Set(types.flatMap((t) => t.by ?? []))].sort() },
      body: out.join('\n'),
      group: 'sdk-types',
      label: family.title,
    });
  }
  return pages;
}

// ------------------------------------------------------------------------------------------ the row adapter

/** A schema's $ref name, or null */
const refName = (schema) => (schema?.$ref ? schema.$ref.split('/').pop() : null);

function adapter(doc, ast, typePages) {
  const schemas = doc.components?.schemas ?? {};
  const resolve = (schema) => (schema?.$ref ? schemas[refName(schema)] ?? {} : schema ?? {});
  const shapeId = (name) => (name && ast.shapes[`ai.caitlyn.v3#${name}`] ? `ai.caitlyn.v3#${name}` : null);

  /** How a schema's type reads: a link for a type with a page, list of, map of, or the simple type */
  const typeText = (schema) => {
    const name = refName(schema);
    if (name && typePages.has(shapeId(name))) return `[${name}](/${typeSlug(shapeId(name))}/)`;
    const s = resolve(schema);
    if (s.type === 'array') return `list of ${typeText(s.items)}`;
    if (s.type === 'object' && s.additionalProperties && !s.properties) return `map of string to ${typeText(s.additionalProperties)}`;
    if (s.contentMediaType === 'text/event-stream') return 'event stream';
    if (s.type === 'string' && s.format === 'date-time') return 'timestamp (RFC 3339)';
    if (s.type === 'object' && !s.properties) return 'JSON';
    return s.type ?? (s.oneOf || s.anyOf ? 'one of several shapes' : 'JSON');
  };

  /** The limits on the muted line: the property's own, then its $ref's */
  const limits = (schema) => {
    const s = { ...resolve(schema), ...(schema?.$ref ? {} : schema) };
    const isList = s.type === 'array';
    const isMap = s.type === 'object';
    const len = isList ? { min: s.minItems, max: s.maxItems } : isMap ? { min: s.minProperties, max: s.maxProperties } : { min: s.minLength, max: s.maxLength };
    const range = { min: s.minimum, max: s.maximum };
    const def = s.default !== undefined && !(typeof s.default === 'object' && s.default && !Object.keys(s.default).length) ? s.default : undefined;
    const has = (c) => c.min !== undefined || c.max !== undefined;
    return { len: has(len) ? len : null, range: has(range) ? range : null, def, pattern: s.pattern, unit: isList ? 'items' : isMap ? 'entries' : 'characters' };
  };

  /** The model's member for a property of a named schema (by its wire name), for its SDK name and description */
  const modelMember = (owner, wire) => {
    const id = shapeId(owner);
    if (!id) return null;
    for (const [name, m] of Object.entries(members(ast, id))) if ((m.traits?.[T('jsonName')] ?? name) === wire) return { name, m };
    return null;
  };

  /** The structure whose properties a schema's rows show (through a list or a map), with its name for the cycle check */
  const nested = (schema) => {
    const name = refName(schema);
    const s = resolve(schema);
    if (s.type === 'array') return nested(s.items);
    if (s.type === 'object' && s.additionalProperties && !s.properties) return nested(s.additionalProperties);
    if (s.properties) return { name, schema: s };
    return null;
  };

  /** One row: the wire name, the SDK's name as a chip when it differs, Required, the muted line, the description */
  const row = ({ wire, sdk, required, schema, doc: given, depth, seen }) => {
    const l = limits(schema);
    const doc = withoutRepeats(oneLine(given ?? resolve(schema).description ?? ''), { len: l.len, range: l.range, def: l.def });
    const values = resolve(schema).enum ?? resolve(resolve(schema).items).enum ?? [];
    const inner = nested(schema);
    const children = inner && depth < 3 && !(inner.name && seen.has(inner.name)) ? rows(inner.schema, inner.name, { depth: depth + 1, seen: new Set([...seen, inner.name]) }) : '';
    return paramRow({
      name: wire,
      chip: sdk && sdk !== wire ? { text: sdk, title: 'In the SDKs', sr: 'in the SDKs', icon: 'sdk' } : null,
      required,
      meta: [typeText(schema), ...limitParts(l)],
      doc,
      values,
      children,
    });
  };

  /** An object schema's properties as rows, inside the rows' wrapper */
  const rows = (schema, owner, { depth = 0, seen = new Set(), sdkOf = null } = {}) => {
    const s = resolve(schema);
    const required = new Set(s.required ?? []);
    const out = ['<div class="caitlyn-params">', ''];
    for (const [wire, prop] of Object.entries(s.properties ?? {})) {
      const member = sdkOf ? sdkOf(wire) : modelMember(owner, wire);
      out.push(...row({ wire, sdk: member?.name, required: required.has(wire), schema: prop, doc: prop.description ?? member?.m.traits?.[T('documentation')], depth, seen }));
    }
    out.push('</div>', '');
    return out.join('\n');
  };

  return { resolve, typeText, limits, row, rows, modelMember };
}

// ------------------------------------------------------------------------------------------ examples and curl

/** The examples of an operation: each key (ListDocuments_example1) in order, its title, request values and response */
function operationExamples(op) {
  const keys = new Map();
  const note = (key, summary, description) => {
    if (!keys.has(key)) keys.set(key, { key, title: summary, description: description || '', path: {}, query: {}, header: {}, body: undefined, response: null });
    return keys.get(key);
  };
  for (const p of op.parameters ?? []) for (const [k, e] of Object.entries(p.examples ?? {})) note(k, e.summary, e.description)[p.in][p.name] = e.value;
  for (const [k, e] of Object.entries(op.requestBody?.content?.['application/json']?.examples ?? {})) note(k, e.summary, e.description).body = e.value;
  for (const [status, r] of Object.entries(op.responses ?? {})) {
    for (const [type, c] of Object.entries(r.content ?? {})) for (const [k, e] of Object.entries(c.examples ?? {})) note(k, e.summary, e.description).response = { status: Number(status), type, value: e.value };
  }
  const n = (k) => Number(/(\d+)$/.exec(k)?.[1] ?? 0);
  return [...keys.values()].sort((a, b) => n(a.key) - n(b.key));
}

/** A shell word in single quotes */
const sh = (v) => `'${String(v).replace(/'/g, `'\\''`)}'`;

/** The example as a curl command: the reader's workspace (the Server block's, your-company.getcaitlyn.ai until one is
 * given) and $CAITLYN_TOKEN, never a token of its own */
export function curl(route, method, op, ex) {
  const path = route.replace(/\{([^}]+)\}/g, (_, name) => encodeURIComponent(ex.path[name] ?? `{${name}}`));
  const url = `https://${WORKSPACE}/api${path}`;
  const stream = Object.values(op.responses ?? {}).some((r) => r.content?.['text/event-stream']);
  const query = Object.entries(ex.query);
  const lines = method === 'GET' ? ['curl --get'] : [`curl --request ${method}`];
  if (stream) lines[0] += ' --no-buffer';
  if (method === 'GET' || !query.length) lines.push(`--url ${sh(url)}`);
  else lines.push(`--globoff --url ${sh(`${url}?${query.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&')}`)}`);
  lines.push('--header "Authorization: Bearer $CAITLYN_TOKEN"');
  if (stream) lines.push(`--header ${sh('Accept: text/event-stream')}`);
  for (const [name, v] of Object.entries(ex.header)) lines.push(`--header ${sh(`${name}: ${v}`)}`);
  if (method === 'GET') for (const [k, v] of query) lines.push(`--data-urlencode ${sh(`${k}=${v}`)}`);
  if (ex.body !== undefined) lines.push(`--header ${sh('Content-Type: application/json')}`, `--data ${sh(JSON.stringify(ex.body, null, 2).replace(/\n/g, '\n  '))}`);
  return lines.join(' \\\n  ');
}

/** The example's HTTP response as the panel shows it */
function httpResponse(op, ex, successStatus) {
  const r = ex.response;
  if (!r) return { status: successStatus, text: null };
  const type = r.status >= 400 ? 'application/problem+json' : r.type;
  return { status: r.status, text: `HTTP/1.1 ${r.status} ${API_STATUS_TEXT[r.status] ?? ''}`.trimEnd() + `\nContent-Type: ${type}\n\n${JSON.stringify(r.value, null, 2)}` };
}

// ------------------------------------------------------------------------------------------------ the pages

/**
 * The overview and one page per operation, in the shape scripts/docs-build.mjs takes ({ slug, title, metadata, body,
 * siteBody, operation, group, label }), plus the old Scalar anchors (#tag/...) each page replaces.
 * ctx: { ast, ops, sdkPages (by operation name), typePages (the type ids with a page), tree (namespaceTree), unreleased
 * and next (as scripts/docs-reference.mjs referencePages gives them; the snapshot's and the lock's by default) }
 */
export function apiPages(doc, { ast, ops, sdkPages, typePages, tree, unreleased = unreleasedOperations(), next = nextRelease() }) {
  const A = adapter(doc, ast, typePages);
  const opByName = new Map(ops.map((o) => [o.name, o]));
  const errors = allErrors(ast);
  const pages = [];
  const anchors = {};
  for (const { route, method, operation } of apiOperations(doc)) {
    const op = opByName.get(operation.operationId);
    const sdk = sdkPages.get(op.name);
    const slug = `api/${kebab(op.name)}`;
    // The live site's addresses for the operation (its tag then was its model namespace's last segment, and a nested
    // namespace's operations were under their parent's tag before that) go to its page
    anchors[`tag/${tagSlug(namespaceLabel(op.namespace, op))}/${method}${route}`] = `/${slug}/`;
    if (op.namespace?.includes('.')) anchors[`tag/${tagSlug(namespaceLabel(op.namespace.split('.')[0]))}/${method}${route}`] ??= `/${slug}/`;
    const live = !unreleased.has(op.name);
    const description = operation.description.replace(/^Using an SDK\?.*\n\n/, '');
    const sdkLink = `[\`${tree.callOf.get(op.name)}()\`](/${sdk.slug}/)`;
    const md = [];
    const site = [];
    const both = (...lines) => {
      md.push(...lines);
      site.push(...lines);
    };
    both(description, '');
    // A batch's, a document's and a folder's progress is on the knowledge base's watch, filtered to it
    const follows = { 'knowledgeBases.ingestion.batches': ['batch', 'batch', 'identifier'], 'knowledgeBases.documents': ['document', 'document', 'identifier'], 'knowledgeBases.folders': ['folder', 'folder', 'path'] }[tree.groupOf.get(op.name)];
    if (follows && op.name !== 'WatchKnowledgeBase') both(`**Follow progress:** [Watch a knowledge base](/api/watch-knowledge-base/) with \`${follows[1]}\` set to the ${follows[0]}'s ${follows[2]} sends a snapshot of the ${follows[0]}, then each change.`, '');
    if (!live) both(notYetNote(next), '');
    md.push('| | |', '| --- | --- |', `| HTTP | \`${method} /api${route}\` |`, `| Server | \`https://{workspace}/api\`, where \`workspace\` is your workspace's hostname |`, `| SDK | ${sdkLink} in the SDK reference |`, '');

    // Request
    const params = operation.parameters ?? [];
    const input = members(ast, op.shape.input.target);
    const sdkName = (where, wire) => Object.entries(input).find(([name, m]) => {
      const b = m.traits ?? {};
      if (where === 'path') return b[T('httpLabel')] && name === wire;
      if (where === 'query') return b[T('httpQuery')] === wire;
      if (where === 'header') return b[T('httpHeader')] === wire;
      return !b[T('httpLabel')] && !b[T('httpQuery')] && !b[T('httpHeader')] && (b[T('jsonName')] ?? name) === wire;
    })?.[0];
    const body = operation.requestBody?.content?.['application/json']?.schema;
    // Where the code panel sits when the page is one column (src/scripts/operation-panel.ts)
    site.push('<div class="caitlyn-panel-slot" data-operation-panel-slot></div>', '');
    both('## Request', '');
    md.push('| Parameter | In | Type | Description |', '| --- | --- | --- | --- |');
    for (const p of params) md.push(`| \`${p.name}\`${p.required ? ' (required)' : ''} | ${p.in} | ${cell(A.typeText(p.schema))} | ${cell(p.description)} |`);
    if (body) {
      const s = A.resolve(body);
      for (const [wire, prop] of Object.entries(s.properties ?? {})) md.push(`| \`${wire}\`${(s.required ?? []).includes(wire) ? ' (required)' : ''} | body | ${cell(A.typeText(prop))} | ${cell(prop.description ?? A.modelMember(local(op.shape.input.target), wire)?.m.traits?.[T('documentation')])} |`);
    }
    if (!params.length && !body) md.push('| | | | No parameters. |');
    md.push('');
    for (const [where, label, icon] of [['path', 'Path parameters', 'path'], ['query', 'Query parameters', 'query'], ['header', 'Headers', 'header']]) {
      const list = params.filter((p) => p.in === where);
      if (!list.length) continue;
      site.push(groupLabel(icon, label), '', '<div class="caitlyn-params">', '');
      for (const p of list) site.push(...A.row({ wire: p.name, sdk: sdkName(where, p.name), required: !!p.required, schema: p.schema, doc: p.description, depth: 0, seen: new Set() }));
      site.push('</div>', '');
    }
    if (body) site.push(groupLabel('body', 'Body'), '', A.rows(body, null, { sdkOf: (wire) => { const name = sdkName('body', wire); return name ? { name, m: input[name] } : null; } }), '');

    // Responses
    both('## Responses', '');
    const statuses = Object.entries(operation.responses ?? {});
    const ev = eventsUnion(ast, op);
    const siteStatuses = [];
    md.push('| Status | Content | Codes |', '| --- | --- | --- |');
    let successStatus = 200;
    for (const [code, r] of statuses) {
      const status = Number(code);
      const [type, content] = Object.entries(r.content ?? {})[0] ?? [];
      const schemaName = refName(content?.schema);
      if (status < 400) {
        successStatus = status;
        const headers = Object.entries(r.headers ?? {});
        const headerRows = headers.length ? [groupLabel('header', 'Headers'), '', '<div class="caitlyn-params">', '', ...headers.flatMap(([name, h]) => A.row({ wire: name, required: false, schema: h.schema, doc: h.description, depth: 0, seen: new Set() })), '</div>', ''] : [];
        if (type === 'text/event-stream') {
          md.push(`| ${status} | \`text/event-stream\`: [ConversationEvent](/${typeSlug(ev.id)}/) events | |`);
          siteStatuses.push(statusRow(status, 'Event stream', [
            `A \`text/event-stream\` of [ConversationEvent](/${typeSlug(ev.id)}/) events, each an \`event:\` line naming it, a \`data:\` line with its JSON and an \`id:\`. A dropped connection resumes from the last \`id:\` with \`Last-Event-ID\`.`,
            '',
            groupLabel('events', 'Events'),
            '',
            memberTree(ast, Object.fromEntries(Object.values(ev.shape.members).map((m) => [m.traits?.[T('jsonName')], m])), typePages, { wireNames: true }),
            ...headerRows,
          ], { open: true }));
        } else {
          md.push(`| ${status} | \`${type ?? 'none'}\` | |`);
          siteStatuses.push(statusRow(status, API_STATUS_TEXT[status] ?? '', [...headerRows, ...(content ? [groupLabel('body', 'Response fields'), '', A.rows(content.schema, local(op.shape.output.target)), ''] : [])], { open: true }));
        }
        continue;
      }
      // An error status: its codes, each linking to its page, and when it happens
      const errName = schemaName?.replace(/ResponseContent$/, '');
      const err = errors.find((e) => e.name === errName);
      const codes = err?.codes ?? [];
      md.push(`| ${status} | \`application/problem+json\` | ${codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(', ')} |`);
      siteStatuses.push(statusRow(status, API_STATUS_TEXT[status] ?? '', [
        `<span class="caitlyn-param-values">${codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(' ')}</span>`,
        '',
        `<span class="caitlyn-param-doc">${oneLine(A.resolve(content?.schema).description ?? err?.doc ?? '')}</span>`,
        '',
      ]));
    }
    md.push('', 'Every error is an RFC 9457 problem details object, `application/problem+json`, whose `code` names the error ([Errors](/errors/)).', '');
    site.push('<div class="caitlyn-statuses">', '', ...siteStatuses, '</div>', '', 'Every error is an RFC 9457 problem details object, `application/problem+json`, whose `code` names the error ([Errors](/errors/)).', '');

    // Examples
    const exs = operationExamples(operation);
    const sdkPanel = sdk.operation?.panel ?? [];
    const events = sdkPanel.find((p) => p.events)?.events ?? null;
    const panel = [];
    if (exs.length) {
      both('## Examples', '');
      site.push('Each example\'s request and response are in the code panel, in curl or the site\'s code language. Choose an example to show it there.', '', '<div class="caitlyn-example-list">', '');
      for (const ex of exs) {
        md.push(`### ${ex.title}`, '');
        site.push(`### [${ex.title}](#${headingId(ex.title)})`, '');
        if (ex.description) both(ex.description, '');
        const command = curl(route, method, operation, ex);
        const res = httpResponse(operation, ex, successStatus);
        md.push('```sh', command, '```', '');
        if (res.text) md.push('```http', res.text, '```', '');
        else if (ev) md.push(`Then the events, each as \`event: <name>\` and \`data: <JSON>\` lines with an \`id:\`, ending with \`${ev.shape.members[ev.final]?.traits?.[T('jsonName')]}\`.`, '');
        const sdkEx = sdkPanel.find((p) => p.title === ex.title);
        panel.push({
          title: ex.title,
          code: { curl: command, ...(sdkEx?.code ?? {}) },
          status: res.status,
          result: null,
          response: res.text,
          events: !res.text && ev ? events : null,
        });
      }
      site.push('</div>', '');
    }

    // Every status the operation documents, for the response pane: an example's HTTP response when the document has one
    // with that status, otherwise the SDK reference's body for it (an example, or the problem details every error has)
    // as an HTTP response; a stream's success is its sample events
    const sdkResponses = sdk.operation?.responses ?? [];
    const responses = statuses.map(([code]) => {
      const status = Number(code);
      const own = panel.find((p) => p.status === status && (p.response || p.events));
      if (own) return { status, response: own.response, events: own.events, sample: false };
      const r = sdkResponses.find((x) => x.status === status);
      if (r?.events) return { status, response: null, events: r.events, sample: r.sample };
      if (r?.result) return { status, response: `HTTP/1.1 ${status} ${API_STATUS_TEXT[status] ?? ''}`.trimEnd() + `\nContent-Type: ${status >= 400 ? 'application/problem+json' : 'application/json'}\n\n${r.result}`, events: null, sample: r.sample, code: r.code };
      return { status, response: null, events: null, sample: true };
    });

    pages.push({
      slug,
      title: operationTitle(op),
      subtitle: op.name,
      metadata: { ...sdk.metadata },
      body: md.join('\n'),
      siteBody: site.join('\n'),
      operation: {
        kind: 'api',
        name: op.name,
        stability: sdk.operation.stability,
        method: tree.callOf.get(op.name),
        calls: sdk.operation.calls,
        http: { method, path: `/api${route}` },
        panel,
        responses,
      },
      group: tree.groupOf.get(op.name),
      label: operationTitle(op),
      route,
      method,
      summary: firstSentence(description),
    });
  }
  // In the SDK reference's order, so the two sidebars list the operations alike
  const order = [];
  walkTree(tree, (n) => order.push(...n.entries.filter((e) => e.op).map((e) => e.op.name)));
  const rank = (p) => order.indexOf(p.operation.name);
  pages.sort((a, b) => rank(a) - rank(b));
  return { pages, anchors };
}

/** The overview at /api/: what the API is, its server, how to authenticate, every operation by resource, and the
 * OpenAPI document. Its Server block is the page's own (src/components/PageTitle.astro shows it). The site's page lists
 * the operations as rows (the method in its colour, the name, the path, what it does); the Markdown copy as a list. */
export function apiOverview(pages, { tree }) {
  const head = [
    'Every operation of the Caitlyn v3 API over HTTP: its request, its responses and its errors, with each example as a curl command and in each SDK.',
    '',
    '## Server',
    '',
    `Every request goes to your workspace's own hostname, \`https://{workspace}/api\`, where \`workspace\` is the hostname you sign in at, such as \`${WORKSPACE}\`. Give yours in the Server block and every example on this site uses it.`,
    '',
    '## Authentication',
    '',
    'Every request carries a Caitlyn access token as a bearer token, `Authorization: Bearer <token>`. A person signs in, or an API client signs in as itself; either way the token is short-lived. The examples read it from `$CAITLYN_TOKEN`. [Authentication](/authentication/) explains how to get one.',
    '',
    '## Operations',
    '',
  ];
  const tail = ['## The OpenAPI document', '', 'The API as an OpenAPI 3.1 document, for tools that generate clients or import requests: [Download the OpenAPI document](/api/openapi.json).', ''];
  const md = [...head];
  const site = [...head];
  // Each group under a heading a level below its parent's, with its own operations as rows; a group with no operations
  // in it or below it (one holding only SDK helpers) is left out
  const has = (n) => pages.some((p) => p.group === n.key) || n.children.some(has);
  walkTree(tree, (n, depth, parents) => {
    if (!has(n) || !parents.every(has)) return;
    const level = '#'.repeat(Math.min(3 + depth, 6));
    md.push(`${level} ${n.label}`, '');
    site.push(`${level} ${n.label}`, '');
    const list = pages.filter((p) => p.group === n.key);
    if (!list.length) return;
    site.push('<div class="caitlyn-api-ops">', '');
    for (const p of list) {
      md.push(`- \`${p.method} ${p.route}\` [${p.title}](/${p.slug}/) (${p.subtitle}): ${p.summary}`);
      site.push('<div class="caitlyn-api-op">', '', `<span class="caitlyn-http-method" data-method="${p.method}">${p.method}</span> [${p.title}](/${p.slug}/) <code class="caitlyn-api-op-path">${p.route}</code>`, '', `<span class="caitlyn-param-doc">${p.summary}</span>`, '', '</div>', '');
    }
    md.push('');
    site.push('</div>', '');
  });
  return { body: [...md, ...tail].join('\n'), siteBody: [...site, ...tail].join('\n') };
}
