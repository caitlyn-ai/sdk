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

/**
 * Runs the cases whose name contains `only` (every case without it), from the `from`th of them. A case that times out
 * may leave work running, such as a watch that reconnects, whose requests would reach the mock during later cases and
 * be counted there. So a run stops after a timed-out case and says where to carry on: the runner loads the page again,
 * which ends everything the case left behind, and calls run() from `next`.
 */
async function run(only?: string, from = 0): Promise<{ results: Result[]; next?: number }> {
  const results: Result[] = [];
  const chosen = cases.filter((x) => !only || x.name.includes(only));
  for (const h of hooks.before) await h();
  for (let i = from; i < chosen.length; i++) {
    const c = chosen[i]!;
    const t0 = performance.now();
    if (c.skip) {
      results.push({ name: c.name, status: 'skipped', ms: 0, message: c.skip });
      continue;
    }
    let timedOut = false;
    try {
      for (const h of hooks.beforeEach) await h();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const limit = new Promise((_, reject) => (timer = setTimeout(() => ((timedOut = true), reject(new Error(`timed out after ${TIMEOUT_MS} ms`))), TIMEOUT_MS)));
      await Promise.race([c.fn(), limit]).finally(() => clearTimeout(timer));
      results.push({ name: c.name, status: 'passed', ms: performance.now() - t0 });
    } catch (err) {
      results.push({ name: c.name, status: 'failed', ms: performance.now() - t0, message: describe(err) });
    }
    console.log(`${results.at(-1)!.status} ${c.name}`);
    if (timedOut && i + 1 < chosen.length) return { results, next: i + 1 };
  }
  for (const h of hooks.after) await h();
  return { results };
}

(globalThis as { __caitlynConformance?: unknown }).__caitlynConformance = { run, count: () => cases.length };
