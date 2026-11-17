(() => {
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const pad = n => String(n).padStart(2, '0');
const ymd = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parse = s => { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2]); };
const addDays = (s, n) => { const d = parse(s); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());
const daysBetween = (a, b) => Math.round((parse(b) - parse(a)) / 864e5);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
const fmtDay = s => parse(s).toLocaleDateString('en-GB', {weekday: 'short', day: 'numeric', month: 'short'});
const fmtShort = s => parse(s).toLocaleDateString('en-GB', {day: 'numeric', month: 'short'});
const toMin = t => { const p = t.split(':').map(Number); return p[0] * 60 + p[1]; };
const fromMin = n => pad(Math.floor(n / 60) % 24) + ':' + pad(n % 60);
const fmtTime = t => { const p = t.split(':').map(Number); return (p[0] % 12 || 12) + ':' + pad(p[1]) + (p[0] >= 12 ? ' pm' : ' am'); };
const monthName = m => new Date(+m.slice(0, 4), +m.slice(5, 7) - 1, 1).toLocaleDateString('en-GB', {month: 'long', year: 'numeric'});

const METHODS = {cash: 'Cash', card: 'Card', bank: 'Bank transfer'};
const EXP_CATS = ['Supplies', 'Rent', 'Utilities', 'Wages', 'Marketing', 'Equipment', 'Cleaning', 'Other'];
const INC_CATS = ['Services', 'Retail', 'Tips', 'Other'];
const CURRENCIES = ['LKR', 'USD', 'EUR', 'GBP', 'INR', 'AUD', 'CAD', 'AED'];
const PERIODS = [['7d', 'Last 7 days'], ['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['all', 'All time']];
const STATUS = {booked: 'Booked', done: 'Paid', cancelled: 'Cancelled', noshow: 'No-show'};
const VIEWS = ['overview', 'book', 'inspo', 'money', 'setup', 'users'];

function guessCurrency() {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
    if (tz === 'Asia/Colombo') return 'LKR';
    if (tz === 'Asia/Kolkata' || tz === 'Asia/Calcutta') return 'INR';
    if (tz === 'Europe/London') return 'GBP';
    if (tz.indexOf('Australia/') === 0) return 'AUD';
    if (tz === 'Asia/Dubai') return 'AED';
    if (tz.indexOf('Europe/') === 0) return 'EUR';
  } catch (e) {}
  return 'USD';
}
function defaultServices(cur) {
  const big = cur === 'LKR' || cur === 'INR';
  const p = big ? [2500, 3000, 3500, 6500, 1500, 800] : [25, 30, 35, 65, 15, 8];
  const names = [['Classic manicure', 45], ['Classic pedicure', 60], ['Gel polish', 60], ['Acrylic full set', 120], ['Nail art (per set)', 30], ['Polish removal', 20]];
  return names.map((n, i) => ({id: 's' + (i + 1), name: n[0], price: p[i], mins: n[1]}));
}

const state = {txns: [], appts: [], settings: null, view: 'overview', period: 'month', apptDate: today(),
  mf: {type: 'all', month: 'all'}, pending: [], pendingUrls: [], lb: null, mode: 'connecting', confirmBook: false,
  me: null, features: {}, rev: 0, users: [], uMeta: null, uEdit: null, uReset: null, uFilter: 'all', rebookForce: null};
let C = null, chartData = null, formBusy = false, qPending = null;

/* ---------- permissions: the server enforces every rule, the UI only mirrors them ---------- */
const RANK = {none: 0, own: 1, read: 2, write: 3};
const lvl = s => (state.me && RANK[state.me.access[s]]) || 0;
const canSee = s => lvl(s) >= 1;
const canRead = s => lvl(s) >= 2;
const canWrite = s => lvl(s) >= 3;
const isOwn = s => lvl(s) === 1;
const isAdmin = () => !!state.me && state.me.role === 'admin';
const staffView = () => canWrite('book');
const canPay = () => canWrite('book') && canWrite('money');
const canSample = () => canWrite('setup') && canWrite('money') && canWrite('book');
const canUpload = () => canWrite('inspo') || isOwn('inspo');
const canEditPhotos = a => canWrite('inspo') || (isOwn('inspo') && !!state.me && a.ownerId === state.me.id);
const hasAnyWrite = () => ['book', 'inspo', 'money', 'setup'].some(s => canWrite(s) || isOwn(s));
function viewAllowed(v) {
  if (v === 'overview') return canRead('overview');
  if (v === 'book') return canSee('book');
  if (v === 'inspo') return canSee('inspo');
  if (v === 'money') return canRead('money');
  if (v === 'setup') return canRead('setup');
  if (v === 'users') return isAdmin();
  return false;
}
const firstView = () => VIEWS.find(viewAllowed) || null;
function gateOk(g) {
  if (g === 'sample') return canSample();
  if (g === 'money') return canRead('money');
  if (g === 'book') return canSee('book');
  return true;
}

function computeCfg() {
  const s = state.settings || {};
  const currency = s.currency || guessCurrency();
  return {
    salon: s.salon || 'Your nail studio',
    currency,
    staff: Array.isArray(s.staff) && s.staff.length ? s.staff : ['Owner'],
    services: Array.isArray(s.services) ? s.services : defaultServices(currency),
    opening: Object.assign({cash: 0, card: 0, bank: 0}, s.opening || {})
  };
}
C = computeCfg();

const fmts = {};
function money(n) {
  const cur = C.currency;
  try {
    const f = fmts[cur] || (fmts[cur] = new Intl.NumberFormat('en', {style: 'currency', currency: cur, minimumFractionDigits: 0, maximumFractionDigits: 2}));
    return f.format(n);
  } catch (e) { return cur + ' ' + n.toFixed(2); }
}
const compact = n => new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(n);

/* ---------- toast + server access ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
}
class ApiError extends Error {
  constructor(status, code, message, data) { super(message); this.status = status; this.code = code; this.data = data || {}; this.handled = false; }
}
async function api(method, url, body, opts) {
  opts = opts || {};
  const headers = {'X-Requested-With': 'rode', 'Accept': 'application/json'};
  let payload;
  if (opts.raw) { payload = opts.raw; headers['Content-Type'] = opts.raw.type || 'application/octet-stream'; }
  else if (body !== undefined) { payload = JSON.stringify(body); headers['Content-Type'] = 'application/json'; }
  let res;
  try { res = await fetch('/api' + url, {method, headers, body: payload, credentials: 'same-origin', cache: 'no-store'}); }
  catch (e) { throw new ApiError(0, 'network', 'Cannot reach the server. Check your connection.'); }
  if (res.status === 204) return null;
  let data = null;
  try { data = await res.json(); } catch (e) { /* non-JSON error page */ }
  if (!res.ok) {
    const er = (data && data.error) || {};
    const err = new ApiError(res.status, er.code || 'error', er.message || 'Something went wrong. Please try again.', er);
    if (res.status === 401 && er.code !== 'invalid_credentials' && !opts.noAuthRedirect) { err.handled = true; signedOut('Your session ended. Please sign in again.'); }
    else if (res.status === 403 && er.code === 'password_change_required' && state.me) { err.handled = true; state.me.mustChange = true; showAuth('force', 'Choose a new password to continue.'); }
    throw err;
  }
  return data;
}
const reportError = e => { if (e && !e.handled) toast(e.message || 'Something went wrong.'); };
const quiet = p => p.catch(() => {});

let loadSeq = 0;
async function loadState() {
  const seq = ++loadSeq;
  const d = await api('GET', '/state');
  if (seq !== loadSeq || !state.me) return;
  state.txns = d.txns; state.appts = d.appts; state.settings = d.settings; state.rev = d.rev;
  state.mode = 'live';
  onData();
}
/** Run a server mutation, then re-sync. Errors are toasted (unless silent) and re-thrown. */
async function act(fn, opts) {
  let r;
  try { r = await fn(); }
  catch (e) {
    if (!(opts && opts.silent)) reportError(e);
    if (e.status !== 0 && e.status !== 401) quiet(loadState());
    throw e;
  }
  try { await loadState(); } catch (e) { if (!e.handled) { state.mode = 'error'; renderHeader(); } }
  return r;
}
async function saveSettings(patch) { await act(() => api('PATCH', '/settings', patch)); }

/* ---------- live sync: cheap revision poll, full reload only when something changed ---------- */
let pollTimer = null, polling = false;
async function poll() {
  if (document.hidden || !state.me || state.me.mustChange || polling) return;
  polling = true;
  try {
    const s = await api('GET', '/sync');
    if (!state.me) return;
    if (s.uv !== state.me.updatedAt) await refreshMe();
    if (s.rev !== state.rev) await loadState();
    else if (state.mode !== 'live') { state.mode = 'live'; renderHeader(); }
  } catch (e) { if (e.status === 0 || e.status >= 500) { state.mode = 'error'; renderHeader(); } }
  finally { polling = false; }
}
const startPolling = () => { stopPolling(); pollTimer = setInterval(poll, 5000); };
const stopPolling = () => { if (pollTimer) clearInterval(pollTimer); pollTimer = null; };
document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
window.addEventListener('online', poll);

async function refreshMe() {
  const d = await api('GET', '/auth/me');
  state.me = d.user; state.features = d.features || {};
  applyNav();
  if (!viewAllowed(state.view)) setView(firstView()); else render();
}

