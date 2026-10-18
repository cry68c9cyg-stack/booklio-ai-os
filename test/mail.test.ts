import assert from 'node:assert/strict';
import {test} from 'node:test';
import {folderLabel, ImapReader, imapDate, parseList, quoted, sentFolder} from '../src/imap.ts';
import {asSupplierInvoice, invoiceAttachments, isdocXml, issuedByVenue, looksLikeInvoice, mailInvoiceId, parseExtraction, parseIsdoc, withKinds} from '../src/mail-invoices.ts';
import {decodeWords, parseAddresses, parseMail} from '../src/mime.ts';
import {overdueInvoices, renderSupplies, type SupplyBrief} from '../src/supplies.ts';
import type {SupplierInvoice} from '../src/validate.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64');

// Synthetic message: a fictitious supplier, a QP text part and a PDF attachment with an RFC 2231 file name.
const message = [
  'From: =?utf-8?B?' + b64('Zelenina Testová s.r.o.') + '?= <fakturace@example.cz>',
  'To: Podnik <info@example.cz>, druhy@example.cz',
  'Subject: =?iso-8859-2?Q?Faktura_=E8._2026001?=',
  'Date: Mon, 12 Oct 2026 09:15:00 +0200',
  'Message-ID: <abc@example.cz>',
  'MIME-Version: 1.0',
  'Content-Type: multipart/mixed; boundary="vnejsi"',
  '',
  '--vnejsi',
  'Content-Type: multipart/alternative; boundary="vnitrni"',
  '',
  '--vnitrni',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Dobr=C3=BD den, v p=C5=99=C3=ADloze fakturu.=',
  ' Hezk=C3=BD den',
  '--vnitrni',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>HTML verze</p>',
  '--vnitrni--',
  '--vnejsi',
  'Content-Type: application/pdf',
  "Content-Disposition: attachment; filename*=utf-8''faktura%20%C4%8D.pdf",
  'Content-Transfer-Encoding: base64',
  '',
  b64('%PDF-1.4 testovaci obsah'),
  '--vnejsi--',
  '',
].join('\r\n');

test('a MIME message is read: encoded headers, nested parts, QP text and an RFC 2231 attachment', () => {
  const mail = parseMail(bytes(message));
  assert.equal(mail.subject, 'Faktura č. 2026001');
  assert.deepEqual(mail.from, {name: 'Zelenina Testová s.r.o.', address: 'fakturace@example.cz'});
  assert.deepEqual(mail.to.map(to => to.address), ['info@example.cz', 'druhy@example.cz']);
  assert.equal(mail.date, '2026-10-12T07:15:00.000Z');
  assert.equal(mail.messageId, '<abc@example.cz>');
  assert.equal(mail.text, 'Dobrý den, v příloze fakturu. Hezký den');
  assert.equal(mail.attachments.length, 1);
  assert.equal(mail.attachments[0].filename, 'faktura č.pdf');
  assert.equal(new TextDecoder().decode(mail.attachments[0].data), '%PDF-1.4 testovaci obsah');
  assert.equal(invoiceAttachments(mail).pdf.length, 1);
  assert.ok(looksLikeInvoice(mail, mail.attachments[0]));
  assert.ok(!looksLikeInvoice({...mail, subject: 'Rezervace na sobotu', text: 'Posílám menu'}, {...mail.attachments[0], filename: 'menu.pdf'}));
});

test('header words and addresses', () => {
  assert.equal(decodeWords('=?utf-8?Q?P=C5=99=C3=ADjem?= =?utf-8?Q?_faktur?='), 'Příjem faktur');
  assert.deepEqual(parseAddresses('"Novák, Jan" <JAN@example.cz>, neplatna, b@example.cz'), [{name: 'Novák, Jan', address: 'jan@example.cz'}, {name: null, address: 'b@example.cz'}]);
});

