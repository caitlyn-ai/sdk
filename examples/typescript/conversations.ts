// The developer docs show these regions: get-caller on Getting started, get-agent-version, create-conversation
// and send-message on the Ask an agent guide, and watch-conversation, watch-workspace-events and stream-reset on
// Streaming. Each also runs against a real server (scripts/examples-live/typescript.sh), so the code the docs
// show is code that ran.
import { Caitlyn, type WorkspaceEvent } from '@caitlyn-ai/sdk';

/** The client every example below takes (the live checks make their own, pointed at the server under test). */
export function createClient() {
  // #region client
  const caitlyn = new Caitlyn({
    workspace: 'your-company.getcaitlyn.ai',
    auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
  });
  // #endregion
  return caitlyn;
}

/** Who the credential belongs to, its kind, its scopes and its organisation. */
export async function getCaller(caitlyn: Caitlyn) {
  // #region get-caller
  // Check the credential before doing anything else: any valid credential may call this
  const me = await caitlyn.callers.get({});
  console.log(`${me.displayName} (${me.credential}) in ${me.organisation.name}; scopes: ${me.scopes.join(' ')}`);
  // #endregion
  return me;
}

/** The draft version of an agent: its configuration, and the ETag a change sends back. */
export async function getAgentVersion(caitlyn: Caitlyn, agentId: string) {
  // #region get-agent-version
  const draft = await caitlyn.agents.versions.get({ agentId, version: 'draft' });
  console.log(draft.configuration.instructions, draft.etag);
  // #endregion
  return draft;
}

/** A new conversation with the draft of an agent. */
export async function createConversation(caitlyn: Caitlyn, agentId: string) {
  // #region create-conversation
  // Only the draft can answer for now; production and named versions arrive with agent versions
  const conversation = await caitlyn.conversations.create({ agentId, version: 'draft', title: 'Annual leave' });
  console.log(conversation.id, conversation.createdAt);
  // #endregion
  return conversation;
}

/** Asks a question and streams the answer as it is written. */
export async function sendMessage(caitlyn: Caitlyn, conversationId: string) {
  // #region send-message
  const stream = caitlyn.conversations.send(conversationId, { message: 'How many days of annual leave do staff get?' });
  for await (const event of stream) {
    if (event.type === 'text.delta') process.stdout.write(event.delta);
  }
  // The answer as a whole: its text, citations and the agent version that wrote it
  const answer = await stream.finalMessage();
  console.log(`\n${answer.citations?.length ?? 0} citations`);
  // #endregion
  return answer;
}

/** Watches a conversation while an answer is written, and stops once it is complete. */
export async function watchConversation(caitlyn: Caitlyn, conversationId: string) {
  // #region watch-conversation
  // Open the watch first; the answer could come from anywhere (another tab, another service): here it is sent below
  const watch = caitlyn.conversations.watch(conversationId, {});
  await watch.opened();
  const answer = caitlyn.conversations.send(conversationId, { message: 'Does that include public holidays?' }).finalMessage();
  let watched;
  for await (const event of watch) {
    // A watch can begin with an answer already in the conversation: wait for the one you are interested in
    if (event.type === 'message.completed' && event.message.id === (await answer).id) {
      watched = event.message;
      break; // a watch stays open across answers, and reconnects by itself: stop at the event you wait for
    }
  }
  // #endregion
  return { watched, answer: await answer };
}

/** Waits for the workspace event a call of your own causes: a new conversation. */
export async function watchWorkspaceEvents(caitlyn: Caitlyn, agentId: string) {
  // #region watch-workspace-events
  // Open the stream first, then make the call, so the event cannot arrive before you listen
  const listening = new AbortController();
  const events = caitlyn.events.subscribe({ types: ['conversation.created'] }, { signal: listening.signal });
  try {
    await events.opened(); // the response headers have arrived: the stream is listening
    const conversation = await caitlyn.conversations.create({ agentId, version: 'draft' });
    for await (const event of events) {
      if (event.type === 'conversation.created' && event.data.id === conversation.id) {
        console.log(`created ${event.data.id} at ${event.occurredAt}; carry on from ${event.eventId}`);
        return { conversation, created: event };
      }
    }
    return { conversation, created: undefined }; // the stream ended first
  } finally {
    listening.abort(); // closes the stream
  }
  // #endregion
}

/**
 * Carries on from a saved cursor. A cursor the stream cannot carry on from (too old, or not one it knows) is
 * answered with stream.reset, delivered as an event, with the cursor to carry on from.
 */
export async function followEvents(
  caitlyn: Caitlyn,
  savedCursor: string,
  handle: (event: WorkspaceEvent) => void | Promise<void>,
  resync: () => Promise<void>,
) {
  // #region stream-reset
  let cursor = savedCursor; // the last event's eventId, saved between runs
  for await (const event of caitlyn.events.subscribe({ types: ['conversation.created'], after: cursor })) {
    if (event.type === 'stream.reset') {
      // Events since the saved cursor are not replayed: re-read what you depend on, then carry on
      await resync();
    }
    cursor = event.eventId ?? cursor; // a stream.reset's eventId is its new cursor
    await handle(event);
  }
  // #endregion
  return cursor;
}
