// The API reference, generated from the model: one page per public operation, one per type the operations use,
// and one per error code (the `type` URI every error body carries, https://build.caitlyn.ai/errors/{code}).
// Each page is Markdown with its knowledge-base metadata; scripts/docs-build.mjs turns them into the site and
// the Markdown copies. Operation pages show the call in each SDK, the request and response members, the events of
// a stream, the permission checked, the errors, and every @examples entry as a runnable program per language
// (scripts/docs-snippets.mjs, compiled in CI) with the HTTP exchange.
import { C, T, allErrors, binding, callOption, eventsUnion, kebab, local, names, operations, retrySafe } from './docs-model.mjs';
import { LANGUAGES, snippets } from './docs-snippets.mjs';
import { OPTIONS, sinceVersion } from './docs-metadata.mjs';
import { ERROR_CODES } from '../docs/error-codes.mjs';

/** The operations Caitlyn workspaces serve today; every other operation's page says it is not available yet. */
export const LIVE_OPERATIONS = new Set([]);

const NOT_YET = '> **Not available yet.** The SDKs have this operation, but Caitlyn workspaces do not serve it yet, so a call\n' +
  '> gets 404. This page describes how it works.';

const STABILITY = {
  ga: 'Generally available',
  beta: 'Beta: public, and may still change before it is generally available',
};

const plural = (n) => (n.endsWith('y') ? `${n.slice(0, -1)}ies` : n.endsWith('s') ? `${n}es` : `${n}s`);
const singular = (n) => (n.endsWith('ies') ? `${n.slice(0, -3)}y` : n.endsWith('ses') ? n.slice(0, -2) : n.replace(/s$/, ''));
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();
const cell = (s) => oneLine(s ?? '').replace(/\|/g, '\\|');
const firstSentence = (s) => (/^(.+?\.)(\s|$)/s.exec(oneLine(s))?.[1] ?? oneLine(s));

/** A shape's members, with its mixins' members first (the JSON AST does not copy them into the shape). */
export function members(ast, id) {
  const s = ast.shapes[id];
  if (!s) return {};
  const out = {};
  for (const { target } of s.mixins ?? []) Object.assign(out, members(ast, target));
  for (const [k, m] of Object.entries(s.members ?? {})) out[k] = out[k] ? { ...out[k], ...m, traits: { ...out[k].traits, ...m.traits } } : m;
  return out;
}

/** The named shapes that get a type page: structures, enums and unions an operation uses, apart from its own
 * input and output, errors, and mixins. */
function typeShapes(ast, ops) {
  const S = ast.shapes;
  const skip = new Set();
  for (const op of ops) {
    skip.add(op.shape.input.target);
    skip.add(op.shape.output.target);
  }
  const found = new Set();
  const walk = (id) => {
    const s = S[id];
    if (!s || found.has(id) || !id.startsWith('ai.caitlyn.v3#')) return;
    if (s.traits?.[T('error')]) return;
    if (['structure', 'union', 'enum', 'intEnum'].includes(s.type) && !skip.has(id) && !s.traits?.[T('mixin')]) found.add(id);
    if (s.type === 'list') return walk(s.member.target);
    if (s.type === 'map') return walk(s.value.target);
    for (const m of Object.values(members(ast, id))) walk(m.target);
  };
  for (const op of ops) {
    for (const m of Object.values(members(ast, op.shape.input.target))) walk(m.target);
    for (const m of Object.values(members(ast, op.shape.output.target))) walk(m.target);
    const ev = eventsUnion(ast, op);
    if (ev) walk(ev.id);
  }
  return [...found].sort((a, b) => local(a).localeCompare(local(b)));
}

export const typeSlug = (id) => `reference/types/${kebab(local(id))}`;

/** How a member's type reads in a table: a link for named shapes, `list of …`, `map of …`, or the simple type. */
function typeText(ast, target, typePages) {
  const S = ast.shapes;
  const s = S[target];
  if (typePages.has(target)) return `[${local(target)}](/${typeSlug(target)}/)`;
  if (!s) return local(target).toLowerCase();
  if (s.type === 'list') return `list of ${typeText(ast, s.member.target, typePages)}`;
  if (s.type === 'map') return `map of string to ${typeText(ast, s.value.target, typePages)}`;
  if (s.type === 'timestamp') return 'timestamp (RFC 3339)';
  if (s.type === 'blob' && s.traits?.[T('streaming')]) return 'event stream';
  if (s.type === 'document') return 'JSON';
  return s.type;
}

