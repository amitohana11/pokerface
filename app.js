import { LOCAL_MODE, localApi, exportBackup, importBackup } from './local-api.js';

const $app = document.getElementById('app');
const $userbox = document.getElementById('userbox');
const $live = document.getElementById('live');
const $toast = document.getElementById('toast');

let me = null;
let view = null; // current view: { onEvent?(msg) }

const ROLE_LABEL = { owner: 'בעלים', admin: 'מנהל', player: 'שחקן' };

// ---------- helpers ----------

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = n => new Intl.NumberFormat('he-IL', { maximumFractionDigits: 2 }).format(n);
const initial = name => esc([...String(name).trim()][0] ?? '?');
const formData = form => Object.fromEntries(new FormData(form));

// Line icons (24x24, stroke-based, Lucide style).
const ICONS = {
  back: '<path d="m9 18 6-6-6-6"/>',                 // RTL: "back" points right
  forward: '<path d="m15 18-6-6 6-6"/>',             // RTL: "open" points left
  plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
  x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
  settings: '<path d="M20 7h-9"/><path d="M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  chart: '<path d="M3 3v18h18"/><path d="M18 17V9"/><path d="M13 17V5"/><path d="M8 17v-3"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  share: '<path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><path d="m16 6-4-4-4 4"/><path d="M12 2v13"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  alert: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
};
const icon = (name, cls = '') => `<svg class="ic ${cls}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;

function ratioText(t) {
  return `<b>${fmt(t.moneyAmount)} ${esc(t.currency)}</b> = <b>${fmt(t.chipAmount)}</b> צ'יפים`;
}

const toMoney = (s, chips) => (chips * s.moneyAmount) / s.chipAmount;
const money = (s, amount) => `${fmt(amount)} ${esc(s.currency)}`;
// Profit/loss with an explicit sign and colour class: "+250 ₪" / "-180 ₪".
const netHtml = (s, amount) => {
  const cls = Math.abs(amount) < 0.005 ? 'zero' : amount > 0 ? 'pos' : 'neg';
  return `<span class="net ${cls}"><span class="ltr">${amount > 0.005 ? '+' : ''}${fmt(amount)} ${esc(s.currency)}</span></span>`;
};

// End-of-night math. rows: [{ name, chips (bought in), final (chips left, or null), mustCount }]
function cashoutMath(s, rows) {
  const counted = rows.filter(r => r.final !== null).map(r => ({ ...r, net: toMoney(s, r.final - r.chips) }));
  const plus = counted.filter(r => r.net > 0.005);
  const minus = counted.filter(r => r.net < -0.005);
  const chipsIn = rows.reduce((a, r) => a + r.chips, 0);
  const chipsOut = rows.reduce((a, r) => a + (r.final ?? 0), 0);
  const diffChips = chipsOut - chipsIn;
  return {
    plus, minus,
    sumPlus: plus.reduce((a, r) => a + r.net, 0),
    sumMinus: minus.reduce((a, r) => a + r.net, 0),
    missing: rows.filter(r => r.mustCount && r.final === null).map(r => r.name),
    chipsIn, chipsOut, diffChips,
    balanced: Math.abs(diffChips) < 1e-6,
  };
}

function mismatchText(s, c) {
  const what = c.diffChips < 0 ? 'חסרים' : 'יש עודף של';
  return `${what} ${fmt(Math.abs(c.diffChips))} צ'יפים (${money(s, Math.abs(toMoney(s, c.diffChips)))})`;
}

// The three tiles: total pluses, total minuses, and the sum (which must be 0).
function summaryTiles(s, c) {
  return `
    <div class="stat plus"><div class="v">${netHtml(s, c.sumPlus)}</div><div class="l">פלוסים (${c.plus.length})</div></div>
    <div class="stat minus"><div class="v">${netHtml(s, c.sumMinus)}</div><div class="l">מינוסים (${c.minus.length})</div></div>
    <div class="stat"><div class="v">${c.missing.length ? '…' : netHtml(s, c.sumPlus + c.sumMinus)}</div><div class="l">סה"כ (צריך 0)</div></div>`;
}

// Server timestamps are UTC "YYYY-MM-DD HH:MM:SS".
const parseDate = s => new Date(s.replace(' ', 'T') + 'Z');
const fmtDate = s => parseDate(s).toLocaleDateString('he-IL', { weekday: 'long', day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtTime = s => parseDate(s).toLocaleTimeString('he-IL', { hour: '2-digit', minute: '2-digit' });
const fmtWeekday = s => parseDate(s).toLocaleDateString('he-IL', { weekday: 'long' });
const fmtShortDate = s => parseDate(s).toLocaleDateString('he-IL', { day: 'numeric', month: 'numeric', year: '2-digit' });

let toastTimer;
// `action` = { label, run } adds a button to the toast (used for "undo").
function toast(msg, kind = '', action = null) {
  $toast.innerHTML = `<span>${esc(msg)}</span>${action ? `<button class="toast-action">${esc(action.label)}</button>` : ''}`;
  $toast.className = `toast ${kind}`;
  $toast.hidden = false;
  if (action) {
    $toast.querySelector('button').onclick = () => { $toast.hidden = true; action.run(); };
  }
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $toast.hidden = true; }, action ? 6000 : 3500);
}

// In-page replacements for window.confirm / window.prompt. The native ones are silently
// blocked in some places (e.g. the in-app browsers of WhatsApp/Instagram/Facebook), where
// they return "cancel" without ever showing anything.
function openModal(message, { ok = 'אישור', cancel = 'ביטול', danger = false, input = null } = {}) {
  return new Promise(resolve => {
    const wrap = document.createElement('div');
    wrap.className = 'modal-backdrop';
    wrap.innerHTML = `
      <form class="modal" role="dialog" aria-modal="true">
        <p class="modal-text"></p>
        ${input ? '<input name="value" autocomplete="off">' : ''}
        <div class="row">
          <button type="submit" class="btn ${danger ? 'danger' : 'primary'} grow">${esc(ok)}</button>
          <button type="button" class="btn" data-cancel>${esc(cancel)}</button>
        </div>
      </form>`;
    wrap.querySelector('.modal-text').textContent = message;
    const form = wrap.querySelector('form');
    if (input) form.value.placeholder = input.placeholder ?? '';

    const done = value => {
      document.removeEventListener('keydown', onKey);
      wrap.remove();
      resolve(value);
    };
    const onKey = e => { if (e.key === 'Escape') done(input ? null : false); };
    form.addEventListener('submit', e => { e.preventDefault(); done(input ? form.value.value : true); });
    wrap.querySelector('[data-cancel]').onclick = () => done(input ? null : false);
    wrap.addEventListener('click', e => { if (e.target === wrap) done(input ? null : false); });
    document.addEventListener('keydown', onKey);

    document.body.append(wrap);
    (input ? form.value : form.querySelector('[type=submit]')).focus();
  });
}
const askConfirm = (message, opts) => openModal(message, opts);
const askText = (message, opts = {}) => openModal(message, { ...opts, input: { placeholder: opts.placeholder } });

async function api(method, url, body) {
  let status, data;
  if (LOCAL_MODE) {
    // "On this phone" mode: same API, answered in the browser. The JSON round-trip
    // makes sure views never hold references into the stored data.
    ({ status, data } = localApi(method, url, body ? JSON.parse(JSON.stringify(body)) : {}));
    data = data == null ? null : JSON.parse(JSON.stringify(data));
  } else {
    const res = await fetch(`/api${url}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    status = res.status;
    data = res.status === 204 ? null : await res.json().catch(() => null);
  }
  if (status >= 400) {
    const err = new Error(data?.error || 'משהו השתבש, נסה שוב');
    err.status = status;
    err.data = data;
    throw err;
  }
  return data;
}

function handleError(err) {
  if (err.status === 401) {
    setMe(null);
    go('/login');
    return;
  }
  toast(err.message || 'שגיאת רשת', 'error');
}

// Wraps a submit handler: prevents default, disables the button while running, reports errors.
function onSubmit(form, fn) {
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit], button:not([type])');
    if (btn) btn.disabled = true;
    try { await fn(formData(form)); } catch (err) { handleError(err); } finally { if (btn) btn.disabled = false; }
  });
}

// ---------- session / user ----------

function setMe(user) {
  me = user;
  if (me) {
    $userbox.innerHTML = `
      <span class="user-chip"><span class="avatar xs">${initial(me.displayName)}</span><span class="who">${esc(me.displayName)}</span></span>
      ${LOCAL_MODE ? '' : `<button class="icon-btn" id="logout" title="יציאה" aria-label="יציאה">${icon('logout')}</button>`}`;
    const $logout = $userbox.querySelector('#logout');
    if ($logout) $logout.onclick = async () => {
      try { await api('POST', '/auth/logout'); } catch {}
      setMe(null);
      go('/login');
    };
    connectRealtime();
  } else {
    $userbox.innerHTML = '';
    disconnectRealtime();
  }
}

// ---------- realtime ----------

let ws = null;
let wsRetry = 0;
let wsTimer = null;

function connectRealtime() {
  if (LOCAL_MODE) return; // single phone: nothing to sync with
  if (!me || (ws && ws.readyState <= WebSocket.OPEN)) return;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws`);
  ws = socket;
  let wasRetry = wsRetry > 0;
  socket.onopen = () => {
    wsRetry = 0;
    $live.classList.add('on');
    $live.title = 'מחובר לעדכונים בזמן אמת';
    // After a reconnect we may have missed events - refresh whatever is on screen.
    if (wasRetry) view?.onEvent?.({ type: 'resync' });
  };
  socket.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    view?.onEvent?.(msg);
  };
  socket.onclose = () => {
    if (ws !== socket) return;
    ws = null;
    $live.classList.remove('on');
    $live.title = 'לא מחובר לעדכונים בזמן אמת';
    if (me) {
      clearTimeout(wsTimer);
      wsTimer = setTimeout(connectRealtime, Math.min(10_000, 500 * 2 ** wsRetry++));
    }
  };
}

