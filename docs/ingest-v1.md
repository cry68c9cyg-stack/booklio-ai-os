# Příjem dat z pokladny · kontrakt v1

Pokladna (Pexeso, později i jiné) posílá AI OS uzavřené účty, uzávěrky hotovosti a ranní kontroly lahví; rezervační systém posílá rezervace. AI OS se k pokladně nikdy nepřipojuje; spojení vždy otevírá pokladna. Pokladna tak nemusí být vystavená do internetu.

## Spárování

1. Pokladna jednou vytvoří náhodný token (32 bajtů, 64 hex znaků) a `installationId` a trvale si je uloží mimo obchodní zálohy.
2. Správce zavolá `POST /admin/t/{tenant}/pair` s `{installationId, token}`. AI OS si uloží jen SHA-256 otisk tokenu.
3. Stejný požadavek je možné opakovat. Jiný token pro stejné `installationId` vrátí 409.

`tenant` je identifikátor provozovny (`[a-z0-9-]{3,64}`), např. `james-dean-praha`. Každá provozovna má vlastní oddělenou databázi.

## Odeslání dávky

`POST /v1/t/{tenant}/ingest`, hlavička `Authorization: Bearer <token>`, tělo nejvýše 1 MiB:

```json
{"batchId": "pos-1-000123", "installationId": "pos-installation-1", "records": [ ... nejvýše 500 záznamů ... ]}
```

- `batchId` (`[\w-]{8,128}`) dělá dávku idempotentní: stejná dávka znovu vrátí stejný výsledek, jiný obsah se stejným `batchId` vrátí 409. Po ztracené odpovědi tedy pokladna pošle přesně stejnou dávku znovu.
- Každý záznam má `id` a `version` (celé číslo od 1). Uloží se jen vyšší verze; změna účtu po uzavření (storno, oprava platby) = stejné `id`, vyšší `version`.
- Odpověď: `{"batchId", "accepted", "stale"}`.
- Neznámá pole se odmítají (400). Do AI OS nepatří jména ani kontakty hostů.
- Všechny částky jsou **celé haléře** (int), včetně DPH, v CZK.

### Účet (`bill`)

| Pole | Typ | Poznámka |
|---|---|---|
| `type` | `"bill"` | |
| `id`, `version` | string, int ≥ 1 | |
| `businessDate` | `YYYY-MM-DD` | provozní den podle pokladny (James Dean: končí v 6:00) |
| `closedAt` | ISO čas | |
| `registerId` | string | pokladna |
| `section` | string | středisko, např. `diner`, `bar`, `club` |
| `status` | `closed` \| `cancelled` | do tržby jde jen `closed` |
| `tableId`, `guests`, `waiterId`, `reservationId` | volitelné | `reservationId` z Booklio, až bude vazba |
| `totalCents` | int | zaplaceno celkem |
| `discountCents` | int ≥ 0 | |
| `items[]` | `{name, quantity, totalCents, productId?, category?, vatRate?}` | nejvýše 500; `vatRate` = sazba DPH produktu v celých procentech (12, 21) z pokladny, doplněno 13. 10. 2026 zpětně kompatibilně: bez ní OKO1 nespočítá tržbu bez DPH a výdělek po položkách |
| `payments[]` | `{method, amountCents}` | `cash`, `card`, `voucher`, `transfer`, …; nejvýše 20 |
| `voids[]` | `{name, amountCents, reason, afterPayment, approvedBy?}` | storna položek; `afterPayment: true` = storno po zaplacení |

### Uzávěrka hotovosti (`cash_closing`)

`{type: "cash_closing", id, version, businessDate, closedAt, registerId, expectedCents, countedCents}`

Ranní přehled čeká, až přijdou uzávěrky všech pokladen z konfigurace (`registers`).

### Ranní kontrola lahví (`bottle_check`)

Doplněno 9. 10. 2026 zpětně kompatibilně: nový typ záznamu, stávající `bill` a `cash_closing` se nemění. Starší verze AI OS tento typ odmítne (400 pro celou dávku), proto se AI OS musí nasadit dřív, než pokladna začne kontroly posílat.

