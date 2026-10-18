import assert from 'node:assert/strict';
import {test} from 'node:test';
import {carriedTodos, parseStaff, renderTodoWeek, todoMail, todoWeek, type StoredTodo} from '../src/tasks.ts';

const row = (date: string, key: string, text: string, amountCents: number | null, owner = 'Matěj', level: 'warn' | 'info' = 'warn'): StoredTodo => ({date, key, level, text, amountCents, owner});

test('Úkoly lidem: open warnings carry over with their first day, by money; state signals, done and today\'s ones do not', () => {
  const stored = [
    row('2026-10-14', 'a', 'Rozdíl v hotovosti bar: −2 000 Kč', -200000),
    row('2026-10-15', 'a', 'Rozdíl v hotovosti bar: −2 000 Kč', -200000),
    row('2026-10-15', 'b', 'Faktura po splatnosti: Maso 40 000 Kč', 4000000, 'Nancy'),
    row('2026-10-16', 'c', 'Report za den chybí.', null),
    row('2026-10-16', 'd', 'Storna po zaplacení: 1× 500 Kč', 50000),
    row('2026-10-16', 'e', 'Zaplatit: Pivovar', 9000000, 'Nancy', 'info'),
    row('2026-10-16', 'f', 'Manko Jameson: −100 ml (300 Kč)', 30000),
    row('2026-10-01', 'g', 'Staré', 100),
  ];
  const carried = carriedTodos('2026-10-17', stored, key => key === 'd', new Set(['f']));
  assert.deepEqual(carried.map(item => [item.key, item.since, item.owner]), [['b', '2026-10-15', 'Nancy'], ['a', '2026-10-14', 'Matěj']]);
});

test('Úkoly lidem: addresses per person, the e-mail and the Monday line', () => {
  const staff = parseStaff('Matěj=matej@jamesdean.cz; Nancy = nancy@jamesdean.cz, spatne\nManažeři=manazer@jamesdean.cz', address => /^[^@\s]+@[^@\s]+\.[a-z]+$/.test(address));
  assert.deepEqual([...staff], [['matěj', ['matej@jamesdean.cz']], ['nancy', ['nancy@jamesdean.cz']], ['manažeři', ['manazer@jamesdean.cz']]]);
  const mail = todoMail('Nancy', '2026-10-18', 'James Dean', [{level: 'warn', text: 'Faktura po splatnosti: Maso', amountCents: 4000000}],
    [{level: 'warn', text: 'Zdražení: limety', amountCents: 2000, key: 'x', since: '2026-10-14'}], {owner: 'Nancy', done: 4, hanging: 1}, 'https://oko1.example/d/test');
  assert.equal(mail.subject, 'K vyřízení 18. 10.: 2 body – Nancy');
  assert.match(mail.text, /1\. ⚠ Faktura po splatnosti: Maso\n\nVisí z předchozích dnů:\n2\. ⚠ Zdražení: limety \(od 14\. 10\.\)/);
  assert.match(mail.text, /Za týden vyřízeno 4, déle než 3 dny visí 1\./);
  assert.match(mail.text, /„Vyřízeno“: https:\/\/oko1\.example\/d\/test/);
  const week = todoWeek('2026-10-18', [row('2026-10-15', 'a', 'x', 1), row('2026-10-15', 'b', 'y', 1, 'Nancy')],
    [{date: '2026-10-16', key: 'a'}, {date: '2026-10-17', key: 'a'}, {date: '2026-10-17', key: 'b'}, {date: '2026-10-01', key: 'b'}],
    [{level: 'warn', text: 'z', amountCents: null, owner: 'Nancy', key: 'z', since: '2026-10-13'}]);
  assert.deepEqual(week, [{owner: 'Matěj', done: 1, hanging: 0}, {owner: 'Nancy', done: 1, hanging: 1}]);
  assert.deepEqual(renderTodoWeek(week), ['Úkoly za týden: Matěj 1 vyřízeno · Nancy 1 vyřízeno, 1 visí přes 3 dny']);
});