function disconnectRealtime() {
  clearTimeout(wsTimer);
  const socket = ws;
  ws = null;
  socket?.close();
  $live.classList.remove('on');
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') connectRealtime();
});

// ---------- router ----------

const routes = [
  [/^\/$/, viewHome, true],
  [/^\/login$/, viewLogin, false],
  [/^\/new$/, viewNewTable, true],
  [/^\/table\/(\d+)$/, viewTable, true],
  [/^\/table\/(\d+)\/settings$/, viewTableSettings, true],
  [/^\/table\/(\d+)\/new-session$/, viewNewSession, true],
  [/^\/table\/(\d+)\/stats$/, viewStats, true],
  [/^\/table\/(\d+)\/session\/(\d+)$/, viewSession, true],
  [/^\/table\/(\d+)\/session\/(\d+)\/(?:results|cashout)$/, viewResults, true],
  [/^\/join\/([A-Za-z0-9]+)$/, viewJoin, true],
];

function go(path) {
  if (location.hash === `#${path}`) router();
  else location.hash = path;
}

async function router() {
  const path = location.hash.replace(/^#/, '') || '/';
  view = null;
  for (const [re, fn, needsAuth] of routes) {
    const m = path.match(re);
    if (!m) continue;
    if (needsAuth && !me) {
      sessionStorage.setItem('afterLogin', path);
      return go('/login');
    }
    if (fn === viewLogin && me) return go('/');
    window.scrollTo(0, 0);
    try { view = (await fn(...m.slice(1))) ?? null; } catch (err) { handleError(err); }
    return;
  }
  go('/');
}

// ---------- views ----------

// Phone-only mode: no accounts or passwords - just a name, or restore a backup.
function viewLocalWelcome() {
  $app.innerHTML = `
    <div class="auth-hero">
      <img src="icons/icon-192.png" alt="" class="auth-logo">
      <h1>POKERFACE</h1>
      <p class="muted">מעקב כניסות ותוצאות לערבי פוקר עם החברים</p>
    </div>
    <section class="card narrow">
      <form class="stack">
        <label>איך קוראים לך?<input name="displayName" required maxlength="30" autocomplete="name"></label>
        <button class="btn primary block">בוא נתחיל</button>
      </form>
      <p class="muted small center" style="margin:16px 0 8px">יש לך קובץ גיבוי מהשרת או מטלפון קודם?</p>
      <label class="btn soft block">${icon('share')} שחזור מקובץ גיבוי<input type="file" accept=".json,application/json" hidden></label>
    </section>`;

  onSubmit($app.querySelector('form'), async d => {
    setMe(await api('POST', '/auth/register', d));
    go('/');
  });
  $app.querySelector('input[type=file]').addEventListener('change', e => restoreFromFile(e.target.files[0]));
}

async function restoreFromFile(file) {
  if (!file) return;
  try {
    importBackup(await file.text());
    setMe(await api('GET', '/auth/me'));
    toast('הנתונים שוחזרו', 'ok');
    go('/');
  } catch (err) {
    toast(err.message.includes('POKERFACE') ? err.message : 'לא הצלחתי לקרוא את הקובץ', 'error');
  }
}

function downloadBackup() {
  const blob = new Blob([exportBackup()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `pokerface-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function viewLogin() {
  if (LOCAL_MODE) return viewLocalWelcome();
  $app.innerHTML = `
    <div class="auth-hero">
      <img src="icons/icon-192.png" alt="" class="auth-logo">
      <h1>POKERFACE</h1>
      <p class="muted">מעקב כניסות ותוצאות לערבי פוקר עם החברים</p>
    </div>
    <section class="card narrow">
      <div class="tabs">
        <button data-tab="login" class="active">התחברות</button>
        <button data-tab="register">הרשמה</button>
      </div>
      <form id="f-login" class="stack">
        <label>שם משתמש<input name="username" autocomplete="username" autocapitalize="off" required></label>
        <label>סיסמה<input name="password" type="password" autocomplete="current-password" required></label>
        <button class="btn primary block">התחבר</button>
      </form>
      <form id="f-register" class="stack" hidden>
        <label>שם משתמש (באנגלית, בשביל התחברות)<input name="username" autocomplete="username" autocapitalize="off" required minlength="3" maxlength="20"></label>
        <label>שם לתצוגה (מה שהחברים יראו)<input name="displayName" required maxlength="30"></label>
        <label>סיסמה (לפחות 6 תווים)<input name="password" type="password" autocomplete="new-password" required minlength="6"></label>
        <button class="btn primary block">צור חשבון</button>
      </form>
    </section>`;

  const forms = { login: $app.querySelector('#f-login'), register: $app.querySelector('#f-register') };
  $app.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      $app.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
      for (const [k, f] of Object.entries(forms)) f.hidden = k !== b.dataset.tab;
    };
  });

  const afterAuth = user => {
    setMe(user);
    const next = sessionStorage.getItem('afterLogin') || '/';
    sessionStorage.removeItem('afterLogin');
    go(next);
  };
  onSubmit(forms.login, async d => afterAuth(await api('POST', '/auth/login', d)));
  onSubmit(forms.register, async d => afterAuth(await api('POST', '/auth/register', d)));
}

async function viewHome() {
  $app.innerHTML = `
    <div class="page-head">
      <div>
        <h1>השולחנות שלי</h1>
        <p class="muted small">היי ${esc(me.displayName)}, בחר שולחן או פתח חדש</p>
      </div>
      <a href="#/new" class="btn primary">${icon('plus')} שולחן חדש</a>
    </div>
    <div id="list"><p class="muted">טוען…</p></div>
    ${LOCAL_MODE ? `
      <h3 class="section-title">גיבוי ושחזור</h3>
      <section class="card">
        <p class="muted small" style="margin-top:0">כל הנתונים שמורים רק בטלפון הזה. כדאי לשמור קובץ גיבוי מדי פעם (למשל ב-Google Drive או בוואטסאפ לעצמך).</p>
        <div class="action-row" style="margin-top:0">
          <button class="btn soft" id="backup">${icon('copy')} שמור קובץ גיבוי</button>
          <label class="btn soft">${icon('share')} שחזור מגיבוי<input type="file" accept=".json,application/json" hidden id="restore"></label>
        </div>
      </section>` : ''}`;
  const $list = $app.querySelector('#list');
  if (LOCAL_MODE) {
    $app.querySelector('#backup').onclick = downloadBackup;
    $app.querySelector('#restore').addEventListener('change', async e => {
      const file = e.target.files[0];
      e.target.value = '';
      if (file && await askConfirm('לשחזר מהקובץ? כל הנתונים שבטלפון יוחלפו בנתונים מהגיבוי.', { ok: 'שחזר', danger: true })) {
        await restoreFromFile(file);
      }
    });
  }

  async function load() {
    const { tables } = await api('GET', '/tables');
    if (!$list.isConnected) return;
    if (!tables.length) {
      $list.innerHTML = `
        <div class="card empty">
          <img src="icons/icon-192.png" alt="" class="empty-logo">
          <p><b>עדיין אין לך שולחנות</b></p>
          <p class="muted small">${LOCAL_MODE ? 'צור שולחן חדש לקבוצת החברים שלך.' : 'צור שולחן חדש לקבוצת החברים שלך, או בקש מהבעלים של שולחן קיים קישור הזמנה.'}</p>
        </div>`;
      return;
    }
    $list.innerHTML = `<ul class="table-list">${tables.map(t => `
      <li><a href="#/table/${t.id}">
        <span class="table-mark">${initial(t.name)}</span>
        <span class="grow">
          <span class="name">${esc(t.name)}</span>
          <span class="meta">
            ${icon('users')} ${t.memberCount}
            <span class="dot-sep"></span>
            ${fmt(t.moneyAmount)} ${esc(t.currency)} = ${fmt(t.chipAmount)} צ'יפים
          </span>
        </span>
        <span class="list-end">
          ${t.openSessionId ? '<span class="badge live-badge"><i class="pulse-dot"></i>משחק פעיל</span>' : `<span class="badge ${t.myRole}">${ROLE_LABEL[t.myRole]}</span>`}
          ${icon('forward', 'chev')}
        </span>
      </a></li>`).join('')}</ul>`;
  }

  await load();
  return { onEvent: () => load().catch(handleError) };
}

function viewNewTable() {
  $app.innerHTML = `
    <a href="#/" class="back-link">${icon('back')} השולחנות שלי</a>
    <section class="card narrow">
      <h1>שולחן חדש</h1>
      <p class="muted small">שולחן = קבוצת החברים הקבועה שלך. בכל ערב משחק תפתחו בתוכו "ערב" חדש.</p>
      <form class="stack">
        <label>שם השולחן<input name="name" required maxlength="40" placeholder="למשל: פוקר של יום חמישי"></label>
        <div>
          <label>יחס צ'יפים לכסף</label>
          <div class="row">
            <label class="grow">כסף (₪)<input name="moneyAmount" type="number" min="0.01" step="any" value="100" required></label>
            <span style="padding-top:22px">=</span>
            <label class="grow">צ'יפים<input name="chipAmount" type="number" min="0.01" step="any" value="100" required></label>
          </div>
          <p class="muted small" id="per-chip"></p>
        </div>
        <label>גודל כניסה סטנדרטית (בצ'יפים)<input name="buyinChips" type="number" min="0.01" step="any" value="100" required></label>
        <p class="muted small" id="buyin-money"></p>
        <button class="btn primary block">צור שולחן</button>
      </form>
    </section>`;

  const form = $app.querySelector('form');
  const $per = $app.querySelector('#per-chip');
  const $buyinMoney = $app.querySelector('#buyin-money');
  const updatePer = () => {
    const m = Number(form.moneyAmount.value), c = Number(form.chipAmount.value), b = Number(form.buyinChips.value);
    const ok = m > 0 && c > 0;
    $per.textContent = ok ? `צ'יפ אחד שווה ${fmt(m / c)} ₪` : '';
    $buyinMoney.textContent = ok && b > 0 ? `כל כניסה = ${fmt(b)} צ'יפים = ${fmt((b * m) / c)} ₪` : '';
  };
  form.addEventListener('input', updatePer);
  updatePer();

  onSubmit(form, async d => {
    const { id } = await api('POST', '/tables', d);
    toast('השולחן נוצר!', 'ok');
    go(`/table/${id}`);
  });
}

async function viewTable(id) {
  $app.innerHTML = `
    <a href="#/" class="back-link">${icon('back')} השולחנות שלי</a>
    <div id="tv-head" class="page-hero"><p class="muted">טוען…</p></div>
    <section id="tv-sessions"></section>
    <h3 class="section-title" id="tv-count">חברים</h3>
    <section class="card list-card">
      <ul class="members" id="tv-members"></ul>
    </section>
    <div id="tv-invite" class="card" hidden></div>
    <section class="card" id="tv-add" hidden>
      <h2>הוספת שחקן</h2>
      <div class="tabs">
        <button data-mode="username" class="active">משתמש קיים</button>
        <button data-mode="guest">אורח (בלי חשבון)</button>
      </div>
      <form class="row">
        <input name="value" class="grow" required autocapitalize="off" placeholder="שם המשתמש שלו באפליקציה" style="margin:0">
        <button class="btn primary">הוסף</button>
      </form>
      <p class="muted small" id="tv-add-hint">השחקן יתווסף מיד, בלי שיצטרך לאשר.</p>
    </section>
    <div id="tv-leave" hidden><button class="btn danger block">עזוב את השולחן</button></div>`;

  const $head = $app.querySelector('#tv-head');
  const $sessions = $app.querySelector('#tv-sessions');
  const $invite = $app.querySelector('#tv-invite');
  const $members = $app.querySelector('#tv-members');
  const $count = $app.querySelector('#tv-count');
  const $add = $app.querySelector('#tv-add');
  const $leave = $app.querySelector('#tv-leave');
  let data, sessions;

  async function load() {
    try {
      [data, { sessions }] = await Promise.all([api('GET', `/tables/${id}`), api('GET', `/tables/${id}/sessions`)]);
    } catch (err) {
      if (err.status === 404) { toast('השולחן לא נמצא או שאינך חבר בו', 'error'); go('/'); return; }
      throw err;
    }
    if ($head.isConnected) draw();
  }

  function draw() {
    const { table, myRole, myMemberId, members } = data;
    const isOwner = myRole === 'owner';

    $head.innerHTML = `
      <div class="row between" style="align-items:flex-start">
        <div class="grow">
          <h1>${esc(table.name)}</h1>
          <div class="pills">
            <span class="pill">${fmt(table.moneyAmount)} ${esc(table.currency)} = ${fmt(table.chipAmount)} צ'יפים</span>
            <span class="pill">כניסה ${fmt(table.buyinChips)} (${money(table, toMoney(table, table.buyinChips))})</span>
            <span class="badge ${myRole}">${ROLE_LABEL[myRole]}</span>
          </div>
        </div>
      </div>
      <div class="action-row">
        <a class="btn soft" href="#/table/${table.id}/stats">${icon('chart')} טבלת מעקב</a>
        ${isOwner ? `<a class="btn soft" href="#/table/${table.id}/settings">${icon('settings')} הגדרות</a>` : ''}
      </div>`;

    const open = sessions.find(s => s.status === 'open');
    const past = sessions.filter(s => s !== open);
    const canOpen = myRole !== 'player';
    $sessions.innerHTML = `
      <h3 class="section-title">ערבי משחק</h3>
      ${open ? `
        <a class="open-session" href="#/table/${table.id}/session/${open.id}">
          <span class="grow">
            <span class="live-label"><i class="pulse-dot"></i>משחק פעיל עכשיו</span>
            <span class="meta">${open.playerCount} שחקנים · ${open.entryCount} כניסות · קופה ${fmt(open.totalChips)}</span>
          </span>
          <span class="open-cta">כניסה לשולחן ${icon('forward')}</span>
        </a>`
      : canOpen ? `<a class="btn primary block big" href="#/table/${table.id}/new-session">${icon('plus')} פתח ערב משחק חדש</a>`
      : '<p class="muted small">אין משחק פעיל כרגע.</p>'}
      ${past.length ? `
        <div class="card list-card" style="margin-top:12px">
          <ul class="session-list">${past.map(s => `
            <li><a href="#/table/${table.id}/session/${s.id}">
              <span class="date-box"><b>${esc(fmtShortDate(s.startedAt))}</b></span>
              <span class="grow">
                <span class="name">${esc(fmtWeekday(s.startedAt))}</span>
                <span class="meta">${s.playerCount} שחקנים · קופה ${money(s, s.totalMoney)}</span>
              </span>
              ${s.myNet !== null ? netHtml(s, s.myNet) : ''}
              ${icon('forward', 'chev')}
            </a></li>`).join('')}
          </ul>
        </div>` : ''}`;

    if (table.inviteCode) {
      const link = `${location.origin}/#/join/${table.inviteCode}`;
      $invite.hidden = false;
      $invite.innerHTML = `
        <div class="row between">
          <h2 style="margin:0">הזמנת חברים</h2>
          <span class="code">${esc(table.inviteCode)}</span>
        </div>
        <p class="muted small">שלח את הקישור לחברים. מי שיפתח אותו יתבקש לאשר הצטרפות.</p>
        <div class="invite-box">
          <span class="invite-link">${icon('link')}<input readonly value="${esc(link)}" aria-label="קישור הזמנה"></span>
          <button class="btn soft" data-act="copy">${icon('copy')} העתק</button>
          ${navigator.share ? `<button class="btn soft" data-act="share">${icon('share')} שתף</button>` : ''}
        </div>`;
      $invite.querySelector('[data-act=copy]').onclick = async () => {
        const input = $invite.querySelector('input');
        try { await navigator.clipboard.writeText(link); } catch { input.select(); document.execCommand('copy'); }
        toast('הקישור הועתק', 'ok');
      };
      const shareBtn = $invite.querySelector('[data-act=share]');
      if (shareBtn) shareBtn.onclick = () => navigator.share({ title: `הצטרפות ל${table.name}`, url: link }).catch(() => {});
    } else {
      $invite.hidden = true;
    }

    $count.textContent = `חברים (${members.length})`;
    $members.innerHTML = members.map(m => {
      const sub = m.isGuest ? 'אורח · בלי חשבון' : `<span class="ltr">@${esc(m.username)}</span>`;
      const me_ = m.id === myMemberId ? ' <span class="muted small">(אני)</span>' : '';
      let controls = `<span class="badge ${m.role}">${ROLE_LABEL[m.role]}</span>`;
      if (isOwner && m.role !== 'owner') {
        controls = `
          ${m.isGuest ? controls : `
            <select data-act="role" data-id="${m.id}" aria-label="תפקיד">
              <option value="player" ${m.role === 'player' ? 'selected' : ''}>שחקן</option>
              <option value="admin" ${m.role === 'admin' ? 'selected' : ''}>מנהל</option>
            </select>`}
          <button class="icon-btn danger" data-act="remove" data-id="${m.id}" data-name="${esc(m.name)}" aria-label="הסר את ${esc(m.name)}" title="הסר">${icon('x')}</button>`;
      }
      return `
        <li>
          <span class="avatar">${initial(m.name)}</span>
          <div class="grow"><div class="name">${esc(m.name)}${me_}</div><div class="muted small">${sub}</div></div>
          ${controls}
        </li>`;
    }).join('');

    $add.hidden = !isOwner;
    $leave.hidden = isOwner;
  }

  // Member actions (event delegation - the list is re-rendered on every update)
  $members.addEventListener('change', async e => {
    const sel = e.target.closest('select[data-act=role]');
    if (!sel) return;
    try {
      await api('PATCH', `/tables/${id}/members/${sel.dataset.id}`, { role: sel.value });
      toast('התפקיד עודכן', 'ok');
    } catch (err) { handleError(err); }
    load().catch(handleError);
  });
  $members.addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act=remove]');
    if (!btn || !(await askConfirm(`להסיר את ${btn.dataset.name} מהשולחן?`, { ok: 'הסר', danger: true }))) return;
    try {
      await api('DELETE', `/tables/${id}/members/${btn.dataset.id}`);
      toast('השחקן הוסר', 'ok');
      await load();
    } catch (err) { handleError(err); }
  });

  // Add player form
  let mode = 'username';
  const addForm = $add.querySelector('form');
  if (LOCAL_MODE) {
    // Phone-only mode has no other accounts: every player is added by name.
    mode = 'guest';
    $add.querySelector('.tabs').hidden = true;
    addForm.value.placeholder = 'שם השחקן';
    $add.querySelector('#tv-add-hint').hidden = true;
  }
  $add.querySelectorAll('.tabs button').forEach(b => {
    b.onclick = () => {
      mode = b.dataset.mode;
      $add.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('active', x === b));
      addForm.value.placeholder = mode === 'username' ? 'שם המשתמש שלו באפליקציה' : 'שם האורח';
      $add.querySelector('#tv-add-hint').textContent = mode === 'username'
        ? 'השחקן יתווסף מיד, בלי שיצטרך לאשר.'
        : 'לחברים שלא מתקינים את האפליקציה - תוכלו לרשום עבורם buy-ins.';
      addForm.value.focus();
    };
  });
  onSubmit(addForm, async d => {
    await api('POST', `/tables/${id}/members`, mode === 'username' ? { username: d.value } : { guestName: d.value });
    addForm.reset();
    toast('השחקן נוסף', 'ok');
    await load();
  });

  $leave.querySelector('button').onclick = async () => {
    if (!(await askConfirm('לעזוב את השולחן?', { ok: 'עזוב', danger: true }))) return;
    try {
      await api('DELETE', `/tables/${id}/members/${data.myMemberId}`);
      toast('עזבת את השולחן');
      go('/');
    } catch (err) { handleError(err); }
  };

  await load();
  return {
    onEvent(msg) {
      if (msg.type === 'table-deleted' && msg.tableId == id) { toast('השולחן נמחק על ידי הבעלים'); go('/'); return; }
      if (msg.type === 'resync' || msg.tableId == id) load().catch(handleError);
    },
  };
}

