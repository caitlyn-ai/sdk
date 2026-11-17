// Runnable code for the API reference: one complete program per @examples entry in the model, in TypeScript,
// Python, Go and Rust, written the way each generated SDK is called (scripts/docs-model.mjs has the naming).
// The reference pages show exactly these programs, and each language's CI job compiles them against its SDK,
// so a snippet that stops matching the SDK fails the pipeline:
//   node scripts/docs-snippets.mjs typescript   writes examples/typescript/reference/*.ts  (tsc, test-typescript.sh)
//   node scripts/docs-snippets.mjs python       writes examples/python/reference/*.py      (pyright, test-python.sh)
//   node scripts/docs-snippets.mjs go           writes examples/go/reference/<name>/main.go (go vet, test-go.sh)
//   node scripts/docs-snippets.mjs rust         writes examples/rust/examples/*.rs         (clippy, test-rust.sh)
// Those directories are generated and ignored by git. Reads build/model/model.json (scripts/prepare-model.mjs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { T, binding, callOption, eventsUnion, loadModel, local, names, namespacePath, operations, root, words } from './docs-model.mjs';
import { placement } from './docs-scopes.mjs';

export const LANGUAGES = [
  { key: 'typescript', label: 'TypeScript', fence: 'ts' },
  { key: 'python', label: 'Python', fence: 'python' },
  { key: 'go', label: 'Go', fence: 'go' },
  { key: 'rust', label: 'Rust', fence: 'rust' },
];

const WORKSPACE = 'your-company.getcaitlyn.ai';
/** A Python string literal: double quotes, or single quotes when the text has double quotes and no single ones. */
const pyStr = (v) => (v.includes('"') && !v.includes("'") ? `'${v.replace(/\\/g, '\\\\')}'` : JSON.stringify(v));
const snake = (s) => s.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '').toLowerCase();

/** The members of an operation's input, split by how each SDK takes them. */
function inputParts(ast, op, input) {
  const shape = ast.shapes[op.shape.input.target];
  const parts = { positional: null, fields: [], options: {}, unset: [] };
  for (const [name, member] of Object.entries(shape.members ?? {})) {
    const value = input[name];
    const option = callOption(name, member);
    if (name === op.positional) parts.positional = { name, member, value };
    else if (option) {
      if (value !== undefined) parts.options[option] = value;
    } else if (value !== undefined) parts.fields.push({ name, member, value });
    else parts.unset.push({ name, member });
  }
  return parts;
}

const required = (member) => !!member.traits?.[T('required')];

// ------------------------------------------------------------------------------------------- values per language

/** A literal for one value of a member's target, in one language. */
/** The model types a Python program names (structures and enums inside them), imported from caitlyn. */
const pyImports = new Set();
// The Rust types a program's literals name (nested structures and enums), for its `use` line.
const rustImports = new Set();

/** A JSON value as a Python literal. */
const pyJson = (v) =>
  v === null ? 'None' : v === true ? 'True' : v === false ? 'False' : Array.isArray(v) ? `[${v.map(pyJson).join(', ')}]`
    : typeof v === 'object' ? `{${Object.entries(v).map(([k, x]) => `${pyStr(k)}: ${pyJson(x)}`).join(', ')}}` : typeof v === 'string' ? pyStr(v) : String(v);

