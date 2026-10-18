/**
 * OKO1's own Google account (a service account): it sees only the folders shared with its e-mail and only reads them
 * (scope drive.readonly). The key is the JSON from Google Cloud in the secret GOOGLE_SERVICE_ACCOUNT; OKO1 signs a
 * short-lived request with it (RS256) and gets an access for one hour.
 */
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const TIMEOUT_MS = 15000;

export type ServiceAccount = {clientEmail: string; privateKey: string};

/** The account from the JSON key, or null when it is not one. */
export function serviceAccount(json: string | undefined): ServiceAccount | null {
  if (!json) return null;
  try {
    const key = JSON.parse(json) as {type?: string; client_email?: string; private_key?: string};
    return key.type === 'service_account' && key.client_email && key.private_key?.includes('PRIVATE KEY') ? {clientEmail: key.client_email, privateKey: key.private_key} : null;
  } catch { return null; }
}

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const text64 = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));

/** An access for Google Drive, or the reason there is none. */
export async function googleAccess(account: ServiceAccount, now = Date.now()): Promise<{ok: true; token: string} | {ok: false; error: string}> {
  let key: CryptoKey;
  try {
    const der = Uint8Array.from(atob(account.privateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '')), char => char.charCodeAt(0));
    key = await crypto.subtle.importKey('pkcs8', der, {name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256'}, false, ['sign']);
  } catch { return {ok: false, error: 'klíč účtu OKO1 u Googlu není čitelný'}; }
  const issued = Math.floor(now / 1000);
  const unsigned = `${text64({alg: 'RS256', typ: 'JWT'})}.${text64({iss: account.clientEmail, scope: SCOPE, aud: TOKEN_URL, iat: issued, exp: issued + 3600})}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const response = await fetch(TOKEN_URL, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
    body: new URLSearchParams({grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}`}),
    signal: AbortSignal.timeout(TIMEOUT_MS)}).catch(() => null);
  if (!response) return {ok: false, error: 'Google neodpověděl'};
  const body = await response.json().catch(() => null) as {access_token?: string; error?: string} | null;
  return response.ok && body?.access_token ? {ok: true, token: body.access_token} : {ok: false, error: `Google ${response.status}${body?.error ? ' ' + String(body.error).slice(0, 60) : ''}`};
}
