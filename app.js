// EZ Money Manager frontend
let DB = { transactions: [], settings: null, budgets: {} };
let month = new Date().toISOString().slice(0, 7); // YYYY-MM
let qaMode = 'expense';
let editMode = 'expense';
let editingId = null;
let dashCurrency = null;

const $ = id => document.getElementById(id);
const api = (url, opts) => fetch(url, opts).then(r => r.json());
const today = () => new Date().toISOString().slice(0, 10);
const JH = { 'Content-Type': 'application/json' };

// ---------- storage backends ----------
// Local mode talks to the Node server; cloud mode (cloud.js) talks to Firestore.
const ServerStore = {
  mode: 'server',
  onChange() {},
  loadAll() { return api('/api/data'); },
  async addTx(body) { const t = await api('/api/transactions', { method: 'POST', headers: JH, body: JSON.stringify(body) }); if (t.error) throw t.error; return t; },
  async updateTx(id, body) { const t = await api('/api/transactions/' + id, { method: 'PUT', headers: JH, body: JSON.stringify(body) }); if (t.error) throw t.error; return t; },
  async deleteTx(id) { await api('/api/transactions/' + id, { method: 'DELETE' }); },
  saveSettings(s) { return api('/api/settings', { method: 'PUT', headers: JH, body: JSON.stringify(s) }); },
  saveBudgets(b) { return api('/api/budgets', { method: 'PUT', headers: JH, body: JSON.stringify(b) }); }
};
let Store = ServerStore;

const firebaseConfigured = () => {
  if (new URLSearchParams(location.search).has('local')) return false; // ?local=1 forces local server mode (testing)
  const c = window.FIREBASE_CONFIG;
  return !!(c && c.apiKey && !String(c.apiKey).startsWith('PASTE'));
};

// ---------- money / wallet helpers ----------
const sym = code => (DB.settings.currencies && DB.settings.currencies[code]) || (code + ' ');
function fmt(n, code) {
  code = code || DB.settings.primaryCurrency;
  const s = Math.abs(n).toLocaleString('en-US', { maximumFractionDigits: 2 });
  return `${n < 0 ? '−' : ''}${sym(code)}${s}`;
}
const walletOf = id => DB.settings.wallets.find(w => w.id === id);
const walletName = id => (walletOf(id) || {}).name || 'Unknown';
const walletCur = id => (walletOf(id) || {}).currency || DB.settings.primaryCurrency;
const walletColor = id => (walletOf(id) || {}).color || '#9aa3ad';
const catColor = (type, name) => (DB.settings.categories[type] || []).find(c => c.name === name)?.color || '#9aa3ad';
const monthName = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

function presentCurrencies() {
  const seen = [];
  for (const w of DB.settings.wallets) if (!seen.includes(w.currency)) seen.push(w.currency);
  return seen;
}

function computeBalances() {
  const bal = {};
  DB.settings.wallets.forEach(w => bal[w.id] = 0);
  for (const t of DB.transactions) {
    if (t.type === 'expense' && t.wallet in bal) bal[t.wallet] -= t.amount;
    else if ((t.type === 'income' || t.type === 'topup') && t.wallet in bal) bal[t.wallet] += t.amount;
    else if (t.type === 'adjust' && t.wallet in bal) bal[t.wallet] += t.delta;
    else if (t.type === 'transfer') {
      if (t.fromWallet in bal) bal[t.fromWallet] -= t.amount;
      if (t.toWallet in bal) bal[t.toWallet] += (t.toAmount != null ? t.toAmount : t.amount);
    }
  }
  return bal;
}

function txInMonth(m) { return DB.transactions.filter(t => t.date.startsWith(m)); }

// ---------- exchange rates (Total Asset) ----------
// Daily rates from open.er-api.com (no key). Cached in localStorage so the
// installed PWA still shows totals offline using the last known rate.
const FX_KEY = 'ezmoney-fx';
let FX = null; // { fetchedOn: 'YYYY-MM-DD', apiDate, rates: { USD:1, LAK:…, THB:…, … } }
const isoCur = c => c === 'KIP' ? 'LAK' : c; // app uses KIP; ISO code is LAK

async function loadRates(force) {
  try { const c = JSON.parse(localStorage.getItem(FX_KEY)); if (c && c.rates) FX = c; } catch {}
  const todayStr = today();
  if (!force && FX && FX.fetchedOn === todayStr) { renderTotalAsset(); return; }
  try {
    const r = await fetch('https://open.er-api.com/v6/latest/USD');
    const j = await r.json();
    if (j && j.result === 'success' && j.rates) {
      FX = { fetchedOn: todayStr, apiDate: j.time_last_update_utc, rates: j.rates };
      localStorage.setItem(FX_KEY, JSON.stringify(FX));
      if (force) toast('Rates updated ✓');
    }
  } catch {} // offline → keep cached FX (or null)
  renderTotalAsset();
}

function fxConvert(amount, from, to) {
  if (from === to) return amount;
  if (!FX) return null;
  const rf = FX.rates[isoCur(from)], rt = FX.rates[isoCur(to)];
  if (!rf || !rt) return null;
  return amount / rf * rt;
}

function renderTotalAsset() {
  if (!DB.settings) return;
  const bal = computeBalances();
  const perCur = {};
  for (const w of DB.settings.wallets) perCur[w.currency] = (perCur[w.currency] || 0) + bal[w.id];
  for (const target of ['KIP', 'THB', 'USD']) {
    let total = 0, ok = true;
    for (const [cur, amt] of Object.entries(perCur)) {
      const v = fxConvert(amt, cur, target);
      if (v === null) { ok = false; break; }
      total += v;
    }
    $('ta' + target).textContent = ok ? fmt(target === 'KIP' ? Math.round(total) : total, target) : '—';
  }
  const line = $('taRateLine');
  if (FX) {
    const kip = FX.rates.LAK, thb = FX.rates.THB;
    const when = FX.fetchedOn === today() ? "today's rate" : 'rate from ' + FX.fetchedOn;
    line.textContent = `$1 = ₭${Math.round(kip).toLocaleString('en-US')} · ฿${thb.toFixed(2)} — ${when}`;
  } else {
    line.textContent = 'No exchange rates yet — go online once to fetch them.';
  }
}

