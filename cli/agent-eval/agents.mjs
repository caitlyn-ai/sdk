// The agents the evaluation can run (the CLI design, 20.3):
//   scripted   plays each task's reference solution through the same shell, offline: the harness's own tests, and a
//              check that every reference solution still works against the CLI and the mock
//   claude     Claude, through the Anthropic Messages API, with one tool, a shell in the task's folder. It calls a model
//              API, so it runs only when CAITLYN_AGENT_EVAL_LIVE=1 and ANTHROPIC_API_KEY are set (the CI jobs' variables)
// and the judge for the rubric-graded tasks, the same API with a fixed rubric.

export const LIVE = () => process.env.CAITLYN_AGENT_EVAL_LIVE === '1' && !!process.env.ANTHROPIC_API_KEY;

/** Plays the task's reference solution: its commands in one shell session (variables carry over), then its answer. */
export function scriptedAgent({ mistakes = {} } = {}) {
  return {
    name: 'scripted',
    async run(task, { exec }) {
      const m = mistakes[task.id];
      const commands = m?.commands ?? task.reference?.commands ?? [];
      const transcript = [];
      if (commands.length) {
        const r = exec.run(commands.join('\n'));
        transcript.push({ command: commands.join('\n'), ...r });
      }
      return { answer: m?.answer ?? task.reference?.answer ?? '', transcript };
    },
  };
}

const SYSTEM = (arm) =>
  [
    'You are an AI coding agent working in a project folder, with a shell tool. The caitlyn CLI is installed and signed in to the',
    "person's Caitlyn workspace. The workspace's developer docs are in ./docs as Markdown (start with docs/llms.txt).",
    arm === 'snippet' ? 'The project has an AGENTS.md.' : '',
    arm === 'skill' ? 'The project has a Claude Code skill for the CLI in .claude/skills/caitlyn/SKILL.md.' : '',
    'Do what the person asks. When you are done, reply with your final answer to them, without calling a tool.',
  ]
    .filter(Boolean)
    .join(' ');

const TOOL = {
  name: 'shell',
  description: 'Run a bash command in the project folder. Returns its stdout, stderr and exit code.',
  input_schema: { type: 'object', properties: { command: { type: 'string', description: 'The command to run' } }, required: ['command'] },
};

async function messages(body, { fetchImpl = fetch } = {}) {
  const r = await fetchImpl(process.env.ANTHROPIC_BASE_URL ? `${process.env.ANTHROPIC_BASE_URL}/v1/messages` : 'https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`the model API answered ${r.status}: ${text.slice(0, 500)}`);
  return JSON.parse(text);
}

/**
 * Claude with a shell. `model` is the model to run (CLI_AGENT_EVAL_MODEL in CI). Refuses to start unless the live run
 * is switched on, so no test or local run calls a model by accident. `fetchImpl` is for tests.
 */
export function claudeAgent({ model, maxTurns = 30, maxTokens = 4096, fetchImpl, allowOffline = false } = {}) {
  if (!allowOffline && !LIVE()) throw new Error('the claude agent calls a model API: set CAITLYN_AGENT_EVAL_LIVE=1 and ANTHROPIC_API_KEY to run it');
  if (!model) throw new Error('the claude agent needs a model (--model, or CLI_AGENT_EVAL_MODEL)');
  return {
    name: `claude:${model}`,
    async run(task, { exec, arm }) {
      const msgs = [{ role: 'user', content: task.prompt }];
      const transcript = [];
      for (let turn = 0; turn < maxTurns; turn++) {
        const res = await messages({ model, max_tokens: maxTokens, system: SYSTEM(arm), tools: [TOOL], messages: msgs }, { fetchImpl });
        msgs.push({ role: 'assistant', content: res.content });
        const calls = res.content.filter((c) => c.type === 'tool_use');
        if (!calls.length || res.stop_reason !== 'tool_use') {
          const answer = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
          transcript.push({ answer });
          return { answer, transcript };
        }
        const results = [];
        for (const call of calls) {
          const r = exec.run(String(call.input?.command ?? ''));
          transcript.push({ command: call.input?.command, ...r });
          results.push({ type: 'tool_result', tool_use_id: call.id, content: `exit code ${r.exitCode}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}` });
        }
        msgs.push({ role: 'user', content: results });
      }
      return { answer: '', transcript, gaveUp: true };
    },
  };
}

/** The judge for rubric-graded tasks: the model reads the rubric, the request and the answer, and says PASS or FAIL. */
export function claudeJudge({ model, fetchImpl, allowOffline = false } = {}) {
  if (!allowOffline && !LIVE()) return null;
  return async (rubric, run) => {
    const res = await messages(
      {
        model,
        max_tokens: 300,
        system: 'You grade an AI agent\'s answer against a rubric. Reply with PASS or FAIL on the first line, then one sentence why.',
        messages: [{ role: 'user', content: `Rubric: ${rubric}\n\nCommands the agent ran:\n${run.commands.map((c) => `caitlyn ${c.argv.join(' ')}`).join('\n') || '(none)'}\n\nThe agent's answer:\n${run.answer}` }],
      },
      { fetchImpl },
    );
    const text = res.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n').trim();
    return { pass: /^PASS\b/.test(text), why: text.split('\n').slice(1).join(' ').trim() };
  };
}
