import { initializeApp }                                        from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, deleteDoc,
         onSnapshot, serverTimestamp, getDocs, query, where } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getMessaging, getToken, onMessage }                   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
import { firebaseConfig, vapidKey }                            from './firebase-config.js';

// ── Firebase ─────────────────────────────────────────────────────────────────
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);
let messaging = null;

// ── Color / emoji palette ────────────────────────────────────────────────────
const COLORS = [
  { accent: 'var(--c0)', dim: 'var(--c0d)' },
  { accent: 'var(--c1)', dim: 'var(--c1d)' },
  { accent: 'var(--c2)', dim: 'var(--c2d)' },
  { accent: 'var(--c3)', dim: 'var(--c3d)' },
  { accent: 'var(--c4)', dim: 'var(--c4d)' },
  { accent: 'var(--c5)', dim: 'var(--c5d)' },
  { accent: 'var(--c6)', dim: 'var(--c6d)' },
];

// Permanent locations get stable color slots
const PERM_COLORS = { mega: 0, '809': 1 };

const EMOJIS = ['🏠','🏡','🏘️','🛖','🏗️','🌆','🎪','🏕️','🎭','🍕'];

function locationColor(locationId) {
  if (locationId in PERM_COLORS) return COLORS[PERM_COLORS[locationId]];
  let h = 0;
  for (const c of locationId) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return COLORS[2 + (h % (COLORS.length - 2))];
}

function locationEmoji(locationId, name) {
  if (locationId === 'mega') return '🏠';
  if (locationId === '809')  return '🏡';
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return EMOJIS[2 + (h % (EMOJIS.length - 2))];
}

// ── Identity ─────────────────────────────────────────────────────────────────
let userId   = localStorage.getItem('booling_uid');
let userName = localStorage.getItem('booling_name');
let fcmToken = null;

if (!userId) {
  userId = 'u_' + crypto.randomUUID().replace(/-/g,'').slice(0,12);
  localStorage.setItem('booling_uid', userId);
}

// ── State ────────────────────────────────────────────────────────────────────
let locationsMap = {};  // locationId → { name, isPermanent }
let usersMap     = {};  // userId → { name, locationId, message, fcmToken }
let listeningStarted = false; // guard against duplicate onSnapshot registrations

// Pending check-in target (set when sheet opens)
let pendingLocationId   = null;
let pendingLocationName = null;

// ── DOM ──────────────────────────────────────────────────────────────────────
const nameScreen         = document.getElementById('name-screen');
const mainScreen         = document.getElementById('main-screen');
const nameInput          = document.getElementById('name-input');
const nameSubmit         = document.getElementById('name-submit');
const userNameEl         = document.getElementById('user-name-display');
const changeNameBtn      = document.getElementById('change-name-btn');
const btnOut             = document.getElementById('btn-out');
const currentStatus      = document.getElementById('current-status');
const currentLocationEl  = document.getElementById('current-location-label');
const notifPrompt        = document.getElementById('notif-prompt');
const enableNotifsBtn    = document.getElementById('enable-notifs');
const locationBoard      = document.getElementById('locations-board');
const checkinButtons     = document.getElementById('checkin-buttons');
const addSpotBtn         = document.getElementById('add-spot-btn');
const backdrop           = document.getElementById('sheet-backdrop');
// Check-in sheet
const checkinSheet       = document.getElementById('checkin-sheet');
const sheetLocationName  = document.getElementById('sheet-location-name');
const checkinMessage     = document.getElementById('checkin-message');
const charCount          = document.getElementById('char-count');
const sheetConfirm       = document.getElementById('sheet-confirm');
const sheetCancel        = document.getElementById('sheet-cancel');
// Add-spot sheet
const addSpotSheet       = document.getElementById('add-spot-sheet');
const spotNameInput      = document.getElementById('spot-name-input');
const spotConfirm        = document.getElementById('spot-confirm');
const spotCancel         = document.getElementById('spot-cancel');
const toast              = document.getElementById('toast');

