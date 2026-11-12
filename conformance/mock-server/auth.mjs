// Sign-in for the mock Caitlyn server: the workspace's OAuth endpoints and a stand-in for AWS STS.
//
//   GET  /oauth/authorize   authorisation code with PKCE: redirects to redirect_uri with code and state (with
//                           Accept: application/json, answers {location} instead, for a browser page)
//   POST /oauth/token       client_credentials, authorization_code, refresh_token (rotating; a reused
//                           refresh token is refused with invalid_grant), RFC 8693 token exchange of a JWT
//                           (exact audience = the resource parameter, unexpired, single-use jti), revoke
//   POST /__sts/            GetWebIdentityToken: checks the Signature Version 4 signature against the
//                           mock credentials, answers with an (unsigned) JWT for the requested audience
//   GET  /__mock/auth       counters: token requests by grant, STS calls, issued tokens
//
// Faults (POST /__mock/faults, key `auth`): {require: true} makes every /v3/ request need a token this
// server issued (or pat_test, or the session cookie); {expiresIn: n} sets token lifetimes; {revokeIssued:
// true} forgets every issued token, so the next request gets 401.
import crypto from 'node:crypto';

export const MOCK_CLIENT = { id: 'machine-client', secret: 'machine-secret' };
export const MOCK_OAUTH_CLIENT = { id: 'studio-client', secret: 'studio-secret' };
export const MOCK_AWS = { accessKeyId: 'AKIDMOCKCAITLYN', secretAccessKey: 'mock-secret-key', region: 'ap-southeast-2' };
export const MOCK_PAT = 'pat_test';
export const MOCK_SESSION_COOKIE = 'caitlyn_session=mock-session';

let st;
export function resetAuth() {
  st = { tokens: new Map(), refresh: new Map(), usedRefresh: new Set(), codes: new Map(), jti: new Set(), counts: { sts: 0 }, faults: { require: false, expiresIn: 3600 } };
}
resetAuth();

export function authFaults(patch) {
  if (patch?.revokeIssued) st.tokens.clear();
  st.faults = { ...st.faults, ...patch, revokeIssued: undefined };
}

const b64url = (b) => Buffer.from(b).toString('base64url');
const json = (res, status, body, extra = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extra });
  res.end(JSON.stringify(body));
};
const oauthError = (res, status, error, description) => json(res, status, { error, error_description: description });
const count = (k) => (st.counts[k] = (st.counts[k] ?? 0) + 1);

function issue(res, grant, { refresh = false, scope } = {}) {
  const token = `cai_${grant}_${crypto.randomBytes(9).toString('hex')}`;
  st.tokens.set(token, { grant, exp: Date.now() + st.faults.expiresIn * 1000 });
  const body = { access_token: token, token_type: 'Bearer', expires_in: st.faults.expiresIn };
  if (refresh) {
    const rt = `rt_${crypto.randomBytes(9).toString('hex')}`;
    st.refresh.set(rt, grant);
    body.refresh_token = rt;
  }
  if (scope) body.scope = scope;
  return json(res, 200, body);
}

/** Does this /v3/ request carry a credential the mock accepts? Only enforced when the `require` fault is on. */
export function authorised(req) {
  if (!st.faults.require) return true;
  const auth = req.headers.authorization ?? '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (token === MOCK_PAT) return true;
  const t = st.tokens.get(token);
  if (t && t.exp > Date.now()) return true;
  if (!token && (req.headers.cookie ?? '').includes(MOCK_SESSION_COOKIE)) {
    return req.method === 'GET' || Boolean(req.headers.origin); // session writes need Origin
  }
  return false;
}

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();

