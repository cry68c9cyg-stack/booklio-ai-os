// Správa provozovny v AI OS z příkazové řádky. Spuštění: node scripts/admin.ts <příkaz> ...
// Adresa služby a správní tajemství se berou z proměnných prostředí, nikdy z argumentů:
//   AI_OS_URL=https://...  AI_OS_ADMIN_SECRET=...  node scripts/admin.ts ...
import {readdir, readFile} from 'node:fs/promises';
import {basename, join} from 'node:path';
import {CsvError, parseHistoryCsv} from '../src/history-csv.ts';
import {JOURNAL_LABEL} from '../src/daily-report.ts';
import {pickFiles, reportFromFiles} from '../src/onedrive.ts';
import {isDate} from '../src/time.ts';

const usage = `Použití:
  node scripts/admin.ts config <tenant> <konfigurace.json>   uloží nastavení provozovny
  node scripts/admin.ts show <tenant>                         vypíše nastavení
  node scripts/admin.ts pair <tenant> <parovani.json>         spáruje pokladnu (soubor z Pexesa: {installationId, token})
  node scripts/admin.ts history <tenant> <export.csv> [--dry-run]   nahraje denní tržby (např. export z rkeeperu)
  node scripts/admin.ts preview <tenant> <YYYY-MM-DD>         ukáže ranní přehled za den
  node scripts/admin.ts briefings <tenant>                    vypíše uložené a odeslané přehledy
  node scripts/admin.ts report <tenant> <YYYY-MM-DD>          ukáže uložený denní report manažerů a rozbor „Report dne“
  node scripts/admin.ts fetch <tenant> <YYYY-MM-DD> [--keep]  načte denní report z OneDrive hned (mimo ranní okno); --keep nepřepíše den, který denní report už má
  node scripts/admin.ts import <tenant> <složka> <od> <do> [--dry-run] [--force]   nahraje dny z excelů manažerů ve složce (deník a denní reporty); den s uloženým denním reportem přeskočí, pokud není --force
  node scripts/admin.ts web <tenant>                          ověří živé čtení webu (adresa, tajemství s tokenem, seznam tabulek); žádná data hostů
  node scripts/admin.ts ingest <tenant>                       kdo posílá data a kdy naposledy (instalace, poslední dávky, typy záznamů); bez obsahu záznamů
  node scripts/admin.ts competitors <tenant> <ceny.json>      uloží ceny srovnatelných podniků v okolí (z jejich veřejných lístků)`;

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
  case 'report':
    console.log(JSON.stringify(await call('GET', 'report', undefined, `?date=${encodeURIComponent(arg ?? '')}`), null, 2));
    break;
  case 'fetch':
    if (flag !== undefined && flag !== '--keep') fail(usage);
    console.log(JSON.stringify(await call('POST', 'fetch', {date: arg, keep: flag === '--keep'}), null, 2));
    break;
  case 'import': {
    // The same reading as the morning fetch from OneDrive, day by day, for files that are already at hand.
    const [from, to] = [flag, process.argv[6]];
    const options: string[] = process.argv.slice(7);
    if (!arg || !isDate(from) || !isDate(to) || from > to || options.some(option => option !== '--dry-run' && option !== '--force')) fail(usage);
    const dryRun = options.includes('--dry-run'), force = options.includes('--force');
    const names = (await readdir(arg)).filter(name => /\.xlsx$/i.test(name) && !name.startsWith('~$'));
    const files = await Promise.all(names.map(async name => ({name, bytes: new Uint8Array(await readFile(join(arg, name)))})));
    for (let day = new Date(`${from}T12:00:00Z`); day.toISOString().slice(0, 10) <= to; day.setUTCDate(day.getUTCDate() + 1)) {
      const date = day.toISOString().slice(0, 10), picked = pickFiles(names, date);
      const report = await reportFromFiles(files.filter(file => file.name === picked.report || picked.books.includes(file.name)), date);
      if (!report) { console.log(`${date}: nic`); continue; }
      const revenue = report.lines.filter(line => line.kind === 'revenue_section').reduce((sum, line) => sum + line.amountCents, 0);
      console.log(`${date}: ${report.files.map(name => basename(name)).join(', ')} · tržba ${Math.round(revenue / 100).toLocaleString('cs-CZ')} Kč · řádků ${report.lines.length}${report.warnings.length ? ` · ${report.warnings.join(' ')}` : ''}`);
      // A past day without its daily report is history, not a missing report.
      const warnings = report.warnings.filter(text => !text.startsWith('Denní report chybí'));
      if (dryRun) continue;
      const stored = await call('GET', 'report', undefined, `?date=${date}`) as {report: {lines: {kind: string; label: string}[]} | null};
      if (!force && stored.report?.lines.some(line => line.kind === 'revenue_section' && !line.label.startsWith(JOURNAL_LABEL))) { console.log(`${date}: denní report už je uložený, přeskočeno`); continue; }
      await call('PUT', 'report', {...report, source: 'admin', warnings});
    }
    break;
  }
  case 'web':
    console.log(JSON.stringify(await call('GET', 'web'), null, 2));
    break;
  case 'ingest':
    console.log(JSON.stringify(await call('GET', 'ingest'), null, 2));
    break;
  case 'competitors':
    console.log(JSON.stringify(await call('PUT', 'competitors', await readJson(arg)), null, 2));
    break;
  default:
    fail(usage);
}
