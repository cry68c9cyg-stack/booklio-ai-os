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
- **Recenze z webu James Dean**: web posílá každou hodinu jen počty recenzí, které dorazily do jeho adminu (Google, TripAdvisor), podle hvězdiček, a kolik jich tam čeká (`review_summary`, viz kontrakt). Ranní zpráva ukáže nové recenze s průměrem a slabé (3 ★ a méně), slabé a recenze pro vedení jdou do seznamu k vyřízení; texty ani autoři do OKO1 nechodí.
- **Náklady a výsledek z iÚčta**: s klíčem `IUCTO_KEY_<TENANT>` (James Dean: `IUCTO_KEY_JAMES_DEAN`, v GitHubu `IUCTO_API_KEY`) si OKO1 jednou denně v ranních hodinách odeslání přečte z účetnictví zaúčtované náklady (účty třídy 5) za běžný měsíc do reportovaného dne a za minulý měsíc. Do ranní zprávy a na dashboard dá náklady podle syntetických účtů a „tržby − náklady“ za měsíc; v první polovině měsíce i výsledek minulého měsíce. Jen čte (`GET /chart_account`, `GET /journal`) a ukládá jen součty za měsíc a účet, žádné dodavatele, odběratele ani texty dokladů. Nepovedené čtení nechá poslední součty a ve zprávě upozorní. Náklady jsou „zatím zaúčtované“, účetnictví se doplňuje se zpožděním.
- **Archiv v R2 (EU)**: nezměněné kopie všech dávek z pokladny a excelů z OneDrive a denní export všeho, co OKO1 o dni ví (`oko1-archive`).

- **Dashboard** na `https://oko1.rr7whdyyhf.workers.dev/d/{tenant}` (James Dean: `/d/james-dean`): tržba proti plánu a stejnému dni před týdnem, platby, slevy a storna, peníze (trezor, banka, výdaje z kasy, výplaty), seznam k vyřízení (nejvýš 15 bodů, varování první; u každého tlačítko „Vyřízeno“, vyřízené body zůstanou přeškrtnuté na konci a „Vrátit“ je vrátí; pamatuje se pro daný den a bod v databázi provozovny), tržby za 35 dní, části podniku, „Report dne“, všechny řádky reportu manažerů a ranní zpráva. Přihlášení: návštěvník zadá svoje číslo; kód v SMS přijde jen na číslo z `dashboardPhones` (není-li nastaveno, jen na první z `recipients`, tedy majitele), jiné číslo dostane stejnou odpověď a nic se nepošle. Kód platí 10 minut a jednou; formulář odpočítává jeho platnost („Kód platí ještě 9:41“) a „Poslat kód znovu“ pustí až po 60 s („Poslat znovu za 0:42“). Server 60 s vynucuje (429 s počtem sekund) a nový kód zneplatní předchozí. Nejvýš 5 kódů za hodinu a 10 za den, po 10 chybných kódech za hodinu se přihlášení na hodinu zavře; formulář řekne, za kolik to půjde znovu. Číslo bez přístupu i neznámá provozovna mají stejný odpočet, stejné 429 i limity, takže z odpovědi nejde poznat, jestli číslo přístup má. Pole kódu má `autocomplete="one-time-code"`, iPhone a iPad tak nabídnou kód ze Zpráv. Přihlášení drží 30 dní v cookie jen pro danou provozovnu; změna povolených čísel nebo `POST /admin/t/{tenant}/logout` všechna přihlášení ukončí.

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
- **Osobní údaje hostů** (jména, telefony, e-maily, poznámky): od 12. 10. 2026 (schválil MC) je OKO1 čte živě z webu James Dean a ukazuje je jen vedení přes MCP server a dashboard, oboje za přihlášením kódem z SMS. Živě čtené údaje neukládá. Uložené jsou jen údaje hosta, které web posílá u rezervací přes ingest v1 (pole `guest`, rozhodnutí MC 12. 10. 2026), a to jen v SQLite provozovny, nikdy v R2, exportu, KV ani logu. Údaje hostů neposílá je do ranní zprávy ani do LLM, které si samo volá. Viz [docs/web-v1.md](docs/web-v1.md).
- Token pro čtení webu je tajemství Workeru `WEB_TOKEN_<TENANT>` (James Dean: `WEB_TOKEN_JAMES_DEAN`), ve webu `OKO1_CTENI_TOKEN`; vytváří ho nasazení, výměna = smazat obě a nasadit.
- Klíč iÚčta je tajemství Workeru `IUCTO_KEY_<TENANT>`; iÚčto nemá klíče jen pro čtení, proto ho OKO1 posílá jen v hlavičce `X-Auth-Key` dotazů GET na `online.iucto.cz`, nikdy do logu ani do textu chyby. Výměna = nový klíč v iÚčtu, `IUCTO_API_KEY` v GitHubu a nasadit.
- Výchozí konfigurace vypíná `workers.dev` i preview URL. Před nasazením je potřeba Cloudflare účet, doména a umístění dat v EU.