`{type: "bottle_check", id, version, businessDate, countedAt, items: [...]}`

| Pole | Typ | Poznámka |
|---|---|---|
| `businessDate` | `YYYY-MM-DD` | provozní den, jehož spotřebu kontrola uzavírá: ranní kontrola v provozní den X má `businessDate` X−1, tedy den, o kterém je ranní přehled |
| `countedAt` | ISO čas | dokončení počítání |
| `items[]` | `{itemId, name, countedMl, expectedMl, costPerLitreCents}` | nejvýše 50, `itemId` se v jedné kontrole neopakuje |
| `itemId` | string | skladová položka pokladny (surovina), ne prodejní produkt |
| `countedMl`, `expectedMl` | int ≥ 0 | celé mililitry; `expectedMl` = očekávaný stav vypočtený pokladnou (poslední potvrzený stav + příjemky − prodej podle receptur) |
| `costPerLitreCents` | int ≥ 0 | nákupní cena za litr v haléřích ze skladové karty pokladny (bez rozlišení DPH, na rozdíl od tržeb) |

Očekávaný stav počítá pokladna, protože zná receptury, prodeje a příjemky; AI OS kontrolu jen ukládá a vykresluje. Opakované počítání téhož rána = nový záznam nebo vyšší `version`; ranní přehled použije kontrolu s nejpozdějším `countedAt`.

Manko lahve = `expectedMl − countedMl` (přebytky se s mankem nesčítají), v Kč `manko × costPerLitreCents / 1000`. Ranní přehled vypíše jen lahve s mankem od prahu `bottleCheck.minLossCents` v konfiguraci provozovny (výchozí 10 000 haléřů = 100 Kč), seřazené podle Kč, nejvýše pět řádků se ⚠. Je-li `bottleCheck` nastavené a kontrola za den chybí, přehled to uvede. Na kontrolu lahví přehled nečeká.

### Rezervace (`reservation`)

Doplněno 9. 10. 2026 zpětně kompatibilně, stejně jako kontrola lahví: AI OS se musí nasadit dřív, než rezervační systém začne rezervace posílat. Zdrojem je rezervační systém (Booklio), který se páruje jako samostatná instalace se svým `installationId` a tokenem.

`{type: "reservation", id, version, businessDate, startsAt, section, partySize, status, arrival?, source?, createdAt?, guest?}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id`, `version` | string, int ≥ 1 | `version` roste s každou změnou rezervace; smí to být čas poslední změny v ms (u rezervací bez horní meze 10¹²). Když je `version` ≥ 10¹² (čas v ms), OKO1 u zrušené rezervace bere tento čas jako čas zrušení: pozdní storna do 24 h před začátkem a výhled hostů, kterým storna po stejné chvíli zase ubírají |
| `businessDate` | `YYYY-MM-DD` | provozní den; noční klub v 0:30 patří k předchozímu dni |
| `startsAt` | ISO čas | začátek rezervace |
| `section` | string | středisko stejným klíčem jako u účtů (`diner`, `bar`, `club`) |
| `partySize` | int 1–1000 | počet osob |
| `status` | `pending` \| `confirmed` \| `declined` \| `expired` \| `cancelled` | čeká, potvrzená, odmítnutá, propadlá, zrušená (hostem i obsluhou) |
| `arrival` | `arrived` \| `no_show` \| `null` | zápis obsluhy, zda host dorazil |
| `source` | string \| `null` | odkud rezervace přišla, např. `web`, `obsluha`, `mcp` |
| `createdAt` | ISO čas, nepovinné | kdy rezervace vznikla (jak dlouho dopředu se rezervuje); doplněno 12. 10. 2026 zpětně kompatibilně. Rezervace poslaná dřív bez něj ho přijme jednou i se stejnou `version` |
| `guest` | objekt, nepovinné | údaje hosta, viz níže; doplněno 12. 10. 2026 zpětně kompatibilně |

