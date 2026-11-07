// "On this phone" mode: the whole backend, running in the browser.
// Implements the same REST API as server/*.js, but on a JSON store kept in localStorage,
// so the app works with no server at all (e.g. hosted for free on GitHub Pages).
// Single user: "me" owns everything; other players are guests (names only).

// Local mode is used on GitHub Pages, or anywhere with ?local in the URL (for testing).
export const LOCAL_MODE = location.hostname.endsWith('github.io') || new URLSearchParams(location.search).has('local');

const KEY = 'pokerface-data-v1';
const EPSILON = 1e-6;

const emptyStore = () => ({
  version: 1,
  meId: null,
  seq: 0,
  users: [], tables: [], members: [], sessions: [], players: [], entries: [],
});

let store = load();

function load() {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...emptyStore(), ...JSON.parse(raw) };
  } catch {}
  return emptyStore();
}

function save() {
  try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (e) { console.error('saving failed', e); }
}

// Ask the browser not to evict our data under storage pressure.
if (LOCAL_MODE) navigator.storage?.persist?.().catch(() => {});

const nextId = () => ++store.seq;
// Same format the server uses: UTC "YYYY-MM-DD HH:MM:SS".
const now = () => new Date().toISOString().slice(0, 19).replace('T', ' ');

// ---------- backup / restore ----------

export function exportBackup() {
  return JSON.stringify({ app: 'pokerface', exportedAt: new Date().toISOString(), ...store }, null, 1);
}

export function importBackup(text) {
  const data = JSON.parse(text);
  if (data.app !== 'pokerface' || !Array.isArray(data.tables) || !Array.isArray(data.members)) {
    throw new Error('זה לא קובץ גיבוי של POKERFACE');
  }
  const { app, exportedAt, ...rest } = data;
  store = { ...emptyStore(), ...rest };
  save();
}

// ---------- helpers mirroring the server ----------

const ok = (data, status = 200) => ({ status, data });
const bad = (error, status = 400, extra = {}) => ({ status, data: { error, ...extra } });

const me = () => store.users.find(u => u.id === store.meId);
const userJson = u => ({ id: u.id, username: u.username, displayName: u.display_name });
const toMoney = (s, chips) => (chips * s.money_amount) / s.chip_amount;
const byName = (a, b) => String(a).localeCompare(String(b), 'he', { sensitivity: 'base' });

function cleanText(value, max) {
  const s = String(value ?? '').trim().replace(/\s+/g, ' ');
  return s && s.length <= max ? s : null;
}

function parseRatio(body) {
  const money = Number(body.moneyAmount);
  const chips = Number(body.chipAmount);
  if (!(money > 0 && chips > 0) || money > 1e7 || chips > 1e9) return null;
  return { money, chips };
}

function parseBuyin(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const n = Number(value);
  return n > 0 && n <= 1e9 ? n : null;
}

const tableJson = t => ({
  id: t.id, name: t.name, ownerId: t.owner_id,
  moneyAmount: t.money_amount, chipAmount: t.chip_amount,
  buyinChips: t.buyin_chips ?? t.chip_amount, currency: t.currency, createdAt: t.created_at,
});

const sessionJson = s => ({
  id: s.id, tableId: s.table_id, status: s.status,
  moneyAmount: s.money_amount, chipAmount: s.chip_amount, buyinChips: s.buyin_chips,
  currency: s.currency, startedAt: s.started_at, closedAt: s.closed_at,
});

const memberName = m => m.user_id ? (store.users.find(u => u.id === m.user_id)?.display_name ?? m.guest_name ?? '?') : m.guest_name;
const activeMembers = tableId => store.members.filter(m => m.table_id === tableId && !m.removed_at);
const myMembership = tableId => store.members.find(m => m.table_id === tableId && m.user_id === store.meId && !m.removed_at);
const roleOrder = { owner: 0, admin: 1, player: 2 };

const entriesOf = (sid, memberId) => store.entries.filter(e => e.session_id === sid && (memberId === undefined || e.member_id === memberId));
const playersOf = sid => store.players.filter(p => p.session_id === sid);
const sumChips = list => list.reduce((a, e) => a + e.chips, 0);

