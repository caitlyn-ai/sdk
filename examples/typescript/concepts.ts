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
    await caitlyn.agents(agentId).versions('v99').get();
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
  const stream = caitlyn.conversations(conversationId).send('How much annual leave do part-time staff get?');
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
  const stream = caitlyn.conversations(conversationId).send('Summarise the leave policy.', {}, { signal: AbortSignal.timeout(30_000) });
  for await (const event of stream) if (event.type === 'text.delta') process.stdout.write(event.delta);
  // #endregion
}

export async function paginationItems(): Promise<void> {
  // #region pagination-items
  // Every document in the folder, one at a time: the SDK fetches the next page when the loop reaches it
  const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
  for await (const document of documents.list({ folder: '/policies/', limit: 100 })) {
    console.log(document.name, document.status);
    if (document.name === 'leave-policy.pdf') break; // stops here: no further page is requested
  }
  // #endregion
}

export async function paginationPages(): Promise<void> {
  // #region pagination-pages
  // Every page in turn, each with its items and nextCursor: for work done a batch at a time
  const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
  for await (const page of documents.list({ folder: '/policies/', limit: 100 }).pages()) {
    console.log(`${page.items.length} documents; more to come: ${page.hasNextPage}`);
  }
  // #endregion
}

export async function paginationPage(): Promise<void> {
  // #region pagination-page
  // One page, in exactly one request: the first 25 documents
  const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
  const page = await documents.list({ folder: '/policies/', limit: 25 }).page();
  for (const document of page.items) console.log(document.name);
  console.log(page.nextCursor); // undefined on the last page
  // #endregion
}

export async function paginationNextPage(): Promise<void> {
  const render = (items: readonly { name: string }[]) => console.log(items.map((d) => d.name));
  const nextButton = { hidden: true };
  // #region pagination-has-next-page
  // Show the first page, and a "Next" button only when another page follows: knowing that takes no request
  const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
  let page = await documents.list({ folder: '/policies/', limit: 25 }).page();
  render(page.items);
  nextButton.hidden = !page.hasNextPage;
  // #endregion
  // #region pagination-next-page
  // The "Next" button's click handler: one request, for the page after the one shown
  async function onNextClick(): Promise<void> {
    const next = await page.nextPage(); // null after the last page
    if (!next) return;
    page = next;
    render(page.items);
    nextButton.hidden = !page.hasNextPage;
  }
  // #endregion
  await onNextClick();
}

export async function paginationCursor(cursor: string | undefined): Promise<void> {
  // #region pagination-cursor
  // Carry on from a position saved earlier (a link, a reload): the same input, and the cursor the page gave
  const documents = caitlyn.knowledgeBases('KB4T7YQ2WL').documents;
  const page = await documents.list({ folder: '/policies/', limit: 25, cursor }).page();
  console.log(page.items.length, page.nextCursor); // save page.nextCursor to carry on from here next time
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
