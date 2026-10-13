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
- **Týdenní souhrn**: v pondělní zprávě (za neděli) řádek „Týden …“ za posledních 7 dní proti 7 dnům předtím: tržba, potvrzené rezervace a hosté, kolik nedorazilo, návštěvy webu a nové recenze s průměrem. Pod ním řádek „Odkud na web za týden“ (pět nejčastějších zdrojů návštěv, např. Instagram, Google, QR kód na stole, a kolik z nich otevřelo rezervaci, volalo nebo navigovalo) a varování „⚠ Recenze“, když průměr hvězdiček za týden (aspoň 5 hodnocených) klesne o 0,3 ★ a víc pod 4 týdny předtím (aspoň 10 hodnocených); totéž jde do seznamu k vyřízení. Na dashboardu je týž přehled pro zobrazený den každý den, se zdroji návštěv proti týdnu předtím. Web posílá u zdrojů jen akce celkem, ne zvlášť odeslané rezervace, proto řádek ukazuje „s akcí“.
- **Měsíc a peníze**: ranní zpráva porovná tržbu i se stejným dnem před týdnem. V pondělní zprávě a ve zprávě o posledním dni měsíce je řádek měsíce: tržba od 1. dne proti stejným dnům minulého měsíce, části podniku, výplaty v hotovosti, výdaje z kasy a slevy (z reportu manažerů) a nové recenze s průměrem hvězdiček. Dashboard má kartu měsíce pro zobrazený den s výplatami a výdaji z kasy podle popisků v deníku (role, nákupy) a slevami podle druhu.
- **Výhled a marketing**: ranní zpráva u dnešních rezervací ukáže, kolik hostů bývá na tento den v týdnu za celý den (průměr 4 týdnů, dny s rezervacemi, aspoň dva; ráno jich bývá zarezervováno méně, proto bez procent), a plán tržby na dnešek. Výplaty v hotovosti mají podíl z tržby (den i měsíc). Pondělní řádek týdne ukáže hosty, kteří nedorazili (i v %), a web: návštěvy, kolikrát byl odeslán rezervační formulář (podle dne návštěvy) a kolik potvrzených rezervací z webu (`source: web`) připadá na tyto dny (podle dne rezervace; jsou to dvě různé skupiny).
- **Odhad tržby** (první verze modulu Forecast z destilátu): každá ranní zpráva má řádek „Odhad tržby: zítra … · 7 dní od dneška … · říjen celkem … (zatím …) · listopad …“, dashboard kartu „Odhad tržby“. Každý den = průměr tržby stejného dne v týdnu za poslední 4 týdny (aspoň 2 dny s daty) × loňská sezónnost jeho měsíce: průměrná denní tržba toho měsíce loni proti stejným 4 týdnům loni (52 týdnů zpět, aspoň 20 dní dat v obou, omezeno na 0,5× až 2×). Bez loňských dat sezónnost není. Den v týdnu bez tržby za 4 týdny (když jiné dny data mají) se bere jako zavřeno. Uplynulé dny měsíce bez dat se do celku odhadnou. Částky zaokrouhlené na tisíce. Když je na některý z příštích 7 dní potvrzeno výrazně víc hostů, než bývá (obvykle aspoň 10 a teď aspoň o 10 víc; obvyklý počet = průměr stejného dne v týdnu za 4 týdny, dny s rezervacemi), odhad dne se zvýší o polovinu toho rozdílu, nejvýš o 50 % (hosté bez rezervace a bar s rezervacemi nerostou); méně rezervací odhad nesnižuje. „Dnes plán tržby“ je odhad pro dnešek a OKO1 si ho uloží (tabulka `forecast_log`), takže zítřejší řádek „Tržba (plán …)“ porovná den přesně s tím, co odeslaná ranní zpráva slíbila (neodeslaná se nepočítá) a dashboard i u starých dnů ukazuje odeslaný plán; řádek odhadu ukáže i průměrnou odchylku za posledních 28 dní bez právě hlášeného dne (od 7 dní). Počasí: MET Norway (api.met.no, zdarma i pro firmy, bez klíče, posílají se jen souřadnice provozovny z nastavení `location`), načítá se v ranních hodinách nejvýš jednou za 3 hodiny; ve zprávě u zítřka, na dashboardu na 7 dní spolu s odhadem a rezervovanými hosty proti obvyklému. Akce zatím nezapočítává.
- **Rezervace pod kontrolou**: ranní zpráva u dnešních rezervací ukáže dvě hodiny s nejvíc rezervovanými hosty („Nejvíc rezervovaných hostů: 18–19 h 12, 1–2 h 20“, klub po půlnoci až na konci) a skupiny od 8 osob s časem a prostorem („Skupiny od 8 osob: 18:00 Diner 12“). Řádek „Na příštích 7 dní čeká na potvrzení 5 rezervací (12 hostů), nejbližší čt 15. 10. 18:00“ (zítra až 7 dní dopředu, dnešek má vlastní počet) jde i do seznamu k vyřízení. Pondělní řádek týdne přidá zrušené rezervace a jejich podíl. Dashboard ukazuje totéž v kartě Rezervace a v kartě týdne. Vše jen počty a časy (sčítané v SQL), žádná jména ani kontakty.
- **Akce a klub**: web posílá do OKO1 veřejné akce podniku (název, čas, prostor; záznam `event`) a u rezervací čas, kdy vznikly (`createdAt`). Ranní zpráva má řádek „Dnes akce: 21:00 Klub – Rock Night (rezervováno 40 hostů)“. Odhad tržby u dne s akcí napíše „(akce Rock Night, bývá o 30 % víc)“ a den zvýší podle toho, kolik dny s akcí za posledních 26 týdnů udělaly proti průměru svého dne v týdnu (medián, aspoň 4 dny s tržbou, 1–2×; s rezervacemi navíc se bere větší z obou, nikdy oba). Pondělní souhrn přidá řádek „Rezervace za týden: týž den … · 1–2 dny předem … · 3–7 dní … · víc než týden … · zdroje: web … (nedorazilo … % hostů) · obsluha … · AI asistenti …“. Dashboard: akce v kartě Rezervace a v tabulce odhadu, v kartě týdne „Rezervováno předem“ a „Odkud rezervace“. Vše jen počty, časy a veřejné názvy akcí.
- **Svátky, počasí a trendy**: odhad tržby zná české státní svátky (včetně Velkého pátku a Velikonočního pondělí). Svátek dostane vlastní koeficient: stejný svátek loni proti ostatním stejným dnům v týdnu téhož měsíce (bez svátků a akcí), jinak medián svátků za poslední rok (aspoň 3); 0–2×, takže loni zavřený den má odhad 0 Kč. Svátky nevstupují do průměrů dnů v týdnu. Ve zprávě „(svátek Den vzniku státu, bývá o 20 % méně)“ nebo „loni zavřeno“. OKO1 si nově nechává počasí každého dne (poslední předpověď MET Norway pro ten den, rok zpět) a deštivý den (od 5 mm) upraví mediánem toho, kolik deštivé dny za půl roku udělaly proti stejným dnům v týdnu téhož měsíce bez deště (aspoň 6 dní, 0,5–1,5×); ve zprávě „(déšť, bývá o 15 % méně)“. Dashboard: svátek a vliv deště v tabulce odhadu a karta „Trendy 12 týdnů“ (tržba, hosté z rezervací, kolik nedorazilo, návštěvy webu, formuláře → rezervace, recenze, odchylka odhadu po týdnech).
- **Směny a výhled hostů**: ranní zpráva má řádek „Hosté dnes: čekej asi 140 (zatím rezervováno 95) · přes den 20 · večer 70 · noc 50 · obvykle nedorazí asi 8“, dashboard kartu „Hosté na 7 dní“ (dny × přes den 6–17 h / večer 17–22 h / noc 22–6 h podle místního začátku rezervace). Čekaný počet = potvrzení hosté teď + kolik hostů obvykle ještě přibude: medián ze stejného dne v týdnu za posledních 8 týdnů, kolik hostů se tam potvrdilo až po stejné chvíli před dnem (podle `createdAt`; rezervace bez něj se berou jako dřívější; aspoň 2 takové dny, starší dny, kde většina hostů čas vzniku nemá, se vynechají; jinak jen rezervováno). Pozdější zrušení se neodečítají (web neposílá, kdy byla rezervace zrušena), čekaný počet je proto spíš horní odhad. Kolik nedorazí = podíl nedorazivších hostů za 28 dní (od 50 rezervovaných) × čekaní hosté. Jen pro aktuální den. Pondělní souhrn přidá řádek „Akce za týden: pá 9. 10. Rock Night – 120 hostů z rezervací (obvykle 80, +50 %), tržba 150 000 Kč (obvykle 100 000 Kč)“: hosté v prostoru akce a tržba dne proti průměru až 4 stejných dnů v týdnu bez akce za 8 týdnů (aspoň 2); totéž v kartě týdne na dashboardu. Čtou se jen začátek, počet osob, stav a čas vzniku rezervací.
- **No-show**: když nedorazí aspoň 6 rezervovaných hostů, aspoň 10 % a aspoň dvojnásobek obvyklého podílu za posledních 28 dní (počítá se od 50 rezervovaných hostů), ranní zpráva i seznam k vyřízení napíšou „⚠ No-show: nedorazilo 12 hostů z 52 rezervovaných (23 %, obvykle 5 %)“. Jen počty, žádná jména.
- **Neobvyklé slevy**: druh slevy (personál, promo, odpisy…), který je aspoň dvojnásobkem své obvyklé výše a aspoň o 1 000 Kč nad ní, jde se ⚠ do ranní zprávy a do seznamu k vyřízení. Obvyklá výše = průměr stejného dne v týdnu za 4 týdny, počítají se jen dny s reportem manažerů (aspoň dva).
- **Hlídání zdrojů**: když web neposlal data déle než 3 hodiny (posílá každou hodinu) nebo pokladna déle než 26 hodin, ranní zpráva i seznam k vyřízení napíšou „⚠ Web neposílá data od 12. 10. 18:01.“ Platí jen pro dnešní zprávu, ne pro staré dny. Dashboard má kartu „Zdroje dat“: kdo a kdy naposledy poslal, kdy přišel který druh dat a kdy OKO1 naposledy četlo report z OneDrive a náklady z iÚčta. Jen časy, žádný obsah.
- **Archiv v R2 (EU)**: nezměněné kopie všech dávek z pokladny a excelů z OneDrive a denní export všeho, co OKO1 o dni ví (`oko1-archive`).

