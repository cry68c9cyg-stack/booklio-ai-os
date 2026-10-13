/**
 * The one look of the SMS code dialog: the dashboard login and connecting Claude (/oauth/authorize) use the same
 * card, fields and buttons. Scoped to `.login`, so the dashboard's own styles stay as they are. Needs the colour
 * variables --bg, --card, --text, --muted, --line, --accent, --warn and --note on :root.
 */
export const LOGIN_CSS = `.login{max-width:440px;margin:8vh auto;padding:16px;font-size:16px;line-height:1.5}
.login .card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:0}
.login h1{font-size:20px;margin:0 0 12px}.login form{display:grid;gap:8px}.login label{display:block}
.login input,.login button{font:inherit;padding:9px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--text)}
.login button{background:var(--accent);border-color:var(--accent);color:#fff;cursor:pointer}.login button.secondary{background:var(--card);color:var(--text);border-color:var(--line)}
.login button:disabled{opacity:.6;cursor:default}.login .again{margin-top:8px}.login .muted{color:var(--muted);font-size:14px}.login .warn{color:var(--warn)}
.login .notice{background:var(--note);padding:12px;border-radius:8px;font-weight:600;overflow-wrap:anywhere}
.login [hidden]{display:none}`;
