// semantic-release's commit analyzer (.releaserc.yml, in place of @semantic-release/commit-analyzer): a release
// happens if and only if a commit since the last release changed what a package ships (scripts/package-inputs.mjs).
//   - Only the commits that changed a package input count, so a `fix(docs)` or a `feat` that only touches tooling
//     makes no release, and nor does a model:main `docs(model)` commit.
//   - Their types set the bump as the angular preset with this repository's rules did: a breaking change (`!` before
//     the colon, or a BREAKING CHANGE footer) is minor before 1.0 and major after, feat is minor, fix, perf and revert
//     are patch.
//   - A package change under any other type (chore, ci, build, …) is still a release, a patch: changes:check refuses
//     such a title, so this only happens when a commit reaches main without a merge request.
// A merge commit changes nothing of its own: its changes are its parents' commits, which are counted.
import { commitFiles, touched } from './package-inputs.mjs';
import { parseCommit } from './release-notes.mjs';

const ORDER = [null, 'patch', 'minor', 'major'];

/** The bump one commit asks for, from its message: 'major', 'minor', 'patch' or null; `major0` is the version's major. */
export function commitBump(message, major0 = 0) {
  const [subject, ...rest] = message.split('\n');
  const c = parseCommit({ subject, body: rest.join('\n') });
  if (!c) return null;
  if (c.breaking) return major0 === 0 ? 'minor' : 'major';
  if (c.type === 'feat') return 'minor';
  if (['fix', 'perf', 'revert'].includes(c.type)) return 'patch';
  return null;
}

/**
 * The release type for `commits` ([{ hash, message }]), or null: the highest bump among the commits that changed a
 * package input, and at least a patch when any did. `filesOf` gives a commit's files; `lastVersion` the last release.
 * Returns { type, counted: [{ hash, subject, packages }], skipped: [{ hash, subject }] } so the log can say why.
 */
export function analyze(commits, { filesOf = commitFiles, lastVersion = null } = {}) {
  const major0 = Number(String(lastVersion ?? '0').split('.')[0]) || 0;
  const counted = [];
  const skipped = [];
  let type = null;
  for (const c of commits) {
    const subject = c.message.split('\n')[0];
    const packages = touched(filesOf(c.hash)).map((p) => p.name);
    if (!packages.length) {
      skipped.push({ hash: c.hash, subject });
      continue;
    }
    counted.push({ hash: c.hash, subject, packages });
    const bump = commitBump(c.message, major0) ?? 'patch';
    if (ORDER.indexOf(bump) > ORDER.indexOf(type)) type = bump;
  }
  return { type, counted, skipped };
}

/** The semantic-release step. */
export async function analyzeCommits(pluginConfig, context) {
  const { commits, lastRelease, logger } = context;
  const { type, counted, skipped } = analyze(commits, { lastVersion: lastRelease?.version });
  for (const c of counted) logger.log(`Counts: ${c.hash.slice(0, 8)} ${c.subject} (changes ${c.packages.join(', ')})`);
  if (skipped.length) logger.log(`Changes no package, so not counted: ${skipped.length} commit(s), such as ${skipped.slice(0, 3).map((c) => `${c.hash.slice(0, 8)} ${c.subject}`).join('; ')}`);
  logger.log(type ? `Release type: ${type}` : 'No package input changed since the last release: no release.');
  return type;
}
