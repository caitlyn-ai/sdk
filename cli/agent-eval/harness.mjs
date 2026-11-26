// The agent evaluation's harness (the CLI design, 20.3): for one task, a fresh workspace folder with the arm's docs, the
// mock server reset and set up for the task, every `caitlyn` the agent runs recorded (its arguments, exit code and
// stderr) through a wrapper on PATH, and afterwards the mock's request log and the files the agent left. The agent is
// given a shell in that folder and the task in plain words, and nothing else.
//
// Commands run through an executor: `local` (a bash process in the task's folder, for the offline tests and a run on a
// developer's machine) or `docker` (each command inside a network-isolated container that holds the CLI, the mock and
// the docs, for the run against a model in CI; Dockerfile beside this file).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const here = import.meta.dirname;
export const repo = path.resolve(here, '../..');

/** The task set (tasks.json). */
export function loadTasks(file = path.join(here, 'tasks.json')) {
  const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
  const ids = new Set();
  for (const t of doc.tasks) {
    if (ids.has(t.id)) throw new Error(`tasks.json: two tasks are ${t.id}`);
    ids.add(t.id);
    if (!['top', 'recovery', 'safety', 'tool'].includes(t.group)) throw new Error(`tasks.json: ${t.id} has the unknown group ${t.group}`);
    if (!t.graders?.length) throw new Error(`tasks.json: ${t.id} has no grader`);
  }
  return doc;
}

/** The three arms: what the agent has besides the shell (20.3). */
export const ARMS = {
  docs: 'the published docs only',
  snippet: 'the docs, and the AGENTS.md section in the project',
  skill: 'the docs, and the Claude Code skill in the project',
};

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

/** The mock server, with its request log and fault configuration. */
export async function startMock() {
  const port = await freePort();
  const child = spawn(process.execPath, [path.join(repo, 'conformance/mock-server/server.mjs')], { env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the mock server did not start')), 10_000);
    child.stdout.on('data', (d) => /listening/.test(String(d)) && (clearTimeout(timer), resolve()));
    child.on('exit', (code) => reject(new Error(`the mock server exited with ${code}`)));
  });
  const base = `http://127.0.0.1:${port}`;
  const call = async (method, p, body, headers = {}) => {
    const r = await fetch(`${base}${p}`, { method, headers: { Authorization: 'Bearer pat_test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.text() };
  };
  return {
    base,
    endpoint: base,
    port,
    reset: () => call('POST', '/__mock/reset'),
    faults: (f) => call('POST', '/__mock/faults', f),
    requests: async () => JSON.parse((await call('GET', '/__mock/requests')).body),
    call,
    stop: () => child.kill(),
  };
}

/** The wrapper that records each `caitlyn` the agent runs: <n>.args (NUL-separated), <n>.exit, <n>.err. */
export function writeShim(dir, real) {
  fs.mkdirSync(dir, { recursive: true });
  const shim = path.join(dir, 'caitlyn');
  fs.writeFileSync(
    shim,
    `#!/usr/bin/env bash
# Records this run of caitlyn for the agent evaluation, then runs the real CLI.
log="\${CAITLYN_EVAL_LOG:?}"
n=$(ls "$log" | grep -c '\\.args$' || true)
printf '%s\\0' "$@" > "$log/$n.args"
${JSON.stringify(real)} "$@" 2> "$log/$n.err"
code=$?
cat "$log/$n.err" >&2
echo "$code" > "$log/$n.exit"
exit "$code"
`,
  );
  fs.chmodSync(shim, 0o755);
  return shim;
}

/** The commands the shim recorded, in order: { argv, exitCode, stderr }. */
export function readLog(dir) {
  if (!fs.existsSync(dir)) return [];
  const n = fs.readdirSync(dir).filter((f) => f.endsWith('.args')).length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const argv = fs.readFileSync(path.join(dir, `${i}.args`), 'utf8').split('\0').slice(0, -1);
    const exit = fs.existsSync(path.join(dir, `${i}.exit`)) ? Number(fs.readFileSync(path.join(dir, `${i}.exit`), 'utf8').trim()) : null;
    const stderr = fs.existsSync(path.join(dir, `${i}.err`)) ? fs.readFileSync(path.join(dir, `${i}.err`), 'utf8') : '';
    out.push({ argv, exitCode: exit, stderr });
  }
  return out;
}

/** Copies the published docs (the Markdown copies and the llms files, not the HTML) into the task's folder. */
export function copyDocs(from, to) {
  if (!from || !fs.existsSync(from)) return 0;
  let n = 0;
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const src = path.join(dir, e.name);
      if (e.isDirectory()) walk(src);
      else if (/\.(md|txt)$/.test(e.name)) {
        const dst = path.join(to, path.relative(from, src));
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        n++;
      }
    }
  };
  walk(from);
  return n;
}

