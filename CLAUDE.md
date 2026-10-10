# Booklio AI OS – pravidla pro práci v repozitáři

- Dokumentace, texty pro uživatele a commity česky; kód a identifikátory anglicky.
- Částky vždy jako celé haléře (int). Datum provozního dne je `YYYY-MM-DD` v časové zóně provozovny.
- Každá provozovna = vlastní Durable Object; žádná data se mezi provozovnami nesdílí.
- Žádná tajemství, exporty ani data hostů v Gitu. Testy jen se syntetickými daty.
- Před PR: `npm test`, `npm run check`, `npm run build`.
- Změna kontraktu příjmu dat = aktualizovat `docs/ingest-v1.md` (nebo nová verze `v2`, pokud není zpětně kompatibilní).
- Vlastník produktu (MC) schvaluje každou změnu přes PR.
