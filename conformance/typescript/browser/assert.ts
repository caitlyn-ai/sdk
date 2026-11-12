// node:assert/strict for a browser page: the assertions the conformance harness uses, with Node's strict semantics.
export class AssertionError extends Error {
  override name = 'AssertionError';
}

const show = (v: unknown) => {
  try {
    return typeof v === 'string' ? JSON.stringify(v) : (JSON.stringify(v) ?? String(v));
  } catch {
    return String(v);
  }
};
const fail = (message?: string | Error, fallback = 'Failed'): never => {
  if (message instanceof Error) throw message;
  throw new AssertionError(message ?? fallback);
};

function deepEqual(a: unknown, b: unknown, seen = new WeakMap<object, unknown>()): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  if (seen.get(a) === b) return true;
  seen.set(a, b);
  if (a instanceof Date) return a.getTime() === (b as Date).getTime();
  if (a instanceof RegExp) return String(a) === String(b);
  if (a instanceof Map) return a.size === (b as Map<unknown, unknown>).size && [...a].every(([k, v]) => (b as Map<unknown, unknown>).has(k) && deepEqual(v, (b as Map<unknown, unknown>).get(k), seen));
  if (a instanceof Set) return a.size === (b as Set<unknown>).size && [...a].every((v) => (b as Set<unknown>).has(v));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], seen));
}

function matches(err: unknown, expected: unknown, message?: string): void {
  if (expected === undefined) return;
  if (expected instanceof RegExp) {
    if (!expected.test(String((err as Error)?.message ?? err))) fail(message, `The error does not match ${expected}: ${String(err)}`);
  } else if (typeof expected === 'function' && expected.prototype !== undefined && err instanceof (expected as new () => unknown)) {
    return;
  } else if (typeof expected === 'function') {
    if ((expected as (e: unknown) => unknown)(err) !== true) fail(message, `The validation function did not return true for ${String(err)}`);
  } else if (typeof expected === 'object' && expected !== null) {
    for (const [k, v] of Object.entries(expected)) if (!deepEqual((err as Record<string, unknown>)[k], v)) fail(message, `The error's ${k} is ${show((err as Record<string, unknown>)[k])}, not ${show(v)}`);
  }
}

const assert = {
  AssertionError,
  ok(value: unknown, message?: string | Error) {
    if (!value) fail(message, `The expression evaluated to a falsy value: ${show(value)}`);
  },
  equal(actual: unknown, expected: unknown, message?: string | Error) {
    if (!Object.is(actual, expected)) fail(message, `Expected values to be strictly equal: ${show(actual)} !== ${show(expected)}`);
  },
  notEqual(actual: unknown, expected: unknown, message?: string | Error) {
    if (Object.is(actual, expected)) fail(message, `Expected "actual" to be strictly unequal to: ${show(expected)}`);
  },
  deepEqual(actual: unknown, expected: unknown, message?: string | Error) {
    if (!deepEqual(actual, expected)) fail(message, `Expected values to be strictly deep-equal: ${show(actual)} vs ${show(expected)}`);
  },
  match(actual: string, re: RegExp, message?: string | Error) {
    if (typeof actual !== 'string' || !re.test(actual)) fail(message, `The input did not match ${re}: ${show(actual)}`);
  },
  fail(message?: string | Error): never {
    return fail(message);
  },
  throws(fn: () => unknown, expected?: unknown, message?: string) {
    try {
      fn();
    } catch (err) {
      return matches(err, expected, message);
    }
    fail(message, 'Missing expected exception.');
  },
  async rejects(p: Promise<unknown> | (() => Promise<unknown>), expected?: unknown, message?: string) {
    try {
      await (typeof p === 'function' ? p() : p);
    } catch (err) {
      return matches(err, expected, message);
    }
    fail(message, 'Missing expected rejection.');
  },
};

export default assert;
