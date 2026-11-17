// The public-wording check: nothing on the developer site points readers at how Caitlyn is built (the protocol
// document, the model and its traits, the generators, CI, repository paths, merge requests, internal hosts, release
// plans, or areas and tools only Caitlyn's own staff have). scripts/docs-build.mjs runs it over every page and over
// the OpenAPI document the site publishes at /api/openapi.json; docs/site/test/api-reference.test.mjs runs it over that
// document too, and docs/site/test/wording.test.mjs over every hand-written page. Prose is checked outside code; hosts
// and merge request links are checked everywhere.
export const INTERNAL_PROSE = [
  [/PROTOCOL\.md/, 'PROTOCOL.md'],
  [/\bsmithy\b/i, 'Smithy'],
  [/\bconformance\b/i, 'the conformance suites'],
  [/`@[a-z][A-Za-z]*`/, 'a model trait'],
  [/\bcode owners\b/i, 'code owners'],
  [/\b(?:codegen|generators?)\b/i, 'the generators'],
  [/\bexamples:live\b/, 'a CI job of this repository'],
  [/(?:^|[\s(`])(?:scripts|codegen|conformance|model)\/[\w.-]/, 'a repository path'],
  [/\bnext release\b|\bnot in a release\b|\bno Caitlyn release\b|\breleased yet\b/i, 'release plans'],
  // Areas, permissions and tools only Caitlyn's own staff have (Caitlyn Support's tooling); a customer never sees them
  [
    new RegExp(
      [
        String.raw`\*\*Developer tools\*\*`,
        String.raw`\bDeveloper tools area\b`,
        String.raw`\bdeveloper[-_]tools\b`,
        String.raw`\bswitch(?:es|ing)? off document access control\b`,
        String.raw`\b(?:support|operator|staff|internal)[- ]only\b`,
        String.raw`\b(?:support|operator) (?:console|tooling|tools)\b`,
        String.raw`\bbreak[- ]?glass\b`,
      ].join('|'),
      'i',
    ),
    'an internal-only area or tool',
  ],
];
export const INTERNAL_ANYWHERE = [
  [/merge_requests\/\d+|\b[\w-]+![0-9]{2,}\b/, 'a merge request'],
  [/\bgit\.customd\.com\b|\bcustomd\.com\b|\blndo\.site\b|\bmr-\d+\.labs\b/i, 'an internal host'],
];

/** The problems in one line of prose (inline code is skipped, apart from a model trait written as code). */
export function lineProblems(line, { prose = true } = {}) {
  const out = [];
  const text = prose ? line.replace(/`[^`]*`/g, (c) => (/^`@[a-z]/.test(c) ? c : '``')) : '';
  for (const [re, what] of INTERNAL_PROSE) if (re.test(text)) out.push(`mentions ${what}: "${line.trim().slice(0, 100)}"`);
  for (const [re, what] of INTERNAL_ANYWHERE) if (re.test(line)) out.push(`names ${what}: "${line.trim().slice(0, 100)}"`);
  return out;
}

/** The problems in a JSON document: every key and string, as `where: problem`. Code samples are programs, so only
 * the hosts and merge request links are checked in them. */
export function documentProblems(value, where = '', { code = false } = {}) {
  if (typeof value === 'string') return lineProblems(value, { prose: !code }).map((p) => `${where}: ${p}`);
  if (Array.isArray(value)) return value.flatMap((v, i) => documentProblems(v, `${where}[${i}]`, { code }));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([k, v]) => [...lineProblems(k).map((p) => `${where} key: ${p}`), ...documentProblems(v, `${where}/${k}`, { code: code || k === 'x-codeSamples' })]);
  }
  return [];
}