/* ---------- sign-in / sign-out ---------- */
function setMsg(sel, text) { const el = $(sel); el.textContent = text || ''; el.hidden = !text; }
function showAuth(mode, msg) {
  $('#app').hidden = true; $('#auth').hidden = false;
  $('#loginForm').hidden = mode !== 'login'; $('#forceForm').hidden = mode !== 'force';
  $('#forgotForm').hidden = mode !== 'forgot'; $('#resetForm').hidden = mode !== 'reset';
  closeAcct(); closeLb();
  if (mode === 'login') {
    setMsg('#loginMsg', msg); $('#lPass').value = '';
    setTimeout(() => ($('#lUser').value ? $('#lPass') : $('#lUser')).focus(), 0);
    loadAuthOptions();
  } else if (mode === 'forgot') {
    setMsg('#forgotMsg', msg); $('#forgotOk').hidden = true; $('#gGo').disabled = false;
    if (!$('#gId').value) $('#gId').value = $('#lUser').value;
    setTimeout(() => $('#gId').focus(), 0);
  } else if (mode === 'reset') {
    setMsg('#resetMsg', msg); ['#rNew', '#rNew2'].forEach(s => { $(s).value = ''; });
    setTimeout(() => $('#rNew').focus(), 0);
  } else {
    setMsg('#forceMsg', msg); ['#fCur', '#fNew', '#fNew2'].forEach(s => { $(s).value = ''; });
    setTimeout(() => $('#fCur').focus(), 0);
  }
}
let resetToken = null;
async function loadAuthOptions() {
  try { const o = await api('GET', '/auth/options', undefined, {noAuthRedirect: true}); $('#lForgot').hidden = !o.passwordReset; }
  catch (e) { $('#lForgot').hidden = true; }
}
const WIPE = ['#dayList', '#weekStrip', '#todayList', '#chartHost', '#balList', '#expBreak', '#incBreak', '#txnList', '#inspoWrap', '#userList', '#svcList', '#staffTags', '#qOut', '#uCreated'];
function resetSession() {
  stopPolling(); loadSeq++;
  Object.assign(state, {me: null, features: {}, txns: [], appts: [], settings: null, users: [], uMeta: null, uEdit: null, uReset: null, rev: 0, mode: 'connecting', confirmBook: false, rebookForce: null});
  qPending = null; clearPending(); closeLb();
  WIPE.forEach(s => { const el = $(s); if (el) el.innerHTML = ''; });
  $$('#app input:not([type=radio]):not([type=checkbox]), #app textarea').forEach(i => { i.value = ''; });
  $$('#app select').forEach(s => { delete s.dataset.sig; });
  C = computeCfg();
}
function signedOut(msg) { resetSession(); showAuth('login', msg); }
async function signOut() { await quiet(api('POST', '/auth/logout', undefined, {noAuthRedirect: true})); signedOut(''); }
async function enterApp(d) {
  state.me = d.user; state.features = d.features || {};
  if (state.me.mustChange) { showAuth('force', 'Choose a new password to continue.'); return; }
  $('#auth').hidden = true; $('#app').hidden = false;
  applyNav(); state.mode = 'connecting'; renderHeader();
  try { await loadState(); }
  catch (e) { if (e.status === 401) return; state.mode = 'error'; renderHeader(); }
  setView(location.hash.slice(1));
  startPolling();
}

/* ---------- helpers ---------- */
function fillSelect(el, opts) {
  const sig = JSON.stringify(opts);
  if (el.dataset.sig === sig) return;
  const prev = el.value;
  el.dataset.sig = sig;
  el.innerHTML = opts.map(o => '<option value="' + esc(o.v) + '">' + esc(o.l) + '</option>').join('');
  if (opts.some(o => o.v === prev)) el.value = prev;
}
function setVal(el, v) { if (document.activeElement !== el) el.value = v; }
function arm(btn, run) {
  if (btn.dataset.armed) { run(); return; }
  btn.dataset.armed = '1'; btn.dataset.old = btn.innerHTML; btn.textContent = 'Sure?'; btn.classList.add('armed');
  setTimeout(() => { if (btn.isConnected && btn.dataset.armed) { delete btn.dataset.armed; btn.innerHTML = btn.dataset.old; btn.classList.remove('armed'); } }, 3000);
}
const sumType = (a, type) => a.reduce((x, t) => x + (t.type === type ? num(t.amount) : 0), 0);
function groupSum(tx, type, keyFn) {
  const m = new Map();
  tx.filter(t => t.type === type).forEach(t => { const k = keyFn(t) || 'Other'; m.set(k, (m.get(k) || 0) + num(t.amount)); });
  return Array.from(m).sort((a, b) => b[1] - a[1]);
}
function barList(rows, cls) {
  if (!rows.length) return '<p class="empty-s">Nothing recorded in this period.</p>';
  const max = rows[0][1] || 1;
  return '<ul class="blist">' + rows.map(r => '<li><div class="bl"><span>' + esc(r[0]) + '</span><b>' + money(r[1]) + '</b></div><div class="track"><i class="' + cls + '" style="width:' + Math.max(3, r[1] / max * 100) + '%"></i></div></li>').join('') + '</ul>';
}
function periodRange(p) {
  const t = today(), d = parse(t);
  if (p === '7d') return [addDays(t, -6), t];
  if (p === 'month') return [ymd(new Date(d.getFullYear(), d.getMonth(), 1)), t];
  if (p === 'last') return [ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), ymd(new Date(d.getFullYear(), d.getMonth(), 0))];
  if (p === 'year') return [d.getFullYear() + '-01-01', t];
  const dates = state.txns.map(x => x.date).filter(Boolean).sort();
  return [dates[0] || t, t > (dates[dates.length - 1] || t) ? t : dates[dates.length - 1]];
}
function buildBuckets(start, end) {
  const buckets = [], n = daysBetween(start, end) + 1;
  if (n <= 31) {
    for (let i = 0; i < n; i++) {
      const k = addDays(start, i);
      buckets.push({key: k, label: String(parse(k).getDate()), long: fmtDay(k), inc: 0, exp: 0});
    }
    return {buckets, mode: 'day'};
  }
  let y = +start.slice(0, 4), m = +start.slice(5, 7) - 1;
  const ey = +end.slice(0, 4), em = +end.slice(5, 7) - 1;
  const many = (ey - y) * 12 + (em - m) > 11;
  while (y < ey || (y === ey && m <= em)) {
    const dt = new Date(y, m, 1);
    buckets.push({key: y + '-' + pad(m + 1),
      label: dt.toLocaleDateString('en-GB', many ? {month: 'short', year: '2-digit'} : {month: 'short'}),
      long: dt.toLocaleDateString('en-GB', {month: 'long', year: 'numeric'}), inc: 0, exp: 0});
    m++; if (m > 11) { m = 0; y++; }
  }
  return {buckets, mode: 'month'};
}
function niceMax(v) {
  if (v <= 0) return 1;
  const e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * e;
}
function conflicts(date, time, mins, staff, skipId) {
  const s = toMin(time), e = s + mins;
  return state.appts.filter(a => a.id !== skipId && a.date === date && a.staff === staff && (a.status === 'booked' || a.status === 'done') && toMin(a.time) < e && s < toMin(a.time) + num(a.mins));
}

