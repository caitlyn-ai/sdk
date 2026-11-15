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
import { T, allErrors, eventsUnion, kebab, local, namespacePath, unreleasedOperations } from './docs-model.mjs';
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

// A namespace's place in the sidebars, the overviews and the OpenAPI document's tags follows the client: a nested
// namespace (caitlyn.agents.versions) is a group inside its first segment's group (Agents, then Versions). A group is
// labelled by its own segment, in words where the SDK's name is not what a reader looks for. The SDK names in the
// pages stay as they are.
const SEGMENT_LABELS = { productionHistory: 'Production history' };
export const segmentLabel = (s) => SEGMENT_LABELS[s] ?? s.charAt(0).toUpperCase() + s.slice(1);
export const namespaceLabel = (ns) => segmentLabel(ns.split('.').pop());
// The order of the groups inside a parent group: versions before production history, then any other alphabetically
const NESTED_ORDER = ['versions', 'productionHistory'];
const nestedRank = (ns) => {
  const i = NESTED_ORDER.indexOf(ns.split('.').pop());
  return i < 0 ? NESTED_ORDER.length : i;
};

/** The namespaces as the sidebars nest them, in the model's order: { label, ns } for a namespace, { label, children }
 * for a parent whose namespaces are nested under it. */
export function namespaceTree(ops) {
  const tree = [];
  for (const ns of [...new Set(ops.map((o) => o.namespace))]) {
    if (!ns.includes('.')) {
      tree.push({ label: namespaceLabel(ns), ns });
      continue;
    }
    const parent = segmentLabel(ns.split('.')[0]);
    let node = tree.find((n) => n.children && n.label === parent);
    if (!node) tree.push((node = { label: parent, children: [] }));
    node.children.push({ label: namespaceLabel(ns), ns });
  }
  for (const node of tree) node.children?.sort((a, b) => nestedRank(a.ns) - nestedRank(b.ns) || a.label.localeCompare(b.label));
  return tree;
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
 * ctx: { ops (the model's operations), namespaceLabel, sdkSlug(op) (its SDK reference page), examples (each
 * operation's programs), base (the site's base path) }
 */
export function publishedOpenapi(raw, { ops, namespaceLabel, sdkSlug, examples, base = '/' }) {
  const doc = structuredClone(raw);
  const problems = [];
  const opByName = new Map(ops.map((o) => [o.name, o]));
  // Each namespace is a tag, and a nested one names its parent tag (OpenAPI 3.2's `parent`)
  doc.tags = namespaceTree(ops).flatMap((node) => (node.children ? [{ name: node.label }, ...node.children.map((c) => ({ name: c.label, parent: node.label }))] : [{ name: node.label }]));
  for (const { operation } of apiOperations(doc)) {
    const op = opByName.get(operation.operationId);
    if (!op) {
      problems.push(`${operation.operationId} is not an operation of the SDK reference`);
      continue;
    }
    operation.summary = op.name;
    operation.tags = [namespaceLabel(op.namespace)];
    const example = examples.find((e) => e.op.id === op.id);
    if (example) operation['x-codeSamples'] = LANGUAGES.map((l) => ({ lang: l.key, label: l.label, source: example.code[l.key].trimEnd() }));
    operation.description = [`Using an SDK? See [\`${namespacePath('typescript', op.namespace)}.${op.method}\`](${base}${sdkSlug(op)}/) in the SDK reference.`, operation.description].filter(Boolean).join('\n\n');
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
 * ctx: { ast, ops, sdkPages (by operation name), typePages (the type ids with a page), examples, namespaceLabel }
 */
export function apiPages(doc, { ast, ops, sdkPages, typePages, namespaceLabel }) {
  const A = adapter(doc, ast, typePages);
  const opByName = new Map(ops.map((o) => [o.name, o]));
  const errors = allErrors(ast);
  const unreleased = unreleasedOperations();
  const pages = [];
  const anchors = {};
  for (const { route, method, operation } of apiOperations(doc)) {
    const op = opByName.get(operation.operationId);
    const sdk = sdkPages.get(op.name);
    const slug = `api/${kebab(op.name)}`;
    const group = namespaceLabel(op.namespace);
    anchors[`tag/${tagSlug(group)}/${method}${route}`] = `/${slug}/`;
    // A nested namespace's operations were under their parent's tag before it was nested (Agents for the versions):
    // the live site's addresses for them go to the same page
    if (op.namespace.includes('.')) anchors[`tag/${tagSlug(segmentLabel(op.namespace.split('.')[0]))}/${method}${route}`] ??= `/${slug}/`;
    const live = !unreleased.has(op.name);
    const description = operation.description.replace(/^Using an SDK\?.*\n\n/, '');
    const sdkLink = `[\`${namespacePath('typescript', op.namespace)}.${op.method}\`](/${sdk.slug}/)`;
    const md = [];
    const site = [];
    const both = (...lines) => {
      md.push(...lines);
      site.push(...lines);
    };
    both(description, '');
    if (!live) both('> **Not available yet.** Caitlyn workspaces do not serve this operation yet, so a call gets 404. This page', '> describes how it works.', '');
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
      title: op.name,
      metadata: { ...sdk.metadata },
      body: md.join('\n'),
      siteBody: site.join('\n'),
      operation: {
        kind: 'api',
        name: op.name,
        method: `${op.namespace}.${op.method}`,
        calls: sdk.operation.calls,
        http: { method, path: `/api${route}` },
        panel,
        responses,
      },
      group: op.namespace,
      label: op.name,
      route,
      method,
      summary: firstSentence(description),
    });
  }
  // In the SDK reference's order, so the two sidebars list the operations alike
  const rank = (p) => ops.findIndex((o) => o.name === p.title);
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
  const group = (label, ns, level) => {
    const list = pages.filter((p) => p.group === ns);
    if (!list.length) return;
    md.push(`${level} ${label}`, '');
    site.push(`${level} ${label}`, '', '<div class="caitlyn-api-ops">', '');
    for (const p of list) {
      md.push(`- \`${p.method} ${p.route}\` [${p.title}](/${p.slug}/): ${p.summary}`);
      site.push('<div class="caitlyn-api-op">', '', `<span class="caitlyn-http-method" data-method="${p.method}">${p.method}</span> [${p.title}](/${p.slug}/) <code class="caitlyn-api-op-path">${p.route}</code>`, '', `<span class="caitlyn-param-doc">${p.summary}</span>`, '', '</div>', '');
    }
    md.push('');
    site.push('</div>', '');
  };
  for (const node of tree) {
    if (!node.children) {
      group(node.label, node.ns, '###');
      continue;
    }
    md.push(`### ${node.label}`, '');
    site.push(`### ${node.label}`, '');
    for (const child of node.children) group(child.label, child.ns, '####');
  }
  return { body: [...md, ...tail].join('\n'), siteBody: [...site, ...tail].join('\n') };
}
