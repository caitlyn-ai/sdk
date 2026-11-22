// The API reference, generated from the model: one page per public operation, one per type the operations use,
// and one per error code (the `type` URI every error body carries, https://build.caitlyn.ai/errors/{code}).
// Each page is Markdown with its knowledge-base metadata; scripts/docs-build.mjs turns them into the site and
// the Markdown copies. Operation pages show the call in each SDK, the request and response members, the events of
// a stream, the permission checked, the errors, and every @examples entry as a runnable program per language
// (scripts/docs-snippets.mjs, compiled in CI) with the HTTP exchange.
import fs from 'node:fs';
import path from 'node:path';
import { C, T, allErrors, binding, callOption, eventsUnion, kebab, local, names, namespacePath, nextRelease, notYetNote, notYetWords, operations, retrySafe, root, unreleasedOperations } from './docs-model.mjs';
import { namespaceTree, operationTitle, walkTree } from './docs-api.mjs';
import { LANGUAGES, goChain, snippets } from './docs-snippets.mjs';
import { placement } from './docs-scopes.mjs';
import { OPTIONS, sinceVersion } from './docs-metadata.mjs';
import { ERROR_CODES, ROUTING_CODES } from '../docs/error-codes.mjs';



/** Each stability level the model has: the badge's word and what it means (the Stability row shows both) */
export const STABILITY = {
  ga: { badge: 'GA', text: 'Generally available' },
  beta: { badge: 'Beta', text: 'Public, and may still change before it is generally available' },
  internal: { badge: 'Internal', text: 'For Caitlyn itself; not in the public SDKs' },
};
/** A stability level as its badge (src/styles/components.css .caitlyn-stability) */
export const stabilityBadge = (level) => `<span class="caitlyn-stability" data-stability="${level}">${STABILITY[level].badge}</span>`;

const plural = (n) => (n.endsWith('y') ? `${n.slice(0, -1)}ies` : n.endsWith('s') ? `${n}es` : `${n}s`);
/** A plural noun's singular: policies -> policy, statuses -> status, aliases -> alias, knowledge-bases ->
 * knowledge-base (only -sses, -xes, -zes, -ches, -shes and -uses drop -es; every other -es word, bases or
 * entries, is a plain -s) */
export const singular = (n) => (/ies$/.test(n) ? `${n.slice(0, -3)}y` : /(ss|x|z|ch|sh|us|ias)es$/.test(n) ? n.slice(0, -2) : n.replace(/s$/, ''));
const oneLine = (s) => s.replace(/\s*\n\s*/g, ' ').trim();
const cell = (s) => oneLine(s ?? '').replace(/\|/g, '\\|');
const firstSentence = (s) => (/^(.+?\.)(\s|$)/s.exec(oneLine(s))?.[1] ?? oneLine(s));
/** A heading's id as the site gives it (github-slugger, as Astro's rehypeHeadingIds): lower case, without punctuation,
 * spaces as hyphens. scripts/docs-build.mjs checks each example link against its heading's id in the built page. */
export const headingId = (text) => text.toLowerCase().replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '').replace(/ /g, '-');

/** A shape's members, with its mixins' members first (the JSON AST does not copy them into the shape). */
/** A namespace path and its trailing dot, or nothing for a method on the client itself. */
const dotted = (p) => (p ? `${p}.` : '');

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

/**
 * Type pages one type per thing replaced, old name to the thing (or renamed type) that took its place. Each old page's
 * address redirects to the new one (scripts/docs-build.mjs), so links to the old pages keep working.
 */
export const RENAMED_TYPES = {
  AgentSummary: 'Agent',
  AgentVersionSummary: 'AgentVersion',
  ConversationSummary: 'Conversation',
  ConversationScope: 'ConversationSharing',
  DocumentVersionSummary: 'DocumentVersion',
  FolderSummary: 'Folder',
  HistorySummary: 'HistoryEntry',
  IngestionBatchItemSummary: 'IngestionBatchItem',
  IngestionBatchSummary: 'IngestionBatch',
  IngestionScope: 'IngestionBoundary',
  KnowledgeBaseSummary: 'KnowledgeBase',
  MetadataField: 'Field',
  MetadataFieldInstructions: 'FieldInstructions',
  MetadataFieldScope: 'FieldLevel',
  MetadataFieldType: 'FieldType',
};

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

/**
 * The site's form of a members table (the Markdown copy keeps the table). Rows are grouped under small headings by
 * where they are sent (path, query, headers, body) when `grouped`. Each row: the name, the wire name only when it
 * differs (a query's `filter[folder][eq]`), a Required label, then one muted line joining the type and its
 * constraints ("string · 1 to 128 characters · default 20"), the description with any sentence that only repeats that
 * line removed, and an enum's values as chips. A member with members of its own (a structure, or a list or map of one)
 * opens in place to show them, three levels deep at most and never round a cycle. Markdown inside HTML blocks (a
 * blank line either side), so links and code are written as in the table and the site's rewriting and checks apply.
 */
const GROUPS = [
  { in: 'path', label: 'Path parameters', icon: 'path' },
  { in: 'query', label: 'Query parameters', icon: 'query' },
  { in: 'header', label: 'Headers', icon: 'header' },
  { in: 'body', label: 'Body', icon: 'body' },
];
/** A small label over a group of rows, with its icon */
export const groupLabel = (icon, label) => `<p class="caitlyn-param-group"><span class="caitlyn-icon" data-icon="${icon}" aria-hidden="true"></span>${label}</p>`;

export function memberTree(ast, mems, typePages, { grouped = false, bodyLabel = 'Body', wireNames = false, depth = 0, seen = new Set(), extraMeta = null } = {}) {
  const rows = Object.entries(mems).filter(([, m]) => binding(m).in !== 'status');
  if (!rows.length) return '';
  const where = (m) => { const b = binding(m).in; return b === 'payload' ? 'body' : b; };
  const sets = grouped ? GROUPS.map((g) => ({ ...g, label: g.in === 'body' ? bodyLabel : g.label, rows: rows.filter(([, m]) => where(m) === g.in) })).filter((g) => g.rows.length) : [{ rows }];
  const out = [];
  for (const set of sets) {
    if (set.label) out.push(groupLabel(set.icon, set.label), '');
    out.push(`<div class="caitlyn-params">`, '');
    for (const [name, m] of set.rows) out.push(...memberRow(ast, name, m, typePages, { wireNames, depth, seen, extraMeta }));
    out.push('</div>', '');
  }
  return out.join('\n');
}

function memberRow(ast, name, m, typePages, { wireNames, depth, seen, extraMeta }) {
  const S = ast.shapes;
  const t = m.traits ?? {};
  const b = binding(m);
  const shown = wireNames || depth ? (t[T('jsonName')] ?? name) : name;
  const wire = !depth && (b.in === 'query' || b.in === 'header') && b.name !== shown ? b.name : null;
  // The one muted line: type, then the constraints, each said once
  const shape = S[m.target];
  const all = { ...shape?.traits, ...t };
  const len = all[T('length')];
  const range = all[T('range')];
  const def = t[T('default')];
  const hasDefault = def !== undefined && def !== null && !(typeof def === 'object' && !Object.keys(def).length);
  const unit = shape?.type === 'list' ? 'items' : shape?.type === 'map' ? 'entries' : 'characters';
  const meta = [typeText(ast, m.target, typePages), ...limitParts({ len, range, def: hasDefault ? def : undefined, pattern: all[T('pattern')], unit })];
  if (extraMeta) meta.push(...extraMeta(m));
  const doc = withoutRepeats(oneLine(t[T('documentation')] ?? ''), { len, range, def: hasDefault ? def : undefined });
  const inner = nestedTarget(ast, m.target);
  const children = inner && depth < 3 && !seen.has(inner) ? memberTree(ast, members(ast, inner), typePages, { depth: depth + 1, seen: new Set([...seen, inner]) }) : '';
  return paramRow({ name: shown, chip: wire ? { text: wire, title: 'Sent as', sr: 'sent as' } : null, required: !!t[T('required')], meta, doc, values: enumValues(ast, m), children });
}

