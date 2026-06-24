import { initializeApp }                            from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc,
         onSnapshot, serverTimestamp }              from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getMessaging, getToken, onMessage }        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
import { firebaseConfig, vapidKey }                 from './firebase-config.js';

// ── Firebase init ────────────────────────────────────────────────────────────
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);
let messaging = null;

// ── Persistent identity ──────────────────────────────────────────────────────
let userId   = localStorage.getItem('booling_uid');
let userName = localStorage.getItem('booling_name');
let fcmToken = null;

if (!userId) {
  userId = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  localStorage.setItem('booling_uid', userId);
}

// ── DOM refs ─────────────────────────────────────────────────────────────────
const nameScreen     = document.getElementById('name-screen');
const mainScreen     = document.getElementById('main-screen');
const nameInput      = document.getElementById('name-input');
const nameSubmit     = document.getElementById('name-submit');
const userNameEl     = document.getElementById('user-name-display');
const changeNameBtn  = document.getElementById('change-name-btn');
const btnOut         = document.getElementById('btn-out');
const currentStatus  = document.getElementById('current-status');
const currentHouseEl = document.getElementById('current-house-label');
const notifPrompt    = document.getElementById('notif-prompt');
const enableNotifsBtn= document.getElementById('enable-notifs');
const houseButtons   = document.querySelectorAll('.btn-house');
const toast          = document.getElementById('toast');

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  await registerSW();
  if (!userName) {
    show(nameScreen);
  } else {
    show(mainScreen);
    userNameEl.textContent = userName;
    startListening();
    initMessaging();
  }
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try {
      await navigator.serviceWorker.register('/firebase-messaging-sw.js');
    } catch (e) {
      console.warn('SW registration failed:', e);
    }
  }
}

// ── Name entry ───────────────────────────────────────────────────────────────
nameSubmit.addEventListener('click', submitName);
nameInput.addEventListener('keydown', e => e.key === 'Enter' && submitName());

async function submitName() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  userName = name;
  localStorage.setItem('booling_name', name);
  userNameEl.textContent = name;
  show(mainScreen);
  startListening();
  await initMessaging();
}

changeNameBtn.addEventListener('click', () => {
  nameInput.value = userName ?? '';
  show(nameScreen);
  setTimeout(() => nameInput.focus(), 50);
});

// ── Firestore: real-time board ───────────────────────────────────────────────
function startListening() {
  onSnapshot(collection(db, 'users'), snap => {
    const users = {};
    snap.forEach(d => { users[d.id] = d.data(); });
    renderBoard(users);
  });
}

async function checkIn(house) {
  await setDoc(doc(db, 'users', userId), {
    name: userName,
    house,
    fcmToken: fcmToken ?? null,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  notify({ name: userName, house, senderToken: fcmToken });
}

async function checkOut() {
  await setDoc(doc(db, 'users', userId), {
    name: userName,
    house: null,
    fcmToken: fcmToken ?? null,
    updatedAt: serverTimestamp(),
  }, { merge: true });

  notify({ name: userName, house: null, senderToken: fcmToken });
}

async function notify(payload) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch {
    // Non-fatal — board still updates via Firestore
  }
}

// ── Render ───────────────────────────────────────────────────────────────────
const HOUSES = ['Mega', '809', 'Garnett'];

function houseId(house) {
  return house.replace(/\s+/g, '').toLowerCase(); // Mega→mega, 809→809, Garnett→garnett
}

function renderBoard(users) {
  const buckets = Object.fromEntries(HOUSES.map(h => [h, []]));
  let myHouse = null;

  for (const [id, u] of Object.entries(users)) {
    if (u.house && buckets[u.house]) {
      buckets[u.house].push({ id, ...u });
    }
    if (id === userId) myHouse = u.house ?? null;
  }

  for (const house of HOUSES) {
    const sid    = houseId(house);
    const people = buckets[house];
    const card   = document.getElementById(`card-${sid}`);
    const countEl= document.getElementById(`count-${sid}`);
    const listEl = document.getElementById(`people-${sid}`);

    if (!card) continue;

    countEl.textContent = people.length;
    card.classList.toggle('lit', people.length > 0);

    if (people.length === 0) {
      listEl.innerHTML = '<span class="empty-text">Nobody here yet</span>';
    } else {
      listEl.innerHTML = people
        .map(p => {
          const isMe = p.id === userId;
          return `<span class="chip${isMe ? ' me' : ''}">${isMe ? '⭐ ' : ''}${esc(p.name)}</span>`;
        })
        .join('');
    }
  }

  // Update check-in UI based on my current house
  houseButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.house === myHouse));

  if (myHouse) {
    currentStatus.classList.remove('hidden');
    currentHouseEl.textContent = myHouse;
  } else {
    currentStatus.classList.add('hidden');
  }
}

function esc(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Check-in buttons ─────────────────────────────────────────────────────────
houseButtons.forEach(btn => {
  btn.addEventListener('click', async () => {
    const house = btn.dataset.house;
    btn.disabled = true;
    try {
      await checkIn(house);
      toast(`Checked in at ${house} 🎉`);
    } finally {
      btn.disabled = false;
    }
  });
});

btnOut.addEventListener('click', async () => {
  btnOut.disabled = true;
  try {
    await checkOut();
    toast('You left 👋');
  } finally {
    btnOut.disabled = false;
  }
});

// ── FCM ──────────────────────────────────────────────────────────────────────
async function initMessaging() {
  if (!('Notification' in window)) return;

  try {
    messaging = getMessaging(fbApp);
  } catch (e) {
    console.warn('Messaging unavailable:', e);
    return;
  }

  if (Notification.permission === 'granted') {
    await grabFCMToken();
  } else if (Notification.permission !== 'denied') {
    notifPrompt.classList.remove('hidden');
  }

  onMessage(messaging, payload => {
    toast(payload.notification?.body ?? 'Someone checked in!');
  });
}

enableNotifsBtn.addEventListener('click', async () => {
  const perm = await Notification.requestPermission();
  notifPrompt.classList.add('hidden');
  if (perm === 'granted') {
    await grabFCMToken();
    toast('Notifications on 🔔');
  } else {
    toast('Notifications blocked');
  }
});

async function grabFCMToken() {
  if (!messaging) return;
  try {
    const swReg = await navigator.serviceWorker.ready;
    fcmToken = await getToken(messaging, { vapidKey, serviceWorkerRegistration: swReg });
    if (fcmToken && userName) {
      await setDoc(doc(db, 'users', userId), { fcmToken, name: userName }, { merge: true });
    }
  } catch (e) {
    console.warn('FCM token error:', e);
  }
}

// ── Utils ────────────────────────────────────────────────────────────────────
function show(el) {
  nameScreen.classList.add('hidden');
  mainScreen.classList.add('hidden');
  el.classList.remove('hidden');
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3200);
}

// ── Go ───────────────────────────────────────────────────────────────────────
init();
