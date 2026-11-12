// The browser build's stand-in for ../aws.ts: the awsIam mode's request signer and credential sources, which a
// browser never uses (PROTOCOL.md 12.6). The names stay, so the build exports what the Node build does; calling
// one says why it is missing.
export type { AwsCredentials, AwsCredentialSource, SignableRequest, WebIdentityTokenRequest } from '../aws.js';

const missing = (): never => {
  throw new Error('Caitlyn: the AWS request signer is not in the browser build of the SDK. awsIam signs in server workloads only.');
};

export const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
export const signV4 = async (..._args: unknown[]): Promise<Record<string, string>> => missing();
export const defaultAwsCredentials = async (..._args: unknown[]): Promise<never> => missing();
export const getWebIdentityToken = async (..._args: unknown[]): Promise<{ token: string; expiration?: Date }> => missing();