test('IMAP responses with literals split across chunks are read whole', async () => {
  const chunks = ['* OK ready\r\n* 1 FETCH (UID 7 BODY[] {5}\r\nab', 'cde)\r\nK1 OK done\r\n'].map(bytes);
  const reader = new ImapReader(async () => chunks.shift() ?? null);
  assert.equal((await reader.response()).text, '* OK ready');
  const fetch = await reader.response();
  assert.equal(fetch.text, '* 1 FETCH (UID 7 BODY[] {5})');
  assert.equal(new TextDecoder().decode(fetch.literals[0]), 'abcde');
  assert.equal((await reader.response()).text, 'K1 OK done');
  await assert.rejects(reader.response());
});

test('IMAP helpers: quoting, dates, folders and the sent folder', () => {
  assert.equal(quoted('a"b\\c'), '"a\\"b\\\\c"');
  assert.throws(() => quoted('a\r\nK2 DELETE x'));
  assert.equal(imapDate('2026-04-01'), '1-Apr-2026');
  const folders = parseList([{text: '* LIST (\\HasNoChildren) "." INBOX', literals: []}, {text: '* LIST (\\HasNoChildren \\Sent) "." "INBOX.Odeslaná pošta"', literals: []}]);
  assert.deepEqual(folders.map(folder => folder.name), ['INBOX', 'INBOX.Odeslaná pošta']);
  assert.equal(sentFolder(folders), 'INBOX.Odeslaná pošta');
  assert.equal(sentFolder([{name: 'Sent', flags: []}]), 'Sent');
  assert.equal(sentFolder([{name: 'INBOX', flags: []}]), null);
  assert.equal(folderLabel('INBOX.Ko&AWE-'), 'INBOX.Koš');
  assert.equal(sentFolder([{name: 'INBOX.Odeslan&AOE- po&AWE-ta', flags: []}]), 'INBOX.Odeslan&AOE- po&AWE-ta');
  assert.equal(folderLabel('A&-B'), 'A&B');
});

const isdoc = `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="http://isdoc.cz/namespace/2013" version="6.0.2">
  <DocumentType>1</DocumentType><ID>FV-2026/0042</ID><IssueDate>2026-10-05</IssueDate>
  <AccountingSupplierParty><Party><PartyIdentification><ID>12345678</ID></PartyIdentification><PartyName><Name>Nápoje Testovací a.s.</Name></PartyName></Party></AccountingSupplierParty>
  <InvoiceLines>
    <InvoiceLine><ID>1</ID><InvoicedQuantity unitCode="KS">10</InvoicedQuantity><LineExtensionAmount>1000.00</LineExtensionAmount><UnitPrice>100.00</UnitPrice><Item><Description>Tonic 0,2 l</Description></Item></InvoiceLine>
    <InvoiceLine><ID>2</ID><InvoicedQuantity unitCode="KG">2</InvoicedQuantity><LineExtensionAmount>500.50</LineExtensionAmount><Item><Description>Citrony &amp; limetky</Description></Item></InvoiceLine>
  </InvoiceLines>
  <LegalMonetaryTotal><TaxExclusiveAmount>1500.50</TaxExclusiveAmount><TaxInclusiveAmount>1815.61</TaxInclusiveAmount></LegalMonetaryTotal>
  <PaymentMeans><Payment><Details><PaymentDueDate>2026-10-19</PaymentDueDate></Details></Payment></PaymentMeans>
</Invoice>`;

