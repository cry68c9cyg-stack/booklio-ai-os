/**
 * Dashboard v1 for the owner: one page, no external scripts or fonts. Login with a one-time code sent by SMS to the
 * venue's recipients (the owner); the session is an HttpOnly cookie valid for this venue only.
 */

import {LOGIN_CSS} from './login-style.ts';

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
:root{--bg:#f6f5f2;--card:#fff;--text:#1d1d1b;--muted:#6b6a66;--line:#e4e2dc;--accent:#0f6e5c;--warn:#b4441c;--note:#fff3c4;--bar:#9cc9bd;--plan:#1d1d1b}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--card:#1e1e1c;--text:#f1efe8;--muted:#a3a19a;--line:#33322f;--accent:#5fc2a8;--warn:#f08a5d;--note:#3d3518;--bar:#2f6f60;--plan:#f1efe8}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1000px;margin:0 auto;padding:16px}
header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-size:20px;margin:0}h2{font-size:15px;margin:0 0 8px;color:var(--muted);font-weight:600;text-transform:uppercase;letter-spacing:.04em}
.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr))}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:14px;margin-bottom:12px}
.big{font-size:26px;font-weight:700}.muted{color:var(--muted)}.warn{color:var(--warn)}.ok{color:var(--accent)}
table{width:100%;border-collapse:collapse}td,th{padding:5px 4px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}td.n,th.n{text-align:right;white-space:nowrap}
ul{margin:0;padding-left:18px}li{margin:3px 0}ul.todos{list-style:none;padding:0}li.todo{display:flex;gap:8px;align-items:baseline}li.todo button{padding:2px 8px;font-size:13px;cursor:pointer;flex:none}li.done span{text-decoration:line-through;color:var(--muted)}
button,input{font:inherit;padding:8px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.6;cursor:default}
nav{display:flex;gap:6px;align-items:center}
svg{width:100%;height:auto;display:block}
pre{white-space:pre-wrap;font:13px/1.4 ui-monospace,monospace;margin:0}
details summary{cursor:pointer;color:var(--muted)}
.pre{white-space:pre-line}
h3{font-size:14px;margin:12px 0 6px}.scroll{overflow-x:auto}
${LOGIN_CSS}
</style>
</head>
<body>
<main>
<section id="login" class="login" hidden>
  <div class="card">
    <h1>Přihlásit do OKO1</h1>
    <form id="phoneForm">
      <label for="phone">Telefon</label><input id="phone" type="tel" inputmode="tel" autocomplete="tel" placeholder="+420 …" required>
      <button id="send">Poslat kód</button>
      <p class="muted">Kód v SMS přijde jen na číslo, které smí na dashboard OKO1.</p>
      <p id="phoneErr" class="warn" role="alert"></p>
    </form>
    <div id="codeStep" hidden>
      <form id="verify">
        <label for="code">Kód z SMS</label><input id="code" name="code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" minlength="6" pattern="[0-9]{6}" required>
        <button>Přihlásit</button>
        <p id="loginMsg" class="muted" role="status"></p>
        <p class="muted"><span id="codeLeft" role="timer">Platí 10 minut.</span> Přihlášení se pak při každé návštěvě prodlouží o 30 dní.</p>
        <p id="loginErr" class="warn" role="alert"></p>
      </form>
      <form id="againForm" class="again"><button class="secondary" id="again">Poslat kód znovu</button></form>
    </div>
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
  $('again').disabled = wait > 0;
  $('again').textContent = wait > 0 ? 'Poslat znovu za ' + codeClock(wait) : 'Poslat kód znovu';
  if (left <= 0 && wait <= 0) { clearInterval(countdownTimer); countdownTimer = null; }
}
function startCountdown(body) {
  const now = Date.now();
  if (typeof body.expiresIn === 'number') codeUntil = now + body.expiresIn * 1000;
  sendFrom = now + (Number(body.retryAfter) || 0) * 1000;
  if (!countdownTimer) countdownTimer = setInterval(countdown, 1000);
  countdown();
}
// Sending the code and sending it again: the same request, after it the code step with the countdown.
async function sendCode(button, error) {
  button.disabled = true;
  error.textContent = '';
  const r = await post('/login', {phone: $('phone').value});
  const body = await r.json().catch(() => ({}));
  if (r.ok || r.status === 429) {
    // Too soon after the last code: only the countdown, the code already sent still works.
    $('loginMsg').textContent = r.ok ? 'Pokud má číslo přístup, kód je na cestě.' : '';
    $('loginErr').textContent = body.error === 'TOO_MANY' ? 'Moc pokusů, další kód půjde poslat za ' + inTime(body.retryAfter) + '.' : '';
    $('phoneForm').hidden = true;
    $('codeStep').hidden = false;
    startCountdown(body);
    if (r.ok) $('code').focus();
  } else { error.textContent = 'Kód se nepodařilo poslat.'; button.disabled = false; }
}
$('phoneForm').onsubmit = e => { e.preventDefault(); return sendCode($('send'), $('phoneErr')); };
$('againForm').onsubmit = e => { e.preventDefault(); return sendCode($('again'), $('loginErr')); };
$('verify').onsubmit = async e => {
  e.preventDefault();
  const r = await post('/verify', {code: $('code').value.trim()});
  const body = await r.json().catch(() => ({}));
  if (r.ok) { clearInterval(countdownTimer); $('login').hidden = true; load(); }
  else $('loginErr').textContent = r.status === 429 ? 'Moc chybných kódů, přihlášení se otevře za ' + inTime(Number(body.retryAfter) || 3600) + '.' : 'Kód nesedí nebo vypršel.';
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

// "K vyřízení": open items first, each with a switch; what is done stays visible, crossed out, at the end.
let todoItems = [], todoDate = '';
function todoCard(items) {
  todoItems = items;
  const open = items.filter(t => t.key && !t.done).length, total = items.filter(t => t.key).length;
  const row = t => '<li class="todo' + (t.done ? ' done' : t.level === 'warn' ? ' warn' : '') + '">' +
    (t.key ? '<button type="button" data-key="' + esc(t.key) + '">' + (t.done ? 'Vrátit' : 'Vyřízeno') + '</button> ' : '') + '<span>' + esc(t.text) + '</span></li>';
  return '<h2>K vyřízení' + (items.length ? ' (zbývá ' + open + ' z ' + total + ')' : '') + '</h2>' + (items.length
    ? (open ? '' : '<p class="ok">Vše vyřízeno.</p>') + '<ul class="todos">' + [...items.filter(t => !t.done), ...items.filter(t => t.done)].map(row).join('') + '</ul>'
    : '<span class="ok">Nic k vyřízení.</span>');
}
$('content').onclick = async e => {
  const button = e.target.closest('#todo button[data-key]');
  if (!button || button.disabled) return;
  const item = todoItems.find(t => t.key === button.dataset.key);
  if (!item) return;
  button.disabled = true;
  const r = await post('/todo', {date: todoDate, key: item.key, done: !item.done}).catch(() => null);
  if (r && r.status === 401) { $('app').hidden = true; $('login').hidden = false; return; }
  if (r && r.ok) item.done = !item.done;
  $('todo').innerHTML = todoCard(todoItems);
  if (!r || !r.ok) $('todo').insertAdjacentHTML('beforeend', '<p class="warn">Nepodařilo se uložit, zkus to znovu.</p>');
};

// The 7 days up to the shown day against the 7 before (revenue, confirmed bookings, website, new reviews).
function weekCard(w) {
  if (!w) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const vs = (a, b) => b ? ' <span class="muted">(' + signed(pct(a, b)) + ')</span>' : '';
  const n = w.current, p = w.previous, rows = [], num = v => String(v).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  const dayWord = d => d + ' ' + (d === 1 ? 'den' : d >= 2 && d <= 4 ? 'dny' : 'dní');
  rows.push('<tr><td>Tržba' + (n.revenueDays < 7 ? ' <span class="muted">(' + dayWord(n.revenueDays) + ' s daty)</span>' : '') + '</td><td class="n">' + kc(n.revenueDays ? n.revenueCents : null) + (p.revenueDays === n.revenueDays ? vs(n.revenueCents, p.revenueCents) : '') + '</td><td class="n muted">' + kc(p.revenueDays ? p.revenueCents : null) + '</td></tr>');
  rows.push('<tr><td>Rezervace (hosté)</td><td class="n">' + n.reservations + ' (' + n.guests + ')' + vs(n.guests, p.guests) + '</td><td class="n muted">' + p.reservations + ' (' + p.guests + ')</td></tr>');
  const ns = x => x.noShowGuests + ' ' + (x.guests ? '(' + Math.round(x.noShowGuests / x.guests * 100) + ' %)' : '');
  rows.push('<tr><td>Nedorazilo hostů</td><td class="n' + (n.noShowGuests ? ' warn' : '') + '">' + ns(n) + '</td><td class="n muted">' + ns(p) + '</td></tr>');
  const lead = x => x.lead ? x.lead.sameDay + ' / ' + x.lead.upTo2 + ' / ' + x.lead.upTo7 + ' / ' + x.lead.more : '–';
  if (n.lead && n.lead.sameDay + n.lead.upTo2 + n.lead.upTo7 + n.lead.more) rows.push('<tr><td>Rezervováno předem <span class="muted">(týž den / 1–2 dny / 3–7 dní / víc)</span></td><td class="n">' + lead(n) + '</td><td class="n muted">' + lead(p) + '</td></tr>');
  const srcName = k => ({web: 'web', obsluha: 'obsluha', mcp: 'AI asistenti'})[k] || k;
  const src = x => (x.sources || []).map(r => esc(srcName(r.source)) + ' ' + r.reservations + (r.noShowGuests && r.guests ? ' <span class="warn">(' + Math.round(r.noShowGuests / r.guests * 100) + ' % nedorazilo)</span>' : '')).join(', ') || '–';
  if ((n.sources || []).length) rows.push('<tr><td>Odkud rezervace</td><td class="n">' + src(n) + '</td><td class="n muted">' + src(p) + '</td></tr>');
  const hostWord = v => v + ' ' + (v === 1 ? 'host' : v >= 2 && v <= 4 ? 'hosté' : 'hostů');
  for (const e of w.events || []) rows.push('<tr><td>Akce ' + short(e.date) + ' <b>' + esc(e.title) + '</b></td><td class="n">' + hostWord(e.guests) + (e.usualGuests ? vs(e.guests, e.usualGuests) : '') +
    (e.revenueCents !== null ? ', ' + kc(e.revenueCents) + (e.usualRevenueCents ? vs(e.revenueCents, e.usualRevenueCents) : '') : '') + '</td><td class="n muted">' +
    (e.usualGuests || e.usualRevenueCents ? 'obvykle ' + [e.usualGuests ? hostWord(e.usualGuests) : '', e.usualRevenueCents ? kc(e.usualRevenueCents) : ''].filter(Boolean).join(', ') : '–') + '</td></tr>');
  if (n.cancelled || p.cancelled) rows.push('<tr><td>Zrušené rezervace</td><td class="n">' + (n.cancelled || 0) + '</td><td class="n muted">' + (p.cancelled || 0) + '</td></tr>');
  if (n.lateCancelled || p.lateCancelled) rows.push('<tr><td>z toho do 24 h před začátkem</td><td class="n">' + (n.lateCancelled || 0) + ' <span class="muted">(' + hostWord(n.lateCancelledGuests || 0) + ')</span></td><td class="n muted">' + (p.lateCancelled || 0) + '</td></tr>');
  rows.push('<tr><td>Návštěvy webu</td><td class="n">' + (n.visits === null ? '–' : num(n.visits) + (p.visits !== null && p.visitDays === n.visitDays ? vs(n.visits, p.visits) : '')) + '</td><td class="n muted">' + (p.visits === null ? '–' : num(p.visits)) + '</td></tr>');
  const stars = t => t === null ? '' : ', ' + (t / 10).toFixed(1).replace('.', ',') + ' ★';
  rows.push('<tr><td>Web: odeslané formuláře → potvrzené rezervace z webu</td><td class="n">' + n.webSent + ' → ' + n.webConfirmed + '</td><td class="n muted">' + p.webSent + ' → ' + p.webConfirmed + '</td></tr>');
  const u = w.reviewsUsual, drop = !!w.reviewDrop;
  rows.push('<tr><td>Nové recenze' + (u && u.rated >= 10 ? ' <span class="muted">(4 týdny předtím ' + stars(u.starsTenths).slice(2) + ' z ' + u.rated + ')</span>' : '') + '</td><td class="n' + (drop ? ' warn' : '') + '">' + n.reviews + stars(n.starsTenths) + (drop ? ' · klesá' : '') + '</td><td class="n muted">' + p.reviews + stars(p.starsTenths) + '</td></tr>');
  const before = new Map(p.origins.map(r => [r.key, r.visits]));
  const origins = n.origins.length ? '<details><summary>Odkud na web <span class="muted">(s akcí = otevřeli rezervaci, volali nebo navigovali)</span></summary><table><tr><th></th><th class="n">7 dní</th><th class="n">7 dní předtím</th></tr>' +
    n.origins.map(r => '<tr><td>' + esc(r.name) + '</td><td class="n">' + num(r.visits) + (r.withAction ? ' <span class="muted">(' + num(r.withAction) + ' s akcí)</span>' : '') + '</td><td class="n muted">' + (before.has(r.key) ? num(before.get(r.key)) : '–') + '</td></tr>').join('') + '</table></details>' : '';
  return '<div class="card"><h2>Týden ' + short(w.from) + '–' + short(w.to) + '</h2><table><tr><th></th><th class="n">7 dní</th><th class="n">7 dní předtím</th></tr>' + rows.join('') + '</table>' + origins + '</div>';
}

// Twelve weeks up to the shown day, newest first: where the numbers are heading.
function trendsCard(t) {
  if (!t || !t.length) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.', num = v => String(v).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  const rows = t.slice().reverse().map((w, i, all) => {
    const prev = all[i + 1], arrow = (a, b) => b ? (a > b * 1.05 ? ' <span class="muted">↑</span>' : a < b * 0.95 ? ' <span class="muted">↓</span>' : '') : '';
    return '<tr><td>' + short(w.from) + '–' + short(w.to) + '</td>' +
      '<td class="n">' + (w.revenueDays ? kc(w.revenueCents) + (prev && prev.revenueDays === w.revenueDays ? arrow(w.revenueCents, prev.revenueCents) : '') + (w.revenueDays < 7 ? ' <span class="muted">(' + w.revenueDays + ' d)</span>' : '') : '–') + '</td>' +
      '<td class="n">' + w.guests + (prev ? arrow(w.guests, prev.guests) : '') + '</td>' +
      '<td class="n' + (w.guests && w.noShowGuests / w.guests >= 0.1 ? ' warn' : '') + '">' + (w.guests ? Math.round(w.noShowGuests / w.guests * 100) + ' %' : '–') + '</td>' +
      '<td class="n">' + (w.visits === null ? '–' : num(w.visits)) + '</td>' +
      '<td class="n">' + w.webSent + ' → ' + w.webConfirmed + '</td>' +
      '<td class="n">' + w.reviews + (w.starsTenths !== null ? ' · ' + (w.starsTenths / 10).toFixed(1).replace('.', ',') + ' ★' : '') + '</td>' +
      '<td class="n">' + (w.errorPermille === null ? '–' : Math.round(w.errorPermille / 10) + ' %') + '</td></tr>';
  }).join('');
  return '<div class="card"><h2>Trendy 12 týdnů</h2><div class="scroll"><table><tr><th>Týden</th><th class="n">Tržba</th><th class="n">Hosté rez.</th><th class="n">Nedorazilo</th><th class="n">Web</th><th class="n">Formuláře → rez.</th><th class="n">Recenze</th><th class="n">Odchylka odhadu</th></tr>' +
    rows + '</table></div><div class="muted">↑ ↓ = o víc než 5 % proti týdnu předtím; odchylka odhadu = jak daleko byla tržba od plánu z ranní zprávy (od 4 dní v týdnu)</div></div>';
}

