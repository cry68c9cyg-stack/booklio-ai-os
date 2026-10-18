// End-to-end test on the real workerd runtime (Miniflare) with synthetic data only.
import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm} from 'node:fs/promises';
import {createHash, generateKeyPairSync, verify} from 'node:crypto';
import vm from 'node:vm';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {build} from 'esbuild';
import {Miniflare} from 'miniflare';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {writeFile} from 'node:fs/promises';
import {journalSheets, reportSheets, xlsx} from './xlsx-fixture.ts';
import {addDays, businessDate, localTime} from '../src/time.ts';

const dir = await mkdtemp(join(tmpdir(), 'ai-os-worker-'));
const webDir = await mkdtemp(join(tmpdir(), 'ai-os-web-'));
const admin = 'local-test-only-admin-secret-32-characters';
const token = 'a'.repeat(64);
let mf;
try {
  // Like wrangler: packages resolve for workerd (the MCP SDK and the OAuth provider).
  const bundle = await build({entryPoints: ['src/worker.ts'], bundle: true, write: false, format: 'esm', platform: 'neutral',
    mainFields: ['module', 'main'], conditions: ['workerd', 'worker', 'browser'], external: ['node:crypto', 'cloudflare:workers']});
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
  // Bookings from the reservation system: counts only, no guest names. A later change is a higher version.
  const booking = (id, version, businessDate, section, partySize, status, arrival) =>
    ({type: 'reservation', id, version, businessDate, startsAt: `${businessDate}T18:00:00Z`, section, partySize, status, arrival, source: 'web'});
  assert.equal((await ingest('batch-0003e', [{...booking('r1', 1, '2026-10-08', 'diner', 4, 'confirmed', null), name: 'Jan'}])).status, 400, 'guest data only inside guest');
  // Guest details (synthetic) are accepted inside `guest`; the briefing still shows only counts.
  assert.deepEqual(await (await ingest('batch-0003h', [{...booking('r9', 1, '2026-10-07', 'bar', 2, 'confirmed', null),
    guest: {code: 'JD-TEST', name: 'Zkušební Hostka', contactType: 'email', contact: 'host@example.test', tables: ['p1']}}])).json(), {batchId: 'batch-0003h', accepted: 1, stale: 0});
  // A booking stored with counts only takes its guest details at the same version, once; the same version again is stale.
  const counted = booking('r8', 5, '2026-10-06', 'bar', 2, 'confirmed', null);
  await ingest('batch-0003i', [counted]);
  assert.deepEqual(await (await ingest('batch-0003j', [{...counted, guest: {name: 'Zkušební Hostka'}}])).json(), {batchId: 'batch-0003j', accepted: 1, stale: 0});
  assert.deepEqual(await (await ingest('batch-0003k', [{...counted, guest: {name: 'Jiná'}}])).json(), {batchId: 'batch-0003k', accepted: 0, stale: 1});
  assert.deepEqual(await (await ingest('batch-0003f', [
    booking('r1', 1, '2026-10-08', 'diner', 4, 'confirmed', null), booking('r2', 1, '2026-10-08', 'club', 2, 'confirmed', 'no_show'),
    booking('r3', 1, '2026-10-09', 'diner', 3, 'confirmed', null), booking('r4', 1, '2026-10-09', 'club', 6, 'confirmed', null),
    booking('r5', 1, '2026-10-09', 'club', 2, 'pending', null),
  ])).json(), {batchId: 'batch-0003f', accepted: 5, stale: 0});
  // The reservation system uses the time of the last change in ms as the version.
  assert.deepEqual(await (await ingest('batch-0003g', [booking('r1', Date.parse('2026-10-08T21:00:00Z'), '2026-10-08', 'diner', 4, 'confirmed', 'arrived')])).json(), {batchId: 'batch-0003g', accepted: 1, stale: 0});
  // The website's daily traffic (totals only); a week before for the comparison; a later version overwrites the day.
  const traffic = (businessDate, version, visits) => ({type: 'web_traffic', id: `web-${businessDate}`, version, businessDate, visits, visitsWithAction: 12,
    origins: [{key: 'instagram', name: 'Instagram', visits: 40, withAction: 5}, {key: 'google', name: 'Google hledání', visits: 60, withAction: 6}, {key: 'qr', name: 'QR kód na stole', visits: 0, withAction: 0}],
    actions: {'rezervace-otevrena': 9, 'rezervace-odeslana': 4}, reviewScans: 2});
  assert.equal((await ingest('batch-0003l', [{...traffic('2026-10-08', 1, 100), origins: [{key: 'x', name: 'X', visits: 1}]}])).status, 400, 'origin needs withAction');
  assert.equal((await ingest('batch-0003m', [{...traffic('2026-10-08', 1, 100), visits: -1}])).status, 400, 'no negative counts');
  assert.deepEqual(await (await ingest('batch-0003n', [traffic('2026-10-01', 1, 80), traffic('2026-10-08', 1, 90), traffic('2026-10-08', 2, 110)])).json(),
    {batchId: 'batch-0003n', accepted: 3, stale: 0});
  // Reviews that reached the website's admin that day (counts only); an author or text is refused.
  const reviewDay = {type: 'review_summary', id: 'reviews-2026-10-08', version: 1, businessDate: '2026-10-08', waiting: 3, forManagement: 1, failed: 0,
    sources: [{key: 'google', name: 'Google', stars: [0, 0, 1, 0, 2], unrated: 0}, {key: 'tripadvisor', name: 'TripAdvisor', stars: [0, 0, 0, 1, 0], unrated: 0}]};
  assert.equal((await ingest('batch-0003o', [{...reviewDay, sources: [{...reviewDay.sources[0], author: 'Jan'}]}])).status, 400, 'no author');
  assert.equal((await ingest('batch-0003p', [{...reviewDay, text: 'Super'}])).status, 400, 'no text');
  assert.equal((await ingest('batch-0003q', [{...reviewDay, sources: [{...reviewDay.sources[0], stars: [1, 2, 3, 4]}]}])).status, 400, 'five star counts');
  assert.equal((await ingest('batch-0003r', [reviewDay])).status, 200);
  // Review averages: this week from 5. 10., the 4 weeks before from 7. 9. to 4. 10.; 6. 9. counts in neither.
  const reviewsOn = (businessDate, stars) => ({...reviewDay, id: `reviews-${businessDate}`, businessDate, sources: [{key: 'google', name: 'Google', stars, unrated: 0}]});
  assert.equal((await ingest('batch-0003t', [reviewsOn('2026-09-06', [5, 0, 0, 0, 0]), reviewsOn('2026-09-07', [0, 0, 0, 0, 5]), reviewsOn('2026-09-30', [0, 0, 0, 0, 5]),
    reviewsOn('2026-10-04', [0, 0, 0, 0, 5]), reviewsOn('2026-10-05', [2, 0, 0, 0, 0])])).status, 200);
  // Outlook, no-shows and the web funnel come from SQL sums over the stored bookings and traffic.
  await ingest('batch-0003s', [booking('r10', 1, '2026-10-01', 'diner', 5, 'confirmed', null), booking('r11', 1, '2026-10-10', 'bar', 3, 'cancelled', null)]);
  const outlookDay = (await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-14')).json()).briefing;
  assert.deepEqual([outlookDay.outlook.usualGuests, outlookDay.noShows], [6, null], 'Thursdays 8. 10. (4 + 2 guests) and 1. 10. (5 guests)');
  const sunday = (await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-11')).json()).briefing;
  assert.deepEqual([sunday.week.current.guests, sunday.week.current.noShowGuests, sunday.week.current.webSent, sunday.week.current.webConfirmed, sunday.week.current.cancelled], [19, 2, 4, 6, 1]);
  assert.deepEqual(sunday.week.current.origins, [{key: 'google', name: 'Google hledání', visits: 60, withAction: 6}, {key: 'instagram', name: 'Instagram', visits: 40, withAction: 5}],
    'website origins summed over the week, most visits first, none without visits');
  assert.deepEqual([sunday.week.current.reviews, sunday.week.current.rated, sunday.week.current.starsTenths, sunday.week.reviewsUsual.rated, sunday.week.reviewsUsual.starsTenths, sunday.week.reviewDrop], [6, 6, 32, 15, 50, true]);
  const monthEnd = (await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-31')).json()).briefing;
  assert.deepEqual(monthEnd.month.reviews, {reviews: 11, rated: 11, starsTenths: 40}, 'reviews of October on its last day, none from September');
  // Who sends and when (admin): installations, last batches and types, never the records themselves.
  const status = await (await call('GET', '/admin/t/test-venue/ingest')).json();
  assert.deepEqual(status.installations.map(row => row.installationId), ['pos-installation-1']);
  assert.ok(status.installations[0].lastSeenAt && status.batches.length && status.records.some(row => row.type === 'review_summary' && row.count === 6));
  assert.ok(!JSON.stringify(status).includes('Burger'), 'no record content');
  const sent = await tick('2026-10-09T06:00:00Z'); // 8:00 local
  assert.equal(sent.decision, 'send');
  assert.equal(sent.businessDate, '2026-10-08');
  assert.match(sent.text, /Tržba: 1 200 Kč \(plán 1 200 Kč, \+0 %\)/);
  assert.match(sent.text, /\nLahve: manko 214 Kč \(2 spočítáno\)\n⚠ Jägermeister −450 ml \(203 Kč\)\n/, 'recount wins, small loss hidden');
  assert.match(sent.text, /\nRezervace: 2 \(6 hostů\), nedorazilo 1 \(2 hosté\)\nDnes rezervováno: 2 \(9 hostů\) · club 1 · diner 1, čeká na potvrzení 1\n/, 'unknown sections keep their key');
  assert.match(sent.text, /\nWeb: 110 návštěv \(před týdnem 80, \+38 %\), 12 s rezervací, telefonem nebo navigací, odeslané rezervace 4, QR na recenze 2×\nOdkud: Google hledání 60 · Instagram 40\nRecenze: 4 nové, průměr 4,3 ★ \(Google 3 · TripAdvisor 1\), 1× 3 ★ a méně; v adminu čeká na odpověď 3, pro vedení 1$/);
  assert.equal((await tick('2026-10-09T07:00:00Z')).decision, 'skip');

  // Next day nothing closes: 9:00 sends anyway, marked incomplete. The venue now expects a bottle check.
  assert.equal((await call('PUT', '/admin/t/test-venue/config', {...config, bottleCheck: {minLossCents: 10000}})).status, 200);
  await ingest('batch-0004', [bill('b3', 1, 30000, '2026-10-09')]);
  assert.equal((await tick('2026-10-10T06:00:00Z')).decision, 'wait'); // 8:00 local
  const late = await tick('2026-10-10T07:00:00Z'); // 9:00 local
  assert.equal(late.decision, 'send-incomplete');
  assert.match(late.text, /⚠ Report chybí: bar\./);
  assert.match(late.text, /\n⚠ Ranní kontrola lahví chybí\.\n/);

  // Everything survives a restart; stored briefings are listed without guest data.
  await mf.dispose();
  mf = new Miniflare(options);
  const list = await (await call('GET', '/admin/t/test-venue/briefings')).json();
  assert.deepEqual(list.map(row => [row.businessDate, row.status, row.incomplete]), [['2026-10-09', 'stored', 1], ['2026-10-08', 'stored', 0]]);
  const preview = await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-08')).json();
  const guestDay = await (await call('GET', '/admin/t/test-venue/briefing?date=2026-10-07')).json();
  assert.match(guestDay.text, /Rezervace: 1 \(2 hosté\)/);
  assert.doesNotMatch(JSON.stringify(guestDay), /Zkušební Hostka|example\.test|JD-TEST/, 'no guest details in the briefing');
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
  let microsoftRenewal = 'renew-1', googleShared = false;
  // A synthetic key of OKO1's Google account, made for the test only.
  const googleKey = generateKeyPairSync('rsa', {modulusLength: 2048});
  const files = {'https://test.files.1drv.com/report.xlsx': await xlsx(reportSheets()), 'https://test.files.1drv.com/book.xlsx': await xlsx(journalSheets())};
  mf = new Miniflare({...options,
    bindings: {...options.bindings, ANTHROPIC_API_KEY: 'test-only-anthropic', ONEDRIVE_CLIENT_ID: 'test-client', GOOGLE_SERVICE_ACCOUNT: JSON.stringify({type: 'service_account', client_email: 'oko1@test.iam.gserviceaccount.com',
      private_key: googleKey.privateKey.export({type: 'pkcs8', format: 'pem'})})},
    outboundService: async request => {
      const url = new URL(request.url);
      outbound.push({url: request.url, body: request.method === 'POST' ? await request.text() : null, key: request.headers.get('x-api-key')});
      // OKO1's Microsoft access: sign-in code, then a renewal each morning (rotated); Graph opens the shared folder.
      if (url.hostname === 'login.microsoftonline.com') {
        const form = new URLSearchParams(outbound.at(-1).body);
        if (form.get('client_id') !== 'test-client') return Response.json({error: 'invalid_client'}, {status: 400});
        if (form.get('grant_type') === 'authorization_code' && form.get('code') === 'test-code' && form.get('code_verifier')) return Response.json({access_token: 'graph-1', refresh_token: 'renew-1'});
        if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') === microsoftRenewal) { microsoftRenewal = 'renew-2'; return Response.json({access_token: 'graph-2', refresh_token: 'renew-2'}); }
        return Response.json({error: 'invalid_grant'}, {status: 400});
      }
      if (url.hostname === 'graph.microsoft.com') {
        if (request.headers.get('authorization') !== 'Bearer graph-2') return new Response('', {status: 401});
        if (url.pathname.startsWith('/v1.0/shares/')) return Response.json({name: 'Reporty', id: 'root1', folder: {}, parentReference: {driveId: 'drive1'}, children: [
          {name: '2026-10', id: 'month1', folder: {}, parentReference: {driveId: 'drive1'}, lastModifiedDateTime: '2026-10-11T08:00:00Z'},
        ]});
        if (url.pathname === '/v1.0/drives/drive1/items/month1/children') return Response.json({value: [
          {name: 'Peněžní deník.xlsx', file: {}, size: 5000, '@microsoft.graph.downloadUrl': 'https://test.files.1drv.com/book.xlsx'},
          {name: 'Denní report 9.10.2026.xlsx', file: {}, size: 5000, '@microsoft.graph.downloadUrl': 'https://test.files.1drv.com/report.xlsx'},
        ]});
      }
      // Google Drive through OKO1's own Google account: a signed JWT for an access, then the Drive API.
      if (url.hostname === 'oauth2.googleapis.com') {
        const assertion = new URLSearchParams(outbound.at(-1).body).get('assertion') ?? '';
        const [head, claims, signature] = assertion.split('.');
        const valid = verify('RSA-SHA256', Buffer.from(head + '.' + claims), googleKey.publicKey, Buffer.from(signature ?? '', 'base64url'));
        const body = JSON.parse(Buffer.from(claims ?? '', 'base64url').toString() || '{}');
        if (!valid || body.iss !== 'oko1@test.iam.gserviceaccount.com' || body.scope !== 'https://www.googleapis.com/auth/drive.readonly') return Response.json({error: 'invalid_grant'}, {status: 400});
        return Response.json({access_token: 'google-1'});
      }
      if (url.hostname === 'www.googleapis.com') {
        if (request.headers.get('authorization') !== 'Bearer google-1') return new Response('', {status: 401});
        const q = url.searchParams.get('q') ?? '';
        if (url.pathname === '/drive/v3/files' && q.startsWith("'1GoogleRootFolder' in parents")) return Response.json({files: [{id: '1GoogleMonth', name: '2026-10', mimeType: 'application/vnd.google-apps.folder', modifiedTime: '2026-10-11T08:00:00Z'}]});
        if (url.pathname === '/drive/v3/files' && q.startsWith("'1GoogleMonth' in parents")) return Response.json({files: [
          {id: '1GoogleReport', name: 'Denní report 9.10.2026.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'},
          {id: '1GoogleBook', name: 'Peněžní deník', mimeType: 'application/vnd.google-apps.spreadsheet'},
        ]});
        if (url.pathname === '/drive/v3/files' && q.startsWith("name = 'OKO1 reporty'")) return Response.json({files: googleShared ? [{id: '1GoogleRootFolder'}] : []});
        if (url.pathname === '/drive/v3/files' ) return Response.json({error: {code: 404}}, {status: 404});
        if (url.pathname === '/drive/v3/files/1GoogleReport' && url.searchParams.get('alt') === 'media') return new Response(files['https://test.files.1drv.com/report.xlsx']);
        if (url.pathname === '/drive/v3/files/1GoogleBook/export') return new Response(files['https://test.files.1drv.com/book.xlsx']);
      }
      // New personal share links do not open through the public API any more.
      if (url.hostname === 'api.onedrive.com' && url.pathname.includes('u!' + Buffer.from('https://1drv.ms/f/c/synthetic/test').toString('base64url'))) return new Response('', {status: 401});
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
  // Without a link OKO1 looks for "OKO1 reporty" shared with its Google account (none is shared here).
  assert.deepEqual(await (await call('POST', '/admin/t/test-venue/fetch', {date: '2026-10-09'})).json(), {found: false, warnings: ['Google Drive: složka „OKO1 reporty“ není nasdílená účtu OKO1 (oko1@test.iam.gserviceaccount.com).']});
  const fetchesBefore = outbound.length;
  assert.deepEqual(await (await call('POST', '/admin/t/excel-venue/fetch', {date: '2026-10-09', keep: true})).json(), {found: true, kept: true, warnings: []}, 'history loading keeps a day with the daily report');
  assert.equal(outbound.length, fetchesBefore);
  // A new personal share link opens only with OKO1's Microsoft access: connected once from the dashboard, then renewed each fetch.
  const graphConfig = {...excelConfig, reportsLink: 'https://1drv.ms/f/c/synthetic/test'};
  assert.equal((await call('PUT', '/admin/t/excel-graph/config', graphConfig)).status, 200);
  const notConnected = await (await call('POST', '/admin/t/excel-graph/fetch', {date: '2026-10-09'})).json();
  assert.equal(notConnected.found, false);
  assert.match(notConnected.warnings[0], /nejde otevřít bez přihlášení.*Připojit OneDrive/);
  const withoutSession = await mf.dispatchFetch('http://local.test/d/excel-graph/onedrive', {redirect: 'manual'});
  assert.equal(withoutSession.status, 303);
  assert.equal(withoutSession.headers.get('location'), 'http://local.test/d/excel-graph', 'only a logged-in dashboard starts the sign-in');
  const graphStub = (await mf.getDurableObjectNamespace('TENANTS')).get((await mf.getDurableObjectNamespace('TENANTS')).idFromName('excel-graph'));
  const started = await graphStub.onedriveStart('excel-graph', 'http://local.test/onedrive/callback');
  const signin = new URL(started.body.url);
  assert.equal(signin.origin + signin.pathname, 'https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
  assert.equal(signin.searchParams.get('scope'), 'Files.Read offline_access');
  assert.equal(signin.searchParams.get('code_challenge_method'), 'S256');
  const state = signin.searchParams.get('state');
  assert.match(state, /^excel-graph~[a-f0-9]{48}$/);
  const finish = query => mf.dispatchFetch('http://local.test/onedrive/callback?' + new URLSearchParams(query));
  assert.equal((await finish({state: 'other~' + 'a'.repeat(48), code: 'test-code'})).status, 400);
  assert.equal((await finish({state, error: 'access_denied'})).status, 400);
  const connected = await finish({state, code: 'test-code'});
  assert.equal(connected.status, 200);
  assert.match(await connected.text(), /OneDrive je připojený/);
  assert.equal((await finish({state, code: 'test-code'})).status, 400, 'a sign-in is finished once');
  const fetchedGraph = await (await call('POST', '/admin/t/excel-graph/fetch', {date: '2026-10-09'})).json();
  assert.equal(fetchedGraph.found, true, JSON.stringify(fetchedGraph.warnings));
  assert.equal(microsoftRenewal, 'renew-2', 'the rotated renewal is kept');
  assert.deepEqual((await (await call('GET', '/admin/t/excel-graph/report?date=2026-10-09')).json()).report.files, ['Denní report 9.10.2026.xlsx', 'Peněžní deník.xlsx']);
  // A Google Drive folder shared only with OKO1's Google account (read-only); a folder not shared with it says so.
  assert.equal((await call('PUT', '/admin/t/excel-google/config', {...excelConfig, reportsLink: 'https://drive.google.com/drive/folders/1GoogleRootFolder?usp=sharing'})).status, 200);
  const fetchedGoogle = await (await call('POST', '/admin/t/excel-google/fetch', {date: '2026-10-09'})).json();
  assert.equal(fetchedGoogle.found, true, JSON.stringify(fetchedGoogle.warnings));
  assert.deepEqual((await (await call('GET', '/admin/t/excel-google/report?date=2026-10-09')).json()).report.files, ['Denní report 9.10.2026.xlsx', 'Peněžní deník.xlsx']);
  assert.equal((await (await call('POST', '/admin/t/excel-google/fetch', {date: '2026-10-08'})).json()).warnings[0], 'Google Drive: denní report za tento den ve složce není.');
  assert.equal((await call('PUT', '/admin/t/excel-google/config', {...excelConfig, reportsLink: 'https://drive.google.com/drive/folders/1NotSharedFolder'})).status, 200);
  assert.match((await (await call('POST', '/admin/t/excel-google/fetch', {date: '2026-10-09'})).json()).warnings[0], /není nasdílená účtu OKO1/);
  // No link at all: OKO1 finds the folder "OKO1 reporty" that someone shared with its Google account.
  assert.equal((await call('PUT', '/admin/t/excel-auto/config', {...excelConfig, reportsLink: ''})).status, 200);
  assert.match((await (await call('POST', '/admin/t/excel-auto/fetch', {date: '2026-10-09'})).json()).warnings[0], /„OKO1 reporty“ není nasdílená účtu OKO1 \(oko1@test\.iam\.gserviceaccount\.com\)/);
  googleShared = true;
  const fetchedAuto = await (await call('POST', '/admin/t/excel-auto/fetch', {date: '2026-10-09'})).json();
  assert.equal(fetchedAuto.found, true, JSON.stringify(fetchedAuto.warnings));
  assert.deepEqual((await (await call('GET', '/admin/t/excel-auto/report?date=2026-10-09')).json()).report.files, ['Denní report 9.10.2026.xlsx', 'Peněžní deník.xlsx']);
  googleShared = false;
  // Microsoft refuses the renewal: no access, the warning says to connect again.
  microsoftRenewal = 'revoked';
  const lost = await (await call('POST', '/admin/t/excel-graph/fetch', {date: '2026-10-10'})).json();
  assert.match(lost.warnings[0], /přístup OKO1 vypršel \(Microsoft 400 invalid_grant\)/);

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
  const pageText = await page.text();
  assert.ok(pageText.includes(`<script nonce="${nonce}">`));
  assert.match(pageText, /<input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="\[0-9\]\{6\}"/);
  assert.equal((await board('GET', '/data')).status, 401);
  assert.equal((await mf.dispatchFetch('http://local.test/d/excel-venue/login', {method: 'POST', body: 'x'})).status, 415);
  // Only the owner's number gets a code. Any other number and any unknown venue get the same answers (the code lives
  // 10 minutes, a second request within 60 s is 429 with the seconds to wait) and nothing is sent.
  const about = (value, target) => value === null || value === undefined ? value : Math.abs(Number(value) - target) <= 3 ? `~${target}` : value;
  const loginAnswer = async response => {
    const body = await response.json();
    return {status: response.status, retry: about(response.headers.get('retry-after'), 60), ...body,
      expiresAt: typeof body.expiresAt, expiresIn: about(body.expiresIn, 600), retryAfter: about(body.retryAfter, 60)};
  };
  const unknownVenue = phone => mf.dispatchFetch('http://local.test/d/no-such-venue/login', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({phone})});
  const twice = async send => [await loginAnswer(await send()), await loginAnswer(await send())];
  const stranger = await twice(() => board('POST', '/login', {phone: '+420 600 000 999'}));
  const nowhere = await twice(() => unknownVenue('+420600000003'));
  assert.equal(codes.length, 0);
  const owner = await twice(() => board('POST', '/login', {phone: '600 000 003'}));
  assert.equal(codes.length, 1, 'the second request within 60 s sends nothing');
  assert.deepEqual(owner, [
    {status: 200, retry: null, sent: true, expiresAt: 'string', expiresIn: '~600', retryAfter: '~60'},
    {status: 429, retry: '~60', error: 'TOO_SOON', expiresAt: 'undefined', expiresIn: '~600', retryAfter: '~60'},
  ]);
  assert.deepEqual(stranger, owner, 'a number without access cannot be told apart');
  assert.deepEqual(nowhere, owner, 'an unknown venue cannot be told apart');
  // The page counts the server's seconds down: the code's validity and the resend button.
  let fakeNow = 1e12;
  class FakeDate extends Date { static now() { return fakeNow; } }
  const loginElements = {}, intervals = [];
  const loginElement = id => loginElements[id] ??= {hidden: false, value: '', textContent: '', innerHTML: '', disabled: false, focus() {}};
  vm.runInNewContext(pageText.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1], {document: {getElementById: loginElement}, location: {reload() {}}, console,
    Date: FakeDate, setInterval: fn => intervals.push(fn), clearInterval() {},
    fetch: async url => url.endsWith('/login') ? {ok: true, status: 200, json: async () => ({sent: true, expiresIn: 600, retryAfter: 60})} : {ok: false, status: 401, json: async () => ({})}});
  await loginElements.phoneForm.onsubmit({preventDefault() {}});
  const loginShown = () => [loginElements.codeLeft.textContent, loginElements.again.disabled, loginElements.again.textContent];
  assert.deepEqual(loginShown(), ['Kód platí ještě 10:00', true, 'Poslat znovu za 1:00']);
  assert.equal(loginElements.loginMsg.textContent, 'Pokud má číslo přístup, kód je na cestě.');
  fakeNow += 18000; intervals[0]();
  assert.deepEqual(loginShown(), ['Kód platí ještě 9:42', true, 'Poslat znovu za 0:42']);
  fakeNow += 600000; intervals[0]();
  assert.deepEqual(loginShown(), ['Kód vypršel, pošli nový', false, 'Poslat kód znovu']);
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
  // Twelve weeks for the trends card, oldest first, the last one up to the shown day.
  assert.deepEqual([data.trends.length, data.trends[11].from, data.trends[11].to, data.trends[11].revenueCents, data.trends[0].to], [12, '2026-10-03', '2026-10-09', 39000000, '2026-07-24']);
  assert.deepEqual([data.balances.register, data.balances.safe], [14080100, 3000000]);
  assert.deepEqual(data.todo.slice(0, 4).map(item => item.text), ['Platba nesedí s deníkem, karta: report 380 000 Kč, deník 295 000 Kč',
    'Tržba nesedí s deníkem, Bar: report 150 000 Kč, deník 100 000 Kč', 'Tržba nesedí s deníkem, Klub: report 180 000 Kč, deník 150 000 Kč',
    'Přepočet pokladny nesedí s deníkem: +29 199 Kč'],
    'the synthetic report and cash book differ in card payments, the bar and the club; the bigger amount first');
  // The week up to the shown day against the week before, and every source with the time it last sent.
  assert.deepEqual([data.week.from, data.week.to, data.week.current.revenueCents, data.week.current.revenueDays], ['2026-10-03', '2026-10-09', 39000000, 1]);
  assert.ok(Array.isArray(data.sources.senders) && Array.isArray(data.sources.types));
  assert.equal(data.sources.report.found, true);
  // The month so far: one day of the synthetic report, its sections, and the cash book's payouts and expenses.
  assert.deepEqual([data.month.month, data.month.through, data.month.complete, data.month.current.revenueCents, data.month.current.revenueDays], ['2026-10', '2026-10-09', false, 39000000, 1]);
  assert.equal(data.month.current.bySection.reduce((sum, row) => sum + row.revenueCents, 0), 39000000);
  assert.deepEqual([data.month.payoutsCents, data.month.expensesCents], [data.briefing.report.payoutsCents, data.briefing.report.expensesCents]);
  assert.deepEqual([data.month.previous.month, data.month.previous.through, data.month.previous.revenueDays], ['2026-09', '2026-09-09', 0]);
  // "Vyřízeno": kept per day and item, only with a session, undone by the same switch.
  assert.ok(data.todo.every(item => /^[a-f0-9]{24}$/.test(item.key) && item.done === false));
  const first = data.todo[0];
  assert.equal((await board('POST', '/todo', {date: '2026-10-09', key: first.key, done: true})).status, 401, 'no session, no change');
  assert.equal((await board('POST', '/todo', {date: '2026-10-09', key: 'x', done: true}, cookieHeader)).status, 400);
  assert.equal((await board('POST', '/todo', {date: '2026-10-09', key: first.key, done: true}, cookieHeader)).status, 200);
  const marked = await (await board('GET', '/data?date=2026-10-09', undefined, cookieHeader)).json();
  assert.deepEqual(marked.todo.filter(item => item.done).map(item => item.text), [first.text]);
  assert.ok((await (await board('GET', '/data?date=2026-10-10', undefined, cookieHeader)).json()).todo.every(item => !item.done), 'another day is its own list');
  assert.equal((await board('POST', '/todo', {date: '2026-10-09', key: first.key, done: false}, cookieHeader)).status, 200);
  assert.ok((await (await board('GET', '/data?date=2026-10-09', undefined, cookieHeader)).json()).todo.every(item => !item.done), 'undone');
  assert.equal((await board('GET', '/data', undefined, {cookie: 'oko1_session=' + 'f'.repeat(64)})).status, 401);
  assert.equal((await mf.dispatchFetch('http://local.test/d/excel-venue/data', {headers: cookieHeader})).status, 200, 'the session works without other headers');
  assert.equal((await mf.dispatchFetch('http://local.test/d/other-venue/data', {headers: cookieHeader})).status, 401, 'a session is valid for its venue only');
  // Later codes: the Durable Object takes the time as a parameter (only tests pass it, the routes never do), so the
  // minutes and hours pass without waiting. 60 s later a new code goes out and the earlier one stops working.
  const tenants = await mf.getDurableObjectNamespace('TENANTS');
  const excelObject = tenants.get(tenants.idFromName('excel-venue'));
  const send = async (phone, offset) => JSON.parse(JSON.stringify(await excelObject.sendLoginCode(phone, '', t0 + offset)));
  const lastCode = () => codes.at(-1).match(/(\d{6})/)[1];
  const t0 = Date.now();
  assert.equal((await send('+420600000003', 61000)).status, 200);
  const older = lastCode();
  assert.equal((await send('+420600000003', 122000)).status, 200);
  assert.equal((await board('POST', '/verify', {code: older})).status, 401, 'a new code ends the earlier one');
  // Parallel requests cannot pass the 60 seconds: one code out of ten.
  const burst = await Promise.all(Array.from({length: 10}, () => send('+420600000003', 183000)));
  assert.deepEqual(burst.map(answer => answer.status).sort(), [200, ...Array(9).fill(429)]);
  assert.equal(codes.length, 4);
  // Five codes an hour and ten a day stay; the answer says when the next one can go. A number without access gets the same.
  for (const offset of [61000, 122000, 183000]) assert.equal((await send('+420600000999', offset)).status, 200);
  const ownerAt = {};
  for (const offset of [244000, 305000, 7200000, 7261000, 7322000, 7383000, 7444000, 7505000]) {
    const ownerAnswer = ownerAt[offset] = await send('+420600000003', offset), strangerAnswer = await send('+420600000999', offset);
    assert.equal(ownerAnswer.status, strangerAnswer.status, `same status at ${offset}`);
    assert.equal(ownerAnswer.body.error, strangerAnswer.body.error);
    assert.ok(Math.abs((ownerAnswer.body.retryAfter ?? 0) - (strangerAnswer.body.retryAfter ?? 0)) <= 5);
  }
  const hourFull = ownerAt[305000].body, dayFull = ownerAt[7505000].body;
  assert.equal(hourFull.error, 'TOO_MANY');
  assert.ok(hourFull.retryAfter > 3200 && hourFull.retryAfter <= 3600 - 305, 'the hour frees up an hour after its first code');
  assert.equal(dayFull.error, 'TOO_MANY');
  assert.ok(dayFull.retryAfter > 86400 - 7505 - 10 && dayFull.retryAfter <= 86400 - 7505, 'the day frees up a day after its first code');
  assert.equal(codes.length, 10, 'ten codes a day at most');
  // Guessing: after ten wrong codes in an hour (three above) the login closes, even for the right code, and says how long.
  const fresh = lastCode();
  for (let i = 0; i < 7; i++) assert.equal((await board('POST', '/verify', {code: String(i).repeat(6) === fresh ? '999999' : String(i).repeat(6)})).status, 401);
  const closed = await board('POST', '/verify', {code: fresh});
  assert.equal(closed.status, 429);
  assert.ok((await closed.json()).retryAfter > 3500 && Number(closed.headers.get('retry-after')) > 3500);
  assert.equal((await board('POST', '/logout', {}, cookieHeader)).status, 200);
  assert.equal((await board('GET', '/data', undefined, cookieHeader)).status, 401);
  // Admin can end every session; a change of the allowed phones ends them too.
  assert.deepEqual(await (await call('POST', '/admin/t/excel-venue/logout', {})).json(), {ended: 0});

  // Web James Dean read live (docs/web-v1.md): the MCP server behind OAuth, the dashboard card, nothing from the web stored.
  await mf.dispose();
  const webToken = 'e'.repeat(64);
  const guestName = 'Zuzana <b>Testovaci</b> Hostova', guestPhone = '+420777000111', guestNote = '<img src=x onerror=alert(1)>';
  const prague = at => localTime(at, 'Europe/Prague');
  const today = businessDate(new Date(), 'Europe/Prague', 6), calendar = prague(new Date()).date;
  const webBooking = (id, extra) => ({_klic: String(id), id, kod: `JD-AAA${id}`, stav: 'potvrzena', zdroj: 'web', osoby: 2, prostor: 'diner', datum: today, cas: '19:00',
    zacatek: `${today}T17:00:00.000Z`, jmeno: 'Petr Synteticky', kontakt_typ: 'email', kontakt: 'petr@example.com', poznamka: null, prichod: null, ...extra});
  const web = {down: false, requests: [], tables: {
    rezervace: [webBooking(1, {osoby: 4, jmeno: guestName, kontakt_typ: 'tel', kontakt: guestPhone, poznamka: guestNote}), webBooking(2, {stav: 'nova', prostor: 'klub', cas: '22:00', zacatek: `${today}T20:00:00.000Z`}),
      webBooking(3, {stav: 'zrusena_hostem'}), webBooking(4, {stav: 'nova', datum: addDays(today, 3)})],
    rezervace_stoly: [{_klic: '1|p4', rezervace_id: 1, stul: 'p4'}, {_klic: '1|p5', rezervace_id: 1, stul: 'p5'}, {_klic: '2|kA', rezervace_id: 2, stul: 'kA'}],
    hoste: [{_klic: '10', id: 10, jmeno: guestName, kontakt: guestPhone, kontakt_typ: 'tel', pocet_rezervaci: 5}],
    hoste_pozvanky: [], cerna_listina_vyrazeni: [],
    nedorazeni: [1, 2, 3].map(i => ({_klic: String(i), id: i, rezervace_id: 100 + i, kontakt_typ: 'tel', kontakt: guestPhone, jmeno: guestName, datum: '2026-09-0' + i})),
    zpravy: [{_klic: '50', id: 50, rezervace_id: 1, kanal: 'sms', druh: 'potvrzeni', vysledek: 'odeslano', vytvoreno: '2026-10-01T10:00:00.000Z'}],
    recenze: [{_klic: '7', id: 7, stav: 'nova', zdroj: 'google', hvezdicky: 2, autor: 'Recenzent <i>X</i>', text: 'Pomalá obsluha', datum: today},
      {_klic: '8', id: 8, stav: 'odeslano', zdroj: 'tripadvisor', hvezdicky: 5, autor: 'Spokojený', text: 'Super', datum: today}],
    objednavky_karet: [{_klic: '20', id: 20, kod: 'JD-K-AB12', stav: 'zaplacena', jmeno: 'Karta Kupujici', polozky: '[{"druh":"voucher","hodnota":1000,"kusy":2}]', celkem_kc: 2000, vytvoreno: `${today}T09:00:00.000Z`}],
    platby: [], blokace: [], blokace_stoly: [], akce: [], akce_kanaly: [], akce_fotky: [], pozvanky: [], pozvanky_rozeslani: [], skeny_qr: [],
  }};
  const dateColumn = {rezervace: 'datum', nedorazeni: 'datum', zpravy: 'vytvoreno', recenze: 'datum', objednavky_karet: 'vytvoreno', platby: 'vytvoreno', blokace: 'od', akce: 'datum', pozvanky: 'vytvoreno', skeny_qr: 'cas'};
  const filters = {rezervace: ['id', 'kod', 'kontakt', 'stav', 'zdroj', 'prostor'], rezervace_stoly: ['rezervace_id', 'stul'], hoste: ['id', 'kontakt'], hoste_pozvanky: ['kontakt'],
    nedorazeni: ['kontakt', 'rezervace_id'], cerna_listina_vyrazeni: ['kontakt'], zpravy: ['rezervace_id'], recenze: ['stav', 'zdroj'], objednavky_karet: ['id', 'kod', 'stav'], platby: ['rezervace_id', 'stav']};
  /** The web's read-only API with synthetic data: Bearer token, pages of two rows, od/do and rovno like the real one. */
  const fakeWeb = url => {
    if (url.pathname === '/api/oko1/v1/tabulky') return Response.json({tabulky: Object.keys(web.tables).map(nazev => ({nazev, klic: ['id'], datum: dateColumn[nazev] ?? null, filtry: filters[nazev] ?? []}))});
    const table = url.pathname.match(/^\/api\/oko1\/v1\/tabulka\/([a-z_]+)$/)?.[1];
    if (table) {
      if (!web.tables[table]) return Response.json({chyba: 'Tabulka není k dispozici.'}, {status: 404});
      let rows = web.tables[table].map((row, i) => ({row, rowid: i + 1}));
      const [from, to] = [url.searchParams.get('od'), url.searchParams.get('do')];
      if ((from || to) && !dateColumn[table]) return Response.json({chyba: 'Tabulka se nedá zúžit podle dne.'}, {status: 422});
      if (from) rows = rows.filter(({row}) => String(row[dateColumn[table]]).slice(0, 10) >= from);
      if (to) rows = rows.filter(({row}) => String(row[dateColumn[table]]).slice(0, 10) <= to);
      for (const equal of url.searchParams.getAll('rovno')) {
        const [column, ...rest] = equal.split(':');
        if (!filters[table]?.includes(column)) return Response.json({chyba: `Podle sloupce „${column}“ tabulka ${table} filtrovat nejde.`}, {status: 422});
        rows = rows.filter(({row}) => String(row[column]) === rest.join(':'));
      }
      const after = Number(url.searchParams.get('po') ?? 0), size = Math.min(2, Number(url.searchParams.get('limit') ?? 1000));
      const page = rows.filter(entry => entry.rowid > after).slice(0, size);
      return Response.json({nazev: table, radky: page.map(entry => entry.row), dalsi: page.length === size ? page.at(-1).rowid : null});
    }
    if (url.pathname === '/api/oko1/v1/navstevnost') return Response.json({statistiky: {dnes: calendar, od: url.searchParams.get('od'), prvniDen: '2026-10-05', prvniSken: null,
      dny: [{den: addDays(calendar, -1), navstevy: 30, sAkci: 5, skenyHodnoceni: 0}, {den: calendar, navstevy: 42, sAkci: 7, skenyHodnoceni: 1}]}, online: {celkem: 2, minut: 5, stranky: [], zarizeni: [], jazyky: []}});
    if (url.pathname === '/api/oko1/v1/prehled') return Response.json({potvrzovani: {automaticke: false, zmeneno: null}, dobaDrzeniMin: 120, kapacitaWebu: null, asistenti: null, kopieNaEmail: false, kredity: null, cekajici: 2});
    return Response.json({chyba: 'Nenalezeno.'}, {status: 404});
  };
  const texts = [];
  const webOptions = {...options, durableObjectsPersist: join(webDir, 'do'), kvNamespaces: ['OAUTH_KV'], kvPersist: join(webDir, 'kv'), r2Buckets: ['ARCHIVE'], r2Persist: join(webDir, 'r2'),
    bindings: {...options.bindings, WEB_TOKEN_JAMES_DEAN: webToken, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-only-token', TWILIO_FROM: '+420700000000'},
    outboundService: async request => {
      const url = new URL(request.url);
      if (url.hostname === 'jamesdean.cz') {
        web.requests.push({path: url.pathname + url.search, auth: request.headers.get('authorization'), method: request.method});
        if (web.down) return new Response('down', {status: 503});
        if (request.headers.get('authorization') !== 'Bearer ' + webToken) return Response.json({chyba: 'Neplatný token.'}, {status: 401});
        return fakeWeb(url);
      }
      if (url.hostname === 'api.twilio.com') { texts.push(new URLSearchParams(await request.text()).get('Body')); return new Response('{}', {status: 201}); }
      return new Response('unexpected', {status: 599});
    },
  };
  mf = new Miniflare(webOptions);
  const jdConfig = {...config, name: 'James Dean', registers: [], recipients: ['+420600000009'], web: {url: 'https://jamesdean.cz'}};
  assert.equal((await call('PUT', '/admin/t/james-dean/config', {...jdConfig, web: {url: 'https://evil.example'}})).status, 400);
  assert.equal((await call('PUT', '/admin/t/james-dean/config', jdConfig)).status, 200);
  await call('POST', '/admin/t/james-dean/pair', {installationId: 'pos-installation-1', token});
  assert.equal((await ingest('batch-web-1', [bill('w1', 1, 80000, today)], 'Bearer ' + token, 'james-dean')).status, 200);
  // The menu from the website (synthetic items): the first one is the starting point, then every change is kept.
  const menuItem = (id, part, category, name, pricesCents, extra = {}) => ({id, part, category, name, pricesCents, ...extra});
  const menu = (version, items) => ({type: 'menu', id: 'menu-web', version, businessDate: today, source: 'web', items,
    notes: [{part: 'drinks', category: 'Káva', text: 'Alternativní mléko za příplatek 20 Kč.'}]});
  const firstMenu = menu(1, [menuItem('food:burgery:classic', 'food', 'Burgery', 'Classic <b>Burger</b>', [22500, 25500], {description: '90 / 150 g hovězího', tip: true}),
    menuItem('food:burgery:texas', 'food', 'Burgery', 'Texas Burger', [24500]), menuItem('drinks:kava:espresso', 'drinks', 'Káva', 'Espresso', [6200]),
    menuItem('drinks:vodka:x', 'drinks', 'Destiláty', 'Vodka X', [9000], {group: 'Vodka', volume: '0,04 l', volumeMl: 40})]);
  const jdIngest = (batchId, records) => ingest(batchId, records, 'Bearer ' + token, 'james-dean');
  assert.equal((await jdIngest('batch-menu-0', [{...firstMenu, items: [...firstMenu.items, firstMenu.items[0]]}])).status, 400, 'item ids are unique');
  assert.equal((await jdIngest('batch-menu-0', [{...firstMenu, items: [{...firstMenu.items[0], pricesCents: []}]}])).status, 400, 'an item has a price');
  assert.equal((await jdIngest('batch-menu-0', [{...firstMenu, items: [{...firstMenu.items[0], part: 'club'}]}])).status, 400, 'known parts only');
  assert.equal((await jdIngest('batch-menu-0', [{...firstMenu, items: [{...firstMenu.items[0], cost: 100}]}])).status, 400, 'no unknown fields');
  assert.deepEqual(await (await jdIngest('batch-menu-1', [firstMenu])).json(), {batchId: 'batch-menu-1', accepted: 1, stale: 0});
  const secondMenu = menu(2, [{...firstMenu.items[0], pricesCents: [22500, 26500]}, {...firstMenu.items[1], pricesCents: [25900]}, firstMenu.items[2],
    menuItem('food:dezerty:pie', 'food', 'Dezerty', 'Apple Pie', [14500])]);
  assert.deepEqual(await (await jdIngest('batch-menu-2', [secondMenu])).json(), {batchId: 'batch-menu-2', accepted: 1, stale: 0});
  assert.deepEqual(await (await jdIngest('batch-menu-3', [firstMenu])).json(), {batchId: 'batch-menu-3', accepted: 0, stale: 1}, 'an older menu changes nothing');
  // The menu for the POS (Pexeso takes it over): only a paired installation, with each item's kind and VAT rate; `since` = nothing new.
  const posMenu = (query, auth = 'Bearer ' + token) => call('GET', `/v1/t/james-dean/menu?${query}`, undefined, auth);
  assert.equal((await posMenu('installationId=pos-installation-1', null)).status, 401);
  assert.equal((await posMenu('installationId=pos-installation-1', 'Bearer ' + 'b'.repeat(64))).status, 401);
  assert.equal((await posMenu('installationId=pos-installation-2')).status, 401);
  assert.equal((await call('POST', '/v1/t/james-dean/menu?installationId=pos-installation-1', {}, 'Bearer ' + token)).status, 405);
  const forPos = (await (await posMenu('installationId=pos-installation-1')).json()).menu;
  assert.deepEqual([forPos.version, forPos.businessDate, typeof forPos.receivedAt, forPos.notes.length], [2, today, 'string', 1]);
  assert.deepEqual(forPos.items.map(item => [item.id, item.pricesCents, item.kind, item.vatRate]), [['food:burgery:classic', [22500, 26500], 'food', 12],
    ['food:burgery:texas', [25900], 'food', 12], ['drinks:kava:espresso', [6200], 'soft', 12], ['food:dezerty:pie', [14500], 'food', 12]]);
  assert.deepEqual(await (await posMenu('installationId=pos-installation-1&since=2')).json(), {menu: null, unchanged: true, version: 2});
  assert.equal((await (await posMenu('installationId=pos-installation-1&since=1')).json()).menu.version, 2);
  // Supplier invoices (interim from Dishboard, synthetic): an older purchase, a dearer one now and an unpaid invoice past its due date.
  const invoice = (id, businessDate, items, extra = {}) => ({type: 'supplier_invoice', id, version: 1, businessDate, source: 'dishboard', supplier: 'Velkoobchod <Test>',
    netCents: items.reduce((sum, item) => sum + item.netCents, 0), grossCents: Math.round(items.reduce((sum, item) => sum + item.netCents, 0) * 1.12), kind: 'food', items, ...extra});
  const berries = (unitPriceCents, quantity = 10) => ({name: 'Borůvky 125 g', quantity, unit: 'ks', unitPriceCents, netCents: unitPriceCents * quantity});
  assert.equal((await jdIngest('batch-inv-0', [{...invoice('inv-1', addDays(today, -40), [berries(4070)]), kind: 'meat'}])).status, 400, 'known kinds only');
  assert.equal((await jdIngest('batch-inv-0', [{...invoice('inv-1', addDays(today, -40), [berries(4070)]), guest: {name: 'X'}}])).status, 400, 'no unknown fields');
  assert.deepEqual(await (await jdIngest('batch-inv-1', [invoice('inv-1', addDays(today, -40), [berries(4070)], {dueDate: addDays(today, -30), paidDate: addDays(today, -31)}),
    invoice('inv-2', addDays(today, -1), [berries(5159)], {number: '2026-118', dueDate: addDays(today, -1)}),
    invoice('inv-3', addDays(today, -1), [{name: 'Pivo 50 l', quantity: 2, unit: 'sud', unitPriceCents: 250000, netCents: 500000, kind: 'beverage'}], {status: 'cancelled'})])).json(),
  {batchId: 'batch-inv-1', accepted: 3, stale: 0});
  // The Monday message (Sunday's report) has a line on the menu's changes over the week.
  const menuSunday = [0, 1, 2, 3, 4, 5, 6].map(i => addDays(calendar, i)).find(day => new Date(day + 'T12:00:00Z').getUTCDay() === 0);
  const menuMonday = await (await call('GET', `/admin/t/james-dean/briefing?date=${menuSunday}`)).json();
  assert.deepEqual([menuMonday.briefing.menuWeek.prices.length, menuMonday.briefing.menuWeek.added, menuMonday.briefing.menuWeek.removed], [2, ['Apple Pie'], ['Vodka X']]);
  assert.match(menuMonday.text, /\nLístek za týden: nová cena 2× \(.+ → .+\) · nově Apple Pie · zrušeno Vodka X(\n|$)/);
  assert.match(menuMonday.text, /\nNa webu opravit v lístku: chybí popis nebo složení 2× \(Texas Burger, Apple Pie\)(\n|$)/);
  assert.ok(menuMonday.briefing.menuGaps.total === 2 && !(await (await call('GET', `/admin/t/james-dean/briefing?date=${addDays(menuSunday, -1)}`)).json()).briefing.menuGaps, 'Mondays only');
  const local = (path, init = {}) => mf.dispatchFetch('http://localhost' + path, init);

  // The admin check reads only the list of tables and never shows the token.
  const check = await (await call('GET', '/admin/t/james-dean/web')).json();
  assert.deepEqual(check, {url: 'https://jamesdean.cz', secret: 'WEB_TOKEN_JAMES_DEAN', token: true, ok: true, tables: 18, error: null});
  assert.deepEqual(web.requests.map(entry => entry.path), ['/api/oko1/v1/tabulky']);
  web.requests.length = 0;
  assert.equal((await call('GET', '/admin/t/james-dean/web', undefined, null)).status, 401);

  // Without an OAuth token the MCP server answers 401 and points to its metadata.
  const rpc = (id, method, params = {}) => JSON.stringify({jsonrpc: '2.0', id, method, params});
  const mcpHeaders = {'content-type': 'application/json', accept: 'application/json, text/event-stream'};
  const anonymous = await local('/mcp', {method: 'POST', headers: mcpHeaders, body: rpc(1, 'tools/list')});
  assert.equal(anonymous.status, 401);
  assert.match(anonymous.headers.get('www-authenticate'), /resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource\/mcp"/);
  assert.equal((await local('/mcp', {method: 'POST', headers: {...mcpHeaders, authorization: 'Bearer x:y:z'}, body: rpc(1, 'tools/list')})).status, 401);
  assert.equal((await (await local('/.well-known/oauth-protected-resource/mcp')).json()).resource, 'http://localhost/mcp');
  assert.equal(web.requests.length, 0);

  // Connecting Claude: client registration, venue + phone, the SMS code, then the code exchange with PKCE.
  const registered = await (await local('/oauth/register', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({
    redirect_uris: ['http://localhost:7777/callback'], client_name: 'Claude <test>', token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code']})})).json();
  const verifier = 'synthetic-pkce-verifier-'.padEnd(64, 'x');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorizeUrl = '/oauth/authorize?' + new URLSearchParams({response_type: 'code', client_id: registered.client_id, redirect_uri: 'http://localhost:7777/callback',
    code_challenge: challenge, code_challenge_method: 'S256', state: 'state-123', resource: 'http://localhost/mcp'});
  const formPost = (fields, origin = 'http://localhost', site) => local(authorizeUrl, {method: 'POST', redirect: 'manual',
    headers: {'content-type': 'application/x-www-form-urlencoded', origin, ...(site ? {'sec-fetch-site': site} : {})}, body: new URLSearchParams(fields).toString()});
  const consent = await local(authorizeUrl);
  assert.equal(consent.status, 200);
  assert.match(consent.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  const consentPage = await consent.text();
  assert.ok(consentPage.includes('Claude &lt;test&gt;') && !consentPage.includes('Claude <test>'), 'the client name is escaped');
  assert.equal((await local('/oauth/authorize?client_id=nobody&response_type=code')).status, 400);
  assert.equal((await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600000009'}, 'https://evil.example')).status, 403);
  // The page sends the real origin (referrer-policy same-origin); Origin: null passes only as a same-origin request.
  assert.equal(consent.headers.get('referrer-policy'), 'same-origin');
  assert.equal((await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600000009'}, 'null', 'cross-site')).status, 403);
  assert.equal((await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600000009'}, 'null')).status, 403);
  const pageOf = async response => ({status: response.status, csp: response.headers.get('content-security-policy'), html: await response.text()});
  const unknownFirst = await pageOf(await formPost({krok: 'kod', provozovna: 'no-such-venue', telefon: '600000009'}, 'null', 'same-origin'));
  assert.match(unknownFirst.html, /Kód z SMS/);
  assert.equal(texts.length, 0);
  // Another number or an unknown venue gets the same pages (the countdown, 429 within 60 s) and nothing is sent.
  const unknownAgain = await pageOf(await formPost({krok: 'kod', provozovna: 'no-such-venue', telefon: '600000009'}));
  const strangerFirst = await pageOf(await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600000123'}));
  const strangerAgain = await pageOf(await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600000123'}));
  assert.equal(texts.length, 0);
  const ownerFirst = await pageOf(await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600 000 009'}));
  assert.equal(ownerFirst.status, 200);
  assert.equal(texts.length, 1);
  const ownerAgain = await pageOf(await formPost({krok: 'kod', provozovna: 'james-dean', telefon: '600 000 009'}));
  assert.equal(ownerAgain.status, 429);
  assert.equal(texts.length, 1, 'a second code within 60 s is not sent');
  // The code step: a field iPhone and iPad fill from Messages, a countdown script allowed only by its nonce, data from the server.
  const scriptNonce = ownerFirst.html.match(/<script nonce="([a-f0-9]{32})">/)[1];
  assert.match(ownerFirst.csp, new RegExp(`^default-src 'none'; script-src 'nonce-${scriptNonce}'; style-src 'nonce-${scriptNonce}'; base-uri 'none'; frame-ancestors 'none'$`));
  assert.match(ownerFirst.html, /<input id="kod" name="kod" inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="\[0-9\]\{6\}"/);
  assert.match(ownerFirst.html, /data-expires-in="600" data-retry-after="60"><span data-left>Platí 10 minut\.<\/span>/);
  assert.match(ownerFirst.html, /<button class="secondary" data-again>Poslat kód znovu<\/button>/);
  assert.match(ownerAgain.html, /data-expires-in="(59\d|600)" data-retry-after="(5\d|60)"/);
  assert.match(ownerAgain.html, /<noscript><p class="muted">Nový kód půjde poslat za \d+ s\.<\/p><\/noscript>/);
  assert.match(ownerAgain.html, /<p class="warn" role="alert"><\/p>/, 'too soon shows only the countdown');
  const same = page => ({status: page.status, html: page.html.replace(/nonce="[a-f0-9]{32}"/g, 'nonce')
    .replace(/data-(expires-in|retry-after)="(\d+)"/g, (_, name, n) => `data-${name}="${Math.abs(n - (name === 'expires-in' ? 600 : 60)) <= 3 ? '~' : n}"`)
    .replace(/name="(provozovna|telefon)" value="[^"]*"/g, 'name="$1"').replace(/za \d+ s\./g, 'za ~ s.')});
  assert.deepEqual(same(strangerFirst), same(ownerFirst), 'a number without access cannot be told apart');
  assert.deepEqual(same(unknownFirst), same(ownerFirst), 'an unknown venue cannot be told apart');
  assert.deepEqual(same(strangerAgain), same(ownerAgain));
  assert.deepEqual(same(unknownAgain), same(ownerAgain));
  // The countdown counts the server's seconds down: "Kód platí ještě 9:42", "Poslat znovu za 0:42", then expired and unlocked.
  let pageNow = 1e12;
  class PageDate extends Date { static now() { return pageNow; } }
  const left = {textContent: ''}, again = {textContent: 'Poslat kód znovu', disabled: false}, pageTimers = [];
  const box = {dataset: {expiresIn: '600', retryAfter: '60'}, querySelector: () => left};
  vm.runInNewContext(ownerFirst.html.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1], {
    document: {querySelector: selector => selector === '[data-countdown]' ? box : again}, Date: PageDate, setInterval: fn => pageTimers.push(fn), clearInterval() {}});
  assert.deepEqual([left.textContent, again.disabled, again.textContent], ['Kód platí ještě 10:00', true, 'Poslat znovu za 1:00']);
  pageNow += 18000; pageTimers[0]();
  assert.deepEqual([left.textContent, again.textContent], ['Kód platí ještě 9:42', 'Poslat znovu za 0:42']);
  pageNow += 600000; pageTimers[0]();
  assert.deepEqual([left.textContent, again.disabled, again.textContent], ['Kód vypršel, pošli nový', false, 'Poslat kód znovu']);
  const mcpCode = texts[0].match(/(\d{6})/)[1];
  assert.equal((await formPost({krok: 'overit', provozovna: 'james-dean', kod: mcpCode === '000000' ? '111111' : '000000'})).status, 401);
  assert.equal((await formPost({krok: 'overit', provozovna: 'no-such-venue', kod: mcpCode})).status, 401);
  const approved = await formPost({krok: 'overit', provozovna: 'james-dean', kod: mcpCode});
  assert.equal(approved.status, 302);
  const callback = new URL(approved.headers.get('location'));
  assert.equal(callback.origin + callback.pathname, 'http://localhost:7777/callback');
  assert.equal(callback.searchParams.get('state'), 'state-123');
  const tokenResponse = await local('/oauth/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({
    grant_type: 'authorization_code', code: callback.searchParams.get('code'), redirect_uri: 'http://localhost:7777/callback', client_id: registered.client_id, code_verifier: verifier}).toString()});
  assert.equal(tokenResponse.status, 200);
  const tokens = await tokenResponse.json();
  const mcp = async (name, args = {}) => {
    const response = await local('/mcp', {method: 'POST', headers: {...mcpHeaders, authorization: 'Bearer ' + tokens.access_token}, body: rpc(9, 'tools/call', {name, arguments: args})});
    assert.equal(response.status, 200, name);
    const {result} = await response.json();
    return {error: result.isError === true, text: result.content[0].text, data: result.isError ? null : JSON.parse(result.content[0].text)};
  };
  const initialized = await (await local('/mcp', {method: 'POST', headers: {...mcpHeaders, authorization: 'Bearer ' + tokens.access_token},
    body: rpc(1, 'initialize', {protocolVersion: '2025-06-18', capabilities: {}, clientInfo: {name: 'test', version: '1'}})})).json();
  assert.equal(initialized.result.serverInfo.name, 'oko1');
  const listed = await (await local('/mcp', {method: 'POST', headers: {...mcpHeaders, authorization: 'Bearer ' + tokens.access_token}, body: rpc(2, 'tools/list')})).json();
  assert.deepEqual(listed.result.tools.map(entry => entry.name).sort(), ['akce_zebricek', 'den', 'historie_ceny', 'k_vyrizeni', 'kontrola_cen', 'kontrola_lahvi', 'listek', 'menu_engineering', 'naklady_dodavatele', 'odhad_a_vyhled', 'preceneni', 'ranni_prehled', 'report_dne_texty', 'report_manazeru', 'souhrn_obdobi', 'trzby_dne', 'trzby_obdobi', 'tyden_mesic_trendy', 'ucty', 'vydelek_polozek',
    'web_blokace_a_akce', 'web_darkove_karty', 'web_host', 'web_navstevnost', 'web_platby_lahvi', 'web_prehled', 'web_recenze', 'web_rezervace', 'web_rezervace_detail', 'web_tabulka']);
  assert.ok(listed.result.tools.every(entry => entry.annotations.readOnlyHint === true), 'read only');

  const reportTexts = await mcp('report_dne_texty', {od: '2026-10-01', do: '2026-10-31'});
  assert.ok(!reportTexts.error && Array.isArray(reportTexts.data.days) && Array.isArray(reportTexts.data.themes.themes) && Array.isArray(reportTexts.data.djs), 'report texts over a period');
  // Tools: live data of the web (names, contacts, tables) and the POS data of OKO1, together in "den".
  const day = await mcp('web_rezervace', {od: today, do: today});
  assert.equal(day.data.pocet, 3);
  assert.deepEqual(day.data.rezervace.map(row => [row.id, row.jmeno, row.stoly]), [[1, guestName, ['p4', 'p5']], [2, 'Petr Synteticky', ['kA']], [3, 'Petr Synteticky', []]]);
  assert.ok(web.requests.every(entry => entry.auth === 'Bearer ' + webToken && entry.method === 'GET'));
  assert.ok(web.requests.some(entry => entry.path.startsWith('/api/oko1/v1/tabulka/rezervace?po=2&')), 'pages are followed');
  assert.equal((await mcp('web_rezervace', {od: today, do: today, stav: 'nova', prostor: 'klub'})).data.pocet, 1);
  const guest = await mcp('web_host', {kontakt: '777 000 111'});
  assert.equal(guest.data.kontakt, guestPhone);
  assert.deepEqual(guest.data.cernaListina, {pocetNedorazeni: 3, vyrazenoPriPoctu: null, naListine: true});
  assert.equal(guest.data.hoste[0].jmeno, guestName);
  const detail = await mcp('web_rezervace_detail', {kod: 'aaa1'});
  assert.deepEqual([detail.data.rezervace.kod, detail.data.stoly, detail.data.zpravy.length], ['JD-AAA1', ['p4', 'p5'], 1]);
  assert.equal((await mcp('web_rezervace_detail', {kod: 'JD-NONE'})).error, true);
  assert.equal((await mcp('web_prehled')).data.cekajici, 2);
  assert.equal((await mcp('web_recenze', {stav: 'nova'})).data.recenze[0].autor, 'Recenzent <i>X</i>');
  assert.deepEqual((await mcp('web_darkove_karty', {od: today, do: today})).data.objednavky[0].polozky, [{druh: 'voucher', hodnota: 1000, kusy: 2}]);
  assert.equal((await mcp('web_navstevnost')).data.statistiky.dnes, calendar);
  const refused = await mcp('web_tabulka', {nazev: 'rezervace', rovno: ['jmeno:Zuzana']});
  assert.equal(refused.error, true);
  assert.match(refused.text, /^Web teď nejde načíst: HTTP 422 \(Podle sloupce „jmeno“ tabulka rezervace filtrovat nejde\.\)\.$/);
  assert.equal((await mcp('web_tabulka', {nazev: 'rezervace_stoly', rovno: ['rezervace_id:1']})).data.pocet, 2);
  assert.equal((await mcp('trzby_dne', {datum: today})).data.revenueCents, 80000);
  assert.equal((await mcp('trzby_dne', {datum: '12.10.2026'})).error, true);
  assert.equal((await mcp('trzby_obdobi', {od: addDays(today, -6), do: today})).data.totalCents, 80000);
  assert.equal((await mcp('ucty', {datum: today})).data.bills[0].id, 'w1');
  // OKO1 overviews: the forecast and outlook, the week, month and trends, sums of any period and the to-do list.
  const outlookTool = (await mcp('odhad_a_vyhled', {datum: today})).data;
  assert.equal(outlookTool.businessDate, today);
  assert.ok('forecast' in outlookTool && 'today' in outlookTool && Array.isArray(outlookTool.events));
  const trendsTool = (await mcp('tyden_mesic_trendy', {datum: today})).data;
  assert.equal(trendsTool.trends.length, 12);
  assert.equal(trendsTool.week.current.revenueCents, 80000);
  const period = (await mcp('souhrn_obdobi', {od: addDays(today, -6), do: today})).data;
  assert.deepEqual([period.revenueCents, period.revenueDays], [80000, 1]);
  assert.equal((await mcp('souhrn_obdobi', {od: today, do: addDays(today, -1)})).error, true);
  const todoTool = (await mcp('k_vyrizeni', {datum: today})).data;
  assert.ok(Array.isArray(todoTool.todo) && Array.isArray(todoTool.sources.types));
  assert.equal((await mcp('odhad_a_vyhled', {datum: 'zitra'})).error, true);
  const ranked = (await mcp('akce_zebricek', {datum: today})).data;
  assert.deepEqual([ranked.to, ranked.from, Array.isArray(ranked.events)], [today, addDays(today, -181), true]);
  assert.equal((await mcp('akce_zebricek', {datum: '13.10.2026'})).error, true);
  const menuTool = (await mcp('listek')).data;
  assert.deepEqual(menuTool.menu.items.map(item => [item.id, item.pricesCents]), [['food:burgery:classic', [22500, 26500]], ['food:burgery:texas', [25900]],
    ['drinks:kava:espresso', [6200]], ['food:dezerty:pie', [14500]]]);
  assert.deepEqual(menuTool.changes.map(change => [change.itemId, change.kind, change.oldCents, change.newCents, change.oldText, change.newText]).sort(), [
    ['drinks:vodka:x', 'removed', 9000, null, '90 Kč', null], ['food:burgery:classic', 'price', 22500, 22500, '225 / 255 Kč', '225 / 265 Kč'],
    ['food:burgery:texas', 'price', 24500, 25900, '245 Kč', '259 Kč'], ['food:dezerty:pie', 'added', null, 14500, null, '145 Kč']]);
  // Pricing of the menu: virtual repricing, the price check and profit by item from POS bills paired to the menu.
  assert.equal((await mcp('vydelek_polozek', {od: addDays(today, -6), do: today})).data.items.length, 0, 'no bills yet: nothing sold');
  const soldDay = addDays(today, -3);
  const posBill = {...bill('jd-pos-1', 1, 106400, soldDay), items: [{name: 'Classic Burger', productId: 'pos-classic', quantity: 4, totalCents: 89600, vatRate: 12},
    {name: 'Tonic 0,25 l', quantity: 2, totalCents: 16800, vatRate: 21}]};
  assert.equal((await jdIngest('batch-jd-pos', [{...posBill, items: [{...posBill.items[0], vatRate: 120}]}])).status, 400, 'a VAT rate is a percentage');
  assert.equal((await jdIngest('batch-jd-pos', [posBill])).status, 200);
  const sold = (await mcp('vydelek_polozek', {od: addDays(today, -6), do: today})).data;
  assert.deepEqual(sold.items.map(row => [row.itemId, row.quantity, row.grossCents, row.netCents, row.profitCents]), [['food:burgery:classic', 4, 89600, 80000, null]]);
  assert.deepEqual([sold.unpaired.map(row => row.name), sold.totals.pairedPermille, sold.missing], [['Burger', 'Tonic 0,25 l'], 481, ['food cost za kus (nákupní ceny a receptury)']]);
  assert.equal((await mcp('vydelek_polozek', {od: today, do: addDays(today, -1)})).error, true);
  // A POS line linked to a menu item (`menuItemId`) pairs by it whatever its name; an id no longer on the menu falls back to the name.
  const linkedDay = addDays(today, 800);
  assert.equal((await jdIngest('batch-linked-0', [{...bill('jd-linked', 1, 25900, linkedDay), items: [{name: 'X', quantity: 1, totalCents: 25900, menuItemId: 'bad id'}]}])).status, 400);
  assert.equal((await jdIngest('batch-linked-1', [{...bill('jd-linked', 1, 48400, linkedDay), items: [{name: 'Texaský s hranolky', quantity: 1, totalCents: 25900, vatRate: 12, menuItemId: 'food:burgery:texas'},
    {name: 'Classic Burger', quantity: 1, totalCents: 22500, vatRate: 12, menuItemId: 'food:burgery:gone'}], payments: [{method: 'card', amountCents: 48400}]}])).status, 200);
  const linked = (await mcp('vydelek_polozek', {od: linkedDay, do: linkedDay})).data;
  assert.deepEqual([linked.items.map(row => [row.itemId, row.quantity, row.posNames]), linked.unpaired.length], [[['food:burgery:texas', 1, ['Texaský s hranolky']], ['food:burgery:classic', 1, ['Classic Burger']]], 0]);
  // A discount on the whole bill falls on its lines in proportion to what was paid.
  assert.equal((await jdIngest('batch-jd-pos-2', [{...bill('jd-pos-2', 1, 20160, soldDay), discountCents: 2240, items: [{name: 'Classic Burger', productId: 'pos-classic', quantity: 1, totalCents: 22400, vatRate: 12}]}])).status, 200);
  assert.deepEqual((await mcp('vydelek_polozek', {od: addDays(today, -6), do: today})).data.items.map(row => [row.quantity, row.grossCents, row.netCents]), [[5, 109760, 98000]]);
  const repriced = (await mcp('preceneni', {kategorie: 'Burgery', procenta: 10})).data;
  assert.deepEqual(repriced.items.map(item => [item.itemId, item.newText]), [['food:burgery:classic', '250 / 290 Kč'], ['food:burgery:texas', '285 Kč']]);
  if (soldDay >= repriced.salesFrom) assert.deepEqual(repriced.sales, {items: 1, grossCents: 109760, newGrossCents: 121956, differenceCents: 12196, profitDifferenceCents: 10889,
    breakEvenDropPermille: 100, ifFewer: [{percent: 5, newGrossCents: 115858}, {percent: 10, newGrossCents: 109760}]});
  assert.equal((await mcp('preceneni', {kategorie: 'Burgery'})).error, true, 'a change is needed');
  assert.equal((await mcp('preceneni', {hledat: 'pizza', procenta: 5})).error, true, 'nothing matches');
  const checked = (await mcp('kontrola_cen')).data;
  assert.deepEqual([checked.items, checked.findings], [4, []], 'no category has 4 items');
  // What to fix on the website: the dishes without a description (the burger with one and the espresso, a hot drink, are fine).
  assert.deepEqual(checked.webGaps.map(gap => [gap.kind, gap.name, gap.text]), [['description', 'Texas Burger', 'chybí popis'], ['description', 'Apple Pie', 'chybí popis']]);
  // Menu engineering: the burger that sold is a star, the rest of the food weak; the price changes of today wait for sales.
  const engineering = (await mcp('menu_engineering', {od: addDays(today, -6), do: today})).data;
  assert.deepEqual(engineering.matrix.map(part => [part.part, part.basis, part.classes.map(row => [row.kind, row.items.map(item => item.itemId)])]),
    [['food', 'price', [['star', ['food:burgery:classic']], ['plowhorse', []], ['puzzle', []], ['dog', ['food:burgery:texas']]]]]);
  assert.deepEqual(engineering.matrix[0].newItems, ['Apple Pie'], 'added to the menu within the days: not judged');
  assert.deepEqual(engineering.experiments.map(row => [row.itemId, row.status, row.before.quantity, row.quantityPermille]).sort(),
    [['food:burgery:classic', 'no_history', 5, null], ['food:burgery:texas', 'no_history', 0, null]], 'bills only 3 days before the change');
  // Costs and suppliers: purchases without VAT, the rise against the purchase before, the overdue invoice; a cancelled one does not count.
  const supplies = (await mcp('naklady_dodavatele', {od: addDays(today, -6), do: today})).data;
  assert.deepEqual([supplies.summary.invoices, supplies.summary.netCents, supplies.summary.byKind], [1, 51590, [{kind: 'food', name: 'jídlo', netCents: 51590}]]);
  assert.deepEqual(supplies.rises.map(rise => [rise.name, rise.oldCents, rise.newCents, rise.permille, rise.extraCents]), [['Borůvky 125 g', 4070, 5159, 268, 10890]]);
  assert.deepEqual(supplies.overdue.map(row => [row.number, row.days]), [['2026-118', 1]]);
  assert.deepEqual([supplies.duplicates, supplies.drinkMargins.margins, supplies.drinkMargins.unpaired], [[], [], 0], 'no drink on the menu has a poured volume');
  // The switch: a sender in disabledSources is left out everywhere, its data stays stored.
  assert.equal((await call('PUT', '/admin/t/james-dean/config', {...jdConfig, disabledSources: ['dishboard']})).status, 200);
  const off = (await mcp('naklady_dodavatele', {od: addDays(today, -6), do: today})).data;
  assert.deepEqual([off.summary.invoices, off.rises.length, off.overdue.length, off.disabledSources], [0, 0, 0, ['dishboard']]);
  // Payments and the cost budget: nothing due this week, no history for new suppliers yet, the default food cost limit unless set.
  assert.deepEqual([supplies.dueSoon, supplies.unusual, supplies.foodCostLimitPermille], [[], [], 300]);
  assert.ok(supplies.monthCompare.every(row => row.changeCents === row.netCents - row.previousCents));
  assert.equal((await call('PUT', '/admin/t/james-dean/config', {...jdConfig, foodCostLimitPermille: 10})).status, 400, 'a limit of 1 % is a mistake');
  assert.equal((await call('PUT', '/admin/t/james-dean/config', {...jdConfig, foodCostLimitPermille: 280})).status, 200);
  assert.equal((await mcp('naklady_dodavatele', {od: addDays(today, -6), do: today})).data.foodCostLimitPermille, 280);
  assert.equal((await call('PUT', '/admin/t/james-dean/config', jdConfig)).status, 200);
  const both = await mcp('den', {datum: today});
  assert.equal(both.data.pokladna.revenueCents, 80000);
  assert.equal(both.data.web.pocetRezervaci, 3);
  assert.equal(both.data.web.navstevnost.den, today);

  // The dashboard card reads the web live; the page escapes every value.
  const jdBoard = (method, path, body, headers = {}) => mf.dispatchFetch('http://local.test/d/james-dean' + path, {method, headers: {'content-type': 'application/json', ...headers}, body: body === undefined ? undefined : JSON.stringify(body)});
  assert.equal((await jdBoard('GET', '/web')).status, 401);
  // The owner has just asked for a code to connect Claude, so the next one goes 60 s later (the Durable Object's clock parameter).
  const jdTenants = await mf.getDurableObjectNamespace('TENANTS');
  const jdSent = JSON.parse(JSON.stringify(await jdTenants.get(jdTenants.idFromName('james-dean')).sendLoginCode('+420600000009', '', Date.now() + 61000)));
  assert.equal(jdSent.status, 200);
  const boardCode = texts.at(-1).match(/(\d{6})/)[1];
  const jdCookie = {cookie: (await jdBoard('POST', '/verify', {code: boardCode})).headers.get('set-cookie').split(';')[0]};
  // Each visit renews the session to 30 days from now (and the cookie with it), at most a year from the code.
  const renewedCookie = (await jdBoard('GET', '/data', undefined, jdCookie)).headers.get('set-cookie');
  assert.match(renewedCookie, /^oko1_session=[a-f0-9]+; Path=\/d\/james-dean; HttpOnly; Secure; SameSite=Strict; Max-Age=2592000$/);
  const jdObject = jdTenants.get(jdTenants.idFromName('james-dean'));
  const jdToken = jdCookie.cookie.split('=')[1], loginAt = Date.now(), oneDay = 86400000;
  assert.equal(await jdObject.validSession(jdToken, loginAt + 29 * oneDay), true);
  assert.equal(await jdObject.validSession(jdToken, loginAt + 58 * oneDay), true, 'used within 30 days, so still logged in');
  for (let d = 87; d <= 348; d += 29) assert.equal(await jdObject.validSession(jdToken, loginAt + d * oneDay), true);
  assert.equal(await jdObject.validSession(jdToken, loginAt + 364 * oneDay), true);
  assert.equal(await jdObject.validSession(jdToken, loginAt + 366 * oneDay), false, 'never longer than a year from the code');
  const card = (await (await jdBoard('GET', '/web', undefined, jdCookie)).json()).card;
  assert.equal(card.name, 'Web James Dean');
  assert.deepEqual(card.reservations.map(row => [row.cas, row.jmeno, row.stoly, row.stav]), [['19:00', guestName, ['p4', 'p5'], 'potvrzena'], ['22:00', 'Petr Synteticky', ['kA'], 'nova']]);
  assert.deepEqual([card.otherReservations, card.pending, card.reviewsWaiting, card.visits.today.navstevy, card.visits.yesterday.navstevy], [1, 2, 1, 42, 30]);
  const pageHtml = await (await jdBoard('GET', '')).text();
  const pageScript = pageHtml.match(/<script nonce="[a-f0-9]+">([\s\S]*?)<\/script>/)[1];
  const renderCard = async (answers, box = 'web') => {
    const elements = {};
    const element = id => elements[id] ??= {hidden: false, value: '', textContent: '', innerHTML: '', disabled: false, focus() {}};
    const fetch = async url => { const body = answers[url.split('?')[0]]; return {ok: true, status: 200, json: async () => body}; };
    vm.runInNewContext(pageScript, {document: {getElementById: element}, location: {reload() {}}, fetch, console});
    await new Promise(resolve => setTimeout(resolve, 100));
    return elements[box].innerHTML;
  };
  // An event a month ago: the ranking card shows it with its title escaped.
  assert.equal((await jdIngest('batch-jd-event', [{type: 'event', id: 'jd-akce', version: 1, businessDate: addDays(today, -30), startsAt: `${addDays(today, -30)}T19:00:00Z`,
    section: 'club', title: '<img src=x onerror=alert(1)>Jam', status: 'published'}])).status, 200);
  // Interest in the menu on the website: a day without `menu` is left out, unknown fields are refused, the card shows the weeks with data.
  const menuDay = (businessDate, menu) => ({type: 'web_traffic', id: `web-${businessDate}`, version: 1, businessDate, visits: 50, visitsWithAction: 0, origins: [], actions: {}, reviewScans: 0, ...(menu ? {menu} : {})});
  const interest = {views: {food: 30, drinks: 12}, visits: 20, abroad: 15, reserved: 2, languages: [{key: 'en', visits: 14, reserved: 1}, {key: 'cs', visits: 6, reserved: 1}]};
  assert.equal((await jdIngest('batch-jd-menu-0', [menuDay(addDays(today, -1), {...interest, ids: []})])).status, 400, 'nothing about single visits');
  assert.equal((await jdIngest('batch-jd-menu-0', [menuDay(addDays(today, -1), {...interest, languages: [{key: 'en', visits: 1}]})])).status, 400, 'a language needs reservations');
  assert.equal((await jdIngest('batch-jd-menu-1', [menuDay(addDays(today, -1), interest), menuDay(addDays(today, -2)), menuDay(addDays(today, -8), {...interest, visits: 10, abroad: 2, languages: [{key: 'cs', visits: 10, reserved: 2}]})])).status, 200);
  // Prices nearby (public menus, stored by the deploy): a wrong set is refused, the card compares with our current menu.
  const nearby = {checkedOn: addDays(today, -3), scope: 'Dlouhá <x>', basket: [{item: 'burger', label: 'Burger', section: 'food', ours: {name: 'Classic <b>Burger</b>', category: 'Burgery', priceIndex: 1}}],
    venues: [...['a', 'b', 'c'].map((key, i) => ({key, name: `Podnik <${key}>`, url: `https://${key}.example/menu`, items: [{item: 'burger', name: 'Burger', priceCzk: 200 + 10 * i}]})),
      {key: 'd', name: 'Podnik d', kind: 'bar', url: 'https://d.example', note: 'lístek <i>není</i> online', items: []}]};
  assert.equal((await call('PUT', '/admin/t/james-dean/competitors', {...nearby, checkedOn: 'x'})).status, 400);
  assert.equal((await call('PUT', '/admin/t/james-dean/competitors', nearby, null)).status, 401, 'admin only');
  assert.deepEqual((await (await call('PUT', '/admin/t/james-dean/competitors', nearby)).json()), {checkedOn: nearby.checkedOn, venues: 4, prices: 3});
  assert.equal((await (await call('GET', '/admin/t/james-dean/competitors')).json()).venues.length, 4);
  const big = {...nearby, venues: [...nearby.venues, ...['e', 'f', 'g', 'h', 'i'].map(key => ({key, name: key, url: `https://${key}.example`, items: Array.from({length: 300}, () => ({item: 'burger', name: 'x'.repeat(200), priceCzk: 250}))}))]};
  assert.ok(JSON.stringify(big).length > 262144);
  assert.equal((await call('PUT', '/admin/t/james-dean/competitors', big)).status, 200, 'every venue nearby: a bigger body than other admin calls');
  assert.equal((await call('PUT', '/admin/t/james-dean/competitors', nearby)).status, 200);
  const boardData = await (await jdBoard('GET', '/data', undefined, jdCookie)).json();
  assert.deepEqual([boardData.menuInterest.length, boardData.menuInterest[11].to, boardData.menuInterest[11].days, boardData.menuInterest[11].visits, boardData.menuInterest[11].food, boardData.menuInterest[11].languages,
    boardData.menuInterest[10].days, boardData.menuInterest[10].visits, boardData.menuInterest[9].days],
  [12, boardData.businessDate, 1, 20, 30, interest.languages, 1, 10, 0]);
  const shown = await renderCard({'/d/james-dean/data': boardData, '/d/james-dean/web': {card}});
  // The menu card: items per part and category, and the changes, escaped.
  assert.deepEqual([boardData.menu.items, boardData.menu.parts.map(part => [part.part, part.items]), boardData.menu.changes.length, boardData.menu.changesTotal], [4, [['food', 3], ['drinks', 1]], 4, 4]);
  assert.deepEqual(boardData.menu.parts[0].categories[0], {name: 'Burgery', items: 2, minCents: 22500, maxCents: 25900, avgCents: 24200});
  const content = await renderCard({'/d/james-dean/data': boardData, '/d/james-dean/web': {card}}, 'content');
  const nearbyRow = boardData.menu.competitors.rows[0];
  assert.deepEqual([nearbyRow.ourName, nearbyRow.medianCents, nearbyRow.diffPct], ['Classic <b>Burger</b>', 21000, Math.round((nearbyRow.ourCents / 21000 - 1) * 100)]);
  assert.ok(nearbyRow.ourCents > 0, 'our price from the current menu');
  assert.deepEqual(boardData.menu.competitors.sections, [{section: 'food', name: 'Jídlo', compared: 1, medianDiffPct: nearbyRow.diffPct, above: nearbyRow.diffPct >= 15 ? 1 : 0, below: nearbyRow.diffPct <= -15 ? 1 : 0}]);
  assert.match(content, /Ceny proti okolí <span class="muted">\(4 podniky – Dlouhá &lt;x&gt;, s cenami online 3,[\s\S]*<b>Jídlo<\/b> celkově[\s\S]*Podnik &lt;a&gt;[\s\S]*Podnik d<\/a> \(bar\) – lístek &lt;i&gt;není&lt;\/i&gt; online/, 'names escaped, a venue without prices online');
  // The Monday message in the week after the prices were read, not later.
  const nearbySunday = [0, 1, 2, 3, 4, 5, 6].map(day => addDays(nearby.checkedOn, day)).find(day => new Date(day + 'T12:00:00Z').getUTCDay() === 0);
  const nearbyBriefing = async day => (await (await call('GET', `/admin/t/james-dean/briefing?date=${day}`)).json()).briefing.competitors;
  assert.deepEqual([(await nearbyBriefing(nearbySunday)).venues, (await nearbyBriefing(nearbySunday)).compared], [3, 1]);
  assert.equal(await nearbyBriefing(addDays(nearbySunday, 7)), null);
  assert.match(content, /Zájem o lístek na webu \(12 týdnů\)[\s\S]*<td class="n">20<\/td><td class="n">30 \/ 12<\/td><td class="n">75 %<\/td><td class="n">30 %<\/td><td class="n">70 %<\/td><td class="n">0 %<\/td><td class="n">2 <span class="muted">\(10,0 %\)<\/span>/);
  // The menu card also checks prices and, with POS bills, shows what sold by item and what is not paired to the menu.
  assert.deepEqual([boardData.menu.priceCheck, boardData.menu.profit.items.map(row => [row.name, row.quantity]), boardData.menu.profit.unpaired.map(row => row.name)],
    [{findings: [], total: 0}, [['Classic <b>Burger</b>', 5]], ['Tonic 0,25 l']], 'the shown day is yesterday: today\'s bill is not in');
  assert.match(content, /Prodej po položkách za 30 dní/);
  assert.deepEqual([boardData.menu.gaps.total, boardData.menu.gaps.items.map(gap => gap.name)], [2, ['Texas Burger', 'Apple Pie']]);
  assert.match(content, /Co opravit na webu<\/h3><ul><li><b>Texas Burger<\/b> \(Burgery\): chybí popis<\/li>/);
  assert.deepEqual(boardData.menu.matrix.map(part => part.classes.map(row => row.count)), [[1, 0, 0, 2]]);
  assert.match(content, /Obliba × výdělek za 30 dní/);
  assert.match(content, /Classic &lt;b&gt;Burger&lt;\/b&gt;/);
  // The costs card: the rise over 30 days and the invoice past its due date, supplier names escaped.
  assert.deepEqual(boardData.supplies.rises.map(rise => [rise.name, rise.permille]), [['Borůvky 125 g', 268]]);
  assert.equal(boardData.supplies.overdueCount, 1);
  assert.ok(content.includes('Jídelní a nápojový lístek') && content.includes('4 položky · jídlo 3, nápoje 1') && content.includes('245 Kč → 259 Kč') && content.includes('225 Kč – 259 Kč'));
  assert.ok(content.includes('Classic &lt;b&gt;Burger&lt;/b&gt;') && !content.includes('<b>Burger</b>'), 'item names are escaped');
  assert.ok(content.includes('Náklady a dodavatelé') && content.includes('40,70 Kč → 51,59 Kč (+27 %)') && content.includes('Velkoobchod &lt;Test&gt;') && !content.includes('<Test>'), 'costs card');
  assert.deepEqual(boardData.eventRanking.map(rank => [rank.title, rank.count]), [['<img src=x onerror=alert(1)>Jam', 1]]);
  assert.ok(content.includes('Akce za půl roku') && content.includes('&lt;img src=x onerror=alert(1)&gt;Jam') && !content.includes('<img'), 'event titles are escaped');
  assert.ok(shown.includes('Zuzana &lt;b&gt;Testovaci&lt;/b&gt; Hostova') && !shown.includes('<b>Testovaci</b>'), 'guest names are escaped');
  assert.ok(shown.includes('&lt;img src=x onerror=alert(1)&gt;') && !shown.includes('<img'), 'notes are escaped');
  assert.ok(shown.includes('Recenzent &lt;i&gt;X&lt;/i&gt;') && shown.includes('stůl') && shown.includes('4, 5') && shown.includes('klub A'));

  // A web outage is a warning: POS tools keep working, the card says the web cannot be read now.
  web.down = true;
  const down = await mcp('web_rezervace', {od: today, do: today});
  assert.equal(down.error, true);
  assert.equal(down.text, 'Web teď nejde načíst: HTTP 503.');
  const downDay = await mcp('den', {datum: today});
  assert.equal(downDay.data.pokladna.revenueCents, 80000);
  assert.equal(downDay.data.web.varovani, 'Web teď nejde načíst: HTTP 503.');
  assert.deepEqual(await (await call('GET', '/admin/t/james-dean/web')).json(), {url: 'https://jamesdean.cz', secret: 'WEB_TOKEN_JAMES_DEAN', token: true, ok: false, tables: 0, error: 'HTTP 503'});
  const downCard = (await (await jdBoard('GET', '/web', undefined, jdCookie)).json()).card;
  assert.equal(downCard.error, 'Web teď nejde načíst (HTTP 503).');
  assert.match(await renderCard({'/d/james-dean/data': boardData, '/d/james-dean/web': {card: downCard}}), /Web teď nejde načíst \(HTTP 503\)\./);
  web.down = false;
  // Without web.url the web tools say so clearly; the dashboard shows no card.
  assert.equal((await call('PUT', '/admin/t/james-dean/config', {...jdConfig, web: null})).status, 200);
  const unplugged = await mcp('web_prehled');
  assert.equal(unplugged.error, true);
  assert.match(unplugged.text, /^Web není připojený: provozovna nemá v nastavení adresu webu/);
  assert.equal((await (await jdBoard('GET', '/web', undefined, jdCookie)).json()).card, null);
  assert.equal((await mcp('trzby_dne', {datum: today})).data.revenueCents, 80000);
  assert.equal((await call('PUT', '/admin/t/james-dean/config', jdConfig)).status, 200);

  // The morning briefing and the export to R2 never carry anything from the web.
  const next = addDays(today, 1);
  const nine = [5, 6, 7, 8].map(hour => new Date(`${next}T0${hour}:00:00Z`)).find(at => prague(at).hour === 9);
  const morning = await (await call('POST', '/admin/t/james-dean/tick', {at: nine.toISOString()})).json();
  assert.equal(morning.decision, 'send-incomplete');
  assert.ok(!morning.text.includes('Testovaci') && !morning.text.includes('777000111'));
  const archive = await mf.getR2Bucket('ARCHIVE');
  let exported = null;
  for (let i = 0; i < 50 && !exported; i++) { exported = await archive.get(`t/james-dean/export/${today}.json`); if (!exported) await new Promise(resolve => setTimeout(resolve, 50)); }
  const exportText = await exported.text();
  assert.ok(exportText.includes('"w1"') && !exportText.includes('Testovaci') && !exportText.includes('777000111') && !exportText.includes('Synteticky'));

  // The menu's trend starts with the month of the menu; a day with changes has its line in the message (not Sunday's, that has the week).
  const trendBoard = await (await jdBoard('GET', '/data', undefined, jdCookie)).json();
  assert.deepEqual([trendBoard.menu.trend.months.length, trendBoard.menu.trend.categories.find(row => row.name === 'Burgery').values], [1, [24200]]);
  const menuDayBrief = await (await call('GET', `/admin/t/james-dean/briefing?date=${today}`)).json();
  if (new Date(today + 'T12:00:00Z').getUTCDay() !== 0) assert.match(menuDayBrief.text, /\nLístek se změnil: nová cena 2× .+ · nově Apple Pie · zrušeno Vodka X(\n|$)/);
  // A menu without most of its items is held (a broken website?): the old one stays and the to-do list says so; a refused menu too.
  assert.deepEqual(await (await jdIngest('batch-menu-held', [menu(5, [secondMenu.items[0]])])).json(), {batchId: 'batch-menu-held', accepted: 1, stale: 0});
  assert.equal((await mcp('listek')).data.menu.items.length, 4, 'the old menu stays');
  assert.equal((await jdIngest('batch-menu-bad', [menu(6, [{...secondMenu.items[0], part: 'club'}])])).status, 400);
  const heldBoard = await (await jdBoard('GET', '/data', undefined, jdCookie)).json();
  // Five menus refused: the four broken ones the contract tests sent earlier and this one.
  assert.deepEqual(heldBoard.menu.problems.map(text => text.replace(/\(\w+\)/, '(…)')), ['Web poslal lístek bez 3 z 4 položek; OKO1 drží předchozí lístek a nový převezme ráno po 24 hodinách, jestli ho web mezitím neopraví.',
    'Lístek z webu OKO1 5× odmítlo (…); platí poslední přijatý lístek.']);
  assert.ok(heldBoard.todo.some(item => item.text.startsWith('Web poslal lístek bez 3 z 4 položek')));
  // The same menu again is stale; a newer one still without the items replaces the held one, its 24 hours run from the first.
  assert.deepEqual(await (await jdIngest('batch-menu-held-again', [menu(5, [secondMenu.items[0]])])).json(), {batchId: 'batch-menu-held-again', accepted: 0, stale: 1});
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(await (await jdIngest('batch-menu-held-7', [menu(7, [secondMenu.items[1]])])).json(), {batchId: 'batch-menu-held-7', accepted: 1, stale: 0});
  // Nobody fixed it within 24 hours: the morning run takes the newest over, with its changes, from the business day of the release.
  await call('POST', '/admin/t/james-dean/tick', {at: new Date(Date.now() + 24 * 3600000 - 10).toISOString()});
  const released = (await mcp('listek')).data;
  assert.deepEqual(released.menu.items.map(item => item.id), [secondMenu.items[1].id]);
  const releaseLines = [];
  for (const day of [today, addDays(today, 1), addDays(today, 2)]) {
    const text = (await (await call('GET', `/admin/t/james-dean/briefing?date=${day}`)).json()).text;
    if (/\nLístek (se změnil|za týden): [^\n]*zrušeno Apple Pie, Espresso, Classic/.test(text)) releaseLines.push(day);
  }
  assert.equal(releaseLines.length, 1);
  assert.ok(releaseLines[0] > today, 'the removed items count from the day of the release');
  // A website that fixes the menu within 24 hours: the full one replaces the held one and nothing is reported.
  assert.equal((await (await jdIngest('batch-menu-8', [menu(8, secondMenu.items)])).json()).accepted, 1);
  assert.equal((await (await jdIngest('batch-menu-9', [menu(9, [secondMenu.items[0]])])).json()).accepted, 1);
  assert.equal((await mcp('listek')).data.menu.items.length, 4);
  assert.equal((await (await jdIngest('batch-menu-10', [menu(10, secondMenu.items)])).json()).accepted, 1);
  const fixedBoard = await (await jdBoard('GET', '/data', undefined, jdCookie)).json();
  assert.ok(!fixedBoard.menu.problems.some(text => text.startsWith('Web poslal')));

  // Claude reads the price history of an item; the message about the month's last day sums up the menu's month.
  const texasHistory = (await mcp('historie_ceny', {hledat: 'texas'})).data;
  assert.deepEqual([texasHistory.items.map(item => item.name), texasHistory.changes.map(change => [change.kind, change.oldText, change.newText])],
    [['Texas Burger'], [['price', '245 Kč', '259 Kč']]]);
  assert.equal((await mcp('historie_ceny', {hledat: 'pizza'})).error, true);
  // The dashboard shows one item over 26 weeks: the price of each week (today's change in the last one) and pieces sold.
  assert.equal((await jdBoard('GET', '/item?q=texas')).status, 401);
  const itemTrend = await (await jdBoard('GET', '/item?q=texas', undefined, jdCookie)).json();
  assert.deepEqual([itemTrend.item.name, itemTrend.weeks.length, itemTrend.weeks[0].priceCents, itemTrend.weeks.at(-1).priceCents, itemTrend.hasSales], ['Texas Burger', 26, 24500, 25900, false]);
  assert.deepEqual((await (await jdBoard('GET', '/item?q=pizza', undefined, jdCookie)).json()).item, null);
  const burgers = await (await jdBoard('GET', '/item?q=burger&id=' + encodeURIComponent(itemTrend.item.itemId), undefined, jdCookie)).json();
  assert.ok(burgers.matches.length > 1 && burgers.item.itemId === itemTrend.item.itemId, 'a match picked by its id');
  assert.ok((await mcp('historie_ceny', {hledat: 'vodka x'})).data.changes.some(change => change.kind === 'removed'), 'a removed item is found by its name');
  const [menuYear, menuMonthNumber] = today.split('-').map(Number);
  const menuMonthEnd = addDays(menuMonthNumber === 12 ? `${menuYear + 1}-01-01` : `${menuYear}-${String(menuMonthNumber + 1).padStart(2, '0')}-01`, -1);
  assert.match((await (await call('GET', `/admin/t/james-dean/briefing?date=${menuMonthEnd}`)).json()).text, /\nLístek v [^\n]+: zdraženo 2, přidáno \d+, zrušeno \d+(\n|$)/);
  assert.doesNotMatch((await (await call('GET', `/admin/t/james-dean/briefing?date=${menuMonthEnd}`)).json()).text, /Skoro neprodané/, 'not with bills on fewer than 14 days');

  // Logging everybody out ends the MCP connection too: the access token and its refresh stop working.
  assert.deepEqual(await (await call('POST', '/admin/t/james-dean/logout', {})).json(), {ended: 2});
  assert.equal((await local('/mcp', {method: 'POST', headers: {...mcpHeaders, authorization: 'Bearer ' + tokens.access_token}, body: rpc(3, 'tools/list')})).status, 401);
  assert.equal((await local('/oauth/token', {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: registered.client_id}).toString()})).status, 400);

  // Nothing read from the web is stored anywhere: not in the venue's SQLite, the KV of OAuth or R2.
  await mf.dispose();
  const leaked = [], seen = new Set();
  for (const file of await readdir(webDir, {recursive: true, withFileTypes: true})) {
    if (!file.isFile()) continue;
    const bytes = await readFile(join(file.parentPath, file.name));
    if (['Testovaci', '777000111', 'Synteticky', 'petr@example.com', 'Recenzent', 'Kupujici'].some(text => bytes.includes(text))) leaked.push(file.name);
    // What OKO1 does keep is found by the same search: the config (owner's phone), the OAuth client and the export.
    for (const text of ['+420600000009', 'Claude <test>', `t/james-dean/export/${today}.json`]) if (bytes.includes(text)) seen.add(text);
  }
  assert.ok(web.requests.length > 20);
  assert.equal(seen.size, 3, 'the search sees the stored data of the Durable Object, the KV and R2');
  assert.deepEqual(leaked, [], 'no file of the Durable Objects, KV or R2 contains data from the web');
  mf = new Miniflare(options);

  // Costs from iÚčto: read once a day with the venue's key (only GETs), only sums per account are kept, a failed read
  // keeps the last sums and says so.
  await mf.dispose();
  const iucto = [];
  let iuctoDown = false;
  mf = new Miniflare({...options,
    bindings: {...options.bindings, IUCTO_KEY_IUCTO_VENUE: 'test-only-iucto-key'},
    outboundService: async request => {
      const url = new URL(request.url);
      iucto.push({method: request.method, path: url.pathname, query: Object.fromEntries(url.searchParams), key: request.headers.get('x-auth-key')});
      if (iuctoDown) return new Response('{}', {status: 402});
      if (url.pathname === '/api/1.3/chart_account') return Response.json({'11': '518100 - Služby ostatní', '12': '321000 - Dodavatelé', '13': '504000 - Prodané zboží', '14': '521000 - Mzdy'});
      if (url.pathname !== '/api/1.3/journal') return new Response('unexpected', {status: 599});
      const supplier = {name: 'Syntetický Dodavatel s.r.o.', email: 'dodavatel@example.com'};
      const october = url.searchParams.get('date_expense_from') === '2026-10-01';
      const pages = october ? [
        [{chartaccount_md: 13, chartaccount_dal: 12, price: '150.00', supplier, text: 'Faktura Syntetický Dodavatel'}, {chartaccount_md: 11, chartaccount_dal: 12, price: 100, supplier}],
        [{chartaccount_md: 12, chartaccount_dal: 11, price: 20, supplier}],
      ] : [[{chartaccount_md: 14, chartaccount_dal: 12, price: 800}]];
      const page = Number(url.searchParams.get('page'));
      return Response.json({page, pageCount: pages.length, _embedded: {journal: pages[page - 1]}});
    },
  });
  await call('PUT', '/admin/t/iucto-venue/config', config);
  await call('POST', '/admin/t/iucto-venue/pair', {installationId: 'pos-installation-1', token});
  await ingest('batch-iucto-1', [bill('i1', 1, 60000), closing], 'Bearer ' + token, 'iucto-venue');
  const tickIucto = async at => (await call('POST', '/admin/t/iucto-venue/tick', {at})).json();
  const costsSent = await tickIucto('2026-10-09T05:00:00Z');
  assert.equal(costsSent.decision, 'send');
  assert.match(costsSent.text, /\nNáklady říjen do 8\. 10\. \(zaúčtované\): 230 Kč · Prodané zboží 150 Kč · Služby 80 Kč\nŘíjen zatím: tržby 600 Kč − náklady 230 Kč = 370 Kč\nZáří celkem: tržby 0 Kč − náklady 800 Kč = −800 Kč/);
  assert.ok(iucto.every(entry => entry.method === 'GET' && entry.key === 'test-only-iucto-key'));
  assert.deepEqual(iucto.map(entry => entry.path + (entry.query.page ? ` ${entry.query.date_expense_from}–${entry.query.date_expense_to} ${entry.query.page}` : '')), [
    '/api/1.3/chart_account', '/api/1.3/journal 2026-10-01–2026-10-08 1', '/api/1.3/journal 2026-10-01–2026-10-08 2',
    '/api/1.3/chart_account', '/api/1.3/journal 2026-09-01–2026-09-30 1',
  ]);
  // The same day is not read again; the next morning iÚčto is down: the briefing keeps the sums and warns.
  await tickIucto('2026-10-09T06:00:00Z');
  assert.equal(iucto.length, 5);
  iuctoDown = true;
  const costsDown = await tickIucto('2026-10-10T07:00:00Z');
  assert.equal(costsDown.decision, 'send-incomplete');
  assert.match(costsDown.text, /Náklady říjen do 8\. 10\. \(zaúčtované\): 230 Kč[\s\S]*⚠ Náklady z iÚčta se dnes nepodařilo načíst \(iÚčto: HTTP 402 \(vyčerpaný denní limit nebo tarif bez API\)\), čísla jsou z posledního načtení\./);
  const dashboardCosts = (await (await call('GET', '/admin/t/iucto-venue/briefing?date=2026-10-08')).json());
  assert.equal(dashboardCosts.briefing.costs.revenueCents, 60000);
  // Nothing about suppliers, customers or entry texts is stored, and the key is nowhere in the Durable Object.
  await mf.dispose();
  for (const file of await readdir(dir, {recursive: true, withFileTypes: true})) {
    if (!file.isFile()) continue;
    const bytes = await readFile(join(file.parentPath, file.name));
    assert.ok(!['Dodavatel s.r.o', 'dodavatel@example.com', 'Faktura', 'test-only-iucto-key'].some(text => bytes.includes(text)), file.name);
  }
  mf = new Miniflare(options);

  // Revenue forecast: 4 weeks of weekday averages (Saturdays higher), last year's November 1,5× its base weeks.
  assert.equal((await call('PUT', '/admin/t/forecast-venue/config', {...config, name: 'Odhad'})).status, 200);
  const historyRows = [];
  for (let day = new Date('2025-09-15T12:00:00Z'); day <= new Date('2026-10-13T12:00:00Z'); day.setUTCDate(day.getUTCDate() + 1)) {
    const businessDate = day.toISOString().slice(0, 10);
    if (businessDate > '2025-11-30' && businessDate < '2026-09-16') continue;
    historyRows.push({businessDate, revenueCents: businessDate >= '2026-09-16' ? (day.getUTCDay() === 6 ? 300000 : 100000) : businessDate >= '2025-11-01' ? 150000 : 100000});
  }
  assert.deepEqual(await (await call('POST', '/admin/t/forecast-venue/history', {rows: historyRows})).json(), {imported: historyRows.length});
  const forecastDay = (await (await call('GET', '/admin/t/forecast-venue/briefing?date=2026-10-13')).json());
  const f = forecastDay.briefing.forecast;
  assert.deepEqual([f.today, f.tomorrow.cents, f.week.cents, f.month.actualCents, f.month.actualDays, f.month.totalCents, f.nextMonth.cents, f.seasonal],
    ['2026-10-14', 100000, 900000, 1700000, 13, 1700000 + 15 * 100000 + 3 * 300000, Math.round(26 * 150000 + 4 * 450000), {'2026-10': 1, '2026-11': 1.5}],
    'Saturdays 3 000 Kč, the rest 1 000 Kč; November × 1,5');
  // A weekday with no revenue in 4 weeks is closed (0) and does not blank the sums.
  assert.equal((await call('PUT', '/admin/t/closed-venue/config', {...config, name: 'Zavřeno v pondělí'})).status, 200);
  assert.deepEqual(await (await call('POST', '/admin/t/closed-venue/history', {rows: historyRows.filter(row => row.businessDate >= '2026-09-16' && new Date(row.businessDate + 'T12:00:00Z').getUTCDay() !== 1)})).json(), {imported: 24});
  const mondaysClosed = (await (await call('GET', '/admin/t/closed-venue/briefing?date=2026-10-13')).json()).briefing.forecast;
  assert.deepEqual([mondaysClosed.week.cents, mondaysClosed.nextMonth.cents], [800000, 21 * 100000 + 4 * 300000 + 5 * 0], 'no Monday revenue; November without last year');
  assert.match(forecastDay.text, /\nOdhad tržby: zítra \(čt 15\. 10\.\) 1 000 Kč · 7 dní od dneška 9 000 Kč · říjen celkem 41 000 Kč \(zatím 17 000 Kč\) · listopad 57 000 Kč$/);

  // Weather (MET Norway, identified by User-Agent) and bookings in the forecast; the forecast of a message that went out is kept and checked the next day.
  await mf.dispose();
  const weatherCalls = [], twilioCalls = [];
  let weatherDown = false;
  mf = new Miniflare({...options, bindings: {...options.bindings, TWILIO_ACCOUNT_SID: 'AC-test', TWILIO_AUTH_TOKEN: 'test-only-token', TWILIO_FROM: '+420700000000'},
    outboundService: async request => {
      if (request.url.startsWith('https://api.twilio.com/')) { twilioCalls.push(1); return new Response('{}', {status: twilioCalls.length === 1 ? 500 : 201}); }
      weatherCalls.push({url: request.url, agent: request.headers.get('user-agent')});
      if (weatherDown) return new Response('', {status: 503});
      return Response.json({properties: {timeseries: [{time: '2026-10-15T10:00:00Z', data: {instant: {details: {air_temperature: 14.2}},
        next_1_hours: {summary: {symbol_code: 'rain'}, details: {precipitation_amount: 1}}}}]}});
    }});
  const weatherConfig = {...config, registers: [], recipients: ['+420600000001'], location: {lat: 50.08987654, lon: 14.42}};
  assert.equal((await call('PUT', '/admin/t/weather-venue/config', {...weatherConfig, location: {lat: 91, lon: 14}})).status, 400);
  assert.equal((await call('PUT', '/admin/t/weather-venue/config', weatherConfig)).status, 200);
  await call('POST', '/admin/t/weather-venue/history', {rows: Array.from({length: 28}, (_, i) => ({businessDate: addDays('2026-10-13', -i), revenueCents: 1000000}))});
  await call('POST', '/admin/t/weather-venue/pair', {installationId: 'pos-installation-1', token});
  // Thursdays before: 20 confirmed guests each; tomorrow (Thursday 15. 10.) 50 confirmed and 3 waiting: 2,5× the usual, so at most 1,5× the revenue.
  assert.equal((await ingest('batch-w1', [booking('w1', 1, '2026-10-08', 'diner', 20, 'confirmed', 'arrived'), booking('w2', 1, '2026-10-01', 'diner', 20, 'confirmed', 'arrived'),
    booking('w3', 1, '2026-10-15', 'diner', 30, 'confirmed', null), booking('w4', 1, '2026-10-15', 'bar', 20, 'confirmed', null), booking('w5', 1, '2026-10-15', 'bar', 3, 'pending', null),
    booking('w6', 1, '2026-10-17', 'club', 4, 'pending', null), booking('w8', 1, '2026-10-14', 'diner', 2, 'pending', null), // today's own count, not in the 7 days booking('w7', 1, '2026-10-22', 'club', 6, 'pending', null),
    {...closing, id: 'wc-13', businessDate: '2026-10-13'}, {...closing, id: 'wc-14', businessDate: '2026-10-14'}], 'Bearer ' + token, 'weather-venue')).status, 200);
  const tickWeather = async at => (await call('POST', '/admin/t/weather-venue/tick', {at})).json();
  // 7:00: the message fails, so its forecast is not kept.
  const failedMorning = await tickWeather('2026-10-14T05:00:00Z');
  assert.equal(failedMorning.status, 'failed');
  assert.deepEqual(weatherCalls, [{url: 'https://api.met.no/weatherapi/locationforecast/2.0/compact?lat=50.0899&lon=14.42', agent: 'OKO1/1.0 github.com/cry68c9cyg-stack/booklio-ai-os'}]);
  assert.match(failedMorning.text, / · plán tržby 10 000 Kč\n/);
  // 8:00: an earlier Wednesday changed (7. 10.: 20 000 Kč); the message that goes out plans 12 500 Kč and that is kept.
  await call('POST', '/admin/t/weather-venue/history', {rows: [{businessDate: '2026-10-07', revenueCents: 2000000}]});
  const weatherMorning = await tickWeather('2026-10-14T06:00:00Z');
  assert.equal(weatherMorning.status, 'delivered');
  assert.match(weatherMorning.text, / · plán tržby 12 500 Kč\n/);
  assert.match(weatherMorning.text, /\nOdhad tržby: zítra \(čt 15\. 10\.\) 15 000 Kč \(víc rezervací než obvykle\), 14 °C, déšť · 7 dní od dneška 78 000 Kč · /);
  // Waiting bookings for the next 7 days (15.–21. 10.): counted and summed, the first one with its local time; 22. 10. is outside.
  assert.match(weatherMorning.text, /\nNa příštích 7 dní čeká na potvrzení 2 rezervace \(7 hostů\), nejbližší čt 15\. 10\. 20:00\n/);
  assert.equal((await tickWeather('2026-10-14T07:00:00Z')).decision, 'skip');
  assert.equal(weatherCalls.length, 1, 'no second read the same morning');
  // Later changes (7. 10.: 30 000 Kč) move the weekday average to 15 000 Kč, but 14. 10. keeps the plan its message gave, also on the dashboard of 13. 10.
  await call('POST', '/admin/t/weather-venue/history', {rows: [{businessDate: '2026-10-14', revenueCents: 1300000}, {businessDate: '2026-10-07', revenueCents: 3000000}]});
  const nextDay = await (await call('GET', '/admin/t/weather-venue/briefing?date=2026-10-14')).json();
  assert.equal(nextDay.briefing.plan.revenueCents, 1250000);
  assert.equal((await (await call('GET', '/admin/t/weather-venue/briefing?date=2026-10-13')).json()).briefing.outlook.planCents, 1250000);
  assert.equal(nextDay.briefing.forecast.days[0].weatherText, '14 °C, déšť', 'the weather of 15. 10. stays until the next read');
  // The next morning MET Norway is down: the weather already read stays.
  weatherDown = true;
  const nextMorning = await tickWeather('2026-10-15T05:00:00Z');
  assert.equal(weatherCalls.length, 2, 'a new read the next morning');
  assert.equal(nextMorning.decision, 'send');
  assert.match(nextMorning.text, /\nTržba: 0 Kč \(plán 12 500 Kč, −100 %\)\n/);
  assert.equal((await (await call('GET', '/admin/t/weather-venue/briefing?date=2026-10-14')).json()).briefing.forecast.days[0].weatherText, '14 °C, déšť');

  // Events of the venue: today's events with the guests booked there, the factor from past event days in the forecast, bookings by lead time and source.
  assert.equal((await call('PUT', '/admin/t/event-venue/config', {...config, registers: [], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}})).status, 200);
  const eventDays = ['2026-07-02', '2026-08-06', '2026-09-10', '2026-10-08'];
  await call('POST', '/admin/t/event-venue/history', {rows: Array.from({length: 182}, (_, i) => addDays('2026-10-13', -i))
    .map(day => ({businessDate: day, revenueCents: eventDays.includes(day) ? 1500000 : 1000000}))});
  await call('POST', '/admin/t/event-venue/pair', {installationId: 'pos-installation-1', token});
  const venueEvent = (id, businessDate, startsAt, section, title, status = 'published') => ({type: 'event', id, version: 1, businessDate, startsAt, section, title, status});
  const made = (record, createdAt) => ({...record, createdAt});
  assert.equal((await ingest('batch-e1', [
    ...eventDays.map((day, i) => venueEvent(`akce-${i}`, day, `${day}T19:00:00Z`, 'club', `Koncert ${i}`)),
    venueEvent('akce-dnes', '2026-10-14', '2026-10-14T19:00:00Z', 'club', 'Rock Night'), venueEvent('akce-zrusena', '2026-10-14', '2026-10-14T18:00:00Z', 'diner', 'Zrušená', 'cancelled'),
    venueEvent('akce-zitra', '2026-10-15', '2026-10-15T18:00:00Z', 'all', 'Halloween'),
    booking('e1', 1, '2026-10-14', 'club', 6, 'confirmed', null), booking('e2', 1, '2026-10-14', 'diner', 4, 'confirmed', null),
    made(booking('e3', 1, '2026-10-10', 'club', 4, 'confirmed', 'no_show'), '2026-10-10T08:00:00Z'), made(booking('e4', 1, '2026-10-10', 'diner', 2, 'confirmed', null), '2026-10-08T22:30:00Z'),
    {...made(booking('e5', 1, '2026-10-09', 'diner', 3, 'confirmed', null), '2026-09-20T10:00:00Z'), source: 'obsluha'}, booking('e6', 1, '2026-10-09', 'bar', 5, 'confirmed', null),
  ], 'Bearer ' + token, 'event-venue')).status, 200);
  // A booking first sent without the time it was made takes it at the same version, once.
  assert.deepEqual(await (await ingest('batch-e2', [made(booking('e6', 1, '2026-10-09', 'bar', 5, 'confirmed', null), '2026-10-05T12:00:00Z')], 'Bearer ' + token, 'event-venue')).json(), {batchId: 'batch-e2', accepted: 1, stale: 0});
  assert.deepEqual(await (await ingest('batch-e3', [made(booking('e6', 1, '2026-10-09', 'bar', 5, 'confirmed', null), '2026-10-01T12:00:00Z')], 'Bearer ' + token, 'event-venue')).json(), {batchId: 'batch-e3', accepted: 0, stale: 1});
  const eventMorning = (await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-13')).json()).briefing;
  assert.deepEqual(eventMorning.events, [{time: '21:00', label: 'Klub', title: 'Rock Night', guests: 6}], 'the cancelled one left out, only the club\'s guests');
  assert.deepEqual(eventMorning.forecast.eventFactor, {factor: 1.5, days: 4}, 'four past event days made 1,5× their weekday');
  assert.deepEqual([eventMorning.forecast.days[1].events, eventMorning.forecast.days[1].eventBoost, eventMorning.forecast.days[1].cents], [['Halloween'], 1.5, 1687500]);
  const eventText = (await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-13')).json()).text;
  assert.match(eventText, /\nDnes akce: 21:00 Klub – Rock Night \(rezervováno 6 hostů\)\n/);
  assert.match(eventText, /\nOdhad tržby: zítra \(čt 15\. 10\.\) 17 000 Kč \(akce Halloween, bývá o 50 % víc\) · /);
  const eventWeek = (await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-11')).json()).briefing.week.current;
  assert.deepEqual([eventWeek.lead, eventWeek.sources], [{sameDay: 1, upTo2: 1, upTo7: 1, more: 1},
    [{source: 'web', reservations: 3, guests: 11, noShowGuests: 4}, {source: 'obsluha', reservations: 1, guests: 3, noShowGuests: 0}]]);
  // The week's events looked back on: guests booked in the club and the revenue against the same weekday without an event.
  assert.equal((await ingest('batch-e4', [booking('e7', 1, '2026-10-08', 'club', 8, 'confirmed', null), booking('e8', 1, '2026-10-01', 'club', 4, 'confirmed', null),
    booking('e9', 1, '2026-09-24', 'club', 6, 'confirmed', null), booking('e10', 1, '2026-09-24', 'diner', 9, 'confirmed', null)], 'Bearer ' + token, 'event-venue')).status, 200);
  const reviewed = await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-11')).json();
  assert.deepEqual(reviewed.briefing.week.events, [{date: '2026-10-08', title: 'Koncert 3', guests: 8, usualGuests: 5, revenueCents: 1500000, usualRevenueCents: 1000000}],
    'the event day of 10. 9. is not usual; the diner\'s guests do not count for a club event');
  assert.match(reviewed.text, /\nAkce za týden: čt 8\. 10\. Koncert 3 – 8 hostů z rezervací \(obvykle 5, \+60 %\), tržba 15 000 Kč \(obvykle 10 000 Kč\)\n/);

  // The events of half a year ranked in the message of the month's last day, and on the dashboard data.
  const rankedEnd = await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-31')).json();
  assert.deepEqual(rankedEnd.briefing.eventRanking[0], {title: 'Koncert 3', count: 1, weekdays: [4], guests: 8, usualGuests: 5, guestLift: 1.6, revenueLift: 1.5, last: '2026-10-08', byWeekday: [{weekday: 4, count: 1, guestLift: 1.6}]});
  assert.match(rankedEnd.text, /\nAkce za půl roku: nejvíc táhne Koncert 3 \(1×, hosté \+60 %, tržba \+50 %\)/);
  assert.equal((await (await call('GET', '/admin/t/event-venue/briefing?date=2026-10-30')).json()).briefing.eventRanking, null, 'only at the month end or for a weak day');

  // The forecast split by section with the weekday's shares from the managers' reports (two Wednesdays: diner 60 %, club 40 %).
  assert.equal((await call('PUT', '/admin/t/section-venue/config', {...config, registers: [], sections: {diner: 'Diner', bar: 'Bar', club: 'Klub'}})).status, 200);
  await call('POST', '/admin/t/section-venue/history', {rows: Array.from({length: 60}, (_, i) => addDays('2026-10-12', -i)).map(day => ({businessDate: day, revenueCents: 1000000}))});
  for (const [day, diner, club] of [['2026-10-07', 700000, 300000], ['2026-09-30', 500000, 500000]]) {
    assert.equal((await call('PUT', '/admin/t/section-venue/report', {businessDate: day, source: 'admin', files: [], warnings: [], notes: null,
      lines: [{kind: 'revenue_section', key: 'club', label: 'Klub', count: null, amountCents: club}, {kind: 'revenue_section', key: 'diner', label: 'Diner', count: null, amountCents: diner}]})).status, 200);
  }
  const sectionMorning = await (await call('GET', '/admin/t/section-venue/briefing?date=2026-10-12')).json();
  const wednesday = sectionMorning.briefing.forecast.days.find(day => day.date === '2026-10-14');
  assert.deepEqual(wednesday.bySection, [{section: 'diner', label: 'Diner', cents: wednesday.cents * 0.6}, {section: 'club', label: 'Klub', cents: wednesday.cents * 0.4}], 'in the order of the config');
  assert.equal(sectionMorning.briefing.forecast.days.find(day => day.date === '2026-10-15').bySection, undefined, 'no Thursday with sections');
  assert.match(sectionMorning.text, /\nOdhad tržby: zítra \(st 14\. 10\.\) [\d ]+ Kč \(Diner [\d ]+ Kč, Klub [\d ]+ Kč\) · /);

  // Public holidays: last year's 28. 10. was closed, so this year's forecast for it is 0 Kč; the weekday averages leave holidays out.
  assert.equal((await call('PUT', '/admin/t/holiday-venue/config', {...config, registers: []})).status, 200);
  await call('POST', '/admin/t/holiday-venue/history', {rows: Array.from({length: 400}, (_, i) => addDays('2026-10-26', -i))
    .map(day => ({businessDate: day, revenueCents: day === '2025-10-28' ? 0 : day === '2026-09-28' ? 300000 : 1000000}))});
  const holidayMorning = await (await call('GET', '/admin/t/holiday-venue/briefing?date=2026-10-26')).json();
  assert.deepEqual([holidayMorning.briefing.forecast.days[1].holiday, holidayMorning.briefing.forecast.days[1].holidayFactor, holidayMorning.briefing.forecast.days[1].cents], ['Den vzniku státu', 0, 0]);
  assert.match(holidayMorning.text, /\nOdhad tržby: zítra \(st 28\. 10\.\) 0 Kč \(svátek Den vzniku státu, loni zavřeno\) · /);
  assert.ok(holidayMorning.briefing.forecast.days[6].cents > 900000, 'the low 28. 9. (a holiday Monday) does not pull Mondays down');

  // Guests to expect today by part of the day: booked now + what the same weekday usually still got after the same moment (local start time).
  assert.equal((await call('PUT', '/admin/t/outlook-venue/config', {...config, registers: []})).status, 200);
  await call('POST', '/admin/t/outlook-venue/pair', {installationId: 'pos-installation-1', token});
  const at = (record, startsAt, createdAt) => ({...record, startsAt, createdAt});
  assert.equal((await ingest('batch-o1', [
    at(booking('o1', 1, '2026-10-14', 'diner', 4, 'confirmed', null), '2026-10-14T10:00:00Z', '2026-10-01T10:00:00Z'),
    at(booking('o2', 1, '2026-10-14', 'diner', 6, 'confirmed', null), '2026-10-14T18:00:00Z', '2026-10-01T10:00:00Z'),
    at(booking('o3', 1, '2026-10-14', 'diner', 10, 'confirmed', null), '2026-10-14T22:30:00Z', '2026-10-01T10:00:00Z'),
    at(booking('o4', 1, '2026-10-14', 'diner', 3, 'pending', null), '2026-10-14T18:00:00Z', '2026-10-01T10:00:00Z'),
    ...['2026-10-07', '2026-09-30'].flatMap((day, i) => [
      at(booking(`p${i}a`, 1, day, 'diner', 6, 'confirmed', null), `${day}T18:00:00Z`, '2026-09-01T10:00:00Z'),
      at(booking(`p${i}b`, 1, day, 'diner', 4, 'confirmed', null), `${day}T18:30:00Z`, `${day}T12:00:00Z`),
      {...booking(`p${i}c`, 1, day, 'diner', 2, 'confirmed', null), startsAt: `${day}T23:00:00Z`},
    ]),
    // Older days without the time of booking would show no later guests: left out.
    ...['2026-09-23', '2026-09-16'].map((day, i) => booking(`q${i}`, 1, day, 'diner', 10, 'confirmed', null)),
    // Cancelled after the same moment on 7. 10. (version = time of the change): booked then, so that Wednesday lost 4 evening guests.
    at(booking('c1', Date.parse('2026-10-07T12:00:00Z'), '2026-10-07', 'diner', 8, 'cancelled', null), '2026-10-07T18:00:00Z', '2026-09-01T10:00:00Z'),
    // Cancelled before the moment, and one whose version is a plain counter: neither was booked then.
    at(booking('c2', Date.parse('2026-10-06T05:00:00Z'), '2026-10-07', 'diner', 5, 'cancelled', null), '2026-10-07T18:00:00Z', '2026-09-01T10:00:00Z'),
    at(booking('c3', 2, '2026-10-07', 'diner', 7, 'cancelled', null), '2026-10-07T18:00:00Z', '2026-09-01T10:00:00Z'),
    // Cancelled after its start (a no-show the staff cancelled later): not a late cancellation; on an older day, so the outlook stays as is.
    at(booking('c4', Date.parse('2026-10-05T23:00:00Z'), '2026-10-05', 'diner', 6, 'cancelled', null), '2026-10-05T18:00:00Z', '2026-09-01T10:00:00Z'),
    // A weak Thursday: usually 12 guests booked by now, now 2.
    ...['2026-10-08', '2026-10-01'].map((day, i) => at(booking(`t${i}`, 1, day, 'diner', 12, 'confirmed', null), `${day}T18:00:00Z`, '2026-09-01T10:00:00Z')),
    at(booking('t2', 1, '2026-10-15', 'diner', 2, 'confirmed', null), '2026-10-15T18:00:00Z', '2026-10-01T10:00:00Z'),
  ], 'Bearer ' + token, 'outlook-venue')).status, 200);
  // The website on Tuesdays: 100 visits and 4 sent booking forms; on 13. 10. only 20 and none.
  const webDay = (businessDate, visits, sent) => ({type: 'web_traffic', id: `web-${businessDate}`, version: 1, businessDate, visits, visitsWithAction: 0, origins: [],
    actions: {'rezervace-odeslana': sent}, reviewScans: 0});
  assert.equal((await ingest('batch-o2', [...['2026-10-06', '2026-09-29', '2026-09-22', '2026-09-15'].map(day => webDay(day, 100, 4)), webDay('2026-10-13', 20, 0)],
    'Bearer ' + token, 'outlook-venue')).status, 200);
  const outlookMorning = await (await call('POST', '/admin/t/outlook-venue/tick', {at: '2026-10-14T07:00:00Z'})).json();
  assert.match(outlookMorning.text, /\nHosté dnes: čekej asi 20 \(zatím rezervováno 20\) · přes den 4 · večer 6 · noc 10(\n|$)/,
    'a booking without its creation time counts as early, days mostly without it are left out, a late cancellation takes guests away (median of −4 and +4)');
  assert.match(outlookMorning.text, /\n⚠ Slabší výhled: čt 15\. 10\. zatím 2 hosté \(obvykle touhle dobou 12, −83 %\)\n/);
  assert.match(outlookMorning.text, /\n⚠ Web: 20 návštěv \(obvykle 100\) a žádný odeslaný rezervační formulář \(obvykle 4\), zkontroluj, že web a rezervace běží\.(\n|$)/);
  const cancelWeek = await (await call('GET', '/admin/t/outlook-venue/briefing?date=2026-10-11')).json();
  assert.deepEqual([cancelWeek.briefing.menuByLanguage.from, cancelWeek.briefing.menuByLanguage.to, cancelWeek.briefing.menuByLanguage.days], ['2026-09-14', '2026-10-11', 0], 'four weeks on Monday, no menu sent yet');
  assert.deepEqual([cancelWeek.briefing.week.current.cancelled, cancelWeek.briefing.week.current.lateCancelled, cancelWeek.briefing.week.current.lateCancelledGuests], [4, 1, 8]);
  assert.match(cancelWeek.text, /, zrušeno 4 \(\d+ % rezervací, z toho 1 až v posledních 24 h před začátkem, 8 hostů\)/);
  const outlookDays = (await (await call('GET', '/admin/t/outlook-venue/briefing?date=2026-10-12')).json()).briefing.guestOutlook;
  assert.equal(outlookDays, null, 'not for a day looked at later');

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
  await rm(webDir, {recursive: true, force: true});
}