const truncate = (s, n = 20_000) => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more characters)` : s);

/** Runs commands in a bash process in the task's folder. */
export function localExecutor({ cwd, env, timeoutMs = 300_000 }) {
  return {
    cwd,
    run(command) {
      const r = spawnSync('bash', ['-c', command], { cwd, env, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
      return { stdout: truncate(r.stdout ?? ''), stderr: truncate(`${r.stderr ?? ''}${r.error ? `\n${r.error.message}` : ''}`), exitCode: r.status ?? 124 };
    },
  };
}

/** The CLI's own description, from the binary under test: what the graders parse commands against. */
export function cliTree(bin) {
  const r = spawnSync(bin, ['commands', '--json', '--hidden'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  if (r.status !== 0) throw new Error(`${bin} commands failed: ${r.stderr}`);
  return JSON.parse(r.stdout);
}

/** The commands a task needs that the CLI doesn't have. */
export function missingCommands(task, tree) {
  const names = new Set();
  for (const c of tree.commands) {
    names.add(c.name);
    for (const a of c.aliases ?? []) names.add([...c.path.slice(0, -1), a].join(' '));
  }
  // An alias anywhere along the path (kb sync is knowledge-bases sync)
  const spelt = (n) => n.split(' ').map((w, i, all) => tree.commands.find((c) => c.path.length === i + 1 && c.path.slice(0, -1).join(' ') === all.slice(0, i).join(' ') && (c.aliases ?? []).includes(w))?.path[i] ?? w).join(' ');
  return (task.needs ?? []).filter((n) => !names.has(n) && !names.has(spelt(n)));
}

/** The local sandbox: the mock on this machine, the agent's shell a bash process in the task's folder. */
export async function localSandbox({ bin }) {
  const mock = await startMock();
  return {
    mock,
    real: path.resolve(bin),
    tree: () => cliTree(bin),
    execFor: (cwd, env) => localExecutor({ cwd, env }),
    stop: () => mock.stop(),
  };
}

/**
 * The container sandbox (Dockerfile beside this file): the CLI, the mock and the agent's shell all inside one
 * container on an internal Docker network, so the agent's commands reach the mock and nothing else. The harness
 * controls the mock and runs the agent's commands with `docker exec`; the temporary folder is mounted at the same path
 * inside, so a task's folder is the same on both sides.
 */
export async function dockerSandbox({ image }) {
  const id = `caitlyn-agent-eval-${process.pid}`;
  const docker = (args, opts = {}) => spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...opts });
  const tmp = fs.realpathSync(os.tmpdir());
  let r = docker(['network', 'create', '--internal', id]);
  if (r.status !== 0) throw new Error(`docker network create failed: ${r.stderr}`);
  r = docker(['run', '-d', '--rm', '--name', id, '--network', id, '-v', `${tmp}:${tmp}`, image]);
  if (r.status !== 0) throw new Error(`docker run failed: ${r.stderr}`);
  const inside = (script, input) => docker(['exec', '-i', id, 'node', '-e', script], { input });
  // Wait for the mock inside to listen
  for (let i = 0; i < 100; i++) {
    if (inside("fetch('http://127.0.0.1:4010/__mock/requests').then(()=>process.exit(0),()=>process.exit(1))").status === 0) break;
    await new Promise((res) => setTimeout(res, 100));
  }
  const call = async (method, p, body, headers = {}) => {
    const req = JSON.stringify({ method, url: `http://127.0.0.1:4010${p}`, headers: { Authorization: 'Bearer pat_test', ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
    const out = inside("let d='';process.stdin.on('data',c=>d+=c).on('end',async()=>{const q=JSON.parse(d);const r=await fetch(q.url,q);process.stdout.write(JSON.stringify({status:r.status,body:await r.text()}))})", req);
    if (out.status !== 0) throw new Error(`the mock in the container: ${out.stderr}`);
    return JSON.parse(out.stdout);
  };
  const mock = {
    endpoint: 'http://127.0.0.1:4010',
    call,
    reset: () => call('POST', '/__mock/reset'),
    faults: (f) => call('POST', '/__mock/faults', f),
    requests: async () => JSON.parse((await call('GET', '/__mock/requests')).body),
    stop: () => {},
  };
  return {
    mock,
    real: '/opt/caitlyn/bin/caitlyn',
    tree: () => {
      const t = docker(['exec', id, '/opt/caitlyn/bin/caitlyn', 'commands', '--json', '--hidden']);
      if (t.status !== 0) throw new Error(`caitlyn commands in the container failed: ${t.stderr}`);
      return JSON.parse(t.stdout);
    },
    execFor: (cwd, env) => ({
      cwd,
      run(command) {
        const envArgs = Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]);
        const x = docker(['exec', '-w', cwd, ...envArgs, id, 'bash', '-c', command], { timeout: 300_000 });
        return { stdout: truncate(x.stdout ?? ''), stderr: truncate(x.stderr ?? ''), exitCode: x.status ?? 124 };
      },
    }),
    stop: () => {
      docker(['rm', '-f', id]);
      docker(['network', 'rm', id]);
    },
  };
}