// Interest in the menu on the website over 12 weeks (only once the website sends it): visits that opened it, page views by part, from abroad, languages and reservations.
function menuInterestCard(weeks) {
  if (!weeks || !weeks.some(w => w.days)) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.', num = v => String(v).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ');
  const share = (a, b) => b ? Math.round(a / b * 100) + ' %' : '–';
  const language = (w, key) => share((w.languages.find(l => l.key === key) || {visits: 0}).visits, w.visits);
  const rows = weeks.slice().reverse().map((w, i, all) => {
    if (!w.days) return '';
    const prev = all[i + 1], arrow = prev && prev.days === 7 && w.days === 7 ? (w.visits > prev.visits * 1.05 ? ' <span class="muted">↑</span>' : w.visits < prev.visits * 0.95 ? ' <span class="muted">↓</span>' : '') : '';
    return '<tr><td>' + esc(short(w.from)) + '–' + esc(short(w.to)) + (w.days < 7 ? ' <span class="muted">(' + w.days + ' d)</span>' : '') + '</td>' +
      '<td class="n">' + num(w.visits) + arrow + '</td><td class="n">' + num(w.food) + ' / ' + num(w.drinks) + '</td><td class="n">' + share(w.abroad, w.visits) + '</td>' +
      '<td class="n">' + language(w, 'cs') + '</td><td class="n">' + language(w, 'en') + '</td><td class="n">' + language(w, 'de') + '</td>' +
      '<td class="n">' + w.reserved + ' <span class="muted">(' + (w.visits ? (Math.round(w.reserved / w.visits * 1000) / 10).toFixed(1).replace('.', ',') : '0,0') + ' %)</span></td></tr>';
  }).join('');
  return '<div class="card"><h2>Zájem o lístek na webu (12 týdnů)</h2><div class="scroll"><table><tr><th>Týden</th><th class="n">Otevřelo</th><th class="n">Jídlo / nápoje</th><th class="n">Ze zahraničí</th><th class="n">česky</th><th class="n">anglicky</th><th class="n">německy</th><th class="n">Rezervace</th></tr>' +
    rows + '</table></div><div class="muted">otevřelo = návštěvy webu, které si otevřely jídelní nebo nápojový lístek; jídlo / nápoje = kolikrát se která část zobrazila; ze zahraničí podle země návštěvy, jazyk podle jazyka webu; rezervace = z těch návštěv poslaly rezervaci; ↑ ↓ = o víc než 5 % proti týdnu předtím</div></div>';
}