Údaje hosta (`guest`, rozhodnutí MC 12. 10. 2026) jsou osobní údaje. OKO1 je drží jen ve své databázi provozovny v EU. Do archivu R2, denního exportu ani do ranní zprávy nejdou, ranní přehled dál ukazuje jen počty: potvrzené rezervace za vykazovaný den s počtem hostů a no-show, a potvrzené rezervace na právě začínající den po střediscích s počtem čekajících na potvrzení. Na rezervace přehled nečeká. Když rezervační systém rezervaci anonymizuje, pošle ji znovu s vyšší `version` a prázdnými údaji; OKO1 tím údaje přepíše.

`guest = {code?, name?, contactType?, contact?, milkshake?, wish?, note?, reason?, language?, origin?, tables?}`

| Pole | Typ | Poznámka |
|---|---|---|
| `code` | string ≤ 40 \| `null` | kód rezervace, který vidí host |
| `name` | string ≤ 200 \| `null` | jméno hosta |
| `contactType`, `contact` | `phone` \| `email` \| `null`, string ≤ 200 \| `null` | kontakt hosta |
| `milkshake`, `wish` | string \| `null` | volby a přání hosta z rezervace |
| `note`, `reason` | string ≤ 2000 \| `null` | poznámka obsluhy, důvod odmítnutí nebo zrušení |
| `language` | string ≤ 10 \| `null` | jazyk zpráv hostovi |
| `origin` | string ≤ 100 \| `null` | odkud host na web přišel (např. `qr`, `profil`) |
| `tables` | pole id stolů | přidělené stoly, např. `p3`, `kA` |

Prázdný řetězec znamená totéž co `null`. Neznámé pole v `guest` dávku odmítne.

> Poznámka (12. 10. 2026): OKO1 navíc čte všechna data webu James Dean živě pro MCP server a dashboard vedení a ta si neukládá ([docs/web-v1.md](web-v1.md)). Uložené údaje hostů jsou jen ty, které web pošle tímto kontraktem v poli `guest` (rozhodnutí MC 12. 10. 2026: živě i uložené).

### Návštěvnost webu (`web_traffic`)

Doplněno 12. 10. 2026 zpětně kompatibilně. Web posílá každou hodinu souhrn za včerejšek a dnešek (pražský kalendářní den 0:00–24:00, ne provozní den do 6:00); vyšší `version` (čas odeslání v ms) den přepíše. Jen součty, nic o jednotlivých návštěvnících ani hostech.

`{type: "web_traffic", id, version, businessDate, visits, visitsWithAction, origins, actions, reviewScans}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id` | string | `web-RRRR-MM-DD` |
| `visits` | int ≥ 0 | návštěvy webu za den |
| `visitsWithAction` | int ≥ 0 | návštěvy, které otevřely rezervaci, volaly nebo navigovaly |
| `origins` | pole ≤ 50 `{key, name, visits, withAction}` | odkud návštěvy přišly (skupiny webu, např. `google`, `instagram`, `qr`), `name` je český název |
| `actions` | objekt `{akce: počet}`, ≤ 100 klíčů | počet návštěv s danou akcí, např. `rezervace-otevrena`, `rezervace-odeslana`, `telefon` |
| `reviewScans` | int ≥ 0 | skeny QR kódu na stole s odkazem na hodnocení na Googlu |

Ranní zpráva ukáže den proti stejnému dni před týdnem, odeslané rezervace, skeny QR a tři nejčastější zdroje; dashboard totéž jako kartu „Návštěvnost webu“. Pondělní týdenní souhrn sečte `origins` za 7 dní (návštěvy a `withAction` podle `key`).

### Recenze (`review_summary`)

Doplněno 12. 10. 2026 zpětně kompatibilně. Web posílá každou hodinu souhrn recenzí, které ten den dorazily do adminu webu (Google, TripAdvisor; pražský kalendářní den podle příchodu do adminu), za včerejšek a dnešek; vyšší `version` (čas odeslání v ms) den přepíše. Jen počty: žádný autor, nadpis ani text recenze.

