// Task 3: change an agent safely: edit its draft with the ETag you read, then publish it.
import { Caitlyn, PreconditionFailedError, ValidationError } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });

export async function addClauseNumbers(agentId: string): Promise<void> {
  const agent = caitlyn.agents(agentId);
  const draft = await agent.draft.get();
  try {
    await agent.draft.update({ guidance: { instructions: `${draft.configuration?.guidance?.instructions ?? ''}\nAlways state the policy clause number.` } }, { ifMatch: draft.etag });
  } catch (err) {
    if (err instanceof PreconditionFailedError) return addClauseNumbers(agentId); // someone else changed it: read again
    if (err instanceof ValidationError) for (const e of err.errors ?? []) console.error(e.pointer, e.code, e.detail);
    throw err;
  }

  // Return a setting to its default
  const edited = await agent.draft.get();
  await agent.draft.update({ clear: ['guidance.identity'] }, { ifMatch: edited.etag });
  await agent.draft.publish({ name: 'clause-numbers', note: 'Answers state the policy clause number' });
}
