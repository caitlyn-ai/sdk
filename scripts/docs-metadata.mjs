// Page metadata for the developer-docs knowledge base on ask.caitlyn.ai. The knowledge base's custom fields:
//   pageType      string     reference | guide | example | concept | error
//   resources     string[]   the SDK namespaces the page covers (documents, conversations…)
//   integrations  string[]   integrations the page covers (none yet)
//   operations    string[]   the model's operation names (ListDocuments…)
//   sinceVersion  integer    the Caitlyn release the page's content needs, as major×10^12 + minor×10^6 + patch,
//                            so that "since ≤ the reader's version" is a numeric filter
export const PAGE_TYPES = ['reference', 'guide', 'example', 'concept', 'error'];

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

/** Returns the problems with one page's metadata (empty when it is valid). */
export function metadataProblems(m) {
  const problems = [];
  if (!PAGE_TYPES.includes(m.pageType)) problems.push(`pageType "${m.pageType}" is not one of ${PAGE_TYPES.join(', ')}`);
  for (const k of ['resources', 'integrations', 'operations']) {
    if (!Array.isArray(m[k]) || m[k].some((v) => typeof v !== 'string')) problems.push(`${k} must be a list of strings`);
  }
  if (!Number.isSafeInteger(m.sinceVersion) || m.sinceVersion < 0) problems.push('sinceVersion must be a whole number');
  const extra = Object.keys(m).filter((k) => !['pageType', 'resources', 'integrations', 'operations', 'sinceVersion'].includes(k));
  if (extra.length) problems.push(`unknown fields: ${extra.join(', ')}`);
  return problems;
}