/** Constraints the description does not already say: length and pattern. */
function constraints(ast, member) {
  const s = ast.shapes[member.target];
  const t = { ...s?.traits, ...member.traits };
  const out = [];
  const len = t[T('length')];
  if (len && (len.min !== undefined || len.max !== undefined)) {
    const unit = s?.type === 'list' ? 'items' : s?.type === 'map' ? 'entries' : 'characters';
    out.push(len.min !== undefined && len.max !== undefined ? `${len.min} to ${len.max} ${unit}.` : len.max !== undefined ? `At most ${len.max} ${unit}.` : `At least ${len.min} ${unit}.`);
  }
  if (t[T('pattern')]) out.push(`Pattern \`${t[T('pattern')]}\`.`);
  return out.join(' ');
}

function where(b) {
  if (b.in === 'path') return 'path';
  if (b.in === 'query') return `query \`${b.name}\``;
  if (b.in === 'header') return `header \`${b.name}\``;
  if (b.in === 'payload') return 'body';
  return 'body';
}

/** A Markdown table of members: name, type, where it is sent (when asked) and description. */
function memberTable(ast, mems, typePages, { showWhere = false, wireNames = false } = {}) {
  const rows = Object.entries(mems)
    .filter(([, m]) => binding(m).in !== 'status')
    .map(([name, m]) => {
      const t = m.traits ?? {};
      const shown = wireNames ? (t[T('jsonName')] ?? name) : name;
      const req = t[T('required')] ? ' (required)' : '';
      const doc = [cell(t[T('documentation')]), constraints(ast, m)].filter(Boolean).join(' ');
      const cols = [`\`${shown}\`${req}`, typeText(ast, m.target, typePages)];
      if (showWhere) cols.push(where(binding(m)));
      cols.push(doc);
      return `| ${cols.join(' | ')} |`;
    });
  if (!rows.length) return '';
  const head = showWhere ? '| Member | Type | Sent in | Description |\n| --- | --- | --- | --- |' : '| Member | Type | Description |\n| --- | --- | --- |';
  return `${head}\n${rows.join('\n')}`;
}

const CALLERS = { person: 'people (signed in, or a personal access token)', api_client: 'API clients (machine sign-in)', guest: 'guests (a guest token)' };

function permissionText(op) {
  const p = op.shape.traits?.[C('permission')];
  if (!p) return null;
  const lines = [`- **Permission:** \`${p.action}\`.`];
  if (p.entity) {
    const what = singular(p.entity.type).replace(/-/g, ' ');
    let entity = `- **Checked on:** the ${what} named by \`${p.entity.from}\``;
    if (p.entity.level) entity += `, which needs the \`${p.entity.level}\` grant`;
    entity += '.';
    if (p.entity.version) entity += ` The version in \`${p.entity.version}\` is checked too: \`production\` needs only access to the agent; the draft and pinned versions also need the agent's version access grant.`;
    if (p.entity.fixedVersion) entity += ` The ${p.entity.fixedVersion} is checked too, so the caller also needs the agent's version access grant.`;
    if (p.entity.documentAccess) entity += ` The folder in \`${p.entity.documentAccess}\` must be one the caller can reach.`;
    lines.push(entity);
  }
  if (p.list) lines.push(`- **Listed:** only what the caller's ${singular(p.list.type).replace(/-/g, ' ')} grants allow.`);
  const callers = p.callers ?? ['person'];
  lines.push(`- **Who can call it:** ${callers.map((c) => CALLERS[c] ?? c).join(', ')}.`);
  if (p.workspace === 'primary') lines.push("- **Workspace:** only the organisation's primary workspace serves it; elsewhere it is refused with 403 [`PRIMARY_WORKSPACE_REQUIRED`](/errors/PRIMARY_WORKSPACE_REQUIRED/).");
  lines.push('', 'The checks run in this order: who is calling, the workspace and the permission (each refused with 403), then the record (404, which is also what a record the caller may not see returns). [Errors](/errors/) explains why.');
  return lines.join('\n');
}