test('ISDOC is read exactly; an advance invoice is not a cost', async () => {
  const xml = await isdocXml({filename: 'f.isdoc', contentType: 'application/xml', data: bytes(isdoc)});
  const invoice = parseIsdoc(xml!)!;
  assert.equal(invoice.supplier, 'Nápoje Testovací a.s.');
  assert.equal(invoice.supplierId, '12345678');
  assert.equal(invoice.number, 'FV-2026/0042');
  assert.equal(invoice.dueDate, '2026-10-19');
  assert.equal(invoice.netCents, 150050);
  assert.equal(invoice.grossCents, 181561);
  assert.deepEqual(invoice.items.map(item => [item.name, item.quantity, item.unit, item.unitPriceCents, item.netCents]),
    [['Tonic 0,2 l', 10, 'ks', 10000, 100000], ['Citrony & limetky', 2, 'kg', 25025, 50050]]);
  assert.equal(parseIsdoc(isdoc.replace('<DocumentType>1<', '<DocumentType>4<')), null);
  const credit = parseIsdoc(isdoc.replace('<DocumentType>1<', '<DocumentType>2<'))!;
  assert.equal(credit.netCents, -150050);
  assert.equal(credit.items[0].netCents, -100000);
  const withModel = withKinds(invoice, {...invoice, kind: 'beverage', category: 'Nealko', items: [{...invoice.items[1], kind: 'food'}]});
  assert.equal(withModel.kind, 'beverage');
  assert.equal(withModel.netCents, 150050);
  assert.deepEqual(withModel.items.map(item => item.kind), [null, 'food']);
});

test('the model answer is checked before it becomes an invoice', () => {
  const answer = {isSupplierInvoice: true, documentType: 'invoice', supplier: 'Maso Test s.r.o.', supplierId: '8765 4321', number: '2026-77',
    issueDate: '2026-09-30', dueDate: '2026-10-14', paid: false, netTotal: 2000, grossTotal: 2240, kind: 'food', category: 'Maso',
    items: [{name: 'Hovězí', quantity: 4, unit: 'KG', unitPrice: 400, net: 1600, kind: 'food'}, {name: 'Doprava', quantity: 1, unitPrice: 400, kind: 'other'}]};
  const invoice = parseExtraction(answer)!;
  assert.equal(invoice.supplierId, '87654321');
  assert.equal(invoice.netCents, 200000);
  assert.equal(invoice.grossCents, 224000);
  assert.deepEqual(invoice.items.map(item => [item.name, item.netCents, item.kind]), [['Hovězí', 160000, null], ['Doprava', 40000, 'other']]);
  assert.equal(parseExtraction({...answer, items: [answer.items[0]]})!.items.length, 0); // items do not add up: totals stay, items go
  assert.equal(parseExtraction({...answer, grossTotal: 5000}), null); // VAT over 30 %: misread
  assert.equal(parseExtraction({...answer, isSupplierInvoice: false}), null);
  assert.equal(parseExtraction({...answer, documentType: 'advance'}), null);
  assert.equal(parseExtraction({...answer, issueDate: '30. 9. 2026'}), null);
  assert.equal(parseExtraction({...answer, documentType: 'credit_note'})!.grossCents, -224000);
  assert.equal(parseExtraction('nic'), null);
});

test('the same invoice e-mailed twice gets the same id; paid at issue counts as paid', () => {
  const invoice = parseExtraction({isSupplierInvoice: true, documentType: 'receipt', supplier: 'Velkoobchod Test', issueDate: '2026-10-01', paid: true,
    netTotal: 100, grossTotal: 121, kind: 'other', items: []})!;
  const id = mailInvoiceId(invoice);
  assert.match(id, /^posta-[0-9a-f]{32}$/);
  assert.equal(mailInvoiceId({...invoice, supplier: 'VELKOOBCHOD Test'}), id);
  assert.notEqual(mailInvoiceId({...invoice, grossCents: 12200}), id);
  const record = asSupplierInvoice(invoice, id);
  assert.equal(record.source, 'posta');
  assert.equal(record.paidDate, '2026-10-01');
  assert.ok(issuedByVenue({...invoice, supplier: 'Testovací podnik s.r.o.'}, 'Testovací podnik'));
  assert.ok(!issuedByVenue(invoice, 'Testovací podnik'));
});

test('invoices from the mailbox are never called overdue (the mailbox does not know payments)', () => {
  const base: SupplierInvoice = {type: 'supplier_invoice', id: 'a', version: 1, businessDate: '2026-09-01', source: 'dishboard', supplier: 'Test', supplierId: null,
    number: '1', dueDate: '2026-09-15', paidDate: null, status: 'active', netCents: 10000, grossCents: 12100, kind: 'food', category: null, items: []};
  assert.equal(overdueInvoices([base], '2026-10-01').length, 1);
  assert.equal(overdueInvoices([{...base, source: 'posta'}], '2026-10-01').length, 0);
});

