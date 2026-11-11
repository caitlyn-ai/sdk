// Task 3: change an agent safely. Reading and editing the draft work today; pin, publish, reset, compare and
// the version history arrive with lane S1, and conversations.ask with lane S2.
import { Caitlyn, PreconditionFailedError, ValidationError } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });

export async function addClauseNumbers(agentId: string): Promise<void> {
  const draft = await caitlyn.versions.get({ agentId, version: 'draft' });
  try {
    await caitlyn.versions.updateDraft(agentId, { instructions: `${draft.configuration.instructions}\nAlways state the policy clause number.` }, { ifMatch: draft.etag });
  } catch (err) {
    if (err instanceof PreconditionFailedError) return addClauseNumbers(agentId); // someone else changed it: read again
    if (err instanceof ValidationError) for (const e of err.errors ?? []) console.error(e.pointer, e.code, e.detail);
    throw err;
  }

  // Return a setting to its default
  const edited = await caitlyn.versions.get({ agentId, version: 'draft' });
  await caitlyn.versions.updateDraft(agentId, { clear: ['identity'] }, { ifMatch: edited.etag });
}
