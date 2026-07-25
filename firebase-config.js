// ============================================================================
//  EZ Money Manager — Firebase config
// ----------------------------------------------------------------------------
//  Cloud sync is ON: this holds a real Firebase project config, so the app runs
//  in CLOUD mode (Firestore) and syncs across every device you sign in on.
//
//  To go back to local-only mode, restore the PASTE_… placeholders.
//  Setup / deploy steps are in SETUP-FIREBASE.md.
// ============================================================================
window.FIREBASE_CONFIG = {
  apiKey: "AIzaSyCBpR9h5qiJa_m5PwxEEwRXqRclwxSvkSI",
  authDomain: "ez-money-manager-f796c.firebaseapp.com",
  projectId: "ez-money-manager-f796c",
  storageBucket: "ez-money-manager-f796c.firebasestorage.app",
  messagingSenderId: "1072292658677",
  appId: "1:1072292658677:web:ea3f862ed9ac55a22c74bc"
};

// The Firestore root collection EZ Money keeps its data in (your "separate
// subset" of the database). Change it only if you want a different namespace.
window.EZMONEY_ROOT = "ezMoney";