/** How each SDK calls the operation, for the summary table. */
function sdkCalls(ast, op) {
  const input = local(op.shape.input.target);
  const pos = op.positional;
  const ts = `caitlyn.${op.namespace}.${op.method}(${pos ? `${pos}, ` : ''}{ … })`;
  const py = `caitlyn.${names.python(op.namespace)}.${names.python(op.method)}(${pos ? `${names.python(pos)}, ` : ''}…)`;
  const go = `client.${names.go(op.namespace)}.${names.go(op.method)}(ctx, ${pos ? `${names.goParam(pos)}, ` : ''}&caitlyn.${input}{…})`;
  const rs = `client.${names.rust(op.namespace)}().${names.rust(op.method)}(${pos ? `${names.rust(pos)}, ` : ''}${input} { … })`;
  return { TypeScript: ts, Python: py, Go: go, Rust: rs };
}

/** Helpers the SDKs add for an operation (PROTOCOL.md section 10, "Uploads"). */
function helpers(ast, op) {
  const t = op.shape.traits ?? {};
  if (t[C('presignedUpload')]) {
    return 'The SDKs also have `uploads.create(file)` (Python `uploads.create(file=…)`, Go `Uploads.Create`, Rust `uploads().create`), which computes the checksum, reserves the upload and sends the bytes to `uploadUrl` with `requiredHeaders`, returning the reserved upload.';
  }
  if (t[C('uploadTarget')]) {
    const member = t[C('uploadTarget')].member;
    return `The SDKs also have \`${op.namespace}.upload(file, …)\` (Python \`${op.namespace}.upload(file=…, …)\`, Go \`${names.go(op.namespace)}.Upload\`, Rust \`${op.namespace}().upload\`), which uploads the file first and then calls this operation with \`${member}\` set to the upload's ID.`;
  }
  return null;
}

function httpRequest(ast, op, input) {
  const http = op.http;
  const mems = members(ast, op.shape.input.target);
  let uri = http.uri;
  const query = [];
  const headers = [];
  const body = {};
  for (const [name, m] of Object.entries(mems)) {
    const v = input[name];
    if (v === undefined) continue;
    const b = binding(m);
    if (b.in === 'path') uri = uri.replace(`{${name}}`, encodeURIComponent(v));
    else if (b.in === 'query') query.push(`${encodeURIComponent(b.name).replace(/%5B/g, '[').replace(/%5D/g, ']')}=${encodeURIComponent(v)}`);
    else if (b.in === 'header') headers.push(`${b.name}: ${v}`);
    else body[b.name ?? name] = v;
  }
  const t = op.shape.traits ?? {};
  if (Object.values(mems).some((m) => m.traits?.[T('idempotencyToken')]) && !headers.some((h) => h.startsWith('Idempotency-Key'))) {
    headers.push('Idempotency-Key: <generated by the SDK>');
  }
  if (t[C('sseEvents')]) headers.unshift('Accept: text/event-stream');
  const hasBody = Object.values(mems).some((m) => binding(m).in === 'body');
  const lines = [`${http.method} /api${uri}${query.length ? `?${query.join('&')}` : ''} HTTP/1.1`, 'Host: your-company.getcaitlyn.ai', 'Authorization: Bearer <token>', ...headers];
  if (hasBody) lines.push('Content-Type: application/json', '', JSON.stringify(body, null, 2));
  return lines.join('\n');
}

function httpResponse(ast, op, example) {
  if (example.error) {
    const err = ast.shapes[example.error.shapeId];
    const status = err.traits[T('httpError')];
    return `HTTP/1.1 ${status}\nContent-Type: application/problem+json\n\n${JSON.stringify(example.error.content, null, 2)}`;
  }
  const out = example.output ?? {};
  const mems = members(ast, op.shape.output.target);
  const headers = [];
  const body = {};
  let status = op.shape.traits?.[T('http')]?.code ?? 200;
  for (const [name, v] of Object.entries(out)) {
    const m = mems[name];
    const b = m ? binding(m) : { in: 'body' };
    if (b.in === 'header') headers.push(`${b.name}: ${v}`);
    else if (b.in === 'status') status = v;
    else body[b.name ?? name] = v;
  }
  if (eventsUnion(ast, op)) return `HTTP/1.1 200\nContent-Type: text/event-stream\n${headers.join('\n')}`.trim();
  return `HTTP/1.1 ${status}\n${headers.length ? `${headers.join('\n')}\n` : ''}Content-Type: application/json\n\n${JSON.stringify(body, null, 2)}`;
}