`{type: "review_summary", id, version, businessDate, sources, waiting, forManagement, failed}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id` | string | `reviews-RRRR-MM-DD` |
| `sources` | pole ≤ 10 `{key, name, stars, unrated}` | podle zdroje (`google`, `tripadvisor`); `stars` = přesně 5 počtů nových recenzí s 1 až 5 ★, `unrated` = nové bez hvězdiček |
| `waiting` | int ≥ 0 | recenze, které teď v adminu čekají na odpověď |
| `forManagement` | int ≥ 0 | recenze předané vedení |
| `failed` | int ≥ 0 | odpovědi, které se nepodařilo odeslat |

Ranní zpráva ukáže nové recenze, průměr hvězdiček, počet se 3 ★ a méně a co čeká v adminu (jen když je co hlásit); slabé recenze, recenze pro vedení a neodeslané odpovědi jdou do seznamu k vyřízení; dashboard má kartu „Recenze“. Týdenní a měsíční souhrn počítá průměr hvězdiček za týden a měsíc a hlásí pokles proti 4 týdnům předtím.

### Akce podniku (`event`)

Doplněno 12. 10. 2026 zpětně kompatibilně. Web posílá veřejné akce podniku z adminu (koncerty, večírky, přenosy): kdy, kde a veřejný název. Nic o hostech. Zrušená akce přijde znovu se `status: cancelled` a vyšší `version`.

`{type: "event", id, version, businessDate, startsAt, endsAt?, section, title, status}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id`, `version` | string, int ≥ 1 | `version` = čas poslední změny v ms |
| `businessDate` | `YYYY-MM-DD` | provozní den akce (noc v klubu patří ke dni, kdy začíná) |
| `startsAt`, `endsAt` | ISO čas, ISO čas \| `null` | začátek a konec |
| `section` | string | středisko (`diner`, `bar`, `club`), `all` = celý podnik |
| `title` | string ≤ 200 | veřejný název akce |
| `status` | `published` \| `cancelled` | zveřejněná, zrušená |

Ranní zpráva ukáže dnešní akce s počtem potvrzených hostů rezervovaných ten den v jejich prostoru; odhad tržby u dne s akcí použije, kolik dny s akcí za posledních 26 týdnů obvykle udělaly proti průměru svého dne v týdnu (medián, aspoň 4 dny, jen zvýšení 1–2×; s rezervacemi navíc platí větší z obou). Dashboard ukazuje akce v tabulce odhadu na 7 dní.

### Jídelní a nápojový lístek (`menu`)

Doplněno 12. 10. 2026 zpětně kompatibilně (rozhodnutí MC 12. 10. 2026: celý lístek z webu do OKO1 jako základ pro ceny, food cost, menu engineering, virtuální přeceňování a výdělek po položkách). Web posílá celý lístek, jak ho zveřejňuje (jídlo, koktejly, nápoje), vždy když se od posledního úspěšného odeslání změnil; OKO1 drží poslední lístek a každou jeho změnu (nová položka, zrušená položka, nová cena) s datem, takže zná cenu každé položky v kterýkoli den. Lístek je veřejný, nic o hostech. AI OS se musí nasadit dřív, než web začne lístek posílat.

`{type: "menu", id, version, businessDate, source, items, notes}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id` | string | lístek odesílatele, web posílá `menu-web` |
| `version` | int ≥ 1 | čas odeslání v ms; vyšší verze lístek celý nahradí |
| `businessDate` | `YYYY-MM-DD` | pražský den odeslání; k tomuto dni se zapíšou změny cen |
| `source` | string | odkud lístek je, např. `web` |
| `items[]` | ≤ 2000 položek, viz níže | `id` se v lístku neopakuje |
| `notes[]` | ≤ 100 `{part, category, text}` | poznámky lístku, např. „Alternativní mléko za příplatek 20 Kč.“; `text` ≤ 500 |

