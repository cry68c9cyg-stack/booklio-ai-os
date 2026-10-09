# Příjem dat z pokladny · kontrakt v1

Pokladna (Pexeso, později i jiné) posílá AI OS uzavřené účty a uzávěrky hotovosti. AI OS se k pokladně nikdy nepřipojuje; spojení vždy otevírá pokladna. Pokladna tak nemusí být vystavená do internetu.

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
| `items[]` | `{name, quantity, totalCents, productId?, category?}` | nejvýše 500 |
| `payments[]` | `{method, amountCents}` | `cash`, `card`, `voucher`, `transfer`, …; nejvýše 20 |
| `voids[]` | `{name, amountCents, reason, afterPayment, approvedBy?}` | storna položek; `afterPayment: true` = storno po zaplacení |

### Uzávěrka hotovosti (`cash_closing`)

`{type: "cash_closing", id, version, businessDate, closedAt, registerId, expectedCents, countedCents}`

Ranní přehled čeká, až přijdou uzávěrky všech pokladen z konfigurace (`registers`).

## Kdy posílat

Po uzavření každého účtu nebo v intervalu 5–15 minut, a vždy hned po uzávěrce. Neodeslané dávky drží pokladna ve své frontě a posílá je s opakováním.