function operationPage(ast, op, typePages, examples, opsUsingError) {
  const t = op.shape.traits ?? {};
  const live = LIVE_OPERATIONS.has(op.name);
  const resourceName = op.resource ? local(op.resource).replace(/Resource$/, '') : null;
  const resources = [...new Set([resourceName && kebab(resourceName), kebab(singular(op.namespace))].filter(Boolean))].filter((k) => OPTIONS.resources.includes(k));
  const metadata = { pageType: 'reference', sinceVersion: sinceVersion(op.since), resources, integrations: [], operations: [op.name] };
  const out = [];
  out.push(op.doc, '');
  if (!live) out.push(NOT_YET, '');
  const calls = sdkCalls(ast, op);
  out.push('| | |', '| --- | --- |');
  out.push(`| HTTP | \`${op.http.method} /api${op.http.uri}\` |`);
  for (const [lang, call] of Object.entries(calls)) out.push(`| ${lang} | \`${call}\` |`);
  // An operation no workspace serves cannot be generally available, whatever an older model snapshot says.
  out.push(`| Stability | ${live ? (STABILITY[op.stability] ?? STABILITY.beta) : STABILITY.beta} |`);
  if (live) out.push(`| Since | Caitlyn ${op.since} |`);
  out.push(`| Retried by the SDKs | ${retrySafe(op, ast) ? 'Yes, on 429, 503 and connection failures ([Retries](/retries/))' : 'No: it is not safe to repeat ([Retries](/retries/))'} |`);
  if (t[C('audit')]) out.push(`| Audited | As a write: ${cell(t[C('audit')].reason ?? '')} The call is refused with 503 when its audit event cannot be recorded. |`);
  out.push('');
  const helper = helpers(ast, op);
  if (helper) out.push(helper, '');

  // Request
  const inMembers = members(ast, op.shape.input.target);
  out.push('## Request', '');
  out.push(`Member names are shown as they are in TypeScript and on the wire. Python and Rust use snake case (\`${names.python('knowledgeBaseId')}\`) and Go uses exported names (\`${names.go('knowledgeBaseId')}\`).`);
  const notes = [];
  if (op.positional) notes.push(`\`${op.positional}\` is the method's first argument rather than an input field.`);
  for (const [name, m] of Object.entries(inMembers)) {
    const opt = callOption(name, m);
    if (opt === 'ifMatch') notes.push(`\`${name}\` is a call option (TypeScript \`{ ifMatch }\`, Go \`caitlyn.WithIfMatch\`, Rust \`.if_match(…)\`; Python takes \`if_match=\`).`);
    if (opt === 'idempotencyKey') notes.push(`\`${name}\` is optional: the SDKs generate one per call and reuse it on every retry. Pass your own as a call option (TypeScript \`{ idempotencyKey }\`, Python \`idempotency_key=\`, Go \`caitlyn.WithIdempotencyKey\`, Rust \`.idempotency_key(…)\`) to make a retry of your own safe.`);
  }
  if (notes.length) out.push(' ' + notes.join(' '));
  out.push('');
  out.push(memberTable(ast, inMembers, typePages, { showWhere: true }) || 'No members.', '');
  const filterable = t[C('filterable')];
  const sortable = t[C('sortable')];
  if (filterable) {
    out.push('Filters combine with AND. A filter or operator not listed here is refused with 400 [`UNKNOWN_FILTER`](/errors/UNKNOWN_FILTER/).', '');
  }
  if (sortable) out.push(`Sortable by ${sortable.fields.map((f) => `\`${f}\``).join(', ')}${sortable.default ? `; the default order is \`${sortable.default}\`` : ''}. Any other field is refused with 400 [\`UNKNOWN_SORT\`](/errors/UNKNOWN_SORT/).`, '');
  if (t[T('paginated')]) out.push('The SDKs page through the list for you: iterate the result and each page is fetched as it is needed ([Pagination](/pagination/)).', '');

  // Response
  const ev = eventsUnion(ast, op);
  out.push('## Response', '');
  if (ev) {
    out.push(`A \`text/event-stream\` of [ConversationEvent](/${typeSlug(ev.id)}/) events. The stream ends after \`${ev.shape.members[ev.final]?.traits?.[T('jsonName')] ?? ev.final}\`, which the SDKs' \`finalMessage()\` (Python \`final_message()\`, Go \`FinalMessage()\`, Rust \`final_message()\`) returns; a failure ends it with \`message.failed\`, which the SDKs raise as the typed error. ${ev.resumeWith ? `A dropped connection is resumed with [${local(ev.resumeWith)}](/reference/${kebab(local(ev.resumeWith))}/) and \`Last-Event-ID\`, so no event is lost or repeated.` : ''} See [Streaming](/streaming/).`, '');
    const rows = Object.entries(ev.shape.members).map(([, m]) => `| \`${m.traits?.[T('jsonName')]}\` | [${local(m.target)}](/${typeSlug(m.target)}/) | ${cell(m.traits?.[T('documentation')])} |`);
    out.push('| Event | Data | Description |', '| --- | --- | --- |', ...rows, '');
    const outMembers = Object.fromEntries(Object.entries(members(ast, op.shape.output.target)).filter(([, m]) => binding(m).in === 'header'));
    if (Object.keys(outMembers).length) out.push('Response headers:', '', memberTable(ast, outMembers, typePages, { showWhere: true }), '');
  } else {
    const status = t[T('http')]?.code ?? 200;
    out.push(`Status ${status}.${t[T('paginated')] ? ' One page of results; the SDKs return the items across every page.' : ''}`, '');
    out.push(memberTable(ast, members(ast, op.shape.output.target), typePages, { showWhere: true }), '');
    out.push('Every result also keeps the JSON it was read from, unknown fields included, as `raw`, and the response metadata (HTTP status, request ID, ETag).', '');
  }

  // Permissions
  const perm = permissionText(op);
  if (perm) out.push('## Permissions', '', perm, '');

  // Errors
  out.push('## Errors', '');
  out.push('The SDKs raise the error class for the response\'s HTTP status, whether or not the operation lists it ([Errors](/errors/)). The statuses this operation returns:', '');
  out.push('| Status | Error | Codes | When |', '| --- | --- | --- | --- |');
  for (const e of opsUsingError.errorsOf(op)) {
    out.push(`| ${e.status} | \`${e.name}\` | ${e.codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(', ')} | ${cell(e.doc)}${e.retryable ? ' Retried by the SDKs.' : ''} |`);
  }
  out.push('');

  // Examples
  const exs = examples.filter((s) => s.op.id === op.id);
  if (exs.length) {
    out.push('## Examples', '');
    for (const s of exs) {
      out.push(`### ${s.example.title}`, '');
      if (s.example.documentation) out.push(s.example.documentation, '');
      for (const l of LANGUAGES) out.push(`\`\`\`${l.fence} tab="${l.label}"`, s.code[l.key].trimEnd(), '```');
      out.push('');
      out.push('The HTTP exchange:', '');
      out.push('```http', httpRequest(ast, op, s.example.input), '```', '');
      out.push('```http', httpResponse(ast, op, s.example), '```', '');
      if (ev && !s.example.error && s.example.output) {
        // The model's examples of a stream have no event bodies; say what arrives rather than invent them.
        out.push(`Then the events, each as \`event: <name>\` and \`data: <JSON>\` lines with an \`id:\`, ending with \`${ev.shape.members[ev.final]?.traits?.[T('jsonName')]}\`.`, '');
      }
    }
  }
  return { slug: `reference/${kebab(op.name)}`, title: op.name, metadata, body: out.join('\n'), group: op.namespace, label: op.name };
}

