/**
 * OAuth for the MCP server (/mcp, docs/web-v1.md), with @cloudflare/workers-oauth-provider and the KV OAUTH_KV.
 * Connecting Claude: the person types the venue and their phone, gets the same SMS code as for the dashboard (same
 * numbers, limits and validity) and the code opens a dashboard-like session. The OAuth grant carries the venue and
 * that session: every MCP request and every token refresh checks that the session still lives, so 30 days, a change
 * of the allowed phones or POST /admin/t/{tenant}/logout end the connection too.
 */
import {AuthorizationError, OAuthError, type OAuthHelpers, type OAuthProviderOptions} from '@cloudflare/workers-oauth-provider';
import {createServer, serveMcp} from './mcp.ts';
import type {Env, TenantObject} from './worker.ts';

export const MCP_PATH = '/mcp';
export const AUTHORIZE_PATH = '/oauth/authorize';
const ACCESS_TOKEN_S = 60 * 60;
/** The same 30 days as a dashboard session: the connection cannot outlive the login it came from. */
const REFRESH_TOKEN_S = 30 * 24 * 60 * 60;
const CLIENT_REGISTRATION_S = 180 * 24 * 60 * 60;
const MAX_FORM = 4096;
const SESSION_ENDED = 'The OKO1 login has ended, connect again.';

/** What an OAuth grant of OKO1 carries: the venue and the session opened by the SMS code. */
export type McpProps = {tenant: string; session: string};
export type Venues = {known(tenant: string): Promise<boolean>; stub(tenant: string): DurableObjectStub<TenantObject>};

const isProps = (value: unknown): value is McpProps => {
  const props = value as Partial<McpProps> | undefined;
  return typeof props?.tenant === 'string' && /^[a-z0-9-]{3,64}$/.test(props.tenant) && typeof props.session === 'string' && /^[a-f0-9]{64}$/.test(props.session);
};

/** The grant is valid while its venue exists and the session of its login lives. */
async function validGrant(props: unknown, venues: Venues): Promise<boolean> {
  return isProps(props) && await venues.known(props.tenant) && await venues.stub(props.tenant).validSession(props.session);
}

function endedToken(request: Request): Response {
  const metadata = `${new URL(request.url).origin}/.well-known/oauth-protected-resource${MCP_PATH}`;
  return Response.json({error: 'invalid_token', error_description: SESSION_ENDED}, {status: 401, headers: {
    'cache-control': 'no-store',
    'www-authenticate': `Bearer realm="OAuth", resource_metadata="${metadata}", error="invalid_token", error_description="${SESSION_ENDED}"`,
  }});
}

/** Options of the provider for one origin (the token resource must be an absolute URL). */
export function oauthOptions(origin: string, app: (request: Request, env: Env, ctx: ExecutionContext) => Promise<Response>, venues: (env: Env) => Venues): OAuthProviderOptions<Env> {
  return {
    apiRoute: MCP_PATH,
    apiHandler: {
      async fetch(request: Request, env: Env, ctx: ExecutionContext & {props?: unknown}) {
        const known = venues(env);
        if (!await validGrant(ctx.props, known)) return endedToken(request);
        const {tenant} = ctx.props as McpProps;
        return serveMcp(request, () => createServer({tenant, env, venue: known.stub(tenant)}));
      },
    },
    defaultHandler: {
      fetch: (request: Request, env: Env, ctx: ExecutionContext) => new URL(request.url).pathname === AUTHORIZE_PATH && env.OAUTH_PROVIDER
        ? authorize(request, env.OAUTH_PROVIDER, venues(env)) : app(request, env, ctx),
    },
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: '/oauth/token',
    clientRegistrationEndpoint: '/oauth/register',
    accessTokenTTL: ACCESS_TOKEN_S,
    refreshTokenTTL: REFRESH_TOKEN_S,
    clientRegistrationTTL: CLIENT_REGISTRATION_S,
    resourceMetadata: {resource: `${origin}${MCP_PATH}`, resource_name: 'OKO1'},
    // Exchanging the code and every refresh fail once the login has ended; invalid_grant ends the whole connection.
    tokenExchangeCallback: async ({props, env}) => {
      if (!await validGrant(props, venues(env))) throw new OAuthError('invalid_grant', {description: SESSION_ENDED});
    },
  };
}

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]!);
const randomHex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');

type Page = {client?: {name: string; host: string; local: boolean}; step: 'phone' | 'code' | 'invalid'; tenant?: string; error?: string};