function sessionPlayers(s) {
  return playersOf(s.id).map(p => {
    const m = store.members.find(x => x.id === p.member_id);
    const es = entriesOf(s.id, p.member_id);
    const chips = sumChips(es);
    const counted = p.final_chips !== null && p.final_chips !== undefined;
    const final = counted ? p.final_chips : null;
    return {
      memberId: p.member_id,
      name: memberName(m),
      username: m.user_id ? me()?.username : null,
      isGuest: !m.user_id,
      removed: !!m.removed_at,
      addedAt: p.added_at,
      entries: es.length,
      chips,
      money: toMoney(s, chips),
      finalChips: final,
      finalMoney: counted ? toMoney(s, final) : null,
      netChips: counted ? final - chips : null,
      net: counted ? toMoney(s, final - chips) : null,
      mustCount: es.length > 0,
    };
  }).sort((a, b) => b.chips - a.chips || byName(a.name, b.name));
}

function cashoutStatus(s, players) {
  const chipsIn = players.reduce((a, p) => a + p.chips, 0);
  const chipsOut = players.reduce((a, p) => a + (p.finalChips ?? 0), 0);
  const diffChips = chipsOut - chipsIn;
  return {
    chipsIn, chipsOut,
    moneyOut: toMoney(s, chipsOut),
    counted: players.filter(p => p.finalChips !== null).length,
    missing: players.filter(p => p.mustCount && p.finalChips === null).map(p => p.name),
    diffChips,
    diffMoney: toMoney(s, diffChips),
    balanced: Math.abs(diffChips) < EPSILON,
  };
}

// ---------- routes ----------

const routes = [];
const route = (method, pattern, handler) => routes.push({ method, re: new RegExp(`^${pattern}$`), handler });

// auth: no passwords on a personal phone - just "who are you?"
route('GET', '/auth/me', () => (me() ? ok(userJson(me())) : bad('צריך להתחבר', 401)));
route('POST', '/auth/register', (_, body) => {
  const displayName = cleanText(body.displayName, 30);
  if (!displayName) return bad('שם לתצוגה חייב להכיל 1-30 תווים');
  let u = me();
  if (u) u.display_name = displayName;
  else {
    u = { id: nextId(), username: 'me', display_name: displayName, created_at: now() };
    store.users.push(u);
    store.meId = u.id;
  }
  save();
  return ok(userJson(u), 201);
});
route('POST', '/auth/login', () => (me() ? ok(userJson(me())) : bad('צריך להירשם', 401)));
route('POST', '/auth/logout', () => ok(null, 204));

// tables
route('GET', '/tables', () => {
  const list = store.tables
    .map(t => ({ t, m: myMembership(t.id) }))
    .filter(x => x.m)
    .sort((a, b) => b.t.created_at.localeCompare(a.t.created_at) || b.t.id - a.t.id)
    .map(({ t, m }) => ({
      ...tableJson(t),
      myRole: m.role,
      memberCount: activeMembers(t.id).length,
      openSessionId: store.sessions.find(s => s.table_id === t.id && s.status === 'open')?.id ?? null,
    }));
  return ok({ tables: list });
});

route('POST', '/tables', (_, body) => {
  const name = cleanText(body.name, 40);
  if (!name) return bad('שם השולחן חייב להכיל 1-40 תווים');
  const ratio = parseRatio(body);
  if (!ratio) return bad("יחס הצ'יפים לכסף לא תקין");
  const buyin = parseBuyin(body.buyinChips, ratio.chips);
  if (!buyin) return bad('גודל כניסה לא תקין');
  const t = {
    id: nextId(), name, owner_id: store.meId,
    money_amount: ratio.money, chip_amount: ratio.chips, buyin_chips: buyin,
    currency: '₪', invite_code: null, created_at: now(),
  };
  store.tables.push(t);
  store.members.push({ id: nextId(), table_id: t.id, user_id: store.meId, guest_name: null, role: 'owner', added_by: store.meId, joined_at: now(), removed_at: null });
  save();
  return ok({ id: t.id }, 201);
});

// Everything under /tables/:id needs the table and my membership in it.
function withTable(handler) {
  return (params, body) => {
    const t = store.tables.find(x => x.id === Number(params[0]));
    const m = t && myMembership(t.id);
    if (!m) return bad('השולחן לא נמצא', 404);
    return handler(t, m, params, body);
  };
}

route('GET', '/tables/(\\d+)', withTable((t, m) => {
  const members = activeMembers(t.id)
    .map(x => ({
      id: x.id, userId: x.user_id, name: memberName(x),
      username: x.user_id ? me()?.username : null, isGuest: !x.user_id,
      role: x.role, joinedAt: x.joined_at,
    }))
    .sort((a, b) => roleOrder[a.role] - roleOrder[b.role] || byName(a.name, b.name));
  return ok({ table: tableJson(t), myRole: m.role, myMemberId: m.id, members });
}));

