import { initializeApp }                                   from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getFirestore, collection, doc, setDoc, deleteDoc,
         onSnapshot, serverTimestamp }                     from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';
import { getMessaging, getToken, onMessage }               from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging.js';
import { firebaseConfig, vapidKey }                        from './firebase-config.js';

// ── Firebase ──────────────────────────────────────────────────────────────────
const fbApp = initializeApp(firebaseConfig);
const db    = getFirestore(fbApp);
let messaging = null;

// ── Permanent locations — hardcoded, never touch Firestore for these ───────────
// This ensures Mega and 809 always render even if Firestore rules aren't set up.
const PERMANENT = [
  { id: 'mega', name: 'Mega', emoji: '🏠', color: '#ff4f00', dim: 'rgba(255,79,0,.30)' },
  { id: '809',  name: '809',  emoji: '🏡', color: '#00b4ff', dim: 'rgba(0,180,255,.30)' },
];
const PERM_IDS = new Set(PERMANENT.map(p => p.id));

// Colors cycled for custom spots, assigned deterministically by Firestore doc ID
const CUSTOM_PALETTE = [
  { color: '#22d47e', dim: 'rgba(34,212,126,.30)'  },
  { color: '#f472b6', dim: 'rgba(244,114,182,.30)' },
  { color: '#a78bfa', dim: 'rgba(167,139,250,.30)' },
  { color: '#fbbf24', dim: 'rgba(251,191,36,.30)'  },
  { color: '#fb923c', dim: 'rgba(251,146,60,.30)'  },
  { color: '#34d399', dim: 'rgba(52,211,153,.30)'  },
];

function customColor(id) {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return CUSTOM_PALETTE[h % CUSTOM_PALETTE.length];
}

// ── Identity ──────────────────────────────────────────────────────────────────
let userId   = localStorage.getItem('booling_uid');
let userName = localStorage.getItem('booling_name');
let fcmToken = null;

if (!userId) {
  userId = 'u_' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
  localStorage.setItem('booling_uid', userId);
}

// ── State ─────────────────────────────────────────────────────────────────────
let customLocs       = [];  // [{ id, name, emoji, color, dim }]  from Firestore
let usersMap         = {};  // userId → Firestore user doc
let listeningStarted = false;

// Pending check-in (set when the sheet opens)
let pendingLocId   = null;
let pendingLocName = null;

// ── DOM refs ──────────────────────────────────────────────────────────────────
const nameScreen      = document.getElementById('name-screen');
const mainScreen      = document.getElementById('main-screen');
const nameInput       = document.getElementById('name-input');
const nameSubmit      = document.getElementById('name-submit');
const userNameEl      = document.getElementById('user-name-display');
const changeNameBtn   = document.getElementById('change-name-btn');
const btnOut          = document.getElementById('btn-out');
const currentStatus   = document.getElementById('current-status');
const currentLocEl    = document.getElementById('current-location-label');
const notifPrompt     = document.getElementById('notif-prompt');
const enableNotifsBtn = document.getElementById('enable-notifs');
const locationBoard   = document.getElementById('locations-board');
const checkinBtns     = document.getElementById('checkin-buttons');
const addSpotBtn      = document.getElementById('add-spot-btn');
const backdrop        = document.getElementById('sheet-backdrop');
const checkinSheet    = document.getElementById('checkin-sheet');
const sheetLocName    = document.getElementById('sheet-location-name');
const checkinMsg      = document.getElementById('checkin-message');
const charCount       = document.getElementById('char-count');
const sheetConfirm    = document.getElementById('sheet-confirm');
const sheetCancel     = document.getElementById('sheet-cancel');
const addSpotSheet    = document.getElementById('add-spot-sheet');
const spotNameInput   = document.getElementById('spot-name-input');
const spotConfirm     = document.getElementById('spot-confirm');
const spotCancel      = document.getElementById('spot-cancel');
const toastEl         = document.getElementById('toast');

// ── Bootstrap ─────────────────────────────────────────────────────────────────
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
    try { await navigator.serviceWorker.register('/firebase-messaging-sw.js'); }
    catch (e) { console.warn('SW registration failed:', e); }
  }
}

// ── Name entry ────────────────────────────────────────────────────────────────
nameSubmit.addEventListener('click', submitName);
nameInput.addEventListener('keydown', e => e.key === 'Enter' && submitName());

async function submitName() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  userName = name;
  localStorage.setItem('booling_name', name);
  userNameEl.textContent = name;
  show(mainScreen);
  startListening();           // guard inside prevents duplicate listeners
  await initMessaging();
}