async function viewTableSettings(id) {
  const { table, myRole } = await api('GET', `/tables/${id}`);
  if (myRole !== 'owner') { toast('רק הבעלים יכול לשנות הגדרות', 'error'); go(`/table/${id}`); return; }

  $app.innerHTML = `
    <a href="#/table/${id}" class="back-link">${icon('back')} חזרה לשולחן</a>
    <section class="card">
      <h2>הגדרות שולחן</h2>
      <form class="stack" id="f-settings">
        <label>שם השולחן<input name="name" required maxlength="40" value="${esc(table.name)}"></label>
        <div class="row">
          <label class="grow">כסף (${esc(table.currency)})<input name="moneyAmount" type="number" min="0.01" step="any" required value="${table.moneyAmount}"></label>
          <span style="padding-top:22px">=</span>
          <label class="grow">צ'יפים<input name="chipAmount" type="number" min="0.01" step="any" required value="${table.chipAmount}"></label>
        </div>
        <label>גודל כניסה סטנדרטית (בצ'יפים)<input name="buyinChips" type="number" min="0.01" step="any" required value="${table.buyinChips}"></label>
        <p class="muted small">שינוי ביחס או בגודל הכניסה חל רק על ערבים חדשים. ערבים קיימים שומרים על ההגדרות מהרגע שבו נפתחו.</p>
        <button class="btn primary block">שמור</button>
      </form>
    </section>
    <section class="card" ${LOCAL_MODE ? 'hidden' : ''}>
      <h2>קוד הזמנה</h2>
      <p class="muted small">הקוד הנוכחי: <span class="code">${esc(table.inviteCode)}</span>. יצירת קוד חדש תבטל את הקישור הישן.</p>
      <button class="btn" id="regen">צור קוד הזמנה חדש</button>
    </section>
    <section class="card danger-zone">
      <h2>מחיקת השולחן</h2>
      <p class="muted small">מוחק את השולחן לצמיתות עבור כל החברים. אי אפשר לבטל.</p>
      <button class="btn danger" id="delete">מחק שולחן</button>
    </section>`;

  onSubmit($app.querySelector('#f-settings'), async d => {
    await api('PATCH', `/tables/${id}`, d);
    toast('נשמר', 'ok');
    go(`/table/${id}`);
  });
  $app.querySelector('#regen').onclick = async () => {
    if (!(await askConfirm('ליצור קוד חדש? הקישור הישן יפסיק לעבוד.', { ok: 'צור קוד חדש' }))) return;
    try {
      const { inviteCode } = await api('POST', `/tables/${id}/invite-code`);
      $app.querySelector('.code').textContent = inviteCode;
      toast('נוצר קוד חדש', 'ok');
    } catch (err) { handleError(err); }
  };
  $app.querySelector('#delete').onclick = async () => {
    const typed = await askText(`כדי למחוק, הקלד את שם השולחן: ${table.name}`, { ok: 'מחק שולחן', danger: true, placeholder: table.name });
    if (typed === null) return;
    if (typed.trim() !== table.name) { toast('השם לא תואם - השולחן לא נמחק', 'error'); return; }
    try {
      await api('DELETE', `/tables/${id}`);
      toast('השולחן נמחק');
      go('/');
    } catch (err) { handleError(err); }
  };

  return {
    onEvent(msg) {
      if (msg.type === 'table-deleted' && msg.tableId == id) go('/');
    },
  };
}

