// The code on the developer docs' Errors, Retries, Streaming, Pagination and Telemetry pages (docs/*.md), one
// region each. scripts/test-typescript.sh type-checks this file against the SDK.
import { trace } from '@opentelemetry/api';
import { Caitlyn, CaitlynConnectionError, CaitlynError, NotFoundError, ValidationError } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });
const agentId = 'GHT7YRWXPL';
const conversationId = '0193a6f2-7c4e-7b1a-9d2e-3f5a8c1b0e47';

export async function errors(): Promise<void> {
  // #region errors
  try {
    await caitlyn.versions.get({ agentId, version: 'v99' });
  } catch (err) {
    if (err instanceof NotFoundError) {
      console.log('No such version');
    } else if (err instanceof ValidationError) {
      for (const e of err.errors ?? []) console.error(e.pointer, e.code, e.detail);
    } else if (err instanceof CaitlynConnectionError) {
      console.error('No response from Caitlyn:', err.cause); // after the SDK's retries
    } else if (err instanceof CaitlynError) {
      // Any other status. code is the stable product code; quote requestId to support.
      console.error(err.status, err.code, err.detail, err.requestId);
      if (err.code.startsWith('HTTP_')) console.error(err.rawBody); // not a Caitlyn error body: a proxy's page, say
    } else {
      throw err;
    }
  }
  // #endregion
}

export function retries(): Caitlyn {
  // #region retries
  const patient = new Caitlyn({
    workspace: 'your-company.getcaitlyn.ai',
    auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
    maxAttempts: 5, // the first attempt included; default 3
    maxRetryDelayMs: 120_000, // the longest Retry-After to wait for; default 60 seconds
  });
  // #endregion
  return patient;
}

export function retryBudget(): Caitlyn {
  // #region retry-budget
  const batch = new Caitlyn({
    workspace: 'your-company.getcaitlyn.ai',
    auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
    retryBudget: 2_000, // retry tokens shared by every call on this client; default 500, and 0 turns retries off
  });
  // #endregion
  return batch;
}

export async function streaming(): Promise<void> {
  // #region streaming
  const stream = caitlyn.conversations.send(conversationId, { message: 'How much annual leave do part-time staff get?' });
  for await (const event of stream) {
    switch (event.type) {
      case 'text.delta':
        process.stdout.write(event.delta);
        break;
      case 'citation.added':
        console.log(`\n[${event.citation.number}] ${event.citation.documentName}`);
        break;
    }
  }
  const answer = await stream.finalMessage(); // the complete message, with its citations
  console.log(answer.id, stream.requestId);
  // #endregion
}

export async function cancelling(): Promise<void> {
  // #region cancelling
  // Give up after 30 seconds: the connection closes and the loop throws the signal's reason
  const stream = caitlyn.conversations.send(conversationId, { message: 'Summarise the leave policy.' }, { signal: AbortSignal.timeout(30_000) });
  for await (const event of stream) if (event.type === 'text.delta') process.stdout.write(event.delta);
  // #endregion
}

export async function pagination(): Promise<void> {
  // #region pagination
  // Every document in the folder: the next page is fetched as the loop reaches it
  for await (const document of caitlyn.documents.list({ knowledgeBaseId: 'KB4T7YQ2WL', folder: 'hr/', limit: 100 })) {
    console.log(document.name, document.status);
  }
  // #endregion
}

export function telemetry(): Caitlyn {
  // #region telemetry
  const traced = new Caitlyn({
    workspace: 'your-company.getcaitlyn.ai',
    auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
    telemetry: { tracerProvider: trace.getTracerProvider() }, // default: the global provider; enabled: false turns spans off
  });
  // #endregion
  return traced;
}