changeNameBtn.addEventListener('click', () => {
  nameInput.value = userName ?? '';
  show(nameScreen);
  setTimeout(() => nameInput.focus(), 50);
});

// ── Firestore listeners ───────────────────────────────────────────────────────
function startListening() {
  if (listeningStarted) return;  // prevent duplicate listeners on name-change flow
  listeningStarted = true;

  // Custom locations collection (skip any doc whose ID matches a permanent one)
  onSnapshot(collection(db, 'locations'), snap => {
    customLocs = [];
    snap.forEach(d => {
      if (PERM_IDS.has(d.id)) return;
      const data = d.data();
      if (data.isPermanent) return;
      const { color, dim } = customColor(d.id);
      customLocs.push({ id: d.id, name: data.name, emoji: '📍', color, dim });
    });
    customLocs.sort((a, b) => a.name.localeCompare(b.name));
    render();
  }, err => {
    // Firestore rules may not yet include 'locations' — permanent locs still render
    console.warn('Locations listener error (check Firestore rules):', err.message);
    render(); // render with just the permanent locations
  });

  onSnapshot(collection(db, 'users'), snap => {
    usersMap = {};
    snap.forEach(d => { usersMap[d.id] = d.data(); });
    render();
  }, err => {
    console.warn('Users listener error:', err.message);
  });
}

// ── Render ────────────────────────────────────────────────────────────────────
function render() {
  const allLocs = [...PERMANENT, ...customLocs];
  const myUser  = usersMap[userId];
  const myLocId = myUser?.locationId ?? null;

  // Index people by location
  const peopleAt = {};
  for (const [uid, u] of Object.entries(usersMap)) {
    const lid = u.locationId;
    if (!lid) continue;
    if (!allLocs.some(l => l.id === lid)) continue; // unknown/stale location
    (peopleAt[lid] ??= []).push({ uid, name: u.name ?? '?', message: u.message ?? '' });
  }

  // ── Board cards ──
  locationBoard.innerHTML = '';
  for (const loc of allLocs) {
    const people = peopleAt[loc.id] ?? [];
    const isLit  = people.length > 0;
    const isPerm = PERM_IDS.has(loc.id);

    const card = document.createElement('div');
    card.className = `loc-card${isLit ? ' lit' : ''}`;
    card.style.setProperty('--accent',     loc.color);
    card.style.setProperty('--accent-dim', loc.dim);

    const delBtn = isPerm
      ? ''
      : `<button class="card-delete" data-id="${loc.id}" title="Remove spot">✕</button>`;

    const peopleHtml = people.length === 0
      ? '<span class="empty-text">Nobody here yet</span>'
      : people.map(p => {
          const isMe = p.uid === userId;
          return `
            <div class="person-row">
              <div class="avatar${isMe ? ' me' : ''}"
                   style="--accent:${loc.color};--accent-dim:${loc.dim}">${initials(p.name)}</div>
              <div class="person-info">
                <span class="person-name">${esc(p.name)}${isMe ? ' ⭐' : ''}</span>
                ${p.message ? `<span class="person-msg">"${esc(p.message)}"</span>` : ''}
              </div>
            </div>`;
        }).join('');

    card.innerHTML = `
      <div class="card-header">
        <span class="card-emoji">${loc.emoji}</span>
        <span class="card-name">${esc(loc.name)}</span>
        <span class="card-badge">${people.length}</span>
        ${delBtn}
      </div>
      <div class="card-people">${peopleHtml}</div>`;

    card.querySelector('.card-delete')
        ?.addEventListener('click', () => deleteLocation(loc.id));

    locationBoard.appendChild(card);
  }

  // ── Check-in buttons ──
  checkinBtns.innerHTML = '';
  for (const loc of allLocs) {
    const btn = document.createElement('button');
    btn.className = `btn-loc${loc.id === myLocId ? ' active' : ''}`;
    btn.style.setProperty('--accent',     loc.color);
    btn.style.setProperty('--accent-dim', loc.dim);
    btn.innerHTML = `${loc.emoji}<br>${esc(loc.name)}`;
    btn.addEventListener('click', () => openCheckinSheet(loc.id, loc.name));
    checkinBtns.appendChild(btn);
  }

  // ── Status pill ──
  if (myLocId) {
    const loc = allLocs.find(l => l.id === myLocId);
    currentStatus.classList.remove('hidden');
    currentLocEl.textContent = loc?.name ?? myUser?.locationName ?? myLocId;
  } else {
    currentStatus.classList.add('hidden');
  }
}

