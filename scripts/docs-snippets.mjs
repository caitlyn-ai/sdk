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
import { T, binding, callOption, eventsUnion, loadModel, local, names, operations, root } from './docs-model.mjs';

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
function literal(ast, lang, target, value, { optional = false } = {}) {
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
      const v = member ? `${typeName}::${names.rustPascal(member)}` : `${typeName}::Unknown(${str(value)}.into())`;
      return optional ? `Some(${v})` : v;
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
    const items = value.map((v) => literal(ast, lang, shape.member.target, v));
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
    if (lang === 'python') return `${name}(${entries.map(([k, m, v]) => `${names.python(k)}=${literal(ast, lang, m.target, v)}`).join(', ')})`;
    if (lang === 'go') return `caitlyn.${name}{${entries.map(([k, m, v]) => `${names.go(k)}: ${literal(ast, lang, m.target, v, { optional: !required(m) })}`).join(', ')}}`;
    const v = `${name} { ${entries.map(([k, m, v]) => `${names.rust(k)}: ${literal(ast, lang, m.target, v, { optional: !required(m) })}`).join(', ')}, ..Default::default() }`;
    return optional ? `Some(${v})` : v;
  }
  if (type === 'document') {
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

function typescript(ast, op, example) {
  const p = inputParts(ast, op, example.input);
  const error = example.error ? local(example.error.shapeId) : null;
  const before = p.positional ? [literal(ast, 'typescript', p.positional.member.target, p.positional.value)] : [];
  const items = p.fields.map((f) => `${f.name}: ${literal(ast, 'typescript', f.member.target, f.value)}`);
  const opts = Object.entries(p.options).map(([k, v]) => `${k}: ${literal(ast, 'typescript', 'smithy.api#String', v)}`);
  const after = opts.length ? [`{ ${opts.join(', ')} }`] : [];
  const call = hug(`caitlyn.${op.namespace}.${op.method}`, before, items, { open: '{ ', close: ' }', empty: '{}', indent: '  ', comma: ',' }, after);
  let body;
  const k = kind(ast, op);
  if (k === 'stream') {
    body = hasTextDelta(ast, op)
      ? `const stream = ${call};\nfor await (const event of stream) {\n  if (event.type === 'text.delta') process.stdout.write(event.delta);\n}\nconsole.log(await stream.finalMessage());`
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

function python(ast, op, example) {
  const p = inputParts(ast, op, example.input);
  const error = example.error ? local(example.error.shapeId) : null;
  const args = [];
  if (p.positional) args.push(literal(ast, 'python', p.positional.member.target, p.positional.value));
  for (const [k, v] of Object.entries(p.options)) args.push(`${names.python(k)}=${pyStr(v)}`);
  for (const f of p.fields) args.push(`${names.python(f.name)}=${literal(ast, 'python', f.member.target, f.value)}`);
  const head = `caitlyn.${names.python(op.namespace)}.${names.python(op.method)}`;
  const inline = `${head}(${args.join(', ')})`;
  const call = inline.length <= 80 ? inline : `${head}(\n${args.map((a) => `    ${a},`).join('\n')}\n)`;
  const imports = new Set(['Caitlyn']);
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

function go(ast, op, example) {
  const p = inputParts(ast, op, example.input);
  const error = example.error ? local(example.error.shapeId) : null;
  const inputType = `${local(op.shape.input.target)}`;
  // gofmt aligns the values of consecutive key: value lines
  const width = Math.max(0, ...p.fields.map((f) => names.go(f.name).length));
  const items = p.fields.map((f) => `${`${names.go(f.name)}:`.padEnd(width + 1)} ${literal(ast, 'go', f.member.target, f.value, { optional: !required(f.member) })}`);
  const before = ['ctx', ...(p.positional ? [literal(ast, 'go', p.positional.member.target, p.positional.value)] : [])];
  const after = Object.entries(p.options).map(([k, v]) => `caitlyn.With${k === 'ifMatch' ? 'IfMatch' : 'IdempotencyKey'}(${JSON.stringify(v)})`);
  const call = hug(`client.${names.go(op.namespace)}.${names.go(op.method)}`, before, items.map((i) => i.replace(/ {2,}/, ' ')), { open: `&caitlyn.${inputType}{`, close: '}', empty: `&caitlyn.${inputType}{}`, indent: '\t', comma: ',', multiline: items }, after);
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
      : 'for event, err := range stream.Events() {\n\tif err != nil {\n\t\tlog.Fatal(err)\n\t}\n\tfmt.Printf("%T %+v\\n", event, event)\n}';
    body = `stream, err := ${call}\nif err != nil {\n${handle.replace(/^/gm, '\t')}\n}\ndefer stream.Close()\n${loop}`;
  } else if (k === 'list') {
    imports.push('encoding/json');
    body = `for item, err := range ${call} {\n\tif err != nil {\n${handle.replace(/^/gm, '\t\t')}\n\t}\n\tout, _ := json.Marshal(item)\n\tfmt.Println(string(out))\n}`;
  } else {
    imports.push('encoding/json');
    body = `result, err := ${call}\nif err != nil {\n${handle.replace(/^/gm, '\t')}\n}\nout, _ := json.MarshalIndent(result, "", "  ")\nfmt.Println(string(out))`;
  }
  return [
    'package main',
    '',
    'import (',
    ...imports.sort().map((i) => `\t"${i}"`),
    '',
    '\tcaitlyn "github.com/caitlyn-ai/caitlyn-go"',
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

function rust(ast, op, example) {
  const p = inputParts(ast, op, example.input);
  const error = example.error ? local(example.error.shapeId).replace(/Error$/, '') : null;
  const inputType = local(op.shape.input.target);
  const imports = new Set(['Auth', 'Client', inputType]);
  const fields = p.fields.map((f) => {
    const target = ast.shapes[f.member.target];
    if (target?.type === 'enum') imports.add(local(f.member.target));
    if (target?.type === 'list' && ast.shapes[target.member.target]?.type === 'enum') imports.add(local(target.member.target));
    return `${names.rust(f.name)}: ${literal(ast, 'rust', f.member.target, f.value, { optional: !required(f.member) })}`;
  });
  const args = [];
  if (p.positional) args.push(JSON.stringify(p.positional.value));
  // Every field the program does not set comes from Default; clippy refuses `..Default::default()` when none is left.
  args.push(`${inputType} {\n${[...fields.map((f) => `    ${f},`), ...(p.unset.length ? ['    ..Default::default()'] : [])].join('\n')}\n}`);
  const opts = Object.entries(p.options).map(([k, v]) => `.${names.rust(k)}(${JSON.stringify(v)})`).join('');
  const call = `client\n    .${names.rust(op.namespace)}()\n    .${names.rust(op.method)}(${indent(args.join(', '), 4).trimStart()})${opts ? `\n    ${opts}` : ''}`;
  let body;
  const k = kind(ast, op);
  if (k === 'stream') {
    imports.add('ConversationEvent');
    const loop = hasTextDelta(ast, op)
      ? 'while let Some(event) = stream.next().await {\n    if let ConversationEvent::TextDelta(delta) = event? {\n        print!("{}", delta.delta);\n    }\n}'
      : 'while let Some(event) = stream.next().await {\n    println!("{:?}", event?);\n}';
    if (!hasTextDelta(ast, op)) imports.delete('ConversationEvent');
    body = `let mut stream = ${call}\n    .await?;\n${loop}`;
  } else if (k === 'list') body = `let mut items = ${call};\nwhile let Some(item) = items.next().await {\n    println!("{:#?}", item?);\n}`;
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

/** Every example of every public operation: [{ op, example, index, file, code: {typescript, python, go, rust} }]. */
export function snippets(ast) {
  const out = [];
  for (const op of operations(ast)) {
    (op.shape.traits?.[T('examples')] ?? []).forEach((example, index) => {
      const file = `${snake(op.name.replace(/([a-z0-9])([A-Z])/g, '$1_$2'))}_${index + 1}`;
      const code = Object.fromEntries(LANGUAGES.map((l) => [l.key, RENDER[l.key](ast, op, example)]));
      out.push({ op, example, index, file, code });
    });
  }
  return out;
}

/** Writes one language's snippets where its CI job compiles them. */
export function writeChecks(ast, lang) {
  const all = snippets(ast);
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
