# Booklio AI OS

Samostatná služba, která čte data z pokladny (Pexeso) a rezervačního systému (Booklio) a dělá z nich provozní přehledy pro majitele. Je navržená pro více podniků: každá provozovna (`tenant`) má vlastní oddělenou databázi.

## Co umí teď (milník 1)

- **Příjem dat z pokladny**: uzavřené účty a uzávěrky hotovosti, viz [kontrakt v1](docs/ingest-v1.md). Pokladna se připojuje sama, nemusí být vystavená do internetu.
- **Ranní přehled tržeb** za včerejší provozní den: tržba, plán, střediska, účty, hosté, průměrný účet, platby, slevy, storna (zvlášť storna po zaplacení), rozdíly v hotovosti a nejprodávanější položky.
- **Pravidlo odeslání**: v 7:00, když jsou uzávěrky všech pokladen (report); jinak znovu v 8:00; v 9:00 odejde vždy, s upozorněním „Report chybí“. Mimo 7–9 se nic neposílá, za jeden den nikdy dvakrát.
- **Plán** = průměr stejného dne v týdnu za předchozí 4 týdny (min. 2 dny dat). Starší dny lze doplnit jednorázovým importem denních tržeb (např. export z rkeeperu).
- **Ranní kontrola lahví**: pokladna pošle spočítaný a očekávaný stav sledovaných lahví (`bottle_check`, viz kontrakt). Přehled vypíše jen lahve s mankem od prahu `bottleCheck.minLossCents` (výchozí 100 Kč), seřazené podle Kč se ⚠; s nastaveným `bottleCheck` upozorní, když kontrola chybí.

- **Denní report manažerů z OneDrive** (přechodně, než poběží Pexeso): OKO1 si v 7:00, 8:00 a 9:00 (dokud report nemá) samo přečte excely ze sdílené složky (`reportsLink`, jen čtení), uloží tržby po částech, platby, slevy a odpisy, výdaje z kasy, výplaty, trezor, banku a přepočet hotovosti a do ranní zprávy přidá to podstatné. Popis v [docs/denni-report-v1.md](docs/denni-report-v1.md).
- **„Report dne“**: volný text manažera. S klíčem `ANTHROPIC_API_KEY` ho Claude roztřídí na incidenty, problémy a úkoly; jména, telefony a e-maily se před odesláním nahradí značkami. Bez klíče jde do zprávy zkrácený text.
- **Archiv v R2 (EU)**: nezměněné kopie všech dávek z pokladny a excelů z OneDrive a denní export všeho, co OKO1 o dni ví (`oko1-archive`).

- **Dashboard** na `https://oko1.rr7whdyyhf.workers.dev/d/{tenant}` (James Dean: `/d/james-dean`): tržba proti plánu a stejnému dni před týdnem, platby, slevy a storna, peníze (trezor, banka, výdaje z kasy, výplaty), seznam k vyřízení (nejvýš 15 bodů, varování první), tržby za 35 dní, části podniku, „Report dne“, všechny řádky reportu manažerů a ranní zpráva. Přihlášení: návštěvník zadá svoje číslo; kód v SMS přijde jen na číslo z `dashboardPhones` (není-li nastaveno, jen na první z `recipients`, tedy majitele), jiné číslo dostane stejnou odpověď a nic se nepošle. Kód platí 10 minut a jednou, nejvýš 5 kódů za hodinu a 10 za den, po 10 chybných kódech za hodinu se přihlášení na hodinu zavře. Přihlášení drží 30 dní v cookie jen pro danou provozovnu; změna povolených čísel nebo `POST /admin/t/{tenant}/logout` všechna přihlášení ukončí.

- **Živé čtení webu James Dean a MCP server** (nový zásah do architektury, schválil MC 12. 10. 2026): OKO1 čte z webu ve chvíli dotazu všechno, co vidí admin webu, i se jmény a kontakty hostů (rezervace, hosté, zprávy, černá listina, recenze, dárkové karty, platby stolu s lahví, blokace, akce, návštěvnost, nastavení) a nikam to neukládá. Vedení se ptá přes MCP server OKO1 (`/mcp`, přihlášení kódem z SMS jako na dashboard), který vidí pokladnu i web dohromady; na dashboardu je karta „Web James Dean“ s dnešními rezervacemi. Popis v [docs/web-v1.md](docs/web-v1.md).

- **Doručení přes BulkGate** (aplikace OKO1) na čísla v `recipients`: WhatsApp šablonou, když je nastavený `WHATSAPP_SENDER` (čeká na schválení odesílatele), jinak SMS. Twilio jen jako záloha. Bez brány se přehled jen uloží a je k dispozici přes správní API. Nepovedené odeslání se zkusí znovu v další hodinu odeslání (nejpozději v 9:00).

Nasazeno naostro: https://oko1.rr7whdyyhf.workers.dev (EU), automaticky z větve `main` přes GitHub Actions. Zadání a rozhodnutí vlastníka: specifikace OKO1 v projektu.