Položka `items[]`: `{id, part, category, name, pricesCents, group?, description?, volume?, volumeMl?, tip?}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id` | string `[\w.:-]{1,100}` | stálý klíč položky u odesílatele; jiné `id` = jiná položka |
| `part` | `food` \| `cocktails` \| `drinks` | část lístku: jídlo, koktejly, ostatní nápoje |
| `category` | string ≤ 100 | kategorie lístku, např. „Burgery“, „Destiláty“ |
| `group` | string ≤ 100 \| `null` | podskupina, např. „Gin“ v destilátech |
| `name` | string ≤ 200 | název položky |
| `description` | string ≤ 1000 \| `null` | popis (složení), podklad pro receptury |
| `volume`, `volumeMl` | string ≤ 40 \| `null`, int ≥ 1 \| `null` | objem, jak ho lístek píše („0,04 l“), a v celých ml |
| `pricesCents` | 1–5 × int ≥ 0 | ceny s DPH v haléřích, jak je lístek uvádí, základní první (burger „225 / 255 Kč“ = `[22500, 25500]`) |
| `tip` | bool | tip šéfkuchaře / doporučení |

Změnou ceny se rozumí jiná kterákoli z cen položky; OKO1 zapíše starou a novou základní cenu i oba texty („225 / 255 Kč“ → „225 / 265 Kč“). První lístek je výchozí stav, změny se počítají až od dalšího. Přejmenování položky, její kategorie nebo objemu je nové `id`, tedy zrušená a nová položka, ne změna ceny. Ceny jsou s DPH; sazbu DPH (jídlo a alkohol mají různou) lístek nenese, pro výdělek po položkách ji OKO1 vezme z produktu pokladny (Pexeso). Dashboard má kartu „Jídelní a nápojový lístek“ (položky po kategoriích s cenami od–do a průměrem, změny za 30 dní), MCP server nástroj `listek` (celý lístek a změny za rok).

Ceny a výdělek po položkách (13. 10. 2026, schválil MC): OKO1 páruje položky účtů pokladny s lístkem samo (stejný název bez diakritiky a objemu, u velikostí objem z názvu nebo nejbližší cena; jiný název jen tehdy, když jsou všechna slova jednoho názvu v druhém, sdílí aspoň 60 % slov a žádné jiné jídlo není blízko; jinak zůstane nespárovaný), takže pokladna nemusí znát id z webu. Z toho počítá prodej po položkách (kusy, tržba s DPH a podle `vatRate` bez DPH; tržba řádku je jeho podíl na zaplacené částce účtu `totalCents`, takže sleva na celý účet se rozpočítá na řádky poměrně, ať pokladna posílá řádky před slevou, nebo po ní) a zisk = tržba bez DPH − food cost za kus × kusy; food cost za kus doplní nákupní ceny a receptury, do té doby je zisk `null` a odpověď říká, co chybí. Kontrola cen hledá v kategoriích od 4 položek položky pod polovinou nebo nad dvojnásobkem běžné (prostřední) ceny kategorie, u nápojů různých objemů za litr, a od 5 položek mezery v cenové řadě (ne u nápojů porovnávaných za litr, tam jsou rozdíly cen dané objemem); položky zdarma se nepočítají; ke každé navrhne cenu. Virtuální přecenění jen počítá, na webu ani v pokladně nic nemění; položka zdarma zůstane zdarma a tržba po přecenění je odhad při stejném počtu kusů podle změny základní ceny. Dashboard má v kartě lístku „Ceny k prověření“ a „Prodej po položkách za 30 dní“ (s nespárovanými produkty pokladny), MCP server nástroje `preceneni`, `kontrola_cen` a `vydelek_polozek(od, do)`.

### Faktura dodavatele (`supplier_invoice`)

