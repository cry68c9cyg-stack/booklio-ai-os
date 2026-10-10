// Správa provozovny v AI OS z příkazové řádky. Spuštění: node scripts/admin.ts <příkaz> ...
// Adresa služby a správní tajemství se berou z proměnných prostředí, nikdy z argumentů:
//   AI_OS_URL=https://...  AI_OS_ADMIN_SECRET=...  node scripts/admin.ts ...
import {readFile} from 'node:fs/promises';
import {CsvError, parseHistoryCsv} from '../src/history-csv.ts';

const usage = `Použití:
  node scripts/admin.ts config <tenant> <konfigurace.json>   uloží nastavení provozovny
  node scripts/admin.ts show <tenant>                         vypíše nastavení
  node scripts/admin.ts pair <tenant> <parovani.json>         spáruje pokladnu (soubor z Pexesa: {installationId, token})
  node scripts/admin.ts history <tenant> <export.csv> [--dry-run]   nahraje denní tržby (např. export z rkeeperu)
  node scripts/admin.ts preview <tenant> <YYYY-MM-DD>         ukáže ranní přehled za den
  node scripts/admin.ts briefings <tenant>                    vypíše uložené a odeslané přehledy`;

function fail(message: string): never {
  console.error(message);
  process.exit(1);
  throw new Error(message);
}

const [command, tenant, arg, flag] = process.argv.slice(2);
if (!command || !tenant) fail(usage);
if (!/^[a-z0-9-]{3,64}$/.test(tenant)) fail('Tenant smí obsahovat jen malá písmena, číslice a pomlčky (3–64 znaků).');

async function call(method: string, route: string, body?: unknown, query = ''): Promise<unknown> {
  const base = process.env.AI_OS_URL, secret = process.env.AI_OS_ADMIN_SECRET;
  if (!base || !/^https?:\/\//.test(base)) fail('Nastavte AI_OS_URL (adresa služby).');
  if (!secret || secret.length < 32) fail('Nastavte AI_OS_ADMIN_SECRET (správní tajemství, min. 32 znaků).');
  const response = await fetch(`${base.replace(/\/$/, '')}/admin/t/${tenant}/${route}${query}`, {
    method,
    headers: {authorization: `Bearer ${secret}`, 'content-type': 'application/json'},
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json().catch(() => null);
  if (!response.ok) fail(`Chyba ${response.status}: ${JSON.stringify(result)}`);
  return result;
}

const readJson = async (path: string | undefined) => {
  if (!path) fail(usage);
  try { return JSON.parse(await readFile(path, 'utf8')); } catch { return fail(`Soubor ${path} nejde přečíst jako JSON.`); }
};

switch (command) {
  case 'config':
    console.log(JSON.stringify(await call('PUT', 'config', await readJson(arg)), null, 2));
    break;
  case 'show':
    console.log(JSON.stringify(await call('GET', 'config'), null, 2));
    break;
  case 'pair': {
    const pairing = await readJson(arg);
    console.log(await call('POST', 'pair', {installationId: pairing.installationId, token: pairing.token}));
    console.log('Pokladna je spárovaná. Soubor s tokenem teď smažte.');
    break;
  }
  case 'history': {
    if (!arg) fail(usage);
    let rows;
    try { rows = parseHistoryCsv(await readFile(arg, 'utf8')); } catch (error) {
      fail(error instanceof CsvError ? error.message : `Soubor ${arg} nejde přečíst.`);
    }
    const total = rows.reduce((sum, row) => sum + row.revenueCents, 0);
    console.log(`Dnů: ${rows.length}, od ${rows[0].businessDate} do ${rows.at(-1)!.businessDate}, tržba celkem ${Math.round(total / 100).toLocaleString('cs-CZ')} Kč`);
    if (flag === '--dry-run') break;
    for (let i = 0; i < rows.length; i += 1000) console.log(await call('POST', 'history', {rows: rows.slice(i, i + 1000)}));
    break;
  }
  case 'preview': {
    const result = await call('GET', 'briefing', undefined, `?date=${encodeURIComponent(arg ?? '')}`) as {text: string};
    console.log(result.text);
    break;
  }
  case 'briefings':
    for (const row of await call('GET', 'briefings') as {businessDate: string; status: string; text: string}[]) {
      console.log(`--- ${row.businessDate} (${row.status})\n${row.text}\n`);
    }
    break;
  default:
    fail(usage);
}
