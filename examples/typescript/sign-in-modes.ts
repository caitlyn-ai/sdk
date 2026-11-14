// A client in each sign-in mode. The developer docs' Authentication page (docs/authentication.md) shows each
// region; scripts/test-typescript.sh type-checks this file against the SDK.
import { Caitlyn, type TokenStore } from '@caitlyn-ai/sdk';

declare function encryptedTokenStoreFor(userId: string): TokenStore;
declare const userId: string;
declare const sessionCookie: string;

// #region token
const script = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! }, // a personal access token, cait-pat-…
});
// #endregion

// #region client-credentials
const service = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: {
    mode: 'clientCredentials',
    clientId: process.env.CAITLYN_CLIENT_ID!,
    clientSecret: process.env.CAITLYN_CLIENT_SECRET!,
    scopes: ['api:read'],
  },
});
// #endregion

// #region oauth
const asPerson = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: {
    mode: 'oauth',
    clientId: process.env.CAITLYN_CLIENT_ID!,
    clientSecret: process.env.CAITLYN_CLIENT_SECRET, // only on a server; a browser app has none
    redirectUri: 'https://app.example.com/caitlyn/callback',
    scopes: ['api:write'],
    tokenStore: encryptedTokenStoreFor(userId), // { load, save, clear }; default: in memory
  },
});

// Send the person to `url`, and keep `state` and `codeVerifier` for the callback
const { url, state, codeVerifier } = await asPerson.auth.authorizationUrl();
// #endregion

// #region oauth-callback
declare const code: string;
declare const returnedState: string;
await asPerson.auth.handleCallback({ code, state: returnedState, expectedState: state, codeVerifier });
// #endregion

// #region aws-iam
const worker = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'awsIam', region: 'ap-southeast-2' }, // the workload's own AWS credentials
});
// #endregion

// #region workload-identity
const ciJob = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'workloadIdentity', token: () => process.env.CAITLYN_ID_TOKEN! }, // GitLab CI id_tokens
});
// #endregion

// #region session
const appPage = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'session', cookie: sessionCookie, origin: 'https://your-company.getcaitlyn.ai' },
});
// #endregion

export { script, service, asPerson, url, worker, ciJob, appPage };
