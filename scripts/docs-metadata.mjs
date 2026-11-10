// Page metadata for the developer-docs knowledge base on ask.caitlyn.ai, written into each Markdown page's
// front matter. Markdown ingestion (caitlyn-data-ingestion !313) reads front-matter keys that equal a
// custom field's key, validates each value against the field's type and options, and stores it, so the
// model never infers those fields. Valid values are applied again on every ingest; a field an operator has
// locked keeps its value. An invalid value is skipped and recorded as a partial failure, so the docs build
// validates every page here first (metadataProblems) and fails rather than publish one.
//
// Keys match the field keys exactly, case included. Option fields take the option KEY, not its label.
//   pageType      one option
//   resources     list of options
//   integrations  list of options
//   operations    list of text: the model's operation names (ListDocuments…)
//   sinceVersion  whole number: the release the content needs, as major×10^12 + minor×10^6 + patch, so that
//                 "since ≤ the reader's version" is a numeric filter
export const OPTIONS = {
  pageType: ['guide', 'concept', 'reference', 'error', 'sdk', 'cli', 'migration', 'changelog'],
  resources: [
    'agent', 'version', 'conversation', 'knowledge-base', 'document', 'upload', 'operation', 'organisation',
    'policy-review', 'unattended-run', 'workspace',
  ],
  integrations: [
    'microsoft-entra-id', 'google-workspace', 'auth0', 'mcp-server', 'mcp-connectors', 'amazon-connect',
    'live-avatar', 'embed-widget', 'agentcore', 'workload-identity',
  ],
};
export const FIELDS = ['pageType', 'sinceVersion', 'resources', 'integrations', 'operations'];

/** "5.115.0" -> 5000115000000. Each part must be below 10^6. */
export function sinceVersion(version) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  if (!m) throw new Error(`sinceVersion: "${version}" is not a release number`);
  const [major, minor, patch] = m.slice(1).map(Number);
  if (minor >= 1e6 || patch >= 1e6) throw new Error(`sinceVersion: "${version}" has a part of 10^6 or more`);
  const n = major * 1e12 + minor * 1e6 + patch;
  if (!Number.isSafeInteger(n)) throw new Error(`sinceVersion: "${version}" is too large`);
  return n;
}

const list = (v) => (Array.isArray(v) ? v : v === undefined ? [] : [v]); // a single value counts as a list of one

/** The problems with one page's metadata, as ingestion would judge it (empty when every value is valid). */
export function metadataProblems(m) {
  const problems = [];
  const unknown = Object.keys(m).filter((k) => !FIELDS.includes(k));
  if (unknown.length) problems.push(`not knowledge-base fields (check the key's case): ${unknown.join(', ')}`);
  if (!OPTIONS.pageType.includes(m.pageType)) problems.push(`pageType "${m.pageType}" is not one of ${OPTIONS.pageType.join(', ')}`);
  for (const field of ['resources', 'integrations']) {
    for (const v of list(m[field])) if (!OPTIONS[field].includes(v)) problems.push(`${field}: "${v}" is not an option key`);
  }
  for (const v of list(m.operations)) if (typeof v !== 'string' || !/^[A-Z][A-Za-z0-9]*$/.test(v)) problems.push(`operations: "${v}" is not an operation name`);
  const since = typeof m.sinceVersion === 'string' && /^\d+$/.test(m.sinceVersion) ? Number(m.sinceVersion) : m.sinceVersion;
  if (!Number.isSafeInteger(since) || since < 0) problems.push(`sinceVersion "${m.sinceVersion}" is not a whole number`);
  return problems;
}

/** YAML front matter for the fields (values are plain keys and numbers, so no quoting is needed). */
export function frontMatter(m) {
  const lines = ['---'];
  for (const k of FIELDS) {
    if (m[k] === undefined) continue;
    if (Array.isArray(m[k])) lines.push(m[k].length ? `${k}:\n${m[k].map((v) => `  - ${v}`).join('\n')}` : `${k}: []`);
    else lines.push(`${k}: ${m[k]}`);
  }
  return `${lines.join('\n')}\n---\n`;
}

/** Reads front matter written by frontMatter() (or hand-written in the same subset of YAML). */
export function parseFrontMatter(markdown) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(markdown);
  if (!m) return null;
  const out = {};
  let key = null;
  for (const line of m[1].split('\n')) {
    const item = /^\s+-\s+(.*)$/.exec(line);
    if (item && key) {
      out[key] = [...list(out[key]), item[1].trim()];
      continue;
    }
    const kv = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    if (!kv) continue;
    key = kv[1];
    const v = kv[2].trim();
    out[key] = v === '' ? [] : v === '[]' ? [] : /^-?\d+$/.test(v) ? Number(v) : v;
  }
  return out;
}
