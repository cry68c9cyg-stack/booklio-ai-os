/**
 * OKO1's own read-only access to OneDrive through Microsoft's official sign-in (Microsoft identity platform, personal
 * accounts). OKO1 is a public client: authorization code with PKCE, no client secret. Permission "Files.Read" is
 * read-only; "offline_access" lets OKO1 renew the access every morning without anyone signing in again.
 * The shared folder link stays the key to the folder: with this access, Microsoft Graph opens it like a signed-in viewer.
 */
const AUTHORITY = 'https://login.microsoftonline.com/consumers/oauth2/v2.0';
export const GRAPH_SCOPE = 'Files.Read offline_access';
const TIMEOUT_MS = 15000;

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

/** A fresh PKCE pair: the verifier stays in OKO1, the challenge goes to Microsoft. */
export async function pkce(): Promise<{verifier: string; challenge: string}> {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
  return {verifier, challenge};
}

export function authorizeUrl(clientId: string, redirectUri: string, state: string, challenge: string): string {
  const params = new URLSearchParams({client_id: clientId, response_type: 'code', redirect_uri: redirectUri, response_mode: 'query',
    scope: GRAPH_SCOPE, state, code_challenge: challenge, code_challenge_method: 'S256', prompt: 'consent'});
  return `${AUTHORITY}/authorize?${params}`;
}

export type Tokens = {accessToken: string; refreshToken: string};
export type TokenResult = {ok: true; tokens: Tokens} | {ok: false; error: string};

async function token(form: Record<string, string>): Promise<TokenResult> {
  const response = await fetch(`${AUTHORITY}/token`, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams(form), signal: AbortSignal.timeout(TIMEOUT_MS)}).catch(() => null);
  if (!response) return {ok: false, error: 'Microsoft neodpověděl'};
  const body = await response.json().catch(() => null) as {access_token?: string; refresh_token?: string; error?: string} | null;
  if (!response.ok || !body?.access_token || !body.refresh_token) return {ok: false, error: `Microsoft ${response.status}${body?.error ? ' ' + String(body.error).slice(0, 60) : ''}`};
  return {ok: true, tokens: {accessToken: body.access_token, refreshToken: body.refresh_token}};
}

/** After the sign-in: the code from Microsoft for the first access and its renewal. */
export const redeem = (clientId: string, redirectUri: string, code: string, verifier: string) =>
  token({client_id: clientId, grant_type: 'authorization_code', code, redirect_uri: redirectUri, code_verifier: verifier, scope: GRAPH_SCOPE});

/** Every morning: a new access; Microsoft also rotates the renewal, which OKO1 then keeps instead of the old one. */
export const renew = (clientId: string, refreshToken: string) =>
  token({client_id: clientId, grant_type: 'refresh_token', refresh_token: refreshToken, scope: GRAPH_SCOPE});
