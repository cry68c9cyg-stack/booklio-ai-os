# Booklio AI OS – pravidla pro práci v repozitáři

- Dokumentace, texty pro uživatele a commity česky; kód a identifikátory anglicky.
- Částky vždy jako celé haléře (int). Datum provozního dne je `YYYY-MM-DD` v časové zóně provozovny.
- Každá provozovna = vlastní Durable Object; žádná data se mezi provozovnami nesdílí.
- Žádná tajemství, exporty ani data hostů v Gitu. Testy jen se syntetickými daty.
- Data hostů Data hostů (jména, kontakty, jazyk, původ, poznámky, historie rezervací) má OKO1 kompletně v databázi provozovny a smí je použít pro jakékoli statistiky, kombinace dotazů, dotazy vedení přes MCP, dashboard i černé listiny - ne do Gitu, veřejných logů, exportů ani R2.
- Před PR: `npm test`, `npm run check`, `npm run build`.
- Změna kontraktu příjmu dat = aktualizovat `docs/ingest-v1.md` (nebo nová verze `v2`, pokud není zpětně kompatibilní).
- Vlastník produktu (MC) schvaluje každou změnu přes PR.

## Working preferences

- Po dokončení každé úlohy (nasazeno, hotovo) hned sám navrhni MC další balík několika konkrétních bodů a čekej jen na jeho „jo“; nečekej, až se zeptá „co dál“ (MC, 13. 10. 2026).