/** A member's limits for the muted line, each said once: length, range, default and pattern. Shared with the API
 * reference (scripts/docs-api.mjs), which reads them from the OpenAPI document. */
export function limitParts({ len, range, def, pattern, unit = 'characters' }) {
  const out = [];
  if (len && (len.min !== undefined || len.max !== undefined)) out.push(len.min !== undefined && len.max !== undefined ? `${len.min} to ${len.max} ${unit}` : len.max !== undefined ? `at most ${len.max} ${unit}` : `at least ${len.min} ${unit}`);
  if (range && (range.min !== undefined || range.max !== undefined)) out.push(range.min !== undefined && range.max !== undefined ? `${range.min} to ${range.max}` : range.max !== undefined ? `at most ${range.max}` : `at least ${range.min}`);
  if (def !== undefined) out.push(`default \`${JSON.stringify(def)}\``);
  if (pattern) out.push(`pattern \`${pattern}\``);
  return out;
}

/**
 * One stacked row, as Markdown inside HTML blocks: the name, a secondary name as a chip (the wire name on the SDK
 * reference, the SDK's name on the API reference), Required, the muted type and limits line, the description, an
 * enum's values as chips, and the row's own members, which it opens in place to show.
 */
export function paramRow({ name, chip = null, required = false, meta = [], doc = '', values = [], children = '' }) {
  const head = [`<span class="caitlyn-param-name">\`${name}\`</span>`];
  if (chip) head.push(`<span class="caitlyn-param-wire" title="${chip.title}"><span class="caitlyn-icon" data-icon="${chip.icon ?? 'wire'}" aria-hidden="true"></span><span class="sr-only">${chip.sr} </span>\`${chip.text}\`</span>`);
  if (required) head.push('<span class="caitlyn-param-required">Required</span>');
  const lines = [head.join(' '), ''];
  if (meta.length) lines.push(`<span class="caitlyn-param-meta">${meta.join(' · ')}</span>`, '');
  if (doc) lines.push(`<span class="caitlyn-param-doc">${doc}</span>`, '');
  if (values.length) lines.push(`<span class="caitlyn-param-values">${values.map((v) => `\`${v}\``).join(' ')}</span>`, '');
  if (children) return ['<details class="caitlyn-param">', '<summary>', '', head.join(' '), '', '</summary>', '', ...lines.slice(2), children, '</details>', ''];
  return ['<div class="caitlyn-param">', '', ...lines, '</div>', ''];
}

/** An error's problem details, as every error body has them: the shape a response pane shows for a status the model has
 * no example of. Its title is the code in words (NOT_FOUND, "Not found"), its detail what the code means. */
export function problemDetails(code, status) {
  const meaning = ERROR_CODES[code]?.meaning;
  return {
    type: `https://build.caitlyn.ai/errors/${code}`,
    title: code.charAt(0) + code.slice(1).toLowerCase().replace(/_/g, ' '),
    status,
    code,
    ...(meaning ? { detail: firstSentence(meaning) } : {}),
    requestId: '01JC9Q2W7R4M0H2T6N1S8V3B70',
  };
}

export const STATUS_TEXT = { 200: 'OK', 201: 'Created', 202: 'Accepted', 204: 'No content' };

/** A response status as a row that opens to what it carries: the status by its class (src/styles/components.css), its
 * name, then the body. Markdown inside HTML blocks. */
export function statusRow(status, label, body, { open = false } = {}) {
  return [`<details class="caitlyn-param caitlyn-status-row"${open ? ' open' : ''}>`, '<summary>', '', `<span class="caitlyn-status" data-status-class="${String(status).charAt(0)}">${status}</span> ${label}`, '', '</summary>', '', ...body, '</details>', ''].join('\n');
}

/** A number as the model's prose writes it: 32000 or 32,000. */
const numberText = (n) => `(?:${n}|${Number(n).toLocaleString('en-GB')})`;

/** The description without what the muted line already says: a "Defaults to 20." sentence, or a ", from 1 to 100" or
 * ", at most 32,000 characters" phrase, when the constraint is the same. */
export function withoutRepeats(doc, { len, range, def }) {
  let out = doc;
  if (def !== undefined) out = out.replace(new RegExp(`\\s*Defaults? to \`?${String(def).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\`?\\.`, 'i'), '');
  for (const c of [range, len]) {
    if (!c) continue;
    if (c.min !== undefined && c.max !== undefined) out = out.replace(new RegExp(`,?\\s*(?:from )?${numberText(c.min)} to ${numberText(c.max)}( characters| items)?(?=[.,;])`, 'i'), '');
    if (c.max !== undefined) out = out.replace(new RegExp(`,?\\s*at most ${numberText(c.max)}( characters| items| entries)?(?=[.,;])`, 'i'), '');
  }
  return out.replace(/\s+\./g, '.').trim();
}

/** An enum member's values (through a list), or none. */
function enumValues(ast, member) {
  let s = ast.shapes[member.target];
  if (s?.type === 'list') s = ast.shapes[s.member.target];
  if (s?.type !== 'enum') return [];
  return Object.values(s.members).map((m) => m.traits?.[T('enumValue')]);
}

/** The structure a member's members come from, through a list or a map, or null for a simple type. */
function nestedTarget(ast, target) {
  const s = ast.shapes[target];
  if (!s) return null;
  if (s.type === 'structure' || s.type === 'union') return target;
  if (s.type === 'list') return nestedTarget(ast, s.member.target);
  if (s.type === 'map') return nestedTarget(ast, s.value.target);
  return null;
}


/** An example's response as the SDK reader sees it: its status and the body's JSON, without the HTTP framing. A
 * stream's success has no body of its own (its events are the sample sequence). */
function responseBody(ast, op, example) {
  if (example.error) {
    const err = ast.shapes[example.error.shapeId];
    return { status: err.traits[T('httpError')], result: JSON.stringify(example.error.content, null, 2) };
  }
  const status = op.shape.traits?.[T('http')]?.code ?? 200;
  if (eventsUnion(ast, op)) return { status, result: null };
  return { status, result: JSON.stringify(wireBody(ast, op, example.output ?? {}), null, 2) };
}

/** A placeholder value for a shape, for sample event bodies: enums take their first value, structures their
 * required members (all of them when none is required), lists one item. */
