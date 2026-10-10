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
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}
nav{display:flex;gap:6px;align-items:center}
svg{width:100%;height:auto;display:block}
pre{white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace;margin:0}
details summary{cursor:pointer;color:var(--muted)}
#login{max-width:360px;margin:15vh auto}.pre{white-space:pre-line}
</style>
</head>
<body>
<main>
<section id="login" hidden>
  <div class="card">
    <h1>OKO1</h1>
    <p class="muted">Zadejte svoje telefonní číslo. Když má přístup, přijde na něj kód v SMS.</p>
    <form id="phoneForm"><p><input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+420 …" aria-label="Telefonní číslo" required> <button class="primary" id="send">Poslat kód</button></p></form>
    <form id="verify" hidden><p><input id="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 číslic" aria-label="Kód z SMS"> <button class="primary">Přihlásit</button></p></form>
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

$('phoneForm').onsubmit = async e => {
  e.preventDefault();
  $('send').disabled = true;
  const r = await post('/login', {phone: $('phone').value});
  const body = await r.json().catch(() => ({}));
  $('loginMsg').textContent = r.ok ? 'Pokud má číslo přístup, kód je na cestě. Platí 10 minut.' : body.error === 'TOO_MANY' ? 'Moc pokusů, zkuste to později.' : 'Kód se nepodařilo poslat.';
  $('verify').hidden = !r.ok; $('send').disabled = false; if (r.ok) $('code').focus();
};
$('verify').onsubmit = async e => {
  e.preventDefault();
  const r = await post('/verify', {code: $('code').value.trim()});
  if (r.ok) { $('login').hidden = true; load(); } else $('loginMsg').textContent = r.status === 429 ? 'Moc chybných kódů, přihlášení je na hodinu zavřené.' : 'Kód nesedí nebo vypršel.';
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
  const paid = b.payments.reduce((s, p) => s + p.amountCents, 0);
  const names = {cash: 'hotovost', card: 'karty', customer_card: 'zákaznické karty', voucher: 'poukazy', transfer: 'převod'};
  cards.push('<div class="card"><h2>Platby</h2>' + (paid ? b.payments.map(p => '<div>' + esc(names[p.method] ?? p.method) + ' <b>' + kc(p.amountCents) + '</b> <span class="muted">' + Math.round(p.amountCents / paid * 100) + ' %</span></div>').join('') : '<span class="muted">bez dat</span>') + '</div>');
  cards.push('<div class="card"><h2>Slevy a storna</h2><div class="big">' + kc(b.discountsCents) + '</div><div class="muted">' + (b.revenueCents ? Math.round(b.discountsCents / b.revenueCents * 1000) / 10 + ' % tržby · ' : '') + 'storna ' + b.voids.count + '× ' + kc(b.voids.amountCents) + '</div></div>');
  if (b.report) cards.push('<div class="card"><h2>Peníze</h2><div>trezor <b class="' + (b.report.safeCents < 0 ? 'warn' : '') + '">' + (b.report.safeCents === null ? '–' : kc(b.report.safeCents)) + '</b></div>' +
    (data.balances.bank !== undefined ? '<div>banka <b>' + kc(data.balances.bank) + '</b></div>' : '') + '<div>výdaje z kasy <b>' + kc(b.report.expensesCents) + '</b></div><div>výplaty v hotovosti <b>' + kc(b.report.payoutsCents) + '</b></div></div>');
  let html = '<div class="grid">' + cards.join('') + '</div>';
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
