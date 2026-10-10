import assert from 'node:assert/strict';
import {test} from 'node:test';
import {CsvError, parseCrowns, parseHistoryCsv} from '../src/history-csv.ts';

test('amounts in Czech and English formats become haléře', () => {
  assert.equal(parseCrowns('84 320,50'), 8432050);
  assert.equal(parseCrowns('84320.5'), 8432050);
  assert.equal(parseCrowns('84.320,50 Kč'), 8432050);
  assert.equal(parseCrowns('84,320.50'), 8432050);
  assert.equal(parseCrowns('abc'), null);
});

test('Czech semicolon export with one row per register is summed per day', () => {
  const csv = '﻿Datum;Pokladna;Tržba;Účty;Hosté\n1.10.2026;Bar;"12 000,00";40;80\n01.10.2026;Klub;8 000;20;\n2026-10-02;Bar;5000,5;10;30\n';
  assert.deepEqual(parseHistoryCsv(csv), [
    {businessDate: '2026-10-01', revenueCents: 2000000, bills: 60, guests: null},
    {businessDate: '2026-10-02', revenueCents: 500050, bills: 10, guests: 30},
  ]);
});

test('comma separated export with English headers', () => {
  assert.deepEqual(parseHistoryCsv('date,revenue\n2026-09-30,1000\n'), [{businessDate: '2026-09-30', revenueCents: 100000, bills: null, guests: null}]);
});

test('errors name the row and the problem', () => {
  assert.throws(() => parseHistoryCsv('Datum;Pokladna\n1.10.2026;Bar'), CsvError);
  assert.throws(() => parseHistoryCsv('Datum;Tržba\n32.13.2026;100'), /Řádek 2/);
  assert.throws(() => parseHistoryCsv('Datum;Tržba\n1.10.2026;sto'), /neplatná tržba/);
});
