# Booklio AI OS

Samostatná služba, která čte data z pokladny (Pexeso) a rezervačního systému (Booklio) a dělá z nich provozní přehledy pro majitele. Je navržená pro více podniků: každá provozovna (`tenant`) má vlastní oddělenou databázi.

## Co umí teď (milník 1)

- **Příjem dat z pokladny**: uzavřené účty a uzávěrky hotovosti, viz [kontrakt v1](docs/ingest-v1.md). Pokladna se připojuje sama, nemusí být vystavená do internetu.
- **Ranní přehled tržeb** za včerejší provozní den: tržba, plán, střediska, účty, hosté, průměrný účet, platby, slevy, storna (zvlášť storna po zaplacení), rozdíly v hotovosti a nejprodávanější položky.
- **Pravidlo odeslání**: v 7:00, když jsou uzávěrky všech pokladen; jinak znovu v 8:00 a 9:00; v 10:00 odejde vždy, s upozorněním „Uzávěrka chybí“. Za jeden den nikdy dvakrát.
- **Plán** = průměr stejného dne v týdnu za předchozí 4 týdny (min. 2 dny dat). Starší dny lze doplnit jednorázovým importem denních tržeb (např. export z rkeeperu).
- **Ranní kontrola lahví**: pokladna pošle spočítaný a očekávaný stav sledovaných lahví (`bottle_check`, viz kontrakt). Přehled vypíše jen lahve s mankem od prahu `bottleCheck.minLossCents` (výchozí 100 Kč), seřazené podle Kč se ⚠; s nastaveným `bottleCheck` upozorní, když kontrola chybí.

- **Odeslání SMS přes Twilio** na čísla v `recipients`. Bez nastaveného Twilia se přehled jen uloží a je k dispozici přes správní API. Nepovedené odeslání se zkusí znovu v další celou hodinu. Nastavení: `TWILIO_ACCOUNT_SID` a `TWILIO_FROM` jako proměnné, `TWILIO_AUTH_TOKEN` jako Cloudflare secret (lokálně v `.dev.vars`).

WhatsApp zatím napojený není. Nic není nasazené.

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

Příklad konfigurace James Dean:

```json
{"name": "James Dean", "timeZone": "Europe/Prague", "businessDayCutoffHour": 6, "sendHours": [7, 8, 9, 10],
 "registers": ["bar", "klub"], "sections": {"diner": "Diner", "bar": "Bar", "club": "Klub"}, "recipients": [],
 "bottleCheck": {"minLossCents": 10000}}
```

## Vývoj

Node 22.18 nebo novější.

```sh
npm ci
npm test        # jednotkové testy + end-to-end na skutečném workerd (Miniflare), jen syntetická data
npm run check   # TypeScript
npm run build   # wrangler deploy --dry-run, nic nenasazuje
```

Technika: Cloudflare Worker, jeden SQLite Durable Object na provozovnu, hodinový cron. Stejný vzor jako cloudové rezervace v Pexesu (větev `feat/t10-online-reservations`).

## Bezpečnost

- Do repozitáře nepatří tajemství, `.dev.vars`, exporty z pokladny ani data hostů.
- `ADMIN_SECRET` patří do Cloudflare secret, lokálně do ignorovaného `.dev.vars`.
- Tokeny pokladen se ukládají jen jako SHA-256 otisk.
- Výchozí konfigurace vypíná `workers.dev` i preview URL. Před nasazením je potřeba Cloudflare účet, doména a umístění dat v EU.