function sampleValue(ast, target, name, depth = 0) {
  const S = ast.shapes;
  const s = S[target];
  const type = s?.type ?? local(target).toLowerCase();
  if (type === 'enum') {
    const values = Object.values(s.members).map((m) => m.traits?.[T('enumValue')]);
    return values.includes('assistant') ? 'assistant' : (values[0] ?? '');
  }
  if (type === 'string') return /id$/i.test(name) ? `${name.replace(/Id$/i, '').toLowerCase() || 'id'}-1` : `<${name}>`;
  if (['integer', 'long', 'short', 'byte'].includes(type)) return 1;
  if (['float', 'double', 'bigdecimal'].includes(type)) return 0.5;
  if (type === 'boolean') return false;
  if (type === 'timestamp') return '2026-01-01T00:00:00Z';
  if (type === 'document') return {};
  if (depth > 3) return null;
  if (type === 'list') return [sampleValue(ast, s.member.target, name, depth + 1)];
  if (type === 'map') return { key: sampleValue(ast, s.value.target, name, depth + 1) };
  if (type === 'structure' || type === 'union') {
    const mems = Object.entries(members(ast, target));
    const req = mems.filter(([, m]) => m.traits?.[T('required')]);
    const use = type === 'union' ? mems.slice(0, 1) : req.length ? req : mems;
    return Object.fromEntries(use.map(([k, m]) => [m.traits?.[T('jsonName')] ?? k, sampleValue(ast, m.target, k, depth + 1)]));
  }
  return null;
}

/** A typical sequence of a stream's events, as server-sent events: for an answer, it starts, writes two pieces of text,
 * cites a source and completes; for any other stream (a batch's, an operation's), its first few event types in the
 * model's order. Built from the event types, so its values are placeholders. */
function sampleEvents(ast, ev) {
  const chat = ['message.started', 'phase.changed', 'text.delta', 'text.delta', 'citation.added', 'message.completed'];
  const byName = new Map(Object.values(ev.shape.members).map((m) => [m.traits?.[T('jsonName')], m]));
  const order = chat.some((name) => byName.has(name)) ? chat : [...byName.keys()].filter(Boolean).slice(0, 4);
  return order
    .filter((name) => byName.has(name))
    .map((name, i) => `id: ${i + 1}\nevent: ${name}\ndata: ${JSON.stringify(sampleValue(ast, byName.get(name).target, name))}`)
    .join('\n\n');
}

const CALLERS = { person: 'people (signed in, or a personal access token)', api_client: 'API clients (machine sign-in)', guest: 'guests (a guest token)' };

function permissionText(op) {
  const p = op.shape.traits?.[C('permission')];
  if (!p) return null;
  // The permission, and any it needs as well (alsoActions: a paid job needs the ingestions permission beside the
  // knowledge base's own); a credential needs every one
  const actions = (q) => [q.action, ...(q.alsoActions ?? [])].map((x) => `\`${x}\``);
  const andList = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}` : xs[0]);
  const lines = [`- **Permission:** ${andList(actions(p))}${p.alsoActions?.length === 1 ? ', both' : p.alsoActions?.length ? ', all of them' : ''}.`];
  const checkedOn = (e) => {
    const what = singular(e.type).replace(/-/g, ' ');
    let entity = `the ${what} named by \`${e.from}\``;
    if (e.level) entity += `, which needs the \`${e.level}\` grant`;
    entity += '.';
    if (e.version) entity += ` The version in \`${e.version}\` is checked too: \`live\` needs only access to the agent; the draft and pinned versions also need the agent's version access grant.`;
    if (e.alsoVersion) entity += ` So is the version in \`${e.alsoVersion}\`, the same way.`;
    if (e.fixedVersion) entity += ` The ${e.fixedVersion} is checked too, so the caller also needs the agent's version access grant.`;
    const reach = [e.documentAccess, ...(e.alsoDocumentAccess ?? [])].filter(Boolean).map((m) => `\`${m}\``);
    if (reach.length) entity += ` The folder or document in ${andList(reach).replace(' and ', reach.length > 2 ? ', and ' : ' and ')} must be one the caller can reach, when given.`;
    return entity;
  };
  if (p.entity) lines.push(`- **Checked on:** ${checkedOn(p.entity)}`);
  // A check that replaces the operation's own when the input names something it does not cover (PutAccess on a folder
  // or a document changes only that record's readers)
  for (const v of p.whenPresent ?? []) {
    const named = andList(v.members.map((m) => `\`${m}\``)).replace(' and ', ' or ');
    lines.push(`- **With ${named}:** the permission is ${andList(actions(v))} instead${v.entity ? `, checked on ${checkedOn(v.entity)}` : '.'}`);
  }
  if (p.list) lines.push(`- **Listed:** only what the caller's ${singular(p.list.type).replace(/-/g, ' ')} grants allow.`);
  const callers = p.callers ?? ['person'];
  lines.push(`- **Who can call it:** ${callers.map((c) => CALLERS[c] ?? c).join(', ')}.`);
  if (p.workspace === 'primary') lines.push("- **Workspace:** only the organisation's primary workspace serves it; elsewhere it is refused with 403 [`PRIMARY_WORKSPACE_REQUIRED`](/errors/PRIMARY_WORKSPACE_REQUIRED/).");
  lines.push('', 'The checks run in this order: who is calling, the workspace and the permission (each refused with 403), then the record (404, which is also what a record the caller may not see returns). [Errors](/errors/) explains why.');
  return lines.join('\n');
}

/**
 * How each SDK calls the operation, for the summary table: through its place in the scope tree (docs-scopes.mjs), with
 * the identifiers the scopes take named as variables (`caitlyn.knowledgeBases(knowledgeBaseId).documents.create(file, { … })`).
 */
function sdkCalls(ast, op) {
  const mems = members(ast, op.shape.input.target);
  // Every identifier the request path takes, named by itself, so placement() finds the scope that fills it.
  const ids = Object.fromEntries(Object.entries(mems).filter(([, m]) => binding(m).in === 'path').map(([n]) => [n, `@@${n}@@`]));
  const p = placement(op.name, ids);
  const unwrap = (code, spell) => code.replace(/"?@@([A-Za-z]+)@@"?/g, (_, n) => spell(n));
  const upload = (op.shape.traits ?? {})[C('uploadTarget')]?.member;
  const jobUpload = p.estimate ? ast.shapes[`ai.caitlyn.v3#${p.method.operation}`]?.traits?.[C('uploadTarget')]?.member : upload;
  const takesFile = !!jobUpload && !jobUpload.includes('.');
  // What the call takes besides its scopes: the estimate's own members (never the file's description), less call options.
  const describes = (m) => /#UploadDescription$/.test(ast.shapes[m.target]?.type === 'list' ? ast.shapes[m.target].member.target : m.target);
  const rest = Object.entries(mems).filter(([n, m]) => !p.filled.has(n) && !callOption(n, m) && binding(m).in !== 'header' && n !== jobUpload && !describes(m) && !m.traits?.[C('fromScope')]);
  // A lone required member is taken first when at most two optional ones sit beside it (TypeScript's layout).
  const required = rest.filter(([, m]) => m.traits?.[T('required')] !== undefined);
  const first = !takesFile && required.length === 1 && rest.length <= 3 ? required[0][0] : undefined;
  const others = rest.filter(([n]) => n !== first);
  const leading = (spell) => (p.method.leading ?? []).map(spell);
  const argsOf = (spell, more) => [...leading(spell), ...(takesFile ? ['file'] : []), ...(first ? [spell(first)] : []), ...(others.length ? [more] : [])].join(', ');
  const rustWord = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const tsPath = p.steps.map((s) => `${s.name}${s.args ? `(${s.args.map((a) => unwrap(String(a), (n) => n)).join(', ')})` : ''}`).join('.');
  const ts = `caitlyn.${tsPath ? `${tsPath}.` : ''}${p.method.name}${p.estimate ? '.estimate' : ''}(${argsOf((n) => n, '{ … }')})`;
  const pyPath = p.steps.map((s) => `${names.python(s.name)}${s.args ? `(${s.args.map((a) => unwrap(String(a), (n) => names.python(n))).join(', ')})` : ''}`).join('.');
  const py = `caitlyn.${pyPath ? `${pyPath}.` : ''}${names.python(p.method.name)}${p.estimate ? '.estimate' : ''}(${argsOf((n) => names.python(n), '…')})`;
  const goName = p.estimate ? `Estimate${names.go(p.method.name)}` : names.go(p.method.name);
  const go = `client${unwrap(goChain(p.steps), (n) => names.goParam(n))}.${goName}(${['ctx', argsOf((n) => names.goParam(n), '…')].filter(Boolean).join(', ')})`;
  // A Rust accessor escapes only keywords: `client.core().uploads()`.
  const rsPath = p.steps.map((s) => (s.args ? `${rustWord(s.singular)}(${s.args.map((a) => unwrap(String(a), (n) => names.rust(n))).join(', ')})` : `${rustWord(s.name)}()`)).join('.');
  const rsName = p.estimate ? `estimate_${rustWord(p.method.name)}` : rustWord(p.method.name);
  const rs = `client.${rsPath ? `${rsPath}.` : ''}${rsName}(${argsOf((n) => names.rust(n), '…')})`;
  return { TypeScript: ts, Python: py, Go: go, Rust: rs };
}

