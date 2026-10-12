import assert from 'node:assert/strict';
import {test} from 'node:test';
import {InputError, validateConfig, type TenantConfig} from '../src/validate.ts';
import {allowedWebUrl, pageQuery, parsePage, parseTableList, webOverview, webSite, webTable, webTables, webToken, webTokenName, webVisits, type WebSite} from '../src/web-client.ts';

const config: TenantConfig = {
  name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9],
  registers: ['bar'], sections: {bar: 'Bar'}, recipients: [], bottleCheck: null, reportsLink: null, dashboardPhones: null, web: null, location: null,
};

test('config: web is only the bare HTTPS origin of an allowed website, never a token', () => {
  const {web: _omit, ...legacy} = config;
  assert.equal(validateConfig(legacy).web, null, 'configs without the key stay valid');
  assert.equal(validateConfig({...config, web: null}).web, null);
  assert.deepEqual(validateConfig({...config, web: {url: 'https://jamesdean.cz'}}).web, {url: 'https://jamesdean.cz'});
  assert.deepEqual(validateConfig({...config, web: {url: 'https://JamesDean.cz/'}}).web, {url: 'https://jamesdean.cz'});
  for (const url of ['http://jamesdean.cz', 'https://evil.example', 'https://jamesdean.cz.evil.example', 'https://evil.example/jamesdean.cz',
    'https://www.evil.cz?jamesdean.cz', 'https://jamesdean.cz/api', 'https://jamesdean.cz/?a=1', 'https://jamesdean.cz:8443',
    'https://user@jamesdean.cz', 'jamesdean.cz', '']) {
    assert.throws(() => validateConfig({...config, web: {url}}), InputError, url);
  }
  assert.throws(() => validateConfig({...config, web: {url: 'https://jamesdean.cz', token: 'a'.repeat(64)}}), InputError, 'no token in the config');
  assert.throws(() => validateConfig({...config, web: 'https://jamesdean.cz'}), InputError);
});

const token = 'd'.repeat(64);
const site: WebSite = {url: 'https://jamesdean.cz', token};

test('web token: secret name from the tenant, only 64 hex characters, never without a configured website', () => {
  assert.equal(webTokenName('james-dean'), 'WEB_TOKEN_JAMES_DEAN');
  assert.equal(webTokenName('bar-u-2-psu'), 'WEB_TOKEN_BAR_U_2_PSU');
  assert.equal(webToken({WEB_TOKEN_JAMES_DEAN: ` ${'A'.repeat(64)}\n`}, 'james-dean'), 'a'.repeat(64));
  assert.equal(webToken({WEB_TOKEN_JAMES_DEAN: 'short'}, 'james-dean'), null);
  assert.equal(webToken({WEB_TOKEN_OTHER: token}, 'james-dean'), null);
  assert.deepEqual(webSite({url: 'https://jamesdean.cz'}, {WEB_TOKEN_JAMES_DEAN: token}, 'james-dean'), {ok: true, value: site});
  assert.match((webSite(null, {WEB_TOKEN_JAMES_DEAN: token}, 'james-dean') as {error: string}).error, /web\.url/);
  assert.match((webSite({url: 'https://jamesdean.cz'}, {}, 'james-dean') as {error: string}).error, /WEB_TOKEN_JAMES_DEAN/);
  assert.equal(webSite({url: 'https://evil.example'}, {WEB_TOKEN_JAMES_DEAN: token}, 'james-dean').ok, false);
  assert.equal(allowedWebUrl('https://jamesdean.cz/api/oko1/v1/tabulky'), true);
  assert.equal(allowedWebUrl('http://jamesdean.cz/'), false);
  assert.equal(allowedWebUrl('https://jamesdean.cz:444/'), false);
});