async function viewNewSession(id) {
  const { table, myRole, myMemberId, members } = await api('GET', `/tables/${id}`);
  if (myRole === 'player') { toast('רק בעלים או מנהל יכולים לפתוח ערב', 'error'); go(`/table/${id}`); return; }

  $app.innerHTML = `
    <a href="#/table/${id}" class="back-link">${icon('back')} חזרה לשולחן</a>
    <section class="card">
      <h1>ערב משחק חדש</h1>
      <p class="muted small">${esc(table.name)} · ${fmt(table.moneyAmount)} ${esc(table.currency)} = ${fmt(table.chipAmount)} צ'יפים · כניסה = ${fmt(table.buyinChips)} צ'יפים</p>
      <form>
        <div class="row between">
          <h2 style="margin:0">מי משחק הערב?</h2>
          <button type="button" class="btn small link" id="toggle-all">בחר הכל</button>
        </div>
        <ul class="pick-list">${members.map(m => `
          <li><label class="pick">
            <input type="checkbox" value="${m.id}" ${m.id === myMemberId ? 'checked' : ''}>
            <span class="avatar">${initial(m.name)}</span>
            <span class="grow">${esc(m.name)}${m.isGuest ? ' <span class="muted small">(אורח)</span>' : ''}</span>
          </label></li>`).join('')}
        </ul>
        <button class="btn primary block" type="submit" id="start">פתח ערב</button>
      </form>
    </section>`;

  const form = $app.querySelector('form');
  const boxes = [...form.querySelectorAll('input[type=checkbox]')];
  const $start = $app.querySelector('#start');
  const $toggle = $app.querySelector('#toggle-all');
  const update = () => {
    const n = boxes.filter(b => b.checked).length;
    $start.textContent = `פתח ערב עם ${n} שחקנים`;
    $toggle.textContent = n === boxes.length ? 'נקה הכל' : 'בחר הכל';
  };
  form.addEventListener('change', update);
  $toggle.onclick = () => {
    const all = boxes.every(b => b.checked);
    boxes.forEach(b => { b.checked = !all; });
    update();
  };
  update();

  onSubmit(form, async () => {
    const memberIds = boxes.filter(b => b.checked).map(b => Number(b.value));
    const { id: sid } = await api('POST', `/tables/${id}/sessions`, { memberIds });
    toast('הערב נפתח - בהצלחה!', 'ok');
    go(`/table/${id}/session/${sid}`);
  });
}

