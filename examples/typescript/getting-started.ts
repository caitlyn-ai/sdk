// The developer docs' Getting started page (docs/getting-started.md) shows the `first-call` region.
// #region first-call
import { Caitlyn } from '@caitlyn-ai/sdk';

const caitlyn = new Caitlyn({
  workspace: 'your-company.caitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! },
});

// Read the draft of an agent: its configuration and its ETag
const draft = await caitlyn.agents('GHT7YRWXPL').draft.get();
console.log(draft.configuration?.guidance?.instructions);
// #endregion