// Events of the half year before the shown day, the strongest first: guests and revenue against the same weekday without an event.
function eventsCard(ranking) {
  if (!ranking || !ranking.length) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const days = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'];
  const lift = x => { if (x === null) return '<span class="muted">–</span>'; const p = Math.round((x - 1) * 100); return '<span class="' + (p < 0 ? 'warn' : '') + '">' + (p === 0 ? '±0' : (p > 0 ? '+' : '−') + Math.abs(p)) + ' %</span>'; };
  const rows = ranking.map(r => '<tr><td><b>' + esc(r.title) + '</b><div class="muted">' + r.count + '× · ' + r.weekdays.map(d => days[d]).join(', ') + ' · naposledy ' + esc(short(r.last)) + '</div></td>' +
    '<td class="n">' + r.guests + (r.usualGuests !== null ? ' <span class="muted">/ ' + r.usualGuests + '</span>' : '') + '</td><td class="n">' + lift(r.guestLift) + '</td><td class="n">' + lift(r.revenueLift) + '</td></tr>').join('');
  return '<div class="card"><h2>Akce za půl roku</h2><div class="scroll"><table><tr><th>Akce</th><th class="n">hosté / obvykle</th><th class="n">hosté</th><th class="n">tržba</th></tr>' + rows + '</table></div>' +
    '<div class="muted">průměr potvrzených hostů na jednu akci proti stejným dnům v týdnu bez akce (nejvýš 4 za 8 týdnů před ní); tržba stejně, jen u dnů s tržbou; nahoře akce, které přivedou nejvíc hostů navíc</div></div>';
}

