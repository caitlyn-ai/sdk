#!/usr/bin/env node
// Runs every SDK's examples against a real Caitlyn workspace, not the conformance mock: the check that an example
// in the developer docs works. It needs a workspace and a credential, so it is not part of `make check` or CI.
//
//   CAITLYN_WORKSPACE=your-company.getcaitlyn.ai CAITLYN_AGENT_ID=… CAITLYN_TOKEN_REF=op://… \
//     node scripts/examples-live.mjs [typescript python go rust]
//
// The examples call the workspace's API directly (https://<workspace>/api, or CAITLYN_ENDPOINT). The credential
// is a personal access token for a person in the workspace: CAITLYN_TOKEN, or CAITLYN_TOKEN_REF, a 1Password
// secret reference this script reads with `op read`. The token is passed to each language's runner by name
// in the environment, never on a command line, and is never printed.
//
// Each language's examples run in the toolchain image (through scripts/docker.sh locally; in CI, where the job
// already runs in that image, directly) with:
//
//   CAITLYN_ENDPOINT   the API address, for the client's `endpoint` option
//   CAITLYN_WORKSPACE  the workspace hostname
//   CAITLYN_TOKEN      the personal access token (the token sign-in mode)
//   CAITLYN_AGENT_ID   an agent whose draft can answer
//
// A language's runner is scripts/examples-live/<language>.sh. It prints one line per check, `ok <check>`,
// `fail <check>: <why>` or `skip <check>: <reason>`, for the checks below, and exits non-zero if any failed. A
// runner may skip only for one of the reasons in SKIP_REASONS, which the reason must start with; any other skip
// counts as a failure. A check refused with 403 PERMISSION_DENIED reports `fail <check>: 403 PERMISSION_DENIED: …`;
// this script alone turns that into `skip …: public role only`, and only when CAITLYN_PUBLIC_ROLE_ONLY=1 says the
// workspace's role setup has not run, because a 403 does not say which role the caller has. The script prints the
// table, every skip with its reason and how many there were, and fails if any check failed or was never reported.
// A skipped check does not fail the run, but it is not a pass.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const CHECKS = [
  'GetCaller',
  'GetAgentVersion',
  'CreateConversation',
  'SendMessage',
  'WatchConversation',
  'WatchWorkspaceEvents',
  'stream.reset', // a cursor from two days ago is answered with stream.reset, delivered as an event
  'CreateUpload',
  'GetUpload',
  'CreateDocument',
  'DeleteDocument.processing', // a document still being processed is deleted: accepted, then gone for good
  'GetDocument',
  'Document.wait',
  'ListDocuments',
  'DeleteDocument',
  'BatchDeleteDocuments',
  'DeleteDocument.wait',
  'UpdateDraftVersion',
  'SaveDraftVersion',
  'ListAgentVersions',
  'PublishAgentVersion',
  'ListHistoryEntries',
  'GetHistoryEntry',
  'ResetDraftVersion',
  'DeleteAgentVersion',
];
const LANGUAGES = ['typescript', 'python', 'go', 'rust'];
// The only reasons a check may be skipped: the workspace lacks what it needs, by a setting the run states.
const SKIP_REASONS = [
  'no knowledge base configured', // CAITLYN_KNOWLEDGE_BASE_ID is not set
  'publishing turned off', // CAITLYN_PUBLISH_AGENT_ID is not set: no agent the checks may publish
];
// The workspace's caller has only the "public" role (its role setup has not run): a permission refusal is then
// expected, and is a skip rather than a failure. Set only while that is so.
const PUBLIC_ROLE_ONLY = process.env.CAITLYN_PUBLIC_ROLE_ONLY === '1';
const PERMISSION_REFUSAL = /^403 PERMISSION_DENIED\b/;