function page(view: Page, status: number): Response {
  const nonce = randomHex(16);
  const client = view.client;
  const body = view.step === 'invalid'
    ? `<p class="warn" role="alert">Tenhle odkaz na připojení neplatí. Spusťte připojení v Claudovi znovu.</p>`
    : `<p class="notice">Přístup k datům OKO1 a k rezervacím, hostům a dalším datům webu dostane: <strong>${escape(client!.host)}</strong>.
  Pokračujte, jen když jste připojení sami spustili ve svém Claudovi. Když vám odkaz někdo poslal, nic nezadávejte.</p>
<p>Připojuje se <strong>${escape(client!.name)}</strong>.${client!.local ? ' Přístup půjde do aplikace v tomhle počítači.' : ''}</p>
<form method="post">${view.step === 'phone' ? `
  <input type="hidden" name="krok" value="kod">
  <label for="provozovna">Provozovna</label><input id="provozovna" name="provozovna" value="${escape(view.tenant ?? '')}" placeholder="james-dean" autocomplete="off" required>
  <label for="telefon">Telefon</label><input id="telefon" name="telefon" type="tel" inputmode="tel" autocomplete="tel" placeholder="+420 …" required>
  <button>Poslat kód</button>
  <p class="muted">Kód v SMS přijde jen na číslo, které smí na dashboard OKO1.</p>` : `
  <input type="hidden" name="krok" value="overit"><input type="hidden" name="provozovna" value="${escape(view.tenant ?? '')}">
  <label for="kod">Kód z SMS</label><input id="kod" name="kod" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required autofocus>
  <button>Připojit</button>
  <p class="muted">Pokud má číslo přístup, kód je na cestě. Platí 10 minut. Připojení pak vydrží 30 dní.</p>`}
  <p class="warn" role="alert">${escape(view.error ?? '')}</p>
</form>`;
  return new Response(`<!doctype html>
<html lang="cs"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">
<title>Připojit Clauda k OKO1</title>
<style nonce="${nonce}">
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#0f6e5c;--warn:#b4441c;--note:#fff3c4}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--text:#f1efe8;--muted:#a3a19a;--line:#33322f;--accent:#5fc2a8;--warn:#f08a5d;--note:#3d3518}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:440px;margin:8vh auto;padding:16px}.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px}
h1{font-size:20px;margin:0 0 12px}form{display:grid;gap:8px}input,button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}
button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}.muted{color:var(--muted);font-size:14px}.warn{color:var(--warn)}
.notice{background:var(--note);padding:12px;border-radius:8px;font-weight:600;overflow-wrap:anywhere}
</style></head>
<body><main><div class="card"><h1>Připojit Clauda k OKO1</h1>${body}</div></main></body></html>`, {status, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer',
    'content-security-policy': `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
  }});
}

async function form(request: Request): Promise<URLSearchParams | null> {
  if (Number(request.headers.get('content-length') || 0) > MAX_FORM) return null;
  const text = new TextDecoder().decode(await request.arrayBuffer());
  return text.length > MAX_FORM ? null : new URLSearchParams(text);
}

/**
 * GET and POST /oauth/authorize: step 1 venue and phone (an SMS code goes only to a number allowed into the dashboard),
 * step 2 the code; a valid code completes the authorization and redirects back to Claude. A broken request is shown,
 * never redirected (anybody can register a client with any address). Only same-origin posts.
 */
export async function authorize(request: Request, oauth: OAuthHelpers, venues: Venues): Promise<Response> {
  let auth;
  try { auth = await oauth.parseAuthRequest(request); } catch (error) {
    if (error instanceof AuthorizationError || error instanceof OAuthError || error instanceof TypeError) return page({step: 'invalid'}, 400);
    throw error;
  }
  const consent = await oauth.describeConsent(auth);
  const client = {name: [...consent.clientName.trim()].slice(0, 60).join(''), host: consent.redirectHost, local: consent.redirectIsLoopback};
  if (request.method === 'GET') return page({client, step: 'phone'}, 200);
  if (request.method !== 'POST') return page({step: 'invalid'}, 405);
  const origin = request.headers.get('origin');
  if (origin !== null && origin !== new URL(request.url).origin) return page({client, step: 'phone', error: 'Požadavek z cizího webu.'}, 403);
  const fields = await form(request);
  if (!fields) return page({client, step: 'phone', error: 'Formulář je příliš velký.'}, 413);
  const tenant = (fields.get('provozovna') ?? '').trim().toLowerCase();
  const validTenant = /^[a-z0-9-]{3,64}$/.test(tenant);
  // An unknown venue answers exactly like a known one, and no storage is created for it.
  const known = validTenant && await venues.known(tenant);
  if (fields.get('krok') === 'kod') {
    if (!validTenant) return page({client, step: 'phone', error: 'Provozovna je krátký název, např. james-dean.'}, 400);
    const sent = known ? await venues.stub(tenant).sendLoginCode(fields.get('telefon')) : {status: 200, body: {sent: true}};
    if (sent.status === 429) return page({client, step: 'phone', tenant, error: 'Moc pokusů, zkuste to později.'}, 429);
    if (sent.status !== 200) return page({client, step: 'phone', tenant, error: 'Kód se nepodařilo poslat.'}, 503);
    return page({client, step: 'code', tenant}, 200);
  }
  const verified = known ? await venues.stub(tenant).verifyLoginCode(fields.get('kod')) : {status: 401, body: {error: 'INVALID_CODE'}};
  if (verified.status !== 200) {
    const tooMany = verified.status === 429;
    return page({client, step: 'code', tenant, error: tooMany ? 'Moc chybných kódů, přihlášení je na hodinu zavřené.' : 'Kód nesedí nebo vypršel.'}, tooMany ? 429 : 401);
  }
  const props: McpProps = {tenant, session: (verified.body as unknown as {token: string}).token};
  const {redirectTo} = await oauth.completeAuthorization({request: auth, userId: tenant, metadata: {client: client.name}, scope: auth.scope, props});
  return new Response(null, {status: 302, headers: {location: redirectTo, 'cache-control': 'no-store'}});
}