route('PATCH', '/tables/(\\d+)', withTable((t, m, _, body) => {
  if (m.role !== 'owner') return bad('אין לך הרשאה לפעולה הזו', 403);
  const name = body.name === undefined ? t.name : cleanText(body.name, 40);
  if (!name) return bad('שם השולחן חייב להכיל 1-40 תווים');
  const ratio = body.moneyAmount === undefined && body.chipAmount === undefined
    ? { money: t.money_amount, chips: t.chip_amount } : parseRatio(body);
  if (!ratio) return bad("יחס הצ'יפים לכסף לא תקין");
  const buyin = parseBuyin(body.buyinChips, t.buyin_chips ?? ratio.chips);
  if (!buyin) return bad('גודל כניסה לא תקין');
  Object.assign(t, { name, money_amount: ratio.money, chip_amount: ratio.chips, buyin_chips: buyin });
  save();
  return ok({ ok: true });
}));

route('DELETE', '/tables/(\\d+)', withTable((t, m) => {
  if (m.role !== 'owner') return bad('אין לך הרשאה לפעולה הזו', 403);
  const sids = new Set(store.sessions.filter(s => s.table_id === t.id).map(s => s.id));
  store.entries = store.entries.filter(e => !sids.has(e.session_id));
  store.players = store.players.filter(p => !sids.has(p.session_id));
  store.sessions = store.sessions.filter(s => s.table_id !== t.id);
  store.members = store.members.filter(x => x.table_id !== t.id);
  store.tables = store.tables.filter(x => x.id !== t.id);
  save();
  return ok(null, 204);
}));

// members (guests only on a personal phone)
route('POST', '/tables/(\\d+)/members', withTable((t, m, _, body) => {
  if (m.role !== 'owner') return bad('אין לך הרשאה לפעולה הזו', 403);
  const guestName = cleanText(body.guestName ?? body.username, 30);
  if (!guestName) return bad('צריך להזין שם של שחקן (עד 30 תווים)');
  if (activeMembers(t.id).some(x => byName(memberName(x), guestName) === 0)) return bad('כבר יש בשולחן שחקן בשם הזה', 409);
  store.members.push({ id: nextId(), table_id: t.id, user_id: null, guest_name: guestName, role: 'player', added_by: store.meId, joined_at: now(), removed_at: null });
  save();
  return ok({ ok: true }, 201);
}));

route('DELETE', '/tables/(\\d+)/members/(\\d+)', withTable((t, m, params) => {
  const target = activeMembers(t.id).find(x => x.id === Number(params[1]));
  if (!target) return bad('החבר לא נמצא', 404);
  if (target.role === 'owner') return bad('הבעלים לא יכול לעזוב את השולחן - אפשר רק למחוק אותו');
  if (m.role !== 'owner') return bad('אין לך הרשאה לפעולה הזו', 403);
  target.removed_at = now();
  target.role = 'player';
  save();
  return ok(null, 204);
}));

// sessions
route('GET', '/tables/(\\d+)/sessions', withTable((t, m) => {
  const sessions = store.sessions
    .filter(s => s.table_id === t.id)
    .sort((a, b) => b.started_at.localeCompare(a.started_at) || b.id - a.id)
    .map(s => {
      const es = entriesOf(s.id);
      const total = sumChips(es);
      const mine = playersOf(s.id).find(p => p.member_id === m.id);
      const myNetChips = mine && mine.final_chips != null ? mine.final_chips - sumChips(entriesOf(s.id, m.id)) : null;
      return {
        ...sessionJson(s),
        playerCount: playersOf(s.id).length,
        entryCount: es.length,
        totalChips: total,
        totalMoney: toMoney(s, total),
        myNet: s.status === 'closed' && myNetChips !== null ? toMoney(s, myNetChips) : null,
      };
    });
  return ok({ sessions });
}));

