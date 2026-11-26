// The Ask Caitlyn evaluation for the CLI (the CLI design, 20.4): puts each question in questions.json to the
// ask.caitlyn.ai docs agent and grades its answer. Every `caitlyn …` in an answer must parse against the CLI's command
// tree (an invented command or flag fails the question), the answer must say what `expect` asks, and it must cite a CLI
// page; at least `threshold` of the answers must pass.
//
//   node cli/agent-eval/ask-caitlyn.mjs --bin build/cli/caitlyn --answers <answers.json>   grade answers already given
//   node cli/agent-eval/ask-caitlyn.mjs --bin build/cli/caitlyn --live                     ask the docs agent (nightly)
//
// --live asks through the TypeScript SDK, signed in with workload identity from CI (CAITLYN_ID_TOKEN, so no secret is
// stored), to the agent ASK_CAITLYN_AGENT in ASK_CAITLYN_WORKSPACE (ask.caitlyn.ai). It runs only with
// CAITLYN_ASK_EVAL_LIVE=1; nothing else here calls a live service.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { commandLineProblems, commandLines } from '../../scripts/docs-cli.mjs';
import { cliTree, here, repo } from './harness.mjs';
import { junit } from './eval.mjs';

export function loadQuestions(file = path.join(here, 'questions.json')) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/** Commands in an answer: its code (inline and blocks), and any line that starts with `caitlyn ` or `$ caitlyn `. */
export function answerCommands(text) {
  const out = new Set(commandLines(text));
  for (const line of text.split('\n')) {
    const m = /^\s*(?:\$\s+)?(caitlyn\s.*)$/.exec(line);
    if (m) out.add(m[1].trim());
  }
  return [...out];
}

/** Grades one answer: { text, citations: [{ sourceUrl }] }. */
export function gradeAnswer(q, answer, tree) {
  const text = answer?.text ?? '';
  const lower = text.toLowerCase();
  const problems = [];
  for (const line of answerCommands(text)) for (const p of commandLineProblems(line, tree, { pending: {} })) problems.push(`invented: ${p}`);
  for (const s of q.expect.includes ?? []) if (!lower.includes(s.toLowerCase())) problems.push(`does not say ${s}`);
  for (const any of q.expect.includesAny ?? []) if (!any.some((s) => lower.includes(s.toLowerCase()))) problems.push(`says none of ${any.join(', ')}`);
  const urls = (answer?.citations ?? []).map((c) => c.sourceUrl ?? c.url ?? '');
  // cites may name a section (/how-to-integrate/#choose-...): a citation of its page counts, with or without the anchor
  if (!urls.some((u) => u.includes('/cli/') || (q.cites && u.includes(q.cites.split('#')[0])))) problems.push('cites no CLI page');
  return { id: q.id, type: q.type, pass: !problems.length, problems };
}

/** Grades every answer; answers are by question id. */
export function gradeAll(set, answers, tree) {
  const results = set.questions.map((q) => (answers[q.id] ? gradeAnswer(q, answers[q.id], tree) : { id: q.id, type: q.type, pass: false, problems: ['no answer'] }));
  const rate = results.filter((r) => r.pass).length / (results.length || 1);
  return { results, rate, pass: rate >= set.threshold };
}

/** Asks the docs agent every question, through the TypeScript SDK. */
async function askLive(set) {
  if (process.env.CAITLYN_ASK_EVAL_LIVE !== '1') throw new Error('--live asks a live workspace: set CAITLYN_ASK_EVAL_LIVE=1 (the nightly job does)');
  const { Caitlyn } = await import(path.join(repo, 'typescript/packages/sdk/dist-es/sdk/index.mjs'));
  const caitlyn = new Caitlyn({ workspace: process.env.ASK_CAITLYN_WORKSPACE ?? 'ask.caitlyn.ai', auth: { mode: 'workloadIdentity', token: () => process.env.CAITLYN_ID_TOKEN } });
  const agent = process.env.ASK_CAITLYN_AGENT;
  if (!agent) throw new Error('ASK_CAITLYN_AGENT names the docs agent');
  const answers = {};
  for (const q of set.questions) {
    const conversation = await caitlyn.agents(agent).live.conversations.create({ title: `CLI evaluation: ${q.id}` });
    const message = await caitlyn.conversations(conversation.id).send(q.question).finalMessage();
    answers[q.id] = { text: message.text, citations: (message.citations ?? []).map((c) => ({ sourceUrl: c.sourceUrl, documentName: c.documentName })) };
  }
  return answers;
}

async function main() {
  const args = process.argv.slice(2);
  const opt = (n) => (args.includes(`--${n}`) ? args[args.indexOf(`--${n}`) + 1] : undefined);
  const bin = opt('bin');
  if (!bin || (!args.includes('--live') && !opt('answers'))) {
    console.error('usage: node cli/agent-eval/ask-caitlyn.mjs --bin <caitlyn> (--answers <file> | --live) [--out build/ask-caitlyn-eval]');
    process.exit(2);
  }
  const set = loadQuestions();
  const answers = args.includes('--live') ? await askLive(set) : JSON.parse(fs.readFileSync(opt('answers'), 'utf8'));
  const graded = gradeAll(set, answers, cliTree(bin));
  const out = path.resolve(opt('out') ?? path.join(repo, 'build/ask-caitlyn-eval'));
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify({ ...graded, answers }, null, 2) + '\n');
  fs.writeFileSync(path.join(out, 'junit.xml'), junit(graded.results.map((r) => ({ arm: 'ask-caitlyn', group: r.type, task: r.id, run: 1, success: r.pass, graders: r.problems.map((p) => ({ type: 'answer', pass: false, why: p })), safety: [] })), { name: 'ask-caitlyn-cli' }));
  for (const r of graded.results) console.log(`${r.pass ? 'pass' : 'FAIL'}  ${r.id}${r.pass ? '' : `: ${r.problems.join('; ')}`}`);
  console.log(`ask-caitlyn: ${(graded.rate * 100).toFixed(0)}% of answers correct and cited (threshold ${set.threshold * 100}%)`);
  if (!graded.pass) process.exit(1);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