// Game-night screen drawn as a poker table: every participant sits in a seat around the felt,
// the pot is in the middle. Tapping a seat opens that player's panel (buy-in / rebuy,
// chips left at the end, their entries).
async function viewSession(tid, sid) {
  $app.innerHTML = `
    <div class="row between">
      <a href="#/table/${tid}" class="back-link">${icon('back')} חזרה לשולחן</a>
      <span class="badge live-badge"><i class="pulse-dot"></i>משחק פעיל</span>
    </div>
    <div class="poker-table" id="sv-table">
      <div class="felt"><div class="pot" id="sv-pot"></div></div>
      <div id="sv-seats"></div>
    </div>
    <p class="muted small center">לחץ על שחקן כדי לרשום כניסה או להזין כמה צ'יפים נשארו לו בסוף.</p>
    <div id="sv-summary" class="stats"></div>
    <div id="sv-balance" class="balance" hidden></div>
    <div class="row" style="margin-bottom:14px">
      <button id="sv-add" class="btn soft grow" hidden>${icon('plus')} הוסף שחקן</button>
      <button id="sv-end" class="btn primary grow" hidden>${icon('flag')} סיום ערב</button>
    </div>
    <p id="sv-end-note" class="muted small" hidden>רק בעלים או מנהל יכולים לסיים את הערב.</p>
    <details class="card log-card">
      <summary><span class="row" style="gap:8px">יומן כניסות <span class="badge" id="sv-log-count">0</span></span></summary>
      <ul class="log" id="sv-log"></ul>
    </details>
    <div id="sv-danger" hidden><button class="btn danger block">מחק את הערב</button></div>
    <div id="sv-sheet" class="sheet-backdrop" hidden><div class="sheet" role="dialog" aria-modal="true"></div></div>`;

  const $pot = $app.querySelector('#sv-pot');
  const $seats = $app.querySelector('#sv-seats');
  const $summary = $app.querySelector('#sv-summary');
  const $balance = $app.querySelector('#sv-balance');
  const $add = $app.querySelector('#sv-add');
  const $end = $app.querySelector('#sv-end');
  const $endNote = $app.querySelector('#sv-end-note');
  const $log = $app.querySelector('#sv-log');
  const $logCount = $app.querySelector('#sv-log-count');
  const $danger = $app.querySelector('#sv-danger');
  const $sheetWrap = $app.querySelector('#sv-sheet');
  const $sheet = $sheetWrap.querySelector('.sheet');
  const resultsPath = `/table/${tid}/session/${sid}/results`;

  let data;
  let sheetFor = null;        // memberId whose panel is open, 'add' for the add-player panel, or null
  const lastChips = new Map(); // memberId -> chips, to flash a seat when someone buys in

  const isAdmin = () => data.myRole !== 'player';
  const canActFor = memberId => isAdmin() || memberId === data.myMemberId;
  const player = memberId => data.players.find(p => p.memberId === memberId);
  const entriesText = n => n === 0 ? 'עוד לא נכנס' : n === 1 ? 'כניסה אחת' : `${n} כניסות`;
  const shortChips = n => n >= 100000 ? `${fmt(Math.round(n / 1000))}K` : fmt(n);

  async function load() {
    try {
      data = await api('GET', `/tables/${tid}/sessions/${sid}`);
    } catch (err) {
      if (err.status === 404) { toast('הערב לא נמצא (אולי נמחק)', 'error'); go(`/table/${tid}`); return; }
      throw err;
    }
    if (!$seats.isConnected) return;
    // A finished night is locked: only the read-only results page is available.
    if (data.session.status !== 'open') { go(resultsPath); return; }
    draw();
  }

  // Seats in a fixed order (who joined the night first); "me" is rotated to the bottom-center seat.
  function seatOrder() {
    const list = [...data.players].sort((a, b) => a.addedAt.localeCompare(b.addedAt) || a.memberId - b.memberId);
    const mine = list.findIndex(p => p.memberId === data.myMemberId);
    return mine > 0 ? [...list.slice(mine), ...list.slice(0, mine)] : list;
  }

  function draw() {
    const { session: s, totals, myMemberId } = data;

    $pot.innerHTML = `
      <div class="pot-chips" aria-hidden="true"><i></i><i></i><i></i></div>
      <div class="pot-label">קופה</div>
      <div class="pot-value">${fmt(totals.chips)}</div>
      <div class="pot-money">${money(s, totals.money)} · ${totals.entries} כניסות</div>
      <div class="pot-date">${esc(data.tableName)} · ${esc(fmtDate(s.startedAt))}</div>`;

    const seats = seatOrder();
    const n = seats.length;
    $seats.innerHTML = seats.map((p, i) => {
      // Spread seats evenly on an ellipse, starting at the bottom center (90° in screen coordinates).
      const angle = Math.PI / 2 + (i * 2 * Math.PI) / n;
      const x = 50 + 43 * Math.cos(angle);
      const y = 50 + 44 * Math.sin(angle);
      const grew = lastChips.has(p.memberId) && p.chips > lastChips.get(p.memberId);
      const counted = p.finalChips !== null;
      return `
        <button class="seat${p.memberId === myMemberId ? ' me' : ''}${p.entries === 0 ? ' idle' : ''}${grew ? ' pulse' : ''}"
                data-seat="${p.memberId}" style="left:${x}%;top:${y}%"
                aria-label="${esc(p.name)}, ${entriesText(p.entries)}, ${fmt(p.chips)} צ'יפים">
          <span class="seat-avatar">${initial(p.name)}${p.entries > 1 ? `<span class="seat-count">×${p.entries}</span>` : ''}</span>
          <span class="seat-name">${esc(p.name)}</span>
          <span class="seat-stack"><i class="chip-dot"></i>${shortChips(p.chips)}</span>
          ${counted ? `<span class="seat-net">${netHtml(s, p.net)}</span>` : ''}
        </button>`;
    }).join('');
    for (const p of data.players) lastChips.set(p.memberId, p.chips);

    $add.hidden = !(isAdmin() && data.notPlaying.length > 0);
    $end.hidden = !isAdmin();
    $endNote.hidden = isAdmin();
    $danger.hidden = data.myRole !== 'owner';
    drawLog();
    drawCount();
    if (pointerInSheet) sheetRenderPending = true; // don't swap buttons under a finger mid-tap
    else renderSheet();
  }

  function renderSheet() {
    if (sheetFor === 'add') renderAddSheet();
    else if (sheetFor === 'count') renderCountSheet();
    else if (sheetFor !== null) player(sheetFor) ? renderPlayerSheet() : closeSheet();
  }

  // Tapping a button right after typing blurs the input, which saves and redraws the panel.
  // If that redraw replaced the button between press and release, the tap would be lost -
  // so while a finger/mouse is down in the panel, the redraw waits until it's released.
  let pointerInSheet = false;
  let sheetRenderPending = false;
  $sheetWrap.addEventListener('pointerdown', () => { pointerInSheet = true; });
  document.addEventListener('pointerup', function onUp() {
    if (!$sheetWrap.isConnected) return document.removeEventListener('pointerup', onUp);
    // Runs after this tap's click event has been handled.
    setTimeout(() => {
      pointerInSheet = false;
      if (sheetRenderPending) { sheetRenderPending = false; renderSheet(); }
    }, 0);
  });

  function drawLog() {
    const { session: s, entries, myMemberId } = data;
    $logCount.textContent = entries.length;
    $log.innerHTML = entries.length ? entries.map(e => {
      const canDel = isAdmin() || (e.memberId === myMemberId && e.createdById === me.id);
      const kind = e.number === 1 ? 'כניסה ראשונה' : `כניסה ${e.number}`;
      const by = e.createdByName && e.createdByName !== e.name ? ` · נרשם ע"י ${esc(e.createdByName)}` : '';
      return `
        <li>
          <span class="time">${fmtTime(e.createdAt)}</span>
          <div class="grow">
            <b>${esc(e.name)}</b> · ${kind}
            <div class="muted small">${fmt(e.chips)} צ'יפים (${money(s, e.money)})${by}</div>
          </div>
          ${canDel ? `<button class="icon-btn" data-del="${e.id}" aria-label="מחק כניסה" title="מחק">${icon('trash')}</button>` : ''}
        </li>`;
    }).join('') : '<li class="muted small">עוד אין כניסות.</li>';
  }

  // End-of-night counts: saved values, overridden by whatever is typed in the open panel
  // (one player's panel, or the "count everyone" panel).
  function liveCount() {
    const typed = new Map([...$sheet.querySelectorAll('[data-final]')].map(i => [Number(i.dataset.final), i.value.trim()]));
    const rows = data.players.map(p => {
      const raw = typed.get(p.memberId);
      const final = raw === undefined ? p.finalChips : raw === '' ? null : Number(raw);
      return { memberId: p.memberId, name: p.name, chips: p.chips, mustCount: p.mustCount, final };
    });
    return { rows, c: cashoutMath(data.session, rows) };
  }

  function balanceInfo(c) {
    const s = data.session;
    if (c.missing.length) return { cls: 'pending', text: `נספרו ${fmt(c.chipsOut)} מתוך ${fmt(c.chipsIn)} צ'יפים · עוד לא הזינו: ${c.missing.map(esc).join(', ')}` };
    if (c.balanced) return { cls: 'ok', text: `✓ נספרו ${fmt(c.chipsOut)} מתוך ${fmt(c.chipsIn)} צ'יפים. הסכום מתאזן, אפשר לסיים את הערב.` };
    return { cls: 'bad', text: `${icon('alert')} אי-התאמה: ${mismatchText(s, c)}. כדאי לספור שוב.` };
  }

  function drawCount() {
    const s = data.session;
    const { rows, c } = liveCount();
    const anyCounted = rows.some(r => r.final !== null);
    $summary.hidden = !anyCounted;
    $balance.hidden = !anyCounted;
    if (!anyCounted) return;
    $summary.innerHTML = summaryTiles(s, c);
    const { cls, text } = balanceInfo(c);
    $balance.className = `balance ${cls}`;
    $balance.innerHTML = text;
  }

  // ---------- bottom sheet ----------

  function openSheet(what) {
    sheetFor = what;
    $sheetWrap.hidden = false;
    document.body.classList.add('no-scroll');
    if (what === 'add') renderAddSheet();
    else if (what === 'count') renderCountSheet();
    else renderPlayerSheet();
  }

  function closeSheet() {
    sheetFor = null;
    $sheetWrap.hidden = true;
    $sheet.innerHTML = '';
    document.body.classList.remove('no-scroll');
    drawCount();
  }

  function renderPlayerSheet() {
    const s = data.session;
    const p = player(sheetFor);
    const act = canActFor(p.memberId);
    const mine = p.memberId === data.myMemberId;

    // A realtime redraw must not wipe out a number being typed.
    const focused = $sheet.contains(document.activeElement) && document.activeElement.name
      ? { name: document.activeElement.name, value: document.activeElement.value } : null;

    const myEntries = data.entries.filter(e => e.memberId === p.memberId);
    $sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="row sheet-head">
        <span class="avatar${mine ? ' mine' : ''}">${initial(p.name)}</span>
        <div class="grow">
          <b>${esc(p.name)}</b>${mine ? ' <span class="muted small">(אני)</span>' : ''}
          <div class="muted small">${entriesText(p.entries)} · ${fmt(p.chips)} צ'יפים (${money(s, p.money)})</div>
        </div>
        <button class="icon-btn" data-close aria-label="סגור">${icon('x')}</button>
      </div>

      ${act ? `
        <section class="sheet-section">
          <button class="btn primary block big" data-buyin="${s.buyinChips}">
            + ${p.entries === 0 ? 'כניסה' : 'כניסה נוספת'} · ${fmt(s.buyinChips)} צ'יפים (${money(s, toMoney(s, s.buyinChips))})
          </button>
          <div class="row" style="margin-top:8px">
            <button class="btn small" data-buyin="${s.buyinChips / 2}">½ כניסה</button>
            <button class="btn small" data-buyin="${s.buyinChips * 2}">2 כניסות</button>
            <input name="custom" type="number" min="0.01" step="any" inputmode="decimal" placeholder="סכום אחר" class="grow" style="margin:0">
            <button class="btn small" data-custom>הוסף</button>
          </div>
          <div class="muted small" data-custom-money></div>
        </section>` : '<p class="muted small">רק מנהל או השחקן עצמו יכולים לעדכן את השחקן הזה.</p>'}

      <section class="sheet-section">
        <label for="sheet-final">נשאר בסוף המשחק (צ'יפים)</label>
        <div class="row">
          <input id="sheet-final" name="final" data-final="${p.memberId}" type="number" min="0" step="any" inputmode="decimal"
                 class="grow" style="margin:0" placeholder="כמה צ'יפים נשארו?" value="${p.finalChips ?? ''}" ${act ? '' : 'disabled'}>
          <span class="sheet-net" data-final-net></span>
        </div>
      </section>

      <section class="sheet-section">
        <div class="muted small" style="margin-bottom:4px">הכניסות של ${esc(p.name)}</div>
        <ul class="log">${myEntries.length ? myEntries.map(e => `
          <li>
            <span class="time">${fmtTime(e.createdAt)}</span>
            <div class="grow">${e.number === 1 ? 'כניסה ראשונה' : `כניסה ${e.number}`} · ${fmt(e.chips)} צ'יפים (${money(s, e.money)})</div>
            ${isAdmin() || (mine && e.createdById === me.id) ? `<button class="icon-btn" data-del="${e.id}" aria-label="מחק כניסה" title="מחק">${icon('trash')}</button>` : ''}
          </li>`).join('') : '<li class="muted small">עוד אין כניסות.</li>'}
        </ul>
      </section>

      ${isAdmin() && p.entries === 0 ? '<button class="btn danger block" data-removep>הוצא מהערב</button>' : ''}`;

    if (focused) {
      const el = $sheet.querySelector(`[name="${focused.name}"]`);
      if (el && !el.disabled) { el.value = focused.value; el.focus(); }
    }
    updateSheetPreviews();
  }

  function updateSheetPreviews() {
    const s = data.session;
    const p = player(sheetFor);
    if (!p) return;
    const finalInput = $sheet.querySelector('[data-final]');
    const netEl = $sheet.querySelector('[data-final-net]');
    if (finalInput && netEl) {
      const raw = finalInput.value.trim();
      netEl.innerHTML = raw === '' ? '' : netHtml(s, toMoney(s, Number(raw) - p.chips));
    }
    const custom = $sheet.querySelector('[name=custom]');
    const customMoney = $sheet.querySelector('[data-custom-money]');
    if (custom && customMoney) {
      const c = Number(custom.value);
      customMoney.textContent = c > 0 ? `= ${fmt(toMoney(s, c))} ${s.currency}` : '';
    }
    drawCount();
  }

  // "Count everyone": one list with every player's end-of-night chips. "Next" on the keyboard
  // jumps to the next player; totals and the balance check update while typing.
  function renderCountSheet() {
    const s = data.session;
    const focused = $sheet.contains(document.activeElement) && document.activeElement.dataset?.final
      ? { id: document.activeElement.dataset.final, value: document.activeElement.value } : null;
    const seats = seatOrder();
    const editable = seats.filter(p => canActFor(p.memberId));
    const lastEditable = editable.at(-1)?.memberId;

    $sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="row sheet-head">
        <div class="grow">
          <b>ספירת צ'יפים, סוף הערב</b>
          <div class="muted small">הזן כמה צ'יפים נשארו לכל שחקן. "הבא" במקלדת עובר לשחקן הבא.</div>
        </div>
        <button class="icon-btn" data-close aria-label="סגור">${icon('x')}</button>
      </div>
      <div class="count-rows">${seats.map(p => `
        <label class="count-row${p.memberId === data.myMemberId ? ' me' : ''}">
          <span class="avatar">${initial(p.name)}</span>
          <span class="grow">
            <span class="name">${esc(p.name)}</span>
            <span class="meta">נכנס ${fmt(p.chips)} (${money(s, p.money)})</span>
          </span>
          <input type="number" min="0" step="any" inputmode="decimal" class="count-input"
                 data-final="${p.memberId}" value="${p.finalChips ?? ''}" placeholder="${p.mustCount ? "צ'יפים" : '0'}"
                 enterkeyhint="${p.memberId === lastEditable ? 'done' : 'next'}"
                 aria-label="כמה צ'יפים נשארו ל${esc(p.name)}" ${canActFor(p.memberId) ? '' : 'disabled'}>
          <span class="count-net" data-count-net="${p.memberId}"></span>
        </label>`).join('')}
      </div>
      <div class="stats" data-count-summary style="margin-top:14px"></div>
      <div class="balance" data-count-balance></div>
      ${isAdmin() ? `<button class="btn primary block big" data-finish>${icon('flag')} סיים ערב</button>` : ''}`;

    if (focused) {
      const el = $sheet.querySelector(`[data-final="${focused.id}"]`);
      if (el) { el.value = focused.value; el.focus(); }
    }
    updateCountPreviews();
  }

  function updateCountPreviews() {
    const s = data.session;
    const { rows, c } = liveCount();
    for (const r of rows) {
      const cell = $sheet.querySelector(`[data-count-net="${r.memberId}"]`);
      if (cell) cell.innerHTML = r.final === null ? '' : netHtml(s, toMoney(s, r.final - r.chips));
    }
    const $s = $sheet.querySelector('[data-count-summary]');
    const $b = $sheet.querySelector('[data-count-balance]');
    if ($s) $s.innerHTML = summaryTiles(s, c);
    if ($b) {
      const { cls, text } = balanceInfo(c);
      $b.className = `balance ${cls}`;
      $b.innerHTML = text;
    }
    drawCount();
  }

  // Save every count in the open panel that differs from what's stored.
  async function saveTypedCounts() {
    for (const input of $sheet.querySelectorAll('[data-final]:not(:disabled)')) {
      const p = player(Number(input.dataset.final));
      const raw = input.value.trim();
      const value = raw === '' ? null : Number(raw);
      if (p && value !== p.finalChips) await saveFinal(input);
    }
  }

  function renderAddSheet() {
    $sheet.innerHTML = `
      <div class="sheet-grip"></div>
      <div class="row sheet-head">
        <b class="grow">הוספת שחקן לערב</b>
        <button class="icon-btn" data-close aria-label="סגור">${icon('x')}</button>
      </div>
      ${data.notPlaying.length ? `
        <ul class="pick-list">${data.notPlaying.map(m => `
          <li><button class="pick add-pick" data-addp="${m.id}">
            <span class="avatar">${initial(m.name)}</span>
            <span class="grow">${esc(m.name)}</span>
            <span class="muted">+ הושב לשולחן</span>
          </button></li>`).join('')}
        </ul>` : '<p class="muted">כל חברי השולחן כבר משחקים הערב.</p>'}`;
  }

  async function addEntry(memberId, chips) {
    const p = player(memberId);
    const { id: entryId } = await api('POST', `/tables/${tid}/sessions/${sid}/entries`, { memberId, chips });
    toast(`נרשמה כניסה ל${p?.name ?? 'שחקן'} (${fmt(chips)})`, 'ok', {
      label: 'בטל',
      run: () => api('DELETE', `/tables/${tid}/sessions/${sid}/entries/${entryId}`)
        .then(() => { toast('הכניסה בוטלה'); return load(); })
        .catch(handleError),
    });
    await load();
  }

  async function saveFinal(input) {
    const value = input.value.trim();
    await api('PUT', `/tables/${tid}/sessions/${sid}/players/${input.dataset.final}/final`, { chips: value === '' ? null : Number(value) });
  }

  async function deleteEntry(entryId) {
    if (!(await askConfirm('למחוק את הכניסה הזו?', { ok: 'מחק', danger: true }))) return;
    await api('DELETE', `/tables/${tid}/sessions/${sid}/entries/${entryId}`);
    toast('הכניסה נמחקה');
    await load();
  }

  // ---------- events ----------

  $seats.addEventListener('click', e => {
    const seat = e.target.closest('[data-seat]');
    if (seat) openSheet(Number(seat.dataset.seat));
  });
  $add.onclick = () => openSheet('add');

  $sheetWrap.addEventListener('click', async e => {
    if (e.target === $sheetWrap || e.target.closest('[data-close]')) return closeSheet();
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    try {
      if (btn.dataset.buyin) {
        await addEntry(sheetFor, Number(btn.dataset.buyin));
      } else if (btn.hasAttribute('data-custom')) {
        const input = $sheet.querySelector('[name=custom]');
        const chips = Number(input.value);
        if (!(chips > 0)) { toast("הזן כמות צ'יפים", 'error'); input.focus(); return; }
        await addEntry(sheetFor, chips);
      } else if (btn.dataset.del) {
        await deleteEntry(btn.dataset.del);
      } else if (btn.hasAttribute('data-removep')) {
        const p = player(sheetFor);
        if (!(await askConfirm(`להוציא את ${p.name} מהערב?`, { ok: 'הוצא', danger: true }))) return;
        await api('DELETE', `/tables/${tid}/sessions/${sid}/players/${p.memberId}`);
        closeSheet();
        await load();
      } else if (btn.hasAttribute('data-finish')) {
        await endNight();
      } else if (btn.dataset.addp) {
        await api('POST', `/tables/${tid}/sessions/${sid}/players`, { memberId: Number(btn.dataset.addp) });
        toast('השחקן הושב לשולחן', 'ok');
        closeSheet();
        await load();
      }
    } catch (err) {
      handleError(err);
    } finally {
      if (btn.isConnected) btn.disabled = false;
    }
  });

  $sheetWrap.addEventListener('input', e => {
    if (sheetFor === 'count') updateCountPreviews();
    else if (e.target.dataset.final !== undefined || e.target.name === 'custom') updateSheetPreviews();
  });
  $sheetWrap.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    if (e.target.dataset.final !== undefined && sheetFor === 'count') {
      // "Next": jump to the next player's box (saving happens on the change event).
      e.preventDefault();
      const inputs = [...$sheet.querySelectorAll('[data-final]:not(:disabled)')];
      const next = inputs[inputs.indexOf(e.target) + 1];
      if (next) { next.focus(); next.select(); } else e.target.blur();
      return;
    }
    if (e.target.dataset.final !== undefined) e.target.blur();
    if (e.target.name === 'custom') $sheet.querySelector('[data-custom]')?.click();
  });
  $sheetWrap.addEventListener('change', async e => {
    if (e.target.dataset.final === undefined) return;
    try {
      await saveFinal(e.target);
      if (sheetFor !== 'count') toast('נשמר', 'ok'); // the count panel shows progress itself
      await load();
    } catch (err) { handleError(err); }
  });
  document.addEventListener('keydown', function onEsc(e) {
    if (!$sheetWrap.isConnected) return document.removeEventListener('keydown', onEsc);
    if (e.key === 'Escape' && !$sheetWrap.hidden && !document.querySelector('.modal')) closeSheet();
  });

  $log.addEventListener('click', async e => {
    const btn = e.target.closest('[data-del]');
    if (!btn) return;
    try { await deleteEntry(btn.dataset.del); } catch (err) { handleError(err); }
  });

  // "End night": if someone still has to count, opens the count-everyone panel at the first
  // missing player; otherwise locks the night and opens the read-only results page.
  async function endNight() {
    const s = data.session;
    try { await saveTypedCounts(); await load(); } catch (err) { handleError(err); return; }
    if (!$seats.isConnected || data.session.status !== 'open') return; // closed/deleted meanwhile
    const { c } = liveCount();
    if (c.missing.length) {
      if (sheetFor !== 'count') openSheet('count');
      else toast(`עוד לא הוזן: ${c.missing.join(', ')}`, 'error');
      // Start at the first empty box from the top of the list.
      const firstEmpty = [...$sheet.querySelectorAll('[data-final]:not(:disabled)')]
        .find(i => i.value.trim() === '' && player(Number(i.dataset.final))?.mustCount);
      firstEmpty?.focus();
      return;
    }
    const lock = 'אחרי הסיום הערב ננעל ואי אפשר לשנות בו כלום, רק לצפות בפלוסים ובמינוסים.';
    const question = c.balanced
      ? `לסיים את הערב?\n\n${lock}`
      : `הסכום לא מתאזן: ${mismatchText(s, c)}.\nמומלץ לספור שוב.\n\nלסיים בכל זאת?\n${lock}`;
    if (!(await askConfirm(question, { ok: c.balanced ? 'סיים ערב' : 'סיים בכל זאת', danger: !c.balanced }))) return;
    $end.disabled = true;
    try {
      await api('POST', `/tables/${tid}/sessions/${sid}/close`, { force: !c.balanced });
      document.body.classList.remove('no-scroll');
      toast('הערב הסתיים', 'ok');
      go(resultsPath);
    } catch (err) { handleError(err); $end.disabled = false; }
  }
  $end.onclick = endNight;

  $danger.querySelector('button').onclick = async () => {
    if (!(await askConfirm('למחוק את הערב וכל הכניסות שבו? אי אפשר לבטל.', { ok: 'מחק ערב', danger: true }))) return;
    try {
      await api('DELETE', `/tables/${tid}/sessions/${sid}`);
      toast('הערב נמחק');
      go(`/table/${tid}`);
    } catch (err) { handleError(err); }
  };

  await load();
  return {
    onEvent(msg) {
      if (msg.type === 'table-deleted' && msg.tableId == tid) { toast('השולחן נמחק על ידי הבעלים'); go('/'); return; }
      if (msg.type === 'resync' || (msg.type === 'session-changed' && msg.sessionId == sid)) load().catch(handleError);
      else if (msg.type === 'table-changed' && msg.tableId == tid) load().catch(handleError); // e.g. role changed
    },
  };
}

