const admin = require('firebase-admin');

// Initialize once across warm invocations.
// Set FIREBASE_SERVICE_ACCOUNT in your Vercel env vars to the full contents
// of the service account JSON file downloaded from Firebase Console.
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)),
  });
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')    return res.status(405).json({ error: 'Method not allowed' });

  const { name, house, message, senderToken } = req.body ?? {};
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

  // title always says who/where; body carries the optional message
  const title = house
    ? `${name} checked in at ${house} 🏠`
    : `${name} just left 👋`;
  const body = message || (house ? 'Come hang!' : '');

  // Send data-only (no `notification` field). The browser would auto-show a
  // notification from the `notification` field AND our onBackgroundMessage handler
  // would show a second one — resulting in duplicate notifications.
  // With data-only, the service worker controls exactly one notification.
  const result = await admin.messaging().sendEachForMulticast({
    tokens,
    data: { title, body },
    webpush: {
      headers:    { TTL: '86400' },
      fcmOptions: { link: '/' },
    },
  });

  // Prune stale tokens so the collection stays clean
  const stale = result.responses
    .map((r, i) => (!r.success ? tokens[i] : null))
    .filter(Boolean);

  if (stale.length) {
    const staleSnap = await db.collection('users')
      .where('fcmToken', 'in', stale.slice(0, 30))
      .get();
    const batch = db.batch();
    staleSnap.forEach(d => batch.update(d.ref, { fcmToken: null }));
    await batch.commit();
  }

  return res.json({ success: true, sent: result.successCount, failed: result.failureCount });
};