function typePage(ast, id, typePages, usedBy) {
  const S = ast.shapes;
  const s = S[id];
  const name = local(id);
  const out = [];
  const doc = s.traits?.[T('documentation')];
  if (doc) out.push(doc.trim(), '');
  const ops = usedBy.get(id) ?? [];
  if (s.type === 'enum') {
    const open = /Open: new values may be added/.test(doc ?? '');
    out.push(`A string. ${open ? '' : ''}The SDKs keep a value they do not know yet as the string itself (Python: an unknown member carrying it), so a newer server never breaks an older SDK.`, '');
    out.push('| Value | Description |', '| --- | --- |');
    for (const [, m] of Object.entries(s.members)) out.push(`| \`${m.traits?.[T('enumValue')]}\` | ${cell(m.traits?.[T('documentation')])} |`);
    out.push('');
  } else if (s.type === 'union') {
    out.push('Exactly one of these, named by the SSE `event:` line. The SDKs skip an event name they do not know.', '');
    out.push('| Event | Data | Visibility | Description |', '| --- | --- | --- | --- |');
    for (const [, m] of Object.entries(s.members)) out.push(`| \`${m.traits?.[T('jsonName')]}\` | [${local(m.target)}](/${typeSlug(m.target)}/) | ${m.traits?.[C('eventClass')] ?? 'public'} | ${cell(m.traits?.[T('documentation')])} |`);
    out.push('');
  } else {
    out.push(memberTable(ast, members(ast, id), typePages, { wireNames: true }) || 'No members.', '');
    out.push('Unknown members a newer server sends are kept in the object\'s `raw`.', '');
  }
  if (ops.length) out.push(`Used by ${ops.map((o) => `[${o.name}](/reference/${kebab(o.name)}/)`).join(', ')}.`, '');
  const resources = [...new Set(ops.flatMap((o) => [o.resource && kebab(local(o.resource).replace(/Resource$/, '')), kebab(singular(o.namespace))]).filter(Boolean))].filter((k) => OPTIONS.resources.includes(k));
  const since = ops.map((o) => sinceVersion(o.since)).sort((a, b) => a - b)[0] ?? 0;
  return {
    slug: typeSlug(id),
    title: name,
    metadata: { pageType: 'reference', sinceVersion: since, resources, integrations: [], operations: ops.map((o) => o.name) },
    body: out.join('\n'),
    group: 'types',
    label: name,
  };
}

