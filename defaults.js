// Default settings for a fresh account — must mirror DEFAULT_SETTINGS in server.js.
// Used when starting a brand-new Firebase (cloud) account that has no settings yet.
(function () {
  const EXP_PALETTE = ['#e8734a', '#5aa469', '#e0a800', '#3bb3a9', '#8a6fbf', '#c96f4a', '#d94a8c', '#4a90d9', '#5a91e0', '#9aa3ad', '#d9534a', '#7a8a99', '#b5892f'];
  const INC_PALETTE = ['#3f9e58', '#2f8fa3', '#d9534a', '#bf7fbf', '#4a6fd9', '#3bb3a9', '#c96f4a', '#8fa35a'];
  const EXP = ['Food & Drinks', 'Groceries', 'Snacks', 'Sports', 'Subscription', 'Fuel', 'Shopping', 'Family Expense', 'Social', 'Household', 'Medical', 'MISC', 'Lottery'];
  const INC = ['Salary', 'DSA', 'YouTube', 'Sponsor', 'Trading', 'Digital Income', 'Freelance Design', 'Others'];
  window.EZ_DEFAULTS = {
    primaryCurrency: 'KIP',
    currencies: { KIP: '₭', THB: '฿', USD: '$', EUR: '€' },
    wallets: [
      { id: 'bcel-kip-main', name: 'BCEL (KIP) Main', currency: 'KIP', color: '#3566c4' },
      { id: 'bcel-kip-backup', name: 'BCEL (KIP) Backup', currency: 'KIP', color: '#5a91e0' },
      { id: 'bcel-thb', name: 'BCEL (THB)', currency: 'THB', color: '#2e9e5b' },
      { id: 'bcel-usd', name: 'BCEL (USD)', currency: 'USD', color: '#3bb3a9' },
      { id: 'ib-kip-wallet', name: 'IB (KIP) Wallet', currency: 'KIP', color: '#e08a00' },
      { id: 'ib-kip-main', name: 'IB (KIP) Main', currency: 'KIP', color: '#e0a800' },
      { id: 'ib-usd', name: 'IB (USD)', currency: 'USD', color: '#c96f4a' },
      { id: 'jdb-kip', name: 'JDB (KIP)', currency: 'KIP', color: '#8a6fbf' },
      { id: 'ldb-kip', name: 'LDB (KIP)', currency: 'KIP', color: '#d94a8c' },
      { id: 'easy-gold', name: 'Easy Gold', currency: 'KIP', color: '#d9a441' }
    ],
    categories: {
      expense: EXP.map((name, i) => ({ name, color: EXP_PALETTE[i % EXP_PALETTE.length] })),
      income: INC.map((name, i) => ({ name, color: INC_PALETTE[i % INC_PALETTE.length] }))
    }
  };
})();
