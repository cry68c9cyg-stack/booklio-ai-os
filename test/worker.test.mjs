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
  const config = {name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7, 8, 9, 10], registers: ['bar'], sections: {bar: 'Bar'}, recipients: []};
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

  // Next day nothing closes: 10:00 sends anyway, marked incomplete. The venue now expects a bottle check.
  assert.equal((await call('PUT', '/admin/t/test-venue/config', {...config, bottleCheck: {minLossCents: 10000}})).status, 200);
  await ingest('batch-0004', [bill('b3', 1, 30000, '2026-10-09')]);
  assert.equal((await tick('2026-10-10T07:00:00Z')).decision, 'wait'); // 9:00 local
  const late = await tick('2026-10-10T08:00:00Z'); // 10:00 local
  assert.equal(late.decision, 'send-incomplete');
  assert.match(late.text, /⚠ Uzávěrka chybí: bar\./);
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

  // The hourly cron wakes every configured venue.
  const worker = await mf.getWorker();
  await worker.scheduled({scheduledTime: new Date('2026-10-11T05:00:00Z'), cron: '0 * * * *'});
  // SMS delivery through Twilio: a failed send is retried at the next hour, then marked delivered.
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
  // Venues without recipients stay 'stored' even with Twilio configured.
  assert.deepEqual((await (await call('GET', '/admin/t/test-venue/briefings')).json()).map(row => row.status), ['stored', 'stored']);
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