/**
 * Prepares one run of a task in a sandbox: its folder, the arm's files, the mock's state. Returns what an agent needs
 * (the prompt and an executor) and `finish()`, which collects what the graders read.
 */
export async function prepareRun(task, { arm, sandbox, docs, workspace = 'your-company.caitlyn.ai' }) {
  const { mock } = sandbox;
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `agent-eval-${task.id}-`));
  const work = path.join(dir, 'project');
  const home = path.join(dir, 'home');
  const log = path.join(dir, 'log');
  for (const d of [work, home, log]) fs.mkdirSync(d, { recursive: true });
  const shimDir = path.join(dir, 'bin');
  writeShim(shimDir, sandbox.real);
  copyDocs(docs, path.join(work, 'docs'));
  await mock.reset();
  if (task.faults) await mock.faults(task.faults);
  for (const s of task.setup ?? []) {
    if (s.file) {
      fs.mkdirSync(path.dirname(path.join(work, s.file)), { recursive: true });
      fs.writeFileSync(path.join(work, s.file), s.text);
      continue;
    }
    // Set up the workspace the task finds, as a person changing it in the app would: whatever its version
    await mock.faults({ allowIfMatchWildcard: true });
    const r = await mock.call(s.method, s.path, s.body, { 'If-Match': '*' });
    await mock.faults({ allowIfMatchWildcard: false });
    if (r.status >= 400) throw new Error(`${task.id}: setting up ${s.method} ${s.path} failed with ${r.status}: ${r.body}`);
  }
  // What the agent's commands run with: agent mode, signed in to the mock, nothing from the caller's environment
  const env = {
    PATH: `${shimDir}${path.delimiter}/usr/local/bin${path.delimiter}/usr/bin${path.delimiter}/bin${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    CAITLYN_CONFIG_DIR: path.join(home, '.caitlyn'),
    CAITLYN_WORKSPACE: workspace,
    CAITLYN_ENDPOINT: mock.endpoint,
    CAITLYN_TOKEN: 'pat_test',
    CAITLYN_AGENT: '1',
    CAITLYN_TELEMETRY: '0',
    CAITLYN_EVAL_LOG: log,
    LANG: 'C.UTF-8',
  };
  // The person has let AI agents use everything the profile can (agent_scopes = "full"): the tasks change drafts,
  // versions and knowledge bases. A profile's default, read-only, would refuse every write before it was sent; the
  // safety tasks check what the agent asks for, not what the profile stops.
  fs.mkdirSync(env.CAITLYN_CONFIG_DIR, { recursive: true });
  fs.writeFileSync(path.join(env.CAITLYN_CONFIG_DIR, 'config'), '[profiles.default]\nagent_scopes = "full"\n');
  const exec = sandbox.execFor(work, env);
  if (arm === 'snippet') exec.run('caitlyn help agents --write > /dev/null');
  if (arm === 'skill') exec.run('caitlyn help agents --format skill --write > /dev/null');
  // Setting up the arm is not the agent's work: its commands and requests are left out
  for (const f of fs.readdirSync(log)) fs.rmSync(path.join(log, f));
  const before = (await mock.requests()).length;
  return {
    dir,
    work,
    exec,
    prompt: task.prompt,
    async finish() {
      const requests = (await mock.requests()).slice(before).filter((r) => r.method);
      const commands = readLog(log);
      return { requests, commands, files: (p) => (fs.existsSync(path.join(work, p)) ? fs.readFileSync(path.join(work, p), 'utf8') : null) };
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
