// The AWS half of the awsIam sign-in mode, with no AWS runtime: a minimal Signature Version 4 signer over Web
// Crypto, the two credential sources AWS workloads actually use (environment variables, and the container
// credentials endpoint used by ECS, Fargate and AgentCore runtimes), and one call, STS GetWebIdentityToken.
// Anything else (profiles, SSO, instance metadata) is reached by passing `credentials`, which accepts any
// @aws-sdk credential provider, for example fromNodeProviderChain() from @aws-sdk/credential-providers.

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  /** When the credentials stop working; the SDK fetches new ones a minute before. */
  expiration?: Date;
}

export type AwsCredentialSource = AwsCredentials | (() => Promise<AwsCredentials> | AwsCredentials);

type Env = Record<string, string | undefined>;
const env = (): Env => (globalThis as { process?: { env?: Env } }).process?.env ?? {};

const enc = new TextEncoder();
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256 = async (s: string) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
async function hmac(key: ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey('raw', key as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(data));
}

/** RFC 3986 encoding, as Signature Version 4 requires (encodeURIComponent leaves !'()* alone). */
export const awsEncode = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

export interface SignableRequest {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: string;
}

/**
 * Signs a request with AWS Signature Version 4 (header form) and returns the headers to send, including
 * `authorization`, `x-amz-date`, `x-amz-content-sha256` and, for temporary credentials, `x-amz-security-token`.
 */
export async function signV4(req: SignableRequest, creds: AwsCredentials, region: string, service: string, now = new Date()): Promise<Record<string, string>> {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const payloadHash = await sha256(req.body);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  headers.host = req.url.host;
  headers['x-amz-date'] = amzDate;
  headers['x-amz-content-sha256'] = payloadHash;
  if (creds.sessionToken) headers['x-amz-security-token'] = creds.sessionToken;
  const names = Object.keys(headers).sort();
  const query = [...req.url.searchParams.entries()]
    .map(([k, v]) => [awsEncode(k), awsEncode(v)])
    .sort(([a, x], [b, y]) => (a === b ? (x < y ? -1 : 1) : a < b ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const path = req.url.pathname.split('/').map((p) => awsEncode(decodeURIComponent(p))).join('/') || '/';
  const canonical = [req.method, path, query, names.map((n) => `${n}:${headers[n]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256(canonical)].join('\n');
  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), day);
  for (const part of [region, service, 'aws4_request']) key = await hmac(key, part);
  const signature = hex(await hmac(key, toSign));
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}`;
  delete headers.host; // fetch sets it
  return headers;
}

/**
 * The default credential source: AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY (with AWS_SESSION_TOKEN), as AWS
 * Lambda and CI runners set them; otherwise the container credentials endpoint
 * (AWS_CONTAINER_CREDENTIALS_FULL_URI or _RELATIVE_URI), as ECS, Fargate and AgentCore runtimes set it.
 */
export async function defaultAwsCredentials(fetchFn: typeof fetch = fetch): Promise<AwsCredentials> {
  const e = env();
  if (e.AWS_ACCESS_KEY_ID && e.AWS_SECRET_ACCESS_KEY)
    return { accessKeyId: e.AWS_ACCESS_KEY_ID, secretAccessKey: e.AWS_SECRET_ACCESS_KEY, sessionToken: e.AWS_SESSION_TOKEN };
  const url = e.AWS_CONTAINER_CREDENTIALS_FULL_URI ?? (e.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI && `http://169.254.170.2${e.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI}`);
  if (url) {
    let auth = e.AWS_CONTAINER_AUTHORIZATION_TOKEN;
    if (!auth && e.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE) {
      const fsModule = 'node:fs/promises'; // a variable, so browser bundlers leave it alone
      const fs = (await import(/* @vite-ignore */ fsModule)) as typeof import('node:fs/promises');
      auth = (await fs.readFile(e.AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE, 'utf8')).trim();
    }
    const res = await fetchFn(url, { headers: auth ? { authorization: auth } : {} });
    if (!res.ok) throw new Error(`awsIam: the container credentials endpoint answered ${res.status}`);
    const c = (await res.json()) as { AccessKeyId: string; SecretAccessKey: string; Token?: string; Expiration?: string };
    return { accessKeyId: c.AccessKeyId, secretAccessKey: c.SecretAccessKey, sessionToken: c.Token, expiration: c.Expiration ? new Date(c.Expiration) : undefined };
  }
  throw new Error(
    'awsIam: no AWS credentials found. Set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY, run where the container credentials endpoint is set, or pass auth.credentials (for example fromNodeProviderChain() from @aws-sdk/credential-providers).',
  );
}

const xmlText = (xml: string, tag: string) => xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1];

export interface WebIdentityTokenRequest {
  region: string;
  audience: string;
  credentials: AwsCredentials;
  signingAlgorithm?: 'ES384' | 'RS256';
  durationSeconds?: number;
  /** Overrides https://sts.{region}.amazonaws.com/ (tests, FIPS or VPC endpoints). */
  stsEndpoint?: string;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

/** Calls STS GetWebIdentityToken (outbound identity federation) on a regional endpoint and returns the JWT. */
export async function getWebIdentityToken(r: WebIdentityTokenRequest): Promise<{ token: string; expiration?: Date }> {
  const url = new URL(r.stsEndpoint ?? `https://sts.${r.region}.amazonaws.com/`);
  const body = new URLSearchParams({
    Action: 'GetWebIdentityToken',
    Version: '2011-06-15',
    'Audience.member.1': r.audience,
    DurationSeconds: String(r.durationSeconds ?? 300),
    SigningAlgorithm: r.signingAlgorithm ?? 'ES384',
  }).toString();
  const headers = await signV4({ method: 'POST', url, headers: { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8' }, body }, r.credentials, r.region, 'sts');
  const res = await (r.fetch ?? fetch)(url, { method: 'POST', headers, body, signal: r.signal });
  const text = await res.text();
  if (!res.ok) {
    const code = xmlText(text, 'Code') ?? `HTTP ${res.status}`;
    throw Object.assign(new Error(`awsIam: STS GetWebIdentityToken failed: ${code}: ${xmlText(text, 'Message') ?? ''}`.trim()), { code, status: res.status });
  }
  const token = xmlText(text, 'WebIdentityToken');
  if (!token) throw new Error('awsIam: STS answered without a WebIdentityToken');
  const exp = xmlText(text, 'Expiration');
  return { token, expiration: exp ? new Date(exp) : undefined };
}
