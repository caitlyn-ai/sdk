// Is the committed snapshot (model/model.lock.json) one the SDKs may be released from? scripts/model-check.sh fetches
// the latest published model and its release number, then runs this.
//
// It passes for:
//   - the latest published model;
//   - a model:main pre-release (the app's main, not yet released; its lock has a `prerelease` record) whose stampNext
//     is later than the latest published release.
// It fails for:
//   - behind: a published model that isn't the latest;
//   - hand-pulled: an unpublished model with no `prerelease` record, a local build that model:main didn't make (how a
//     stale Gate 1 snapshot once reached main);
//   - stale pre-release: a model:main pre-release whose stampNext isn't later than the latest published release, so
//     it was built before a release it doesn't have.
//
// Usage: node scripts/model-check.mjs <lock> <latest model.json> <latest version> [--strict]
//   exit 0  passes, or no model is published yet (no latest given)
//   exit 2  fails, in a merge request: a warning
//   exit 1  fails with --strict (main and v* tags, where docs:publish needs this job)
import crypto from 'node:crypto';
import fs from 'node:fs';

const RELEASE = /^\d+\.\d+\.\d+$/;
const later = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};

/**
 * `lock` is model.lock.json's contents; `latest` is { sha256, version } of the latest published model, or null when
 * none is published. Returns { ok, case, message }: case is latest, ahead, none, behind, hand-pulled or stale.
 */
export function classify(lock, latest) {
  const name = lock.version ?? (lock.prerelease ? `a pre-release of app commit ${lock.prerelease.appCommit}` : 'an unpublished build');
  if (!latest) return { ok: true, case: 'none', message: `No model is published yet, so there is nothing to compare the snapshot (${name}) with.` };
  if (lock.version) {
    if (lock.sha256 === latest.sha256) return { ok: true, case: 'latest', message: lock.version === latest.version ? `The snapshot (${lock.version}) is the latest published model.` : `The snapshot (${lock.version}) is the same model as the latest published release, ${latest.version}.` };
    return { ok: false, case: 'behind', message: `Behind: the snapshot is the published model ${lock.version}, but the latest published model is ${latest.version}. Run scripts/model-pull.sh latest, or let model:main bring the app's model.` };
  }
  if (!lock.prerelease) {
    return { ok: false, case: 'hand-pulled', message: `Hand-pulled: the snapshot is an unpublished build with no prerelease record, so model:main didn't make it (${lock.source ?? 'source unknown'}). Pull a published model (scripts/model-pull.sh latest), or let model:main bring the app's model.` };
  }
  if (!RELEASE.test(lock.stampNext ?? '') || !later(lock.stampNext, latest.version)) {
    return { ok: false, case: 'stale', message: `Stale pre-release: the snapshot is model:main's pre-release of app commit ${lock.prerelease.appCommit}, stamped ${lock.stampNext ?? 'with no release'}, which isn't later than the latest published release ${latest.version}. It was built before a release it doesn't have; the next model:main run, or scripts/model-pull.sh latest, replaces it.` };
  }
  return { ok: true, case: 'ahead', message: `The snapshot is model:main's pre-release of app commit ${lock.prerelease.appCommit}, for Caitlyn ${lock.stampNext}, ahead of the latest published release ${latest.version}.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [lockFile, modelFile, versionArg] = process.argv.slice(2).filter((a) => a !== '--strict');
  const strict = process.argv.includes('--strict');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const latest = modelFile
    ? { sha256: crypto.createHash('sha256').update(fs.readFileSync(modelFile)).digest('hex'), version: versionArg.trim() }
    : null;
  const r = classify(lock, latest);
  if (r.ok) {
    console.log(r.message);
    process.exit(0);
  }
  console.error(r.message);
  console.error(strict
    ? 'This fails on main and v* tags, and docs:publish waits for it.'
    : 'A warning in a merge request: model:main brings the app\'s model to main when the app merges a change to it.');
  process.exit(strict ? 1 : 2);
}
