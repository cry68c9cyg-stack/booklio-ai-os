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
4. Nasazení: `npm run deploy`. Wrangler vypíše adresu služby, např. `https://oko1.<účet>.workers.dev`.

Data provozoven jsou v produkci uložená jen v EU (`DATA_JURISDICTION=eu`).

## 2. WhatsApp a SMS (BulkGate)

Posílá se přes **BulkGate Advanced API** (vlastní aplikace „OKO1“, ne aplikace webu). Do tajemství repozitáře na GitHubu uložte `BULKGATE_APP_ID` a `BULKGATE_TOKEN`; nasazení je samo předá do Cloudflare.

- **WhatsApp:** po registraci odesílatele u podpory BulkGate a schválení šablony `ranni_prehled` (jazyk `cs`, jeden textový parametr) nastavte proměnnou repozitáře `WHATSAPP_SENDER` (číslo odesílatele). Přehled pak jde do WhatsAppu a když se nedoručí do 10 minut, přijde jako SMS.
- **SMS:** odesílatel `JamesDean` (změna přes proměnnou `SMS_SENDER`), text bez diakritiky, nejvýš 612 znaků.
- Twilio (`TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`) zůstává jen jako záloha.

Dokud není nastavená žádná brána, přehledy se jen ukládají a lze je přečíst příkazem `briefings`.

## 3. Nastavení provozovny

Do terminálu nastavte adresu a tajemství jen pro aktuální okno:

```sh
export AI_OS_URL=https://oko1.<účet>.workers.dev
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

## 6. Web James Dean a MCP server

Živé čtení webu a MCP server popisuje [docs/web-v1.md](web-v1.md). Nasazení z větve `main` udělá samo:

- doplní do nastavení James Dean `web.url = https://jamesdean.cz`;
- najde, nebo poprvé vytvoří jmenný prostor KV `oko1-oauth` pro přihlašování k MCP; když token `CLOUDFLARE_API_TOKEN` nemá oprávnění Workers KV Storage, použije id jmenného prostoru `oko1-oauth` z `wrangler.jsonc` (vytvořený 12. 10. 2026), pro binding Workeru oprávnění KV potřeba není;
- když web nemá tajemství `OKO1_CTENI_TOKEN` nebo ho odmítá, vytvoří nový token a uloží ho do OKO1 (`WEB_TOKEN_JAMES_DEAN`) i do webu (`OKO1_CTENI_TOKEN`). Web přitom musí mít nasazené čtecí rozhraní `/api/oko1/v1`.

Ověření: `npm run admin -- web james-dean` musí ukázat `"ok": true` a 18 tabulek. Výměna tokenu: smazat obě tajemství a znovu spustit nasazení.

Připojení v Claudovi (každý, kdo smí na dashboard):

1. Claude → Nastavení → Konektory → Přidat vlastní konektor, adresa `https://oko1.rr7whdyyhf.workers.dev/mcp` (v Claude Code: `claude mcp add --transport http oko1 https://oko1.rr7whdyyhf.workers.dev/mcp` a pak `/mcp`).
2. Na stránce OKO1 zkontrolovat, kam přístup půjde, zadat provozovnu `james-dean` a svoje číslo.
3. Opsat kód z SMS. Připojení i přihlášení na dashboard platí 30 dní od posledního použití, nejvýš rok od kódu; `POST /admin/t/james-dean/logout` (správní API) ukončí všechna připojení i přihlášení na dashboard.

## 7. Ověření

- `npm run admin -- preview james-dean 2026-10-08`: náhled přehledu za den.
- `npm run admin -- briefings james-dean`: co odešlo a s jakým stavem (`delivered`, `stored`, `failed`).
- První SMS přijde v 7:00 po prvním provozním dni s daty z Pexesa.
