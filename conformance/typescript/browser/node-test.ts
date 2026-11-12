// node:test for a browser page: the browser conformance run (typescript/scripts/conformance-browser.mjs) bundles
// the harness with this in its place, and calls window.__caitlynConformance.run() from Playwright.
type Fn = () => unknown;
interface Case {
  name: string;
  fn: Fn;
  skip?: string;
}
export interface Result {
  name: string;
  status: 'passed' | 'failed' | 'skipped';
  ms: number;
  message?: string;
}

const cases: Case[] = [];
const hooks: Record<'before' | 'after' | 'beforeEach', Fn[]> = { before: [], after: [], beforeEach: [] };
const TIMEOUT_MS = 60_000;

export function test(name: string, a: Fn | { skip?: string }, b?: Fn): void {
  if (typeof a === 'function') cases.push({ name, fn: a });
  else cases.push({ name, fn: b!, skip: a.skip });
}
export const before = (fn: Fn) => void hooks.before.push(fn);
export const after = (fn: Fn) => void hooks.after.push(fn);
export const beforeEach = (fn: Fn) => void hooks.beforeEach.push(fn);

const describe = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}` : String(err));

/** Runs every case, or those whose name contains `only`. */
async function run(only?: string): Promise<Result[]> {
  const results: Result[] = [];
  for (const h of hooks.before) await h();
  for (const c of cases.filter((x) => !only || x.name.includes(only))) {
    const t0 = performance.now();
    if (c.skip) {
      results.push({ name: c.name, status: 'skipped', ms: 0, message: c.skip });
      continue;
    }
    try {
      for (const h of hooks.beforeEach) await h();
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([c.fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS} ms`)), TIMEOUT_MS)))]).finally(() => clearTimeout(timer));
      results.push({ name: c.name, status: 'passed', ms: performance.now() - t0 });
    } catch (err) {
      results.push({ name: c.name, status: 'failed', ms: performance.now() - t0, message: describe(err) });
    }
    console.log(`${results.at(-1)!.status} ${c.name}`);
  }
  for (const h of hooks.after) await h();
  return results;
}

(globalThis as { __caitlynConformance?: unknown }).__caitlynConformance = { run, count: () => cases.length };
