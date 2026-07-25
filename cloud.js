// EZ Money Manager — Firebase (Firestore) cloud sync module.
// Loaded dynamically by app.js only when firebase-config.js holds a real config.
// Data lives under: {ROOT}/{uid}          -> { settings, budgets }
//                   {ROOT}/{uid}/tx/{id}  -> one document per transaction
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signOut, sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, getDoc, setDoc, deleteDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

let app, auth, db, ROOT = 'ezMoney';
let cache = { transactions: [], settings: null, budgets: {} };
let changeCb = null, unsub = [];

const uid = () => auth.currentUser && auth.currentUser.uid;
const rootDoc = () => doc(db, ROOT, uid());
const txCol = () => collection(db, ROOT, uid(), 'tx');
const rid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2));

// mirror of server.js buildTx — validate + normalise before writing to the cloud
function normalizeTx(body) {
  const settings = cache.settings || window.EZ_DEFAULTS;
  const find = id => settings.wallets.find(w => w.id === id);
  const type = body.type;
  if (!body.date || !/^\d{4}-\d{2}-\d{2}$/.test(body.date)) throw 'bad date';
  const note = String(body.note || '').slice(0, 300);
  if (type === 'adjust') {
    const w = find(body.wallet);
    if (!w) throw 'unknown wallet';
    const delta = Number(body.delta);
    if (!isFinite(delta) || delta === 0) throw 'bad delta';
    return { type, delta, wallet: w.id, date: body.date, note };
  }
  const amount = Number(body.amount);
  if (!isFinite(amount) || amount <= 0) throw 'bad amount';
  if (type === 'transfer') {
    const from = find(body.fromWallet), to = find(body.toWallet);
    if (!from || !to) throw 'unknown wallet';
    if (from.id === to.id) throw 'same wallet';
    let toAmount = body.toAmount !== undefined && body.toAmount !== '' ? Number(body.toAmount) : amount;
    if (from.currency === to.currency) toAmount = amount;
    if (!isFinite(toAmount) || toAmount <= 0) throw 'bad received amount';
    return { type, amount, toAmount, fromWallet: from.id, toWallet: to.id, date: body.date, note };
  }
  if (type === 'topup') {
    const w = find(body.wallet); if (!w) throw 'unknown wallet';
    return { type, amount, wallet: w.id, date: body.date, note };
  }
  if (type === 'expense' || type === 'income') {
    const w = find(body.wallet); if (!w) throw 'unknown wallet';
    return { type, amount, category: String(body.category || 'Others'), wallet: w.id, date: body.date, note };
  }
  throw 'bad type';
}

const EZCloud = {
  mode: 'firebase',

  init(config, root) {
    ROOT = root || 'ezMoney';
    app = initializeApp(config);
    auth = getAuth(app);
    try {
      db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });
    } catch { db = initializeFirestore(app, {}); }
  },

  onAuth(cb) { onAuthStateChanged(auth, cb); },
  currentUser() { return auth.currentUser; },
  signIn(email, pw) { return signInWithEmailAndPassword(auth, email, pw); },
  signUp(email, pw) { return createUserWithEmailAndPassword(auth, email, pw); },
  signOut() { unsub.forEach(u => u()); unsub = []; return signOut(auth); },
  resetPassword(email) { return sendPasswordResetEmail(auth, email); },

  // begin realtime sync; resolves once the first settings + tx snapshots have arrived
  async start() {
    // seed settings for a brand-new account
    const rd = await getDoc(rootDoc());
    if (!rd.exists()) {
      await setDoc(rootDoc(), { settings: window.EZ_DEFAULTS, budgets: {} });
      cache.settings = JSON.parse(JSON.stringify(window.EZ_DEFAULTS));
      cache.budgets = {};
    } else {
      const d = rd.data();
      cache.settings = d.settings || JSON.parse(JSON.stringify(window.EZ_DEFAULTS));
      cache.budgets = d.budgets || {};
    }
    await new Promise(resolve => {
      let first = true;
      unsub.push(onSnapshot(txCol(), snap => {
        cache.transactions = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (first) { first = false; resolve(); } else if (changeCb) changeCb();
      }, () => { if (first) { first = false; resolve(); } }));
    });
    unsub.push(onSnapshot(rootDoc(), snap => {
      if (!snap.exists()) return;
      const d = snap.data();
      cache.settings = d.settings || cache.settings;
      cache.budgets = d.budgets || {};
      if (changeCb) changeCb();
    }));
  },

  onChange(cb) { changeCb = cb; },

  async loadAll() {
    return {
      transactions: cache.transactions.slice(),
      settings: cache.settings || JSON.parse(JSON.stringify(window.EZ_DEFAULTS)),
      budgets: cache.budgets || {}
    };
  },

  async addTx(body) {
    const fields = normalizeTx(body);
    const tx = { id: rid(), ...fields, createdAt: new Date().toISOString() };
    const { id, ...data } = tx;
    await setDoc(doc(txCol(), id), data);
    if (!cache.transactions.find(t => t.id === id)) cache.transactions.push(tx);
    return tx;
  },

  async updateTx(id, body) {
    const existing = cache.transactions.find(t => t.id === id) || {};
    const fields = normalizeTx({ ...existing, ...body });
    const tx = { id, ...fields, createdAt: existing.createdAt || new Date().toISOString() };
    const { id: _i, ...data } = tx;
    await setDoc(doc(txCol(), id), data);
    const idx = cache.transactions.findIndex(t => t.id === id);
    if (idx !== -1) cache.transactions[idx] = tx;
    return tx;
  },

  async deleteTx(id) {
    await deleteDoc(doc(txCol(), id));
    cache.transactions = cache.transactions.filter(t => t.id !== id);
  },

  async saveSettings(settings) {
    cache.settings = settings;
    await setDoc(rootDoc(), { settings }, { merge: true });
    return settings;
  },

  async saveBudgets(budgets) {
    cache.budgets = budgets;
    await setDoc(rootDoc(), { budgets }, { merge: true });
    return budgets;
  }
};

window.EZCloud = EZCloud;
export default EZCloud;
