// The @range check (PROTOCOL.md 3): before sending, every SDK refuses a value outside its member's declared range, as
// the server would refuse it, so a call that cannot succeed costs no request. The rules come from the model
// (codegen/model-support Ranges), one string per rule: `<Operation>|query|<parameter>|<min>|<max>` or
// `<Operation>|body|<JSON Pointer pattern>|<min>|<max>`, where `*` in a pattern stands for any list item or map value
// and an empty bound is no bound. The check reads the request as it will be sent, so its field errors name the
// value as the server's would: `parameter` for a query parameter, `pointer` for a body value.

/** One field error, as a 400 VALIDATION_FAILED's `errors` carries it. */
export interface RangeProblem {
  parameter?: string;
  pointer?: string;
  code: 'VALIDATION_FAILED';
  detail: string;
}

interface Rule {
  where: 'query' | 'body';
  path: string;
  min?: number;
  max?: number;
}

/** The rules by operation, from the generated `Operation|where|path|min|max` strings. */
export function rangeRules(entries: readonly string[]): Map<string, Rule[]> {
  const out = new Map<string, Rule[]>();
  for (const e of entries) {
    const [op, where, path, min, max] = e.split('|') as [string, 'query' | 'body', string, string, string];
    const rule: Rule = { where, path, ...(min ? { min: Number(min) } : {}), ...(max ? { max: Number(max) } : {}) };
    (out.get(op) ?? out.set(op, []).get(op)!).push(rule);
  }
  return out;
}

const bounds = (r: Rule): string =>
  r.min !== undefined && r.max !== undefined ? `between ${r.min} and ${r.max}` : r.min !== undefined ? `at least ${r.min}` : `at most ${r.max}`;
const outside = (r: Rule, v: number): boolean => (r.min !== undefined && v < r.min) || (r.max !== undefined && v > r.max);
const escape = (s: string): string => s.replace(/~/g, '~0').replace(/\//g, '~1');

/** Every value of `query` and `body` outside its rule's range. */
export function rangeProblems(rules: readonly Rule[], query: Record<string, unknown>, body: unknown): RangeProblem[] {
  const problems: RangeProblem[] = [];
  for (const r of rules) {
    if (r.where === 'query') {
      const raw = query[r.path];
      for (const v of Array.isArray(raw) ? raw : raw == null ? [] : [raw]) {
        const n = Number(v);
        if (v !== '' && !Number.isNaN(n) && outside(r, n)) {
          problems.push({ parameter: r.path, code: 'VALIDATION_FAILED', detail: `\`${r.path}\` must be ${bounds(r)}; it is ${v}.` });
        }
      }
      continue;
    }
    // The values the pattern reaches, with the pointer each is at
    let at: [string, unknown][] = [['', body]];
    for (const seg of r.path.split('/').slice(1)) {
      const next: [string, unknown][] = [];
      for (const [p, v] of at) {
        if (v === null || typeof v !== 'object') continue;
        if (seg === '*') for (const [k, c] of Object.entries(v)) next.push([`${p}/${escape(k)}`, c]);
        else if (Object.prototype.hasOwnProperty.call(v, seg)) next.push([`${p}/${escape(seg)}`, (v as Record<string, unknown>)[seg]]);
      }
      at = next;
    }
    for (const [pointer, v] of at) {
      if (typeof v === 'number' && outside(r, v)) {
        problems.push({ pointer, code: 'VALIDATION_FAILED', detail: `\`${pointer}\` must be ${bounds(r)}; it is ${v}.` });
      }
    }
  }
  return problems;
}