route('POST', '/tables/(\\d+)/sessions', withTable((t, m, _, body) => {
  if (m.role === 'player') return bad('אין לך הרשאה לפעולה הזו', 403);
  const ids = [...new Set((Array.isArray(body.memberIds) ? body.memberIds : []).map(Number))];
  if (ids.length < 2) return bad('צריך לבחור לפחות 2 משתתפים');
  const valid = new Set(activeMembers(t.id).map(x => x.id));
  if (ids.some(id => !valid.has(id))) return bad('אחד המשתתפים שנבחרו אינו חבר בשולחן');
  if (store.sessions.some(s => s.table_id === t.id && s.status === 'open')) return bad('כבר יש ערב פתוח בשולחן הזה', 409);
  const s = {
    id: nextId(), table_id: t.id, status: 'open',
    money_amount: t.money_amount, chip_amount: t.chip_amount, buyin_chips: t.buyin_chips ?? t.chip_amount,
    currency: t.currency, created_by: store.meId, started_at: now(), closed_at: null,
  };
  store.sessions.push(s);
  const at = now();
  ids.forEach(id => store.players.push({ session_id: s.id, member_id: id, added_at: at, final_chips: null, final_by: null, final_at: null }));
  save();
  return ok({ id: s.id }, 201);
}));

// Everything under /sessions/:sid needs the session too.
function withSession(handler, { open = false, admin = false } = {}) {
  return withTable((t, m, params, body) => {
    const s = store.sessions.find(x => x.id === Number(params[1]) && x.table_id === t.id);
    if (!s) return bad('הערב לא נמצא', 404);
    if (admin && m.role === 'player') return bad('אין לך הרשאה לפעולה הזו', 403);
    if (open && s.status !== 'open') return bad('הערב כבר נסגר');
    return handler(t, m, s, params, body);
  });
}

route('GET', '/tables/(\\d+)/sessions/(\\d+)', withSession((t, m, s) => {
  const players = sessionPlayers(s);
  const perPlayer = new Map();
  const entries = entriesOf(s.id)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id - b.id)
    .map(e => {
      const n = (perPlayer.get(e.member_id) ?? 0) + 1;
      perPlayer.set(e.member_id, n);
      const member = store.members.find(x => x.id === e.member_id);
      return {
        id: e.id, memberId: e.member_id, name: memberName(member),
        chips: e.chips, money: toMoney(s, e.chips), number: n,
        createdAt: e.created_at, createdById: e.created_by,
        createdByName: store.users.find(u => u.id === e.created_by)?.display_name ?? null,
      };
    })
    .reverse();
  const playing = new Set(playersOf(s.id).map(p => p.member_id));
  const notPlaying = activeMembers(t.id)
    .filter(x => !playing.has(x.id))
    .map(x => ({ id: x.id, name: memberName(x) }))
    .sort((a, b) => byName(a.name, b.name));
  const totalChips = players.reduce((a, p) => a + p.chips, 0);
  return ok({
    session: sessionJson(s), tableName: t.name, myRole: m.role, myMemberId: m.id,
    players, entries, notPlaying,
    totals: { chips: totalChips, money: toMoney(s, totalChips), entries: entries.length },
    cashout: cashoutStatus(s, players),
  });
}));

route('DELETE', '/tables/(\\d+)/sessions/(\\d+)', withSession((t, m, s) => {
  if (m.role !== 'owner') return bad('אין לך הרשאה לפעולה הזו', 403);
  store.entries = store.entries.filter(e => e.session_id !== s.id);
  store.players = store.players.filter(p => p.session_id !== s.id);
  store.sessions = store.sessions.filter(x => x.id !== s.id);
  save();
  return ok(null, 204);
}));

route('POST', '/tables/(\\d+)/sessions/(\\d+)/players', withSession((t, m, s, _, body) => {
  const memberId = Number(body.memberId);
  if (!activeMembers(t.id).some(x => x.id === memberId)) return bad('החבר לא נמצא', 404);
  if (playersOf(s.id).some(p => p.member_id === memberId)) return bad('השחקן כבר משתתף בערב', 409);
  store.players.push({ session_id: s.id, member_id: memberId, added_at: now(), final_chips: null, final_by: null, final_at: null });
  save();
  return ok({ ok: true }, 201);
}, { open: true, admin: true }));

route('DELETE', '/tables/(\\d+)/sessions/(\\d+)/players/(\\d+)', withSession((t, m, s, params) => {
  const memberId = Number(params[2]);
  if (entriesOf(s.id, memberId).length) return bad('לשחקן יש כבר כניסות בערב הזה - צריך למחוק אותן קודם');
  store.players = store.players.filter(p => !(p.session_id === s.id && p.member_id === memberId));
  save();
  return ok(null, 204);
}, { open: true, admin: true }));

