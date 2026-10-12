# Živé čtení webu James Dean a MCP server OKO1 · v1

## Nový zásah do architektury (12. 10. 2026, schválil MC)

OKO1 dosud nesmělo pracovat se jmény a kontakty hostů: z rezervačního systému dostávalo jen počty ([kontrakt ingest v1](ingest-v1.md)) a „Report dne“ posílá do Clauda jen po pseudonymizaci. **Nově OKO1 čte z webu James Dean živě všechna data, která vidí admin webu, včetně jmen, telefonů, e-mailů a poznámek hostů, a předává je přes svůj MCP server do Clauda vedení.** Neukládá si je: žádná tabulka, archiv R2, log ani kopie. Data se přečtou ve chvíli dotazu (otázka v Claudovi, otevření dashboardu) a jdou jen do odpovědi.

Vlastník (MC) 12. 10. 2026: „Chci dát oku plný přístup“, „ať si ukládá i osobní údaje, tedy jména a všechno. Jména i kontakty.“ a po upřesnění „aby oko jedna mělo kdykoliv například na dotaz přes MCP server aktuální online informace, ne staré hodinu“ a „vlastní MCP server v OKO1, pokladna i web dohromady“. Ve 13:01 MC doplnil: „Chci, aby oko jedna mělo údaje hostů živě, a zároveň si je i ukládalo.“ Vedle živého čtení proto web posílá údaje hosta u každé rezervace i hodinově přes [ingest v1](ingest-v1.md) (pole `guest`) a OKO1 je ukládá do SQLite provozovny.

Záruky, na kterých tahle změna stojí:

- **Nic, co OKO1 čte živě, se neukládá.** Výjimka je jen pole `guest` u rezervací, které web posílá přes ingest v1: to se ukládá do SQLite provozovny a nikam jinam. Živě čtená data nejsou ani v SQLite provozovny (Durable Object), ani v archivu R2 (`ingest`, `onedrive`, `export/{den}.json`), ani v KV pro OAuth, ani v logu. Hlídá to e2e test, který po celém průchodu prohledá všechny soubory Durable Objects, KV a R2.
- **Nic z webu nejde do ranní zprávy** (SMS, WhatsApp), do `Briefing`, do „K vyřízení“ ani do promptu LLM, které si OKO1 samo volá (rozbor „Report dne“). Do Clauda jdou údaje hostů jen jako odpověď MCP na dotaz vedení.
- **Přístup jen pro vedení:** MCP i karta dashboardu jsou za přihlášením kódem z SMS na číslo z `dashboardPhones` (jinak první z `recipients`, tedy majitel).
- **Web je zdroj pravdy:** co web smaže nebo anonymizuje (rezervace po 3 měsících, karty a recenze po 13 měsících), OKO1 už nikdy neukáže.
- **Jen čtení.** OKO1 do webu nic nezapisuje; web vydává jen tabulky z whitelistu, bez otisků hesel, klíčů, tokenů a odkazů pro hosta.

Zásady ochrany osobních údajů webu (cs, en, de) tuto změnu popisují od 12. 10. 2026 (OKO1 jako interní provozní systém, Anthropic i jako asistent pro dotazy vedení).

## Rozhraní webu

Web (`james-dean-web`) má čtecí rozhraní `https://jamesdean.cz/api/oko1/v1/…`:

- Hlavička `Authorization: Bearer <token>` (64 hex znaků). Web bez tajemství `OKO1_CTENI_TOKEN` vrací 404 (rozhraní je vypnuté), špatný token 401, po 10 špatných tokenech z jedné IP za 15 minut 429. Správný token projde vždy, i souběžně.
- Jen `GET`, odpovědi JSON s `Cache-Control: no-store`.