// ── Bootstrap ────────────────────────────────────────────────────────────────
async function init() {
  await registerSW();
  if (!userName) {
    show(nameScreen);
  } else {
    show(mainScreen);
    userNameEl.textContent = userName;
    await seedLocations();
    startListening();
    initMessaging();
  }
}

async function registerSW() {
  if ('serviceWorker' in navigator) {
    try { await navigator.serviceWorker.register('/firebase-messaging-sw.js'); }
    catch (e) { console.warn('SW failed:', e); }
  }
}

// Ensure Mega and 809 always exist
async function seedLocations() {
  await Promise.all([
    setDoc(doc(db, 'locations', 'mega'), { name: 'Mega', isPermanent: true }, { merge: true }),
    setDoc(doc(db, 'locations', '809'),  { name: '809',  isPermanent: true }, { merge: true }),
  ]);
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
  await seedLocations();
  startListening();
  await initMessaging();
}

changeNameBtn.addEventListener('click', () => {
  nameInput.value = userName ?? '';
  show(nameScreen);
  setTimeout(() => nameInput.focus(), 50);
});

// ── Firestore listeners ───────────────────────────────────────────────────────
function startListening() {
  if (listeningStarted) return; // prevent duplicate listeners from name-change flow
  listeningStarted = true;

  onSnapshot(collection(db, 'locations'), snap => {
    locationsMap = {};
    snap.forEach(d => { locationsMap[d.id] = d.data(); });
    render();
  });

  onSnapshot(collection(db, 'users'), snap => {
    usersMap = {};
    snap.forEach(d => { usersMap[d.id] = d.data(); });
    render();
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const myUser    = usersMap[userId];
  const myLocId   = myUser?.locationId ?? null;
  const myLocName = myLocId ? (locationsMap[myLocId]?.name ?? myLocId) : null;

  // Sort: permanent first (mega, then 809), then custom alphabetically
  const sorted = Object.entries(locationsMap).sort(([aId, a], [bId, b]) => {
    if (a.isPermanent && !b.isPermanent) return -1;
    if (!a.isPermanent && b.isPermanent) return 1;
    if (a.isPermanent && b.isPermanent) {
      // mega before 809
      if (aId === 'mega') return -1;
      if (bId === 'mega') return  1;
    }
    return a.name.localeCompare(b.name);
  });

  // Build people-per-location index
  const peopleAt = {}; // locationId → [{ uid, name, message }]
  for (const [uid, u] of Object.entries(usersMap)) {
    if (u.locationId && locationsMap[u.locationId]) {
      (peopleAt[u.locationId] ??= []).push({ uid, name: u.name, message: u.message ?? '' });
    }
  }

  // ── Render status board ──
  locationBoard.innerHTML = '';
  for (const [locId, loc] of sorted) {
    const people = peopleAt[locId] ?? [];
    const { accent, dim } = locationColor(locId);
    const emoji = locationEmoji(locId, loc.name);
    const isLit = people.length > 0;

    const card = document.createElement('div');
    card.className = `loc-card${isLit ? ' lit' : ''}`;
    card.style.setProperty('--accent', accent);
    card.style.setProperty('--accent-dim', dim);

    const deleteBtn = !loc.isPermanent
      ? `<button class="card-delete" data-loc-id="${locId}" title="Remove spot">✕</button>`
      : '';

    card.innerHTML = `
      <div class="card-header">
        <span class="card-emoji">${emoji}</span>
        <span class="card-name">${esc(loc.name)}</span>
        <span class="card-badge">${people.length}</span>
        ${deleteBtn}
      </div>
      <div class="card-people" id="people-${locId}">
        ${people.length === 0
          ? '<span class="empty-text">Nobody here yet</span>'
          : people.map(p => `
              <div class="person-entry">
                <span class="chip${p.uid === userId ? ' me' : ''}">${p.uid === userId ? '⭐ ' : ''}${esc(p.name)}</span>
                ${p.message ? `<span class="person-msg">"${esc(p.message)}"</span>` : ''}
              </div>`).join('')}
      </div>`;

    locationBoard.appendChild(card);
  }

  // Delete button listeners
  locationBoard.querySelectorAll('.card-delete').forEach(btn => {
    btn.addEventListener('click', () => deleteLocation(btn.dataset.locId));
  });

  // ── Render check-in buttons ──
  checkinButtons.innerHTML = '';
  for (const [locId, loc] of sorted) {
    const { accent, dim } = locationColor(locId);
    const emoji = locationEmoji(locId, loc.name);
    const btn = document.createElement('button');
    btn.className = `btn-loc${locId === myLocId ? ' active' : ''}`;
    btn.style.setProperty('--accent', accent);
    btn.style.setProperty('--accent-dim', dim);
    btn.dataset.locId = locId;
    btn.dataset.locName = loc.name;
    btn.innerHTML = `${emoji}<br>${esc(loc.name)}`;
    btn.addEventListener('click', () => openCheckinSheet(locId, loc.name));
    checkinButtons.appendChild(btn);
  }

  // ── Current status ──
  if (myLocId && myLocName) {
    currentStatus.classList.remove('hidden');
    currentLocationEl.textContent = myLocName;
  } else {
    currentStatus.classList.add('hidden');
  }
}

function esc(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Delete custom location ────────────────────────────────────────────────────
async function deleteLocation(locId) {
  const loc = locationsMap[locId];
  if (!loc || loc.isPermanent) return;

  // Move anyone still there to "out"
  const affected = Object.entries(usersMap).filter(([,u]) => u.locationId === locId);
  await Promise.all(affected.map(([uid]) =>
    setDoc(doc(db, 'users', uid), { locationId: null, locationName: null, message: null }, { merge: true })
  ));

  await deleteDoc(doc(db, 'locations', locId));
  showToast(`Removed ${loc.name}`);
}

// ── Auto-cleanup empty custom locations ──────────────────────────────────────
// Called after a check-out; removes a non-permanent location if it's empty.
async function cleanupIfEmpty(locId) {
  if (!locId) return;
  const loc = locationsMap[locId];
  if (!loc || loc.isPermanent) return;
  const stillThere = Object.values(usersMap).some(u => u.locationId === locId);
  if (!stillThere) {
    await deleteDoc(doc(db, 'locations', locId));
  }
}

// ── Check-in sheet ────────────────────────────────────────────────────────────
function openCheckinSheet(locId, locName) {
  pendingLocationId   = locId;
  pendingLocationName = locName;
  sheetLocationName.textContent = locName;
  checkinMessage.value = '';
  charCount.textContent = '0';
  openSheet(checkinSheet);
  setTimeout(() => checkinMessage.focus(), 350);
}

checkinMessage.addEventListener('input', () => {
  charCount.textContent = checkinMessage.value.length;
});

sheetConfirm.addEventListener('click', async () => {
  if (!pendingLocationId || sheetConfirm.disabled) return;
  sheetConfirm.disabled = true;
  const locId  = pendingLocationId;
  const locName = pendingLocationName;
  const msg    = checkinMessage.value.trim();
  closeSheets();
  try {
    await checkIn(locId, locName, msg);
    showToast(`Checked in at ${locName} 🎉`);
  } finally {
    sheetConfirm.disabled = false;
  }
});

sheetCancel.addEventListener('click', closeSheets);

// ── Add-spot sheet ────────────────────────────────────────────────────────────
addSpotBtn.addEventListener('click', () => {
  spotNameInput.value = '';
  openSheet(addSpotSheet);
  setTimeout(() => spotNameInput.focus(), 350);
});

spotNameInput.addEventListener('keydown', e => e.key === 'Enter' && addSpot());

spotConfirm.addEventListener('click', addSpot);
spotCancel.addEventListener('click', closeSheets);

async function addSpot() {
  const name = spotNameInput.value.trim();
  if (!name) { spotNameInput.focus(); return; }

  // Check for duplicate name (case-insensitive)
  const exists = Object.values(locationsMap).some(l => l.name.toLowerCase() === name.toLowerCase());
  if (exists) { showToast('That spot already exists!'); return; }

  closeSheets();
  const newRef = doc(collection(db, 'locations'));
  await setDoc(newRef, { name, isPermanent: false, createdAt: serverTimestamp() });
  showToast(`Added ${name} 📍`);
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────
function openSheet(sheet) {
  backdrop.classList.remove('hidden');
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
  sheet.classList.remove('hidden');
}

function closeSheets() {
  backdrop.classList.add('hidden');
  document.querySelectorAll('.sheet').forEach(s => s.classList.add('hidden'));
  pendingLocationId = pendingLocationName = null;
}

backdrop.addEventListener('click', closeSheets);

// ── Firestore writes ──────────────────────────────────────────────────────────
async function checkIn(locationId, locationName, message = '') {
  const prevLocId = usersMap[userId]?.locationId ?? null;

  await setDoc(doc(db, 'users', userId), {
    name:         userName,
    locationId,
    locationName,
    message:      message || null,
    fcmToken:     fcmToken ?? null,
    updatedAt:    serverTimestamp(),
  }, { merge: true });

  // Clean up previous custom location if it's now empty
  if (prevLocId && prevLocId !== locationId) {
    // Give Firestore a tick to propagate
    setTimeout(() => cleanupIfEmpty(prevLocId), 1500);
  }

  notifyOthers({ name: userName, house: locationName, message: message || null, senderToken: fcmToken });
}

async function checkOut() {
  const prevLocId = usersMap[userId]?.locationId ?? null;

  await setDoc(doc(db, 'users', userId), {
    name:         userName,
    locationId:   null,
    locationName: null,
    message:      null,
    fcmToken:     fcmToken ?? null,
    updatedAt:    serverTimestamp(),
  }, { merge: true });

  if (prevLocId) setTimeout(() => cleanupIfEmpty(prevLocId), 1500);

  notifyOthers({ name: userName, house: null, message: null, senderToken: fcmToken });
}

async function notifyOthers(payload) {
  try {
    await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  } catch { /* non-fatal */ }
}

btnOut.addEventListener('click', async () => {
  btnOut.disabled = true;
  try { await checkOut(); showToast('You left 👋'); }
  finally { btnOut.disabled = false; }
});

// ── FCM ───────────────────────────────────────────────────────────────────────
async function initMessaging() {
  if (!('Notification' in window)) return;
  try { messaging = getMessaging(fbApp); }
  catch (e) { console.warn('Messaging unavailable:', e); return; }

  if (Notification.permission === 'granted') {
    await grabFCMToken();
  } else if (Notification.permission !== 'denied') {
    notifPrompt.classList.remove('hidden');
  }

  // data-only messages: title/body live in payload.data, not payload.notification
  onMessage(messaging, payload => {
    showToast(payload.data?.body ?? payload.data?.title ?? 'Someone checked in!');
  });
}

enableNotifsBtn.addEventListener('click', async () => {
  const perm = await Notification.requestPermission();
  notifPrompt.classList.add('hidden');
  if (perm === 'granted') { await grabFCMToken(); showToast('Notifications on 🔔'); }
  else showToast('Notifications blocked');
});

async function grabFCMToken() {
  if (!messaging) return;
  try {
    const swReg = await navigator.serviceWorker.ready;
    fcmToken = await getToken(messaging, { vapidKey, serviceWorkerRegistration: swReg });
    if (fcmToken && userName) {
      await setDoc(doc(db, 'users', userId), { fcmToken, name: userName }, { merge: true });
    }
  } catch (e) { console.warn('FCM token error:', e); }
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function show(el) {
  nameScreen.classList.add('hidden');
  mainScreen.classList.add('hidden');
  el.classList.remove('hidden');
}

let toastTimer;
function showToast(msg) {
  toast.textContent = msg;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 3200);
}

// ── Go ────────────────────────────────────────────────────────────────────────
init();
