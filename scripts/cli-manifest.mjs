// The CLI's command manifest: the generator's commands.json (codegen/cli), with every documentation string passed
// through the same public-docs filter the developer docs use (publicDoc), so `--help` never quotes the model's notes
// about itself. Written with two-space indents, so a model change is a reviewable diff.
//
//   node scripts/cli-manifest.mjs <generator output> <cli/internal/spec/commands.json>
import fs from 'node:fs';
import path from 'node:path';
import { publicDoc } from './docs-model.mjs';

const [from, to] = process.argv.slice(2);
if (!from || !to) {
  console.error('usage: node scripts/cli-manifest.mjs <commands.json from the generator> <output>');
  process.exit(2);
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      // Example inputs and outputs are data, never prose: leave them exactly as the model has them
      if (k === 'examples') {
        out[k] = v.map((e) => ({ ...e, ...(e.documentation ? { documentation: publicDoc(e.documentation) } : {}) }));
      } else if ((k === 'documentation' || k === 'reason') && typeof v === 'string') {
        out[k] = publicDoc(v);
      } else {
        out[k] = clean(v);
      }
    }
    return out;
  }
  return value;
}

const manifest = clean(JSON.parse(fs.readFileSync(from, 'utf8')));
fs.mkdirSync(path.dirname(to), { recursive: true });
fs.writeFileSync(to, JSON.stringify(manifest, null, 2) + '\n');
console.log(`${to}: ${manifest.commands.length} commands over ${Object.keys(manifest.operations).length} operations`);
