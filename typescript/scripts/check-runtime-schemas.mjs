// Refuses a model that uses a Smithy feature sdk-core's runtime (packages/sdk-core/src/protocol.ts and runtime/) does
// not implement, so the SDK can never quietly mishandle it. It reads the generated static schemas
// (packages/sdk/src/schemas/schemas_0.ts) and fails on:
//   - an AWS event stream (a streaming union member): Caitlyn streams are server-sent events, a streaming blob;
//   - a blob that is not streamed, a big integer or a big decimal;
//   - a timestamp that is not RFC 3339 date-time (the model's DateTime is @timestampFormat("date-time"));
//   - a string with a media type (JSON in a string, or base64 in a header);
//   - a host prefix (@endpoint) or a @hostLabel member.
// Teach the runtime the feature, run the conformance suites, then allow it here.
// Usage: node scripts/check-runtime-schemas.mjs (or import checkRuntimeSchemas from scripts/build-packages.mjs).
import { build } from 'esbuild';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const BITS = ['httpLabel', 'idempotent', 'idempotencyToken', 'sensitive', 'httpPayload', 'httpResponseCode', 'httpQueryParams'];
const traitsOf = (t) => (t && typeof t === 'object' ? t : Object.fromEntries(BITS.filter((_, i) => ((Number(t) >> i) & 1) === 1).map((b) => [b, 1])));
const deref = (r) => (typeof r === 'function' ? r() : r);

export async function checkRuntimeSchemas(schemasFile) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'caitlyn-schemas-'));
  const out = path.join(dir, 'schemas.mjs');
  await build({ entryPoints: [schemasFile], bundle: true, format: 'esm', platform: 'node', outfile: out, logLevel: 'error' });
  const schemas = await import(pathToFileURL(out).href);
  fs.rmSync(dir, { recursive: true, force: true });

  const problems = [];
  const seen = new Set();
  const visit = (ref, where, inherited = {}) => {
    let type = deref(ref);
    const traits = { ...inherited };
    while (Array.isArray(type) && type.length === 2) {
      Object.assign(traits, traitsOf(type[1]));
      type = deref(type[0]);
    }
    if (Array.isArray(type) && type[0] === 0) {
      Object.assign(traits, traitsOf(type[3]), { ...traits });
      type = deref(type[4]);
    }
    if (traits.hostLabel) problems.push(`${where}: @hostLabel`);
    if (typeof type === 'number') {
      if (type === 17 || type === 19) problems.push(`${where}: a big integer or big decimal`);
      if (type === 21) problems.push(`${where}: a blob that is not streamed`);
      if (type === 4 || type === 6 || type === 7) problems.push(`${where}: a timestamp that is not @timestampFormat("date-time")`);
      if (type === 0 && traits.mediaType) problems.push(`${where}: a string with media type ${traits.mediaType}`);
      if (type >= 64 && type <= 255) visit(type & 63, `${where}[]`);
      return;
    }
    if (!Array.isArray(type) || seen.has(type)) return;
    seen.add(type);
    const [kind, , name] = type;
    const own = traitsOf(type[3]);
    if (kind === 9) {
      if (own.endpoint) problems.push(`${name}: a host prefix (@endpoint)`);
      visit(type[4], `${name} input`);
      visit(type[5], `${name} output`);
    } else if (kind === 1) {
      visit(type[4], `${name}[]`);
    } else if (kind === 2) {
      visit(type[5], `${name}{}`);
    } else if (kind === 3 || kind === 4 || kind === -3) {
      type[4].forEach((member, i) => {
        const m = type[5][i];
        const mt = Array.isArray(m) && m.length === 2 ? traitsOf(m[1]) : {};
        let target = deref(Array.isArray(m) && m.length === 2 ? m[0] : m);
        if (Array.isArray(target) && target[0] === 4 && (mt.streaming || traitsOf(target[3]).streaming)) problems.push(`${name}.${member}: an AWS event stream`);
        visit(m, `${name}.${member}`);
      });
    }
  };
  for (const [exported, value] of Object.entries(schemas)) if (Array.isArray(value)) visit(value, exported);
  if (problems.length) {
    throw new Error(`The SDK runtime (sdk-core) does not implement what this model uses:\n  ${problems.join('\n  ')}\nSee scripts/check-runtime-schemas.mjs.`);
  }
  return seen.size;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const n = await checkRuntimeSchemas(path.resolve(import.meta.dirname, '../packages/sdk/src/schemas/schemas_0.ts'));
  console.log(`runtime schemas ok (${n} shapes)`);
}
