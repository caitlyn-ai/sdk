// What changed in the public API between two model snapshots (model/model.json, Smithy's JSON AST), in the shape of
// the changes.json the app's CaitlynChanges writes (smithy/validators/.../diff/CaitlynChanges.java in the app): the
// same kinds, fields and order, so the developer site's Changelog renders both alike (scripts/docs-changelog.mjs
// apiSections). The release notes (scripts/release-notes.mjs) diff the model at the previous release tag with the
// one being released, which works whether the snapshot was pulled from a published model or from a local build.
//
//   node scripts/model-diff.mjs OLD_MODEL.json NEW_MODEL.json     prints the changes as JSON
//
// Only the public surface counts, as in CaitlynChanges: shapes a GA or beta operation reaches (through members,
// input, output and errors, mixins, and the shape ids the model's traits name), and the errors bound on the
// service, which every operation can return. Each change carries `surface`: `ga` when a GA operation reaches it,
// `beta` otherwise. docs/site/test/model-diff.test.mjs checks this against two changes.json CaitlynChanges wrote.
import fs from 'node:fs';

export const SERVICE = 'ai.caitlyn.v3#Caitlyn';
const STABILITY = 'ai.caitlyn.traits#stability';
const ERROR_CODES = 'ai.caitlyn.traits#errorCodes';
const KIND_ORDER = ['operationAdded', 'operationRemoved', 'stabilityChanged', 'errorAdded', 'errorRemoved', 'serviceErrorAdded', 'serviceErrorRemoved', 'errorCodeAdded', 'errorCodeRemoved', 'memberAdded', 'memberRemoved', 'memberChanged', 'enumValueAdded', 'enumValueRemoved'];

/**
 * The kinds a caller can be broken by: something they use is gone, something they send became required, or a member
 * now has a type that does not take every value its old one did. A changed type marked `widens` (see widens) breaks
 * no one.
 */
export function isBreaking(c) {
  if (['operationRemoved', 'errorRemoved', 'memberRemoved', 'enumValueRemoved'].includes(c.kind)) return true;
  if (c.kind === 'memberAdded') return c.required === true;
  if (c.kind === 'memberChanged') return (c.from.target !== c.to.target && !c.widens) || (!c.from.required && c.to.required);
  if (c.kind === 'stabilityChanged') return c.to !== 'ga' && c.from === 'ga';
  return false;
}

// The prelude's simple shapes, which a model names but does not declare
const PRELUDE = { String: 'string', Boolean: 'boolean', Blob: 'blob', Timestamp: 'timestamp', Document: 'document', Byte: 'byte', Short: 'short', Integer: 'integer', Long: 'long', Float: 'float', Double: 'double', BigInteger: 'bigInteger', BigDecimal: 'bigDecimal' };
// A number type takes every value of the types before it in its line
const WIDER = [['byte', 'short', 'integer', 'long', 'bigInteger'], ['float', 'double', 'bigDecimal']];
const within = (inner = {}, outer = {}) => (outer.min ?? -Infinity) <= (inner.min ?? -Infinity) && (outer.max ?? Infinity) >= (inner.max ?? Infinity);

/**
 * Whether a member's change of type breaks no one (memberChanged, with the models before and after): both types are
 * plain strings, numbers or other simple values, which every SDK spells as the language's own type (so no caller
 * imports their names), and the new one takes every value the old one did: the same type or a wider number, a length
 * and range no narrower, and no pattern unless the same one. An enum, structure, list, map or union is a named type
 * in the SDKs, so changing it to another breaks code that names it, whatever values it takes.
 */