// Read-only results of a finished (locked) night: pluses and minuses per player. Nothing can be edited here.
async function viewResults(tid, sid) {
  const sessionPath = `/table/${tid}/session/${sid}`;
  $app.innerHTML = '<p class="muted">טוען…</p>';

  async function render() {
    let data;
    try {
      data = await api('GET', `/tables/${tid}/sessions/${sid}`);
    } catch (err) {
      if (err.status === 404) { toast('הערב לא נמצא (אולי נמחק)', 'error'); go(`/table/${tid}`); return; }
      throw err;
    }
    if (data.session.status === 'open') { go(sessionPath); return; } // not finished yet

    const { session: s, tableName, players, myMemberId } = data;
    const rows = players.map(p => ({ name: p.name, chips: p.chips, mustCount: p.mustCount, final: p.finalChips }));
    const c = cashoutMath(s, rows);
    const ranked = players
      .filter(p => p.entries > 0 || p.finalChips !== null)
      .map(p => ({ ...p, net: p.net ?? toMoney(s, -p.chips) }))
      .sort((a, b) => b.net - a.net);
    const mine = ranked.find(p => p.memberId === myMemberId);

    $app.innerHTML = `
      <a href="#/table/${tid}" class="back-link">${icon('back')} חזרה לשולחן</a>
      <section class="card results-card">
        <div class="row between">
          <div class="muted small">${esc(tableName)} · ${esc(fmtDate(s.startedAt))}</div>
          <span class="badge">${icon('lock')} הערב הסתיים</span>
        </div>
        <h1>תוצאות הערב</h1>
        ${mine ? `<div class="my-result"><span class="muted">התוצאה שלך</span>${netHtml(s, mine.net)}</div>` : ''}
      </section>
      <div class="stats">${summaryTiles(s, c)}</div>
      <section class="card list-card">
        <ul class="results">${ranked.map(p => `
          <li class="${p.memberId === myMemberId ? 'me' : ''}">
            <span class="avatar">${initial(p.name)}</span>
            <div class="grow">
              <b>${esc(p.name)}</b>
              <div class="muted small">נכנס ${money(s, p.money)} (${p.entries === 1 ? 'כניסה אחת' : `${p.entries} כניסות`}) · נשאר עם ${fmt(p.finalChips ?? 0)} צ'יפים</div>
            </div>
            ${netHtml(s, p.net)}
          </li>`).join('')}
        </ul>
        ${c.balanced ? '' : `<p class="balance bad">${icon('alert')} הערב הסתיים עם אי-התאמה: ${mismatchText(s, c)}.</p>`}
      </section>
      <p class="muted small">ההתחשבנות בפועל נעשית ביניכם. מי שבפלוס מקבל, מי שבמינוס משלם.</p>`;
  }

  await render();
  return {
    onEvent(msg) {
      if (msg.type === 'table-deleted' && msg.tableId == tid) { toast('השולחן נמחק על ידי הבעלים'); go('/'); return; }
      if (msg.type === 'session-changed' && msg.sessionId == sid) render().catch(handleError);
    },
  };
}