test('unreadable documents from the mailbox are in the morning brief', () => {
  const brief = {unreadable: [{date: '2026-10-12', sender: 'fakturace@example.cz', subject: 'Faktura 2026001'}]} as unknown as SupplyBrief;
  const lines = renderSupplies({...emptyBrief(), ...brief});
  assert.ok(lines.some(line => line.startsWith('Z pošty nešlo přečíst 1 doklad: fakturace@example.cz, 12. 10.')), lines.join('\n'));
});

function emptyBrief(): SupplyBrief {
  return {month: {invoices: 0}, rises: [], overdue: [], sources: []} as unknown as SupplyBrief;
}

// --- Pošta info@ (synthetic conversations) -----------------------------------------------------------------------------
import {baseSubject, mailInsights, ownText, pairReplies, parseIncomingReading, parseReplyReading, renderMail, type MailRow} from '../src/mail-insights.ts';
import {todoList as todos} from '../src/todo.ts';
import {buildBriefing, renderBriefing} from '../src/briefing.ts';
import type {TenantConfig} from '../src/validate.ts';
import {zonedMidnight} from '../src/time.ts';

const row = (key: string, extra: Partial<MailRow>): MailRow => ({key, direction: 'in', at: '2026-10-10T10:00:00.000Z', from: 'host@example.cz', fromName: 'Host Testovací', to: ['info@example.cz'],
  subject: 'Dotaz', messageId: `<${key}@example.cz>`, inReplyTo: null, references: [], automated: false, reading: null, ...extra});

test('own text of a message: the quoted conversation is cut off', () => {
  assert.equal(ownText('Děkujeme, stůl je rezervovaný.\n\nDne 10. 10. 2026 v 10:00 Host napsal(a):\n> Chtěl bych stůl'), 'Děkujeme, stůl je rezervovaný.');
  assert.equal(ownText('Ahoj\n> citace\nkonec'), 'Ahoj\nkonec');
  assert.equal(baseSubject('RE: Odp: Fwd:  Rezervace  pátek'), 'rezervace pátek');
});