## Spuštění naostro

Krok za krokem v [docs/spusteni.md](docs/spusteni.md): Cloudflare, Twilio, nastavení provozovny, import historie z rkeeperu (`npm run admin -- history`) a spárování Pexesa.

## Správní API

Vše vyžaduje `Authorization: Bearer <ADMIN_SECRET>` (min. 32 znaků).

| | |
|---|---|
| `PUT /admin/t/{tenant}/config` | název, časová zóna, hranice provozního dne, hodiny odeslání, pokladny, střediska, příjemci, volitelně `bottleCheck: {minLossCents}` |
| `POST /admin/t/{tenant}/pair` | spárování pokladny (`installationId`, `token`) |
| `POST /admin/t/{tenant}/history` | import denních tržeb `{rows: [{businessDate, revenueCents, bills?, guests?}]}` |
| `GET /admin/t/{tenant}/briefing?date=YYYY-MM-DD` | náhled přehledu za den |
| `GET /admin/t/{tenant}/briefings` | odeslané/uložené přehledy |
| `POST /admin/t/{tenant}/tick` | ruční spuštění plánovače k času `{at}` (pro ověření) |
| `PUT /admin/t/{tenant}/report` | uloží denní report manažerů (viz [docs/denni-report-v1.md](docs/denni-report-v1.md)) |
| `GET /admin/t/{tenant}/report?date=YYYY-MM-DD` | uložený denní report a rozbor „Report dne“ |
| `POST /admin/t/{tenant}/fetch` | načte report z OneDrive hned `{date}` |
| `GET /admin/t/{tenant}/web` | ověří živé čtení webu: adresa, název tajemství, jestli je token nastavený, počet tabulek; bez tokenu a bez dat hostů |

## MCP server

`https://oko1.rr7whdyyhf.workers.dev/mcp` (Streamable HTTP, OAuth). Jen čtení: pokladna (`trzby_dne`, `trzby_obdobi`, `ranni_prehled`, `report_manazeru`, `kontrola_lahvi`, `ucty`), web živě (`web_rezervace`, `web_rezervace_detail`, `web_host`, `web_navstevnost`, `web_recenze`, `web_darkove_karty`, `web_platby_lahvi`, `web_blokace_a_akce`, `web_prehled`, `web_tabulka`) a souhrn `den`. Připojení v Claudovi: vlastní konektor s touto adresou, pak provozovna a kód z SMS na číslo, které smí na dashboard; vydrží 30 dní. Podrobnosti v [docs/web-v1.md](docs/web-v1.md).

Příklad konfigurace James Dean:

```json
{"name": "James Dean", "timeZone": "Europe/Prague", "businessDayCutoffHour": 6, "sendHours": [7, 8, 9],
 "registers": ["bar", "klub"], "sections": {"diner": "Diner", "bar": "Bar", "club": "Klub"}, "recipients": [],
 "bottleCheck": {"minLossCents": 10000}, "web": {"url": "https://jamesdean.cz"}}
```

## Vývoj

Node 22.18 nebo novější.

```sh
npm ci
npm test        # jednotkové testy + end-to-end na skutečném workerd (Miniflare), jen syntetická data
npm run check   # TypeScript
npm run build   # wrangler deploy --dry-run, nic nenasazuje
```

Technika: Cloudflare Worker, jeden SQLite Durable Object na provozovnu, ranní cron v 7, 8 a 9 hodin pražského času, archiv v R2 (EU), MCP server s OAuth (KV `OAUTH_KV`) a živé čtení webu James Dean. Excel se čte bez knihoven (vlastní čtečka ZIP a XML). Stejný vzor jako cloudové rezervace v Pexesu (větev `feat/t10-online-reservations`).

## Bezpečnost

- Do repozitáře nepatří tajemství, `.dev.vars`, exporty z pokladny ani data hostů.
- `ADMIN_SECRET` patří do Cloudflare secret, lokálně do ignorovaného `.dev.vars`.
- Tokeny pokladen se ukládají jen jako SHA-256 otisk.
- **Osobní údaje hostů** (jména, telefony, e-maily, poznámky): od 12. 10. 2026 (schválil MC) je OKO1 čte živě z webu James Dean a ukazuje je jen vedení přes MCP server a dashboard, oboje za přihlášením kódem z SMS. Neukládá je do SQLite, R2, KV ani logů a neposílá je do ranní zprávy ani do LLM, které si samo volá. Kontrakt ingest dál nese jen počty rezervací. Viz [docs/web-v1.md](docs/web-v1.md).
- Token pro čtení webu je tajemství Workeru `WEB_TOKEN_<TENANT>` (James Dean: `WEB_TOKEN_JAMES_DEAN`), ve webu `OKO1_CTENI_TOKEN`; vytváří ho nasazení, výměna = smazat obě a nasadit.
- Výchozí konfigurace vypíná `workers.dev` i preview URL. Před nasazením je potřeba Cloudflare účet, doména a umístění dat v EU.
