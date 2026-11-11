// Creating a client in each sign-in mode (proposal section 7, "Client construction").
import { Caitlyn, type OAuthTokens, type TokenStore } from '@caitlyn-ai/sdk';

declare function encryptedStoreFor(userId: string): TokenStore;
declare const userId: string;
declare const mintedCookie: string;

// An application acting as a signed-in person (authorisation code with PKCE, refresh, RFC 8707 resource)
export const asPerson = new Caitlyn({
  workspace: 'customd.caitlyn.ai',
  auth: {
    mode: 'oauth',
    clientId: process.env.STUDIOS_CLIENT_ID!,
    clientSecret: process.env.STUDIOS_CLIENT_SECRET, // confidential client on a server; omit in a browser
    redirectUri: 'https://studio.caitlyn.ai/auth/callback',
    scopes: ['chat:write', 'agents:write', 'mcp:read'],
    resource: 'https://customd.caitlyn.ai/api/v3',
    tokenStore: encryptedStoreFor(userId), // {load, save, clear}
  },
});

// In the web app's routes:
export async function startSignIn(): Promise<{ url: string; state: string; codeVerifier: string }> {
  return asPerson.auth.authorizationUrl();
}
export async function finishSignIn(code: string, state: string, expectedState: string, codeVerifier: string): Promise<OAuthTokens> {
  return asPerson.auth.handleCallback({ code, state, expectedState, codeVerifier });
}

// A registered machine integration (ApiClient)
export const service = new Caitlyn({
  workspace: 'your-company.getcaitlyn.ai',
  auth: { mode: 'clientCredentials', clientId: process.env.CAITLYN_CLIENT_ID!, clientSecret: process.env.CAITLYN_CLIENT_SECRET!, scopes: ['chat:write'] },
});

// A workload in AWS: its role credentials get an AWS-signed token from STS GetWebIdentityToken (regional
// endpoint), exchanged once for a Caitlyn bearer token
export const worker = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'awsIam', region: 'ap-southeast-2' } });

// A CI job or other OIDC workload: its own identity token (GitLab CI id_tokens), exchanged the same way
export const ci = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'workloadIdentity', token: () => process.env.CAITLYN_ID_TOKEN! } });

// The app itself, or a tool driving a local app with a session cookie
export const local = new Caitlyn({
  workspace: 'caitlyn.lndo.site',
  auth: { mode: 'session', cookie: mintedCookie, origin: 'https://caitlyn.lndo.site' },
});

// A script using a personal access token
export const script = new Caitlyn({ workspace: 'your-company.getcaitlyn.ai', auth: { mode: 'token', token: process.env.CAITLYN_TOKEN! } });
