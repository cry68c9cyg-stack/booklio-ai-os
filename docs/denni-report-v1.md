# Denní report manažerů · v1

Přechodný zdroj dat, než poběží Pexeso (specifikace OKO1 §4). Manažeři dál vyplňují svoje excely na OneDrive. OKO1 si je čte samo, nikdo nic neposílá. Po spuštění Pexesa se tento zdroj vypne a stejné údaje přijdou z pokladny ([kontrakt v1](ingest-v1.md)).

## Odkud a kdy

- **Složka na OneDrive** sdílená odkazem „kdokoli s odkazem může zobrazit“. Odkaz je jediné oprávnění OKO1 a umí jen číst. Do Gitu nepatří: je v tajemství repozitáře `ONEDRIVE_REPORTS_LINK` a nasazení ho vloží do nastavení provozovny James Dean jako `reportsLink`. Povolené jsou jen odkazy `https://` na `1drv.ms`, `onedrive.live.com` a `*.sharepoint.com`.
- **Kdy:** jen v hodinách ranní zprávy, tedy 7:00, 8:00 a 9:00 (pravidlo MC z 10. 10. 2026), a jen dokud report za den nemá. V 9:00 odejde zpráva vždy, případně s upozorněním „Report chybí“.
- **Které soubory:** denní report je sešit s datem dne v názvu (např. `Denní report 9.10.2026.xlsx`, `09_10_26`). Peněžní deník je sešit, jehož název obsahuje „deník“, a OKO1 z něj bere jen sloupec daného dne; je-li deníků víc (např. po měsících), stáhne tři nejnovější a použije ten, který sloupec dne má. Za hotový report se počítá jen report s tržbami po částech: samotný deník nestačí a OKO1 to zkusí znovu v další hodině. Prohledá kořen složky a nejvýš pět podsložek, od nejnovější. Soubory nad 10 MB a dočasné soubory Excelu (`~$…`) se přeskočí. Odkaz na jediný sešit se čte celý.
- **Archiv:** stažené soubory se beze změny uloží do R2 v EU (`t/{tenant}/onedrive/{datum}/{soubor}`).

**Neověřeno na skutečném odkazu.** Čtení bez přihlášení přes `api.onedrive.com` funguje u osobního OneDrive; firemní OneDrive (SharePoint, `*.sharepoint.com`) ho obvykle nepustí. Pak OKO1 uloží upozornění „sdílený odkaz nejde otevřít bez přihlášení“ a náhradní cestu zařídí Claude bez práce MC. Ověří se hned s odkazem od Matěje.

Bezpečnost: OKO1 stahuje jen z adres Microsoftu (`1drv.ms`, `*.1drv.com`, `*.onedrive.com`, `onedrive.live.com`, `*.live.net`, `*.sharepoint.com`), přesměrování kontroluje znovu, každý požadavek má limit 15 s a soubor nejvýš 10 MB (rozbalený sešit nejvýš 40 MB). Čtení a rozbor mají dohromady nejvýš 60 s, takže pomalý OneDrive ani API nikdy nezastaví odeslání zprávy v 9:00.

## Co se čte

Podle popisků v řádcích. Popisky jsou převzaté z fotek reportu z 9. 10. 2026 a **ověří se na zkušebních souborech od Matěje**. Řádky s částkou, které pravidla nepoznají, se uloží jako `unmapped`. Omezení do ověření: z řádku se čte jen první popisek (bloky vedle sebe v jednom řádku se zatím nerozliší) a známý popisek zopakovaný na dalším listu se počítá jednou.

| Druh řádku (`kind`) | Odkud | Popisek v Excelu → klíč (`key`) |
|---|---|---|
| `revenue_section` | denní report | Restaurace den → `diner`, Restaurace noc → `bar`, Club celkem → `club` (specifikace §3) |
| `revenue_register` | denní report | Pokladna 1–3 → `club-1` až `club-3`, Texaco → `texaco` |
| `payment` | denní report | Hotovost → `cash`, Karty → `card`, Zákaznické karty → `customer_card` |
| `discount` | denní report | Odpisy…, Promo…, Personál, Sleva N %, MŽ, IG, Cosmo…: počet a Kč |
| `void` | denní report | Storno: počet a Kč |
| `total` | oba | Celkem podle výjezdů → `payments`; „Celkem“ v bloku „Slevy a odpisy“ → `discounts`; řádky pod TOTAL v deníku |
| `balance` | deník | Banka → `bank`, Trezor → `safe`, Pokladna → `register` |
| `movement` | deník | Vklad…, Odvod…, Záloha…, Karty (odečet karet v bloku Náklady, nejsou to výdaje z hotovosti), záporné řádky v bloku Náklady |
| `expense` | deník | kladné řádky pod hlavičkou „Náklady“ (název nákupu a částka) |
| `payout` | deník | řádky pod hlavičkou „Výplaty“ (role a částka) |
| `cash_count` | deník | přepočet hotovosti od řádku „Euro“: měny, kov, dluhy, obálky |

Text řádku „Report dne“ (také „Poznámky“, „Události“) a jméno DJ tvoří volný text `notes`.

## Uložení

Částky v celých haléřích. Report za den nahrazuje předchozí verzi téhož dne.

```json
{"businessDate": "2026-10-09", "source": "onedrive", "files": ["Denní report 9.10.2026.xlsx"],
 "lines": [{"kind": "revenue_section", "key": "bar", "label": "Restaurace noc", "count": null, "amountCents": 15000000}],
 "notes": "…", "warnings": []}
```

Stejný tvar přijímá `PUT /admin/t/{tenant}/report` (oprava dne, import historie). Neznámá pole se odmítnou (400).

## Ranní zpráva z reportu

Dokud nejsou účty z pokladny, je zdrojem tržby report: tržba a plán, části, podíl plateb, slevy celkem a tři největší položky slev, výdaje z kasy a výplaty v hotovosti, záporný trezor se ⚠ a body z „Report dne“. Jakmile přijdou účty z pokladny, mají přednost.

## „Report dne“

S klíčem `ANTHROPIC_API_KEY` (vlastní klíč OKO1) pošle OKO1 text Claudovi a dostane zpět shrnutí a nejvýš deset bodů: incident, problém, úkol, informace. Před odesláním nahradí jména (slova s velkým písmenem mimo seznam běžných slov), telefony (devět číslic, i s +420) a e-maily značkami `[X1]`, `[telefon]`, `[e-mail]`. Jména se vrátí jen do výsledku uloženého v OKO1. Jména napsaná malým písmenem (přezdívky) se nepoznají; patří to do posouzení DPIA (specifikace §9). Úspěšný rozbor se dělá jednou, změněný text znovu, nepovedený se zkusí v další hodině ranního okna. Do té doby, bez klíče nebo při chybě jde do zprávy zkrácený původní text.
