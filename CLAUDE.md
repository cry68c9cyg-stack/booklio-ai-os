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

- Každá zpráva MC, ve které nečekáš na jeho rozhodnutí (nasazeno, hotovo, odesláno, čekáme na někoho třetího), končí konkrétním návrhem další dávky několika bodů a otázkou „jo?“; nikdy nečekej, až se zeptá „co dál“ (MC, 13. 10. 2026).
- Každé nové pravidlo od MC zapiš přes skill Task Observer sem do „Working preferences“ (a do paměti projektu) (MC, 13. 10. 2026).
- U každých stažených tabulek projdi všechny záložky všech sešitů, zkontroluj, že čísla mezi soubory sedí (report × deník × Bilance × Graf, výčetka × zůstatek, součty × řádky), a nálezy dej MC jako problém a řešení (MC, 18. 10. 2026).
- Když chybí denní report manažerů, pošli vždy důležitý e-mail (vysoká priorita) na info@jamesdean.cz: chybí report, doplnit (MC, 19. 10. 2026).
