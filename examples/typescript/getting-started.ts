// The developer docs' Getting started page (docs/getting-started.md) shows the `first-call` region.
// #region first-call
import { Caitlyn } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
});

// Read the draft of an agent: its configuration and its ETag
const draft = await caitlyn.versions.get({ agentId: 'GHT7YRWXPL', version: 'draft' });
console.log(draft.configuration.instructions);
// #endregion
