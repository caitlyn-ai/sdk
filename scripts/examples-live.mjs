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
// Each language's examples run in the toolchain image (scripts/docker.sh) with:
//
//   CAITLYN_ENDPOINT   the API address, for the client's `endpoint` option
//   CAITLYN_WORKSPACE  the workspace hostname
//   CAITLYN_TOKEN      the personal access token (the token sign-in mode)
//   CAITLYN_AGENT_ID   an agent whose draft can answer
//
// A language's runner is scripts/examples-live/<language>.sh. It prints one line per check, `ok <check>` or
// `fail <check>: <why>`, for the checks below, and exits non-zero if any failed. This script prints the table
// and fails if any check failed or was never reported.
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
];
const LANGUAGES = ['typescript', 'python', 'go', 'rust'];

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
  const child = spawn(path.join(root, 'scripts', 'docker.sh'), [runner], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
  let buffer = '';
  child.stdout.on('data', (d) => {
    buffer += d;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, i).split(token).join('[token]');
      buffer = buffer.slice(i + 1);
      process.stdout.write(`  ${line}\n`);
      const m = /^(ok|fail) ([\w.]+)(?:: (.*))?$/.exec(line.trim());
      if (m && CHECKS.includes(m[2])) results[language][m[2]] = m[1] === 'ok' ? 'ok' : `fail: ${m[3] ?? ''}`;
    }
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  if (code !== 0) console.log(`${language}: exited with ${code}`);
}

const cell = (r) => (r === undefined ? 'not run' : r === 'ok' ? 'ok' : 'FAIL');
console.log(`\n${['check'.padEnd(22), ...languages.map((l) => l.padEnd(11))].join('')}`);
for (const check of CHECKS) console.log([check.padEnd(22), ...languages.map((l) => cell(results[l][check]).padEnd(11))].join(''));
const failed = languages.flatMap((l) => CHECKS.filter((c) => results[l][c] !== 'ok').map((c) => `${l} ${c}: ${results[l][c] ?? 'not run'}`));
if (failed.length) {
  console.log(`\n${failed.join('\n')}`);
  process.exit(1);
}