// ---------- data ----------
async function reload() {
  DB = await Store.loadAll();
  if (!DB.settings) DB.settings = window.EZ_DEFAULTS;
  if (!dashCurrency || !presentCurrencies().includes(dashCurrency)) dashCurrency = DB.settings.primaryCurrency;
  renderAll();
}

async function boot() {
  registerServiceWorker();
  setupInstallPrompt();
  $('qaDate').value = today();
  loadRates(); // fire-and-forget; re-renders Total Asset when rates arrive
  if (firebaseConfigured()) {
    try {
      await import('./cloud.js');
      Store = window.EZCloud;
      Store.init(window.FIREBASE_CONFIG, window.EZMONEY_ROOT);
      Store.onChange(() => reload());
      updateCloudUI('cloud', null);
      Store.onAuth(async user => {
        if (user) {
          showAuthGate(false);
          try { await Store.start(); } catch (e) { console.error(e); }
          await reload();
          updateCloudUI('cloud', user.email);
        } else {
          updateCloudUI('cloud', null);
          showAuthGate(true);
        }
      });
    } catch (e) {
      console.error('Cloud init failed, falling back to local:', e);
      Store = ServerStore;
      updateCloudUI('local');
      await reload();
    }
  } else {
    Store = ServerStore;
    updateCloudUI('local');
    await reload();
  }
}

// ---------- render ----------
function renderAll() {
  $('monthLabel').textContent = monthName(month);
  renderTotalAsset();
  renderQuickAdd();
  renderDashboard();
  renderLedger();
  renderReport();
  renderBudgets();
  renderSettings();
}

function fillCategorySelect(sel, type, selected) {
  sel.innerHTML = '';
  for (const c of DB.settings.categories[type]) {
    const o = document.createElement('option');
    o.value = c.name; o.textContent = c.name;
    if (c.name === selected) o.selected = true;
    sel.appendChild(o);
  }
}
function fillWalletSelect(sel, selected) {
  sel.innerHTML = '';
  for (const w of DB.settings.wallets) {
    const o = document.createElement('option');
    o.value = w.id; o.textContent = w.name;
    if (w.id === selected) o.selected = true;
    sel.appendChild(o);
  }
}
const show = (id, on) => $(id).classList.toggle('hidden', !on);

// ----- quick add -----
function renderQuickAdd() {
  document.querySelectorAll('#typeToggle .tt-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === qaMode));
  const isEI = qaMode === 'expense' || qaMode === 'income';
  show('qaCategory', isEI);
  show('qaWallet', isEI || qaMode === 'topup');
  show('qaFrom', qaMode === 'transfer');
  show('qaArrow', qaMode === 'transfer');
  show('qaTo', qaMode === 'transfer');

  if (isEI) fillCategorySelect($('qaCategory'), qaMode, $('qaCategory').value);
  fillWalletSelect($('qaWallet'), $('qaWallet').value || DB.settings.wallets[0]?.id);
  fillWalletSelect($('qaFrom'), $('qaFrom').value || DB.settings.wallets[0]?.id);
  fillWalletSelect($('qaTo'), $('qaTo').value || DB.settings.wallets[1]?.id);
  updateQaReceived();
  $('qaAmount').placeholder = qaMode === 'transfer' ? 'amount sent' : '0';
}
function updateQaReceived() {
  const diff = qaMode === 'transfer' && walletCur($('qaFrom').value) !== walletCur($('qaTo').value);
  show('qaToAmount', diff);
}

// ----- dashboard -----
function renderDashboard() {
  renderWalletOverview();
  renderCurScope();
  const txs = txInMonth(month).filter(t => (t.type === 'income' || t.type === 'expense') && walletCur(t.wallet) === dashCurrency);
  const income = txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0);
  const expense = txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0);
  $('statIncome').textContent = fmt(income, dashCurrency);
  $('statExpense').textContent = fmt(expense, dashCurrency);
  $('statBalance').textContent = fmt(income - expense, dashCurrency);

  const now = new Date();
  const isCurrent = month === now.toISOString().slice(0, 7);
  const daysInMonth = new Date(+month.slice(0, 4), +month.slice(5, 7), 0).getDate();
  const days = isCurrent ? now.getDate() : daysInMonth;
  $('statDaily').textContent = fmt(days ? expense / days : 0, dashCurrency);

  renderDonut(txs);
  renderWeekday(txs);
  renderTrend();
  renderRows($('recentList'), [...DB.transactions].sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)).slice(0, 8));
}

function renderWalletOverview() {
  const bal = computeBalances();
  const box = $('walletBars');
  box.innerHTML = '';
  const totals = {};
  for (const cur of presentCurrencies()) {
    const wallets = DB.settings.wallets.filter(w => w.currency === cur);
    const max = Math.max(1, ...wallets.map(w => Math.abs(bal[w.id])));
    const sub = wallets.reduce((s, w) => s + bal[w.id], 0);
    totals[cur] = sub;
    const group = document.createElement('div');
    group.className = 'wallet-group';
    let rows = '';
    for (const w of wallets) {
      const b = bal[w.id];
      const pct = Math.max(2, Math.abs(b) / max * 100);
      rows += `<div class="wallet-bar-row">
        <span class="wbr-name" title="${esc(w.name)}">${esc(w.name)}</span>
        <div class="wbr-track"><div class="wbr-fill" style="width:${pct}%;background:${w.color}"></div></div>
        <span class="wbr-val ${b < 0 ? 'neg' : ''}">${fmt(b, cur)}</span>
        <button class="wbr-fix" data-id="${w.id}" title="Reconcile — fix to actual balance">⚖</button>
      </div>`;
    }
    group.innerHTML = `<div class="wg-head"><span>${esc(cur)}</span><span class="wg-sub">${fmt(sub, cur)}</span></div>${rows}`;
    box.appendChild(group);
  }
  box.querySelectorAll('.wbr-fix').forEach(btn => btn.addEventListener('click', () => openReconcile(btn.dataset.id)));
  $('woGrandTotals').innerHTML = presentCurrencies().map(c => `<span>${fmt(totals[c], c)}</span>`).join('');
}

function renderCurScope() {
  for (const boxId of ['curScope', 'repCurScope']) {
    const box = $(boxId);
    box.innerHTML = '';
    for (const cur of presentCurrencies()) {
      const b = document.createElement('button');
      b.textContent = `${sym(cur)} ${cur}`;
      b.classList.toggle('active', cur === dashCurrency);
      b.addEventListener('click', () => { dashCurrency = cur; renderDashboard(); renderReport(); });
      box.appendChild(b);
    }
  }
}