export function widens(c, before, after) {
  if (c.kind !== 'memberChanged' || c.from.target === c.to.target) return false;
  const memberTarget = (m, s) => m[`${SERVICE.split('#')[0]}#${s}`]?.members?.[c.member]?.target;
  const simple = (m, id) => {
    if (!id) return null;
    const [ns, local] = id.split('#');
    if (ns === 'smithy.api') return PRELUDE[local] ? { type: PRELUDE[local], traits: {} } : null;
    const shape = m[id];
    if (!shape || !Object.values(PRELUDE).includes(shape.type) || shape.traits?.['smithy.api#enum']) return null;
    return { type: shape.type, traits: shape.traits ?? {} };
  };
  const [b, a] = [assembled(before), assembled(after)];
  const old = simple(b, memberTarget(b, c.shape));
  const now = simple(a, memberTarget(a, c.shape));
  if (!old || !now) return false;
  const line = WIDER.find((l) => l.includes(old.type));
  if (old.type !== now.type && !(line && line.indexOf(now.type) > line.indexOf(old.type))) return false;
  const t = (s, trait) => s.traits[`smithy.api#${trait}`];
  if (t(now, 'length') && !within(t(old, 'length'), t(now, 'length'))) return false;
  if (t(now, 'range') && !within(t(old, 'range'), t(now, 'range'))) return false;
  if (t(now, 'pattern') && t(now, 'pattern') !== t(old, 'pattern')) return false;
  if ((t(now, 'timestampFormat') ?? null) !== (t(old, 'timestampFormat') ?? null)) return false;
  return true;
}

// assemble's shapes, once for each model
const assembledCache = new WeakMap();
const assembled = (ast) => {
  if (!assembledCache.has(ast)) assembledCache.set(ast, assemble(ast));
  return assembledCache.get(ast);
};