Doplněno 13. 10. 2026 zpětně kompatibilně (rozhodnutí MC 13. 10. 2026: Dishboard napojit jako provizorní zdroj, později ho nahradí jiný, nejspíš Pexeso). Faktury a účtenky dodavatelů: co podnik nakoupil, od koho a za kolik. Obchodní údaje, nic o hostech. Každý odesílatel se páruje jako samostatná instalace se svým tokenem a uvádí `source`; provozovna ho může vypnout v konfiguraci (`disabledSources`, např. `["dishboard"]`): data zůstanou uložená, ale OKO1 je nikde nepočítá. AI OS se musí nasadit dřív, než odesílatel začne faktury posílat.

`{type: "supplier_invoice", id, version, businessDate, source, supplier, netCents, grossCents, kind, items, supplierId?, number?, dueDate?, paidDate?, status?, category?}`

| Pole | Typ | Poznámka |
|---|---|---|
| `id`, `version` | string, int ≥ 1 | stálý klíč faktury u odesílatele; vyšší `version` (třeba čas změny v ms) fakturu celou nahradí |
| `businessDate` | `YYYY-MM-DD` | den vystavení (u účtenky den nákupu) |
| `source` | string | odesílatel, např. `dishboard` |
| `supplier`, `supplierId` | string ≤ 200, string \| `null` | dodavatel a jeho IČO |
| `number` | string ≤ 60 \| `null` | číslo faktury |
| `dueDate`, `paidDate` | `YYYY-MM-DD` \| `null` | splatnost a den zaplacení; nezaplacená po splatnosti jde do seznamu k vyřízení |
| `status` | `active` \| `cancelled` | výchozí `active`; zrušená (dobropis celé faktury, duplicita) se nepočítá |
| `netCents`, `grossCents` | int | celkem bez DPH a s DPH v haléřích (dobropis záporně) |
| `kind` | `food` \| `beverage` \| `other` | k čemu nákup je: jídlo, nápoje (obojí tvoří food cost), ostatní |
| `category` | string ≤ 100 \| `null` | kategorie odesílatele, např. „Maso“ |
| `items[]` | ≤ 500 `{name, quantity, unitPriceCents, netCents, unit?, kind?, category?}` | položky faktury; prázdné pole, když odesílatel položky nezná |

Položka: `name` ≤ 200, `quantity` > 0 (může být desetinné), `unit` ≤ 20 (`ks`, `kg`, `l`…), `unitPriceCents` = cena bez DPH za jednotku v haléřích, `netCents` = řádek bez DPH, `kind` a `category` jen když se liší od faktury. Část faktury, kterou položky nepokryjí (doprava, zaokrouhlení), připadne druhu a kategorii faktury.

OKO1 z faktur počítá:
- **nákupy** za měsíc do vykazovaného dne bez DPH po druzích, kategoriích a dodavatelích a **food cost** = jídlo a nápoje bez DPH k tržbám s DPH týchž dní (tržby bez DPH OKO1 nezná, protože jídlo a nápoje mají různé sazby);
- **zdražení**: položka stejného dodavatele se stejným názvem (bez ohledu na velikost písmen a mezery) a jednotkou, jejíž cena za jednotku je o 5 % a víc nad předchozím nákupem; levnější další nákup zdražení ruší. Ranní zpráva a seznam k vyřízení berou 7 dní do vykazovaného dne, dashboard 30 dní, porovnává se s nákupy za rok;
- **faktury po splatnosti**: nezaplacené, splatnost před dnem, který začíná po vykazovaném.

Ranní zpráva má řádek nákupů s food costem, nejvýš tři nejdražší zdražení a souhrn faktur po splatnosti; seznam k vyřízení každé zdražení (váha = o kolik víc nákup stál) a každou fakturu po splatnosti; dashboard kartu „Náklady a dodavatelé“; MCP server nástroj `naklady_dodavatele(od, do)`.

## Kdy posílat

Po uzavření každého účtu nebo v intervalu 5–15 minut, a vždy hned po uzávěrce a po dokončení kontroly lahví. Neodeslané dávky drží pokladna ve své frontě a posílá je s opakováním.