// Tracking table: every player's totals across all finished nights of the table.
async function viewStats(tid) {
  $app.innerHTML = '<p class="muted">טוען…</p>';

  async function render() {
    let data;
    try {
      data = await api('GET', `/tables/${tid}/stats`);
    } catch (err) {
      if (err.status === 404) { toast('השולחן לא נמצא או שאינך חבר בו', 'error'); go('/'); return; }
      throw err;
    }
    const { tableName, currency, myMemberId, nights, openSessionId, players } = data;
    const s = { currency };
    const cur = amount => `${fmt(amount)} ${esc(currency)}`;
    const totalIn = players.reduce((a, p) => a + p.moneyIn, 0);
    const totalNet = players.reduce((a, p) => a + p.net, 0);
    const played = players.filter(p => p.nights > 0);

    $app.innerHTML = `
      <a href="#/table/${tid}" class="back-link">${icon('back')} חזרה לשולחן</a>
      <div class="page-hero">
        <div class="muted small">${esc(tableName)}</div>
        <h1>טבלת מעקב</h1>
        <p class="muted small">סיכום כל הערבים שהסתיימו: כמה כל אחד הכניס וכמה הרוויח או הפסיד בסך הכול.</p>
      </div>
      <div class="stats">
        <div class="stat"><div class="v">${nights}</div><div class="l">ערבים שהסתיימו</div></div>
        <div class="stat"><div class="v">${cur(totalIn)}</div><div class="l">סך הכל הכנסות</div></div>
        <div class="stat"><div class="v">${played.length}</div><div class="l">שחקנים ששיחקו</div></div>
      </div>
      ${openSessionId ? `<p class="balance pending">יש ערב פעיל עכשיו. הוא ייכנס לטבלה אחרי שיסתיים. <a href="#/table/${tid}/session/${openSessionId}">לערב ←</a></p>` : ''}
      ${nights === 0 ? `
        <section class="card empty">
          <img src="icons/icon-192.png" alt="" class="empty-logo">
          <p><b>עוד אין ערבים שהסתיימו</b></p>
          <p class="muted small">אחרי שתסיימו ערב ראשון, תופיע כאן טבלה עם הכניסות והרווחים של כל אחד.</p>
        </section>` : `
        <section class="card table-card">
          <table class="track">
            <thead>
              <tr><th>#</th><th>שחקן</th><th>נכנס</th><th>רווח / הפסד</th></tr>
            </thead>
            <tbody>${players.map((p, i) => `
              <tr class="${p.memberId === myMemberId ? 'me' : ''}${p.nights === 0 ? ' idle' : ''}">
                <td class="rank">${p.nights ? rankBadge(i) : '–'}</td>
                <td>
                  <b>${esc(p.name)}</b>${p.memberId === myMemberId ? ' <span class="muted small">(אני)</span>' : ''}
                  <div class="muted small">${p.nights === 0 ? 'עוד לא שיחק' : `${p.nights === 1 ? 'ערב אחד' : `${p.nights} ערבים`} · ${p.wins} ברווח, ${p.losses} בהפסד`}</div>
                </td>
                <td>
                  ${cur(p.moneyIn)}
                  <div class="muted small">${p.entries === 1 ? 'כניסה אחת' : `${p.entries} כניסות`}</div>
                </td>
                <td>${p.nights ? netHtml(s, p.net) : '<span class="muted">–</span>'}
                  ${p.nights > 1 ? `<div class="muted small">שיא: <span class="ltr">${p.best > 0 ? '+' : ''}${fmt(p.best)}</span></div>` : ''}
                </td>
              </tr>`).join('')}
            </tbody>
            <tfoot>
              <tr>
                <td></td>
                <td><b>סה"כ</b></td>
                <td>${cur(totalIn)}</td>
                <td>${netHtml(s, totalNet)}</td>
              </tr>
            </tfoot>
          </table>
        </section>
        <p class="muted small">הסה"כ של הרווחים וההפסדים אמור לצאת 0. אם לא, אחד הערבים הסתיים עם אי-התאמה בספירה.</p>`}`;
  }

  await render();
  return {
    onEvent(msg) {
      if (msg.type === 'table-deleted' && msg.tableId == tid) { toast('השולחן נמחק על ידי הבעלים'); go('/'); return; }
      if (msg.type === 'resync' || msg.tableId == tid) render().catch(handleError);
    },
  };
}