| Cesta | Odpověď |
|---|---|
| `GET /api/oko1/v1/tabulky` | `{tabulky: [{nazev, klic, datum, filtry}]}`: `datum` = sloupec pro `od`/`do` (nebo `null`), `filtry` = sloupce pro `rovno` |
| `GET /api/oko1/v1/tabulka/{nazev}?po=&limit=&od=&do=&rovno=sloupec:hodnota` | `{nazev, radky: [{_klic, …sloupce}], dalsi}`; stránky po nejvýš 1000 řádcích, `dalsi` = `po` další stránky, nebo `null`; `rovno` i vícekrát (všechny podmínky platí zároveň); nepovolený filtr 422 s vysvětlením |
| `GET /api/oko1/v1/navstevnost?od=RRRR-MM-DD` | `{statistiky: {dnes, od, prvniDen, prvniSken, dny: [{den, navstevy, sAkci, puvody, akce, stranky, zarizeni, jazyky, zeme, doby, skenyHodnoceni, rychlost}]}, online}`; nejvýš 13 měsíců zpět |
| `GET /api/oko1/v1/prehled` | `{potvrzovani, dobaDrzeniMin, kapacitaWebu, asistenti, kopieNaEmail, kredity, cekajici}` |

Tabulky (whitelist webu): `rezervace` (bez `storno_token`, `nabidka_token`), `rezervace_stoly`, `hoste` (bez `hledani`), `hoste_pozvanky` (bez `token`), `nedorazeni`, `cerna_listina_vyrazeni`, `zpravy`, `recenze`, `objednavky_karet`, `platby` (bez `session_id`), `blokace`, `blokace_stoly`, `akce`, `akce_kanaly`, `akce_fotky` (bez `data`), `pozvanky`, `pozvanky_rozeslani`, `skeny_qr`. Přesný seznam sloupců pro `od`/`do` a `rovno` je v konstantě `TABULKY_OKO1` webu (`src/server/http/oko1Cteni.ts`) a vrací ho `GET /tabulky`.

Důležité hodnoty: stav rezervace `nova` (čeká na obsluhu), `potvrzena`, `odmitnuta`, `propadla`, `zrusena_hostem`, `zrusena_obsluhou`; `kontakt_typ` `tel` nebo `email`; `datum` rezervace je u klubu den, ke kterému noc patří (provozní den); stoly `p1`–`p17` v přízemí, `kA`–`kD` a `k1`–`k13` v klubu.

## Klient webu v OKO1

`src/web-client.ts` (pojistky stejně jako u OneDrive):

- jen `https://` na hostitele z allowlistu `WEB_HOSTS` (`jamesdean.cz`), bez portu a přihlašovacích údajů v adrese;
- `redirect: 'manual'`, přesměrování je chyba;
- časový limit 10 s na požadavek a 25 s na celé čtení (všechny stránky), odpověď nejvýš 20 MB;
- nejvýš 5 000 řádků na jeden živý dotaz (nástroje MCP mají výchozí 1 000); delší odpověď se vrátí zkrácená s `zkraceno: true`;
- chyby jako krátké české texty (`HTTP 401 (neplatný token)`, `web není dostupný`, vysvětlení webu u 422), nikdy výjimka a nikdy token ani data v textu chyby.

`src/web-views.ts` skládá z tabulek pohledy: rezervace se stoly, detail rezervace (stoly, zprávy, platby), host podle kontaktu (databáze hostů, rezervace, nedorazení, černá listina, pozvánky) a kartu dashboardu.

## Token

- V OKO1 je token tajemství Workeru `WEB_TOKEN_<TENANT>`: název provozovny velkými písmeny, `-` → `_` (James Dean: `WEB_TOKEN_JAMES_DEAN`). Nikdy není v configu, v Gitu, v logu ani v odpovědi API.
- Ve webu je stejný token tajemství `OKO1_CTENI_TOKEN`.
- Config provozovny určuje adresu webu: `web: {"url": "https://jamesdean.cz"}` (jen původ z allowlistu, bez cesty a dotazu). Nasazení ho do configu James Dean doplní samo.