// The month up to the shown day against the same days of the month before, and the cash the cash book paid out.
const monthNames = ['leden', 'únor', 'březen', 'duben', 'květen', 'červen', 'červenec', 'srpen', 'září', 'říjen', 'listopad', 'prosinec'];
function monthCard(m) {
  if (!m || !m.current.revenueDays) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const name = mo => monthNames[Number(mo.slice(5, 7)) - 1];
  const n = m.current, p = m.previous, rows = [];
  const dayWord = d => d + ' ' + (d === 1 ? 'den' : d >= 2 && d <= 4 ? 'dny' : 'dní');
  rows.push('<tr><th></th><th class="n">' + esc(name(m.month)) + '</th><th class="n">' + esc(short(p.month + '-01')) + '–' + esc(short(p.through)) + '</th></tr>');
  rows.push('<tr><td>Tržba' + (n.revenueDays < Number(m.through.slice(8)) ? ' <span class="muted">(' + dayWord(n.revenueDays) + ' s daty)</span>' : '') + '</td><td class="n">' + kc(n.revenueCents) +
    (p.revenueCents && (p.revenueDays === n.revenueDays || (n.revenueDays === Number(m.through.slice(8)) && p.revenueDays === Number(p.through.slice(8)))) ? ' <span class="muted">(' + signed(pct(n.revenueCents, p.revenueCents)) + ')</span>' : '') + '</td><td class="n muted">' + kc(p.revenueDays ? p.revenueCents : null) + '</td></tr>');
  const before = new Map((p.bySection ?? []).map(r => [r.section, r.revenueCents]));
  for (const r of n.bySection ?? []) rows.push('<tr><td class="muted">' + esc(r.label) + '</td><td class="n">' + kc(r.revenueCents) + '</td><td class="n muted">' + kc(before.has(r.section) ? before.get(r.section) : null) + '</td></tr>');
  if (m.reviews && m.reviews.reviews) rows.push('<tr><td>Nové recenze</td><td class="n">' + m.reviews.reviews + (m.reviews.starsTenths !== null ? ', ' + (m.reviews.starsTenths / 10).toFixed(1).replace('.', ',') + ' ★' : '') + '</td><td></td></tr>');
  const list = (title, total, items, limit) => total ? '<details><summary>' + esc(title) + ' <b>' + kc(total) + '</b></summary><table>' +
    items.slice(0, limit).map(r => '<tr><td>' + esc(r.label) + '</td><td class="n">' + kc(r.amountCents) + '</td></tr>').join('') + '</table></details>' : '';
  return '<div class="card"><h2>' + esc(name(m.month)[0].toUpperCase() + name(m.month).slice(1)) + (m.complete ? ' celkem' : ' do ' + esc(short(m.through))) + '</h2><table>' + rows.join('') + '</table>' +
    list('Výplaty v hotovosti' + (n.revenueCents > 0 && m.payoutsCents ? ' (' + (Math.round(m.payoutsCents / n.revenueCents * 1000) / 10).toFixed(1).replace('.', ',') + ' % tržby)' : ''), m.payoutsCents, m.payouts, 20) + list('Výdaje z kasy', m.expensesCents, m.expenses, 10) + list('Slevy a odpisy', m.discountsCents, m.discounts, 10) + '</div>';
}

// Guests to expect over the 7 days from today by part of the day: expected, with those booked now in brackets.
function guestsCard(g) {
  if (!g || !(g.days || []).length) return '';
  const cell = (expected, booked) => '<b>' + (expected === null ? booked : expected) + '</b>' + (expected !== null ? ' <span class="muted">(' + booked + ')</span>' : '');
  const rows = g.days.map(d => '<tr' + (d.weak ? ' class="warn"' : '') + '><td>' + esc(czDate(d.date).slice(0, -5)) + (d.weak ? '<div class="muted">obvykle touhle dobou ' + d.usual + ' potvrzených</div>' : '') + '</td>' +
    d.parts.map(p => '<td class="n">' + cell(p.expected, p.booked) + '</td>').join('') + '<td class="n">' + cell(d.expected, d.booked) + '</td></tr>').join('');
  return '<div class="card"><h2>Hosté na 7 dní</h2><table><tr><th></th><th class="n">přes den</th><th class="n">večer</th><th class="n">noc</th><th class="n">celkem</th></tr>' + rows + '</table>' +
    '<div class="muted">tučně kolik hostů čekat, v závorce kolik jich je zatím potvrzeno v rezervacích; kolik ještě přibude nebo ubude stornem, se počítá ze stejného dne v týdnu za posledních 8 týdnů; červeně den, kdy je potvrzeno aspoň o 40 % méně hostů než obvykle touhle dobou' +
    (g.noShowGuests ? ' · dnes obvykle nedorazí asi ' + g.noShowGuests : '') + '</div></div>';
}

// Revenue forecast from the day after the shown one: the next 7 days with bookings and weather, the month, the next month, how well it hit.
function forecastCard(f) {
  if (!f) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const name = mo => monthNames[Number(mo.slice(5, 7)) - 1];
  const big = mo => esc(name(mo)[0].toUpperCase() + name(mo).slice(1));
  const round = c => c === null ? null : Math.round(c / 100000) * 100000;
  const days = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so'], wd = d => days[new Date(d + 'T12:00:00Z').getUTCDay()];
  const m = f.month, missing = m.elapsedDays - m.actualDays;
  const by = (x, what) => ' <span class="muted">(' + (x >= 1 ? '+' : '−') + Math.round(Math.abs(x - 1) * 100) + ' % ' + what + ')</span>';
  const lift = d => { const e = d.eventBoost || 1; return (e > d.boost ? by(e, 'akce') : d.boost > 1 ? by(d.boost, 'rezervace') : '') +
    (d.holidayFactor !== undefined && d.holidayFactor !== 1 ? by(d.holidayFactor, 'svátek') : '') + (d.rainFactor !== undefined && d.rainFactor !== 1 ? by(d.rainFactor, 'déšť') : ''); };
  // Sections in whole thousands that add up to the day's rounded amount (the rest goes to the largest); under 1 000 Kč left out.
  const sections = d => { const rows = d.bySection.map(x => ({label: x.label, cents: round(x.cents)})), top = rows.reduce((a, x) => x.cents > a.cents ? x : a, rows[0]);
    top.cents += round(d.cents) - rows.reduce((t, x) => t + x.cents, 0); return rows.filter(x => x.cents > 0); };
  const week = (f.days || []).map(d => '<tr><td>' + wd(d.date) + ' ' + short(d.date) + ((d.events || []).length ? '<div class="muted">' + d.events.map(esc).join(', ') + '</div>' : '') + (d.holiday ? '<div class="muted">svátek: ' + esc(d.holiday) + '</div>' : '') + '</td><td class="n">' + kc(round(d.cents)) + lift(d) + ((d.bySection || []).length ? '<div class="muted">' + sections(d).map(x => esc(x.label) + ' ' + kc(x.cents)).join(', ') + '</div>' : '') +
    '</td><td class="n' + (d.boost > 1 ? ' warn' : '') + '">' + d.guests + (d.usualGuests !== null ? ' <span class="muted">/ ' + d.usualGuests + '</span>' : '') + '</td><td class="muted">' + esc(d.weatherText || '–') + '</td></tr>').join('');
  const rows = [];
  rows.push('<tr><td>7 dní od dneška <span class="muted">(' + short(f.week.from) + '–' + short(f.week.to) + ')</span></td><td class="n">' + kc(round(f.week.cents)) + '</td></tr>');
  rows.push('<tr><td>' + big(m.month) + ' celkem' + (m.elapsedDays ? ' <span class="muted">(zatím ' + kc(m.actualCents) + (missing > 0 ? ', ' + missing + (missing === 1 ? ' den' : missing <= 4 ? ' dny' : ' dní') + ' bez dat odhadnuto' : '') + ')</span>' : '') + '</td><td class="n">' + kc(round(m.totalCents)) + '</td></tr>');
  rows.push('<tr><td>' + big(f.nextMonth.month) + '</td><td class="n">' + kc(round(f.nextMonth.cents)) + '</td></tr>');
  const seasons = Object.keys(f.seasonal).sort().map(k => name(k) + ' ×' + String(f.seasonal[k]).replace('.', ','));
  return '<div class="card"><h2>Odhad tržby od ' + short(f.today) + '</h2>' +
    (week ? '<table><tr><th></th><th class="n">odhad</th><th class="n">hosté rez. / obvykle</th><th>počasí</th></tr>' + week + '</table>' : '') +
    '<table>' + rows.join('') + '</table>' +
    (f.accuracy ? '<p>Odhad se za ' + f.accuracy.days + ' dní lišil od skutečnosti v průměru o <b>' + Math.round(f.accuracy.errorPermille / 10) + ' %</b>.</p>' : '<p class="muted">Přesnost odhadu se ukáže po 7 dnech provozu.</p>') +
    '<p class="muted">Průměr stejného dne v týdnu za poslední 4 týdny' +
    (seasons.length ? ', upravený podle loňska (' + esc(seasons.join(', ')) + ')' : '; loňská data na sezónnost zatím nejsou') +
    '. Výrazně víc potvrzených hostů než obvykle (aspoň o 10) zvýší odhad dne o polovinu toho rozdílu, nejvýš o 50 %. ' +
    (f.eventFactor && f.eventFactor.factor > 1 ? 'Den s akcí bývá o ' + Math.round((f.eventFactor.factor - 1) * 100) + ' % silnější (' + f.eventFactor.days + ' dní s akcí za půl roku); platí větší z obou úprav. ' : 'Vliv akcí se započítá od 4 dní s akcí a tržbou. ') +
    'Státní svátek se počítá podle stejného svátku loni proti jeho dnům v týdnu (jinak podle mediánu svátků za rok) a do průměrů dnů v týdnu nevstupuje. ' +
    (f.rainFactor ? 'Deštivý den (od 5 mm) bývá ' + (f.rainFactor.factor >= 1 ? 'o ' + Math.round((f.rainFactor.factor - 1) * 100) + ' % silnější' : 'o ' + Math.round((1 - f.rainFactor.factor) * 100) + ' % slabší') + ' (' + f.rainFactor.days + ' deštivých dní za půl roku). ' : 'Vliv deště se započítá od 6 deštivých dní s tržbou (počasí dne = poslední předpověď MET Norway pro ten den, OKO1 si ji ukládá od října 2026). ') +
    ((f.days || []).some(d => (d.bySection || []).length) ? 'Rozdělení po prostorech podle jejich podílu na tržbě stejného dne v týdnu za posledních 8 týdnů. ' : '') + 'Počasí: MET Norway.</p></div>';
}