route('POST', '/tables/(\\d+)/sessions/(\\d+)/entries', withSession((t, m, s, _, body) => {
  const memberId = Number(body.memberId);
  if (m.role === 'player' && memberId !== m.id) return bad('שחקן יכול לרשום כניסות רק לעצמו', 403);
  if (!playersOf(s.id).some(p => p.member_id === memberId)) return bad('השחקן לא משתתף בערב הזה');
  const chips = body.chips === undefined ? s.buyin_chips : Number(body.chips);
  if (!(chips > 0) || chips > 1e9) return bad("כמות צ'יפים לא תקינה");
  const e = { id: nextId(), session_id: s.id, member_id: memberId, chips, created_by: store.meId, created_at: now() };
  store.entries.push(e);
  save();
  return ok({ id: e.id }, 201);
}, { open: true }));

route('DELETE', '/tables/(\\d+)/sessions/(\\d+)/entries/(\\d+)', withSession((t, m, s, params) => {
  const e = store.entries.find(x => x.id === Number(params[2]) && x.session_id === s.id);
  if (!e) return bad('הכניסה לא נמצאה', 404);
  store.entries = store.entries.filter(x => x !== e);
  save();
  return ok(null, 204);
}, { open: true }));

route('PUT', '/tables/(\\d+)/sessions/(\\d+)/players/(\\d+)/final', withSession((t, m, s, params, body) => {
  const p = playersOf(s.id).find(x => x.member_id === Number(params[2]));
  if (!p) return bad('השחקן לא משתתף בערב הזה');
  let chips = body.chips;
  if (chips === null || chips === '') chips = null;
  else {
    chips = Number(chips);
    if (!(chips >= 0) || chips > 1e9) return bad("כמות צ'יפים לא תקינה");
  }
  Object.assign(p, { final_chips: chips, final_by: store.meId, final_at: now() });
  save();
  return ok({ ok: true });
}, { open: true }));

route('POST', '/tables/(\\d+)/sessions/(\\d+)/close', withSession((t, m, s, _, body) => {
  const status = cashoutStatus(s, sessionPlayers(s));
  if (status.missing.length) return bad(`עוד לא ספרו צ'יפים: ${status.missing.join(', ')}`, 400, { cashout: status });
  if (!status.balanced && body.force !== true) return bad('הסכום לא מתאזן - כדאי לספור שוב', 409, { cashout: status });
  Object.assign(s, { status: 'closed', closed_at: now() });
  save();
  return ok({ ok: true, cashout: status });
}, { open: true, admin: true }));

// tracking table
route('GET', '/tables/(\\d+)/stats', withTable((t, m) => {
  const stats = new Map(store.members.filter(x => x.table_id === t.id).map(x => [x.id, {
    memberId: x.id, name: memberName(x), isGuest: !x.user_id, removed: !!x.removed_at,
    nights: 0, entries: 0, moneyIn: 0, net: 0, wins: 0, losses: 0, best: null, worst: null,
  }]));
  const closed = store.sessions.filter(s => s.table_id === t.id && s.status === 'closed');
  for (const s of closed) {
    for (const p of playersOf(s.id)) {
      const es = entriesOf(s.id, p.member_id);
      if (es.length === 0 && p.final_chips == null) continue;
      const st = stats.get(p.member_id);
      if (!st) continue;
      const chipsIn = sumChips(es);
      const net = toMoney(s, (p.final_chips ?? 0) - chipsIn);
      st.nights += 1;
      st.entries += es.length;
      st.moneyIn += toMoney(s, chipsIn);
      st.net += net;
      if (net > 0.005) st.wins += 1;
      if (net < -0.005) st.losses += 1;
      st.best = st.best === null ? net : Math.max(st.best, net);
      st.worst = st.worst === null ? net : Math.min(st.worst, net);
    }
  }
  const players = [...stats.values()]
    .filter(p => !p.removed || p.nights > 0)
    .sort((a, b) => (b.nights > 0) - (a.nights > 0) || b.net - a.net || b.nights - a.nights || byName(a.name, b.name));
  return ok({
    tableName: t.name, currency: t.currency, myMemberId: m.id,
    nights: closed.length,
    openSessionId: store.sessions.find(s => s.table_id === t.id && s.status === 'open')?.id ?? null,
    players,
  });
}));

// ---------- entry point used by app.js instead of fetch('/api/...') ----------

export function localApi(method, url, body = {}) {
  const path = url.split('?')[0];
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = path.match(r.re);
    if (m) return r.handler(m.slice(1), body ?? {});
  }
  return bad('לא נמצא', 404);
}