/* ---------- rendering ---------- */
function onData() { C = computeCfg(); render(); }
function render() {
  if (!state.me) return;
  renderHeader();
  if (state.lb) drawLb();
  const v = state.view;
  if (v === 'overview') renderOverview();
  else if (v === 'book') renderBook();
  else if (v === 'inspo') renderInspo();
  else if (v === 'money') renderMoney();
  else if (v === 'setup') renderSetup();
  else if (v === 'users') renderUsers();
}
function renderHeader() {
  $('#eyebrow').textContent = fmtDay(today());
  const labels = {connecting: 'Connecting', live: staffView() ? 'Shared with team' : 'Connected', slow: 'Waiting for server', error: 'Connection lost, retrying'};
  let s = state.mode, text = labels[s];
  if (s === 'live' && state.me && !hasAnyWrite()) text = 'View only';
  const el = $('#sync'); el.dataset.s = s; el.lastElementChild.textContent = text;
  $('#acctName').textContent = state.me ? (state.me.name.split(' ')[0] || 'Account') : 'Account';
  $$('fieldset[data-w]').forEach(f => { const w = f.dataset.w; f.disabled = !(w === 'book' ? (canWrite('book') || isOwn('book')) : canWrite(w)); });
  $$('[data-gate]').forEach(e => { e.hidden = !gateOk(e.dataset.gate); });
}
function applyNav() {
  $$('.tabs a').forEach(a => { a.hidden = !viewAllowed(a.dataset.v); });
  const own = isOwn('book');
  const set = (v, t) => { const s = $('.tabs a[data-v="' + v + '"] span'); if (s) s.textContent = t; };
  set('book', own ? 'My bookings' : 'Bookings'); set('inspo', isOwn('inspo') ? 'My inspo' : 'Inspo');
}
function setView(v) {
  if (!VIEWS.includes(v) || !viewAllowed(v)) v = firstView();
  state.view = v;
  VIEWS.forEach(n => { $('#v-' + n).hidden = n !== v; });
  $('#noAccess').hidden = v !== null;
  $$('.tabs a').forEach(a => { if (a.dataset.v === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
  if (v && location.hash.slice(1) !== v) history.replaceState(null, '', '#' + v);
  if (v === 'users') quiet(loadUsers());
  render();
}
function renderOverview() {
  const range = periodRange(state.period), s = range[0], e = range[1];
  const tx = state.txns.filter(t => t.date >= s && t.date <= e);
  const inc = sumType(tx, 'income'), exp = sumType(tx, 'expense'), net = inc - exp;
  const pname = (PERIODS.find(p => p[0] === state.period) || PERIODS[1])[1];
  $('#periodChips').innerHTML = PERIODS.map(p => '<button class="chip" data-act="period" data-p="' + p[0] + '" aria-pressed="' + (p[0] === state.period) + '">' + p[1] + '</button>').join('');
  $('#kLabel').textContent = 'Net profit · ' + pname;
  const kp = $('#kProfit'); kp.textContent = money(net); kp.className = 'big ' + (net < 0 ? 'exp' : '');
  $('#kSub').textContent = inc > 0 ? Math.round(net / inc * 100) + '% of income kept after expenses' : 'Record some income to see your margin';
  $('#kInc').textContent = money(inc); $('#kExp').textContent = money(exp);

  const empty = !state.txns.length && !state.appts.length;
  $('#emptyHint').hidden = !empty;
  $('#sampleBanner').hidden = !(state.txns.some(t => t.sample) || state.appts.some(a => a.sample));

  // chart
  const bk = buildBuckets(s, e), buckets = bk.buckets;
  tx.forEach(t => {
    const k = bk.mode === 'day' ? t.date : t.date.slice(0, 7);
    const b = buckets.find(x => x.key === k);
    if (b) { if (t.type === 'income') b.inc += num(t.amount); else b.exp += num(t.amount); }
  });
  const max = niceMax(Math.max.apply(null, buckets.map(b => Math.max(b.inc, b.exp)).concat([0])));
  const step = Math.ceil(buckets.length / 8);
  const h = v => v > 0 ? 'max(' + (v / max * 100).toFixed(2) + '%,3px)' : '0';
  chartData = {buckets, inc, exp};
  $('#chartHost').innerHTML = '<div class="chart"><div class="yl"><span>' + compact(max) + '</span><span>' + compact(max / 2) + '</span><span>0</span></div>' +
    '<div class="plot"><div class="gl"><i></i><i></i><i></i></div><div class="cols">' +
    buckets.map((b, i) => '<button class="col" data-act="bucket" data-i="' + i + '" aria-pressed="false" aria-label="' + esc(b.long) + '"><span class="bars"><i class="bar i" style="height:' + h(b.inc) + '"></i><i class="bar e" style="height:' + h(b.exp) + '"></i></span><span class="lbl' + (i % step ? ' off' : '') + '">' + esc(b.label) + '</span></button>').join('') +
    '</div></div></div>';
  $('#readout').textContent = pname + ': income ' + money(inc) + ', expenses ' + money(exp);

  // balances
  const bal = {cash: num(C.opening.cash), card: num(C.opening.card), bank: num(C.opening.bank)};
  state.txns.forEach(t => { const m = bal[t.method] !== undefined ? t.method : 'cash'; bal[m] += (t.type === 'income' ? 1 : -1) * num(t.amount); });
  const total = bal.cash + bal.card + bal.bank;
  $('#balList').innerHTML = Object.keys(METHODS).map(k => '<li><span>' + METHODS[k] + '</span><b class="' + (bal[k] < 0 ? 'exp' : '') + '">' + money(bal[k]) + '</b></li>').join('') +
    '<li class="total"><span>Total balance</span><span class="' + (total < 0 ? 'exp' : '') + '">' + money(total) + '</span></li>';

  $('#expBreak').innerHTML = barList(groupSum(tx, 'expense', t => t.category), 'e');
  $('#incBreak').innerHTML = barList(groupSum(tx, 'income', t => t.service || t.category), 'i');

  const td = today();
  const tAll = state.appts.filter(a => a.date === td && a.status !== 'cancelled' && a.status !== 'noshow');
  const tDone = tAll.filter(a => a.status === 'done').length, tLeft = tAll.length - tDone;
  const nowM = new Date().getHours() * 60 + new Date().getMinutes();
  const tNext = tAll.filter(a => a.status === 'booked').sort((a, b) => a.time.localeCompare(b.time)).find(a => toMin(a.time) >= nowM) || null;
  $('#tCount').textContent = tAll.length;
  $('#tLbl').textContent = tAll.length === 1 ? 'appointment' : 'appointments';
  $('#tSub').textContent = !tAll.length ? 'Nothing booked for today yet.'
    : tDone + ' paid, ' + tLeft + ' still to come' + (tNext ? '. Next: ' + fmtTime(tNext.time) + ' with ' + tNext.client + '.' : '.');
  const list = state.appts.filter(a => a.date === td && a.status === 'booked').sort((a, b) => a.time.localeCompare(b.time));
  $('#todayList').innerHTML = list.length
    ? '<ul class="up">' + list.map(a => '<li><time>' + fmtTime(a.time) + '</time><div><b>' + esc(a.client) + '</b><br><span class="muted">' + esc(a.service) + ' with ' + esc(a.staff) + '</span></div></li>').join('') + '</ul>'
    : '<p class="empty-s">Nothing booked for today.</p>';
}

function thumbsHtml(a) {
  const ins = Array.isArray(a.inspo) ? a.inspo : [], can = canEditPhotos(a);
  if (!ins.length && !can) return '';
  return '<div class="thumbs">' + ins.map((id, i) => '<button class="th" data-act="lb" data-id="' + esc(a.id) + '" data-i="' + i + '" aria-label="View inspo photo ' + (i + 1) + '"><img src="/_blob/' + esc(id) + '" alt="Inspo photo ' + (i + 1) + ' for ' + esc(a.client) + '" loading="lazy"></button>').join('') +
    (can ? '<label class="btn sm ghost filebtn">Add inspo<input type="file" accept="image/*" multiple data-act-file="' + esc(a.id) + '" aria-label="Add inspo photos for ' + esc(a.client) + '"></label>' : '') + '</div>';
}
function apptHtml(a) {
  const end = fromMin(toMin(a.time) + num(a.mins)), id = esc(a.id);
  const mine = !!state.me && a.ownerId === state.me.id;
  let acts = '';
  if (staffView()) {
    if (a.status === 'booked') {
      acts = (canPay() ? '<span class="paylbl">Paid by</span>' + Object.keys(METHODS).map(k => '<button class="btn sm pay" data-act="pay" data-id="' + id + '" data-m="' + k + '">' + METHODS[k] + '</button>').join('') : '') +
        '<span class="sp"></span><button class="btn sm ghost" data-act="cancel" data-id="' + id + '">Cancel</button><button class="btn sm ghost" data-act="noshow" data-id="' + id + '">No-show</button>';
    } else if (a.status === 'done') {
      acts = '<span class="paylbl">' + esc(METHODS[a.method] || 'Paid') + ' · ' + money(num(a.price)) + ' recorded</span><span class="sp"></span>' +
        (canPay() ? '<button class="btn sm ghost" data-act="undo" data-id="' + id + '">Undo payment</button>' : '');
    } else {
      acts = '<span class="sp"></span><button class="btn sm ghost" data-act="rebook" data-id="' + id + '">Rebook</button>';
    }
    acts += '<button class="btn sm ghost" data-act="delAppt" data-id="' + id + '">Delete</button>';
  } else if (isOwn('book') && mine && a.status === 'booked') {
    acts = '<span class="sp"></span><button class="btn sm ghost" data-act="cancel" data-id="' + id + '">Cancel booking</button>';
  }
  return '<div class="appt ' + esc(a.status) + '"><div class="tm"><b>' + fmtTime(a.time) + '</b><span>to ' + fmtTime(end) + '</span></div>' +
    '<div><p class="who">' + esc(a.client) + '</p><p class="what">' + esc(a.service) + ' with ' + esc(a.staff) + '</p>' +
    (a.phone || a.note ? '<p class="what">' + esc([a.phone, a.note].filter(Boolean).join(' · ')) + '</p>' : '') + '</div>' +
    '<div class="side"><b>' + money(num(a.price)) + '</b><span class="pill ' + esc(a.status) + '">' + (STATUS[a.status] || 'Booked') + '</span></div>' +
    thumbsHtml(a) + (acts ? '<div class="acts">' + acts + '</div>' : '') + '</div>';
}
function renderBook() {
  const cust = !staffView();
  fillSelect($('#aStaff'), C.staff.map(s => ({v: s, l: s})));
  $('#aInspoWrap').hidden = !canUpload();
  $('#quick').hidden = !(state.features.quickBook && staffView());
  const opts = [{v: '', l: 'Choose a service'}].concat(C.services.map(s => ({v: s.id, l: s.name})));
  if (!cust) opts.push({v: 'custom', l: 'Custom service'});
  fillSelect($('#aService'), opts);
  $('#aClient').readOnly = cust; $('#aPrice').readOnly = cust; $('#aMins').readOnly = cust;
  if (cust) {
    $('#aClient').value = state.me.name;
    if (!$('#aPhone').value && document.activeElement !== $('#aPhone')) $('#aPhone').value = state.me.phone || '';
  }
  $('#aDate').min = cust ? today() : '';
  $('#aSubmit').textContent = state.confirmBook ? 'Book anyway' : (cust ? 'Book appointment' : 'Add to book');
  if (!$('#aDate').value) $('#aDate').value = state.apptDate;
  const d = state.apptDate, td = today();
  $('#dTitle').textContent = d === td ? 'Today, ' + fmtShort(d) : fmtDay(d);
  const list = state.appts.filter(a => a.date === d).sort((a, b) => a.time.localeCompare(b.time));
  const live = list.filter(a => a.status === 'booked' || a.status === 'done');
  $('#dMeta').textContent = live.length ? live.length + (live.length === 1 ? ' client' : ' clients') + ' · ' + money(live.reduce((x, a) => x + num(a.price), 0)) + ' expected' : 'No clients booked';
  const dow = (parse(d).getDay() + 6) % 7, mon = addDays(d, -dow);
  const names = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  $('#weekStrip').innerHTML = names.map((n, i) => {
    const k = addDays(mon, i), c = state.appts.filter(a => a.date === k && a.status !== 'cancelled').length;
    return '<button class="wd' + (k === td ? ' today' : '') + '" data-act="pickday" data-d="' + k + '" aria-pressed="' + (k === d) + '" aria-label="' + esc(fmtDay(k)) + '"><small>' + n + '</small><b>' + parse(k).getDate() + '</b><em>' + (c || '') + '</em></button>';
  }).join('');
  $('#dayList').innerHTML = list.length ? list.map(apptHtml).join('') : '<p class="empty-s">Nothing on this day yet.' + (canWrite('book') || isOwn('book') ? ' Use the form to add a booking.' : '') + '</p>';
}

function renderMoney() {
  const type = ($('input[name="tType"]:checked') || {}).value || 'income';
  fillSelect($('#tCat'), (type === 'income' ? INC_CATS : EXP_CATS).map(c => ({v: c, l: c})));
  fillSelect($('#tMethod'), Object.keys(METHODS).map(k => ({v: k, l: METHODS[k]})));
  if (!$('#tDate').value) $('#tDate').value = today();
  const months = Array.from(new Set(state.txns.map(t => (t.date || '').slice(0, 7)).filter(Boolean))).sort().reverse();
  if (state.mf.month !== 'all' && months.indexOf(state.mf.month) < 0) state.mf.month = 'all';
  fillSelect($('#mMonth'), [{v: 'all', l: 'All months'}].concat(months.map(m => ({v: m, l: monthName(m)}))));
  $('#mMonth').value = state.mf.month;
  $$('#typeChips .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.t === state.mf.type)));
  const list = filteredTxns();
  $('#mSummary').textContent = list.length ? list.length + (list.length === 1 ? ' entry' : ' entries') + ' · income ' + money(sumType(list, 'income')) + ' · expenses ' + money(sumType(list, 'expense')) : '';
  $('#txnList').innerHTML = list.length ? list.slice(0, 200).map(t =>
    '<li class="row"><span class="d">' + fmtShort(t.date) + '</span><div class="m"><b>' + esc(t.service || t.category || 'Other') + '</b><span>' + esc([t.note, METHODS[t.method]].filter(Boolean).join(' · ')) + '</span></div>' +
    '<span class="a ' + (t.type === 'income' ? 'inc' : 'exp') + '">' + (t.type === 'income' ? '+' : '−') + money(num(t.amount)) + '</span>' +
    (canWrite('money') ? '<button class="btn x" data-act="delTxn" data-id="' + esc(t.id) + '" aria-label="Delete entry">&times;</button>' : '<span></span>') + '</li>').join('')
    : '<li class="empty-s" style="list-style:none">No transactions match. Add one with the form.</li>';
  $('#exportBtn').hidden = false;
}
function filteredTxns() {
  return state.txns.filter(t => (state.mf.type === 'all' || t.type === state.mf.type) && (state.mf.month === 'all' || (t.date || '').slice(0, 7) === state.mf.month))
    .sort((a, b) => (b.date || '').localeCompare(a.date || '') || (b.createdAt || 0) - (a.createdAt || 0));
}


function renderSetup() {
  const dis = canWrite('setup') ? '' : ' disabled';
  fillSelect($('#sCur'), CURRENCIES.map(c => ({v: c, l: c})));
  if (document.activeElement !== $('#sCur')) $('#sCur').value = C.currency;
  setVal($('#oCash'), C.opening.cash || ''); setVal($('#oCard'), C.opening.card || ''); setVal($('#oBank'), C.opening.bank || '');
  $('#staffTags').innerHTML = C.staff.map((s, i) => '<span class="tag">' + esc(s) + '<button data-act="rmStaff" data-i="' + i + '"' + dis + ' aria-label="Remove ' + esc(s) + '">&times;</button></span>').join('');
  const box = $('#svcList');
  if (box.contains(document.activeElement) && document.activeElement.tagName === 'INPUT') return;
  box.innerHTML = C.services.map((s, i) => '<div class="svc" data-i="' + i + '"><label class="f"><span>Service</span><input data-k="name" value="' + esc(s.name) + '" maxlength="60"' + dis + '></label>' +
    '<label class="f"><span>Price</span><input data-k="price" type="number" min="0" step="any" value="' + esc(s.price) + '"' + dis + '></label>' +
    '<label class="f"><span>Min</span><input data-k="mins" type="number" min="5" step="5" value="' + esc(s.mins) + '"' + dis + '></label>' +
    '<button class="btn x" data-act="rmSvc" data-i="' + i + '"' + dis + ' aria-label="Remove ' + esc(s.name) + '">&times;</button></div>').join('') || '<p class="empty-s">No services yet. Add your first below.</p>';
}

/* ---------- actions ---------- */
const idp = id => encodeURIComponent(id);
async function pay(id, method) {
  const a = state.appts.find(x => x.id === id); if (!a) return;
  await act(() => api('POST', '/appts/' + idp(id) + '/pay', {method}));
  toast('Recorded ' + money(num(a.price)) + ' from ' + a.client);
}
async function setStatus(id, status, force) {
  try { await act(() => api('POST', '/appts/' + idp(id) + '/status', {status, force: !!force}), {silent: true}); state.rebookForce = null; }
  catch (e) {
    if (e.code === 'conflict' && status === 'booked') { state.rebookForce = id; toast(e.message + ' Tap Rebook again to book anyway.'); }
    else reportError(e);
    throw e;
  }
}
const undoPay = id => act(() => api('POST', '/appts/' + idp(id) + '/undo-pay'));
async function loadSample() {
  toast('Loading sample data');
  await act(() => api('POST', '/sample'));
  toast('Sample data loaded. You can clear it in Setup.');
}
async function clearSample() {
  if (!state.txns.some(t => t.sample) && !state.appts.some(a => a.sample)) { toast('No sample data to clear.'); return; }
  await act(() => api('DELETE', '/sample'));
  toast('Sample data cleared.');
}
async function exportCsv() {
  // Prefix cells that a spreadsheet would run as formulas (CSV injection); real numbers are left alone.
  const q = v => {
    let s = String(v == null ? '' : v);
    if (/^[=+\-@\t\r]/.test(s) && isNaN(Number(s))) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const rows = [['Date', 'Type', 'Category', 'Detail', 'Paid with', 'Amount']].concat(filteredTxns().map(t => [t.date, t.type, t.service || t.category, t.note, METHODS[t.method] || '', (t.type === 'income' ? '' : '-') + num(t.amount)]));
  const csv = '\ufeff' + rows.map(r => r.map(q).join(',')).join('\r\n'), name = 'rode-' + today() + '.csv';
  try {
    const url = URL.createObjectURL(new Blob([csv], {type: 'text/csv;charset=utf-8'})), a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { toast('The file was not saved.'); }
}

/* ---------- inspo photos ---------- */
function uploadMsg(e) {
  const c = e && e.code;
  if (c === 'too_large') return 'That photo is too large.';
  if (c === 'unsupported_type') return 'Use JPG, PNG, WebP or GIF photos.';
  if (c === 'quota_or_state') return 'Too many photos are waiting. Attach or remove some first.';
  if (c === 'rate_limited') return 'Too many uploads at once. Wait a moment and try again.';
  return (e && e.message) || "Couldn't upload that photo.";
}
function shrink(file) {
  return new Promise(res => {
    const url = URL.createObjectURL(file), img = new Image();
    img.onload = () => {
      const sc = Math.min(1, 1600 / Math.max(img.width, img.height)), c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.width * sc)); c.height = Math.max(1, Math.round(img.height * sc));
      const g = c.getContext('2d');
      g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // JPEG has no alpha: avoid black backgrounds on PNGs
      g.drawImage(img, 0, 0, c.width, c.height);
      c.toBlob(b => { URL.revokeObjectURL(url); res(b || file); }, 'image/jpeg', 0.85);
    };
    img.onerror = () => { URL.revokeObjectURL(url); res(file); };
    img.src = url;
  });
}
async function uploadAll(files) {
  const ids = [];
  if (!canUpload()) { toast('Your account cannot add photos.'); return ids; }
  for (const f of Array.from(files).slice(0, 8)) {
    try { const r = await api('POST', '/assets', undefined, {raw: await shrink(f)}); ids.push(r.id); }
    catch (e) { if (e.status === 401) break; if (!e.handled) toast(uploadMsg(e)); }
  }
  return ids;
}
const discardUploads = ids => ids.forEach(id => quiet(api('DELETE', '/assets/' + idp(id))));
async function attachTo(id, files) {
  const a = state.appts.find(x => x.id === id); if (!a) return;
  toast('Uploading ' + files.length + (files.length === 1 ? ' photo' : ' photos') + '…');
  const ids = await uploadAll(files);
  if (!ids.length) return;
  try { await act(() => api('POST', '/appts/' + idp(id) + '/inspo', {assetIds: ids})); }
  catch (e) { discardUploads(ids); return; }
  toast('Added ' + ids.length + (ids.length === 1 ? ' photo' : ' photos') + ' to ' + a.client);
}

function renderPrev() {
  $('#aPrev').innerHTML = state.pendingUrls.map((u, i) => '<div class="pv"><img src="' + u + '" alt="Selected photo ' + (i + 1) + '"><button type="button" data-act="rmPend" data-i="' + i + '" aria-label="Remove photo ' + (i + 1) + '">&times;</button></div>').join('');
  $('#aFilesNote').textContent = state.pending.length ? state.pending.length + ' selected' : 'Optional';
}
function clearPending() { state.pendingUrls.forEach(u => URL.revokeObjectURL(u)); state.pending = []; state.pendingUrls = []; renderPrev(); }
function renderInspo() {
  const groups = new Map();
  state.appts.filter(a => Array.isArray(a.inspo) && a.inspo.length).sort((a, b) => (b.date || '').localeCompare(a.date || '')).forEach(a => {
    const k = (a.client || 'Unnamed').trim().toLowerCase();
    if (!groups.has(k)) groups.set(k, {name: a.client || 'Unnamed', items: []});
    a.inspo.forEach((id, i) => groups.get(k).items.push({a, id, i}));
  });
  $('#inspoWrap').innerHTML = groups.size ? Array.from(groups.values()).map(g =>
    '<section class="grp"><div class="head"><h3>' + esc(g.name) + '</h3><span class="note">' + g.items.length + (g.items.length === 1 ? ' photo' : ' photos') + '</span></div><div class="gal">' +
    g.items.map(x => '<button class="th" data-act="lb" data-id="' + esc(x.a.id) + '" data-i="' + x.i + '" aria-label="Open photo for ' + esc(x.a.client) + ', ' + esc(fmtShort(x.a.date)) + '"><img src="/_blob/' + esc(x.id) + '" alt="Inspo for ' + esc(x.a.client) + '" loading="lazy"></button>').join('') + '</div></section>').join('')
    : '<p class="empty-s">No inspo yet. Open Bookings and tap Add inspo on a booking, or attach photos when you create one.</p>';
}
function openLb(id, i) {
  const a = state.appts.find(x => x.id === id); if (!a || !a.inspo || !a.inspo[i]) return;
  state.lb = {id, i}; drawLb(); $('#lb').hidden = false; $('#lb [data-act="lbx"]').focus();
}
function drawLb() {
  const lb = state.lb, a = lb && state.appts.find(x => x.id === lb.id);
  if (!a || !Array.isArray(a.inspo) || !a.inspo.length) { closeLb(); return; }
  if (lb.i >= a.inspo.length) lb.i = a.inspo.length - 1;
  $('#lbImg').src = '/_blob/' + a.inspo[lb.i];
  $('#lbImg').alt = 'Inspo photo ' + (lb.i + 1) + ' for ' + a.client;
  $('#lbCap').textContent = a.client + ' · ' + fmtShort(a.date) + ' · ' + (lb.i + 1) + ' of ' + a.inspo.length;
  $('#lbRm').hidden = !canEditPhotos(a);
}
function closeLb() { state.lb = null; $('#lb').hidden = true; $('#lbImg').removeAttribute('src'); }
function stepLb(d) {
  const a = state.lb && state.appts.find(x => x.id === state.lb.id); if (!a) return;
  state.lb.i = (state.lb.i + d + a.inspo.length) % a.inspo.length; drawLb();
}
async function removeLbPhoto() {
  const lb = state.lb, a = lb && state.appts.find(x => x.id === lb.id); if (!a) return;
  const pid = a.inspo[lb.i];
  await act(() => api('DELETE', '/appts/' + idp(a.id) + '/inspo/' + idp(pid)));
  toast('Photo removed');
}

/* ---------- quick book (spoken or typed) ---------- */
const str = v => (typeof v === 'string' && v.trim() && v.trim().toLowerCase() !== 'null') ? v.trim() : null;
function sampleMsg(e) { return (e && e.message) || "I couldn't read that. Say it again with the client, service, day and time."; }
function qMsg(html) { $('#qOut').innerHTML = html; }
async function quickParse() {
  const text = $('#qText').value.trim();
  if (!text) { toast('Say or type the booking first.'); return; }
  if (!staffView() || !state.features.quickBook) return;
  const go = $('#qGo'); go.disabled = true; go.textContent = 'Reading…'; qMsg(''); qPending = null;
  try { const r = await api('POST', '/quick-parse', {text: text.slice(0, 600)}); handleParsed(r.parsed); }
  catch (e) { if (!e.handled) qMsg('<p class="warn">' + esc(sampleMsg(e)) + '</p>'); }
  finally { go.disabled = false; go.textContent = 'Read booking'; }
}

function handleParsed(r) {
  if (!r || typeof r !== 'object' || Array.isArray(r)) { qMsg('<p class="warn">' + esc(sampleMsg({code: 'invalid_json'})) + '</p>'); return; }
  const sName = str(r.service), low = sName ? sName.toLowerCase() : '';
  const svc = sName ? (C.services.find(s => s.name.toLowerCase() === low) || C.services.find(s => s.name.toLowerCase().indexOf(low) >= 0 || low.indexOf(s.name.toLowerCase()) >= 0)) : null;
  const time = typeof r.time === 'string' && /^\d{1,2}:\d{2}$/.test(r.time) ? pad(+r.time.split(':')[0]) + ':' + r.time.split(':')[1] : null;
  let date = /^\d{4}-\d{2}-\d{2}$/.test(r.date || '') && !isNaN(parse(r.date)) ? r.date : null, pastDate = false;
  if (date && date < today()) { pastDate = true; date = null; }
  const sw = (str(r.staff) || '').toLowerCase();
  const m = {
    client: str(r.client), phone: str(r.phone), note: str(r.note), date, time,
    service: svc ? svc.name : sName, svc,
    staff: C.staff.find(x => x.toLowerCase() === sw) || C.staff[0],
    mins: svc ? svc.mins : (num(r.mins) > 0 ? num(r.mins) : 60),
    price: svc ? svc.price : num(r.price)
  };
  const miss = [];
  if (!m.client) miss.push("the client's name");
  if (!m.service) miss.push('the service');
  if (!m.date) miss.push(pastDate ? 'the day (that date has already passed)' : 'the day');
  if (!m.time) miss.push('the time');
  if (m.service && !svc && !(m.price > 0)) miss.push('the price');
  qPending = m;
  if (miss.length) {
    qMsg('<div class="qsum"><p><b>Still need ' + esc(miss.join(', ')) + '.</b> Add it to the note above and press Read booking again.</p><div class="qbtns"><button class="btn sm" type="button" data-act="qedit">Fill the form with what I got</button></div></div>');
    return;
  }
  const clash = conflicts(m.date, m.time, m.mins, m.staff);
  m.clash = clash.length > 0;
  qMsg('<div class="qsum"><dl><dt>Client</dt><dd>' + esc(m.client) + (m.phone ? ' · ' + esc(m.phone) : '') + '</dd>' +
    '<dt>Service</dt><dd>' + esc(m.service) + ' · ' + m.mins + ' min · ' + money(m.price) + '</dd>' +
    '<dt>When</dt><dd>' + esc(fmtDay(m.date)) + ', ' + fmtTime(m.time) + '</dd>' +
    '<dt>With</dt><dd>' + esc(m.staff) + '</dd>' + (m.note ? '<dt>Note</dt><dd>' + esc(m.note) + '</dd>' : '') + '</dl>' +
    (clash.length ? '<p class="warn">' + esc(m.staff) + ' already has ' + esc(clash[0].client) + ' at ' + fmtTime(clash[0].time) + '.</p>' : '') +
    '<div class="qbtns"><button class="btn primary" type="button" data-act="qconfirm">' + (clash.length ? 'Book anyway' : 'Confirm booking') + '</button><button class="btn" type="button" data-act="qedit">Edit in form</button></div></div>');
}
let rec = null;
function micStart() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition, btn = $('#qMic');
  const fallback = () => { $('#qText').focus(); toast('The page cannot use the microphone here. Tap the microphone key on your keyboard and speak.'); };
  if (rec) { try { rec.stop(); } catch (e) {} return; }
  if (!SR) { fallback(); return; }
  let heard = false;
  try {
    rec = new SR(); rec.lang = navigator.language || 'en-US'; rec.interimResults = true; rec.continuous = false;
    btn.textContent = 'Listening… tap to stop';
    rec.onresult = ev => { heard = true; $('#qText').value = Array.from(ev.results).map(r => r[0].transcript).join(' '); };
    rec.onerror = () => { if (!heard) fallback(); };
    rec.onend = () => { rec = null; btn.textContent = 'Speak'; if (heard) quickParse(); };
    rec.start();
  } catch (e) { rec = null; btn.textContent = 'Speak'; fallback(); }
}
async function quickConfirm() {
  const m = qPending; if (!m || !m.date) return;
  const body = {date: m.date, time: m.time, mins: m.mins, client: m.client, phone: m.phone || '', service: m.service, staff: m.staff, price: m.price, note: m.note || '', force: !!m.clash};
  if (m.svc) body.serviceId = m.svc.id;
  try { await act(() => api('POST', '/appts', body), {silent: true}); }
  catch (e) { if (!e.handled) qMsg('<p class="warn">' + esc(e.message) + '</p>'); return; }
  state.apptDate = m.date; qPending = null; $('#qText').value = ''; qMsg('');
  toast('Booked ' + m.client + ' for ' + fmtDay(m.date) + ' at ' + fmtTime(m.time) + '. Tap Add inspo on the booking to attach photos.');
  renderBook();
}
function quickEdit() {
  const m = qPending; if (!m) return;
  $('#aClient').value = m.client || ''; $('#aPhone').value = m.phone || '';
  $('#aService').value = m.svc ? m.svc.id : (m.service ? 'custom' : '');
  $('#aService').dispatchEvent(new Event('change'));
  if (!m.svc && m.service) $('#aCustom').value = m.service;
  $('#aPrice').value = m.price || ''; $('#aMins').value = m.mins || '';
  $('#aDate').value = m.date || state.apptDate; $('#aTime').value = m.time || '';
  $('#aStaff').value = m.staff; $('#aNote').value = m.note || '';
  $('#aClient').scrollIntoView({behavior: 'smooth', block: 'center'});
}
/* ---------- user administration (administrators only; the server enforces this) ---------- */
const SECTION_LABELS = {overview: 'Overview & reports', book: 'Bookings', inspo: 'Client inspo', money: 'Money & ledger', setup: 'Setup'};
const LEVEL_LABELS = {none: 'No access', own: 'Own only', read: 'View', write: 'View & edit'};
const ROLE_NOTES = {
  customer: 'Customers sign in to book appointments and manage only their own bookings and photos. They never see other clients, money or setup.',
  staff: 'Team members run the day: bookings, photos and the ledger. Tune each section below.',
  viewer: 'View-only accounts can look but not change anything.',
  admin: 'Administrators have full access and can manage users.'
};
const roleMeta = id => (state.uMeta && state.uMeta.roles.find(r => r.id === id)) || null;
function accessSelects(role, current, disabled) {
  const rm = roleMeta(role); if (!rm) return '';
  return state.uMeta.sections.map(sec => {
    const allowed = rm.allowed[sec], val = current && allowed.includes(current[sec]) ? current[sec] : rm.preset[sec];
    return '<label class="f"><span>' + esc(SECTION_LABELS[sec]) + '</span><select data-sec="' + sec + '"' + (allowed.length < 2 || disabled ? ' disabled' : '') + '>' +
      allowed.map(l => '<option value="' + l + '"' + (l === val ? ' selected' : '') + '>' + esc(LEVEL_LABELS[l]) + '</option>').join('') + '</select></label>';
  }).join('');
}
const readAccess = box => { const o = {}; $$('select[data-sec]', box).forEach(s => { o[s.dataset.sec] = s.value; }); return o; };
function genPassword(len) {
  const alpha = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789', lim = 256 - (256 % alpha.length);
  let out = '';
  while (out.length < len) { const b = new Uint8Array(32); crypto.getRandomValues(b); for (const x of b) { if (x < lim && out.length < len) out += alpha[x % alpha.length]; } }
  return out;
}
async function loadUsers() {
  const d = await api('GET', '/users');
  state.users = d.users; state.uMeta = d.meta;
  if (state.view === 'users') renderUsers();
}
function renderCreateAccess() {
  const role = $('#uRole').value, box = $('#uAccess');
  box.innerHTML = accessSelects(role, null); box.dataset.role = role;
  $('#uRoleNote').textContent = ROLE_NOTES[role] || '';
}
const fmtWhen = ms => ms ? new Date(ms).toLocaleString('en-GB', {day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'}) : '';
function accessSummary(u) {
  if (u.role === 'admin') return 'Full access, manages users';
  const parts = Object.keys(SECTION_LABELS).filter(s => u.access[s] !== 'none').map(s => SECTION_LABELS[s] + ': ' + LEVEL_LABELS[u.access[s]].toLowerCase());
  return parts.join(' · ') || 'No access to any section';
}
function userCard(u) {
  const self = state.me && u.id === state.me.id, editing = state.uEdit === u.id, resetting = state.uReset === u.id, rm = roleMeta(u.role);
  const id = esc(u.id);
  let h = '<div class="ucard' + (u.active ? '' : ' off') + '"><div class="uhead"><div class="um"><p class="who">' + esc(u.name) + ' <span class="pill">' + esc(rm ? rm.label : u.role) + '</span>' +
    (u.active ? '' : ' <span class="pill cancelled">Inactive</span>') + (self ? ' <span class="pill done">You</span>' : '') + (u.mustChange ? ' <span class="pill noshow">Temp password</span>' : '') + '</p>' +
    '<p class="what">@' + esc(u.username) + (u.phone ? ' · ' + esc(u.phone) : '') + (u.email ? ' · ' + esc(u.email) : '') + '</p>' +
    '<p class="what">' + esc(accessSummary(u)) + '</p>' +
    '<p class="what">' + (u.lastLoginAt ? 'Last sign-in ' + esc(fmtWhen(u.lastLoginAt)) : 'Never signed in') + '</p></div>' +
    '<div class="uacts"><button class="btn sm" data-act="uedit" data-id="' + id + '">' + (editing ? 'Close' : 'Edit') + '</button>' +
    '<button class="btn sm ghost" data-act="ureset" data-id="' + id + '">' + (resetting ? 'Close' : 'Reset password') + '</button>' +
    (self ? '' : '<button class="btn sm ghost" data-act="utoggle" data-id="' + id + '">' + (u.active ? 'Deactivate' : 'Activate') + '</button><button class="btn sm ghost" data-act="udel" data-id="' + id + '">Delete</button>') + '</div></div>';
  if (editing) {
    h += '<form class="uform" data-uedit="' + id + '" autocomplete="off"><div class="fields"><label class="f"><span>Full name</span><input name="name" value="' + esc(u.name) + '" required maxlength="80"></label>' +
      '<label class="f"><span>Phone</span><input name="phone" value="' + esc(u.phone) + '" maxlength="30"></label>' +
      '<label class="f"><span>Email (for password reset)</span><input name="email" type="email" value="' + esc(u.email) + '" maxlength="120" autocapitalize="none"></label></div>' +
      '<label class="f"><span>Role</span><select name="role" data-role-for="edit"' + (self ? ' disabled' : '') + '>' + state.uMeta.roles.map(r => '<option value="' + r.id + '"' + (r.id === u.role ? ' selected' : '') + '>' + esc(r.label) + '</option>').join('') + '</select></label>' +
      '<div class="access" data-access-box>' + accessSelects(u.role, u.access) + '</div><p class="note" data-role-note>' + esc(ROLE_NOTES[u.role] || '') + '</p>' +
      '<p class="warn" data-err hidden></p><div class="inline"><button class="btn primary" type="submit">Save changes</button><button class="btn ghost" type="button" data-act="uedit" data-id="' + id + '">Cancel</button></div></form>';
  }
  if (resetting) {
    h += '<form class="uform" data-ureset="' + id + '" autocomplete="off"><label class="f"><span>New temporary password</span><span class="inline" style="margin-top:0"><input name="password" type="text" required minlength="10" maxlength="128" autocomplete="off" autocapitalize="none" spellcheck="false"><button class="btn" type="button" data-act="genPass" data-target-form="1">Generate</button></span></label>' +
      '<label class="check"><input type="checkbox" name="must" checked><span>Ask them to choose their own password at next sign-in</span></label>' +
      '<p class="note">This signs them out everywhere.</p><p class="warn" data-err hidden></p><div class="inline"><button class="btn primary" type="submit">Set password</button></div></form>';
  }
  return h + '</div>';
}
function renderUsers() {
  if (!isAdmin()) return;
  if (!state.uMeta) { $('#userList').innerHTML = '<p class="empty-s">Loading…</p>'; return; }
  fillSelect($('#uRole'), state.uMeta.roles.map(r => ({v: r.id, l: r.label})));
  if (!$('#uRole').dataset.init) { $('#uRole').value = 'customer'; $('#uRole').dataset.init = '1'; }
  if ($('#uAccess').dataset.role !== $('#uRole').value) renderCreateAccess();
  $$('#uFilter .chip').forEach(c => c.setAttribute('aria-pressed', String(c.dataset.f === state.uFilter)));
  const list = state.users.filter(u => state.uFilter === 'all' || (state.uFilter === 'customer' ? u.role === 'customer' : u.role !== 'customer'));
  $('#uCount').textContent = state.users.length + (state.users.length === 1 ? ' account' : ' accounts');
  const box = $('#userList');
  if (box.contains(document.activeElement) && ['INPUT', 'SELECT'].includes(document.activeElement.tagName)) return; // never wipe a form mid-edit
  box.innerHTML = list.length ? list.map(userCard).join('') : '<p class="empty-s">Nobody here yet.</p>';
}
function showCreds(user, password, mustChange) {
  const box = $('#uCreated');
  box.innerHTML = '<p><b>Sign-in details for ' + esc(user.name) + '</b></p><dl><dt>Username</dt><dd>' + esc(user.username) + '</dd><dt>Password</dt><dd>' + esc(password) + '</dd></dl>' +
    '<p class="note">' + (mustChange ? 'They will be asked to choose a new password when they first sign in. ' : '') + 'This password is shown only now. Copy it before leaving this page.</p>' +
    '<div class="qbtns"><button class="btn sm" type="button" data-act="ucopy" data-u="' + esc(user.username) + '" data-p="' + esc(password) + '">Copy details</button><button class="btn sm ghost" type="button" data-act="uhide">Hide</button></div>';
  box.hidden = false; box.scrollIntoView({behavior: 'smooth', block: 'nearest'});
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied.'); }
  catch (e) {
    const t = document.createElement('textarea'); t.value = text; t.style.position = 'fixed'; t.style.opacity = '0'; document.body.appendChild(t); t.select();
    try { document.execCommand('copy'); toast('Copied.'); } catch (e2) { toast('Could not copy. Select the text and copy it manually.'); }
    t.remove();
  }
}
async function submitCreateUser() {
  setMsg('#uWarn', '');
  const btn = $('#uSubmit'); btn.disabled = true;
  const password = $('#uPass').value, mustChange = $('#uMust').checked;
  try {
    const r = await api('POST', '/users', {name: $('#uName').value.trim(), username: $('#uUser').value.trim(), phone: $('#uPhone').value.trim(), email: $('#uEmail').value.trim(), role: $('#uRole').value, access: readAccess($('#uAccess')), password, mustChange});
    showCreds(r.user, password, mustChange);
    ['#uName', '#uUser', '#uPhone', '#uEmail', '#uPass'].forEach(s => { $(s).value = ''; });
    $('#uRole').value = 'customer'; renderCreateAccess(); $('#uMust').checked = true;
    toast('Created ' + r.user.name + '.');
    await loadUsers();
  } catch (e) { if (!e.handled) setMsg('#uWarn', e.message); }
  finally { btn.disabled = false; }
}
async function userAction(fn, okMsg) {
  try { await fn(); await loadUsers(); if (okMsg) toast(okMsg); }
  catch (e) { reportError(e); }
}

/* ---------- account dialog ---------- */
function openAcct() {
  if (!state.me) return;
  $('#acctWho').textContent = state.me.name + ' · @' + state.me.username + ' · ' + state.me.roleLabel;
  ['#pCur', '#pNew', '#pNew2'].forEach(s => { $(s).value = ''; }); setMsg('#acctMsg', '');
  $('#acct').hidden = false; $('#pCur').focus();
}
function closeAcct() { $('#acct').hidden = true; }
async function changePassword(cur, next, again, msgSel, btn) {
  if (next !== again) { setMsg(msgSel, 'The new passwords do not match.'); return null; }
  if (next.length < 10) { setMsg(msgSel, 'Use at least 10 characters.'); return null; }
  setMsg(msgSel, ''); btn.disabled = true;
  try { return await api('POST', '/auth/password', {current: cur, next}); }
  catch (e) { if (!e.handled) setMsg(msgSel, e.message); return null; }
  finally { btn.disabled = false; }
}

/* ---------- events ---------- */
document.addEventListener('click', ev => {
  const b = ev.target.closest('[data-act]'); if (!b) return;
  const act_ = b.dataset.act, id = b.dataset.id;
  if (act_ === 'period') { state.period = b.dataset.p; renderOverview(); }
  else if (act_ === 'bucket') {
    const i = +b.dataset.i, d = chartData && chartData.buckets[i]; if (!d) return;
    $$('#chartHost .col').forEach(c => c.setAttribute('aria-pressed', String(c === b)));
    $('#readout').textContent = d.long + ': income ' + money(d.inc) + ', expenses ' + money(d.exp);
  }
  else if (act_ === 'go') { location.hash = b.dataset.go; }
  else if (act_ === 'dprev' || act_ === 'dnext' || act_ === 'dtoday' || act_ === 'pickday') {
    state.apptDate = act_ === 'dprev' ? addDays(state.apptDate, -1) : act_ === 'dnext' ? addDays(state.apptDate, 1) : act_ === 'dtoday' ? today() : b.dataset.d;
    $('#aDate').value = state.apptDate; renderBook();
  }
  else if (act_ === 'pay') quiet(pay(id, b.dataset.m));
  else if (act_ === 'cancel') quiet(setStatus(id, 'cancelled'));
  else if (act_ === 'noshow') quiet(setStatus(id, 'noshow'));
  else if (act_ === 'rebook') quiet(setStatus(id, 'booked', state.rebookForce === id));
  else if (act_ === 'undo') quiet(undoPay(id));
  else if (act_ === 'delAppt') arm(b, () => quiet(act(() => api('DELETE', '/appts/' + idp(id)))));
  else if (act_ === 'delTxn') arm(b, () => quiet(act(() => api('DELETE', '/txns/' + idp(id)))));
  else if (act_ === 'lb') openLb(id, +b.dataset.i);
  else if (act_ === 'lbx') closeLb();
  else if (act_ === 'lbp') stepLb(-1);
  else if (act_ === 'lbn') stepLb(1);
  else if (act_ === 'lbrm') arm(b, () => quiet(removeLbPhoto()));
  else if (act_ === 'rmPend') { const i = +b.dataset.i; URL.revokeObjectURL(state.pendingUrls[i]); state.pending.splice(i, 1); state.pendingUrls.splice(i, 1); renderPrev(); }
  else if (act_ === 'qmic') micStart();
  else if (act_ === 'qparse') quickParse();
  else if (act_ === 'qclear') { $('#qText').value = ''; qPending = null; qMsg(''); $('#qText').focus(); }
  else if (act_ === 'qconfirm') quiet(quickConfirm());
  else if (act_ === 'qedit') quickEdit();
  else if (act_ === 'mtype') { state.mf.type = b.dataset.t; renderMoney(); }
  else if (act_ === 'export') quiet(exportCsv());
  else if (act_ === 'sample') quiet(loadSample());
  else if (act_ === 'clearSample') quiet(clearSample());
  else if (act_ === 'rmStaff') {
    if (C.staff.length <= 1) { toast('Keep at least one team member.'); return; }
    const s = C.staff.slice(); s.splice(+b.dataset.i, 1); quiet(saveSettings({staff: s}));
  }
  else if (act_ === 'rmSvc') { const s = C.services.slice(); s.splice(+b.dataset.i, 1); quiet(saveSettings({services: s})); }
  else if (act_ === 'acct') openAcct();
  else if (act_ === 'acctx') closeAcct();
  else if (act_ === 'signout') quiet(signOut());
  else if (act_ === 'genPass') {
    const input = b.dataset.targetForm ? b.closest('form').querySelector('input[name="password"]') : $('#' + b.dataset.target);
    input.value = genPassword(14);
  }
  else if (act_ === 'ufilter') { state.uFilter = b.dataset.f; renderUsers(); }
  else if (act_ === 'uedit') { state.uEdit = state.uEdit === id ? null : id; state.uReset = null; renderUsers(); }
  else if (act_ === 'ureset') { state.uReset = state.uReset === id ? null : id; state.uEdit = null; renderUsers(); }
  else if (act_ === 'utoggle') {
    const u = state.users.find(x => x.id === id); if (!u) return;
    quiet(userAction(() => api('PATCH', '/users/' + idp(id), {active: !u.active}), u.active ? u.name + ' can no longer sign in.' : u.name + ' can sign in again.'));
  }
  else if (act_ === 'udel') arm(b, () => quiet(userAction(() => api('DELETE', '/users/' + idp(id)), 'User deleted.')));
  else if (act_ === 'ucopy') copyText('Username: ' + b.dataset.u + '\nPassword: ' + b.dataset.p);
  else if (act_ === 'uhide') { $('#uCreated').hidden = true; $('#uCreated').innerHTML = ''; }
});

document.addEventListener('change', e => {
  const t = e.target;
  if (t.matches && t.matches('input[data-act-file]')) { const files = Array.from(t.files); t.value = ''; if (files.length) quiet(attachTo(t.dataset.actFile, files)); }
  else if (t.matches && t.matches('select[data-role-for]')) {
    if (t.dataset.roleFor === 'create') renderCreateAccess();
    else { const f = t.closest('form'); f.querySelector('[data-access-box]').innerHTML = accessSelects(t.value, null); f.querySelector('[data-role-note]').textContent = ROLE_NOTES[t.value] || ''; }
  }
});

$('#mMonth').addEventListener('change', e => { state.mf.month = e.target.value; renderMoney(); });
$$('input[name="tType"]').forEach(r => r.addEventListener('change', renderMoney));

$('#aService').addEventListener('change', () => {
  const v = $('#aService').value, s = C.services.find(x => x.id === v);
  $('#aCustomWrap').hidden = v !== 'custom';
  $('#aCustom').required = v === 'custom';
  if (s) { $('#aPrice').value = s.price; $('#aMins').value = s.mins; }
});
$('#apptForm').addEventListener('input', () => {
  if (state.confirmBook) { state.confirmBook = false; setMsg('#aWarn', ''); $('#aSubmit').textContent = staffView() ? 'Add to book' : 'Book appointment'; }
});
$('#apptForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  if (formBusy) return;
  const cust = !staffView();
  const sv = $('#aService').value, svc = C.services.find(x => x.id === sv);
  const service = sv === 'custom' ? $('#aCustom').value.trim() : (svc ? svc.name : '');
  const date = $('#aDate').value, time = $('#aTime').value, staff = $('#aStaff').value || C.staff[0];
  const mins = Math.max(5, Math.round(num($('#aMins').value)) || 30);
  if (!service || !date || !time) return;
  const clash = conflicts(date, time, mins, staff);
  if (clash.length && cust) { setMsg('#aWarn', 'You already have a booking at that time.'); return; }
  if (clash.length && !state.confirmBook) {
    state.confirmBook = true;
    setMsg('#aWarn', staff + ' already has ' + clash[0].client + ' at ' + fmtTime(clash[0].time) + '. Press again to book anyway.');
    $('#aSubmit').textContent = 'Book anyway';
    return;
  }
  formBusy = true;
  const btn = $('#aSubmit'), oldLabel = btn.textContent;
  let inspo = [];
  if (state.pending.length) { btn.disabled = true; btn.textContent = 'Uploading photos\u2026'; inspo = await uploadAll(state.pending); }
  btn.disabled = false; btn.textContent = oldLabel;
  const body = cust
    ? {serviceId: sv, phone: $('#aPhone').value.trim(), staff, date, time, note: $('#aNote').value.trim(), inspo}
    : {client: $('#aClient').value.trim(), phone: $('#aPhone').value.trim(), staff, date, time, mins, price: num($('#aPrice').value), note: $('#aNote').value.trim(), inspo, force: state.confirmBook};
  if (!cust) { if (sv === 'custom') body.service = service; else body.serviceId = sv; }
  try { await act(() => api('POST', '/appts', body), {silent: true}); }
  catch (e) {
    formBusy = false; discardUploads(inspo);
    if (e.code === 'conflict') { state.confirmBook = true; setMsg('#aWarn', e.message + ' Press again to book anyway.'); btn.textContent = 'Book anyway'; }
    else if (e.code === 'slot_taken' || e.code === 'too_many_bookings') setMsg('#aWarn', e.message);
    else reportError(e);
    return;
  }
  formBusy = false; clearPending();
  state.confirmBook = false; setMsg('#aWarn', '');
  (cust ? ['#aNote', '#aTime'] : ['#aClient', '#aPhone', '#aNote', '#aTime']).forEach(s => { $(s).value = ''; });
  state.apptDate = date; toast('Booked for ' + fmtDay(date) + ' at ' + fmtTime(time));
  renderBook();
});
$('#txnForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const type = $('input[name="tType"]:checked').value, amount = num($('#tAmount').value);
  if (!(amount > 0) || !$('#tDate').value) return;
  try { await act(() => api('POST', '/txns', {type, date: $('#tDate').value, amount, category: $('#tCat').value, method: $('#tMethod').value, note: $('#tNote').value.trim()})); }
  catch (e) { return; }
  $('#tAmount').value = ''; $('#tNote').value = '';
  toast((type === 'income' ? 'Income' : 'Expense') + ' of ' + money(amount) + ' saved');
});

// setup fields save on change
$('#sCur').addEventListener('change', e => quiet(saveSettings({currency: e.target.value})));
['Cash', 'Card', 'Bank'].forEach(k => $('#o' + k).addEventListener('change', () => {
  quiet(saveSettings({opening: {cash: num($('#oCash').value), card: num($('#oCard').value), bank: num($('#oBank').value)}}));
}));
$('#staffForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const n = $('#staffName').value.trim(); if (!n || C.staff.some(s => s.toLowerCase() === n.toLowerCase())) return;
  $('#staffName').value = '';
  quiet(saveSettings({staff: C.staff.concat([n])}));
});
$('#svcForm').addEventListener('submit', ev => {
  ev.preventDefault();
  const s = {id: 's' + uid(), name: $('#nsName').value.trim(), price: num($('#nsPrice').value), mins: Math.max(5, Math.round(num($('#nsMins').value)))};
  if (!s.name) return;
  ['#nsName', '#nsPrice', '#nsMins'].forEach(q => { $(q).value = ''; });
  quiet(saveSettings({services: C.services.concat([s])}));
});
$('#svcList').addEventListener('change', ev => {
  const row = ev.target.closest('.svc'); if (!row) return;
  const i = +row.dataset.i, k = ev.target.dataset.k; if (!k || !C.services[i]) return;
  const list = C.services.map(s => Object.assign({}, s));
  list[i][k] = k === 'name' ? ev.target.value.trim() || list[i].name : (k === 'mins' ? Math.max(5, Math.round(num(ev.target.value))) : num(ev.target.value));
  quiet(saveSettings({services: list}));
});

// auth + account + users forms
$('#loginForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#lGo'); btn.disabled = true; setMsg('#loginMsg', '');
  try {
    const d = await api('POST', '/auth/login', {username: $('#lUser').value.trim(), password: $('#lPass').value}, {noAuthRedirect: true});
    $('#lPass').value = '';
    await enterApp(d);
  } catch (e) { setMsg('#loginMsg', e.message); $('#lPass').value = ''; $('#lPass').focus(); }
  finally { btn.disabled = false; }
});
$('#lForgot').addEventListener('click', () => showAuth('forgot'));
$$('[data-act="tologin"]').forEach(b => b.addEventListener('click', () => { resetToken = null; showAuth('login'); }));
$('#forgotForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const btn = $('#gGo'); btn.disabled = true; setMsg('#forgotMsg', ''); $('#forgotOk').hidden = true;
  try {
    await api('POST', '/auth/forgot', {identifier: $('#gId').value.trim()}, {noAuthRedirect: true});
    $('#forgotOk').textContent = 'If an account matches, an email with a reset link is on its way. The link works once and expires soon. Check your spam folder too.';
    $('#forgotOk').hidden = false;
    setTimeout(() => { btn.disabled = false; }, 15000); // brief pause against double-sends
  } catch (e) { setMsg('#forgotMsg', e.message); btn.disabled = false; }
});
$('#resetForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const a = $('#rNew').value, b = $('#rNew2').value;
  if (a !== b) { setMsg('#resetMsg', 'The two passwords do not match.'); return; }
  const btn = $('#rGo'); btn.disabled = true; setMsg('#resetMsg', '');
  try {
    await api('POST', '/auth/reset', {token: resetToken, password: a}, {noAuthRedirect: true});
    resetToken = null;
    showAuth('login', '');
    setMsg('#loginMsg', 'Password updated. Sign in with your new password.');
  } catch (e) { setMsg('#resetMsg', e.message); }
  finally { btn.disabled = false; }
});
$('#forceForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const d = await changePassword($('#fCur').value, $('#fNew').value, $('#fNew2').value, '#forceMsg', $('#fGo'));
  if (d) await enterApp(d);
});
$('#acctForm').addEventListener('submit', async ev => {
  ev.preventDefault();
  const d = await changePassword($('#pCur').value, $('#pNew').value, $('#pNew2').value, '#acctMsg', $('#pGo'));
  if (d) { state.me = d.user; closeAcct(); toast('Password updated. Other devices were signed out.'); }
});
$('#userForm').addEventListener('submit', ev => { ev.preventDefault(); quiet(submitCreateUser()); });
$('#userList').addEventListener('submit', async ev => {
  ev.preventDefault();
  const f = ev.target, err = f.querySelector('[data-err]');
  const show = m => { err.textContent = m; err.hidden = !m; };
  show('');
  try {
    if (f.dataset.uedit) {
      const id = f.dataset.uedit, self = state.me && id === state.me.id;
      const body = {name: f.elements.name.value.trim(), phone: f.elements.phone.value.trim(), email: f.elements.email.value.trim(), access: readAccess(f)};
      if (!self) body.role = f.elements.role.value;
      await api('PATCH', '/users/' + idp(id), body);
      state.uEdit = null; await loadUsers(); toast('Saved.');
    } else if (f.dataset.ureset) {
      const id = f.dataset.ureset, u = state.users.find(x => x.id === id), pw = f.elements.password.value, must = f.elements.must.checked;
      await api('POST', '/users/' + idp(id) + '/password', {password: pw, mustChange: must});
      state.uReset = null; await loadUsers();
      if (u) showCreds(u, pw, must);
      toast('Password updated. They were signed out everywhere.');
    }
  } catch (e) { if (!e.handled) show(e.message); }
});

