// Which published models' changes.json scripts/model-pull.sh keeps in model/changes/, one file per version, for the
// developer site's Changelog (scripts/docs-changelog.mjs). The app's publish job uploads a changes.json beside each
// release's model.json: what changed in the public API since the release before it. A pull keeps every published
// version's after the one the snapshot was locked to, up to and including the one it pulls, so a release the SDKs
// skipped still has its entry; the files accumulate across pulls.
//
//   node scripts/model-changes.mjs range LISTING PREVIOUS NEW CHANGES_DIR
//
// LISTING is the registry's package listing pages, concatenated as one JSON array (GitLab's
// GET /projects/:id/packages, each entry { name, version }); PREVIOUS is the lock's version before the pull (empty
// for a local build); NEW is the version being pulled. Prints the versions to fetch, oldest first, one a line.
import fs from 'node:fs';

/** Compares two release numbers (5.9.0 < 5.10.0). */
export const compareVersions = (a, b) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
};
const RELEASE = /^\d+\.\d+\.\d+$/;

/** The versions model/changes/ already holds (its <version>.json files). */
export function keptVersions(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).map((f) => /^(\d+\.\d+\.\d+)\.json$/.exec(f)?.[1]).filter(Boolean).sort(compareVersions);
}

/**
 * The versions whose changes.json a pull of `next` keeps, oldest first: every published version of `name` above the
 * lower bound and up to `next`. The lower bound is the previous lock's version; a local build's lock has none, so it
 * is the newest version already kept; with neither, only `next` is kept.
 */
export function versionsToKeep(listing, { name = 'caitlyn-v3-model', previous = null, kept = [], next }) {
  if (!RELEASE.test(next ?? '')) throw new Error(`model-changes: "${next}" is not a release number`);
  const published = [...new Set(listing.filter((p) => p.name === name && RELEASE.test(p.version)).map((p) => p.version))];
  const floor = RELEASE.test(previous ?? '') ? previous : [...kept].sort(compareVersions).at(-1) ?? null;
  const wanted = floor
    ? published.filter((v) => compareVersions(v, floor) > 0 && compareVersions(v, next) <= 0)
    : published.filter((v) => v === next);
  if (!wanted.includes(next)) wanted.push(next);
  return wanted.sort(compareVersions);
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fs.realpathSync(import.meta.filename)) {
  const [cmd, listingFile, previous, next, dir] = process.argv.slice(2);
  if (cmd !== 'range' || !listingFile || !next || !dir) {
    console.error('Usage: node scripts/model-changes.mjs range LISTING PREVIOUS NEW CHANGES_DIR');
    process.exit(2);
  }
  const listing = JSON.parse(fs.readFileSync(listingFile, 'utf8'));
  for (const v of versionsToKeep(listing, { previous: previous || null, kept: keptVersions(dir), next })) console.log(v);
}
