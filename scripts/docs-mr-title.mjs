// The public-wording check (scripts/docs-wording.mjs) over a merge request's title. Merge requests are squashed into
// a commit with the title as its message, semantic-release turns a releasing one (feat, fix, perf, revert, or any
// type with !) into a line of CHANGELOG.md, and the developer site publishes that file as its Changelog
// (scripts/docs-changelog.mjs) with the scope as a label. So a title that would put something internal on the site
// fails here, while it can still be edited, rather than the docs build after the release.
//   node scripts/docs-mr-title.mjs "<title>"     (CI: the docs:mr-title job passes $CI_MERGE_REQUEST_TITLE)
import { lineProblems } from './docs-wording.mjs';

const RELEASING = ['feat', 'fix', 'perf', 'revert'];

/** The parts of a conventional-commit title: type, scope, breaking, subject (null when it is not one). */
export function parseTitle(title) {
  // A draft's marker goes before it merges, so it is not part of the title that releases
  const m = /^(\w+)(?:\(([^)]*)\))?(!)?: (.*)$/.exec(title.trim().replace(/^(?:\[?(?:Draft|WIP)\]?:?\s*|\(Draft\)\s*)/i, ''));
  return m ? { type: m[1], scope: m[2] ?? null, breaking: !!m[3], subject: m[4] } : null;
}

/** What the title would publish that the wording check refuses, as messages naming the rule; empty when fine. */
export function titleProblems(title) {
  const t = parseTitle(title);
  if (!t) return [];
  if (!RELEASING.includes(t.type) && !t.breaking) return [];
  return [
    ...lineProblems(t.subject).map((p) => `the title ${p}`),
    ...(t.scope ? lineProblems(t.scope).map((p) => `the scope ${p}`) : []),
  ];
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const title = process.argv[2] ?? '';
  const problems = titleProblems(title);
  if (problems.length) {
    console.error(`This merge request's title becomes a line of the public Changelog on build.caitlyn.ai when it releases, and it ${problems.length === 1 ? 'breaks a wording rule' : 'breaks wording rules'}:`);
    for (const p of problems) console.error(`  - ${p}`);
    console.error('Reword the title (the subject after "type(scope):") so it says what changed for someone using the SDKs, then rerun this job.');
    process.exit(1);
  }
  console.log(`docs-mr-title: "${title}" is fine for the Changelog`);
}