/** Helpers the SDKs add for an operation (PROTOCOL.md section 10, "Uploads"). */
function helpers(ast, op) {
  const t = op.shape.traits ?? {};
  if (t[C('presignedUpload')]) {
    return 'The SDKs also have `core.uploads.send(file)` (Python `core.uploads.send(file)`, Go `Core.Uploads.Send`, Rust `core().uploads().send`), which computes the checksum, reserves the upload and sends the bytes to `uploadUrl` with `requiredHeaders`, returning the reserved upload. The calls that take a file use it for you.';
  }
  if (t[C('uploadTarget')]) {
    const member = t[C('uploadTarget')].member;
    const where = member.includes('.')
      ? `at \`${member}\` the SDKs take the file itself in place of the upload's ID`
      : `the SDKs take \`file\` in place of \`${member}\``;
    return `Give a file instead of an upload: ${where}. The SDK hashes and uploads the file first (as \`core.uploads.send\` does), then calls this operation with \`${member}\` set to the upload's ID. An upload's ID is still accepted.`;
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

/**
 * An example's output as the wire carries its body: the payload member's value itself (an operation whose output is a
 * thing sends the thing, `{"etag": …, "key": …}`, never `{"field": {…}}`), otherwise the body-bound members under
 * their JSON names. Header- and status-bound members are never in it.
 */
function wireBody(ast, op, output) {
  const mems = members(ast, op.shape.output.target);
  const body = {};
  for (const [name, v] of Object.entries(output)) {
    const b = mems[name] ? binding(mems[name]) : { in: 'body' };
    if (b.in === 'payload') return v;
    if (b.in === 'body') body[b.name ?? name] = v;
  }
  return body;
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
  let status = op.shape.traits?.[T('http')]?.code ?? 200;
  for (const [name, v] of Object.entries(out)) {
    const m = mems[name];
    const b = m ? binding(m) : { in: 'body' };
    if (b.in === 'header') headers.push(`${b.name}: ${v}`);
    else if (b.in === 'status') status = v;
  }
  const body = wireBody(ast, op, out);
  if (eventsUnion(ast, op)) return `HTTP/1.1 200\nContent-Type: text/event-stream\n${headers.join('\n')}`.trim();
  return `HTTP/1.1 ${status}\n${headers.length ? `${headers.join('\n')}\n` : ''}Content-Type: application/json\n\n${JSON.stringify(body, null, 2)}`;
}

function operationPage(ast, op, typePages, examples, opsUsingError) {
  const t = op.shape.traits ?? {};
  // An operation no release serves yet (scripts/docs-model.mjs: the pre-release case) says so, with the release it
  // arrives in; every other operation shows the release it arrived in
  const released = !opsUsingError.unreleased.has(op.name);
  const resourceName = op.resource ? local(op.resource).replace(/Resource$/, '') : null;
  const resources = [...new Set([resourceName && kebab(resourceName), op.namespace && kebab(singular(op.namespace.split('.').pop()))].filter(Boolean))].filter((k) => OPTIONS.resources.includes(k));
  const metadata = { pageType: 'reference', sinceVersion: sinceVersion(op.since), resources, integrations: [], operations: [op.name] };
  const out = [];
  // The site's page swaps some Markdown blocks for richer ones (memberTree); the Markdown copy keeps them as written
  const siteParts = new Map();
  out.push(op.doc, '');
  if (!released) out.push(notYetNote(opsUsingError.next), '');
  const calls = sdkCalls(ast, op);
  out.push('| | |', '| --- | --- |');
  out.push(`| HTTP | \`${op.http.method} /api${op.http.uri}\` |`);
  for (const [lang, call] of Object.entries(calls)) out.push(`| ${lang} | \`${call}\` |`);
  // An operation no workspace serves cannot be generally available, whatever the model says.
  const stability = released && STABILITY[op.stability] ? op.stability : 'beta';
  // An operation no release serves yet says so here too, with the release it arrives in
  const meaning = `${STABILITY[stability].text}${released ? '' : `. ${notYetWords(opsUsingError.next)}`}`;
  const stabilityRow = `| Stability | ${STABILITY[stability].badge}: ${meaning} |`;
  out.push(stabilityRow);
  // The site's row shows the level as its badge, its meaning beside it
  siteParts.set(stabilityRow, `| Stability | ${stabilityBadge(stability)} ${meaning} |`);
  if (released) out.push(`| Since | Caitlyn ${op.since} |`);
  out.push(`| Retried by the SDKs | ${retrySafe(op, ast) ? 'Yes, on 429, 503 and connection failures ([Retries](/retries/))' : 'No: it is not safe to repeat ([Retries](/retries/))'} |`);
  if (t[C('audit')]) out.push(`| Audited | As a write: ${cell(t[C('audit')].reason ?? '')} The call is refused with 503 when its audit event cannot be recorded. |`);
  out.push('');
  const helper = helpers(ast, op);
  if (helper) out.push(helper, '');

  // Request
  const inMembers = members(ast, op.shape.input.target);
  const requestAt = out.length;
  out.push('## Request', '');
  out.push(`Member names are shown as they are in TypeScript and on the wire. Python and Rust use snake case (\`${names.python('knowledgeBaseId')}\`) and Go uses exported names (\`${names.go('knowledgeBaseId')}\`).`);
  const notes = [];
  if (op.positional) notes.push(`\`${op.positional}\` is the method's first argument rather than an input field.`);
  for (const [name, m] of Object.entries(inMembers)) {
    const opt = callOption(name, m);
    if (opt === 'ifMatch') notes.push(`\`${name}\` is a call option (TypeScript \`{ ifMatch }\`, Go \`caitlyn.WithIfMatch\`, Rust \`.if_match(…)\`; Python takes \`if_match=\`). \`*\` (any version) is accepted, and sent only when you pass it yourself: no helper fills it in.`);
    if (opt === 'idempotencyKey') notes.push(`\`${name}\` is optional: the SDKs generate one per call and reuse it on every retry. Pass your own as a call option (TypeScript \`{ idempotencyKey }\`, Python \`idempotency_key=\`, Go \`caitlyn.WithIdempotencyKey\`, Rust \`.idempotency_key(…)\`) to make a retry of your own safe.`);
  }
  if (notes.length) out.push(' ' + notes.join(' '));
  out.push('');
  const reqTable = memberTable(ast, inMembers, typePages, { showWhere: true });
  out.push(reqTable || 'No members.', '');
  if (reqTable) siteParts.set(reqTable, memberTree(ast, inMembers, typePages, { grouped: true }));
  const filterable = t[C('filterable')];
  const sortable = t[C('sortable')];
  if (filterable) {
    out.push('Filters combine with AND. A filter or operator not listed here is refused with 400 [`UNKNOWN_FILTER`](/errors/UNKNOWN_FILTER/).', '');
  }
  if (sortable) out.push(`Sortable by ${sortable.fields.map((f) => `\`${f}\``).join(', ')}${sortable.default ? `; the default order is \`${sortable.default}\`` : ''}. Any other field is refused with 400 [\`UNKNOWN_SORT\`](/errors/UNKNOWN_SORT/).`, '');
  if (t[T('paginated')]) out.push('The SDKs page through the list for you: iterate the result and each page is fetched as it is needed ([Pagination](/pagination/)).', '');

  // Response
  const ev = eventsUnion(ast, op);
  const responseAt = out.length;
  let siteResponse = '';
  out.push('## Response', '');
  // An operation whose output is a thing (its @httpPayload member, under one type per thing) returns that thing
  const payload = Object.values(members(ast, op.shape.output.target)).find((m) => m.traits?.[T('httpPayload')] !== undefined);
  // and a list returns those things, a page at a time
  const listOf = t[T('paginated')] && ast.shapes[members(ast, op.shape.output.target).items?.target]?.member?.target;
  const returnsLine = payload && typePages.has(payload.target)
    ? `Returns: [${local(payload.target)}](/${typeSlug(payload.target)}/), with its \`etag\` and the response metadata on it.`
    : listOf && typePages.has(listOf)
      ? `Returns: [${local(listOf)}](/${typeSlug(listOf)}/) items, a page at a time.`
      : null;
  if (returnsLine) out.push(returnsLine, '');
  if (ev) {
    out.push(`A \`text/event-stream\` of [ConversationEvent](/${typeSlug(ev.id)}/) events. The stream ends after \`${ev.shape.members[ev.final]?.traits?.[T('jsonName')] ?? ev.final}\`, which the SDKs' \`finalMessage()\` (Python \`final_message()\`, Go \`FinalMessage()\`, Rust \`final_message()\`) returns; a failure ends it with \`message.failed\`, which the SDKs raise as the typed error. ${ev.resumeWith ? `A dropped connection is resumed with [${local(ev.resumeWith)}](/reference/${kebab(local(ev.resumeWith))}/) and \`Last-Event-ID\`, so no event is lost or repeated.` : ''} See [Streaming](/streaming/).`, '');
    const rows = Object.entries(ev.shape.members).map(([, m]) => `| \`${m.traits?.[T('jsonName')]}\` | [${local(m.target)}](/${typeSlug(m.target)}/) | ${cell(m.traits?.[T('documentation')])} |`);
    const eventTable = ['| Event | Data | Description |', '| --- | --- | --- |', ...rows].join('\n');
    out.push(eventTable, '');
    // On the site each event is a row that opens to show its data's members
    const outMembers = Object.fromEntries(Object.entries(members(ast, op.shape.output.target)).filter(([, m]) => binding(m).in === 'header'));
    if (Object.keys(outMembers).length) out.push('Response headers:', '', memberTable(ast, outMembers, typePages, { showWhere: true }), '');
    // The site: one status row, open, with the stream's events (each opening to its data) and the headers
    siteResponse = statusRow(200, 'Event stream', [
      out[responseAt + 2],
      '',
      `<p class="caitlyn-param-group"><span class="caitlyn-icon" data-icon="events" aria-hidden="true"></span>Events</p>`,
      '',
      memberTree(ast, Object.fromEntries(Object.values(ev.shape.members).map((m) => [m.traits?.[T('jsonName')], m])), typePages, { wireNames: true }),
      Object.keys(outMembers).length ? memberTree(ast, outMembers, typePages, { grouped: true }) : '',
    ], { open: true });
  } else {
    const status = t[T('http')]?.code ?? 200;
    out.push(`Status ${status}.${t[T('paginated')] ? ' One page of results; the SDKs return the items across every page.' : ''}`, '');
    const resTable = memberTable(ast, members(ast, op.shape.output.target), typePages, { showWhere: true });
    out.push(resTable, '');
    out.push('Every result also keeps the JSON it was read from, unknown fields included, as `raw`, and the response metadata (HTTP status, request ID, ETag).', '');
    // The site: one status row, open, with the result's fields grouped (headers, then the response fields)
    siteResponse = statusRow(status, STATUS_TEXT[status] ?? '', [
      ...(t[T('paginated')] ? ['One page of results; the SDKs return the items across every page.', ''] : []),
      memberTree(ast, members(ast, op.shape.output.target), typePages, { grouped: true, bodyLabel: 'Response fields' }),
      'Every result also keeps the JSON it was read from, unknown fields included, as `raw`, and the response metadata (HTTP status, request ID, ETag).',
      '',
    ], { open: true });
  }

  // Permissions
  const perm = permissionText(op);
  if (perm) out.push('## Permissions', '', perm, '');

  // Errors
  const errorsAt = out.length;
  out.push('## Errors', '');
  out.push('The SDKs raise the error class for the response\'s HTTP status, whether or not the operation lists it ([Errors](/errors/)). The statuses this operation returns:', '');
  out.push('| Status | Error | Codes | When |', '| --- | --- | --- | --- |');
  const siteErrors = [];
  for (const e of opsUsingError.errorsOf(op)) {
    out.push(`| ${e.status} | \`${e.name}\` | ${e.codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(', ')} | ${cell(e.doc)}${e.retryable ? ' Retried by the SDKs.' : ''} |`);
    // The site: a status row per error class, opening to its codes (each linking to its page) and when it happens
    siteErrors.push(statusRow(e.status, `\`${e.name}\``, [
      `<span class="caitlyn-param-values">${e.codes.map((c) => `[\`${c}\`](/errors/${c}/)`).join(' ')}</span>`,
      '',
      `<span class="caitlyn-param-doc">${oneLine(e.doc ?? '')}${e.retryable ? ' Retried by the SDKs.' : ''}</span>`,
      '',
    ]));
  }
  out.push('');
  const errorsEnd = out.length;

  // Examples
  let examplesAt = -1;
  const exs = examples.filter((s) => s.op.id === op.id);
  if (exs.length) {
    examplesAt = out.length;
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
  const body = out.join('\n');
  // The site's page (docs/site/src/components/OperationHeader.astro) shows the HTTP call and each SDK's call in a strip
  // under the title, so its body leaves those rows out of the summary table; the Markdown copy keeps them.
  const stripRows = new Set([`| HTTP | \`${op.http.method} /api${op.http.uri}\` |`, ...Object.entries(calls).map(([lang, call]) => `| ${lang} | \`${call}\` |`)]);
  // The site's page shows each example's code and exchange in its code panel (src/components/OperationPanel.astro), so its
  // Examples section keeps each example's heading and words (their anchors stay) and leaves the code out. A slot after
  // the opening is where the panel sits when the page is one column.
  const permissionsAt = out.indexOf('## Permissions', responseAt);
  const siteLines = [
    ...out.slice(0, requestAt),
    '<div class="caitlyn-panel-slot" data-operation-panel-slot></div>',
    '',
    ...out.slice(requestAt, responseAt),
    '## Response',
    '',
    ...(returnsLine ? [returnsLine, ''] : []),
    `<div class="caitlyn-statuses">\n\n${siteResponse}\n</div>`,
    '',
    ...out.slice(permissionsAt < 0 ? errorsAt : permissionsAt, errorsAt),
    ...out.slice(errorsAt, errorsAt + 3),
    `<div class="caitlyn-statuses">\n\n${siteErrors.join('\n')}\n</div>`,
    '',
    ...out.slice(errorsEnd, examplesAt < 0 ? out.length : examplesAt),
  ];
  if (examplesAt >= 0) {
    // Each example's title is a link to its own heading, which shows that example in the code panel
    // (src/scripts/operation-panel.ts marks the one shown); its heading and anchor stay as the Markdown copy has them.
    siteLines.push('## Examples', '', 'Each example\'s code, request and response are in the code panel, in the site\'s code language. Choose an example to show it there.', '', '<div class="caitlyn-example-list">', '');
    for (const ex of exs) {
      siteLines.push(`### [${ex.example.title}](#${headingId(ex.example.title)})`, '');
      if (ex.example.documentation) siteLines.push(ex.example.documentation, '');
    }
    siteLines.push('</div>', '');
  }
  const siteBody = siteLines.filter((line) => !stripRows.has(line)).map((line) => siteParts.get(line) ?? line).join('\n');
  const events = eventsUnion(ast, op);
  const panel = exs.map((ex) => ({
    title: ex.example.title,
    code: Object.fromEntries(Object.entries(ex.code).map(([k, v]) => [k, v.trimEnd()])),
    // What the SDK hands back: the result's JSON (the response body), or the error's problem details
    ...responseBody(ast, op, ex.example),
    // A stream's examples in the model carry no event bodies, so the sequence is built from the event types and
    // labelled as a sample
    events: events && !ex.example.error ? sampleEvents(ast, events) : null,
  }));
  // Every status the operation documents, each with a body to show in the panel's response pane: an example's own when
  // the model has one with that status, otherwise the problem details every error carries, with the status's first code
  // (marked as an illustration)
  const success = t[T('http')]?.code ?? 200;
  const errorClasses = opsUsingError.errorsOf(op);
  const statuses = [...new Set([success, ...errorClasses.map((e) => e.status)])].sort((a, b) => a - b);
  const responses = statuses.map((status) => {
    const own = panel.find((p) => p.status === status);
    if (own) return { status, result: own.result, events: own.events, sample: false };
    const err = errorClasses.find((e) => e.status === status);
    const code = err?.codes[0];
    if (!code) return { status, result: null, events: null, sample: true };
    return { status, result: JSON.stringify(problemDetails(code, status), null, 2), events: null, sample: true, code };
  });
  const operation = {
    name: op.name,
    stability,
    responses,
    method: opsUsingError.tree.callOf.get(op.name),
    calls: Object.fromEntries(Object.entries(calls).map(([lang, call]) => [lang.toLowerCase(), call])),
    http: { method: op.http.method, path: `/api${op.http.uri}` },
    panel,
  };
  // Titled by the job (@title), with the operation's name under it; in the sidebars' group (scripts/docs-api.mjs)
  return { slug: `reference/${kebab(op.name)}`, title: operationTitle(op), subtitle: op.name, metadata, body, siteBody, operation, group: opsUsingError.tree.groupOf.get(op.name), label: operationTitle(op) };
}

function typePage(ast, id, typePages, usedBy) {
  const S = ast.shapes;
  const s = S[id];
  const name = local(id);
  const out = [];
  const doc = s.traits?.[T('documentation')];
  if (doc) out.push(doc.trim(), '');
  const ops = usedBy.get(id) ?? [];
  // The site's page shows the members, values or events as the operation pages' stacked rows; the Markdown copy keeps
  // the tables
  const site = [...out];
  if (s.type === 'enum') {
    const open = /Open: new values may be added/.test(doc ?? '');
    const lead = `A string. ${open ? '' : ''}The SDKs keep a value they do not know yet as the string itself (Python: an unknown member carrying it), so a newer server never breaks an older SDK.`;
    out.push(lead, '');
    out.push('| Value | Description |', '| --- | --- |');
    for (const [, m] of Object.entries(s.members)) out.push(`| \`${m.traits?.[T('enumValue')]}\` | ${cell(m.traits?.[T('documentation')])} |`);
    out.push('');
    site.push(lead, '', groupLabel('values', 'Values'), '', '<div class="caitlyn-params">', '');
    for (const [, m] of Object.entries(s.members)) {
      const d = oneLine(m.traits?.[T('documentation')] ?? '');
      site.push('<div class="caitlyn-param">', '', `<span class="caitlyn-param-name">\`${m.traits?.[T('enumValue')]}\`</span>`, '', ...(d ? [`<span class="caitlyn-param-doc">${d}</span>`, ''] : []), '</div>', '');
    }
    site.push('</div>', '');
  } else if (s.type === 'union') {
    const lead = 'Exactly one of these, named by the SSE `event:` line. The SDKs skip an event name they do not know.';
    out.push(lead, '');
    out.push('| Event | Data | Visibility | Description |', '| --- | --- | --- | --- |');
    for (const [, m] of Object.entries(s.members)) out.push(`| \`${m.traits?.[T('jsonName')]}\` | [${local(m.target)}](/${typeSlug(m.target)}/) | ${m.traits?.[C('eventClass')] ?? 'public'} | ${cell(m.traits?.[T('documentation')])} |`);
    out.push('');
    site.push(lead, '', groupLabel('events', 'Events'), '', memberTree(ast, Object.fromEntries(Object.values(s.members).map((m) => [m.traits?.[T('jsonName')], m])), typePages, { wireNames: true, extraMeta: (m) => [`${m.traits?.[C('eventClass')] ?? 'public'} event`] }));
  } else {
    const table = memberTable(ast, members(ast, id), typePages, { wireNames: true });
    out.push(table || 'No members.', '');
    out.push('Unknown members a newer server sends are kept in the object\'s `raw`.', '');
    site.push(...(table ? [groupLabel('body', 'Members'), '', memberTree(ast, members(ast, id), typePages, { wireNames: true })] : ['No members.']), '');
    site.push('Unknown members a newer server sends are kept in the object\'s `raw`.', '');
  }
  if (ops.length) {
    const line = `Used by ${ops.map((o) => `[${o.name}](/reference/${kebab(o.name)}/)`).join(', ')}.`;
    out.push(line, '');
    site.push(line, '');
  }
  const resources = [...new Set(ops.flatMap((o) => [o.resource && kebab(local(o.resource).replace(/Resource$/, '')), o.namespace && kebab(singular(o.namespace.split('.').pop()))]).filter(Boolean))].filter((k) => OPTIONS.resources.includes(k));
  const since = ops.map((o) => sinceVersion(o.since)).sort((a, b) => a - b)[0] ?? 0;
  return {
    slug: typeSlug(id),
    title: name,
    metadata: { pageType: 'reference', sinceVersion: since, resources, integrations: [], operations: ops.map((o) => o.name) },
    body: out.join('\n'),
    siteBody: site.join('\n'),
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
  // Each code the model lists has a constant in every SDK (scripts/check-error-codes.mjs); the plain string compares the same.
  const pascal = code.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  out.push('## Check for it', '');
  out.push(`Each SDK has a constant for this code. It is the code itself, so comparing with \`"${code}"\` works the same.`, '');
  out.push('```ts tab="TypeScript"', `import { CaitlynError, ErrorCode } from '@caitlyn-ai/sdk';`, '', `if (err instanceof CaitlynError && err.code === ErrorCode.${code}) {`, '  // …', '}', '```');
  out.push('```python tab="Python"', 'from caitlyn import CaitlynError, ErrorCode', '', 'try:', '    ...', 'except CaitlynError as err:', `    if err.code == ErrorCode.${code}:`, '        ...', '```');
  out.push('```go tab="Go"', 'var apiErr *caitlyn.Error', `if errors.As(err, &apiErr) && apiErr.Code == caitlyn.ErrorCode${pascal} {`, '\t// …', '}', '```');
  out.push('```rust tab="Rust"', 'use caitlyn_sdk::ErrorCode;', '', `if err.code() == Some(ErrorCode::${code}) {`, '    // …', '}', '```', '');
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

/**
 * Every generated page: { slug, title, metadata, body, group, label }. `unreleased` (the operations no release serves
 * yet) and `next` (the release they arrive in) default to the snapshot's and the lock's; a test passes its own.
 */
export function referencePages(ast, { unreleased = unreleasedOperations(), next = nextRelease() } = {}) {
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
  const helpers = loadHelpers();
  const tree = namespaceTree(ops, { ast, helpers });
  const pages = [];
  for (const op of ops) pages.push(operationPage(ast, op, typePages, examples, { errorsOf, tree, unreleased, next }));
  for (const h of helpers) pages.push(helperPage(h, ops, tree));
  for (const id of types) pages.push(typePage(ast, id, typePages, usedBy));
  for (const err of errors) {
    for (const code of err.codes) {
      const listing = ops.filter((o) => (o.shape.errors ?? []).some((e) => e.target === err.id));
      pages.push(errorPage(ast, code, err, listing));
    }
  }
  for (const [code, text] of Object.entries(ROUTING_CODES)) {
    if (errors.some((e) => e.codes.includes(code))) throw new Error(`docs-reference: ${code} is a model code; take it out of ROUTING_CODES`);
    pages.push(routingErrorPage(ast, code, text));
  }
  return { pages, ops, examples, typePages, tree, helpers, unreleased, next };
}

/** A page for a code the server's routing sends (docs/error-codes.mjs ROUTING_CODES): no operation declares it. */
function routingErrorPage(ast, code, text) {
  const out = [];
  out.push(text.meaning.trim(), '');
  out.push('| | |', '| --- | --- |');
  out.push(`| HTTP status | ${text.status} |`);
  out.push('| Raised by the SDKs as | `NotSupportedByServer` in TypeScript and Python, `*caitlyn.NotSupportedByServerError` in Go, `Error::NotSupportedByServer` in Rust |');
  out.push('| Retried by the SDKs | No |');
  out.push('');
  out.push('## What to do', '', text.action.trim(), '');
  out.push('## The error body', '');
  out.push(`An RFC 9457 problem details object with \`code\` set to \`${code}\` and \`type\` set to this page's address, from the server's routing rather than an operation, so no operation lists it. \`requestId\` identifies the request; quote it to Caitlyn support. [Errors](/errors/) lists every field.`, '');
  return {
    slug: `errors/${code}`,
    title: code,
    metadata: { pageType: 'error', sinceVersion: Math.min(...operations(ast).map((o) => sinceVersion(o.since))), resources: [], integrations: [], operations: [] },
    body: out.join('\n'),
    group: 'errors',
    label: code,
  };
}

// ------------------------------------------------------------------------------------------------ the helpers

/** The SDK helpers the reference has a page for (docs/helpers.json): written in each SDK's runtime core, not generated
 * from an operation */
export function loadHelpers() {
  return JSON.parse(fs.readFileSync(path.join(root, 'docs/helpers.json'), 'utf8')).helpers;
}

/** The lines of an example's region (`// #region name` to `// #endregion`, `#` in Python), less their shared indent,
 * as scripts/docs-guides.mjs reads them */
function exampleRegion(ref) {
  const [file, name] = ref.split('#');
  const lines = fs.readFileSync(path.join(root, file), 'utf8').split('\n');
  const marker = (l, text) => ['//', '#'].some((c) => l.trim() === `${c} ${text}`);
  const start = lines.findIndex((l) => marker(l, `#region ${name}`));
  const end = lines.findIndex((l, i) => i > start && marker(l, '#endregion'));
  if (start < 0 || end < 0) throw new Error(`docs/helpers.json: ${ref} is no example region`);
  const body = lines.slice(start + 1, end);
  const shared = Math.min(...body.filter((l) => l.trim()).map((l) => /^[\t ]*/.exec(l)[0].length));
  return body.map((l) => l.slice(shared)).join('\n');
}

export const helperSlug = (h) => `reference/helpers/${kebab(h.id.replace(/\./g, '-'))}`;

/** A helper's page: what it does, its call in each SDK, its options, the operations it makes and an example in each
 * language, from the tested examples */
/**
 * A scope method's call in each language, through the scope tree (docs-scopes.mjs placement), as sdkCalls spells an
 * operation's: `kb.ingestion.batches(ingestionBatchId).watch()`. `call` is { operation (one the scope's watch or
 * method reaches), input (the identifiers, each named by the variable it shows), method (watch or wait) }.
 */
export function scopeCalls({ operation, input, method }) {
  const p = placement(operation, Object.fromEntries(Object.entries(input).map(([k, v]) => [k, `@@${v}@@`])));
  const unwrap = (code, spell) => String(code).replace(/"?@@([A-Za-z]+)@@"?/g, (_, n) => spell(n));
  const rustWord = (n) => n.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
  const tsPath = p.steps.map((s) => `${s.name}${s.args ? `(${s.args.map((a) => unwrap(a, (n) => n)).join(', ')})` : ''}`).join('.');
  const pyPath = p.steps.map((s) => `${names.python(s.name)}${s.args ? `(${s.args.map((a) => unwrap(a, (n) => names.python(n))).join(', ')})` : ''}`).join('.');
  const rsPath = p.steps.map((s) => (s.args ? `${rustWord(s.singular)}(${s.args.map((a) => unwrap(a, (n) => names.rust(n))).join(', ')})` : `${rustWord(s.name)}()`)).join('.');
  return {
    typescript: `caitlyn.${tsPath}.${method}()`,
    python: `caitlyn.${pyPath}.${names.python(method)}()`,
    go: `client${unwrap(goChain(p.steps), (n) => names.goParam(n))}.${names.go(method)}(ctx)`,
    rust: `client.${rsPath}.${rustWord(method)}()`,
  };
}

function helperPage(h, ops, tree) {
  const byName = new Map(ops.map((o) => [o.name, o]));
  for (const name of h.calls) if (!byName.has(name)) throw new Error(`docs/helpers.json: ${h.id} calls ${name}, which is no public operation`);
  const out = [...h.description.flatMap((p) => [p, ''])];
  out.push('| | |', '| --- | --- |');
  // A scope's watch() and wait() are spelled from the scope tree; the other helpers' calls are their runtime cores'
  const spellings = h.call ? scopeCalls(h.call) : h.spellings;
  for (const l of LANGUAGES) out.push(`| ${l.label} | \`${spellings[l.key].replace(/\|/g, '\\|')}\` |`);
  out.push('');
  if (h.options?.length) {
    out.push('## Options', '');
    // Options spelled in each language (a wait's) are a row per option with each language's spelling; the others are
    // named as in TypeScript
    if (h.options[0].spellings) {
      // What each option does, then how each language spells them: a row per language
      for (const o of h.options) out.push(`- **${o.option}.** ${o.doc}`);
      out.push('', `| Language | ${h.options.map((o) => o.option).join(' | ')} |`, `| --- | ${h.options.map(() => '---').join(' | ')} |`);
      for (const l of LANGUAGES) out.push(`| ${l.label} | ${h.options.map((o) => `\`${o.spellings[l.key].replace(/\|/g, '\\|')}\``).join(' | ')} |`);
    } else {
      out.push('Named as in TypeScript; each SDK spells them its own way (Python `remove_missing`, Go `RemoveMissing`, Rust `.remove_missing(…)`).', '');
      out.push('| Option | What it does |', '| --- | --- |');
      for (const [name, doc] of h.options) out.push(`| ${name.split(', ').map((n) => `\`${n}\``).join(', ')} | ${cell(doc)} |`);
    }
    out.push('');
  }
  for (const section of h.sections ?? []) out.push(`## ${section.heading}`, '', ...section.body.flatMap((p) => [p, '']));
  if (h.example) {
    out.push('## Example', '');
    for (const l of LANGUAGES) out.push(`\`\`\`${l.fence} tab="${l.label}"`, exampleRegion(h.example[l.key]).trimEnd(), '```');
    out.push('');
  }
  out.push('## The operations it makes', '', h.calls.map((n) => `[${operationTitle(byName.get(n))}](/reference/${kebab(n)}/) (${n})`).join(', ') + '.', '');
  const since = Math.min(...h.calls.map((n) => sinceVersion(byName.get(n).since)));
  return {
    slug: helperSlug(h),
    title: h.title,
    subtitle: h.call ? scopeCalls(h.call).typescript.replace(/^caitlyn\.knowledgeBases\(knowledgeBaseId\)/, 'kb') : h.name,
    calls: h.call ? scopeCalls(h.call) : h.spellings,
    metadata: { pageType: 'sdk', sinceVersion: since, resources: h.resources, integrations: [], operations: h.calls },
    body: out.join('\n'),
    group: tree.groupOf.get(h.id),
    label: h.title,
    helper: h.id,
  };
}

/**
 * The SDK reference's overview at /sdk/: installing each SDK and creating a client (both from Getting started, as its
 * readers already know them), the server and workspace (the page's Server block), the sign-in modes (Authentication's
 * table), every group of the client with its operations and helpers by their call, the waiters, and how errors and retries behave. The site's
 * page lists the operations as rows; the Markdown copy as a list. `pages` are the SDK reference's operation pages.
 * ctx: { install, firstCall, modes } (Markdown taken from the hand-written pages), tree (scripts/docs-api.mjs
 * namespaceTree: the groups as the sidebars nest them)
 */
export function sdkOverview(ast, ops, pages, { install, firstCall, modes, tree }) {
  const head = [
    'The SDKs for TypeScript, Python, Go and Rust call the Caitlyn v3 API for you: they sign in, retry what is safe to repeat, page through lists, follow streams and raise a typed error for each failure. Each operation is a method on a client, grouped by what it acts on.',
    '',
    '## Install',
    '',
    install.trim(),
    '',
    '## Create a client',
    '',
    'A client is for one workspace and one way of signing in. This program creates one and makes a first call; [Getting started](/getting-started/) walks through it.',
    '',
    firstCall.trim(),
    '',
    '## Server and workspace',
    '',
    "The client sends every request to its workspace's own hostname, `https://{workspace}/api`. Give your workspace in the Server block and every example on this site uses it. [The workspace](/getting-started/#the-workspace) explains what it decides.",
    '',
    '## Sign-in modes',
    '',
    'The `auth` option chooses how the client signs in; [Authentication](/authentication/) has each mode in full.',
    '',
    modes.trim(),
    '',
    '## Groups and operations',
    '',
  ];
  const md = [...head];
  const site = [...head];
  const W = 'smithy.waiters#waitable';
  const waiters = [];
  // Each group under a heading a level below its parent's, its operations and helpers as rows by their call
  const pageOf = (e) => (e.op ? pages.find((p) => p.operation?.name === e.op.name) : pages.find((p) => p.helper === e.helper.id));
  walkTree(tree, (n, depth) => {
    const level = '#'.repeat(Math.min(3 + depth, 6));
    md.push(`${level} ${n.label}`, '');
    site.push(`${level} ${n.label}`, '');
    if (!n.entries.length) return;
    site.push(`<div class="caitlyn-api-ops">`, '');
    for (const e of n.entries) {
      const page = pageOf(e);
      const call = e.op ? `${tree.callOf.get(e.op.name)}()` : e.helper.call ? page.calls.typescript : page.calls.typescript.replace(/\(.*$/s, '()');
      const summary = e.op ? firstSentence(e.op.doc ?? '') : e.helper.summary;
      md.push(`- [\`${call}\`](/${page.slug}/) (${page.title}): ${summary}`);
      site.push('<div class="caitlyn-api-op">', '', `[${page.title}](/${page.slug}/) <code class="caitlyn-api-op-path">${call}</code>`, '', `<span class="caitlyn-param-doc">${summary}</span>`, '', '</div>', '');
      if (e.op) for (const [wname, w] of Object.entries(e.op.shape.traits?.[W] ?? {})) waiters.push({ ns: e.op.namespace, op: e.op, page, name: wname, doc: oneLine(w.documentation ?? '') });
    }
    md.push('');
    site.push('</div>', '');
  });
  const tail = [];
  if (waiters.length) {
    tail.push('## Waiters', '', 'A waiter reads a resource until it reaches the state you are waiting for, backing off between reads, and returns it; it raises a `WaiterError` when the resource reaches a state it can never leave, or the wait runs out of time.', '');
    tail.push('| Waiter | Reads | Waits until |', '| --- | --- | --- |');
    for (const w of waiters) {
      const m = `waitUntil${w.name}`;
      tail.push(`| \`caitlyn.${namespacePath('typescript', w.ns)}.${m}\` (Python \`${namespacePath('python', w.ns)}.${names.python(m)}\`, Go \`${namespacePath('go', w.ns)}.${names.go(m)}\`, Rust \`${namespacePath('rust', w.ns)}.${names.rust(m)}\`) | [${w.op.name}](/${w.page.slug}/) | ${cell(w.doc)} |`);
    }
    tail.push('');
  }
  tail.push(
    '## Errors and retries',
    '',
    'A failed call raises the error class for its HTTP status, carrying the error\'s `code`, `detail` and `requestId` ([Errors](/errors/)); each code has its own page under Error codes. A call that is safe to repeat is retried on 429, 503 and connection failures, with backoff ([Retries](/retries/)). A stream resumes from the last event it received ([Streaming](/streaming/)), and a list is paged through for you ([Pagination](/pagination/)).',
    '',
  );
  return { body: [...md, ...tail].join('\n'), siteBody: [...site, ...tail].join('\n') };
}

export { plural };
