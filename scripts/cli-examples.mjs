// Runs every CLI example (examples/cli/*.sh) against the conformance mock server and compares what it prints with its
// committed transcript (examples/cli/<name>.out), as the CLI design's docs coverage asks (20.1, 17.2): the sessions the
// docs show are the sessions the CLI gives. Each example runs in a clean environment (no CI or AI-agent markers, no
// colour, no telemetry, a fresh home), signed in to the mock with a token, after the mock's state is reset.
//
// An example that names commands this CLI doesn't have yet (a `# needs: <command>` line) is skipped, and listed, until
// the CLI has them; then its transcript must exist.
//
//   node scripts/cli-examples.mjs --bin build/cli/caitlyn            check every example
//   node scripts/cli-examples.mjs --bin build/cli/caitlyn --update   write the transcripts
//   node scripts/cli-examples.mjs --bin … change-an-agent             only the examples named
//
// scripts/cli-examples.sh builds the CLI and runs this (make cli-examples).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(import.meta.dirname, '..');
export const EXAMPLES = path.join(root, 'examples/cli');

/** The commands an example needs that it names with `# needs:` lines. */
export function needs(script) {
  return [...script.matchAll(/^# needs: (.+)$/gm)].flatMap((m) => m[1].split(',').map((s) => s.trim()).filter(Boolean));
}

/**
 * What changes from run to run, made stable for the transcript: identifiers the mock makes up (UUIDs, request IDs),
 * times, temporary folders and the mock's port.
 */
export function normalise(text, { port, tmp = [] } = {}) {
  let out = text;
  for (const t of tmp) if (t) out = out.split(t).join('<tmp>');
  if (port) out = out.split(`127.0.0.1:${port}`).join('127.0.0.1:<port>');
  return out
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<uuid>')
    .replace(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g, '<request-id>')
    // the mock names new documents at random
    .replace(/\bdoc-[0-9a-f]{8}\b/g, '<document-id>')
    .replace(/\bconv-[0-9a-f]{8}\b/g, '<conversation-id>')
    .replace(/("requestId":\s*")[^"]+(")/g, '$1<request-id>$2')
    .replace(/\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g, (t) => (t.startsWith('2026-11-0') ? t : '<time>'))
    .replace(/\/(?:private\/)?(?:var\/folders|tmp)\/[^\s"']+/g, '<tmp>')
    .replace(/[ \t]+$/gm, '');
}

/** A free port on the loopback interface. */
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

/** Starts the mock server; resolves when it listens. */
export async function startMock() {
  const port = await freePort();
  // The mock's clock is fixed two minutes before the moment the examples measure relative times from
  // (CAITLYN_DISPLAY_NOW in examples/cli/), so "2 minutes ago" is what a transcript always says
  const child = spawn(process.execPath, [path.join(root, 'conformance/mock-server/server.mjs')], { env: { ...process.env, PORT: String(port), MOCK_NOW: '2026-11-06T08:58:00.000Z' }, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the mock server did not start within 10 s')), 10_000);
    child.stdout.on('data', (d) => {
      if (/listening/.test(String(d))) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.on('exit', (code) => reject(new Error(`the mock server exited with ${code}`)));
  });
  return {
    port,
    base: `http://127.0.0.1:${port}`,
    reset: () => fetch(`http://127.0.0.1:${port}/__mock/reset`, { method: 'POST' }),
    stop: () => child.kill(),
  };
}

/** The environment an example runs in: nothing from the caller's but PATH, so a CI or AI-agent marker can't change it. */
export function cleanEnv({ bin, base, home }) {
  return {
    PATH: `${path.dirname(path.resolve(bin))}${path.delimiter}${process.env.PATH ?? ''}`,
    HOME: home,
    CAITLYN_CONFIG_DIR: path.join(home, '.caitlyn'),
    CAITLYN_WORKSPACE: 'your-company.caitlyn.ai',
    CAITLYN_ENDPOINT: base,
    CAITLYN_TOKEN: 'pat_test',
    CAITLYN_TELEMETRY: '0',
    NO_COLOR: '1',
    LANG: 'C.UTF-8',
    TZ: 'UTC',
  };
}

/** The commands the CLI has, by name, as `caitlyn commands` lists them (aliases spelt out: kb sync is knowledge-bases
 * sync, and either spelling is accepted). */
function commandNames(bin) {
  const r = spawnSync(bin, ['commands', '--json', '--hidden'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: os.tmpdir() } });
  if (r.status !== 0) throw new Error(`${bin} commands failed: ${r.stderr}`);
  const names = new Set();
  for (const c of JSON.parse(r.stdout).commands) {
    names.add(c.name);
    // Each alias of each word along the path
    const parents = JSON.parse(r.stdout).commands;
    const spellings = c.path.map((word, i) => [word, ...(parents.find((p) => p.name === c.path.slice(0, i + 1).join(' '))?.aliases ?? [])]);
    const expand = (i, prefix) => (i === spellings.length ? [prefix.join(' ')] : spellings[i].flatMap((w) => expand(i + 1, [...prefix, w])));
    for (const n of expand(0, [])) names.add(n);
  }
  return names;
}

/** Runs one example; returns its transcript: what it printed, stdout and stderr in order, and its exit code. */
export async function runExample(file, { bin, mock }) {
  await mock.reset();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'caitlyn-example-'));
  try {
    const r = spawnSync('bash', ['-c', `bash ${JSON.stringify(file)} 2>&1`], { env: cleanEnv({ bin, base: mock.base, home }), encoding: 'utf8', timeout: 120_000, cwd: home });
    const text = `${r.stdout ?? ''}${r.error ? `\n${r.error.message}\n` : ''}[exit ${r.status}]\n`;
    return normalise(text, { port: mock.port, tmp: [home, fs.realpathSync(home)] });
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function main() {
  const args = process.argv.slice(2);
  const bin = args[args.indexOf('--bin') + 1];
  if (!args.includes('--bin') || !bin || !fs.existsSync(bin)) {
    console.error('usage: node scripts/cli-examples.mjs --bin <caitlyn binary> [--update] [example ...]');
    process.exit(2);
  }
  const update = args.includes('--update');
  const only = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--bin');
  const files = fs.readdirSync(EXAMPLES).filter((f) => f.endsWith('.sh') && (!only.length || only.includes(f.replace(/\.sh$/, '')))).sort();
  const known = commandNames(bin);
  const mock = await startMock();
  let failed = 0;
  const skipped = [];
  try {
    for (const f of files) {
      const file = path.join(EXAMPLES, f);
      const missing = needs(fs.readFileSync(file, 'utf8')).filter((c) => !known.has(c));
      const outFile = file.replace(/\.sh$/, '.out');
      if (missing.length) {
        skipped.push(`${f} (needs caitlyn ${missing.join(', caitlyn ')})`);
        continue;
      }
      const got = await runExample(file, { bin, mock });
      if (update) {
        fs.writeFileSync(outFile, got);
        console.log(`wrote examples/cli/${path.basename(outFile)}`);
        continue;
      }
      if (!fs.existsSync(outFile)) {
        console.error(`examples/cli/${f}: no transcript; run node scripts/cli-examples.mjs --bin … --update ${f.replace(/\.sh$/, '')}`);
        failed++;
        continue;
      }
      const want = fs.readFileSync(outFile, 'utf8');
      if (got !== want) {
        failed++;
        console.error(`examples/cli/${f}: its output differs from examples/cli/${path.basename(outFile)}`);
        const a = want.split('\n');
        const b = got.split('\n');
        for (let i = 0; i < Math.max(a.length, b.length); i++) {
          if (a[i] !== b[i]) {
            console.error(`  line ${i + 1}\n    want: ${a[i] ?? '(nothing)'}\n    got:  ${b[i] ?? '(nothing)'}`);
            break;
          }
        }
      } else console.log(`ok  examples/cli/${f}`);
    }
  } finally {
    mock.stop();
  }
  for (const s of skipped) console.log(`skip examples/cli/${s}`);
  if (failed) process.exit(1);
  console.log(`cli-examples: ${files.length - skipped.length} examples match their transcripts; ${skipped.length} wait for commands this CLI doesn't have yet`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
