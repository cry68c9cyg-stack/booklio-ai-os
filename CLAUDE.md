# Booklio AI OS – pravidla pro práci v repozitáři

- Dokumentace, texty pro uživatele a commity česky; kód a identifikátory anglicky.
- Částky vždy jako celé haléře (int). Datum provozního dne je `YYYY-MM-DD` v časové zóně provozovny.
- Každá provozovna = vlastní Durable Object; žádná data se mezi provozovnami nesdílí.
- Žádná tajemství, exporty ani data hostů v Gitu. Testy jen se syntetickými daty.
- Data hostů (jména, kontakty, poznámky, texty zpráv a recenzí) z webu James Dean smí OKO1 jen živě číst ve chvíli dotazu a předat v odpovědi MCP nebo na dashboard vedení (`docs/web-v1.md`). To, co OKO1 čte živě, nikdy neukládat do SQLite, R2, KV ani logů. Uložit se smí jen údaje hosta, které web pošle u rezervace v poli `guest` kontraktu ingest v1 (rozhodnutí MC 12. 10. 2026: „živě, a zároveň si je i ukládalo“), a to jen do SQLite provozovny, nikdy do R2, exportu ani logů. Data hostů nikdy nedávat do ranní zprávy, SMS a WhatsAppu a neposílat do LLM, které si OKO1 samo volá (Report dne jen po pseudonymizaci). Nový zásah do architektury, schválil MC 12. 10. 2026; každé další použití dat hostů je nová změna ke schválení.
- Před PR: `npm test`, `npm run check`, `npm run build`.
- Změna kontraktu příjmu dat = aktualizovat `docs/ingest-v1.md` (nebo nová verze `v2`, pokud není zpětně kompatibilní).
- Vlastník produktu (MC) schvaluje každou změnu přes PR.
