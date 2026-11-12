// Reads smithy-typescript's static schemas (the tuples in the generated schemas_0.ts) for the protocol
// (../protocol.ts), in place of @smithy/core's NormalizedSchema. It understands the same encoding:
//   a number                       a simple type: 0 string, 1 number, 2 boolean, 4-7 timestamp, 15 document,
//                                  17 big integer, 19 big decimal, 21 blob, 42 streaming blob; 64|x a list of x,
//                                  128|x a map of x
//   [0, ns, name, traits, type]    a simple type with traits of its own
//   [1, ns, name, traits, value]   a list;  [2, ns, name, traits, key, value] a map
//   [3 | 4 | -3, ns, name, traits, memberNames, memberTypes, required?]  a structure, a union, an error
//   [type, traits]                 a member: a type with the member's traits
//   () => type                     a type defined later in the file
// Traits are an object, or a number whose bits are httpLabel, idempotent, idempotencyToken, sensitive,
// httpPayload, httpResponseCode, httpQueryParams.

export type Traits = Record<string, any>;

export interface Shape {
  /** The type: its number, or its tuple (never a member wrapper or a function). */
  readonly type: any;
  /** The member's traits over the type's own, as NormalizedSchema.getMergedTraits() gives them. */
  readonly traits: Traits;
}

const BITS = ['httpLabel', 'idempotent', 'idempotencyToken', 'sensitive', 'httpPayload', 'httpResponseCode', 'httpQueryParams'];

export function traitsOf(t: unknown): Traits {
  if (t && typeof t === 'object') return t as Traits;
  const out: Traits = {};
  BITS.forEach((name, i) => ((Number(t) >> i) & 1) === 1 && (out[name] = 1));
  return out;
}

const deref = (r: any) => (typeof r === 'function' ? r() : r);
const cache = new WeakMap<object, Shape>();
const simple: Shape[] = [];

/** The type and merged traits of a schema reference. */
export function shape(ref: any): Shape {
  if (typeof ref === 'number' && simple[ref]) return simple[ref]!;
  if (ref && (typeof ref === 'object' || typeof ref === 'function') && cache.has(ref)) return cache.get(ref)!;
  let type = deref(ref);
  const member: Traits[] = [];
  while (Array.isArray(type) && type.length === 2) {
    member.push(traitsOf(type[1]));
    type = deref(type[0]);
  }
  let own: Traits = Array.isArray(type) ? traitsOf(type[3]) : {};
  if (Array.isArray(type) && type[0] === 0) type = deref(type[4]);
  const traits: Traits = { ...own };
  for (let i = member.length - 1; i >= 0; i--) Object.assign(traits, member[i]);
  const s = { type, traits };
  if (typeof ref === 'number') simple[ref] = s;
  else if (ref && (typeof ref === 'object' || typeof ref === 'function')) cache.set(ref, s);
  return s;
}

const code = (s: Shape) => (typeof s.type === 'number' ? s.type : undefined);
export const isList = (s: Shape) => (typeof s.type === 'number' ? s.type >= 64 && s.type < 128 : s.type?.[0] === 1);
export const isMap = (s: Shape) => (typeof s.type === 'number' ? s.type >= 128 && s.type <= 255 : s.type?.[0] === 2);
export const isStruct = (s: Shape) => Array.isArray(s.type) && (s.type[0] === 3 || s.type[0] === -3 || s.type[0] === 4);
export const isUnion = (s: Shape) => Array.isArray(s.type) && s.type[0] === 4;
export const isString = (s: Shape) => code(s) === 0;
export const isNumber = (s: Shape) => code(s) === 1;
export const isBoolean = (s: Shape) => code(s) === 2;
export const isTimestamp = (s: Shape) => (code(s) ?? -1) >= 4 && (code(s) ?? -1) <= 7;
export const isDocument = (s: Shape) => code(s) === 15;
export const isBlob = (s: Shape) => code(s) === 21 || code(s) === 42;
export const isStreaming = (s: Shape) => !!s.traits.streaming || code(s) === 42;

/** A list's item or a map's value. */
export function valueOf(s: Shape): Shape {
  if (typeof s.type === 'number') return shape(s.type & 0b0011_1111);
  return shape(s.type[3 + s.type[0]]);
}

/** A structure's members, in model order, as [name, shape]. */
export function members(s: Shape): [string, Shape][] {
  if (!isStruct(s)) return [];
  const [, , , , names, types] = s.type as [number, string, string, unknown, string[], unknown[]];
  return names.map((name, i) => [name, shape(types[i])]);
}