// The menu from the website: items per part and category with base prices, and its changes over 30 days.
function menuCard(m) {
  if (!m) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const changeText = c => c.kind === 'added' ? 'nová položka za ' + esc(c.newText) : c.kind === 'removed' ? 'zrušeno (bylo ' + esc(c.oldText) + ')' : esc(c.oldText) + ' → ' + esc(c.newText);
  const range = c => c.minCents === c.maxCents ? kc(c.minCents) : kc(c.minCents) + ' – ' + kc(c.maxCents);
  let h = '<div class="card"><h2>Jídelní a nápojový lístek</h2><div class="muted">' + m.items + (m.items === 1 ? ' položka' : m.items >= 2 && m.items <= 4 ? ' položky' : ' položek') + ' · ' + m.parts.map(p => esc(p.name.toLowerCase()) + ' ' + p.items).join(', ') + ' · z webu, naposledy ' + esc(m.received) + '</div>';
  h += '<h3>Změny za 30 dní</h3>' + (m.changes.length ? '<ul>' + m.changes.map(c => '<li>' + esc(short(c.date)) + ' <b>' + esc(c.name) + '</b>: ' + changeText(c) + '</li>').join('') + '</ul>' + (m.changesTotal > m.changes.length ? '<div class="muted">… a další ' + (m.changesTotal - m.changes.length) + '</div>' : '') : '<span class="muted">beze změn</span>');
  if (m.problems && m.problems.length) h += '<div class="warn">' + m.problems.map(esc).join('<br>') + '</div>';
  const pc = m.priceCheck;
  h += '<h3>Ceny k prověření</h3>' + (pc.findings.length ? '<ul>' + pc.findings.map(f => '<li>' + (f.name ? '<b>' + esc(f.name) + '</b> ' + esc(f.priceText) : '<b>' + esc(f.category) + '</b>') +
    (f.name ? ' (' + esc(f.category) + ')' : '') + ': ' + esc(f.text) + '</li>').join('') + '</ul>' + (pc.total > pc.findings.length ? '<div class="muted">… a další ' + (pc.total - pc.findings.length) + '</div>' : '') : '<span class="muted">nic nápadného</span>');
  const gp = m.gaps;
  if (gp) h += '<h3>Co opravit na webu</h3>' + (gp.items.length ? '<ul>' + gp.items.map(g => '<li><b>' + esc(g.name) + '</b> (' + esc(g.group ? g.category + ' › ' + g.group : g.category) + '): ' + esc(g.text) + '</li>').join('') + '</ul>' +
    (gp.total > gp.items.length ? '<div class="muted">… a další ' + (gp.total - gp.items.length) + '</div>' : '') : '<span class="muted">nic, lístek je úplný</span>');
  const pr = m.profit;
  if (pr) {
    h += '<h3>Prodej po položkách za 30 dní</h3><div class="scroll"><table><tr><th>Položka</th><th class="n">Kusů</th><th class="n">Tržba</th><th class="n">Zisk</th></tr>' +
      pr.items.map(i => '<tr><td>' + esc(i.name) + '</td><td class="n">' + i.quantity + '</td><td class="n">' + kc(i.grossCents) + '</td><td class="n">' + (i.profitCents === null ? '<span class="muted">–</span>' : kc(i.profitCents)) + '</td></tr>').join('') + '</table></div>' +
      '<div class="muted">spárováno s lístkem ' + (pr.totals.pairedPermille === null ? '–' : Math.round(pr.totals.pairedPermille / 10) + ' %') + ' tržby' + (pr.itemsTotal > pr.items.length ? ' · položek celkem ' + pr.itemsTotal : '') +
      (pr.missing.length ? ' · k zisku chybí: ' + esc(pr.missing.join(', ')) : '') + '</div>' +
      (pr.unpaired.length ? '<div class="muted">nespárováno: ' + pr.unpaired.map(u => esc(u.name) + ' ' + kc(u.grossCents)).join(', ') + (pr.unpairedTotal > pr.unpaired.length ? ' a další ' + (pr.unpairedTotal - pr.unpaired.length) : '') + '</div>' : '');
  }
  if (m.matrix && m.matrix.length) {
    h += '<h3>Obliba × výdělek za 30 dní</h3>' + m.matrix.map(part => '<details><summary>' + esc(part.name) + (part.basis === 'price' ? ' <span class="muted">(podle ceny, food cost chybí)</span>' : '') + '</summary><ul>' +
      part.classes.filter(c => c.count).map(c => '<li><b>' + esc(c.name) + '</b> (' + c.count + '): ' + c.items.map(i => esc(i.name)).join(', ') + (c.count > c.items.length ? ' …' : '') + '<br><span class="muted">' + esc(c.advice) + '</span></li>').join('') + '</ul>' +
      (part.newItems.length ? '<div class="muted">nové, zatím nehodnocené: ' + part.newItems.map(esc).join(', ') + '</div>' : '') + '</details>').join('');
  }
  if (m.experiments && m.experiments.length) {
    const pct = p => p === null ? '–' : (p > 0 ? '+' : '') + Math.round(p / 10) + ' %';
    h += '<h3>Změny cen jako pokus</h3><ul>' + m.experiments.map(e => '<li>' + esc(short(e.date)) + ' <b>' + esc(e.name) + '</b> ' + esc(e.oldText || '?') + ' → ' + esc(e.newText || '?') + ': ' +
      (e.status === 'no_history' ? '<span class="muted">málo prodejů před změnou</span>' : e.status === 'waiting' ? '<span class="muted">čeká na 7 dní prodeje</span>' : 'kusy za den ' + pct(e.quantityPermille) + ', tržba za den ' + pct(e.revenuePermille) + (e.status === 'running' ? ' <span class="muted">(zatím ' + e.after.days + ' dní)</span>' : '')) + '</li>').join('') + '</ul>';
  }
  h += '<h3>Položka v čase</h3><form id="itemForm" class="row"><input id="itemQuery" maxlength="100" placeholder="název, např. texas burger" autocomplete="off"><button>Ukázat</button></form><div id="itemBox"></div>';
  const t = m.trend;
  if (t && t.categories.length) {
    const month = s => Number(s.slice(5)) + '/' + s.slice(2, 4);
    const pct = p => p === null ? '' : (p > 0 ? '+' : '') + String(p / 10).replace('.', ',') + ' %';
    h += '<details><summary>Vývoj cen po měsících</summary><div class="scroll"><table><tr><th>Kategorie</th>' + t.months.map(x => '<th class="n">' + esc(month(x)) + '</th>').join('') + '<th class="n">Změna</th></tr>' +
      t.categories.map(c => '<tr><td>' + esc(c.name) + '</td>' + c.values.map(v => '<td class="n">' + (v === null ? '<span class="muted">–</span>' : kc(v)) + '</td>').join('') + '<td class="n">' + pct(c.changePermille) + '</td></tr>').join('') +
      '</table></div>' + (t.months.length < 2 ? '<div class="muted">průměrná cena kategorie; další měsíce přibydou s dalšími lístky</div>' : '') + '</details>';
  }
  for (const p of m.parts) {
    h += '<details><summary>' + esc(p.name) + ' (' + p.items + ')</summary><div class="scroll"><table><tr><th>Kategorie</th><th class="n">Položek</th><th class="n">Cena od – do</th><th class="n">Průměr</th></tr>' +
      p.categories.map(c => '<tr><td>' + esc(c.name) + '</td><td class="n">' + c.items + '</td><td class="n">' + range(c) + '</td><td class="n">' + kc(c.avgCents) + '</td></tr>').join('') + '</table></div></details>';
  }
  return h + '</div>';
}

