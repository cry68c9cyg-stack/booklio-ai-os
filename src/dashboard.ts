/**
 * Dashboard v1 for the owner: one page, no external scripts or fonts. Login with a one-time code sent by SMS to the
 * venue's recipients (the owner); the session is an HttpOnly cookie valid for this venue only.
 */

const escape = (value: string) => value.replace(/[&<>"']/g, char => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[char]!);

export function dashboardHtml(tenant: string, nonce: string): string {
  return `<!doctype html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>OKO1</title>
<style nonce="${nonce}">
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#0f6e5c;--warn:#b4441c;--bar:#9cc9bd;--plan:#1d1d1b}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--text:#f1efe8;--muted:#a3a19a;--line:#33322f;--accent:#5fc2a8;--warn:#f08a5d;--bar:#2f6f60;--plan:#f1efe8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.big{font-size:26px;font-weight:700}.muted{color:var(--muted)}.warn{color:var(--warn)}.ok{color:var(--accent)}
table{width:100%;border-collapse:collapse}td,th{padding:5px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}
ul{margin:0;padding-left:18px}li{margin:3px 0}
button,input{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.6;cursor:default}
nav{display:flex;gap:6px;align-items:center}
svg{width:100%;height:auto;display:block}
pre{white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace;margin:0}
details summary{cursor:pointer;color:var(--muted)}
#login{max-width:360px;margin:15vh auto}.pre{white-space:pre-line}
h3{font-size:14px;margin:12px 0 6px}.scroll{overflow-x:auto}
</style>
</head>
<body>
<main>
<section id="login" hidden>
  <div class="card">
    <h1>OKO1</h1>
    <p class="muted">Zadejte svoje telefonní číslo. Když má přístup, přijde na něj kód v SMS.</p>
    <form id="phoneForm"><p><input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+420 …" aria-label="Telefonní číslo" required> <button class="primary" id="send">Poslat kód</button></p></form>
    <form id="verify" hidden><p><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="[0-9]{6}" placeholder="6 číslic" aria-label="Kód z SMS" required> <button class="primary">Přihlásit</button></p><p id="codeLeft" class="muted" role="timer"></p></form>
    <p id="loginMsg" class="muted" role="status"></p>
  </div>
</section>
<section id="app" hidden>
  <header>
    <h1 id="title">OKO1</h1>
    <nav><button id="prev" aria-label="Předchozí den">‹</button><input type="date" id="date" aria-label="Provozní den"><button id="next" aria-label="Další den">›</button><button id="logout">Odhlásit</button></nav>
  </header>
  <div id="content"></div>
</section>
</main>
<script nonce="${nonce}">
const base = '/d/${escape(tenant)}';
const $ = id => document.getElementById(id);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]);
const kc = c => c === null || c === undefined ? '–' : (c < 0 ? '−' : '') + Math.round(Math.abs(c) / 100).toString().replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' Kč';
const pct = (a, b) => b ? Math.round((a / b - 1) * 100) : null;
const signed = p => p === null ? '' : (p >= 0 ? '+' : '−') + Math.abs(p) + ' %';
const days = ['ne','po','út','st','čt','pá','so'];
const czDate = d => { const [y,m,dd] = d.split('-').map(Number); return days[new Date(d + 'T12:00:00Z').getUTCDay()] + ' ' + dd + '. ' + m + '. ' + y; };
const shift = (d, n) => { const t = new Date(d + 'T12:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const post = (path, body) => fetch(base + path, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body ?? {})});

// Countdown of the login code: the seconds come from the server's answer (expiresIn, retryAfter), the page only counts
// them down. The same answer and countdown for every number, with access or without.
const pad = n => String(n).padStart(2, '0');
const codeClock = s => s >= 3600 ? Math.floor(s / 3600) + ':' + pad(Math.floor(s / 60) % 60) + ':' + pad(s % 60) : Math.floor(s / 60) + ':' + pad(s % 60);
const inTime = s => s < 120 ? s + ' s' : Math.ceil(s / 60) + ' min';
let codeUntil = 0, sendFrom = 0, countdownTimer = null;
function countdown() {
  const now = Date.now(), left = Math.ceil((codeUntil - now) / 1000), wait = Math.ceil((sendFrom - now) / 1000);
  if (codeUntil) $('codeLeft').textContent = left > 0 ? 'Kód platí ještě ' + codeClock(left) : 'Kód vypršel, pošli nový';
  $('send').disabled = wait > 0;
  $('send').textContent = wait > 0 ? 'Poslat znovu za ' + codeClock(wait) : codeUntil ? 'Poslat kód znovu' : 'Poslat kód';
  if (left <= 0 && wait <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
}
function startCountdown(body) {
  const now = Date.now();
  if (typeof body.expiresIn === 'number') codeUntil = now + body.expiresIn * 1000;
  sendFrom = now + (Number(body.retryAfter) || 0) * 1000;
  if (!countdownTimer) countdownTimer = setInterval(countdown, 1000);
  countdown();
}
$('phoneForm').onsubmit = async e => {
  e.preventDefault();
  $('send').disabled = true;
  const r = await post('/login', {phone: $('phone').value});
  const body = await r.json().catch(() => ({}));
  if (r.ok || r.status === 429) {
    // Too soon after the last code: only the countdown, the code already sent still works.
    $('loginMsg').textContent = r.ok ? 'Pokud má číslo přístup, kód je na cestě.' : body.error === 'TOO_MANY' ? 'Moc pokusů, další kód půjde poslat za ' + inTime(body.retryAfter) + '.' : '';
    $('verify').hidden = false;
    startCountdown(body);
    if (r.ok) $('code').focus();
  } else { $('loginMsg').textContent = 'Kód se nepodařilo poslat.'; $('send').disabled = false; }
};
$('verify').onsubmit = async e => {
  e.preventDefault();
  const r = await post('/verify', {code: $('code').value.trim()});
  const body = await r.json().catch(() => ({}));
  if (r.ok) { clearInterval(countdownTimer); $('login').hidden = true; load(); }
  else $('loginMsg').textContent = r.status === 429 ? 'Moc chybných kódů, přihlášení se otevře za ' + inTime(Number(body.retryAfter) || 3600) + '.' : 'Kód nesedí nebo vypršel.';
};
$('logout').onclick = async () => { await post('/logout'); location.reload(); };
$('date').onchange = () => load($('date').value);
$('prev').onclick = () => load(shift($('date').value, -1));
$('next').onclick = () => load(shift($('date').value, 1));

function chart(series, selected) {
  const w = 700, h = 160, n = series.length, max = Math.max(1, ...series.map(d => Math.max(d.revenueCents ?? 0, d.planCents ?? 0)));
  const bw = w / n;
  let bars = '', plan = '', labels = '';
  series.forEach((d, i) => {
    const x = i * bw, v = d.revenueCents ?? 0, bh = v / max * (h - 20);
    bars += '<rect x="' + (x + 1) + '" y="' + (h - 20 - bh) + '" width="' + (bw - 2) + '" height="' + bh + '" fill="' + (d.date === selected ? 'var(--accent)' : 'var(--bar)') + '"><title>' + esc(czDate(d.date) + ': ' + (d.revenueCents === null ? 'bez dat' : kc(v))) + '</title></rect>';
    if (d.planCents) { const y = h - 20 - d.planCents / max * (h - 20); plan += '<line x1="' + (x + 1) + '" x2="' + (x + bw - 1) + '" y1="' + y + '" y2="' + y + '" stroke="var(--plan)" stroke-width="2"/>'; }
    if (new Date(d.date + 'T12:00:00Z').getUTCDay() === 1) labels += '<text x="' + (x + 2) + '" y="' + (h - 6) + '" font-size="11" fill="var(--muted)">' + Number(d.date.slice(8)) + '. ' + Number(d.date.slice(5, 7)) + '.</text>';
  });
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Tržby po dnech">' + bars + plan + labels + '</svg>';
}

function render(data) {
  const b = data.briefing, r = data.report;
  $('title').textContent = data.name;
  $('date').value = data.businessDate;
  const sameDayLastWeek = data.days.find(d => d.date === shift(data.businessDate, -7));
  // A day known only from the imported history (rkeeper) has its total but no detail.
  const imported = b.source === 'none' ? data.days.find(d => d.date === data.businessDate)?.revenueCents ?? null : null;
  if (imported !== null) b.revenueCents = imported;
  const cards = [];
  cards.push('<div class="card"><h2>Tržba ' + esc(czDate(data.businessDate)) + '</h2><div class="big">' + kc(b.revenueCents) + '</div><div class="muted">' +
    (b.plan ? 'plán ' + kc(b.plan.revenueCents) + ' (' + signed(pct(b.revenueCents, b.plan.revenueCents)) + ')' : 'plán zatím není') +
    (sameDayLastWeek && sameDayLastWeek.revenueCents ? ' · před týdnem ' + kc(sameDayLastWeek.revenueCents) + ' (' + signed(pct(b.revenueCents, sameDayLastWeek.revenueCents)) + ')' : '') + '</div>' +
    '<div class="muted">zdroj: ' + (imported !== null ? 'import historie (jen součet)' : ({pos: 'pokladna', report: 'report manažerů', none: 'zatím žádná data'})[b.source]) + '</div></div>');
  const paid = b.payments.filter(p => p.amountCents > 0).reduce((s, p) => s + p.amountCents, 0);
  const names = {cash: 'hotovost', card: 'karty', customer_card: 'zákaznické karty', voucher: 'poukazy', transfer: 'převod'};
  cards.push('<div class="card"><h2>Platby</h2>' + (paid ? b.payments.map(p => '<div>' + esc(names[p.method] ?? p.method) + ' <b>' + kc(p.amountCents) + '</b>' + (p.amountCents > 0 ? ' <span class="muted">' + Math.round(p.amountCents / paid * 100) + ' %</span>' : '') + '</div>').join('') : '<span class="muted">bez dat</span>') + '</div>');
  cards.push('<div class="card"><h2>Slevy a storna</h2><div class="big">' + kc(b.discountsCents) + '</div><div class="muted">' + (b.revenueCents ? Math.round(b.discountsCents / b.revenueCents * 1000) / 10 + ' % tržby · ' : '') + 'storna ' + b.voids.count + '× ' + kc(b.voids.amountCents) + '</div></div>');
  if (b.report) cards.push('<div class="card"><h2>Peníze</h2><div>trezor <b class="' + (b.report.safeCents < 0 ? 'warn' : '') + '">' + (b.report.safeCents === null ? '–' : kc(b.report.safeCents)) + '</b></div>' +
    (data.balances.register !== undefined ? '<div>kasa podle deníku <b>' + kc(data.balances.register) + '</b></div>' : '') +
    (b.report.cashDifferenceCents !== null && b.report.cashDifferenceCents !== undefined ? '<div>rozdíl přepočtu <b class="' + (Math.abs(b.report.cashDifferenceCents) >= 50000 ? 'warn' : '') + '">' + (b.report.cashDifferenceCents > 0 ? '+' : '') + kc(b.report.cashDifferenceCents) + '</b></div>' : '') +
    (data.balances.bank !== undefined ? '<div>banka <b>' + kc(data.balances.bank) + '</b></div>' : '') + '<div>výdaje z kasy <b>' + kc(b.report.expensesCents) + '</b></div><div>výplaty v hotovosti <b>' + kc(b.report.payoutsCents) + '</b></div></div>');
  const rv = b.reservations, hosts = n => n + ' ' + (n === 1 ? 'host' : n >= 2 && n <= 4 ? 'hosté' : 'hostů');
  if (rv) cards.push('<div class="card"><h2>Rezervace</h2><div class="big">' + rv.day.confirmed + '</div><div class="muted">' + hosts(rv.day.guests) +
    (rv.day.noShows ? ' · <span class="warn">nedorazilo ' + rv.day.noShows + ' (' + hosts(rv.day.noShowGuests) + ')</span>' : '') + (rv.day.cancelled ? ' · zrušeno ' + rv.day.cancelled : '') + '</div>' +
    '<div>' + esc(czDate(shift(data.businessDate, 1))) + ': <b>' + rv.today.confirmed + '</b> (' + hosts(rv.today.guests) + ')' +
    (rv.today.bySection.length > 1 ? ' <span class="muted">' + rv.today.bySection.map(s => esc(s.label) + ' ' + s.confirmed).join(' · ') + '</span>' : '') +
    (rv.today.pending ? ' · <span class="warn">čeká ' + rv.today.pending + '</span>' : '') + '</div></div>');
  const w = b.web, visits = n => n + ' ' + (n === 1 ? 'návštěva' : n >= 2 && n <= 4 ? 'návštěvy' : 'návštěv');
  if (w) cards.push('<div class="card"><h2>Návštěvnost webu</h2><div class="big">' + w.visits + '</div><div class="muted">' + visits(w.visits) +
    (w.lastWeekVisits !== null ? ' · před týdnem ' + w.lastWeekVisits + (w.lastWeekVisits ? ' (' + signed(pct(w.visits, w.lastWeekVisits)) + ')' : '') : '') + '</div>' +
    '<div>s akcí <b>' + w.withAction + '</b> · odeslané rezervace <b>' + w.reservationsSent + '</b>' + (w.reviewScans ? ' · QR na recenze <b>' + w.reviewScans + '</b>' : '') + '</div>' +
    (w.topOrigins.length ? '<div class="muted">' + w.topOrigins.map(o => esc(o.name) + ' ' + o.visits).join(' · ') + '</div>' : '') + '</div>');
  const re = b.reviews;
  if (re) cards.push('<div class="card"><h2>Recenze</h2><div class="big">' + re.newCount + '</div><div class="muted">nových za den' +
    (re.averageTenths !== null ? ' · průměr ' + (re.averageTenths / 10).toFixed(1).replace('.', ',') + ' ★' : '') + '</div>' +
    (re.bySource.length ? '<div class="muted">' + re.bySource.map(s => esc(s.name) + ' ' + s.newCount).join(' · ') + '</div>' : '') +
    (re.low ? '<div class="warn">3 ★ a méně: ' + re.low + '</div>' : '') +
    '<div>v adminu čeká na odpověď <b>' + re.waiting + '</b>' + (re.forManagement ? ' · <span class="warn">pro vedení ' + re.forManagement + '</span>' : '') +
    (re.failed ? ' · <span class="warn">neodeslané ' + re.failed + '</span>' : '') + '</div></div>');
  const co = b.costs, sum = rows => rows.reduce((t, r) => t + r.amountCents, 0);
  if (co) cards.push('<div class="card"><h2>Náklady a výsledek</h2><div class="big">' + kc(co.revenueCents - sum(co.rows)) + '</div><div class="muted">' +
    esc(co.month) + ' do ' + esc(czDate(co.through)) + ': tržby ' + kc(co.revenueCents) + ' − zaúčtované náklady ' + kc(sum(co.rows)) + '</div>' +
    co.rows.slice(0, 5).map(r => '<div>' + esc(r.name) + ' <b>' + kc(r.amountCents) + '</b></div>').join('') +
    (b.costsPrevious && b.costsPrevious.rows.length ? '<div class="muted">' + esc(b.costsPrevious.month) + ' celkem: ' + kc(b.costsPrevious.revenueCents - sum(b.costsPrevious.rows)) + '</div>' : '') +
    (co.error ? '<div class="warn">iÚčto dnes nejde načíst: ' + esc(co.error) + '</div>' : '') + '</div>');
  let html = '<div class="grid">' + cards.join('') + '</div><div id="web"></div>';
  html += '<div class="card"><h2>K vyřízení</h2>' + (data.todo.length ? '<ul>' + data.todo.map(t => '<li class="' + (t.level === 'warn' ? 'warn' : '') + '">' + esc(t.text) + '</li>').join('') + '</ul>' : '<span class="ok">Nic k vyřízení.</span>') + '</div>';
  html += '<div class="card"><h2>Posledních ' + data.days.length + ' dní</h2>' + chart(data.days, data.businessDate) + '<div class="muted">sloupec = tržba, čárka = plán (průměr stejného dne za 4 týdny)</div></div>';
  if (b.bySection.length) html += '<div class="card"><h2>Části podniku</h2><table>' + b.bySection.map(s => '<tr><td>' + esc(s.label) + '</td><td class="n">' + kc(s.revenueCents) + '</td><td class="n muted">' + (b.revenueCents ? Math.round(s.revenueCents / b.revenueCents * 100) : 0) + ' %</td></tr>').join('') + '</table></div>';
  if (b.notes) html += '<div class="card"><h2>Report dne</h2>' + (b.notes.raw ? '<p class="pre">' + esc(b.notes.raw) + '</p>' : (b.notes.summary ? '<p>' + esc(b.notes.summary) + '</p>' : '') + '<ul>' + b.notes.points.map(p => '<li class="' + (p.kind === 'incident' || p.kind === 'problem' ? 'warn' : '') + '">' + esc(({incident: 'Incident', problem: 'Problém', task: 'Úkol', info: 'Info'})[p.kind]) + ': ' + esc(p.text) + '</li>').join('') + '</ul>') + '</div>';
  if (r) {
    const kinds = {discount: 'Slevy a odpisy', expense: 'Výdaje z kasy', payout: 'Výplaty v hotovosti', movement: 'Vklady, odvody, karty', cash_count: 'Přepočet hotovosti', balance: 'Stavy', revenue_register: 'Pokladny klubu', total: 'Součty', unmapped: 'Nerozpoznané řádky'};
    html += '<div class="card"><h2>Report manažerů</h2><div class="muted">' + esc(r.files.join(', ') || 'zadáno ručně') + '</div>';
    for (const [kind, label] of Object.entries(kinds)) {
      const rows = r.lines.filter(l => l.kind === kind);
      if (rows.length) html += '<details' + (kind === 'expense' || kind === 'payout' ? ' open' : '') + '><summary>' + esc(label) + ' (' + rows.length + ')</summary><table>' + rows.map(l => '<tr><td>' + esc(l.label) + '</td><td class="n">' + (l.count === null ? '' : l.count + '×') + '</td><td class="n">' + kc(l.amountCents) + '</td></tr>').join('') + '</table></details>';
    }
    if (r.warnings.length) html += '<p class="warn">' + r.warnings.map(esc).join('<br>') + '</p>';
    html += '</div>';
  }
  if (data.briefingText) html += '<div class="card"><h2>Ranní zpráva</h2><pre>' + esc(data.briefingText) + '</pre></div>';
  $('content').innerHTML = html;
  loadWeb();
}

// Card "Web {venue}": read live from the website when the page asks, nothing of it is stored in OKO1 (docs/web-v1.md).
const areas = {diner: 'Diner', bar: 'Bar', klub: 'Klub'};
const states = {nova: 'čeká', potvrzena: 'potvrzená'};
const tableName = id => /^[pk][A-Z0-9]+$/.test(id) ? (id[0] === 'k' ? 'klub ' : '') + id.slice(1) : id;
const clock = (iso, zone) => new Date(iso).toLocaleTimeString('cs-CZ', {timeZone: zone, hour: '2-digit', minute: '2-digit'});
function webCard(c) {
  let h = '<div class="card"><h2>' + esc(c.name) + '</h2>';
  if (c.error) return h + '<p class="warn">' + esc(c.error) + '</p></div>';
  h += '<div class="muted">načteno živě v ' + esc(clock(c.readAt, c.timeZone)) + '</div>';
  if (c.warnings.length) h += '<p class="warn">' + c.warnings.map(esc).join('<br>') + '</p>';
  const list = c.reservations;
  h += '<h3>Rezervace ' + esc(czDate(c.today)) + ': ' + list.length + (c.pending ? ' · <span class="warn">čeká na potvrzení ' + esc(c.pending) + '</span>' : '') + '</h3>';
  if (list.length) h += '<div class="scroll"><table><tr><th>čas</th><th>jméno</th><th class="n">osoby</th><th>prostor</th><th>stůl</th><th>stav</th><th>kontakt</th><th>poznámka</th></tr>' +
    list.map(r => '<tr><td>' + esc(r.cas) + '</td><td>' + esc(r.jmeno ?? '–') + '</td><td class="n">' + esc(r.osoby) + '</td><td>' + esc(areas[r.prostor] ?? r.prostor) +
      '</td><td>' + esc(r.stoly.map(tableName).join(', ')) + '</td><td class="' + (r.stav === 'nova' ? 'warn' : '') + '">' + esc(states[r.stav] ?? r.stav) +
      '</td><td>' + esc(r.kontakt) + '</td><td>' + esc(r.poznamka) + '</td></tr>').join('') + '</table></div>';
  if (c.otherReservations) h += '<div class="muted">zrušené, odmítnuté a propadlé: ' + esc(c.otherReservations) + '</div>';
  const v = c.visits;
  h += '<h3>Návštěvnost webu</h3>' + (v ? '<div>dnes <b>' + esc(v.today.navstevy) + '</b> <span class="muted">(s akcí ' + esc(v.today.sAkci) + ')</span> · včera <b>' +
    esc(v.yesterday?.navstevy ?? 0) + '</b> <span class="muted">(s akcí ' + esc(v.yesterday?.sAkci ?? 0) + ')</span></div>' : '<span class="muted">bez dat</span>');
  h += '<h3>Recenze čekající na odpověď: ' + esc(c.reviewsWaiting) + '</h3>';
  if (c.reviews.length) h += '<ul>' + c.reviews.map(r => '<li>' + esc('★'.repeat(Number(r.hvezdicky) || 0)) + ' <b>' + esc(r.autor) + '</b> <span class="muted">' +
    esc([r.zdroj, r.datum].filter(Boolean).join(', ')) + '</span><br>' + esc(r.text) + '</li>').join('') + '</ul>';
  return h + '</div>';
}
async function loadWeb() {
  const box = $('web');
  const r = await fetch(base + '/web').catch(() => null);
  const body = r && r.ok ? await r.json().catch(() => null) : null;
  if (!body) { box.innerHTML = r && r.status === 401 ? '' : '<div class="card"><h2>Web</h2><p class="warn">Web teď nejde načíst.</p></div>'; return; }
  box.innerHTML = body.card ? webCard(body.card) : '';
}

async function load(date) {
  const r = await fetch(base + '/data' + (date ? '?date=' + encodeURIComponent(date) : ''));
  if (r.status === 401) { $('app').hidden = true; $('login').hidden = false; return; }
  if (!r.ok) { $('content').innerHTML = '<div class="card warn">Data se nepodařilo načíst.</div>'; $('app').hidden = false; return; }
  $('app').hidden = false; render(await r.json());
}
load();
</script>
</body>
</html>`;
}
