const admin = require('firebase-admin');

// Initialize once across warm invocations
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert({
      projectId:   process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // Vercel stores newlines as literal \n in env vars
      privateKey:  process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    }),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { name, house, senderToken } = req.body ?? {};
  if (!name) return res.status(400).json({ error: 'name is required' });

  const db = admin.firestore();

  // Collect all FCM tokens except the sender's
  const snap = await db.collection('users').get();
  const tokens = [];
  snap.forEach(d => {
    const { fcmToken } = d.data();
    if (fcmToken && fcmToken !== senderToken) tokens.push(fcmToken);
  });

  if (tokens.length === 0) return res.json({ success: true, sent: 0 });

  const body = house
    ? `${name} just checked in at ${house} 🏠`
    : `${name} just left 👋`;

  // FCM caps sendEachForMulticast at 500 tokens — fine for a friend group
  const result = await admin.messaging().sendEachForMulticast({
    tokens,
    notification: { title: 'Where We Booling? 🎉', body },
    webpush: {
      notification: { icon: '/icon.svg', badge: '/icon.svg', vibrate: [200, 100, 200] },
      fcmOptions:   { link: '/' },
    },
  });

  // Prune stale tokens so the collection stays clean
  const stale = result.responses
    .map((r, i) => (!r.success ? tokens[i] : null))
    .filter(Boolean);

  if (stale.length) {
    const staleSnap = await db.collection('users')
      .where('fcmToken', 'in', stale.slice(0, 30))   // Firestore 'in' limit
      .get();
    const batch = db.batch();
    staleSnap.forEach(d => batch.update(d.ref, { fcmToken: null }));
    await batch.commit();
  }

  return res.json({ success: true, sent: result.successCount, failed: result.failureCount });
};