test('web client: page query, table list and page shape', () => {
  assert.equal(pageQuery(0, {}), 'po=0&limit=1000');
  assert.equal(pageQuery(7, {od: '2026-10-01', do: '2026-10-31', rovno: [['stav', 'nova'], ['prostor', 'klub']]}),
    'po=7&limit=1000&od=2026-10-01&do=2026-10-31&rovno=stav%3Anova&rovno=prostor%3Aklub');
  assert.equal(pageQuery(0, {od: '1. 10. 2026'}), null);
  assert.equal(pageQuery(0, {rovno: [['stav; DROP', 'x']]}), null);
  assert.deepEqual(parseTableList({tabulky: [{nazev: 'rezervace', klic: ['id'], datum: 'datum', filtry: ['stav']}, {nazev: 'hoste', klic: ['id']}]}),
    [{nazev: 'rezervace', klic: ['id'], datum: 'datum', filtry: ['stav']}, {nazev: 'hoste', klic: ['id'], datum: null, filtry: []}]);
  assert.equal(parseTableList({tabulky: [{nazev: '../x'}]}), null);
  assert.deepEqual(parsePage({nazev: 'hoste', radky: [{_klic: '1'}], dalsi: null}, 'hoste', 0), {rows: [{_klic: '1'}], next: null});
  assert.equal(parsePage({nazev: 'hoste', radky: [], dalsi: 5}, 'hoste', 5), null, 'paging must move forward');
  assert.equal(parsePage({nazev: 'jine', radky: [], dalsi: null}, 'hoste', 0), null);
});

test('web client: pages with the Bearer token, cut at the row limit, refuses redirects and never throws', async t => {
  const seen: {url: string; auth: string | null; redirect: string | undefined}[] = [];
  let reply: (url: URL) => Response | Promise<Response> = () => new Response('{}');
  t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
    seen.push({url: input, auth: new Headers(init.headers).get('authorization'), redirect: init.redirect});
    return reply(new URL(input));
  });
  // Three pages of two rows each; the client follows `dalsi` with the filters kept.
  const all = Array.from({length: 5}, (_, i) => ({_klic: String(i + 1), id: i + 1}));
  reply = url => {
    const after = Number(url.searchParams.get('po')), rows = all.filter(row => row.id > after).slice(0, 2);
    return Response.json({nazev: 'rezervace', radky: rows, dalsi: rows.length === 2 && rows.at(-1)!.id < 5 ? rows.at(-1)!.id : null});
  };
  const read = await webTable(site, 'rezervace', {od: '2026-10-12', rovno: [['stav', 'nova']]});
  assert.deepEqual(read, {ok: true, value: {rows: all, truncated: false}});
  assert.deepEqual(seen.map(entry => new URL(entry.url).searchParams.get('po')), ['0', '2', '4']);
  assert.ok(seen.every(entry => entry.auth === `Bearer ${token}` && entry.redirect === 'manual'));
  assert.ok(seen.every(entry => entry.url.startsWith('https://jamesdean.cz/api/oko1/v1/tabulka/rezervace?') && entry.url.includes('od=2026-10-12&rovno=stav%3Anova')));
  assert.deepEqual(await webTable(site, 'rezervace', {}, 3), {ok: true, value: {rows: all.slice(0, 3), truncated: true}});
  // Errors are short Czech texts; the web's own explanation of a refused filter is passed on.
  reply = () => new Response(null, {status: 302, headers: {location: 'https://evil.example/'}});
  assert.deepEqual(await webTable(site, 'rezervace'), {ok: false, error: 'přesměrování 302 (nepovoleno)'});
  reply = () => Response.json({chyba: 'Neplatný token.'}, {status: 401});
  assert.deepEqual(await webOverview(site), {ok: false, error: 'HTTP 401 (neplatný token)'});
  reply = () => Response.json({chyba: 'Podle sloupce „jmeno“ tabulka rezervace filtrovat nejde.'}, {status: 422});
  assert.deepEqual(await webTable(site, 'rezervace', {rovno: [['jmeno', 'x']]}), {ok: false, error: 'HTTP 422 (Podle sloupce „jmeno“ tabulka rezervace filtrovat nejde.)'});
  reply = () => new Response('x'.repeat(10), {headers: {'content-length': String(30 * 1024 * 1024)}});
  assert.deepEqual(await webVisits(site), {ok: false, error: 'odpověď je příliš velká'});
  reply = () => new Response('not json');
  assert.deepEqual(await webVisits(site, '2026-10-01'), {ok: false, error: 'odpověď webu nejde přečíst'});
  reply = () => { throw new TypeError('fetch failed'); };
  assert.deepEqual(await webTables(site), {ok: false, error: 'web není dostupný'});
  const before = seen.length;
  assert.deepEqual(await webTable({...site, url: 'https://evil.example'}, 'rezervace'), {ok: false, error: 'adresa mimo povolené weby'});
  assert.deepEqual(await webTable(site, 'rezervace', {od: '12.10.2026'}), {ok: false, error: 'neplatný filtr (od a do jako RRRR-MM-DD, rovno jako sloupec:hodnota)'});
  assert.equal(seen.length, before, 'nothing is sent to a host outside the allowlist or with a bad filter');
});
