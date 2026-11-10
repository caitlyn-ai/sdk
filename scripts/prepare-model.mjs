// Writes build/model/model.json, the model the generators read, from the committed snapshot
// model/model.json. It checks the snapshot against model/model.lock.json, then:
//   - removes the `validators` and `suppressions` metadata: they name the app's Caitlyn lint rules,
//     which run in the app's model build and are not on the generators' classpath;
//   - replaces any @since("next") with the lock's `stampNext`. A published model never contains
//     "next" (the app's release stamps it); an unpublished build, such as the Gate 1 snapshot, does.
// Usage: node scripts/prepare-model.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const raw = fs.readFileSync(path.join(root, 'model/model.json'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'model/model.lock.json'), 'utf8'));
const sha = crypto.createHash('sha256').update(raw).digest('hex');
if (sha !== lock.sha256) {
  console.error(`prepare-model: model/model.json has SHA-256 ${sha}, but model/model.lock.json says ${lock.sha256}.`);
  console.error('Update the model with scripts/model-pull.sh, which writes both files; never edit the snapshot by hand.');
  process.exit(1);
}
const ast = JSON.parse(raw.toString('utf8'));
delete ast.metadata?.validators;
delete ast.metadata?.suppressions;

const SINCE = 'ai.caitlyn.traits#since';
let stamped = 0;
const stamp = (traits) => {
  if (traits?.[SINCE] === 'next') {
    if (!/^\d+\.\d+\.\d+$/.test(lock.stampNext ?? '')) {
      console.error('prepare-model: the model contains @since("next") and model.lock.json has no stampNext release number.');
      process.exit(1);
    }
    traits[SINCE] = lock.stampNext;
    stamped++;
  }
};
for (const shape of Object.values(ast.shapes)) {
  stamp(shape.traits);
  for (const member of Object.values(shape.members ?? {})) stamp(member.traits);
}
fs.mkdirSync(path.join(root, 'build/model'), { recursive: true });
fs.writeFileSync(path.join(root, 'build/model/model.json'), JSON.stringify(ast, null, 2));
console.log(`prepare-model: build/model/model.json from ${lock.version ?? 'an unpublished model'} (${sha.slice(0, 12)})` +
  (stamped ? `, ${stamped} @since("next") stamped as ${lock.stampNext}` : ''));