function literal(ast, lang, target, value, { optional = false, nested = false } = {}) {
  const S = ast.shapes;
  const shape = S[target] ?? { type: target.split('#')[1].toLowerCase() };
  const type = shape.type;
  const str = (s) => JSON.stringify(s);
  if (type === 'enum') {
    const [member] = Object.entries(shape.members).find(([, m]) => m.traits?.[T('enumValue')] === value) ?? [];
    const typeName = local(target);
    if (lang === 'go') {
      const v = member ? `caitlyn.${typeName}${names.go(member)}` : `caitlyn.${typeName}(${str(value)})`;
      return optional ? `caitlyn.Ptr(${v})` : v;
    }
    if (lang === 'rust') {
      rustImports.add(typeName);
      const v = member ? `${typeName}::${names.rustPascal(member)}` : `${typeName}::Unknown(${str(value)}.into())`;
      return optional ? `Some(${v})` : v;
    }
    if (lang === 'python' && nested) {
      // A model's enum member is typed as its enum class; a call's own parameter also takes the string.
      pyImports.add(typeName);
      return `${typeName}(${pyStr(value)})`;
    }
    return lang === 'python' ? pyStr(value) : `'${value}'`;
  }
  if (type === 'string' || type === 'timestamp') {
    if (lang === 'go') return optional ? `caitlyn.Ptr(${str(value)})` : str(value);
    if (lang === 'rust') return optional ? `Some(${str(value)}.into())` : `${str(value)}.into()`;
    if (lang === 'python') return pyStr(value);
    return `'${String(value).replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  }
  if (['integer', 'long', 'short', 'byte', 'float', 'double', 'bigInteger', 'bigDecimal'].includes(type)) {
    const goType = { integer: 'int32', long: 'int64', short: 'int16', byte: 'int8', float: 'float32', double: 'float64' }[type];
    if (lang === 'go') return optional ? `caitlyn.Ptr[${goType}](${value})` : String(value);
    if (lang === 'rust') return optional ? `Some(${value})` : String(value);
    return String(value);
  }
  if (type === 'boolean') {
    if (lang === 'python') return value ? 'True' : 'False';
    if (lang === 'go') return optional ? `caitlyn.Ptr(${value})` : String(value);
    if (lang === 'rust') return optional ? `Some(${value})` : String(value);
    return String(value);
  }
  if (type === 'list') {
    const items = value.map((v) => literal(ast, lang, shape.member.target, v, { nested }));
    if (lang === 'go') {
      const el = S[shape.member.target];
      const elType = el && ['structure', 'enum'].includes(el.type) ? `caitlyn.${local(shape.member.target)}` : goScalar(el, shape.member.target);
      return `[]${elType}{${items.map((i) => i.replace(/^&?caitlyn\.[A-Za-z]+\{/, '{')).join(', ')}}`;
    }
    if (lang === 'rust') return optional ? `Some(vec![${items.join(', ')}])` : `vec![${items.join(', ')}]`;
    return `[${items.join(', ')}]`;
  }
  if (type === 'structure') {
    const name = local(target);
    const entries = Object.entries(value).map(([k, v]) => [k, shape.members[k], v]);
    if (lang === 'typescript') return `{ ${entries.map(([k, m, v]) => `${k}: ${literal(ast, lang, m.target, v)}`).join(', ')} }`;
    if (lang === 'python') {
      pyImports.add(name);
      return `${name}(${entries.map(([k, m, v]) => `${names.python(k)}=${literal(ast, lang, m.target, v, { nested: true })}`).join(', ')})`;
    }
    // An optional structure member is a pointer in Go (a list's items drop the & again, above).
    if (lang === 'go') return `${optional ? '&' : ''}caitlyn.${name}{${entries.map(([k, m, v]) => `${names.go(k)}: ${literal(ast, lang, m.target, v, { optional: !required(m) })}`).join(', ')}}`;
    rustImports.add(name);
    const v = `${name} { ${entries.map(([k, m, v]) => `${names.rust(k)}: ${literal(ast, lang, m.target, v, { optional: !required(m) })}`).join(', ')}, ..Default::default() }`;
    return optional ? `Some(${v})` : v;
  }
  if (type === 'map') {
    const entries = Object.entries(value).map(([k, v]) => [k, literal(ast, lang, shape.value.target, v, { nested })]);
    if (lang === 'python') return `{${entries.map(([k, v]) => `${pyStr(k)}: ${v}`).join(', ')}}`;
    if (lang === 'typescript') return `{ ${entries.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')} }`;
    if (lang === 'go') {
      const el = S[shape.value.target];
      const elType = el && ['structure', 'enum'].includes(el.type) ? `caitlyn.${local(shape.value.target)}` : goScalar(el, shape.value.target);
      // An enum key is the enum's own type (map[caitlyn.IngestionItemOutcome]int64).
      const key = S[shape.key.target];
      const keyType = key?.type === 'enum' ? `caitlyn.${local(shape.key.target)}` : 'string';
      return `map[${keyType}]${elType}{${entries.map(([k, v]) => `${JSON.stringify(k)}: ${v}`).join(', ')}}`;
    }
    // The Rust SDK's maps are BTreeMap (deterministic order).
    const v = `std::collections::BTreeMap::from([${entries.map(([k, x]) => `(${JSON.stringify(k)}.into(), ${x})`).join(', ')}])`;
    return optional ? `Some(${v})` : v;
  }
  if (type === 'document') {
    if (lang === 'python') return pyJson(value);
    if (lang === 'rust') return `serde_json::json!(${JSON.stringify(value)})`;
    return JSON.stringify(value);
  }
  throw new Error(`docs-snippets: no ${lang} literal for ${target} (${type})`);
}

function goScalar(shape, target) {
  const type = shape?.type ?? target.split('#')[1].toLowerCase();
  return { string: 'string', integer: 'int32', long: 'int64', boolean: 'bool', float: 'float32', double: 'float64' }[type] ?? 'any';
}

// ------------------------------------------------------------------------------------------------ the programs

/** What a program does with the result, by the operation's kind. */
function kind(ast, op) {
  if (eventsUnion(ast, op)) return 'stream';
  if (op.shape.traits?.[T('paginated')]) return 'list';
  return 'call';
}

function hasTextDelta(ast, op) {
  const u = eventsUnion(ast, op);
  return !!u && Object.values(u.shape.members).some((m) => m.traits?.[T('jsonName')] === 'text.delta');
}

/**
 * A call whose input object is written inline when the line is short, and otherwise one member per line
 * with the object hugging the parentheses: f(a, {\n  x: 1,\n}, opts).
 */
function hug(head, before, items, o, after) {
  const obj = items.length ? `${o.open}${items.join(', ')}${o.close}` : o.empty;
  const inline = `${head}(${[...before, obj, ...after].join(', ')})`;
  if (inline.length <= 90 || !items.length) return inline;
  const open = o.open.trimEnd();
  const close = o.close.trimStart();
  const lines = (o.multiline ?? items).map((i) => `${o.indent}${i}${o.comma}`).join('\n');
  return `${head}(${[...before, `${open}\n${lines}\n${close}`].join(', ')}${after.length ? `, ${after.join(', ')}` : ''})`;
}

const indent = (code, n) => code.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');

// The TypeScript client as scopes (PROTOCOL.md 10): each operation's method is found in the scope tree
// (conformance/cases/scope-tree.json), the example's identifiers make the scopes on the way, and the rest of its input
// is laid out as the TypeScript SDK takes it (codegen/typescript's ScopeEmitter): an upload target's file first, else
// a lone required member first, then an object of the other members, then the call options.
const C = (s) => `ai.caitlyn.traits#${s}`;

function allMembers(ast, id) {
  const s = ast.shapes[id];
  const out = {};
  for (const m of s?.mixins ?? []) Object.assign(out, allMembers(ast, m.target));
  return Object.assign(out, s?.members ?? {});
}

function tsLayout(ast, op, fills) {
  const members = allMembers(ast, op.input.target);
  const upload = op.traits?.[C('uploadTarget')]?.member;
  const top = upload && !upload.includes('.') ? upload : undefined;
  const options = [];
  const rest = [];
  for (const [name, m] of Object.entries(members)) {
    if (callOption(name, m)) options.push(name);
    else if (fills.includes(name) || m.traits?.[C('fromScope')] !== undefined || name === top) continue;
    else rest.push(name);
  }
  const required = rest.filter((n) => members[n].traits?.[T('required')] !== undefined);
  const readers = (n) => ast.shapes[members[n].target]?.members?.kind !== undefined;
  const positional = !top && !upload?.includes('.') && required.length === 1 && rest.length <= 3 && !readers(required[0]) ? required[0] : undefined;
  return { members, top, positional, rest: rest.filter((n) => n !== positional), options };
}

function typescript(ast, op, example) {
  const input = example.input;
  const error = example.error ? local(example.error.shapeId) : null;
  // Placed through the scope tree (docs-scopes.mjs): the identifiers in the scopes, the rest as the call's arguments.
  const { steps, method, estimate, leading } = placement(op.name, input);
  // A folder scope takes its path as people write it; the input has it as a request path does (`hr/leave`).
  const labels = new Set((method.fills ?? []).filter((f) => f.trimSlashes).map((f) => input[f.member]));
  const scopeArg = (v) => (labels.has(v) ? `'/${v}/'` : `'${v}'`);
  let head = 'caitlyn';
  for (const step of steps) head += `.${step.name}${step.args ? `(${step.args.map(scopeArg).join(', ')})` : ''}`;
  head += `.${method.name}${estimate ? '.estimate' : ''}`;
  const jobOp = ast.shapes[`ai.caitlyn.v3#${method.operation}`];
  const job = tsLayout(ast, jobOp, (method.fills ?? []).map((f) => f.member));
  const own = estimate ? tsLayout(ast, op.shape, (method.fills ?? []).map((f) => f.member)) : job;
  const value = (layout, name) => literal(ast, 'typescript', layout.members[name].target, input[name]);
  const before = leading.map((v) => `'${v}'`);
  if (job.top) {
    if (!estimate) before.push(`{ ${job.top}: '${input[job.top]}' }`);
    else {
      const [name, m] = Object.entries(own.members).find(([n, x]) => input[n] !== undefined && /UploadDescription/.test(ast.shapes[x.target]?.type === 'list' ? ast.shapes[x.target].member.target : x.target));
      const d = ast.shapes[m.target]?.type === 'list' ? { target: ast.shapes[m.target].member.target, v: input[name][0] } : { target: m.target, v: input[name] };
      before.push(literal(ast, 'typescript', d.target, d.v));
    }
  }
  if (job.positional && input[job.positional] !== undefined) before.push(value(own, job.positional));
  // A file job's estimate takes the file and the estimate's own members only; any other estimate, its job's arguments.
  const describes = (target) => /#UploadDescription$/.test(target) || /#UploadDescription$/.test(ast.shapes[target]?.member?.target ?? '');
  const ownMembers = estimate && job.top ? own.rest.filter((n) => !describes(own.members[n].target)) : undefined;
  const restNames = (ownMembers ?? (estimate ? job.rest.filter((n) => own.rest.includes(n)) : job.rest)).filter((n) => input[n] !== undefined);
  const items = restNames.map((n) => `${n}: ${value(own, n)}`);
  const opts = own.options.filter((n) => input[n] !== undefined).map((n) => `${callOption(n, own.members[n])}: ${literal(ast, 'typescript', 'smithy.api#String', input[n])}`);
  const after = opts.length ? [`{ ${opts.join(', ')} }`] : [];
  const o = { open: '{ ', close: ' }', empty: '{}', indent: '  ', comma: ',' };
  const call = (ownMembers ? ownMembers.length : job.rest.length)
    ? hug(head, before, items, o, after)
    : `${head}(${[...before, ...(after.length ? after : [])].join(', ')})`;
  let body;
  const k = estimate ? 'call' : kind(ast, op);
  if (k === 'stream') {
    body = hasTextDelta(ast, op) && eventsUnion(ast, op).final
      ? `for await (const text of ${call}.text()) process.stdout.write(text);`
      : `for await (const event of ${call}) console.log(event.type, event);`;
  } else if (k === 'list') body = `for await (const item of ${call}) {\n  console.log(item);\n}`;
  else body = `const result = await ${call};\nconsole.log(result);`;
  const imports = ['Caitlyn', ...(error ? [error] : [])];
  if (error) body = `try {\n${indent(body, 2)}\n} catch (err) {\n  if (!(err instanceof ${error})) throw err;\n  console.error(err.status, err.code, err.detail, err.requestId);\n}`;
  return [
    `import { ${imports.join(', ')} } from '@caitlyn-ai/sdk';`,
    '',
    `const caitlyn = new Caitlyn({ workspace: '${WORKSPACE}', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });`,
    '',
    body,
    '',
  ].join('\n');
}

/** An identifier as a Python literal: a string, or a number as the model's examples give it. */
const pyId = (v) => (typeof v === 'string' ? pyStr(v) : String(v));

/** The estimates whose job takes a file: the SDK's estimate takes the file too and describes it (PROTOCOL.md 10). */
const FILE_ESTIMATES = new Set(['EstimateIngestion', 'EstimateDocumentVersion']);

function python(ast, op, example) {
  pyImports.clear();
  const p = inputParts(ast, op, { ...example.input });
  const error = example.error ? local(example.error.shapeId) : null;
  // The call's place in the client: the scopes take the identifiers, the call the rest (scripts/docs-scopes.mjs).
  const place = placement(op.name, example.input ?? {});
  const args = place.leading.map(pyId);
  const fields = p.positional ? [p.positional, ...p.fields] : p.fields;
  if (place.estimate && FILE_ESTIMATES.has(op.name)) {
    // The example describes the file; the SDK's estimate takes the file itself, here by its name.
    const described = example.input?.file ?? example.input?.documents?.[0];
    args.push(pyStr(described?.name ?? 'leave-policy.pdf'));
    for (const f of fields) if (!place.filled.has(f.name) && f.name !== 'file' && f.name !== 'documents') args.push(`${names.python(f.name)}=${literal(ast, 'python', f.member.target, f.value)}`);
  } else {
    for (const f of fields) if (!place.filled.has(f.name)) args.push(`${names.python(f.name)}=${literal(ast, 'python', f.member.target, f.value)}`);
  }
  for (const [k, v] of Object.entries(p.options)) args.push(`${names.python(k)}=${pyStr(v)}`);
  const path = place.steps.map((s) => names.python(s.name) + (s.args ? `(${s.args.map(pyId).join(', ')})` : '')).join('.');
  const head = `caitlyn.${path ? `${path}.` : ''}${names.python(place.method.name)}${place.estimate ? '.estimate' : ''}`;
  const inline = `${head}(${args.join(', ')})`;
  const call = inline.length <= 80 ? inline : `${head}(\n${args.map((a) => `    ${a},`).join('\n')}\n)`;
  const imports = new Set(['Caitlyn', ...pyImports]);
  pyImports.clear();
  if (error) imports.add(error);
  let body;
  const k = kind(ast, op);
  if (k === 'stream') {
    if (hasTextDelta(ast, op)) {
      imports.add('TextDeltaEvent');
      body = `with ${call} as stream:\n    for event in stream:\n        if isinstance(event, TextDeltaEvent):\n            print(event.delta, end="", flush=True)\n    print(stream.final_message())`;
    } else body = `with ${call} as stream:\n    for event in stream:\n        print(event.type, event)`;
  } else if (k === 'list') body = `for item in ${call}:\n    print(item)`;
  else body = `result = ${call}\nprint(result)`;
  if (error) body = `try:\n${indent(body, 4)}\nexcept ${error} as err:\n    print(err.status, err.code, err.detail, err.request_id)`;
  return [
    'import os',
    '',
    `from caitlyn import ${[...imports].sort().join(', ')}`,
    'from caitlyn.auth import Token',
    '',
    `caitlyn = Caitlyn(workspace="${WORKSPACE}", auth=Token(os.environ["CAITLYN_TOKEN"]))`,
    '',
    body,
    '',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------ Go, by scope

/**
 * The Go spelling of a placement (scripts/docs-scopes.mjs): a collection called with identifiers is the parent's
 * singular method (`KnowledgeBase("KB…")`), a named scope a method (`Draft()`), anything else a field (`Documents`).
 * Also the input members no Go Input holds: every member any placement fills, and the filters a scope's watch fills.
 */
let goTree;
function goSpelling() {
  if (goTree) return goTree;
  const tree = JSON.parse(fs.readFileSync(path.join(root, 'conformance/cases/scope-tree.json'), 'utf8'));
  const fillsOf = {};
  const walk = (n) => {
    for (const m of n.methods ?? []) for (const f of m.fills ?? []) (fillsOf[m.operation] ??= new Set()).add(f.member);
    if (n.watch?.filter) (fillsOf[n.watch.watch] ??= new Set()).add(n.watch.filter);
    for (const c of Object.values(n.children ?? {})) walk(c);
    if (n.scope) walk(n.scope);
  };
  walk(tree);
  goTree = { tree, fillsOf };
  return goTree;
}

export function goChain(steps) {
  let node = goSpelling().tree;
  let out = '';
  for (const step of steps) {
    const child = node.children[step.name];
    if (step.args) {
      out += `.${names.go(child.singular)}(${step.args.map((a) => JSON.stringify(a)).join(', ')})`;
      node = child.scope;
    } else if (child.kind === 'scope' && child.alias) {
      out += `.${names.go(child.alias)}()`;
      node = child;
    } else {
      out += `.${names.go(step.name)}`;
      node = child;
    }
  }
  return out;
}

const describesFile = (ast, member) => {
  const t = ast.shapes[member.target];
  return /#UploadDescription$/.test(t?.type === 'list' ? t.member.target : member.target);
};

function go(ast, op, example) {
  const S = ast.shapes;
  const input = example.input ?? {};
  const p = placement(op.name, input);
  const error = example.error ? local(example.error.shapeId) : null;
  const str = (v) => JSON.stringify(v);
  const chain = goChain(p.steps);
  const name = p.estimate ? `Estimate${names.go(p.method.name)}` : names.go(p.method.name);
  const jobOp = p.estimate ? operations(ast).find((o) => o.name === p.method.operation) : op;
  const target = jobOp.shape.traits?.['ai.caitlyn.traits#uploadTarget']?.member;
  const topFile = !!target && !target.includes('.');
  // A file job's estimate takes the file and its own members; any other estimate its job's.
  const inputOp = p.estimate && !topFile ? jobOp : op;
  const { fillsOf } = goSpelling();
  const filled = new Set([...(fillsOf[inputOp.name] ?? []), ...p.filled, ...(p.method.leading ?? [])]);
  if (topFile && !p.estimate) filled.add(target);
  const inputShape = S[inputOp.shape.input.target];
  const members = Object.entries(inputShape.members ?? {}).filter(([n, m]) => !filled.has(n) && !callOption(n, m) && !describesFile(ast, m));
  const hasInput = members.length > 0;
  const own = S[op.shape.input.target].members ?? {};
  const given = members.filter(([n]) => input[n] !== undefined && own[n]);
  const inputType = local(inputOp.shape.input.target);
  const width = Math.max(0, ...given.map(([n]) => names.go(n).length));
  const items = given.map(([n, m]) => `${`${names.go(n)}:`.padEnd(width + 1)} ${literal(ast, 'go', m.target, input[n], { optional: !required(m) })}`);
  const before = ['ctx', ...p.leading.map((v) => str(v))];
  const pre = [];
  if (topFile && !p.estimate) before.push(`caitlyn.UploadID(${str(input[target])})`);
  if (p.estimate && topFile) {
    // An estimate takes the job's file, and sends only its description.
    const d = Array.isArray(input.documents) ? input.documents[0] : input.file;
    const hints = d.hints ? `, caitlyn.WithHints(${literal(ast, 'go', 'ai.caitlyn.v3#IngestionHints', d.hints, { optional: true })})` : '';
    pre.push(`file, err := caitlyn.FileFromPath(${str(`./${d.name}`)}${hints})`, 'if err != nil {', '\tlog.Fatal(err)', '}');
    before.push('file');
  }
  const options = Object.entries(input).flatMap(([n, v]) => {
    const o = callOption(n, own[n] ?? {});
    return o ? [`caitlyn.With${o === 'ifMatch' ? 'IfMatch' : 'IdempotencyKey'}(${str(v)})`] : [];
  });
  const head = `client${chain}.${name}`;
  // Go's Send is hand-written (codegen/smithy-build.json's handWritten): the message positional, the rest as options.
  const sendArgs = () => {
    const args = ['ctx', str(input.message)];
    if (input.context) args.push(`caitlyn.WithMessageContext(${literal(ast, 'go', own.context.target, input.context).replace(/^\[\]caitlyn\.ContextItem\{(.*)\}$/, '$1')})`);
    if (input.attachments) args.push(`caitlyn.WithAttachments(${input.attachments.map((a) => `caitlyn.UploadID(${str(a.uploadId)})`).join(', ')})`);
    return `${head}(${args.join(', ')})`;
  };
  const call = op.name === 'SendMessage' ? sendArgs() : hasInput
    ? hug(head, before, items.map((i) => i.replace(/ {2,}/, ' ')), { open: `&caitlyn.${inputType}{`, close: '}', empty: 'nil', indent: '\t', comma: ',', multiline: items }, options)
    : `${head}(${[...before, ...options].join(', ')})`;
  const imports = ['context', 'fmt', 'log', 'os'];
  const handle = error
    ? `var apiErr *caitlyn.${error}\nif errors.As(err, &apiErr) {\n\tfmt.Println(apiErr.Status, apiErr.Code, apiErr.Detail, apiErr.RequestID)\n\treturn\n}\nlog.Fatal(err)`
    : 'log.Fatal(err)';
  if (error) imports.push('errors');
  let body;
  const k = kind(ast, op);
  if (k === 'stream') {
    const loop = hasTextDelta(ast, op)
      ? 'for event, err := range stream.Events() {\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tif delta, ok := event.(*caitlyn.TextDelta); ok {\n\t\tfmt.Print(delta.Delta)\n\t}\n}'
      : 'for event, err := range stream.Events() {\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tfmt.Printf("%s %+v\\n", event.EventType(), event)\n}';
    body = `stream, err := ${call}\nif err != nil {\n${handle.replace(/^/gm, '\t')}\n}\ndefer stream.Close()\n${loop}`;
  } else if (k === 'list') {
    imports.push('encoding/json');
    body = `for item, err := range ${call} {\n\tif err != nil {\n${handle.replace(/^/gm, '\t\t')}\n\t}\n\tout, _ := json.Marshal(item)\n\tfmt.Println(string(out))\n}`;
  } else {
    imports.push('encoding/json');
    body = `result, err := ${call}\nif err != nil {\n${handle.replace(/^/gm, '\t')}\n}\nout, _ := json.MarshalIndent(result, "", "  ")\nfmt.Println(string(out))`;
  }
  if (pre.length) body = `${pre.join('\n')}\n${body}`;
  return [
    'package main',
    '',
    'import (',
    ...imports.sort().map((i) => `\t"${i}"`),
    '',
    '\tcaitlyn "github.com/caitlyn-ai/sdk/go"',
    ')',
    '',
    'func main() {',
    '\tctx := context.Background()',
    `\tclient, err := caitlyn.NewClient("${WORKSPACE}", caitlyn.Token(os.Getenv("CAITLYN_TOKEN")))`,
    '\tif err != nil {',
    '\t\tlog.Fatal(err)',
    '\t}',
    body.replace(/^(?=.)/gm, '\t'),
    '}',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------------------------------------ Rust: scopes

/** A Rust method of the scope tree (Names.segment): snake case, `core` and `input` as they are. */
const rustMethod = (n) => words(n).join('_');

function rust(ast, op, example) {
  const input = example.input ?? {};
  // Placed through the scope tree (scripts/docs-scopes.mjs), as every language's reference programs are.
  const place = placement(op.name, input);
  place.name = place.estimate ? `estimate_${rustMethod(place.method.name)}` : rustMethod(place.method.name);
  const error = example.error ? local(example.error.shapeId).replace(/Error$/, '') : null;
  const imports = new Set(['Auth', 'Client']);
  rustImports.clear();
  const str = (v) => JSON.stringify(String(v));
  const shape = ast.shapes[op.shape.input.target];
  const members = shape.members ?? {};
  const target = op.shape.traits?.['ai.caitlyn.traits#uploadTarget']?.member;
  const jobTarget = place.estimate ? ast.shapes[`ai.caitlyn.v3#${place.method.operation}`]?.traits?.['ai.caitlyn.traits#uploadTarget']?.member : null;
  const described = Object.entries(members).find(([, m]) => {
    const t = ast.shapes[m.target];
    const item = t?.type === 'list' ? t.member.target : m.target;
    return item.endsWith('#UploadDescription');
  });
  const withFile = (target && !target.includes('.')) || (jobTarget && !jobTarget.includes('.') && described);
  const fills = place.estimate ? new Set() : place.filled;
  const leading = place.method.leading ?? [];
  // A value as a Rust argument or setter takes it: &str for strings, arrays of &str for lists of strings.
  const arg = (m, value) => {
    const t = ast.shapes[m.target] ?? { type: m.target.split('#')[1].toLowerCase() };
    if (t.type === 'string') return str(value);
    if (t.type === 'list' && (ast.shapes[t.member.target] ?? { type: 'string' }).type === 'string') return `[${value.map(str).join(', ')}]`;
    return literal(ast, 'rust', m.target, value, { optional: false });
  };
  const args = place.leading.map((v) => str(v));
  if (withFile) {
    const given = input.name ?? (described ? (Array.isArray(input[described[0]]) ? input[described[0]][0]?.name : input[described[0]]?.name) : null);
    args.push(str(`./${given?.includes('.') ? given : 'leave-policy.pdf'}`));
  }
  const setters = [];
  const options = [];
  const positional = [];
  for (const [name, m] of Object.entries(members)) {
    const value = input[name];
    if (value === undefined || fills.has(name) || leading.includes(name) || m.traits?.[T('httpLabel')]) continue;
    const option = callOption(name, m);
    if (option) {
      options.push(`.${names.rust(option)}(${str(value)})`);
      continue;
    }
    if (withFile && (name === target || (described && name === described[0]))) continue;
    if (!withFile && m.traits?.[T('required')]) positional.push({ name, code: arg(m, value) });
    else setters.push(`.${names.rust(name)}(${arg(m, value)})`);
  }
  // The member a create's new scope is named by comes first, as the SDK takes it: `kb.fields().create(key, …)`.
  const first = place.method.creates?.source?.startsWith('input:') ? place.method.creates.source.slice('input:'.length) : null;
  positional.sort((a, b) => (a.name === first ? 0 : 1) - (b.name === first ? 0 : 1));
  args.push(...positional.map((p) => p.code));
  for (const n of rustImports) imports.add(n);
  rustImports.clear();
  let call = 'client';
  for (const step of place.steps) {
    if (!step.args) {
      call += `\n    .${rustMethod(step.name)}()`;
      continue;
    }
    // A folder scope takes its path as people write it: `/hr/leave/`, where the request path has `hr/leave`.
    const folder = step.singular === 'folder';
    const values = step.args.map((v) => (folder ? `/${String(v).replace(/^\/|\/$/g, '')}/` : v));
    call += `\n    .${rustMethod(step.singular)}(${values.map(str).join(', ')})`;
  }
  call += `\n    .${place.name}(${args.join(', ')})`;
  for (const x of [...setters, ...options]) call += `\n    ${x}`;
  let body;
  const k = kind(ast, op);
  if (k === 'stream') {
    imports.add('ConversationEvent');
    const loop = hasTextDelta(ast, op)
      ? 'while let Some(event) = stream.next().await {\n    if let ConversationEvent::TextDelta(delta) = event? {\n        print!("{}", delta.delta);\n    }\n}'
      : 'while let Some(event) = stream.next().await {\n    println!("{:?}", event?);\n}';
    if (!hasTextDelta(ast, op)) imports.delete('ConversationEvent');
    body = `let mut stream = ${call}\n    .await?;\n${loop}`;
  } else if (k === 'list') body = `let mut items = ${call}\n    .items();\nwhile let Some(item) = items.next().await {\n    println!("{:#?}", item?);\n}`;
  else body = `let result = ${call}\n    .await?;\nprintln!("{result:#?}");`;
  if (error) {
    // The 404 (or other error) arrives where the call is awaited, or for a stream or list, from its first item.
    body = `let outcome: Result<(), caitlyn_sdk::Error> = async {\n${indent(body, 4)}\n    Ok(())\n}\n.await;\nmatch outcome {\n    Err(caitlyn_sdk::Error::${error}(err)) => eprintln!("{} {} {:?} {:?}", err.status, err.code, err.detail, err.request_id),\n    other => other?,\n}`;
  }
  return [
    `use caitlyn_sdk::{${[...imports].sort().join(', ')}};`,
    '',
    '#[tokio::main]',
    'async fn main() -> Result<(), Box<dyn std::error::Error>> {',
    `    let client = Client::new("${WORKSPACE}", Auth::token(std::env::var("CAITLYN_TOKEN")?))?;`,
    indent(body, 4),
    '    Ok(())',
    '}',
    '',
  ].join('\n');
}

const RENDER = { typescript, python, go, rust };

/**
 * Every example of every public operation: [{ op, example, index, file, code: {typescript, python, go, rust} }], in the
 * languages asked for (all four by default).
 */
export function snippets(ast, langs = LANGUAGES.map((l) => l.key)) {
  const out = [];
  for (const op of operations(ast)) {
    (op.shape.traits?.[T('examples')] ?? []).forEach((example, index) => {
      const file = `${snake(op.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))}_${index + 1}`;
      const code = Object.fromEntries(langs.map((l) => [l, RENDER[l](ast, op, example)]));
      out.push({ op, example, index, file, code });
    });
  }
  return out;
}

/** Writes one language's snippets where its CI job compiles them. */
export function writeChecks(ast, lang) {
  const all = snippets(ast, [lang]);
  const dirs = {
    typescript: path.join(root, 'examples/typescript/reference'),
    python: path.join(root, 'examples/python/reference'),
    go: path.join(root, 'examples/go/reference'),
    rust: path.join(root, 'examples/rust/examples'),
  };
  const dir = dirs[lang];
  if (!dir) throw new Error(`docs-snippets: unknown language ${lang}; one of ${Object.keys(dirs).join(', ')}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const header = {
    typescript: '// Generated by scripts/docs-snippets.mjs from the model\'s @examples; the API reference shows this program. Do not edit.\n',
    python: '# Generated by scripts/docs-snippets.mjs from the model\'s @examples; the API reference shows this program. Do not edit.\n',
    go: '// Code generated by scripts/docs-snippets.mjs from the model\'s @examples. DO NOT EDIT.\n\n',
    rust: '// Generated by scripts/docs-snippets.mjs from the model\'s @examples; the API reference shows this program. Do not edit.\n',
  }[lang];
  for (const s of all) {
    const code = header + s.code[lang];
    if (lang === 'typescript') fs.writeFileSync(path.join(dir, `${s.file}.ts`), code);
    if (lang === 'python') fs.writeFileSync(path.join(dir, `${s.file}.py`), code);
    if (lang === 'rust') fs.writeFileSync(path.join(dir, `${s.file}.rs`), code);
    if (lang === 'go') {
      fs.mkdirSync(path.join(dir, s.file), { recursive: true });
      fs.writeFileSync(path.join(dir, s.file, 'main.go'), code);
    }
  }
  return all.length;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const lang = process.argv[2];
  const n = writeChecks(loadModel(), lang);
  console.log(`docs-snippets: ${n} ${lang} programs from the model's @examples, for the compiler to check`);
}