const root = path.resolve(import.meta.dirname, '..');
const fail = (message) => {
  console.error(`examples-live: ${message}`);
  process.exit(2);
};
const workspace = process.env.CAITLYN_WORKSPACE;
if (!workspace) fail('set CAITLYN_WORKSPACE, the workspace hostname (see the top of scripts/examples-live.mjs)');
if (!process.env.CAITLYN_AGENT_ID) fail('set CAITLYN_AGENT_ID, an agent whose draft can answer');
let token = process.env.CAITLYN_TOKEN;
if (!token && process.env.CAITLYN_TOKEN_REF) {
  try {
    token = execFileSync('op', ['read', process.env.CAITLYN_TOKEN_REF], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }).trim();
  } catch {
    fail('`op read` could not read CAITLYN_TOKEN_REF (is 1Password unlocked?)');
  }
}
if (!token) fail('set CAITLYN_TOKEN, or CAITLYN_TOKEN_REF for `op read`');
const endpoint = process.env.CAITLYN_ENDPOINT ?? `https://${workspace}/api`;
const languages = process.argv.length > 2 ? process.argv.slice(2) : LANGUAGES;
for (const l of languages) if (!LANGUAGES.includes(l)) fail(`unknown language ${l} (${LANGUAGES.join(', ')})`);

const env = { ...process.env, CAITLYN_ENDPOINT: endpoint, CAITLYN_TOKEN: token };
delete env.CAITLYN_TOKEN_REF;
const results = {}; // language → check → 'ok' | 'fail: …'
for (const language of languages) {
  results[language] = {};
  const runner = path.join('scripts', 'examples-live', `${language}.sh`);
  if (!fs.existsSync(path.join(root, runner))) {
    console.log(`${language}: no ${runner} yet`);
    continue;
  }
  console.log(`${language}: running ${runner} against ${endpoint}`);
  const [command, args] = process.env.CI ? ['bash', [runner]] : [path.join(root, 'scripts', 'docker.sh'), [runner]];
  const child = spawn(command, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = token.length >= 8 ? buffer.slice(0, i).split(token).join('[token]') : buffer.slice(0, i); // a real token is long; a short one would mask ordinary text
      buffer = buffer.slice(i + 1);
      process.stdout.write(`  ${line}\n`);
      const m = /^(ok|fail|skip) ([\w.]+)(?:: (.*))?$/.exec(line.trim());
      if (m && CHECKS.includes(m[2])) {
        const why = m[3] ?? '';
        const allowed = m[1] !== 'skip' || SKIP_REASONS.some((r) => why.startsWith(r));
        results[language][m[2]] =
          m[1] === 'ok' ? 'ok'
          : m[1] === 'fail' && PUBLIC_ROLE_ONLY && PERMISSION_REFUSAL.test(why) ? `skip: public role only (${why})`
          : allowed ? `${m[1]}: ${why}`
          : `fail: skipped without an allowed reason (${why})`;
      }
    }
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) console.log(`${language}: exited with ${code}`);
}

if (PUBLIC_ROLE_ONLY) {
  console.log('\nCAITLYN_PUBLIC_ROLE_ONLY=1: a 403 PERMISSION_DENIED counts as a skip, not a failure, in this run.');
}
const cell = (r) => (r === undefined ? 'not run' : r === 'ok' ? 'ok' : r.startsWith('skip') ? 'skipped' : 'FAIL');
const width = Math.max(...CHECKS.map((c) => c.length)) + 2; // the longest check's name, and a gap
console.log(`\n${['check'.padEnd(width), ...languages.map((l) => l.padEnd(11))].join('')}`);
for (const check of CHECKS) console.log([check.padEnd(width), ...languages.map((l) => cell(results[l][check]).padEnd(11))].join(''));
const failed = languages.flatMap((l) => CHECKS.filter((c) => results[l][c] !== 'ok' && !results[l][c]?.startsWith('skip')).map((c) => `${l} ${c}: ${results[l][c] ?? 'not run'}`));
const skipped = languages.flatMap((l) => CHECKS.filter((c) => results[l][c]?.startsWith('skip')).map((c) => `${l} ${c}: ${results[l][c]}`));
console.log(`\n${skipped.length} skipped${skipped.length ? `:\n${skipped.join('\n')}` : ''}`);
if (failed.length) {
  console.log(`\n${failed.join('\n')}`);
  process.exit(1);
}
