// End-to-end test on the real workerd runtime (Miniflare) with synthetic data only.
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {journalSheets, reportSheets, xlsx} from './xlsx-fixture.ts';

const dir = await mkdtemp(join(tmpdir(), 'ai-os-worker-'));
const admin = 'local-test-only-admin-secret-32-characters';
const token = 'a'.repeat(64);
let mf;
try {
  const bundle = await build({entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral', external: ['node:crypto', 'cloudflare:workers']});
  const options = {
    modules: true, script: bundle.outputFiles[0].text, compatibilityDate: '2026-08-06', compatibilityFlags: ['nodejs_compat'],
    durableObjects: {TENANTS: {className: 'TenantObject', useSQLite: true}, REGISTRY: {className: 'Registry', useSQLite: true}},
    durableObjectsPersist: dir, bindings: {ADMIN_SECRET: admin},
  };
  mf = new Miniflare(options);
  const call = (method, path, body, auth = 'Bearer ' + admin) => mf.dispatchFetch('http://local.test' + path, {
    method, headers: {'content-type': 'application/json', ...(auth ? {authorization: auth} : {})}, body: body === undefined ? undefined : JSON.stringify(body),
  });
  const config = {name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9], registers: ['bar'], sections: {bar: 'Bar'}, recipients: []};
  const bill = (id, version = 1, totalCents = 50000, businessDate = '2026-10-08') => ({
    type: 'bill', id, version, businessDate, closedAt: '2026-10-08T20:00:00Z', registerId: 'bar', section: 'bar', status: 'closed', guests: 2,
    totalCents, discountCents: 0, items: [{name: 'Burger', quantity: 1, totalCents}], payments: [{method: 'card', amountCents: totalCents}], voids: [],
  });
  const closing = {type: 'cash_closing', id: 'close-1', version: 1, businessDate: '2026-10-08', closedAt: '2026-10-09T03:00:00Z', registerId: 'bar', expectedCents: 0, countedCents: 0};
  const ingest = (batchId, records, auth = 'Bearer ' + token, tenant = 'test-venue') => call('POST', `/v1/t/${tenant}/ingest`, {batchId, installationId: 'pos-installation-1', records}, auth);

  // Admin API needs the admin secret; unknown routes and tenants with bad names are 404.
  assert.equal((await call('PUT', '/admin/t/test-venue/config', config, null)).status, 401);
  assert.equal((await call('PUT', '/admin/t/test-venue/config', config, 'Bearer wrong')).status, 401);
  assert.equal((await call('GET', '/admin/t/Test_Venue/config')).status, 404);
  assert.equal((await call('POST', '/admin/t/test-venue/tick', {at: '2026-10-09T05:00:00Z'})).status, 200);
  assert.deepEqual(await (await call('POST', '/admin/t/test-venue/tick', {at: '2026-10-09T05:00:00Z'})).json(), {decision: 'not-configured'});
  assert.equal((await call('PUT', '/admin/t/test-venue/config', {...config, recipients: ['123']})).status, 400);
  assert.equal((await call('PUT', '/admin/t/test-venue/config', config)).status, 200);

  // Pairing stores only a hash; a different token for the same installation is a conflict.
  assert.equal((await ingest('batch-0001', [bill('b1')])).status, 401);
  assert.equal((await call('POST', '/admin/t/test-venue/pair', {installationId: 'pos-installation-1', token})).status, 200);
  assert.equal((await call('POST', '/admin/t/test-venue/pair', {installationId: 'pos-installation-1', token})).status, 200);
  assert.equal((await call('POST', '/admin/t/test-venue/pair', {installationId: 'pos-installation-1', token: 'b'.repeat(64)})).status, 409);

  // Ingest: auth, idempotent batches, newer versions win, another venue sees nothing.
  assert.equal((await ingest('batch-0001', [bill('b1')], 'Bearer ' + 'c'.repeat(64))).status, 401);
  assert.equal((await ingest('batch-0001', [bill('b1')], null)).status, 401);
  assert.equal((await ingest('batch-0001', [bill('b1')], 'Bearer ' + token, 'other-venue')).status, 401);
  assert.equal((await ingest('batch-0001', [{...bill('b1'), totalCents: 1.5}])).status, 400);
  assert.deepEqual(await (await ingest('batch-0001', [bill('b1'), bill('b2')])).json(), {batchId: 'batch-0001', accepted: 2, stale: 0});
  assert.deepEqual(await (await ingest('batch-0001', [bill('b1'), bill('b2')])).json(), {batchId: 'batch-0001', accepted: 2, stale: 0});
  assert.equal((await ingest('batch-0001', [bill('b1')])).status, 409);
  assert.deepEqual(await (await ingest('batch-0002', [bill('b1', 2, 70000), bill('b2', 1, 99999)])).json(), {batchId: 'batch-0002', accepted: 1, stale: 1});

  // History import feeds the plan (same weekday, previous weeks).
  assert.deepEqual(await (await call('POST', '/admin/t/test-venue/history', {rows: [
    {businessDate: '2026-10-01', revenueCents: 100000}, {businessDate: '2026-09-24', revenueCents: 140000},
  ]})).json(), {imported: 2});

  // 7:00 without the closing: wait. 8:00 with the closing: send. 9:00: already sent.
  const tick = async at => (await call('POST', '/admin/t/test-venue/tick', {at})).json();
  assert.equal((await tick('2026-10-09T04:00:00Z')).decision, 'wait'); // 6:00 local
  assert.equal((await tick('2026-10-09T05:00:00Z')).decision, 'wait'); // 7:00 local, closing missing
  assert.equal((await ingest('batch-0003', [closing])).status, 200);
  // Morning bottle check (expected stock computed by the POS); a recount is a higher version.
  const bottles = (version, countedMl) => ({type: 'bottle_check', id: 'px-bottle-7', version, businessDate: '2026-10-08', countedAt: '2026-10-09T05:30:00Z', items: [
    {itemId: '1', name: 'Jägermeister', countedMl, expectedMl: 4100, costPerLitreCents: 45000},
    {itemId: '2', name: 'Tequila', countedMl: 880, expectedMl: 900, costPerLitreCents: 55000},
  ]});
  assert.equal((await ingest('batch-0003b', [{...bottles(1, 3000), registerId: 'bar'}])).status, 400, 'unknown field in bottle_check');
  assert.deepEqual(await (await ingest('batch-0003c', [bottles(1, 3000)])).json(), {batchId: 'batch-0003c', accepted: 1, stale: 0});
  assert.deepEqual(await (await ingest('batch-0003d', [bottles(2, 3650)])).json(), {batchId: 'batch-0003d', accepted: 1, stale: 0});
  const sent = await tick('2026-10-09T06:00:00Z'); // 8:00 local
  assert.equal(sent.decision, 'send');
  assert.equal(sent.businessDate, '2026-10-08');
  assert.match(sent.text, /Tržba: 1 200 Kč \(plán 1 200 Kč, \+0 %\)/);
  assert.match(sent.text, /\nLahve: manko 214 Kč \(2 spočítáno\)\n⚠ Jägermeister −450 ml \(203 Kč\)$/, 'recount wins, small loss hidden');
  assert.equal((await tick('2026-10-09T07:00:00Z')).decision, 'skip');

  // Next day nothing closes: 9:00 sends anyway, marked incomplete. The venue now expects a bottle check.
  assert.equal((await call('PUT', '/admin/t/test-venue/config', {...config, bottleCheck: {minLossCents: 10000}})).status, 200);
  await ingest('batch-0004', [bill('b3', 1, 30000, '2026-10-09')]);
  assert.equal((await tick('2026-10-10T06:00:00Z')).decision, 'wait'); // 8:00 local
  const late = await tick('2026-10-10T07:00:00Z'); // 9:00 local
  assert.equal(late.decision, 'send-incomplete');
  assert.match(late.text, /⚠ Report chybí: bar\./);
  assert.match(late.text, /\n⚠ Ranní kontrola lahví chybí\.$/);

  // Everything survives a restart; stored briefings are listed without guest data.
  await mf.dispose();
  mf = new Miniflare(options);
  const list = await (await call('GET', '/admin/t/test-venue/briefings')).json();
  assert.deepEqual(list.map(row => [row.businessDate, row.status, row.incomplete]), [['2026-10-09', 'stored', 1], ['2026-10-08', 'stored', 0]]);
  const preview = await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-08')).json();
  assert.equal(preview.briefing.revenueCents, 120000);
  assert.equal((await call('GET', '/admin/t/test-venue/briefing?date=2026-13-01')).status, 400);
  assert.equal((await call('GET', '/admin/t/other-venue/briefing?date=2026-10-08')).status, 409);

  // The morning cron wakes every configured venue.
  const worker = await mf.getWorker();
  await worker.scheduled({scheduledTime: new Date('2026-10-11T05:00:00Z'), cron: '0 5-8 * * *'});
  // SMS delivery through Twilio: a failed send is retried at the next send hour, then marked delivered.
  await mf.dispose();
  const sms = [];
  mf = new Miniflare({...options,
    bindings: {...options.bindings, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-only-token', TWILIO_FROM: '+420700000000'},
    outboundService: async request => {
      sms.push({url: request.url, auth: request.headers.get('authorization'), body: new URLSearchParams(await request.text())});
      return new Response('{}', {status: sms.length === 1 ? 500 : 201});
    },
  });
  await call('PUT', '/admin/t/sms-venue/config', {...config, registers: [], recipients: ['+420600000001']});
  await call('POST', '/admin/t/sms-venue/pair', {installationId: 'pos-installation-1', token});
  await ingest('batch-sms-1', [bill('s1'), closing], 'Bearer ' + token, 'sms-venue');
  const tickSms = async at => (await call('POST', '/admin/t/sms-venue/tick', {at})).json();
  assert.equal((await tickSms('2026-10-09T05:00:00Z')).status, 'failed');
  const delivered = await tickSms('2026-10-09T06:00:00Z');
  assert.equal(delivered.status, 'delivered');
  assert.equal((await tickSms('2026-10-09T07:00:00Z')).decision, 'skip');
  assert.equal(sms.length, 2);
  assert.equal(sms[1].url, 'https://api.twilio.com/2010-04-01/Accounts/AC-test/Messages.json');
  assert.equal(sms[1].auth, 'Basic ' + btoa('AC-test:test-only-token'));
  assert.equal(sms[1].body.get('To'), '+420600000001');
  assert.equal(sms[1].body.get('Body'), delivered.text);
  // BulkGate wins over Twilio: WhatsApp template first, then a 7-bit SMS from a text sender (gText).
  await mf.dispose();
  const bulk = [];
  mf = new Miniflare({...options,
    bindings: {...options.bindings, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-only-token', TWILIO_FROM: '+420700000000',
      BULKGATE_APP_ID: '12345', BULKGATE_TOKEN: 'test-only-bulkgate', WHATSAPP_SENDER: '+420 700 000 009'},
    outboundService: async request => {
      bulk.push({url: request.url, body: await request.json()});
      return Response.json(bulk.length === 1 ? {error: 'low_credit'} : {data: {response: [{status: 'accepted', number: '420600000002', channel: 'whatsapp'}]}}, {status: bulk.length === 1 ? 400 : 200});
    },
  });
  await call('PUT', '/admin/t/bulk-venue/config', {...config, registers: [], recipients: ['+420600000002']});
  await call('POST', '/admin/t/bulk-venue/pair', {installationId: 'pos-installation-1', token});
  await ingest('batch-bulk-1', [bill('b1'), closing], 'Bearer ' + token, 'bulk-venue');
  const tickBulk = async at => (await call('POST', '/admin/t/bulk-venue/tick', {at})).json();
  assert.equal((await tickBulk('2026-10-09T05:00:00Z')).status, 'failed');
  const bulkDelivered = await tickBulk('2026-10-09T06:00:00Z');
  assert.equal(bulkDelivered.status, 'delivered');
  assert.equal(bulk.length, 2);
  assert.equal(bulk[1].url, 'https://portal.bulkgate.com/api/2.0/advanced/transactional');
  const bulkBody = bulk[1].body;
  assert.deepEqual(bulkBody.number, ['420600000002']);
  assert.deepEqual(Object.keys(bulkBody.channel), ['whatsapp', 'sms']);
  assert.equal(bulkBody.channel.whatsapp.sender, '420700000009');
  assert.equal(bulkBody.channel.whatsapp.template.template, 'ranni_prehled');
  assert.equal(bulkBody.channel.whatsapp.template.body[0].text, bulkDelivered.text.split('\n').join(' | '));
  assert.deepEqual(bulkBody.channel.sms, {sender_id: 'gText', sender_id_value: 'JamesDean', unicode: false});
  assert.match(bulkBody.text, /^[\x20-\x7e\n]+$/);
  assert.ok(bulkBody.text.includes('Trzba'));
  // Venues without recipients stay 'stored' even with Twilio configured.
  assert.deepEqual((await (await call('GET', '/admin/t/test-venue/briefings')).json()).map(row => row.status), ['stored', 'stored']);
  // Managers' Excel on OneDrive: fetched only at 7, 8 and 9, archived, stored as the day's report; "Report dne" goes to Claude without names.
  await mf.dispose();
  const outbound = [];
  const files = {'https://test.files.1drv.com/report.xlsx': await xlsx(reportSheets()), 'https://test.files.1drv.com/book.xlsx': await xlsx(journalSheets())};
  mf = new Miniflare({...options,
    bindings: {...options.bindings, ANTHROPIC_API_KEY: 'test-only-anthropic'},
    outboundService: async request => {
      const url = new URL(request.url);
      outbound.push({url: request.url, body: request.method === 'POST' ? await request.text() : null, key: request.headers.get('x-api-key')});
      if (url.hostname === 'api.onedrive.com') {
        const day = outbound.filter(entry => entry.url.includes('onedrive')).length;
        return Response.json({name: 'Reporty', folder: {}, children: [
          {name: 'Peněžní deník.xlsx', file: {}, size: 5000, '@content.downloadUrl': 'https://test.files.1drv.com/book.xlsx'},
          ...(day >= 2 ? [{name: 'Denní report 9.10.2026.xlsx', file: {}, size: 5000, '@content.downloadUrl': 'https://test.files.1drv.com/report.xlsx'}] : []),
        ]});
      }
      if (url.hostname === 'test.files.1drv.com') return new Response(files[request.url]);
      if (url.hostname === 'api.anthropic.com') return Response.json({content: [{type: 'tool_use', name: 'report_points', input: {
        summary: '[X2] rozbil sklenici.', points: [{kind: 'task', text: 'Objednat led', amountCents: null}, {kind: 'incident', text: 'Host [X2] rozbil sklenici', amountCents: null}],
      }}]});
      return new Response('unexpected', {status: 599});
    },
  });
  const excelConfig = {...config, registers: ['diner', 'bar', 'klub'], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}, reportsLink: 'https://1drv.ms/f/s!synthetic-test'};
  assert.equal((await call('PUT', '/admin/t/excel-venue/config', {...excelConfig, reportsLink: 'https://example.com/x'})).status, 400);
  assert.equal((await call('PUT', '/admin/t/excel-venue/config', excelConfig)).status, 200);
  const tickExcel = async at => (await call('POST', '/admin/t/excel-venue/tick', {at})).json();
  assert.equal((await tickExcel('2026-10-10T04:00:00Z')).decision, 'wait'); // 6:00 local: nothing is fetched
  assert.equal(outbound.length, 0);
  // 7:00: only the cash book is there (with revenue), which is not the day's report: wait and look again at 8:00.
  assert.equal((await tickExcel('2026-10-10T05:00:00Z')).decision, 'wait');
  const excelSent = await tickExcel('2026-10-10T06:00:00Z'); // 8:00 local
  assert.equal(excelSent.decision, 'send');
  assert.equal(excelSent.businessDate, '2026-10-09');
  assert.match(excelSent.text, /Tržba: 390 000 Kč\nDiner 60 000 Kč · Bar 150 000 Kč · Klub 180 000 Kč\n/);
  assert.match(excelSent.text, /⚠ Přepočet pokladny nesedí se zůstatkem v deníku: přebývá 29 199 Kč/);
  assert.match(excelSent.text, /\nReport dne:\n⚠ Host Novák rozbil sklenici\n• Objednat led$/);
  const claude = outbound.find(entry => entry.url.startsWith('https://api.anthropic.com/'));
  assert.equal(claude.key, 'test-only-anthropic');
  assert.ok(!claude.body.includes('Novák') && !claude.body.includes('Zdeněk') && claude.body.includes('[X1]'), 'names are replaced before the text leaves OKO1');
  const stored = await (await call('GET', '/admin/t/excel-venue/report?date=2026-10-09')).json();
  assert.equal(stored.report.source, 'onedrive');
  assert.deepEqual(stored.report.files, ['Denní report 9.10.2026.xlsx', 'Peněžní deník.xlsx']);
  assert.equal(stored.notes.points.length, 2);
  // Next morning the day's report is missing: tried at 7 and 8, sent at 9 marked incomplete, never tried again.
  const before = outbound.filter(entry => entry.url.includes('onedrive')).length;
  assert.equal((await tickExcel('2026-10-11T05:00:00Z')).decision, 'wait');
  assert.equal((await tickExcel('2026-10-11T06:00:00Z')).decision, 'wait');
  const missing = await tickExcel('2026-10-11T07:00:00Z');
  assert.equal(missing.decision, 'send-incomplete');
  assert.match(missing.text, /⚠ Report chybí/);
  assert.equal((await tickExcel('2026-10-11T08:00:00Z')).decision, 'skip');
  assert.equal(outbound.filter(entry => entry.url.includes('onedrive')).length - before, 3);
  // A report can also be stored through the admin API (for example a corrected day); a changed text is analysed again.
  const manual = {businessDate: '2026-10-11', source: 'admin', files: [], warnings: [], notes: null,
    lines: [{kind: 'revenue_section', key: 'bar', label: 'Restaurace noc', count: null, amountCents: 100000}]};
  assert.equal((await call('PUT', '/admin/t/excel-venue/report', {...manual, lines: [{...manual.lines[0], amountCents: 'x'}]})).status, 400);
  assert.deepEqual(await (await call('PUT', '/admin/t/excel-venue/report', manual)).json(), {businessDate: '2026-10-11', lines: 1, notes: false, warnings: []});
  assert.equal((await (await call('GET', '/admin/t/excel-venue/briefing?date=2026-10-11')).json()).briefing.revenueCents, 100000);
  assert.equal((await call('GET', '/admin/t/excel-venue/report?date=11.10.2026')).status, 400);
  assert.deepEqual(await (await call('POST', '/admin/t/test-venue/fetch', {date: '2026-10-09'})).json(), {found: false, warnings: ['OneDrive: odkaz na složku není nastavený.']});
  const fetchesBefore = outbound.length;
  assert.deepEqual(await (await call('POST', '/admin/t/excel-venue/fetch', {date: '2026-10-09', keep: true})).json(), {found: true, kept: true, warnings: []}, 'history loading keeps a day with the daily report');
  assert.equal(outbound.length, fetchesBefore);

  // Dashboard: page with a strict CSP, login by SMS code to the owner, session cookie, day data, logout.
  await mf.dispose();
  const codes = [];
  mf = new Miniflare({...options,
    bindings: {...options.bindings, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-only-token', TWILIO_FROM: '+420700000000'},
    outboundService: async request => { codes.push(new URLSearchParams(await request.text()).get('Body')); return new Response('{}', {status: 201}); },
  });
  await call('PUT', '/admin/t/excel-venue/config', {...excelConfig, recipients: ['+420600000003']});
  const board = (method, path, body, headers = {}) => mf.dispatchFetch('http://local.test/d/excel-venue' + path, {method, headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  const page = await board('GET', '');
  assert.equal(page.status, 200);
  const csp = page.headers.get('content-security-policy'), nonce = csp.match(/'nonce-([a-f0-9]+)'/)[1];
  assert.match(csp, /default-src 'none'/);
  assert.ok((await page.text()).includes(`<script nonce="${nonce}">`));
  assert.equal((await board('GET', '/data')).status, 401);
  assert.equal((await mf.dispatchFetch('http://local.test/d/excel-venue/login', {method: 'POST', body: 'x'})).status, 415);
  // Only the owner's number gets a code; any other number and any unknown venue get the same answer and nothing is sent.
  assert.deepEqual(await (await board('POST', '/login', {phone: '+420 600 000 999'})).json(), {sent: true});
  assert.deepEqual(await (await mf.dispatchFetch('http://local.test/d/no-such-venue/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({phone: '+420600000003'})})).json(), {sent: true});
  assert.equal(codes.length, 0);
  assert.equal((await board('POST', '/login', {phone: '600 000 003'})).status, 200);
  assert.equal(codes.length, 1);
  const code = codes[0].match(/kód pro přihlášení (\d{6})/)[1];
  const wrong = code === '000000' ? '111111' : '000000';
  assert.equal((await board('POST', '/verify', {code: wrong})).status, 401);
  const verified = await board('POST', '/verify', {code});
  assert.equal(verified.status, 200);
  const session = verified.headers.get('set-cookie');
  assert.match(session, /^oko1_session=[a-f0-9]{64}; Path=\/d\/excel-venue; HttpOnly; Secure; SameSite=Strict/);
  assert.equal((await board('POST', '/verify', {code})).status, 401, 'a code works once');
  const cookieHeader = {cookie: session.split(';')[0]};
  const data = await (await board('GET', '/data?date=2026-10-09', undefined, cookieHeader)).json();
  assert.equal(data.briefing.revenueCents, 39000000);
  assert.equal(data.days.length, 35);
  assert.equal(data.days.at(-1).date, '2026-10-09');
  assert.deepEqual([data.balances.register, data.balances.safe], [14080100, 3000000]);
  assert.equal(data.todo[0].text, 'Přepočet pokladny nesedí s deníkem: +29 199 Kč');
  assert.equal((await board('GET', '/data', undefined, {cookie: 'oko1_session=' + 'f'.repeat(64)})).status, 401);
  assert.equal((await mf.dispatchFetch('http://local.test/d/excel-venue/data', {headers: cookieHeader})).status, 200, 'the session works without other headers');
  assert.equal((await mf.dispatchFetch('http://local.test/d/other-venue/data', {headers: cookieHeader})).status, 401, 'a session is valid for its venue only');
  // Parallel requests cannot pass the limit of five codes an hour (one is used already).
  const burst = await Promise.all(Array.from({length: 10}, () => board('POST', '/login', {phone: '+420600000003'})));
  assert.equal(burst.filter(r => r.status === 200).length, 4);
  assert.equal(codes.length, 5);
  // Guessing: after ten wrong codes in an hour (two above) the login closes, even for the right code.
  const fresh = codes[4].match(/(\d{6})/)[1];
  for (let i = 0; i < 8; i++) assert.equal((await board('POST', '/verify', {code: String(i).repeat(6) === fresh ? '999999' : String(i).repeat(6)})).status, 401);
  assert.equal((await board('POST', '/verify', {code: fresh})).status, 429);
  assert.equal((await board('POST', '/logout', {}, cookieHeader)).status, 200);
  assert.equal((await board('GET', '/data', undefined, cookieHeader)).status, 401);
  // Admin can end every session; a change of the allowed phones ends them too.
  assert.deepEqual(await (await call('POST', '/admin/t/excel-venue/logout', {})).json(), {ended: 0});

  // The admin script talks to a real HTTP endpoint: config, rkeeper-style CSV import, preview.
  await mf.dispose();
  mf = new Miniflare({...options, port: 0});
  const url = (await mf.ready).href;
  const runAdmin = (...args) => promisify(execFile)(process.execPath, ['scripts/admin.ts', ...args], {env: {...process.env, AI_OS_URL: url, AI_OS_ADMIN_SECRET: options.bindings.ADMIN_SECRET}});
  await writeFile(join(dir, 'config.json'), JSON.stringify({...config, name: 'Skript'}));
  await writeFile(join(dir, 'history.csv'), 'Datum;Pokladna;Tržba;Účty\n1.10.2026;Bar;"1 000,00";4\n1.10.2026;Klub;500;2\n24.9.2026;Bar;700;3\n');
  assert.match((await runAdmin('config', 'script-venue', join(dir, 'config.json'))).stdout, /"name": "Skript"/);
  assert.match((await runAdmin('history', 'script-venue', join(dir, 'history.csv'))).stdout, /Dnů: 2[\s\S]*imported: 2/);
  assert.match((await runAdmin('preview', 'script-venue', '2026-10-08')).stdout, /Skript · čtvrtek 8\. 10\. 2026[\s\S]*plán 1 100 Kč/);
  await assert.rejects(runAdmin('history', 'script-venue', join(dir, 'config.json')), /Soubor nemá hlavičku/);
  console.log('worker tests passed');
} finally {
  await mf?.dispose();
  await rm(dir, {recursive: true, force: true});
}