// Rank number in a circle; the top three get gold / silver / bronze.
const rankBadge = i => `<span class="rank-badge${i < 3 ? ` r${i + 1}` : ''}">${i + 1}</span>`;

async function viewJoin(code) {
  let inv;
  try {
    inv = await api('GET', `/invites/${code}`);
  } catch (err) {
    if (err.status !== 404) throw err;
    $app.innerHTML = `
      <section class="card narrow empty">
        <div class="empty-icon">${icon('link')}</div>
        <p>${esc(err.message)}</p>
        <a href="#/" class="btn">לשולחנות שלי</a>
      </section>`;
    return;
  }

  const t = inv.table;
  if (inv.alreadyMember) {
    $app.innerHTML = `
      <section class="card narrow empty">
        <p>אתה כבר חבר בשולחן <b>${esc(t.name)}</b>.</p>
        <a href="#/table/${t.id}" class="btn primary">פתח את השולחן</a>
      </section>`;
    return;
  }

  $app.innerHTML = `
    <section class="card narrow">
      <p class="muted">הוזמנת להצטרף לשולחן</p>
      <h1>${esc(t.name)}</h1>
      <p class="muted small">של ${esc(inv.ownerName)} · ${inv.memberCount} חברים</p>
      <p class="ratio">${ratioText(t)}</p>
      <div class="row">
        <button class="btn primary grow" id="join">הצטרף לשולחן</button>
        <a href="#/" class="btn">לא עכשיו</a>
      </div>
    </section>`;
  $app.querySelector('#join').onclick = async e => {
    e.target.disabled = true;
    try {
      const { tableId } = await api('POST', `/invites/${code}/join`);
      toast('הצטרפת לשולחן!', 'ok');
      go(`/table/${tableId}`);
    } catch (err) { handleError(err); e.target.disabled = false; }
  };
}

// ---------- boot ----------

async function boot() {
  if (LOCAL_MODE) $live.hidden = true; // no realtime connection on a single phone
  try { setMe(await api('GET', '/auth/me')); } catch { setMe(null); }
  window.addEventListener('hashchange', router);
  router();
}

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {}); // relative: works under /<repo>/ on GitHub Pages too
}

boot();
