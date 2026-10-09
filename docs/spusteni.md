# Spuštění AI OS naostro

Návod pro první provozovnu (James Dean). Každý krok, který potřebuje přístupové údaje, dělá majitel sám na svém počítači. Tajemství nikdy neposílejte do chatu, e-mailu ani do Gitu.

## Co budete potřebovat

- Účet **Cloudflare** (stačí bezplatný; Durable Objects na SQLite jsou v bezplatném tarifu, pro jistotu zkontrolujte aktuální limity).
- Účet **Twilio** s ověřeným českým číslem odesílatele nebo alfanumerickým odesílatelem (např. `JamesDean`).
- Počítač s Node.js 22.18 nebo novějším a tímto repozitářem (`npm ci`).

## 1. Cloudflare

1. Založte účet na dash.cloudflare.com.
2. V terminálu ve složce repozitáře: `npx wrangler login` (otevře prohlížeč).
3. Vytvořte správní tajemství a uložte ho do Cloudflare:
   ```sh
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   npx wrangler secret put ADMIN_SECRET --env production
   ```
   Hodnotu si uložte do správce hesel. Bude potřeba pro správní příkazy.
4. Nasazení: `npm run deploy`. Wrangler vypíše adresu služby, např. `https://booklio-ai-os.<účet>.workers.dev`.

Data provozoven jsou v produkci uložená jen v EU (`DATA_JURISDICTION=eu`).

## 2. Twilio (SMS)

1. Na twilio.com založte účet a kupte nebo ověřte odesílatele.
2. Do Cloudflare uložte údaje (token jako tajemství):
   ```sh
   npx wrangler secret put TWILIO_AUTH_TOKEN --env production
   npx wrangler secret put TWILIO_ACCOUNT_SID --env production
   npx wrangler secret put TWILIO_FROM --env production
   ```
   `TWILIO_FROM` je číslo ve tvaru `+420…` nebo jméno odesílatele.

Dokud Twilio není nastavené, přehledy se jen ukládají a lze je přečíst příkazem `briefings`.

## 3. Nastavení provozovny

Do terminálu nastavte adresu a tajemství jen pro aktuální okno:

```sh
export AI_OS_URL=https://booklio-ai-os.<účet>.workers.dev
export AI_OS_ADMIN_SECRET=<správní tajemství>
```

1. Zkopírujte `docs/priklady/james-dean.config.json` mimo repozitář, doplňte své číslo do `recipients` a v `registers` uveďte identifikátory pokladen tak, jak je ukazuje Pexeso v Nastavení → Integrace → Booklio AI OS.
2. `npm run admin -- config james-dean cesta/k/config.json`

## 4. Historie z rkeeperu (plán)

Export denních tržeb uložte jako CSV (oddělovač `;` nebo `,`). Stačí sloupce **Datum** a **Tržba**; volitelně **Účty** a **Hosté**. Víc řádků za jeden den (např. po pokladnách) se sečte.

```sh
npm run admin -- history james-dean export.csv --dry-run   # jen kontrola: počet dnů a součet
npm run admin -- history james-dean export.csv
```

Plán je průměr stejného dne v týdnu za předchozí 4 týdny.

## 5. Spárování Pexesa

1. V Pexesu: Nastavení → Integrace → Booklio AI OS. Vyplňte adresu služby a tenant `james-dean`, vygenerujte párování a uložte ho do souboru (zobrazí se jen jednou).
2. `npm run admin -- pair james-dean parovani.json`, pak soubor smažte.
3. V Pexesu zapněte odesílání. Kontrolu lahví zapínejte až po tomto kroku.

## 6. Ověření

- `npm run admin -- preview james-dean 2026-10-08`: náhled přehledu za den.
- `npm run admin -- briefings james-dean`: co odešlo a s jakým stavem (`delivered`, `stored`, `failed`).
- První SMS přijde v 7:00 po prvním provozním dni s daty z Pexesa.