test('replies pair by In-Reply-To or by subject and address; waiting, speed, topics, complaints and grades', () => {
  const now = new Date('2026-10-18T12:00:00Z');
  const rows: MailRow[] = [
    row('a', {at: '2026-10-15T08:00:00.000Z', subject: 'Rezervace na pátek', reading: {topic: 'reservation', needsReply: true, complaint: false, summary: 'Chce stůl na pátek.'}}),
    row('a-re', {direction: 'out', at: '2026-10-15T10:00:00.000Z', from: 'info@example.cz', fromName: null, to: ['host@example.cz'], subject: 'Re: Rezervace na pátek', inReplyTo: '<a@example.cz>',
      reading: {quality: 5, issues: null, better: null}}),
    row('b', {at: '2026-10-14T09:00:00.000Z', from: 'jiny@example.cz', fromName: null, subject: 'Studené jídlo', reading: {topic: 'complaint', needsReply: true, complaint: true, summary: 'Stěžuje si na studené jídlo.'}}),
    row('b-re', {direction: 'out', at: '2026-10-17T09:00:00.000Z', from: 'info@example.cz', fromName: null, to: ['jiny@example.cz'], subject: 'RE: Studené jídlo', messageId: null,
      reading: {quality: 2, issues: 'Bez omluvy.', better: 'Omlouváme se…'}}),
    row('c', {at: '2026-10-16T09:00:00.000Z', from: 'treti@example.cz', fromName: 'Třetí', subject: 'Ztracená bunda', reading: {topic: 'lost', needsReply: true, complaint: false, summary: 'Hledá bundu.'}}),
    row('c2', {at: '2026-10-17T09:00:00.000Z', from: 'treti@example.cz', fromName: 'Třetí', subject: 'Re: Ztracená bunda', reading: {topic: 'lost', needsReply: true, complaint: false, summary: 'Znovu se ptá.'}}),
    row('d', {at: '2026-10-17T09:00:00.000Z', from: 'newsletter@example.cz', subject: 'Akce týdne', automated: true}),
    row('old', {at: '2026-09-10T09:00:00.000Z', reading: {topic: 'lost', needsReply: true, complaint: false, summary: ''}}),
  ];
  assert.deepEqual([...pairReplies(rows)].map(([key, reply]) => [key, reply.key]), [['a', 'a-re'], ['b', 'b-re']]);
  const insights = mailInsights(rows, '2026-09-18T12:00:00.000Z', now.toISOString(), now);
  assert.equal(insights.received, 4);
  assert.equal(insights.answered, 2);
  assert.equal(insights.medianReplyHours, 37); // 2 h and 72 h
  assert.equal(insights.within24Permille, 250);
  assert.deepEqual(insights.waiting.map(w => [w.from, w.hours]), [['treti@example.cz', 51]]);
  assert.deepEqual(insights.topics.map(t => [t.topic, t.count, t.previous]), [['lost', 2, 1], ['reservation', 1, 0], ['complaint', 1, 0]]);
  assert.equal(insights.complaints[0].answeredHours, 72);
  assert.equal(insights.complaints[0].better, 'Omlouváme se…');
  assert.equal(insights.qualityTenths, 35);
  assert.deepEqual(insights.weakest.map(w => w.quality), [2]);
  assert.ok(insights.outOfControl.some(text => text === 'Třetí <treti@example.cz> píše už 2× bez odpovědi („Re: Ztracená bunda“)'), insights.outOfControl.join('\n'));
  assert.ok(insights.outOfControl.some(text => text.startsWith('1 odpověď přišla až po víc než 48')));
  const lines = renderMail(insights, insights);
  assert.match(lines[0], /^⚠ Pošta info@: 1 bez odpovědi přes 24 h: Třetí \(„Ztracená bunda“, 2 dny\)$/);
  assert.ok(lines.some(line => line.startsWith('Pošta info@ za týden: 4 zpráv k odpovědi, odpovězeno 2, obvykle za 37 h, odpovědi 3,5/5')), lines.join('\n'));
  const config = {name: 'Testovací podnik', timeZone: 'Europe/Prague', businessDayCutoffHour: 6, sendHours: [7], registers: [], sections: {}, recipients: [], bottleCheck: null,
    reportsLink: null, dashboardPhones: null, web: null, location: null, disabledSources: [], foodCostLimitPermille: null} as unknown as TenantConfig;
  const briefing = buildBriefing({businessDate: '2026-10-17', config, bills: [], closings: [], planHistory: [], incomplete: false, mail: {insights, weekly: null}});
  assert.match(renderBriefing(config.name, briefing), /\n⚠ Pošta info@: 1 bez odpovědi/);
  assert.ok(todos(briefing).some(item => item.text.startsWith('Odpovědět na e-mail: Třetí („Ztracená bunda“, 2 dny) – Hledá bundu.')));
});

test('the model readings of mail are checked', () => {
  assert.deepEqual(parseIncomingReading({topic: 'group', needsReply: true, complaint: false, summary: '  Oslava   pro 20 lidí '}), {topic: 'group', needsReply: true, complaint: false, summary: 'Oslava pro 20 lidí'});
  assert.equal(parseIncomingReading({topic: 'neznámé', needsReply: true, complaint: false, summary: ''}), null);
  assert.deepEqual(parseReplyReading({quality: 4.4, issues: '', better: null}), {quality: 4, issues: null, better: null});
  assert.equal(parseReplyReading({quality: 7}), null);
});

test('local midnight of a day in Prague, in summer and winter time', () => {
  assert.equal(zonedMidnight('2026-10-18', 'Europe/Prague'), '2026-10-17T22:00:00.000Z');
  assert.equal(zonedMidnight('2026-12-01', 'Europe/Prague'), '2026-11-30T23:00:00.000Z');
});