**Jak token vzniká:** nasazení (`.github/workflows/deploy.yml`, krok „Token pro živé čtení webu“) se podívá, jestli web tajemství `OKO1_CTENI_TOKEN` má a jestli s ním OKO1 web přečte (`GET /admin/t/james-dean/web`). Když web token nemá, nebo ho odmítá (401), vygeneruje `openssl rand -hex 32` (v logu maskovaný), uloží ho nejdřív do OKO1 (`wrangler secret put WEB_TOKEN_JAMES_DEAN --env production`), pak do webu (`wrangler secret bulk --name james-dean-web-production` mimo repozitář) a ověří čtení. Když web jen neodpovídá, token zůstává a nasazení varuje.

**Výměna:** smazat obě tajemství (`OKO1_CTENI_TOKEN` ve webu, `WEB_TOKEN_JAMES_DEAN` v OKO1) a spustit nasazení.

**Zrušení přístupu OKO1 k webu:** smazat `OKO1_CTENI_TOKEN` ve webu (rozhraní webu je pak vypnuté, 404) a `WEB_TOKEN_JAMES_DEAN` v OKO1, případně odebrat `web` z configu provozovny. Dokud se `web` z nasazení neodebere, další nasazení vytvoří nový token; trvalé vypnutí tedy znamená i úpravu kroku v `deploy.yml`.

## MCP server OKO1

- Adresa: `https://oko1.rr7whdyyhf.workers.dev/mcp` (Streamable HTTP bez stavu, odpovědi JSON, `@modelcontextprotocol/sdk`). Jen `POST`.
- OAuth 2.1 (`@cloudflare/workers-oauth-provider`, KV `OAUTH_KV`, jmenný prostor `oko1-oauth`): registrace klienta `/oauth/register`, přihlašovací stránka `/oauth/authorize`, tokeny `/oauth/token`, metadata `/.well-known/oauth-authorization-server` a `/.well-known/oauth-protected-resource/mcp`. Bez platného tokenu `/mcp` vrací 401.
- **Přihlášení:** stránka `/oauth/authorize` ukáže, kdo se připojuje a kam přístup půjde. Člověk zadá provozovnu (`james-dean`) a svoje číslo; kód v SMS přijde jen na číslo, které smí na dashboard (`dashboardPhones`, jinak první z `recipients`), jiné číslo i neznámá provozovna dostanou stejnou stránku a nic se nepošle. Stejná pravidla jako na dashboardu: kód platí 10 minut a jednou, nejvýš 5 kódů za hodinu a 10 za den, po 10 chybných kódech za hodinu se přihlášení zavře. Formulář přijímá jen odeslání ze stejného původu.
- **Platnost:** kód otevře stejnou relaci jako přihlášení na dashboard (30 dní). Grant OAuth nese provozovnu a tuto relaci; každý požadavek na `/mcp` i každé obnovení tokenu ověří, že relace žije. Přístupový token platí hodinu, obnovovací nejvýš 30 dní. `POST /admin/t/{tenant}/logout` nebo změna povolených čísel ukončí i všechna připojení MCP.
- **Jen čtení**, popisy nástrojů česky, odpovědi JSON. Částky v OKO1 (`…Cents`) jsou v haléřích; na webu je `castka` plateb v haléřích a `celkem_kc` dárkových karet v korunách.