// Mon–Sun spending bars for the selected month (same currency scope as the donut)
function renderWeekday(txs) {
  const svg = $('weekday');
  const days = [0, 0, 0, 0, 0, 0, 0]; // Mon..Sun
  for (const t of txs) if (t.type === 'expense')
    days[(new Date(t.date + 'T00:00:00').getDay() + 6) % 7] += t.amount;
  const max = Math.max(...days);
  const labels = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
  const W = 380, H = 220, padB = 28, padT = 26, chartH = H - padB - padT;
  let out = '';
  for (let i = 1; i <= 4; i++) {
    const yy = padT + chartH * i / 4;
    out += `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke="#eef2f7" stroke-width="1"/>`;
  }
  if (!max) {
    out += `<text x="${W / 2}" y="${H / 2}" text-anchor="middle" fill="#93a1b0" font-size="13" font-style="italic">no expenses</text>`;
  } else {
    const groupW = W / 7, barW = 30;
    days.forEach((v, i) => {
      const cx = groupW * i + groupW / 2;
      const h = v / max * chartH;
      const top = v === max;
      out += `<rect x="${cx - barW / 2}" y="${padT + chartH - h}" width="${barW}" height="${Math.max(h, v ? 2 : 0)}" rx="6" fill="#d9534a" opacity="${top ? '1' : '.55'}"><title>${labels[i]}: ${fmt(v, dashCurrency)}</title></rect>`;
      if (v) {
        const compact = v >= 1e6 ? (v / 1e6).toFixed(1) + 'M' : v >= 1e3 ? Math.round(v / 1e3) + 'k' : String(Math.round(v));
        out += `<text x="${cx}" y="${padT + chartH - h - 6}" text-anchor="middle" font-size="10" font-weight="${top ? 800 : 600}" fill="${top ? '#24303c' : '#93a1b0'}">${compact}</text>`;
      }
      out += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" font-weight="${top ? 800 : 400}" fill="${top ? '#24303c' : '#93a1b0'}">${labels[i]}</text>`;
    });
  }
  svg.innerHTML = out;
}

function renderDonut(txs) {
  const svg = $('donut'), legend = $('donutLegend');
  const byCat = {};
  for (const t of txs) if (t.type === 'expense') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const entries = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, e) => s + e[1], 0);
  svg.innerHTML = ''; legend.innerHTML = '';
  if (!total) {
    svg.innerHTML = `<circle cx="100" cy="100" r="70" fill="none" stroke="#eef2f7" stroke-width="26"/><text x="100" y="105" text-anchor="middle" fill="#93a1b0" font-size="13" font-style="italic">no expenses</text>`;
    return;
  }
  let angle = -90;
  const R = 70, CX = 100, CY = 100;
  for (const [name, amt] of entries) {
    const sweep = (amt / total) * 360;
    const a1 = angle * Math.PI / 180, a2 = (angle + sweep) * Math.PI / 180;
    const large = sweep > 180 ? 1 : 0;
    const x1 = CX + R * Math.cos(a1), y1 = CY + R * Math.sin(a1);
    const x2 = CX + R * Math.cos(a2), y2 = CY + R * Math.sin(a2);
    const color = catColor('expense', name);
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    const d = sweep >= 359.99
      ? `M ${CX} ${CY - R} A ${R} ${R} 0 1 1 ${CX - 0.01} ${CY - R}`
      : `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2}`;
    p.setAttribute('d', d);
    p.setAttribute('fill', 'none');
    p.setAttribute('stroke', color);
    p.setAttribute('stroke-width', '26');
    svg.appendChild(p);
    angle += sweep;
    const row = document.createElement('div');
    row.className = 'row';
    row.innerHTML = `<i class="dot" style="background:${color}"></i><span>${esc(name)}</span><span class="amt">${fmt(amt, dashCurrency)} · ${Math.round(amt / total * 100)}%</span>`;
    legend.appendChild(row);
  }
  const label = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  label.setAttribute('x', 100); label.setAttribute('y', 97); label.setAttribute('text-anchor', 'middle');
  label.setAttribute('font-size', '11'); label.setAttribute('fill', '#93a1b0'); label.setAttribute('font-weight', '600');
  label.textContent = 'TOTAL';
  const val = document.createElementNS('http://www.w3.org/2000/svg', 'text');
  val.setAttribute('x', 100); val.setAttribute('y', 114); val.setAttribute('text-anchor', 'middle');
  val.setAttribute('font-size', '13'); val.setAttribute('fill', '#24303c'); val.setAttribute('font-weight', '800');
  val.textContent = fmt(total, dashCurrency);
  svg.appendChild(label); svg.appendChild(val);
}