function initials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function esc(s) {
  return String(s ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Delete custom location ────────────────────────────────────────────────────
async function deleteLocation(locId) {
  if (PERM_IDS.has(locId)) return;
  const loc = customLocs.find(l => l.id === locId);

  // Move anyone there to "out" first
  const affected = Object.entries(usersMap).filter(([, u]) => u.locationId === locId);
  await Promise.all(affected.map(([uid]) =>
    setDoc(doc(db, 'users', uid),
           { locationId: null, locationName: null, message: null }, { merge: true })
  ));

  await deleteDoc(doc(db, 'locations', locId));
  if (loc) showToast(`Removed ${loc.name}`);
}

// Auto-delete empty custom locations after someone leaves
async function cleanupIfEmpty(locId) {
  if (!locId || PERM_IDS.has(locId)) return;
  const stillThere = Object.values(usersMap).some(u => u.locationId === locId);
  if (!stillThere) {
    try { await deleteDoc(doc(db, 'locations', locId)); } catch { /* ok */ }
  }
}

// ── Check-in sheet ────────────────────────────────────────────────────────────
function openCheckinSheet(locId, locName) {
  pendingLocId   = locId;
  pendingLocName = locName;
  sheetLocName.textContent = locName;
  checkinMsg.value = '';
  charCount.textContent = '0';
  openSheet(checkinSheet);
  setTimeout(() => checkinMsg.focus(), 350);
}

checkinMsg.addEventListener('input', () => {
  charCount.textContent = checkinMsg.value.length;
});

sheetConfirm.addEventListener('click', async () => {
  if (!pendingLocId || sheetConfirm.disabled) return;
  sheetConfirm.disabled = true;
  const locId   = pendingLocId;
  const locName = pendingLocName;
  const msg     = checkinMsg.value.trim();
  closeSheets();
  try {
    await checkIn(locId, locName, msg);
    showToast(`Checked in at ${locName} 🎉`);
  } finally {
    sheetConfirm.disabled = false;
  }
});

sheetCancel.addEventListener('click', closeSheets);

// ── Add spot sheet ────────────────────────────────────────────────────────────
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

  const allNames = [...PERMANENT, ...customLocs].map(l => l.name.toLowerCase());
  if (allNames.includes(name.toLowerCase())) {
    showToast('That spot already exists!');
    return;
  }

  closeSheets();
  try {
    const ref = doc(collection(db, 'locations'));
    await setDoc(ref, { name, isPermanent: false, createdAt: serverTimestamp() });
    showToast(`Added ${name} 📍`);
  } catch (e) {
    console.error('Failed to add spot:', e);
    showToast('Failed — check Firestore rules include "locations"');
  }
}

// ── Sheet helpers ─────────────────────────────────────────────────────────────
function openSheet(s) {
  backdrop.classList.add('open');
  [checkinSheet, addSpotSheet].forEach(sh => sh.classList.remove('open'));
  s.classList.add('open');
}

function closeSheets() {
  backdrop.classList.remove('open');
  [checkinSheet, addSpotSheet].forEach(s => s.classList.remove('open'));
  pendingLocId = pendingLocName = null;
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

  // Schedule cleanup of the previous custom location if it's now empty
  if (prevLocId && prevLocId !== locationId) {
    setTimeout(() => cleanupIfEmpty(prevLocId), 2000);
  }

  // Exactly one notify call per check-in
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

  if (prevLocId) setTimeout(() => cleanupIfEmpty(prevLocId), 2000);

  notifyOthers({ name: userName, house: null, message: null, senderToken: fcmToken });
}

async function notifyOthers(payload) {
  try {
    await fetch('/api/notify', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(payload),
    });
  } catch { /* non-fatal — board still updates via Firestore */ }
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
  catch { return; }

  if (Notification.permission === 'granted') {
    await grabFCMToken();
  } else if (Notification.permission !== 'denied') {
    notifPrompt.classList.remove('hidden');
  }

  // data-only messages — title/body live in payload.data, not payload.notification
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

// ── Utilities ─────────────────────────────────────────────────────────────────
function show(el) {
  [nameScreen, mainScreen].forEach(s => s.classList.add('hidden'));
  el.classList.remove('hidden');
}

let toastTimer;
function showToast(msg) {
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), 3200);
}

// ── Go ────────────────────────────────────────────────────────────────────────
init();
