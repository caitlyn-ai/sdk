// The operation pages' response panes (src/components/OperationPanel.astro): beside every status, in each SDK language,
// what the call returns or the error class it raises, read from the generated SDKs (scripts/docs-api.mjs sdkReturns).
// Every link in them names a page the site builds, and every class is one the SDK has. scripts/docs-build.mjs checks the
// links again in the built pages. Reads the prepared model (scripts/docs-build.sh runs prepare-model before these tests).
// Run: npm test (in docs/site).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { allErrors, kebab, loadModel, root } from '../../../scripts/docs-model.mjs';
import { referencePages } from '../../../scripts/docs-reference.mjs';
import { SDK_TYPES, sdkReturns, sdkTypeAnchor, sdkTypePages } from '../../../scripts/docs-api.mjs';

const ast = loadModel();
const reference = referencePages(ast);
const returned = sdkReturns({ ast, ops: reference.ops, tree: reference.tree, typePages: reference.typePages, sdkSlug: (op) => `sdk/${kebab(op.name)}` });
const LANGS = ['typescript', 'python', 'go', 'rust'];
const typePages = sdkTypePages(returned[SDK_TYPES]);
// The site's addresses: the SDK reference's pages and the SDK types area (written under reference/, published under
// sdk/), the errors' pages
const slugs = new Set([...reference.pages, ...typePages].map((p) => p.slug.replace(/^reference\//, 'sdk/')));
slugs.add('errors');

test('every SDK-language response on every operation page shows what the call returns', () => {
  for (const op of reference.ops) {
    const r = returned[op.name];
    assert.ok(r, op.name);
    for (const lang of LANGS) assert.match(r.returns[lang] ?? '', /^returns <code>/, `${op.name} in ${lang}`);
  }
});

test('every error status an operation documents names the class each SDK raises, and the class is the SDK\'s own', () => {
  const sources = {
    typescript: fs.readFileSync(path.join(root, 'typescript/packages/sdk/src/models/errors.ts'), 'utf8'),
    python: fs.readFileSync(path.join(root, 'python/caitlyn/caitlyn/errors.py'), 'utf8'),
    go: fs.readFileSync(path.join(root, 'go/errors.go'), 'utf8'),
    rust: fs.readFileSync(path.join(root, 'rust/caitlyn-sdk/src/error.rs'), 'utf8'),
  };
  const defined = {
    typescript: (c) => new RegExp(`export class ${c}\\b`).test(sources.typescript),
    python: (c) => new RegExp(`^class ${c}\\(`, 'm').test(sources.python),
    go: (c) => new RegExp(`^type ${c.replace(/^\*caitlyn\./, '')} struct`, 'm').test(sources.go),
    rust: (c) => new RegExp(`^\\s+${c.replace(/^Error::/, '')}\\(`, 'm').test(sources.rust),
  };
  const modelled = new Map(allErrors(ast).map((e) => [e.status, e.name]));
  for (const p of reference.pages.filter((x) => x.operation)) {
    for (const { status } of p.operation.responses.filter((x) => x.status >= 400)) {
      const classes = returned[p.operation.name].errorClasses[String(status)];
      for (const lang of LANGS) {
        assert.ok(classes?.[lang], `${p.operation.name} ${status} in ${lang}`);
        assert.ok(defined[lang](classes[lang]), `${p.operation.name} ${status}: ${classes[lang]} is not a ${lang} class`);
        if (modelled.has(status)) assert.match(classes[lang], new RegExp(modelled.get(status).replace(/Error$/, '')), `${status} in ${lang} is the status's own class`);
      }
    }
  }
});

test('every link in a return line names a page the site builds, and an anchor on it', () => {
  const bySlug = new Map([...reference.pages, ...typePages].map((p) => [p.slug.replace(/^reference\//, 'sdk/'), p]));
  for (const [name, r] of Object.entries(returned)) {
    for (const [lang, html] of Object.entries(r.returns)) {
      for (const [, href] of html.matchAll(/href="([^"]*)"/g)) {
        const [target, anchor] = href.split('#');
        const slug = target.replace(/^\/|\/$/g, '');
        assert.ok(slugs.has(slug), `${name} in ${lang} links to ${href}, which is no page`);
        const body = bySlug.get(slug).body;
        if (anchor) assert.ok(new RegExp(`^## ${anchor.charAt(0).toUpperCase()}${anchor.slice(1)}$`, 'm').test(body) || body.includes(`{#${anchor}}`), `${href} names no heading`);
      }
    }
  }
});

test('a call that creates a scope or starts work shows the handle, not the body', () => {
  const ts = returned.CreateDocument.returns.typescript;
  assert.match(ts, /WorkPromise/);
  assert.match(returned.CreateAgent.returns.python, /CreatedAgentScope/);
  assert.match(returned.DeleteKnowledgeBase.returns.go, /DeleteKnowledgeBaseStarted/);
  assert.match(returned.SendMessage.returns.rust, /ConversationEventStream/);
  // A get returns the thing itself, linked to its type page
  assert.match(returned.GetKnowledgeBase.returns.go, /\*caitlyn\.<a href="\/sdk\/types\/knowledge-base\/">KnowledgeBase<\/a>/);
  // A create that returns a thing shows the scope and the thing, each linked, in each language's spelling
  const field = returned.CreateField.returns;
  assert.match(field.typescript, /KnowledgeBaseFieldScope<\/a> &amp; <a href="\/sdk\/types\/field\/">Field<\/a>/);
  assert.match(field.python, /CreatedFieldScope<\/a><\/code>, whose <code>\.result<\/code> is <code><a href="\/sdk\/types\/field\/">Field<\/a>/);
  assert.match(field.go, /CreatedField<\/a><\/code>, whose <code>Result<\/code> is <code>\*caitlyn\.<a href="\/sdk\/types\/field\/">Field<\/a>/);
  assert.match(field.rust, /Created<\/a>&lt;<a href="[^"]+">FieldScope<\/a>, <a href="\/sdk\/types\/field\/">Field<\/a>&gt;/);
});

test('every type a response pane names is linked: none is left as plain text', () => {
  for (const [name, r] of Object.entries(returned)) for (const [lang, names] of Object.entries(r.unlinked)) assert.deepEqual(names, [], `${name} in ${lang}`);
});

test('every error class has its own entry in the SDK types area', () => {
  const page = typePages.find((p) => p.slug === 'reference/sdk-types/error-classes');
  for (const r of Object.values(returned)) {
    for (const classes of Object.values(r.errorClasses)) for (const [lang, cls] of Object.entries(classes)) assert.ok(page.body.includes(`{#${sdkTypeAnchor(lang, cls)}}`), `${lang} ${cls}`);
  }
  for (const id of ['typescript-caitlynerror', 'python-caitlynerror', 'go-caitlyn-error', 'rust-error-api']) assert.ok(page.body.includes(`{#${id}}`), id);
});

test('every type name in a return line is a link of its own, inside generics and intersections too', () => {
  // Only a language's own built-ins (Promise, Go's iter.Seq2 and error, Python's None, Rust's ()) stay plain text
  const BUILT_IN = new Set(['Promise', 'iter', 'Seq2', 'error', 'None', 'caitlyn']);
  for (const [name, r] of Object.entries(returned)) {
    for (const [lang, html] of Object.entries(r.returns)) {
      // Every code span but the accessors named beside a type (Result, .result, Wait, .wait(), .items())
      for (const [, code] of html.matchAll(/<code>([\s\S]*?)<\/code>/g)) {
        if (/^(Result|\.result|Wait|\.wait\(\)|\.items\(\))$/.test(code)) continue;
        const plain = code.replace(/<a [^>]*>[^<]*<\/a>/g, ' ').replace(/&[a-z]+;/g, ' ');
        for (const [word] of plain.matchAll(/\b[A-Za-z_]\w*\b/g)) assert.ok(BUILT_IN.has(word), `${name} in ${lang}: ${word} is not linked`);
      }
    }
  }
});

// A call whose output is a thing (an @httpPayload member) sends the thing as the body, `{"etag": …, "key": …}`; the
// model's examples key it by the member's name (`field`), which is never on the wire
test('no response pane shows a thing wrapped in its payload member\'s name', () => {
  const S = ast.shapes;
  const payloadOf = (op) => Object.entries(S[op.shape.output.target].members ?? {}).find(([, m]) => m.traits?.['smithy.api#httpPayload'] !== undefined)?.[0];
  let checked = 0;
  for (const p of reference.pages.filter((x) => x.operation)) {
    const op = reference.ops.find((o) => o.name === p.operation.name);
    const payload = payloadOf(op);
    if (!payload) continue;
    const bodies = [...p.operation.panel.map((x) => x.result), ...(p.operation.responses ?? []).map((x) => x.result)].filter((b) => b && b.trim().startsWith('{'));
    for (const b of bodies) {
      const keys = Object.keys(JSON.parse(b));
      checked++;
      assert.ok(!(keys.length === 1 && keys[0] === (S[op.shape.output.target].members[payload].traits?.['smithy.api#jsonName'] ?? payload)), `${op.name} shows its body as {"${payload}": …}`);
    }
    for (const m of p.body.matchAll(/```http\nHTTP\/1\.1 2\d\d[^\n]*\n(?:[^\n]+\n)*\n(\{[\s\S]*?\n\})\n```/g)) {
      const keys = Object.keys(JSON.parse(m[1]));
      checked++;
      assert.ok(!(keys.length === 1 && keys[0] === payload), `${op.name}'s HTTP exchange shows its body as {"${payload}": …}`);
    }
  }
  assert.ok(checked > 0);
});
