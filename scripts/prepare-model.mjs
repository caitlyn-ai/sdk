// Writes build/model/model.json, the model the generators read, from the committed snapshot
// model/model.json. It checks the snapshot against model/model.lock.json, then:
//   - removes the `validators` and `suppressions` metadata: they name the app's Caitlyn lint rules,
//     which run in the app's model build and are not on the generators' classpath;
//   - replaces any @since("next") with the lock's `stampNext`. A published model never contains
//     "next" (the app's release stamps it); an unpublished build, such as the current snapshot, does. That is the
//     pre-release case, a model built from a branch of the app: the SDKs say "Since Caitlyn <stampNext>" and the
//     docs, reading the raw snapshot, say "Not available yet: arrives in Caitlyn <stampNext>" (docs/README.md).
// Usage: node scripts/prepare-model.mjs
//
// The app's local loop (scripts/dev-sdk.sh) uses its dev mode instead, for a model the app has just built:
//   node scripts/prepare-model.mjs --dev <input model.json> <output model.json>
// It reads <input>, not the snapshot, so it skips the lock's SHA-256 check (the input is not the locked model); it
// still stamps @since("next") with the lock's stampNext (or, with a published lock, the minor release after its
// version), and it writes <output>, never build/model/model.json, which
// `make generate` reads. Committed generated code comes only from the locked snapshot.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dev = process.argv[2] === '--dev';
if (dev && process.argv.length !== 5) {
  console.error('usage: node scripts/prepare-model.mjs --dev <input model.json> <output model.json>');
  process.exit(2);
}
const input = dev ? path.resolve(process.argv[3]) : path.join(root, 'model/model.json');
const output = dev ? path.resolve(process.argv[4]) : path.join(root, 'build/model/model.json');
const raw = fs.readFileSync(input);
const lock = JSON.parse(fs.readFileSync(path.join(root, 'model/model.lock.json'), 'utf8'));
const sha = crypto.createHash('sha256').update(raw).digest('hex');
if (!dev && sha !== lock.sha256) {
  console.error(`prepare-model: model/model.json has SHA-256 ${sha}, but model/model.lock.json says ${lock.sha256}.`);
  console.error('Update the model with scripts/model-pull.sh, which writes both files; never edit the snapshot by hand.');
  process.exit(1);
}
const ast = JSON.parse(raw.toString('utf8'));
delete ast.metadata?.validators;
delete ast.metadata?.suppressions;

const SINCE = 'ai.caitlyn.traits#since';
// What "next" is stamped as: the lock's stampNext. A published lock has none (its model has no "next"), so dev mode, for
// an app build made after that release, stamps the release after it: the next minor version.
const nextMinor = (v) => (/^\d+\.\d+\.\d+$/.test(v ?? '') ? `${v.split('.')[0]}.${Number(v.split('.')[1]) + 1}.0` : null);
const stampNext = lock.stampNext || (dev ? nextMinor(lock.version) : null);
let stamped = 0;
const stamp = (traits) => {
  if (traits?.[SINCE] === 'next') {
    if (!/^\d+\.\d+\.\d+$/.test(stampNext ?? '')) {
      console.error('prepare-model: the model contains @since("next") and model.lock.json has no stampNext release number.');
      process.exit(1);
    }
    traits[SINCE] = stampNext;
    stamped++;
  }
};
for (const shape of Object.values(ast.shapes)) {
  stamp(shape.traits);
  for (const member of Object.values(shape.members ?? {})) stamp(member.traits);
}
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, JSON.stringify(ast, null, 2));
const from = dev ? `the dev model ${path.relative(root, input)}` : (lock.version ?? 'an unpublished model');
console.log(`prepare-model: ${path.relative(root, output)} from ${from} (${sha.slice(0, 12)})` +
  (stamped ? `, ${stamped} @since("next") stamped as ${stampNext}` : ''));