const name = (id) => id.split('#')[1].split('$')[0];
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The model as Smithy's assembler sees it: `apply` traits merged into their shapes and members, and each shape's
 * mixins flattened into its members and traits (a mixin's localTraits, and the mixin trait itself, stay with it).
 */
export function assemble(ast) {
  const raw = ast.shapes ?? {};
  const shapes = {};
  for (const [id, s] of Object.entries(raw)) {
    if (s.type === 'apply') continue;
    shapes[id] = structuredClone(s);
  }
  // An apply reaches a shape, or a member it declares, before mixins are flattened (so a mixin's own member carries
  // it to every structure using the mixin), and a member a structure inherits from a mixin afterwards (its own copy)
  const pending = [];
  const applyTo = (id, traits) => {
    const [shapeId, member] = id.split('$');
    const target = shapes[shapeId];
    const holder = target && (member ? memberMap(target)?.[member] : target);
    if (holder) holder.traits = { ...(holder.traits ?? {}), ...traits };
    return !!holder;
  };
  for (const [id, s] of Object.entries(raw)) if (s.type === 'apply' && !applyTo(id, s.traits)) pending.push([id, s.traits]);
  const done = new Set();
  const flatten = (id) => {
    const s = shapes[id];
    if (!s || done.has(id)) return s;
    done.add(id);
    if (!s.mixins?.length) return s;
    let members = {};
    let traits = {};
    for (const { target } of s.mixins) {
      const m = flatten(target);
      if (!m) continue;
      members = { ...members, ...structuredClone(m.members ?? {}) };
      const local = new Set(['smithy.api#mixin', ...(m.traits?.['smithy.api#mixin']?.localTraits ?? [])]);
      for (const [t, v] of Object.entries(m.traits ?? {})) if (!local.has(t)) traits[t] = v;
    }
    // A member the shape declares itself keeps the mixin's traits it does not override
    for (const [n, own] of Object.entries(s.members ?? {})) members[n] = members[n] ? { ...members[n], ...own, traits: { ...(members[n].traits ?? {}), ...(own.traits ?? {}) } } : own;
    s.members = members;
    s.traits = { ...traits, ...(s.traits ?? {}) };
    return s;
  };
  for (const id of Object.keys(shapes)) flatten(id);
  for (const [id, traits] of pending) applyTo(id, traits);
  return shapes;
}

/** A shape's members by name: a structure's, union's or enum's `members`, a list's `member`, a map's `key` and `value`. */
function memberMap(s) {
  if (s.type === 'list' || s.type === 'set') return s.member ? { member: s.member } : {};
  if (s.type === 'map') return { ...(s.key ? { key: s.key } : {}), ...(s.value ? { value: s.value } : {}) };
  return s.members ?? null;
}

/** Every operation the service contains, through its resources (Smithy's TopDownIndex). */
export function containedOperations(shapes) {
  const ops = new Set();
  const service = shapes[SERVICE];
  if (!service) return ops;
  const seen = new Set();
  const resource = (id) => {
    if (seen.has(id)) return;
    seen.add(id);
    const r = shapes[id];
    if (!r) return;
    for (const k of ['create', 'put', 'read', 'update', 'delete', 'list']) if (r[k]) ops.add(r[k].target);
    for (const k of ['operations', 'collectionOperations']) for (const o of r[k] ?? []) ops.add(o.target);
    for (const x of r.resources ?? []) resource(x.target);
  };
  for (const o of service.operations ?? []) ops.add(o.target);
  for (const r of service.resources ?? []) resource(r.target);
  return new Set([...ops].filter((id) => shapes[id]?.type === 'operation'));
}

/** The shapes one shape points at: its members' targets, an operation's input, output and errors, its mixins, and every shape id a trait's value names. */
function neighbours(shapes, s) {
  const out = [];
  for (const m of Object.values(memberMap(s) ?? {})) {
    out.push(m.target);
    traitIds(shapes, m.traits, out);
  }
  if (s.type === 'operation') {
    if (s.input) out.push(s.input.target);
    if (s.output) out.push(s.output.target);
    for (const e of s.errors ?? []) out.push(e.target);
  }
  for (const m of s.mixins ?? []) out.push(m.target);
  traitIds(shapes, s.traits, out);
  return out;
}
function traitIds(shapes, traits, out) {
  const visit = (v) => {
    if (typeof v === 'string') {
      if (v.includes('#') && shapes[v]) out.push(v);
    } else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  for (const [t, v] of Object.entries(traits ?? {})) if (t !== 'smithy.api#documentation' && t !== 'smithy.api#examples') visit(v);
}

const stability = (op) => op.traits?.[STABILITY] ?? 'beta';
const widest = (a, b) => (a === 'ga' || b === 'ga' ? 'ga' : a ?? b);

/** Every shape a GA or beta operation reaches, with the widest stability reaching it; the service's errors too. */
export function surface(shapes) {
  const reach = new Map();
  const walk = (start, level) => {
    const stack = [start];
    const seen = new Set();
    while (stack.length) {
      const id = stack.pop();
      if (seen.has(id) || !shapes[id]) continue;
      seen.add(id);
      reach.set(id, widest(reach.get(id), level));
      stack.push(...neighbours(shapes, shapes[id]));
    }
  };
  let widestPublic = null;
  for (const id of containedOperations(shapes)) {
    const level = stability(shapes[id]);
    if (level !== 'ga' && level !== 'beta') continue;
    widestPublic = widest(widestPublic, level);
    walk(id, level);
  }
  if (widestPublic) for (const e of shapes[SERVICE]?.errors ?? []) walk(e.target, widestPublic);
  return reach;
}

const describe = (m) => ({ target: name(m.target), required: !!m.traits?.['smithy.api#required'] });
const withStatus = (change, shape) => (shape?.traits?.['smithy.api#httpError'] !== undefined ? { ...change, status: shape.traits['smithy.api#httpError'] } : change);
const enumValues = (s) => new Set(Object.entries(s.members ?? {}).map(([n, m]) => m.traits?.['smithy.api#enumValue'] ?? n));
const errorCodes = (s) => new Set(s.traits?.[ERROR_CODES] ?? []);

/** The public API's changes from `oldAst` to `newAst` (either may be null: no model is no surface), sorted as CaitlynChanges sorts them. */
export function modelChanges(oldAst, newAst) {
  const before = oldAst ? assemble(oldAst) : {};
  const after = newAst ? assemble(newAst) : {};
  const oldSurface = surface(before);
  const newSurface = surface(after);
  const changes = [];
  const change = (kind, surf, fields) => changes.push({ kind, surface: surf, ...fields });

  const publicOps = (shapes, surf) => [...containedOperations(shapes)].filter((id) => surf.has(id));
  for (const id of [...new Set([...publicOps(before, oldSurface), ...publicOps(after, newSurface)])].sort(cmp)) {
    const was = oldSurface.has(id) ? before[id] : null;
    const now = newSurface.has(id) ? after[id] : null;
    const surf = widest(oldSurface.get(id), newSurface.get(id));
    if (!was) {
      change('operationAdded', surf, { operation: name(id), stability: stability(now), title: now.traits?.['smithy.api#title'] ?? '' });
      continue;
    }
    if (!now) {
      change('operationRemoved', surf, { operation: name(id), stability: stability(was) });
      continue;
    }
    if (stability(was) !== stability(now)) change('stabilityChanged', surf, { operation: name(id), from: stability(was), to: stability(now) });
    const eb = new Set((was.errors ?? []).map((e) => e.target));
    const ea = new Set((now.errors ?? []).map((e) => e.target));
    for (const e of [...ea].sort(cmp)) if (!eb.has(e)) changes.push(withStatus({ kind: 'errorAdded', surface: surf, operation: name(id), error: name(e) }, after[e]));
    for (const e of [...eb].sort(cmp)) if (!ea.has(e)) changes.push(withStatus({ kind: 'errorRemoved', surface: surf, operation: name(id), error: name(e) }, before[e]));
  }

  for (const id of [...new Set([...oldSurface.keys(), ...newSurface.keys()])].sort(cmp)) {
    const was = oldSurface.has(id) ? before[id] : null;
    const now = newSurface.has(id) ? after[id] : null;
    if (!was || !now || was.type === 'operation') continue;
    const surf = widest(oldSurface.get(id), newSurface.get(id));
    const cb = errorCodes(was);
    const ca = errorCodes(now);
    for (const code of [...ca].sort(cmp)) if (!cb.has(code)) changes.push(withStatus({ kind: 'errorCodeAdded', surface: surf, error: name(id), code }, now));
    for (const code of [...cb].sort(cmp)) if (!ca.has(code)) changes.push(withStatus({ kind: 'errorCodeRemoved', surface: surf, error: name(id), code }, was));
    if (was.type === 'enum' && now.type === 'enum') {
      const vb = enumValues(was);
      const va = enumValues(now);
      for (const value of [...va].sort(cmp)) if (!vb.has(value)) change('enumValueAdded', surf, { shape: name(id), value });
      for (const value of [...vb].sort(cmp)) if (!va.has(value)) change('enumValueRemoved', surf, { shape: name(id), value });
      continue;
    }
    if (!['structure', 'union', 'list', 'set', 'map'].includes(was.type)) continue;
    const mb = memberMap(was) ?? {};
    const ma = memberMap(now) ?? {};
    for (const n of [...new Set([...Object.keys(mb), ...Object.keys(ma)])].sort(cmp)) {
      if (!mb[n]) change('memberAdded', surf, { shape: name(id), member: n, ...describe(ma[n]) });
      else if (!ma[n]) change('memberRemoved', surf, { shape: name(id), member: n, ...describe(mb[n]) });
      else {
        const from = describe(mb[n]);
        const to = describe(ma[n]);
        if (from.target !== to.target || from.required !== to.required) change('memberChanged', surf, { shape: name(id), member: n, from, to });
      }
    }
  }

  const serviceBefore = before[SERVICE];
  if (after[SERVICE] && serviceBefore) {
    const surf = [...newSurface.values(), ...oldSurface.values()].includes('ga') ? 'ga' : 'beta';
    const eb = new Set((serviceBefore.errors ?? []).map((e) => e.target));
    const ea = new Set((after[SERVICE].errors ?? []).map((e) => e.target));
    for (const e of [...ea].sort(cmp)) if (!eb.has(e)) changes.push(withStatus({ kind: 'serviceErrorAdded', surface: surf, error: name(e) }, after[e]));
    for (const e of [...eb].sort(cmp)) if (!ea.has(e)) changes.push(withStatus({ kind: 'serviceErrorRemoved', surface: surf, error: name(e) }, before[e]));
  }

  const key = (c) => [KIND_ORDER.indexOf(c.kind), c.operation ?? '', c.shape ?? '', c.member ?? '', c.value ?? '', c.error ?? '', c.code ?? ''];
  return changes.sort((a, b) => {
    const x = key(a);
    const y = key(b);
    for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return i === 0 ? x[i] - y[i] : cmp(x[i], y[i]);
    return 0;
  });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const [oldFile, newFile] = process.argv.slice(2);
  if (!oldFile || !newFile) {
    console.error('Usage: node scripts/model-diff.mjs OLD_MODEL.json NEW_MODEL.json');
    process.exit(2);
  }
  const read = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
  process.stdout.write(`${JSON.stringify(modelChanges(read(oldFile), read(newFile)), null, 2)}\n`);
}