function renderTrend() {
  const svg = $('trend');
  const months = [];
  let [y, m] = month.split('-').map(Number);
  for (let i = 5; i >= 0; i--) {
    let mm = m - i, yy = y;
    while (mm < 1) { mm += 12; yy--; }
    months.push(`${yy}-${String(mm).padStart(2, '0')}`);
  }
  const data = months.map(mo => {
    const txs = DB.transactions.filter(t => t.date.startsWith(mo) && walletCur(t.wallet) === dashCurrency);
    return {
      m: mo,
      inc: txs.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      exp: txs.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    };
  });
  const max = Math.max(1, ...data.flatMap(d => [d.inc, d.exp]));
  const W = 520, H = 220, padB = 28, padT = 12, chartH = H - padB - padT;
  const groupW = W / 6, barW = 26;
  let out = '';
  for (let i = 1; i <= 4; i++) {
    const yy = padT + chartH * i / 4;
    out += `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke="#eef2f7" stroke-width="1"/>`;
  }
  data.forEach((d, i) => {
    const cx = groupW * i + groupW / 2;
    const hInc = d.inc / max * chartH, hExp = d.exp / max * chartH;
    out += `<rect x="${cx - barW - 3}" y="${padT + chartH - hInc}" width="${barW}" height="${Math.max(hInc, d.inc ? 2 : 0)}" rx="5" fill="#2e9e5b" opacity=".85"/>`;
    out += `<rect x="${cx + 3}" y="${padT + chartH - hExp}" width="${barW}" height="${Math.max(hExp, d.exp ? 2 : 0)}" rx="5" fill="#d9534a" opacity=".85"/>`;
    const lbl = new Date(d.m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' });
    const bold = d.m === month ? 'font-weight="800" fill="#24303c"' : 'fill="#93a1b0"';
    out += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="12" ${bold}>${lbl}</text>`;
  });
  svg.innerHTML = out;
}

// ----- ledger -----
function renderLedger() {
  // wallet filter options
  const wsel = $('fltWallet');
  const wkeep = wsel.value;
  wsel.innerHTML = '<option value="">All wallets</option>';
  for (const w of DB.settings.wallets) {
    const o = document.createElement('option'); o.value = w.id; o.textContent = w.name; wsel.appendChild(o);
  }
  wsel.value = wkeep;
  // category filter options
  const csel = $('fltCategory');
  const ckeep = csel.value;
  csel.innerHTML = '<option value="">All categories</option>';
  for (const kind of ['expense', 'income'])
    for (const c of DB.settings.categories[kind]) {
      const o = document.createElement('option'); o.value = c.name; o.textContent = c.name; csel.appendChild(o);
    }
  csel.value = ckeep;

  const q = $('fltSearch').value.trim().toLowerCase();
  const ftype = $('fltType').value, fwallet = $('fltWallet').value, fcat = $('fltCategory').value;
  let txs = txInMonth(month);
  if (ftype) txs = txs.filter(t => t.type === ftype);
  if (fwallet) txs = txs.filter(t => t.wallet === fwallet || t.fromWallet === fwallet || t.toWallet === fwallet);
  if (fcat) txs = txs.filter(t => t.category === fcat);
  if (q) txs = txs.filter(t => (t.note || '').toLowerCase().includes(q) || (t.category || '').toLowerCase().includes(q) || walletName(t.wallet).toLowerCase().includes(q));
  txs.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt));

  $('ledgerTitle').textContent = monthName(month);
  $('ledgerCount').textContent = `${txs.length} ${txs.length === 1 ? 'entry' : 'entries'}`;
  renderRows($('ledgerList'), txs);

  // net income−expense per currency (transfers/top-ups excluded)
  const net = {};
  for (const t of txs) {
    if (t.type !== 'income' && t.type !== 'expense') continue;
    const c = walletCur(t.wallet);
    net[c] = (net[c] || 0) + (t.type === 'income' ? t.amount : -t.amount);
  }
  const parts = Object.entries(net);
  $('ledgerTotal').innerHTML = parts.length
    ? parts.map(([c, v]) => `<span style="color:${v < 0 ? 'var(--red)' : 'var(--green)'}">${fmt(v, c)}</span>`).join(' &nbsp; ')
    : '—';
}

function renderRows(container, txs) {
  container.innerHTML = '';
  if (!txs.length) {
    container.innerHTML = '<div class="empty">Nothing written on this page yet ✎</div>';
    return;
  }
  for (const t of txs) {
    const row = document.createElement('div');
    row.className = 'ledger-row';
    const day = t.date.slice(8, 10) + ' ' + new Date(t.date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short' });
    let catLabel, catCls = '', dotColor, note = t.note || '', walletChip, amountHtml;
    if (t.type === 'transfer') {
      catLabel = '⇄ Transfer'; catCls = 'transfer'; dotColor = 'transparent';
      walletChip = `${esc(walletName(t.fromWallet))} → ${esc(walletName(t.toWallet))}`;
      const sameCur = walletCur(t.fromWallet) === walletCur(t.toWallet);
      amountHtml = `<span class="lr-amount transfer">${fmt(t.amount, walletCur(t.fromWallet))}${sameCur ? '' : ' → ' + fmt(t.toAmount, walletCur(t.toWallet))}</span>`;
    } else if (t.type === 'topup') {
      catLabel = '↑ Top-up'; catCls = 'topup'; dotColor = 'transparent';
      walletChip = esc(walletName(t.wallet));
      amountHtml = `<span class="lr-amount topup">+${fmt(t.amount, walletCur(t.wallet))}</span>`;
    } else if (t.type === 'adjust') {
      catLabel = '⚖ Adjust'; catCls = 'adjust'; dotColor = 'transparent';
      walletChip = esc(walletName(t.wallet));
      amountHtml = `<span class="lr-amount adjust">${t.delta >= 0 ? '+' : '−'}${fmt(Math.abs(t.delta), walletCur(t.wallet))}</span>`;
    } else {
      catLabel = esc(t.category); dotColor = catColor(t.type, t.category);
      walletChip = esc(walletName(t.wallet));
      amountHtml = `<span class="lr-amount ${t.type === 'expense' ? 'exp' : 'inc'}">${t.type === 'expense' ? '−' : '+'}${fmt(t.amount, walletCur(t.wallet))}</span>`;
    }
    row.innerHTML = `
      <span class="lr-date">${day}</span>
      <span class="lr-cat ${catCls}"><i class="dot" style="background:${dotColor}"></i>${catLabel}</span>
      <span class="lr-note">${esc(note)}</span>
      <span class="lr-wallet">${walletChip}</span>
      ${amountHtml}`;
    row.addEventListener('click', () => openEdit(t));
    container.appendChild(row);
  }
}

// ----- report (yearly) -----
let reportYear = new Date().getFullYear();

function renderReport() {
  if (!DB.settings) return;
  $('repYearLabel').textContent = reportYear;
  const inCur = t => walletCur(t.wallet) === dashCurrency;
  const year = String(reportYear);
  const txs = DB.transactions.filter(t => t.date.startsWith(year) && (t.type === 'income' || t.type === 'expense') && inCur(t));

  const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
  const data = months.map(mo => {
    const mt = txs.filter(t => t.date.startsWith(mo));
    return {
      m: mo,
      inc: mt.filter(t => t.type === 'income').reduce((s, t) => s + t.amount, 0),
      exp: mt.filter(t => t.type === 'expense').reduce((s, t) => s + t.amount, 0)
    };
  });

  const totInc = data.reduce((s, d) => s + d.inc, 0);
  const totExp = data.reduce((s, d) => s + d.exp, 0);
  $('repIncome').textContent = fmt(totInc, dashCurrency);
  $('repExpense').textContent = fmt(totExp, dashCurrency);
  $('repNet').textContent = fmt(totInc - totExp, dashCurrency);
  $('repRate').textContent = totInc > 0 ? Math.round((totInc - totExp) / totInc * 100) + '%' : '—';

  // 12-month chart
  const svg = $('repChart');
  const max = Math.max(1, ...data.flatMap(d => [d.inc, d.exp]));
  const W = 720, H = 240, padB = 28, padT = 12, chartH = H - padB - padT;
  const groupW = W / 12, barW = 18;
  let out = '';
  for (let i = 1; i <= 4; i++) {
    const yy = padT + chartH * i / 4;
    out += `<line x1="0" y1="${yy}" x2="${W}" y2="${yy}" stroke="#eef2f7" stroke-width="1"/>`;
  }
  const nowMonth = new Date().toISOString().slice(0, 7);
  data.forEach((d, i) => {
    const cx = groupW * i + groupW / 2;
    const hInc = d.inc / max * chartH, hExp = d.exp / max * chartH;
    out += `<rect x="${cx - barW - 2}" y="${padT + chartH - hInc}" width="${barW}" height="${Math.max(hInc, d.inc ? 2 : 0)}" rx="4" fill="#2e9e5b" opacity=".85"/>`;
    out += `<rect x="${cx + 2}" y="${padT + chartH - hExp}" width="${barW}" height="${Math.max(hExp, d.exp ? 2 : 0)}" rx="4" fill="#d9534a" opacity=".85"/>`;
    const lbl = new Date(d.m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' });
    const bold = d.m === nowMonth ? 'font-weight="800" fill="#24303c"' : 'fill="#93a1b0"';
    out += `<text x="${cx}" y="${H - 8}" text-anchor="middle" font-size="11" ${bold}>${lbl}</text>`;
  });
  svg.innerHTML = out;

  // top categories of the year
  const byCat = {};
  for (const t of txs) if (t.type === 'expense') byCat[t.category] = (byCat[t.category] || 0) + t.amount;
  const cats = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const box = $('repTopCats');
  box.innerHTML = cats.length ? '' : '<div class="empty">No expenses this year yet ✎</div>';
  const catMax = cats.length ? cats[0][1] : 1;
  for (const [name, amt] of cats) {
    const row = document.createElement('div');
    row.className = 'rep-cat-row';
    row.innerHTML = `
      <span class="rep-cat-name"><i class="dot" style="background:${catColor('expense', name)}"></i>${esc(name)}</span>
      <div class="wbr-track"><div class="wbr-fill" style="width:${Math.max(2, amt / catMax * 100)}%;background:${catColor('expense', name)}"></div></div>
      <span class="rep-cat-amt">${fmt(amt, dashCurrency)}<em>${totExp ? Math.round(amt / totExp * 100) + '%' : ''}</em></span>`;
    box.appendChild(row);
  }

  // monthly breakdown table + best/worst
  const active = data.filter(d => d.inc || d.exp);
  let best = null, worst = null;
  for (const d of active) {
    const net = d.inc - d.exp;
    if (!best || net > best.net) best = { m: d.m, net };
    if (!worst || net < worst.net) worst = { m: d.m, net };
  }
  const mName = m => new Date(m + '-01T00:00:00').toLocaleDateString('en-US', { month: 'short' });
  $('repBestWorst').textContent = best ? `best: ${mName(best.m)} · toughest: ${mName(worst.m)}` : '';
  let rows = `<tr><th>Month</th><th>Income</th><th>Spent</th><th>Net</th></tr>`;
  for (const d of data) {
    const net = d.inc - d.exp;
    const cur = d.m === nowMonth ? ' class="rep-now"' : '';
    const dim = (!d.inc && !d.exp) ? ' rep-dim' : '';
    rows += `<tr${cur ? cur : dim ? ` class="${dim.trim()}"` : ''}>
      <td>${mName(d.m)}</td>
      <td class="num inc">${d.inc ? fmt(d.inc, dashCurrency) : '·'}</td>
      <td class="num exp">${d.exp ? fmt(d.exp, dashCurrency) : '·'}</td>
      <td class="num ${net < 0 ? 'exp' : 'inc'}">${(d.inc || d.exp) ? fmt(net, dashCurrency) : '·'}</td>
    </tr>`;
  }
  rows += `<tr class="rep-total"><td>Total</td><td class="num inc">${fmt(totInc, dashCurrency)}</td><td class="num exp">${fmt(totExp, dashCurrency)}</td><td class="num ${totInc - totExp < 0 ? 'exp' : 'inc'}">${fmt(totInc - totExp, dashCurrency)}</td></tr>`;
  $('repTable').innerHTML = rows;
}

// ----- reconcile (fix wallet to actual) -----
let recWalletId = null;
function openReconcile(id) {
  const w = walletOf(id);
  if (!w) return;
  recWalletId = id;
  const bal = computeBalances()[id] || 0;
  $('recInfo').innerHTML = `<b>${esc(w.name)}</b> — the app shows <b>${fmt(bal, w.currency)}</b>. Type what the bank/app really says and I'll post one adjustment for the difference.`;
  $('recActual').value = '';
  $('recNote').value = '';
  $('recModal').classList.remove('hidden');
  $('recActual').focus();
}
function closeReconcile() { $('recModal').classList.add('hidden'); recWalletId = null; }
async function saveReconcile() {
  const w = walletOf(recWalletId);
  if (!w) return closeReconcile();
  const actual = Number($('recActual').value);
  if ($('recActual').value === '' || !isFinite(actual)) return toast('Enter the actual balance');
  const current = computeBalances()[recWalletId] || 0;
  const delta = actual - current;
  if (delta === 0) { closeReconcile(); return toast('Already matches — nothing to fix ✓'); }
  try {
    await Store.addTx({ type: 'adjust', wallet: recWalletId, delta, date: today(), note: $('recNote').value || 'reconcile' });
  } catch (e) { return toast('Error: ' + e); }
  closeReconcile();
  await reload();
  toast(`Adjusted ${delta > 0 ? '+' : '−'}${fmt(Math.abs(delta), w.currency)} ⚖`);
}

// ----- budgets -----
function renderBudgets() {
  $('budgetCurName').textContent = sym(DB.settings.primaryCurrency) + ' ' + DB.settings.primaryCurrency;
  const list = $('budgetList');
  list.innerHTML = '';
  const spent = {};
  for (const t of txInMonth(month))
    if (t.type === 'expense' && walletCur(t.wallet) === DB.settings.primaryCurrency)
      spent[t.category] = (spent[t.category] || 0) + t.amount;

  for (const c of DB.settings.categories.expense) {
    const budget = Number(DB.budgets[c.name] || 0);
    const used = spent[c.name] || 0;
    const pct = budget ? Math.min(100, used / budget * 100) : 0;
    const row = document.createElement('div');
    row.className = 'budget-row';
    row.innerHTML = `
      <span class="budget-name"><i class="dot" style="background:${c.color}"></i>${esc(c.name)}</span>
      <input type="number" class="budget-input" min="0" step="any" placeholder="no limit" value="${budget || ''}" data-cat="${esc(c.name)}">
      <div class="budget-bar"><div class="budget-fill ${used > budget && budget ? 'warn' : ''}" style="width:${pct}%"></div></div>
      <span class="budget-status">${budget ? `${fmt(used, DB.settings.primaryCurrency)} of ${fmt(budget, DB.settings.primaryCurrency)}` : fmt(used, DB.settings.primaryCurrency) + ' spent'}</span>`;
    list.appendChild(row);
  }
  list.querySelectorAll('.budget-input').forEach(inp => {
    inp.addEventListener('change', async () => {
      const v = Number(inp.value);
      if (v > 0) DB.budgets[inp.dataset.cat] = v; else delete DB.budgets[inp.dataset.cat];
      await Store.saveBudgets(DB.budgets);
      renderBudgets();
      toast('Budget saved');
    });
  });
}

// ----- settings -----
function renderSettings() {
  // currency options for the "add wallet" picker
  const ncur = $('newWalletCur');
  if (ncur.options.length !== Object.keys(DB.settings.currencies).length) {
    ncur.innerHTML = '';
    for (const code of Object.keys(DB.settings.currencies)) {
      const o = document.createElement('option'); o.value = code; o.textContent = `${sym(code)} ${code}`; ncur.appendChild(o);
    }
  }
  // wallets
  const wl = $('walletList');
  wl.innerHTML = '';
  for (const w of DB.settings.wallets) {
    const row = document.createElement('div');
    row.className = 'wallet-set-row';
    let opts = '';
    for (const code of Object.keys(DB.settings.currencies))
      opts += `<option value="${code}" ${code === w.currency ? 'selected' : ''}>${sym(code)} ${code}</option>`;
    row.innerHTML = `
      <i class="dot" style="background:${w.color}"></i>
      <input type="text" value="${esc(w.name)}" data-id="${w.id}" class="wallet-name-input">
      <select data-id="${w.id}" class="wallet-cur-input">${opts}</select>
      <button class="cat-del" title="Delete wallet" data-id="${w.id}">✕</button>`;
    wl.appendChild(row);
  }
  wl.querySelectorAll('.wallet-name-input').forEach(inp => inp.addEventListener('change', async () => {
    const w = walletOf(inp.dataset.id); if (!w) return;
    const v = inp.value.trim(); if (!v) { inp.value = w.name; return; }
    w.name = v; await saveSettings(); toast('Wallet renamed');
  }));
  wl.querySelectorAll('.wallet-cur-input').forEach(sel => sel.addEventListener('change', async () => {
    const w = walletOf(sel.dataset.id); if (!w) return;
    w.currency = sel.value; await saveSettings(); toast('Currency updated');
  }));
  wl.querySelectorAll('.cat-del').forEach(btn => btn.addEventListener('click', () => deleteWallet(btn.dataset.id)));

  // categories
  for (const kind of ['expense', 'income']) {
    const box = $(kind === 'expense' ? 'catExpense' : 'catIncome');
    box.innerHTML = '';
    for (const c of DB.settings.categories[kind]) {
      const row = document.createElement('div');
      row.className = 'cat-row';
      row.innerHTML = `<i class="dot" style="background:${c.color}"></i><span>${esc(c.name)}</span><button class="cat-del" title="Delete">✕</button>`;
      row.querySelector('.cat-del').addEventListener('click', () => deleteCategory(kind, c.name));
      box.appendChild(row);
    }
  }
}

async function saveSettings() {
  DB.settings = await Store.saveSettings(DB.settings);
  renderAll();
}

const WALLET_PALETTE = ['#3566c4', '#5a91e0', '#2e9e5b', '#3bb3a9', '#e08a00', '#e0a800', '#c96f4a', '#8a6fbf', '#d94a8c', '#d9a441', '#4a90d9', '#7a8a99'];
async function addWallet() {
  const name = $('newWalletName').value.trim();
  if (!name) return;
  if (DB.settings.wallets.some(w => w.name.toLowerCase() === name.toLowerCase())) return toast('Wallet already exists');
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '-' + Math.random().toString(36).slice(2, 6);
  DB.settings.wallets.push({ id, name, currency: $('newWalletCur').value, color: WALLET_PALETTE[DB.settings.wallets.length % WALLET_PALETTE.length] });
  $('newWalletName').value = '';
  await saveSettings();
  toast(`Added "${name}"`);
}
async function deleteWallet(id) {
  const inUse = DB.transactions.some(t => t.wallet === id || t.fromWallet === id || t.toWallet === id);
  if (inUse && !confirm(`"${walletName(id)}" has entries. They'll remain but show as “Unknown”. Delete wallet?`)) return;
  DB.settings.wallets = DB.settings.wallets.filter(w => w.id !== id);
  await saveSettings();
}

const CAT_PALETTE = ['#e8734a', '#5aa469', '#e0a800', '#3bb3a9', '#8a6fbf', '#c96f4a', '#d94a8c', '#4a90d9', '#5a91e0', '#9aa3ad', '#d9534a', '#7a8a99', '#b5892f'];
async function addCategory(kind, name) {
  name = name.trim();
  if (!name) return;
  if (DB.settings.categories[kind].some(c => c.name.toLowerCase() === name.toLowerCase())) return toast('Category already exists');
  const color = CAT_PALETTE[DB.settings.categories[kind].length % CAT_PALETTE.length];
  DB.settings.categories[kind].push({ name, color });
  await saveSettings();
  toast(`Added "${name}"`);
}
async function deleteCategory(kind, name) {
  const inUse = DB.transactions.some(t => t.type === kind && t.category === name);
  if (inUse && !confirm(`"${name}" is used by existing entries. They keep the name but lose the color. Delete category?`)) return;
  DB.settings.categories[kind] = DB.settings.categories[kind].filter(c => c.name !== name);
  await saveSettings();
}

// ---------- quick add save ----------
async function quickAdd() {
  const amount = Number($('qaAmount').value);
  if (!(amount > 0)) { $('qaAmount').focus(); return toast('Enter an amount'); }
  const date = $('qaDate').value || today();
  const note = $('qaNote').value;
  let body, label;
  if (qaMode === 'transfer') {
    const fromW = $('qaFrom').value, toW = $('qaTo').value;
    if (fromW === toW) return toast('Choose two different wallets');
    body = { type: 'transfer', amount, fromWallet: fromW, toWallet: toW, date, note };
    if (walletCur(fromW) !== walletCur(toW)) {
      const toAmount = Number($('qaToAmount').value);
      if (!(toAmount > 0)) { $('qaToAmount').focus(); return toast('Enter the received amount'); }
      body.toAmount = toAmount;
    }
    label = 'Transfer recorded ✓';
  } else if (qaMode === 'topup') {
    body = { type: 'topup', amount, wallet: $('qaWallet').value, date, note };
    label = 'Top-up recorded ✓';
  } else {
    body = { type: qaMode, amount, category: $('qaCategory').value, wallet: $('qaWallet').value, date, note };
    label = (qaMode === 'expense' ? 'Expense' : 'Income') + ' recorded ✓';
  }
  try {
    await Store.addTx(body);
  } catch (e) { return toast('Error: ' + e); }
  $('qaAmount').value = ''; $('qaNote').value = ''; $('qaToAmount').value = '';
  await reload();
  toast(label);
  $('qaAmount').focus();
}

// ---------- edit modal ----------
function openEdit(t) {
  editingId = t.id;
  editMode = t.type;
  const isEI = t.type === 'expense' || t.type === 'income';
  $('editTitle').textContent = { expense: 'Edit expense', income: 'Edit income', transfer: 'Edit transfer', topup: 'Edit top-up', adjust: 'Edit adjustment' }[t.type];
  $('editTypeToggle').classList.toggle('hidden', !isEI);
  $('editCategoryRow').classList.toggle('hidden', !isEI);
  $('editWalletRow').classList.toggle('hidden', !(isEI || t.type === 'topup' || t.type === 'adjust'));
  $('editFromRow').classList.toggle('hidden', t.type !== 'transfer');
  $('editToRow').classList.toggle('hidden', t.type !== 'transfer');
  $('editAmount').min = t.type === 'adjust' ? '' : '0'; // adjustments can be negative

  if (isEI) {
    document.querySelectorAll('#editTypeToggle .tt-btn').forEach(b => b.classList.toggle('active', b.dataset.type === editMode));
    fillCategorySelect($('editCategory'), editMode, t.category);
    fillWalletSelect($('editWallet'), t.wallet);
  } else if (t.type === 'topup' || t.type === 'adjust') {
    fillWalletSelect($('editWallet'), t.wallet);
  } else {
    fillWalletSelect($('editFrom'), t.fromWallet);
    fillWalletSelect($('editTo'), t.toWallet);
    $('editToAmount').value = t.toAmount != null ? t.toAmount : t.amount;
  }
  updateEditReceived();
  $('editAmount').value = t.type === 'adjust' ? t.delta : t.amount;
  $('editDate').value = t.date;
  $('editNote').value = t.note || '';
  $('modal').classList.remove('hidden');
}
function updateEditReceived() {
  const diff = editMode === 'transfer' && walletCur($('editFrom').value) !== walletCur($('editTo').value);
  $('editToAmountRow').classList.toggle('hidden', !diff);
}
function closeEdit() { $('modal').classList.add('hidden'); editingId = null; }

async function saveEdit() {
  const amount = Number($('editAmount').value);
  if (editMode === 'adjust') {
    if (!isFinite(amount) || amount === 0) return toast('Enter a non-zero adjustment');
    const body = { type: 'adjust', delta: amount, wallet: $('editWallet').value, date: $('editDate').value, note: $('editNote').value };
    try { await Store.updateTx(editingId, body); } catch (e) { return toast('Error: ' + e); }
    closeEdit();
    await reload();
    return toast('Saved ✓');
  }
  if (!(amount > 0)) return toast('Enter an amount');
  const body = { type: editMode, amount, date: $('editDate').value, note: $('editNote').value };
  if (editMode === 'transfer') {
    body.fromWallet = $('editFrom').value; body.toWallet = $('editTo').value;
    if (body.fromWallet === body.toWallet) return toast('Choose two different wallets');
    if (walletCur(body.fromWallet) !== walletCur(body.toWallet)) {
      const toAmount = Number($('editToAmount').value);
      if (!(toAmount > 0)) return toast('Enter the received amount');
      body.toAmount = toAmount;
    }
  } else if (editMode === 'topup') {
    body.wallet = $('editWallet').value;
  } else {
    body.category = $('editCategory').value; body.wallet = $('editWallet').value;
  }
  try {
    await Store.updateTx(editingId, body);
  } catch (e) { return toast('Error: ' + e); }
  closeEdit();
  await reload();
  toast('Saved ✓');
}
async function deleteEdit() {
  if (!confirm('Delete this entry?')) return;
  await Store.deleteTx(editingId);
  closeEdit();
  await reload();
  toast('Deleted');
}

// ---------- helpers ----------
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
let toastTimer;
function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2200);
}
function shiftMonth(delta) {
  let [y, m] = month.split('-').map(Number);
  m += delta;
  while (m < 1) { m += 12; y--; }
  while (m > 12) { m -= 12; y++; }
  month = `${y}-${String(m).padStart(2, '0')}`;
  renderAll();
}

// ---------- view switching (top tabs + mobile bottom nav) ----------
function switchView(view) {
  document.querySelectorAll('[data-view]').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.toggle('active', v.id === 'view-' + view));
  window.scrollTo(0, 0);
}
document.querySelectorAll('[data-view]').forEach(el => el.addEventListener('click', () => switchView(el.dataset.view)));