| Nástroj | Co vrací |
|---|---|
| `trzby_dne(datum)` | tržba dne a vše, co ví ranní přehled (`Briefing`: plán, střediska, platby, slevy, storna, rozdíly v hotovosti, položky, počty rezervací) |
| `trzby_obdobi(od, do)` | tržba po dnech (pokladna, jinak report manažerů, jinak importovaná historie) a součet, nejvýš 400 dní |
| `ranni_prehled(datum)` | uložený text ranní zprávy se stavem, nebo náhled |
| `report_manazeru(datum)` | denní report manažerů a rozbor „Report dne“ |
| `kontrola_lahvi(datum)` | ranní kontroly lahví a manka od prahu |
| `ucty(datum)` | účty z pokladny (položky, platby, slevy, storna) |
| `web_rezervace(od, do, stav?, prostor?, limit?)` | rezervace živě se jmény, kontakty, poznámkami a stoly |
| `web_rezervace_detail(kod nebo id)` | jedna rezervace se stoly, zprávami a platbou stolu s lahví |
| `web_host(kontakt)` | host podle telefonu nebo e-mailu: databáze hostů, rezervace, nedorazení, černá listina, pozvánky |
| `web_navstevnost(od?)` | návštěvnost po dnech a kdo je teď na webu (bez `od` 30 dní) |
| `web_recenze(stav?, zdroj?, od?, do?, limit?)` | recenze TripAdvisor a Google (bez filtrů 90 dní) |
| `web_darkove_karty(od, do, stav?, limit?)` | objednávky dárkových karet |
| `web_platby_lahvi(od, do, limit?)` | platby stolu s lahví |
| `web_blokace_a_akce(od, do)` | blokace zasahující do období (se stoly) a akce (s kanály) |
| `web_prehled()` | nastavení a stav rezervací na webu |
| `web_tabulka(nazev, od?, do?, rovno?, limit?)` | obecné čtení tabulky z whitelistu |
| `den(datum)` | jeden provozní den dohromady: pokladna z OKO1, rezervace a návštěvnost z webu |

Bez `web.url` v configu nebo bez tokenu webu vrací nástroje `web_*` srozumitelné varování („Web není připojený: …“) a pokladní nástroje fungují. Výpadek webu = „Web teď nejde načíst: …“; `den` pak vrátí pokladní část a u webu varování.

### Připojení v Claudovi

- **Claude (web, desktop, mobil):** Nastavení → Konektory → Přidat vlastní konektor, adresa `https://oko1.rr7whdyyhf.workers.dev/mcp`, potvrdit Připojit. Otevře se stránka OKO1: provozovna `james-dean`, svoje číslo, kód z SMS. V organizaci (Team, Enterprise) přidává vlastní konektor vlastník nebo správce organizace a členové se pak jen přihlásí.
- **Claude Code:** `claude mcp add --transport http oko1 https://oko1.rr7whdyyhf.workers.dev/mcp`, pak v Claude Code `/mcp` a přihlásit se stejně.
- Po 30 dnech, po odhlášení všech nebo po změně povolených čísel je potřeba se připojit znovu.

## Dashboard

Karta „Web {provozovna}“ na `/d/{tenant}` se načte zvlášť přes `GET /d/{tenant}/web` (jen s přihlášením) a čte web živě při každém vykreslení: dnešní rezervace podle provozního dne provozovny (čas, jméno, osoby, prostor, stůl, stav, kontakt, poznámka; zrušené, odmítnuté a propadlé jen počtem), počet čekajících na potvrzení, návštěvnost dnes a včera (`navstevy`, `sAkci`) a recenze čekající na odpověď (`nova`, `ke_kontrole`, `pro_vedeni`). Každá hodnota jde přes `esc()`. Bez `web.url` karta není, bez spojení s webem ukáže „Web teď nejde načíst“.

## Správní API

`GET /admin/t/{tenant}/web` (Bearer `ADMIN_SECRET`, příkaz `npm run admin -- web <tenant>`): živě přečte jen seznam tabulek webu a vrátí `{url, secret, token, ok, tables, error}`. Token ani data hostů nevrací. Data hostů správní API nemá; čte je jen MCP a dashboard.

## Testy

Jednotkové (`test/web.test.ts`): validace `web` v configu (jen https a allowlist, bez cesty, portu a tokenu), název tajemství z provozovny, klient webu (stránkování s Bearer tokenem, filtry, zkrácení na limit, odmítnuté přesměrování, chyby bez výjimek). E2E (`test/worker.test.mjs`, Miniflare s falešným webem, který ověřuje token): `/mcp` bez tokenu 401, celý tok OAuth s kódem z SMS a PKCE, nástroje vrací živá data webu i pokladny, výpadek webu je varování, karta dashboardu ukáže jméno escapované, ranní zpráva ani export do R2 nic z webu neobsahují, odhlášení ukončí i MCP a žádný soubor Durable Objects, KV ani R2 neobsahuje nic z webu.
