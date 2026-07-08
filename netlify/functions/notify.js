// Netlify Functions version of the notify handler.
// Identical logic to /api/notify.js — Netlify just needs a different file path
// and exports a slightly different signature.

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

exports.handler = async function (event) {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors(), body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors(), body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  const { name, house, message, senderToken } = JSON.parse(event.body ?? '{}');
  if (!name) return { statusCode: 400, headers: cors(), body: JSON.stringify({ error: 'name required' }) };

  const db   = admin.firestore();
  const snap = await db.collection('users').get();
  const tokens = [];
  snap.forEach(d => {
    const { fcmToken } = d.data();
    if (fcmToken && fcmToken !== senderToken) tokens.push(fcmToken);
  });

  if (!tokens.length) return { statusCode: 200, headers: cors(), body: JSON.stringify({ success: true, sent: 0 }) };

  const title = house ? `${name} checked in at ${house} 🏠` : `${name} just left 👋`;
  const body  = message || (house ? 'Come hang!' : '');

  const result = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title, body },
    webpush: {
      notification: { icon: '/icon.svg', vibrate: [200, 100, 200] },
      fcmOptions:   { link: '/' },
    },
  });

  return {
    statusCode: 200,
    headers: cors(),
    body: JSON.stringify({ success: true, sent: result.successCount }),
  };
};

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
  };
}
