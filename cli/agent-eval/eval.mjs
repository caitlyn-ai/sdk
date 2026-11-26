// The CLI's agent evaluation (the CLI design, 20.3): runs the task set against the CLI and the mock server, with an
// agent, in one or more arms, grades every run and checks the thresholds. Writes a JUnit report (failures show in the
// merge request) and a JSON report with every transcript.
//
//   node cli/agent-eval/eval.mjs --bin build/cli/caitlyn --agent scripted                  offline: the reference solutions
//   node cli/agent-eval/eval.mjs --bin … --agent claude --model <id> --fast                 the merge request's subset
//   node cli/agent-eval/eval.mjs --bin … --agent claude --model <id> --arms docs,snippet,skill --runs 3   nightly
//
// Options: --docs <the built site, build/docs/site> --out <folder, build/agent-eval> --executor local|docker
// --image <the evaluation image, for docker> --tasks <id,id> --judge-model <id>. The claude agent and judge call a model
// API and run only with CAITLYN_AGENT_EVAL_LIVE=1 and ANTHROPIC_API_KEY set. Exit code 1 when a threshold is missed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { claudeAgent, claudeJudge, scriptedAgent } from './agents.mjs';
import { grade, summarise } from './graders.mjs';
import { ARMS, dockerSandbox, loadTasks, localSandbox, missingCommands, prepareRun, repo } from './harness.mjs';

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The JUnit report: a suite per arm, a case per task and run. */
export function junit(results, { name = 'cli-agent-eval' } = {}) {
  const arms = [...new Set(results.map((r) => r.arm))];
  const suites = arms.map((arm) => {
    const rs = results.filter((r) => r.arm === arm);
    const cases = rs.map((r) => {
      const why = [...r.graders.filter((g) => !g.pass).map((g) => `${g.type}: ${g.why}`), ...r.safety.map((s) => `safety: ${s}`)].join('\n');
      return `    <testcase classname="${xml(`${name}.${arm}.${r.group}`)}" name="${xml(`${r.task} #${r.run}`)}" time="${(r.seconds ?? 0).toFixed(1)}">${r.success ? '' : `\n      <failure message="${xml(why.split('\n')[0] || 'failed')}">${xml(why)}</failure>\n    `}</testcase>`;
    });
    return `  <testsuite name="${xml(`${name} (${arm})`)}" tests="${rs.length}" failures="${rs.filter((r) => !r.success).length}">\n${cases.join('\n')}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}">\n${suites.join('\n')}\n</testsuites>\n`;
}

/** Runs the evaluation; returns { results, summary, skipped }. */
export async function evaluate({ bin, agent, arms = ['docs'], runs = 1, fast = false, only = null, docs = null, executor = 'local', image, judge = null, tasksFile, log = () => {} }) {
  const set = loadTasks(tasksFile);
  const sandbox = executor === 'docker' ? await dockerSandbox({ image }) : await localSandbox({ bin });
  const tree = sandbox.tree();
  let tasks = set.tasks.filter((t) => (!fast || t.fast) && (!only || only.includes(t.id)));
  const skipped = [];
  tasks = tasks.filter((t) => {
    const missing = missingCommands(t, tree);
    if (missing.length) skipped.push({ task: t.id, needs: missing });
    return !missing.length;
  });
  const results = [];
  try {
    for (const arm of arms) {
      if (!ARMS[arm]) throw new Error(`no arm ${arm}: use ${Object.keys(ARMS).join(', ')}`);
      for (const task of tasks) {
        for (let run = 1; run <= runs; run++) {
          const started = Date.now();
          const prepared = await prepareRun(task, { arm, sandbox, docs });
          let out;
          try {
            out = await agent.run(task, { exec: prepared.exec, arm });
          } catch (err) {
            out = { answer: '', transcript: [{ error: String(err?.message ?? err) }] };
          }
          const collected = await prepared.finish();
          const graded = await grade(task, { ...collected, answer: out.answer }, { tree, judge });
          results.push({ ...graded, arm, run, seconds: (Date.now() - started) / 1000, answer: out.answer, transcript: out.transcript, commandsRun: collected.commands, requests: collected.requests.map((r) => ({ method: r.method, path: r.path, status: r.status })) });
          log(`${graded.success ? 'pass' : 'FAIL'}  ${arm.padEnd(7)} ${task.id} #${run}${graded.success ? '' : `: ${[...graded.graders.filter((g) => !g.pass).map((g) => g.why), ...graded.safety].join('; ')}`}`);
          prepared.cleanup();
        }
      }
    }
  } finally {
    sandbox.stop();
  }
  return { results, summary: summarise(results, set.thresholds), skipped };
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
  const bin = opt('bin');
  if (!bin || !fs.existsSync(bin)) {
    console.error('usage: node cli/agent-eval/eval.mjs --bin <caitlyn> [--agent scripted|claude] [--model <id>] [--fast] [--arms docs,snippet,skill] [--runs n] [--docs build/docs/site] [--out build/agent-eval]');
    process.exit(2);
  }
  const which = opt('agent', 'scripted');
  const model = opt('model', process.env.CLI_AGENT_EVAL_MODEL);
  const agent = which === 'claude' ? claudeAgent({ model }) : scriptedAgent();
  const judge = which === 'claude' ? claudeJudge({ model: opt('judge-model', model) }) : null;
  const out = path.resolve(opt('out', path.join(repo, 'build/agent-eval')));
  const { results, summary, skipped } = await evaluate({
    bin,
    agent,
    judge,
    arms: opt('arms', 'docs').split(','),
    runs: Number(opt('runs', '1')),
    fast: args.includes('--fast'),
    only: opt('tasks') ? opt('tasks').split(',') : null,
    docs: opt('docs', fs.existsSync(path.join(repo, 'build/docs/site')) ? path.join(repo, 'build/docs/site') : null),
    executor: opt('executor', 'local'),
    image: opt('image'),
    log: (l) => console.log(l),
  });
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'junit.xml'), junit(results));
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ agent: agent.name, summary, skipped, results }, null, 2) + '\n');
  for (const s of skipped) console.log(`skip  ${s.task}: needs caitlyn ${s.needs.join(', caitlyn ')}`);
  const m = summary.measures;
  console.log(`\n${agent.name}: ${m.runs} runs; success ${Object.entries(m.success).map(([g, v]) => `${g} ${(v * 100).toFixed(0)}%`).join(', ')}; median commands ${m.commandsRatioMedian.toFixed(2)}× the reference; ${m.wrongFlagsPerTask.toFixed(2)} wrong flags and ${m.inventedCommandsPerTask.toFixed(2)} invented commands per task; ${m.safetyViolations} safety violations; hints followed ${m.hintsFollowed} of ${m.hints}`);
  for (const f of summary.failures) console.error(`threshold missed: ${f}`);
  console.log(`reports: ${path.relative(repo, out)}/junit.xml and report.json`);
  if (!summary.pass) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