document.querySelectorAll('#typeToggle .tt-btn').forEach(b => b.addEventListener('click', () => { qaMode = b.dataset.mode; renderQuickAdd(); }));
document.querySelectorAll('#editTypeToggle .tt-btn').forEach(b => b.addEventListener('click', () => {
  editMode = b.dataset.type;
  document.querySelectorAll('#editTypeToggle .tt-btn').forEach(x => x.classList.toggle('active', x === b));
  fillCategorySelect($('editCategory'), editMode, $('editCategory').value);
}));

$('qaFrom').addEventListener('change', updateQaReceived);
$('qaTo').addEventListener('change', updateQaReceived);
$('editFrom').addEventListener('change', updateEditReceived);
$('editTo').addEventListener('change', updateEditReceived);

$('qaSave').addEventListener('click', quickAdd);
$('qaAmount').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });
$('qaNote').addEventListener('keydown', e => { if (e.key === 'Enter') quickAdd(); });

$('prevMonth').addEventListener('click', () => shiftMonth(-1));
$('nextMonth').addEventListener('click', () => shiftMonth(1));
$('taRefresh').addEventListener('click', () => loadRates(true));
$('repPrevYear').addEventListener('click', () => { reportYear--; renderReport(); });
$('repNextYear').addEventListener('click', () => { reportYear++; renderReport(); });
$('recSave').addEventListener('click', saveReconcile);
$('recCancel').addEventListener('click', closeReconcile);
$('recActual').addEventListener('keydown', e => { if (e.key === 'Enter') saveReconcile(); });
$('recModal').addEventListener('click', e => { if (e.target === $('recModal')) closeReconcile(); });