// Supplier invoices (Dishboard, later Pexeso): purchases of the month without VAT, food cost, price rises over 30 days, overdue invoices.
function suppliesCard(s) {
  if (!s) return '';
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const unit = c => String(Math.floor(c / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + String(c % 100).padStart(2, '0') + ' Kč';
  const m = s.month;
  let h = '<div class="card"><h2>Náklady a dodavatelé</h2><div class="big">' + kc(m.netCents) + '</div><div class="muted">nákupy ' + esc(short(m.from)) + '–' + esc(short(m.to)) +
    ' bez DPH, ' + m.invoices + (m.invoices === 1 ? ' faktura' : m.invoices >= 2 && m.invoices <= 4 ? ' faktury' : ' faktur') +
    (m.foodCostPermille !== null ? ' · food cost <b>' + String(m.foodCostPermille / 10).replace('.', ',') + ' %</b> z tržeb s DPH (' + kc(m.revenueCents) + ')' : '') + '</div>';
  if (m.byKind.length) h += '<div>' + m.byKind.map(k => esc(k.name) + ' <b>' + kc(k.netCents) + '</b>').join(' · ') + '</div>';
  h += '<h3>Zdražení za 30 dní</h3>' + (s.rises.length ? '<ul>' + s.rises.map(r => '<li class="warn">' + esc(short(r.date)) + ' <b>' + esc(r.name) + '</b>' + (r.unit ? ' / ' + esc(r.unit) : '') + ' (' + esc(r.supplier) + '): ' +
    unit(r.oldCents) + ' → ' + unit(r.newCents) + ' (+' + Math.round(r.permille / 10) + ' %)</li>').join('') + '</ul>' : '<span class="muted">žádné zdražení od 5 %</span>');
  h += '<h3>Po splatnosti</h3>' + (s.overdue.length ? '<div class="warn">' + s.overdueCount + ' za ' + kc(s.overdueCents) + '</div><ul>' + s.overdue.map(o => '<li>' + esc(o.supplier) + (o.number ? ' č. ' + esc(o.number) : '') + ': ' + kc(o.grossCents) +
    ', splatná ' + esc(short(o.dueDate)) + ' (' + o.days + (o.days === 1 ? ' den' : o.days <= 4 ? ' dny' : ' dní') + ')</li>').join('') + '</ul>' : '<span class="muted">nic po splatnosti</span>');
  if (s.foodCostAlert) h += '<div class="warn">Food cost ' + String(s.foodCostAlert.permille / 10).replace('.', ',') + ' % je nad hranicí ' + String(s.foodCostAlert.limitPermille / 10).replace('.', ',') + ' %</div>';
  h += '<h3>Splatné do 7 dní</h3>' + (s.dueSoon && s.dueSoon.length ? '<div>' + s.dueSoonCount + ' za ' + kc(s.dueSoonCents) + '</div><ul>' + s.dueSoon.map(o => '<li>' + esc(short(o.dueDate)) + ' ' + esc(o.supplier) + (o.number ? ' č. ' + esc(o.number) : '') + ': ' + kc(o.grossCents) +
    ' (' + (o.days === 0 ? 'dnes' : o.days === 1 ? 'zítra' : 'za ' + o.days + (o.days <= 4 ? ' dny' : ' dní')) + ')</li>').join('') + '</ul>' : '<span class="muted">nic k zaplacení</span>');
  if (s.unusual && s.unusual.length) h += '<h3>Neobvyklé nákupy za 30 dní</h3><ul>' + s.unusual.map(u => '<li class="warn">' + esc(short(u.date)) + ' ' + (u.kind === 'new_supplier' ? 'nový dodavatel <b>' + esc(u.supplier) + '</b> ' + kc(u.netCents) :
    '<b>' + esc(u.supplier) + '</b> ' + kc(u.netCents) + ' <span class="muted">(obvykle ' + kc(u.usualCents) + ')</span>') + '</li>').join('') + '</ul>';
  if (s.result) h += '<div>Provozní výsledek od ' + esc(short(m.from)) + ': <b>' + kc(s.result.resultCents) + '</b> <span class="muted">(tržby ' + kc(s.result.revenueCents) + ' − nákupy ' + kc(s.result.purchasesCents) +
    (s.result.payoutsCents ? ' − výplaty z kasy ' + kc(s.result.payoutsCents) : '') + '; hrubý odhad bez mezd mimo kasu a režií)</span></div>';
  if (s.duplicates && s.duplicates.length) h += '<div class="warn">Možná duplicitní faktury: ' + s.duplicates.map(d => esc(d.supplier) + ' ' + d.count + '× ' + kc(d.grossCents) + ' (' + esc(short(d.date)) + ')').join(' · ') + '</div>';
  if (s.margins && s.margins.rows.length) h += '<details><summary>Marže nápojů (' + s.margins.paired + ' spárováno s nákupem, ' + s.margins.unpaired + ' bez nákupu)</summary><div class="scroll"><table><tr><th>Nápoj</th><th class="n">Prodej bez DPH</th><th class="n">Nákup</th><th class="n">Marže</th><th>Nákup podle</th></tr>' +
    s.margins.rows.map(r => '<tr><td>' + esc(r.name) + ' <span class="muted">' + String(r.volumeMl / 1000).replace('.', ',') + ' l</span></td><td class="n">' + kc(r.priceNetCents) + '</td><td class="n">' + kc(r.costCents) + '</td><td class="n' + (r.marginPermille < 600 ? ' warn' : '') + '">' + Math.round(r.marginPermille / 10) + ' %</td><td class="muted">' +
      esc(r.purchase.name) + ' (' + esc(r.purchase.supplier) + ', ' + esc(short(r.purchase.date)) + ', ' + unit(r.purchase.perLitreCents) + '/l)</td></tr>').join('') + '</table></div><div class="muted">Párování podle názvu, DPH nápojů 21 %.</div></details>';
  if (s.monthCompare && s.monthCompare.length) h += '<details><summary>Proti minulému měsíci (stejné dny)</summary><table><tr><th>Kategorie</th><th class="n">Teď</th><th class="n">Minule</th><th class="n">Rozdíl</th></tr>' +
    s.monthCompare.map(c => '<tr><td>' + esc(c.name) + '</td><td class="n">' + kc(c.netCents) + '</td><td class="n muted">' + kc(c.previousCents) + '</td><td class="n' + (c.changeCents > 0 ? ' warn' : '') + '">' + (c.changeCents > 0 ? '+' : '') + kc(c.changeCents) + '</td></tr>').join('') + '</table></details>';
  if (m.byCategory.length) h += '<details><summary>Kategorie (' + m.byCategory.length + ')</summary><table>' + m.byCategory.map(c => '<tr><td>' + esc(c.name) + '</td><td class="n">' + kc(c.netCents) + '</td></tr>').join('') + '</table></details>';
  if (m.bySupplier.length) h += '<details><summary>Dodavatelé (' + m.bySupplier.length + ')</summary><table>' + m.bySupplier.map(c => '<tr><td>' + esc(c.name) + '</td><td class="n muted">' + c.invoices + '×</td><td class="n">' + kc(c.netCents) + '</td></tr>').join('') + '</table></details>';
  if (s.disabled.length) h += '<div class="muted">vypnuté zdroje: ' + esc(s.disabled.join(', ')) + '</div>';
  return h + '</div>';
}

// Who sends data to OKO1 and when it last arrived; a sender silent too long is marked.
function sourcesCard(s) {
  if (!s) return '';
  const rows = s.senders.map(x => '<tr><td>' + esc(x.name) + '</td><td class="n' + (x.silent ? ' warn' : '') + '">' + (x.lastSeen ? esc(x.lastSeen) : 'zatím nic') + (x.silent ? ' · neposílá' : '') + '</td></tr>')
    .concat(s.types.map(x => '<tr><td class="muted">' + esc(x.name) + '</td><td class="n muted">' + esc(x.lastReceived) + '</td></tr>'));
  if (s.report) rows.push('<tr><td>Report manažerů (OneDrive)</td><td class="n">' + esc(s.report.at) + (s.report.found ? '' : ' · <span class="warn">nenalezen</span>') + '</td></tr>');
  if (s.costs) rows.push('<tr><td>Náklady (iÚčto)</td><td class="n">' + esc(s.costs.at) + (s.costs.ok ? '' : ' · <span class="warn">chyba</span>') + '</td></tr>');
  return '<div class="card"><h2>Zdroje dat</h2>' + (rows.length ? '<table>' + rows.join('') + '</table>' : '<span class="muted">zatím žádný zdroj neposlal data</span>') + '</div>';
}

function render(data) {
  todoDate = data.businessDate;
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
  const ev = (b.events || []).length ? '<div>dnes akce: ' + b.events.map(e => esc(e.time) + ' ' + esc(e.label) + ' <b>' + esc(e.title) + '</b>' + (e.guests ? ' (' + hosts(e.guests) + ')' : '')).join(', ') + '</div>' : '';
  const pa = b.pendingAhead ? '<div class="warn">příštích 7 dní čeká na potvrzení ' + b.pendingAhead.count + ' (' + hosts(b.pendingAhead.guests) + '), nejbližší ' + esc(czDate(b.pendingAhead.first.date)) + ' ' + esc(b.pendingAhead.first.time) + '</div>' : '';
  if (!rv && (pa || ev)) cards.push('<div class="card"><h2>Rezervace</h2>' + ev + pa + '</div>');
  if (rv) cards.push('<div class="card"><h2>Rezervace</h2><div class="big">' + rv.day.confirmed + '</div><div class="muted">' + hosts(rv.day.guests) +
    (rv.day.noShows ? ' · <span class="warn">nedorazilo ' + rv.day.noShows + ' (' + hosts(rv.day.noShowGuests) + ')</span>' : '') + (rv.day.cancelled ? ' · zrušeno ' + rv.day.cancelled : '') + '</div>' +
    '<div>' + esc(czDate(shift(data.businessDate, 1))) + ': <b>' + rv.today.confirmed + '</b> (' + hosts(rv.today.guests) + ')' +
    (rv.today.bySection.length > 1 ? ' <span class="muted">' + rv.today.bySection.map(s => esc(s.label) + ' ' + s.confirmed).join(' · ') + '</span>' : '') +
    (rv.today.pending ? ' · <span class="warn">čeká ' + rv.today.pending + '</span>' : '') + '</div>' +
    (b.outlook && (b.outlook.usualGuests || b.outlook.planCents) ? '<div class="muted">' + [b.outlook.usualGuests ? 'obvykle za celý den ' + hosts(b.outlook.usualGuests) : '',
      b.outlook.planCents ? 'plán tržby ' + kc(b.outlook.planCents) : ''].filter(Boolean).join(' · ') + '</div>' : '') +
    ((rv.today.byHour || []).length ? '<div>nejvíc hostů: ' + rv.today.byHour.slice().sort((x, y) => y.guests - x.guests || (x.hour + 18) % 24 - (y.hour + 18) % 24).slice(0, 2)
      .sort((x, y) => (x.hour + 18) % 24 - (y.hour + 18) % 24).map(r => '<b>' + r.hour + '–' + (r.hour + 1) % 24 + ' h</b> ' + r.guests).join(', ') + '</div>' : '') +
    ((rv.today.groups || []).length ? '<div>skupiny: ' + rv.today.groups.map(g => esc(g.time) + ' ' + esc(g.label) + ' <b>' + g.partySize + '</b>').join(', ') + '</div>' : '') +
    (b.noShows && b.noShows.guests ? '<div class="muted">nedorazilo ' + Math.round(b.noShows.ratePermille / 10) + ' % rezervovaných hostů' + (b.noShows.usualPermille !== null ? ' (obvykle ' + Math.round(b.noShows.usualPermille / 10) + ' %)' : '') + '</div>' : '') +
    ev + pa + '</div>');
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
  html += '<div class="card" id="todo">' + todoCard(data.todo) + '</div>';
  html += '<div class="card"><h2>Posledních ' + data.days.length + ' dní</h2>' + chart(data.days, data.businessDate) + '<div class="muted">sloupec = tržba, čárka = plán (průměr stejného dne za 4 týdny)</div></div>';
  html += guestsCard(b.guestOutlook) + forecastCard(b.forecast) + weekCard(data.week) + eventsCard(data.eventRanking) + trendsCard(data.trends) + menuInterestCard(data.menuInterest) + monthCard(data.month) + suppliesCard(data.supplies) + menuCard(data.menu) + sourcesCard(data.sources);
  if (b.bySection.length) html += '<div class="card"><h2>Části podniku</h2><table>' + b.bySection.map(s => '<tr><td>' + esc(s.label) + '</td><td class="n">' + kc(s.revenueCents) + '</td><td class="n muted">' + (b.revenueCents ? Math.round(s.revenueCents / b.revenueCents * 100) : 0) + ' %</td></tr>').join('') + '</table></div>';
  if (b.notes) html += '<div class="card"><h2>Report dne</h2>' + (b.notes.raw ? '<p class="pre">' + esc(b.notes.raw) + '</p>' : (b.notes.summary ? '<p>' + esc(b.notes.summary) + '</p>' : '') + '<ul>' + b.notes.points.map(p => '<li class="' + (p.kind === 'incident' || p.kind === 'problem' ? 'warn' : '') + '">' + esc(({incident: 'Incident', problem: 'Problém', task: 'Úkol', info: 'Info'})[p.kind]) + ': ' + esc(p.text) + '</li>').join('') + '</ul>') + '</div>';
  if (r) {
    const kinds = {discount: 'Slevy a odpisy', expense: 'Výdaje z kasy', payout: 'Výplaty v hotovosti', movement: 'Vklady, odvody, karty', cash_count: 'Přepočet hotovosti', balance: 'Stavy', revenue_register: 'Pokladny klubu', journal_revenue: 'Tržby podle deníku', journal_payment: 'Platby podle deníku', total: 'Součty', unmapped: 'Nerozpoznané řádky'};
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
// One item over 26 weeks: price at the end of each week and pieces sold, as bars.
async function loadItem(query, id) {
  const box = $('itemBox');
  if (!box) return;
  const r = await fetch(base + '/item?q=' + encodeURIComponent(query) + (id ? '&id=' + encodeURIComponent(id) : '')).catch(() => null);
  if (r && r.status === 401) { $('app').hidden = true; $('login').hidden = false; return; }
  const t = r && r.ok ? await r.json().catch(() => null) : null;
  if (!t) { box.innerHTML = '<p class="warn">Položku teď nejde načíst.</p>'; return; }
  if (!t.item) { box.innerHTML = '<p class="muted">Žádná položka lístku neodpovídá.</p>'; return; }
  const short = d => Number(d.slice(8)) + '. ' + Number(d.slice(5, 7)) + '.';
  const most = Math.max(1, ...t.weeks.map(w => w.quantity));
  let h = (t.matches.length > 1 ? '<div class="muted">' + t.matches.map(x => x.itemId === t.item.itemId ? '<b>' + esc(x.name) + (x.volume ? ' ' + esc(x.volume) : '') + '</b>'
    : '<a href="#" data-item="' + esc(x.itemId) + '">' + esc(x.name) + (x.volume ? ' ' + esc(x.volume) : '') + '</a>').join(' · ') + '</div>' : '') +
    '<div><b>' + esc(t.item.name) + '</b> ' + esc(t.item.price) + ' <span class="muted">(' + esc(t.item.category) + ')</span></div>';
  // Bars = pieces per week, the line = price at the week's end (its own scale); SVG attributes pass the page's style policy.
  const W = 520, H = 140, bw = W / t.weeks.length, prices = t.weeks.map(w => w.priceCents).filter(p => p !== null);
  const low = prices.length ? Math.min(...prices) * 0.9 : 0, high = prices.length ? Math.max(...prices) * 1.05 : 1, py = p => H - 20 - (p - low) / Math.max(1, high - low) * (H - 30);
  let bars = '', line = '', labels = '';
  t.weeks.forEach((w, i) => {
    const bh = Math.max(0, w.quantity) / most * (H - 30), x = i * bw;
    bars += '<rect x="' + (x + 1) + '" y="' + (H - 20 - bh) + '" width="' + (bw - 2) + '" height="' + bh + '" fill="var(--bar)"><title>' + esc(short(w.week) + ': ' + w.quantity + ' ks, ' + kc(w.grossCents) + ', cena ' + kc(w.priceCents)) + '</title></rect>';
    if (w.priceCents !== null) line += (line ? ' L' : 'M') + (x + 1) + ' ' + py(w.priceCents) + ' L' + (x + bw - 1) + ' ' + py(w.priceCents);
    if (i % 4 === 0) labels += '<text x="' + x + '" y="' + (H - 6) + '" font-size="10" fill="var(--muted)">' + esc(short(w.week)) + '</text>';
  });
  h += '<svg viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Cena a prodej po týdnech">' + bars + '<path d="' + line + '" fill="none" stroke="var(--plan)" stroke-width="2"/>' + labels + '</svg>' +
    '<div class="muted">sloupce = prodané kusy za týden, čára = cena</div>';
  const changed = t.weeks.filter((w, i) => i && w.priceCents !== t.weeks[i - 1].priceCents);
  if (changed.length) h += '<div>Změny ceny: ' + changed.map(w => esc(short(w.week)) + ' ' + kc(w.priceCents)).join(', ') + '</div>';
  h += t.hasSales ? '' : '<div class="muted">prodej se ukáže s účty z pokladny</div>';
  box.innerHTML = h;
  box.querySelectorAll('a[data-item]').forEach(a => a.addEventListener('click', e => { e.preventDefault(); loadItem(query, a.dataset.item); }));
}
// The search sits in the menu card, which is drawn again with each day; its submit bubbles up to the content.
$('content').onsubmit = e => {
  if (e.target && e.target.id === 'itemForm') { e.preventDefault(); const q = $('itemQuery').value.trim(); if (q) loadItem(q, null); }
};
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
