// Every error code has a constant in each SDK, equal to the code, and no SDK has a constant for anything else (run by
// scripts/generate.sh, so CI's generate job and `make check` fail when one is missing). The codes are the model's
// (@errorCodes on its error shapes) and the ones the SDKs raise themselves (SdkErrorCodes in codegen/model-support).
// The four runtimes are scanned too: an upper-case string literal in one that is neither a code nor a known non-code
// (NOT_CODES below) fails the check, so a code raised by hand cannot go without a constant. The SDKs' own codes say
// where they are raised (PROTOCOL.md 6.3): "every runtime" codes must be found raised in each runtime, unless
// SdkErrorCodes says "cannot happen in <runtime>: <why>"; "only <runtimes>: <reason>" codes must not be found raised
// in any other. The constants:
//   TypeScript  ErrorCode.<CODE>             typescript/packages/sdk/src/sdk/errorCodes.ts
//   Python      ErrorCode.<CODE> (OpenEnum)  python/caitlyn/caitlyn/errors.py
//   Go          caitlyn.ErrorCode<Pascal>    go/client.go
//   Rust        ErrorCode::<CODE>            rust/caitlyn-sdk/src/error.rs
import fs from 'node:fs';

const root = new URL('../', import.meta.url);
const read = (p) => fs.readFileSync(new URL(p, root), 'utf8');
const model = JSON.parse(read('model/model.json'));
const codes = new Set();
for (const shape of Object.values(model.shapes)) {
  for (const c of shape.traits?.['ai.caitlyn.traits#errorCodes'] ?? []) codes.add(c);
}
if (codes.size === 0) throw new Error('check-error-codes: the model lists no error codes');
const modelCodes = codes.size;
const sdkSource = read('codegen/model-support/src/main/java/ai/caitlyn/codegen/model/SdkErrorCodes.java');
// put("CODE", "meaning", reach, "cannot happen in <runtime>: <why>"...), reach being EVERY or "only <runtimes>: <reason>".
const STR = '"((?:[^"\\\\]|\\\\.)*)"';
const sdkEntries = [...sdkSource.matchAll(new RegExp(`put\\(${STR},\\s*${STR},\\s*(EVERY|${STR})((?:,\\s*${STR})*)\\)`, 'g'))].map((m) => ({
  code: m[1],
  reach: m[3] === 'EVERY' ? 'every' : m[4],
  cannot: [...m[5].matchAll(new RegExp(STR, 'g'))].map((x) => x[1]),
}));
const sdkCodes = sdkEntries.map((e) => e.code);
if (sdkCodes.length === 0) throw new Error('check-error-codes: SdkErrorCodes lists no codes');
const LANGS = ['typescript', 'python', 'go', 'rust'];
const layout = [];
for (const e of sdkEntries) {
  if (e.reach === 'every') {
    e.runtimes = new Set(LANGS);
    for (const c of e.cannot) {
      const m = /^cannot happen in (typescript|python|go|rust): ./.exec(c);
      if (!m) layout.push(`SdkErrorCodes: ${e.code}'s exception "${c}" is not "cannot happen in <runtime>: <why>"`);
      else e.runtimes.delete(m[1]);
    }
  } else {
    const m = /^only ((?:typescript|python|go|rust)(?:(?:, | and )(?:typescript|python|go|rust))*): ./.exec(e.reach);
    if (!m) layout.push(`SdkErrorCodes: ${e.code}'s reach "${e.reach}" is neither EVERY nor "only <runtimes>: <reason>"`);
    e.runtimes = new Set(m ? m[1].split(/, | and /) : []);
    if (e.cannot.length) layout.push(`SdkErrorCodes: ${e.code} is runtime-specific, so it takes no "cannot happen" exceptions`);
  }
}
if (sdkEntries.length !== [...sdkSource.matchAll(/\bput\("/g)].length) layout.push('SdkErrorCodes: an entry is not put("CODE", "meaning", reach, ...exceptions) as this check reads it');
for (const c of sdkCodes) codes.add(c);

// Upper-case literals in the runtimes that are not error codes.
const NOT_CODES = new Set([
  // HTTP methods, environment variables and algorithm names
  'HEAD', 'POST', 'PATCH', 'HMAC', 'AKIDEXAMPLE', 'CAITLYN_RUSTC_VERSION', 'MAX_FILE_SIZE',
  // smithy-typescript's and the runtime's own identifiers
  'CONTENT_LENGTH', 'SET_CONTENT_LENGTH', 'CONTENT_TYPES', 'ENDPOINT', 'ENDPOINT_PARAMETERS', 'ENDPOINT_V2', 'HTTP_AUTH_SCHEME',
  'HTTP_SIGNING', 'RETRY', 'TRANSIENT', 'ERROR', 'UNKNOWN',
  // a batch item's failure code from the server (CompleteIngestionBatchUploads), compared, never raised
  'CHECKSUM_MISMATCH',
]);
const notCode = (s) => NOT_CODES.has(s) || /^AWS_/.test(s) || /^HTTP_\d+$/.test(s);
const runtimes = { typescript: ['typescript/packages/sdk-core/src', /\.ts$/, true], python: ['python/caitlyn-core/src/caitlyn_core', /\.py$/, true], go: ['go', /\.go$/, false], 'go core': ['go/core', /\.go$/, true], rust: ['rust/caitlyn-sdk-core/src', /\.rs$/, true] };
const files = (dir, re, deep) => fs.readdirSync(new URL(`${dir}/`, root), { withFileTypes: true }).flatMap((e) =>
  e.isDirectory() ? (deep ? files(`${dir}/${e.name}`, re, deep) : []) : re.test(e.name) && !/_test\.go$|\.test\.ts$/.test(e.name) ? [`${dir}/${e.name}`] : []);
const unlisted = [];
// The literals each runtime raises or names, by code (Go's two directories are one runtime).
const raised = Object.fromEntries(LANGS.map((l) => [l, new Map()]));
for (const [lang, [dir, re, deep]] of Object.entries(runtimes)) {
  for (const f of files(dir, re, deep)) {
    const src = read(f);
    if (/^\/\/ Code generated .* DO NOT EDIT\.$/m.test(src.split('\n')[0])) continue;
    for (const [, lit] of src.matchAll(/["']([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+|[A-Z]{4,})["']/g)) {
      if (!codes.has(lit) && !notCode(lit)) unlisted.push(`${lang}: ${f} raises or names ${lit}, which is not a known code: add it to SdkErrorCodes, or to NOT_CODES if it is not a code`);
      const runtime = lang === 'go core' ? 'go' : lang;
      if (!raised[runtime].has(lit)) raised[runtime].set(lit, f);
    }
  }
}
// Where each of the SDKs' own codes is raised, against where SdkErrorCodes says it is.
for (const e of sdkEntries) {
  for (const lang of LANGS) {
    const at = raised[lang].get(e.code);
    if (e.runtimes.has(lang) && !at)
      layout.push(`${lang}: raises no ${e.code}, which SdkErrorCodes says ${e.reach === 'every' ? 'every runtime raises' : `${lang} raises`}: raise it, or record "cannot happen in ${lang}: <why>"`);
    if (!e.runtimes.has(lang) && at && !(e.reach === 'every'))
      layout.push(`${lang}: ${at} raises ${e.code}, which SdkErrorCodes marks "${e.reach}"`);
    if (!e.runtimes.has(lang) && at && e.reach === 'every')
      layout.push(`${lang}: ${at} raises ${e.code}, whose case SdkErrorCodes says cannot happen in ${lang}`);
  }
}
const pascal = (code) => code.toLowerCase().split('_').map((w) => w[0].toUpperCase() + w.slice(1)).join('');
const found = {
  typescript: [...read('typescript/packages/sdk/src/sdk/errorCodes.ts').matchAll(/^  (\w+): "(\w+)",$/gm)].map(([, k, v]) => [k, v]),
  python: [...read('python/caitlyn/caitlyn/errors.py').matchAll(/^    (\w+) = "(\w+)"$/gm)].map(([, k, v]) => [k, v]),
  go: [...read('go/client.go').matchAll(/^\tErrorCode(\w+)\s+ErrorCode = "(\w+)"$/gm)].map(([, k, v]) => [k, v]),
  rust: [...read('rust/caitlyn-sdk/src/error.rs').matchAll(/^    pub const (\w+): &'static str = "(\w+)";$/gm)].map(([, k, v]) => [k, v]),
};
const name = { typescript: (c) => c, python: (c) => c, go: pascal, rust: (c) => c };
const problems = [];
for (const [lang, pairs] of Object.entries(found)) {
  const byValue = new Map(pairs.map(([k, v]) => [v, k]));
  for (const code of codes) {
    if (!byValue.has(code)) problems.push(`${lang}: no constant for ${code}`);
    // Go's names keep initialisms upper-case (HTTPClientFailed), so its names compare without case.
    else if (lang === 'go' ? byValue.get(code).toLowerCase() !== name.go(code).toLowerCase() : byValue.get(code) !== name[lang](code)) problems.push(`${lang}: ${code}'s constant is ${byValue.get(code)}, not ${name[lang](code)}`);
  }
  for (const [k, v] of pairs) if (!codes.has(v)) problems.push(`${lang}: constant ${k} is ${v}, which is not a known code`);
}
problems.push(...new Set(unlisted), ...new Set(layout));
const errorsPage = read('docs/errors.md');
for (const c of sdkCodes) if (!errorsPage.includes(`\`${c}\``)) problems.push(`docs/errors.md: ${c}, a code the SDKs raise, is not named under "Errors the SDK raises itself"`);
if (problems.length) {
  console.error(`check-error-codes:\n  ${problems.join('\n  ')}`);
  process.exit(1);
}
const every = sdkEntries.filter((e) => e.reach === 'every').length;
console.log(`check-error-codes: all ${codes.size} error codes (${modelCodes} from the model, ${codes.size - modelCodes} the SDKs raise themselves) have a constant in TypeScript, Python, Go and Rust, and the runtimes raise no other; ${every} of the SDKs' own are raised in every runtime where their case can happen, and ${sdkEntries.length - every} only in theirs`);