['fltSearch', 'fltType', 'fltWallet', 'fltCategory'].forEach(id => $(id).addEventListener('input', renderLedger));
$('btnExport').addEventListener('click', exportCSV);

$('editSave').addEventListener('click', saveEdit);
$('editCancel').addEventListener('click', closeEdit);
$('editDelete').addEventListener('click', deleteEdit);
$('modal').addEventListener('click', e => { if (e.target === $('modal')) closeEdit(); });

$('addWallet').addEventListener('click', addWallet);
$('newWalletName').addEventListener('keydown', e => { if (e.key === 'Enter') addWallet(); });
$('addCatExpense').addEventListener('click', () => { addCategory('expense', $('newCatExpense').value); $('newCatExpense').value = ''; });
$('addCatIncome').addEventListener('click', () => { addCategory('income', $('newCatIncome').value); $('newCatIncome').value = ''; });
$('newCatExpense').addEventListener('keydown', e => { if (e.key === 'Enter') { addCategory('expense', e.target.value); e.target.value = ''; } });
$('newCatIncome').addEventListener('keydown', e => { if (e.key === 'Enter') { addCategory('income', e.target.value); e.target.value = ''; } });

// ---------- CSV export (server endpoint locally, client-side in cloud mode) ----------
function exportCSV() {
  if (Store.mode === 'server') { window.location.href = '/api/export?month=' + month; return; }
  const esc = v => `"${String(v).replace(/"/g, '""')}"`;
  const rows = ['date,type,wallet,category,amount,note'];
  const list = txInMonth(month).slice().sort((a, b) => a.date.localeCompare(b.date));
  for (const t of list) {
    let wallet, category, amount;
    if (t.type === 'transfer') { wallet = `${walletName(t.fromWallet)} -> ${walletName(t.toWallet)}`; category = 'Transfer'; amount = t.amount; }
    else if (t.type === 'topup') { wallet = walletName(t.wallet); category = 'Top-up'; amount = t.amount; }
    else if (t.type === 'adjust') { wallet = walletName(t.wallet); category = 'Adjustment'; amount = t.delta; }
    else { wallet = walletName(t.wallet); category = t.category; amount = t.amount; }
    rows.push([t.date, t.type, esc(wallet), esc(category), amount, esc(t.note || '')].join(','));
  }
  const blob = new Blob(['﻿' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ez-money-${month}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ---------- PWA: service worker + install prompt ----------
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('sw.js').catch(e => console.warn('SW:', e)));
  }
}
let deferredPrompt = null;
function setupInstallPrompt() {
  window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); deferredPrompt = e; $('installBtn').classList.remove('hidden'); });
  window.addEventListener('appinstalled', () => { deferredPrompt = null; $('installBtn').classList.add('hidden'); });
  $('installBtn').addEventListener('click', async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice;
    deferredPrompt = null;
    $('installBtn').classList.add('hidden');
  });
}