function errorPage(ast, code, err, ops) {
  const text = ERROR_CODES[code];
  if (!text) throw new Error(`docs-reference: docs/error-codes.mjs has no text for ${code}; add it`);
  const out = [];
  out.push(text.meaning.trim(), '');
  out.push('| | |', '| --- | --- |');
  out.push(`| HTTP status | ${err.status} |`);
  out.push(`| Error class | \`${err.name}\` in TypeScript and Python, \`*caitlyn.${err.name}\` in Go, \`Error::${err.name.replace(/Error$/, '')}\` in Rust |`);
  out.push(`| Retried by the SDKs | ${err.retryable ? 'Yes, for operations that are safe to repeat ([Retries](/retries/))' : 'No'} |`);
  out.push('');
  out.push('## What to do', '', text.action.trim(), '');
  out.push('## The error body', '');
  out.push(`Every error is an RFC 9457 problem details object with \`code\` set to \`${code}\` and \`type\` set to this page's address. \`requestId\` identifies the request; quote it to Caitlyn support. [Errors](/errors/) lists every field.`, '');
  if (ops.length) out.push(`Operations that document this error: ${ops.map((o) => `[${o.name}](/reference/${kebab(o.name)}/)`).join(', ')}. Any operation can return it, though: the SDKs choose the class by HTTP status.`, '');
  return {
    slug: `errors/${code}`,
    title: code,
    metadata: { pageType: 'error', sinceVersion: Math.min(...(ops.length ? ops : operations(ast)).map((o) => sinceVersion(o.since))), resources: [], integrations: [], operations: ops.map((o) => o.name) },
    body: out.join('\n'),
    group: 'errors',
    label: code,
  };
}

/** Every generated page: { slug, title, metadata, body, group, label }. */
export function referencePages(ast) {
  const ops = operations(ast);
  const types = typeShapes(ast, ops);
  const typePages = new Set(types);
  const usedBy = new Map();
  const note = (typeId, op) => {
    const list = usedBy.get(typeId) ?? [];
    if (!list.includes(op)) list.push(op);
    usedBy.set(typeId, list);
  };
  for (const op of ops) {
    const seen = new Set();
    const walk = (id) => {
      const s = ast.shapes[id];
      if (!s || seen.has(id)) return;
      seen.add(id);
      if (typePages.has(id)) note(id, op);
      if (s.type === 'list') return walk(s.member.target);
      if (s.type === 'map') return walk(s.value.target);
      for (const m of Object.values(members(ast, id))) walk(m.target);
    };
    walk(op.shape.input.target);
    walk(op.shape.output.target);
    const ev = eventsUnion(ast, op);
    if (ev) walk(ev.id);
  }
  const errors = allErrors(ast);
  const service = Object.values(ast.shapes).find((s) => s.type === 'service');
  const serviceErrors = new Set((service.errors ?? []).map((e) => e.target));
  const errorsOf = (op) => {
    const own = new Set((op.shape.errors ?? []).map((e) => e.target));
    return errors.filter((e) => own.has(e.id) || serviceErrors.has(e.id));
  };
  const examples = snippets(ast);
  const pages = [];
  for (const op of ops) pages.push(operationPage(ast, op, typePages, examples, { errorsOf }));
  for (const id of types) pages.push(typePage(ast, id, typePages, usedBy));
  for (const err of errors) {
    for (const code of err.codes) {
      const listing = ops.filter((o) => (o.shape.errors ?? []).some((e) => e.target === err.id));
      pages.push(errorPage(ast, code, err, listing));
    }
  }
  return { pages, ops, examples };
}

export { plural };
