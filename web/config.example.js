// web/config.example.js — Template for deploy-time Firebase config.
// Copy to web/config.js and fill in YOUR values. config.js is git-ignored.
// Never put Telegram bot tokens here: the browser never talks to Telegram.
// The agent (on your PC) holds credentials in agent/config.json and
// consumes the /notifications RTDB queue this app pushes to.
window.YT_WEB_CONFIG = {
  firebase: {
    apiKey: 'YOUR_FIREBASE_API_KEY',
    authDomain: 'YOUR_PROJECT.firebaseapp.com',
    databaseURL: 'https://YOUR_PROJECT-default-rtdb.REGION.firebasedatabase.app',
    projectId: 'YOUR_PROJECT',
    storageBucket: 'YOUR_PROJECT.firebasestorage.app',
    messagingSenderId: 'YOUR_SENDER_ID',
    appId: 'YOUR_APP_ID',
  },
};
