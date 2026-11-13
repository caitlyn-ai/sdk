// Task 1: ask an agent a question and stream a cited, multi-turn answer.
// conversations.create is not in the model yet; until it is, this starts from an existing conversation.
import { Caitlyn } from '@caitlyn-ai/sdk';

const service = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'clientCredentials', clientId: process.env.CAITLYN_CLIENT_ID!, clientSecret: process.env.CAITLYN_CLIENT_SECRET! },
});
declare function showChip(event: { label: string; status?: string }): void;

export async function ask(conversationId: string): Promise<void> {
  const controller = new AbortController();
  const stream = service.conversations.send(
    conversationId,
    { message: 'How many days of annual leave do staff get?', context: [{ type: 'page', label: 'Leave request form', data: { formId: 'LR-2231' } }] },
    { signal: controller.signal },
  );

  for await (const event of stream) {
    if (event.type === 'text.delta') process.stdout.write(event.delta);
    if (event.type === 'citation.added') console.log(`\n[${event.citation.number}] ${event.citation.documentName} p.${event.citation.pageNumber}`);
    if (event.type === 'tool.finished') console.log(`\n${event.toolName} ${event.status}`);
    if (event.type === 'progress.updated') showChip(event);
  }
  const answer = await stream.finalMessage(); // Message, with answer.citations and answer.agentVersion
  console.log(answer.agentVersion, answer.citations?.length);

  // Follow-up in the same conversation; history is held server-side
  const followUp = await service.conversations.send(conversationId, { message: 'Does that include public holidays?' }).finalMessage();
  console.log(followUp.text);
}
