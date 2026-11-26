// The model-backed agent and judge, against a fake Messages API: the tool loop, and that neither runs by accident.
import assert from 'node:assert/strict';
import test from 'node:test';
import { claudeAgent, claudeJudge, scriptedAgent } from '../agents.mjs';

const fakeApi = (replies) => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const body = replies.shift();
    return { ok: true, status: 200, text: async () => JSON.stringify(body) };
  };
  return { calls, fetchImpl };
};

test('the claude agent refuses to start unless the live run is switched on', () => {
  const saved = process.env.CAITLYN_AGENT_EVAL_LIVE;
  delete process.env.CAITLYN_AGENT_EVAL_LIVE;
  assert.throws(() => claudeAgent({ model: 'claude-sonnet-5-5' }), /CAITLYN_AGENT_EVAL_LIVE/);
  assert.equal(claudeJudge({ model: 'x' }), null);
  if (saved !== undefined) process.env.CAITLYN_AGENT_EVAL_LIVE = saved;
});

test('the claude agent runs each shell call and returns the final answer', async () => {
  const { calls, fetchImpl } = fakeApi([
    { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Looking.' }, { type: 'tool_use', id: 't1', name: 'shell', input: { command: 'caitlyn agents list' } }] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'The HR assistant is GHT7YRWXPL.' }] },
  ]);
  const ran = [];
  const exec = { run: (c) => (ran.push(c), { stdout: '{"items":[]}', stderr: '', exitCode: 0 }) };
  const agent = claudeAgent({ model: 'claude-sonnet-5-5', fetchImpl, allowOffline: true });
  const out = await agent.run({ prompt: 'Which agents are there?' }, { exec, arm: 'snippet' });
  assert.deepEqual(ran, ['caitlyn agents list']);
  assert.equal(out.answer, 'The HR assistant is GHT7YRWXPL.');
  assert.equal(calls[0].model, 'claude-sonnet-5-5');
  assert.match(calls[0].system, /AGENTS\.md/);
  assert.equal(calls[1].messages.at(-1).content[0].tool_use_id, 't1');
  assert.match(calls[1].messages.at(-1).content[0].content, /exit code 0/);
});

test('the judge reads PASS or FAIL', async () => {
  const { fetchImpl } = fakeApi([{ content: [{ type: 'text', text: 'PASS\nIt recommends the MCP server.' }] }]);
  const judge = claudeJudge({ model: 'x', fetchImpl, allowOffline: true });
  assert.deepEqual(await judge('rubric', { commands: [], answer: 'a' }), { pass: true, why: 'It recommends the MCP server.' });
});

test('the scripted agent plays the reference in one shell session', async () => {
  const ran = [];
  const out = await scriptedAgent().run({ id: 't', reference: { commands: ['a=1', 'echo $a'], answer: 'done' } }, { exec: { run: (c) => (ran.push(c), { stdout: '', stderr: '', exitCode: 0 }) } });
  assert.deepEqual(ran, ['a=1\necho $a']);
  assert.equal(out.answer, 'done');
});