// ---------- cloud sync UI ----------
function updateCloudUI(mode, email) {
  const badge = $('cloudBadge'), status = $('cloudStatus'), signOutBtn = $('cloudSignOut');
  if (mode === 'local') {
    badge.textContent = '● Local';
    badge.className = 'sync-badge local';
    status.innerHTML = 'Running in <b>local mode</b> — data is stored on this PC via the EZ Money server. To sync your PC and phone, set up Firebase (see <b>SETUP-FIREBASE.md</b>).';
    signOutBtn.classList.add('hidden');
  } else if (email) {
    badge.textContent = '● Synced';
    badge.className = 'sync-badge ok';
    status.innerHTML = `Cloud sync <b>on</b>. Signed in as <b>${esc(email)}</b>. Your entries sync across every device you log in on.`;
    signOutBtn.classList.remove('hidden');
  } else {
    badge.textContent = '● Cloud';
    badge.className = 'sync-badge cloud';
    status.innerHTML = 'Cloud sync is configured. Sign in to start syncing.';
    signOutBtn.classList.add('hidden');
  }
}
function showAuthGate(on) { $('authGate').classList.toggle('hidden', !on); }
function authErr(msg) { $('authError').textContent = msg || ''; }
async function doAuth(kind) {
  const email = $('authEmail').value.trim(), pw = $('authPassword').value;
  if (!email || !pw) return authErr('Enter your email and password.');
  authErr('');
  try {
    if (kind === 'up') await Store.signUp(email, pw);
    else await Store.signIn(email, pw);
  } catch (e) {
    authErr(String(e.message || e).replace('Firebase: ', ''));
  }
}

// auth gate + cloud controls
$('authSignIn').addEventListener('click', () => doAuth('in'));
$('authSignUp').addEventListener('click', () => doAuth('up'));
$('authPassword').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth('in'); });
$('authReset').addEventListener('click', async () => {
  const email = $('authEmail').value.trim();
  if (!email) return authErr('Enter your email first, then tap reset.');
  try { await Store.resetPassword(email); authErr(''); toast('Password reset email sent'); }
  catch (e) { authErr(String(e.message || e).replace('Firebase: ', '')); }
});
$('cloudSignOut').addEventListener('click', async () => { await Store.signOut(); toast('Signed out'); });

// ---------- init ----------
$('installBtn').classList.add('hidden');
$('qaDate').value = today();
boot();