/** An independent Signature Version 4 check (header form, POST, form body, no query) for the STS stand-in. */
function verifySigV4(req, body, pathname) {
  const m = (req.headers.authorization ?? '').match(/^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/(sts)\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/);
  if (!m) return 'missing or malformed Authorization';
  const [, akid, day, region, service, signed, signature] = m;
  if (akid !== MOCK_AWS.accessKeyId) return 'unknown access key';
  if (sha256(body) !== req.headers['x-amz-content-sha256']) return 'payload hash mismatch';
  const names = signed.split(';');
  const canonHeaders = names.map((n) => `${n}:${String(req.headers[n] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canonical = ['POST', pathname, '', canonHeaders, signed, sha256(body)].join('\n');
  const toSign = ['AWS4-HMAC-SHA256', req.headers['x-amz-date'], `${day}/${region}/${service}/aws4_request`, sha256(canonical)].join('\n');
  let key = hmac(`AWS4${MOCK_AWS.secretAccessKey}`, day);
  for (const p of [region, service, 'aws4_request']) key = hmac(key, p);
  if (hmac(key, toSign).toString('hex') !== signature) return 'signature does not match';
  if (!names.includes('host') || !names.includes('x-amz-date')) return 'host and x-amz-date must be signed';
  return null;
}

const jwt = (claims) => `${b64url(JSON.stringify({ alg: 'none', typ: 'JWT' }))}.${b64url(JSON.stringify(claims))}.mock`;
const readJwt = (t) => {
  try {
    return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString());
  } catch {
    return null;
  }
};

/** Handles a sign-in request; returns false when the path is not one of these. */
export async function handleAuth(req, res, url, body) {
  if (url.pathname === '/__mock/auth' && req.method === 'GET') {
    return json(res, 200, { counts: st.counts, issued: st.tokens.size }), true;
  }
  if (url.pathname === '/oauth/authorize' && req.method === 'GET') {
    const q = url.searchParams;
    if (q.get('client_id') !== MOCK_OAUTH_CLIENT.id || q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge') || !q.get('redirect_uri'))
      return oauthError(res, 400, 'invalid_request', 'client_id, redirect_uri and an S256 code_challenge are required'), true;
    const code = `code_${crypto.randomBytes(6).toString('hex')}`;
    st.codes.set(code, { challenge: q.get('code_challenge'), redirectUri: q.get('redirect_uri'), resource: q.get('resource') });
    const to = new URL(q.get('redirect_uri'));
    to.searchParams.set('code', code);
    if (q.get('state')) to.searchParams.set('state', q.get('state'));
    // A browser page cannot read a redirect's Location, so the browser conformance run asks for it as JSON.
    if (req.headers.accept === 'application/json') return json(res, 200, { location: to.toString() }), true;
    res.writeHead(302, { Location: to.toString() });
    return res.end(), true;
  }
  if (url.pathname === '/oauth/token' && req.method === 'POST') {
    const p = new URLSearchParams(body.toString());
    if (p.get('action') === 'revoke') return json(res, 200, {}), true;
    const grant = p.get('grant_type');
    count(grant ?? 'none');
    switch (grant) {
      case 'client_credentials':
        if (p.get('client_id') !== MOCK_CLIENT.id || p.get('client_secret') !== MOCK_CLIENT.secret) return oauthError(res, 401, 'invalid_client', 'Unknown client or wrong secret'), true;
        return issue(res, 'cc', { scope: p.get('scope') ?? '' }), true;
      case 'authorization_code': {
        const c = st.codes.get(p.get('code'));
        st.codes.delete(p.get('code'));
        if (!c) return oauthError(res, 400, 'invalid_grant', 'Unknown or used code'), true;
        const challenge = crypto.createHash('sha256').update(p.get('code_verifier') ?? '').digest('base64url');
        if (challenge !== c.challenge) return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed'), true;
        if (p.get('redirect_uri') !== c.redirectUri) return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match'), true;
        return issue(res, 'code', { refresh: true }), true;
      }
      case 'refresh_token': {
        const rt = p.get('refresh_token');
        if (st.usedRefresh.has(rt) || !st.refresh.has(rt)) return oauthError(res, 400, 'invalid_grant', 'Refresh token is not valid'), true;
        st.refresh.delete(rt);
        st.usedRefresh.add(rt);
        return issue(res, 'refresh', { refresh: true }), true;
      }
      case 'urn:ietf:params:oauth:grant-type:token-exchange': {
        if (p.get('subject_token_type') !== 'urn:ietf:params:oauth:token-type:jwt') return oauthError(res, 400, 'invalid_request', 'subject_token_type must be JWT'), true;
        const claims = readJwt(p.get('subject_token') ?? '');
        if (!claims) return oauthError(res, 400, 'invalid_grant', 'subject_token is not a JWT'), true;
        const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
        if (!p.get('resource') || !aud.includes(p.get('resource'))) return oauthError(res, 400, 'invalid_grant', 'The token audience is not this workspace'), true;
        if (!(claims.exp * 1000 > Date.now())) return oauthError(res, 400, 'invalid_grant', 'The token has expired'), true;
        if (!claims.jti || st.jti.has(claims.jti)) return oauthError(res, 400, 'invalid_grant', 'The token was already used'), true;
        st.jti.add(claims.jti);
        return issue(res, `x_${claims.iss?.includes('sts') ? 'aws' : 'oidc'}`), true;
      }
      default:
        return oauthError(res, 400, 'unsupported_grant_type', 'grant_type is not supported'), true;
    }
  }
  if (url.pathname === '/__sts/' && req.method === 'POST') {
    count('sts');
    const problem = verifySigV4(req, body.toString(), url.pathname);
    const xmlError = (status, code, message) => {
      res.writeHead(status, { 'Content-Type': 'text/xml' });
      res.end(`<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`);
      return true;
    };
    if (problem) return xmlError(403, 'SignatureDoesNotMatch', problem);
    const p = new URLSearchParams(body.toString());
    if (p.get('Action') !== 'GetWebIdentityToken' || !p.get('Audience.member.1')) return xmlError(400, 'InvalidParameterValue', 'Action and Audience are required');
    const now = Math.floor(Date.now() / 1000);
    const token = jwt({ iss: 'https://mock.tokens.sts.global.api.aws', sub: 'arn:aws:iam::123456789012:role/worker', aud: p.get('Audience.member.1'), iat: now, exp: now + Number(p.get('DurationSeconds') ?? 300), jti: crypto.randomUUID() });
    res.writeHead(200, { 'Content-Type': 'text/xml' });
    res.end(`<GetWebIdentityTokenResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetWebIdentityTokenResult>
    <WebIdentityToken>${token}</WebIdentityToken>
    <Expiration>${new Date((now + 300) * 1000).toISOString()}</Expiration>
  </GetWebIdentityTokenResult>
</GetWebIdentityTokenResponse>`);
    return true;
  }
  return false;
}

/** A workload identity token, as GitLab CI would mint it, for tests. */
export const mockOidcToken = (aud, overrides = {}) => {
  const now = Math.floor(Date.now() / 1000);
  return jwt({ iss: 'https://git.example.com', sub: 'project_path:group/project:ref_type:branch:ref:main', aud, iat: now, exp: now + 300, jti: crypto.randomUUID(), ...overrides });
};
