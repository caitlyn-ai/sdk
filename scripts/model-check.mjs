// Is the committed snapshot (model/model.lock.json) one the SDKs may be released from? scripts/model-check.sh fetches
// the latest published model and its release number, then runs this. It compares what the models say, not their
// version numbers: the app releases several times a day, mostly with no change to the model, and none of those
// releases should need anyone to pull a model by hand.
//
// It passes for:
//   - the latest published model, or a published model the same as it;
//   - a model:main pre-release (the app's main, not yet released; its lock has a `prerelease` record) that the latest
//     release shipped: the same model, with each @since("next") whatever release stamped it (`released`);
//   - a model:main pre-release built since the latest release: its stampNext, the app version its build reports, is
//     the latest release or later, so the app hasn't released since (`ahead`).
// It fails for:
//   - behind: a published model that isn't the latest and says something different;
//   - hand-pulled: an unpublished model with no `prerelease` record, a local build that model:main didn't make (how a
//     stale Gate 1 snapshot once reached main);
//   - stale pre-release: the app has released since the pre-release's build, and that release's model says something
//     the pre-release doesn't: model:main didn't bring it.
//
// Usage: node scripts/model-check.mjs <lock> <latest model.json> <latest version> [--strict]
//   The snapshot is the model.json beside the lock.
//   exit 0  passes, or no model is published yet (no latest given)
//   exit 2  fails, in a merge request: a warning
//   exit 1  fails with --strict (main and v* tags, where docs:publish needs this job)
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const RELEASE = /^\d+\.\d+\.\d+$/;
const later = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
};
const SINCE = 'ai.caitlyn.traits#since';

/** JSON with every object's keys sorted, so two models compare by what they say, not their key order. */
const canonical = (v) => JSON.stringify(v, (_, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));

/**
 * Whether a pre-release's model is the one a release shipped: the same shapes, members and traits, where each
 * @since("next") in the pre-release may be any release number in the published model (the release that shipped it).
 */
export function shipped(snapshot, published) {
  const theirs = published?.shapes ?? {};
  const stamp = (traits, other) => (traits?.[SINCE] === 'next' && RELEASE.test(other?.[SINCE] ?? '') ? { ...traits, [SINCE]: other[SINCE] } : traits);
  const ours = Object.fromEntries(
    Object.entries(snapshot?.shapes ?? {}).map(([id, shape]) => {
      const other = theirs[id];
      const members = shape.members && Object.fromEntries(Object.entries(shape.members).map(([m, member]) => [m, member.traits ? { ...member, traits: stamp(member.traits, other?.members?.[m]?.traits) } : member]));
      return [id, { ...shape, ...(shape.traits && { traits: stamp(shape.traits, other?.traits) }), ...(members && { members }) }];
    }),
  );
  return canonical({ ...snapshot, shapes: ours }) === canonical(published);
}

/**
 * `lock` is model.lock.json's contents; `latest` is { sha256, version, model } of the latest published model, or null
 * when none is published; `snapshot` is the committed model.json (a pre-release's is compared with `latest.model`).
 * Returns { ok, case, message }: case is latest, released, ahead, none, behind, hand-pulled or stale.
 */
export function classify(lock, latest, snapshot = null) {
  const name = lock.version ?? (lock.prerelease ? `a pre-release of app commit ${lock.prerelease.appCommit}` : 'an unpublished build');
  if (!latest) return { ok: true, case: 'none', message: `No model is published yet, so there is nothing to compare the snapshot (${name}) with.` };
  if (lock.version) {
    if (lock.sha256 === latest.sha256) return { ok: true, case: 'latest', message: lock.version === latest.version ? `The snapshot (${lock.version}) is the latest published model.` : `The snapshot (${lock.version}) is the same model as the latest published release, ${latest.version}.` };
    return { ok: false, case: 'behind', message: `Behind: the snapshot is the published model ${lock.version}, but the latest published model is ${latest.version}. Run scripts/model-pull.sh latest, or let model:main bring the app's model.` };
  }
  if (!lock.prerelease) {
    return { ok: false, case: 'hand-pulled', message: `Hand-pulled: the snapshot is an unpublished build with no prerelease record, so model:main didn't make it (${lock.source ?? 'source unknown'}). Pull a published model (scripts/model-pull.sh latest), or let model:main bring the app's model.` };
  }
  if (snapshot && latest.model && shipped(snapshot, latest.model)) {
    return { ok: true, case: 'released', message: `The snapshot is model:main's pre-release of app commit ${lock.prerelease.appCommit}, and the latest published release, ${latest.version}, shipped that model.` };
  }
  if (!RELEASE.test(lock.stampNext ?? '') || later(latest.version, lock.stampNext)) {
    return { ok: false, case: 'stale', message: `Stale pre-release: the snapshot is model:main's pre-release of app commit ${lock.prerelease.appCommit}, stamped ${lock.stampNext ?? 'with no release'}, and the app has released ${latest.version} since with a model this snapshot doesn't have. The next model:main run, or scripts/model-pull.sh latest, replaces it.` };
  }
  return { ok: true, case: 'ahead', message: `The snapshot is model:main's pre-release of app commit ${lock.prerelease.appCommit}, for Caitlyn ${lock.stampNext}, built since the latest published release ${latest.version}.` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [lockFile, modelFile, versionArg] = process.argv.slice(2).filter((a) => a !== '--strict');
  const strict = process.argv.includes('--strict');
  const lock = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
  const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file) : null);
  const latestBytes = modelFile ? fs.readFileSync(modelFile) : null;
  const latest = latestBytes ? { sha256: crypto.createHash('sha256').update(latestBytes).digest('hex'), version: versionArg.trim(), model: JSON.parse(latestBytes) } : null;
  const snapshotBytes = read(path.join(path.dirname(lockFile), 'model.json'));
  const r = classify(lock, latest, snapshotBytes && JSON.parse(snapshotBytes));
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