window.addEventListener('hashchange', () => { if (state.me && !state.me.mustChange) setView(location.hash.slice(1)); });
$('#aFiles').addEventListener('change', e => {
  Array.from(e.target.files).forEach(f => { if (state.pending.length < 8) { state.pending.push(f); state.pendingUrls.push(URL.createObjectURL(f)); } });
  e.target.value = ''; renderPrev();
});
$('#qText').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); quickParse(); } });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#acct').hidden) { closeAcct(); return; }
  if (!state.lb) return;
  if (e.key === 'Escape') closeLb(); else if (e.key === 'ArrowLeft') stepLb(-1); else if (e.key === 'ArrowRight') stepLb(1);
});

/* ---------- PWA ---------- */
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('/sw.js', {scope: '/'}).catch(() => {}); });
}

/* ---------- boot ---------- */
async function boot() {
  const m = /^#reset=([\w-]{20,100})$/.exec(location.hash);
  if (m) {
    resetToken = m[1];
    history.replaceState(null, '', location.pathname + location.search); // keep the token out of history and screenshots
    showAuth('reset');
    return;
  }
  try { const d = await api('GET', '/auth/me', undefined, {noAuthRedirect: true}); await enterApp(d); }
  catch (e) { showAuth('login', e.status === 401 ? '' : e.message); }
}
boot();
})();