- **Dashboard** na `https://oko1.rr7whdyyhf.workers.dev/d/{tenant}` (James Dean: `/d/james-dean`): tržba proti plánu a stejnému dni před týdnem, platby, slevy a storna, peníze (trezor, banka, výdaje z kasy, výplaty), seznam k vyřízení (nejvýš 15 bodů, varování první; u každého tlačítko „Vyřízeno“, vyřízené body zůstanou přeškrtnuté na konci a „Vrátit“ je vrátí; pamatuje se pro daný den a bod v databázi provozovny), tržby za 35 dní, týden proti týdnu předtím, měsíc proti minulému, zdroje dat, části podniku, „Report dne“, všechny řádky reportu manažerů a ranní zpráva. Přihlášení: návštěvník zadá svoje číslo; kód v SMS přijde jen na číslo z `dashboardPhones` (není-li nastaveno, jen na první z `recipients`, tedy majitele), jiné číslo dostane stejnou odpověď a nic se nepošle. Kód platí 10 minut a jednou; formulář odpočítává jeho platnost („Kód platí ještě 9:41“) a „Poslat kód znovu“ pustí až po 60 s („Poslat znovu za 0:42“). Server 60 s vynucuje (429 s počtem sekund) a nový kód zneplatní předchozí. Nejvýš 5 kódů za hodinu a 10 za den, po 10 chybných kódech za hodinu se přihlášení na hodinu zavře; formulář řekne, za kolik to půjde znovu. Číslo bez přístupu i neznámá provozovna mají stejný odpočet, stejné 429 i limity, takže z odpovědi nejde poznat, jestli číslo přístup má. Pole kódu má `autocomplete="one-time-code"`, iPhone a iPad tak nabídnou kód ze Zpráv. Přihlášení drží 30 dní v cookie jen pro danou provozovnu; změna povolených čísel nebo `POST /admin/t/{tenant}/logout` všechna přihlášení ukončí.

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
