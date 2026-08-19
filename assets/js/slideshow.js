import { config, api, num } from './config.js';
import { eventKey } from './event-key.js';

const params = new URLSearchParams(location.search);
const slideMs = num(params.get('interval'), config.slideSeconds || 7) * 1000;
const refreshMs = num(params.get('refresh'), config.refreshSeconds || 60) * 1000;

// A burst of uploads shouldn't hijack the screen for ten minutes; the overflow
// still gets shown, just via the normal shuffle.
const MAX_PRIORITY = 12;

const key = eventKey();

// Shown instead of "Waiting for the first photo…" when the manifest is refused.
// Scanning the QR on screen is no help here — that unlocks whichever phone did
// the scanning, not this machine — so the message names the one fix that works
// on the projector itself.
const LOCKED_MESSAGE = `Denne skærm mangler adgangskoden. Åbn den som ${location.pathname}?k=JERES-KODE`;

const el = {
  slides: [document.getElementById('slide-0'), document.getElementById('slide-1')],
  holding: document.getElementById('holding'),
  holdingStatus: document.getElementById('holding-status'),
  hud: document.getElementById('hud'),
  hudCount: document.getElementById('hud-count'),
  hudError: document.getElementById('hud-error'),
  fullscreen: document.getElementById('fullscreen-btn'),
};

const pool = new Map();      // key -> {key, url, uploaded}
const known = new Set();     // every key we've ever seen in a manifest
let priority = [];           // keys uploaded since the last refresh, newest first
let deck = [];               // shuffled remainder of the pool
let slot = 0;                // which of the two <img> layers is on screen
let currentKey = null;
let timer = null;
let started = false;
let locked = false;          // the Worker refused the manifest

start();

async function start() {
  el.fullscreen.addEventListener('click', toggleFullscreen);
  setupIdleHiding();
  keepScreenAwake();

  await refresh();
  started = true;
  advance();
  setInterval(refresh, refreshMs);
}

/* -- the pool ------------------------------------------------------------- */

async function refresh() {
  // Without a key the answer is a certain 403, so don't bother asking.
  if (!key) return lock();

  let photos;
  try {
    const res = await fetch(api('/api/photos'), {
      cache: 'no-store',
      headers: { 'X-Event-Key': key },
    });
    // A stale key won't fix itself on the next tick — say so rather than
    // sitting behind "Reconnecting…" for the rest of the evening.
    if (res.status === 403) return lock();
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    photos = (await res.json()).photos;
    locked = false;
    hideError();
  } catch (e) {
    // Keep playing whatever we already have. A projector going blank because a
    // fetch failed is far worse than a slightly stale pool.
    showError('Genopretter forbindelse…');
    return;
  }

  const first = known.size === 0;
  const fresh = [];
  const live = new Set();

  photos.forEach((p) => {
    pool.set(p.key, p);
    live.add(p.key);
    if (!known.has(p.key)) {
      known.add(p.key);
      if (!first) fresh.push(p);
    }
  });

  // Drop anything that has disappeared from the bucket — the "delete it in the
  // B2 console" escape hatch for a photo nobody wants on the wall.
  Array.from(pool.keys()).forEach((key) => {
    if (!live.has(key)) drop(key);
  });

  if (first) {
    deck = shuffle(Array.from(pool.keys()));
  } else if (fresh.length) {
    fresh.sort((a, b) => b.uploaded - a.uploaded);
    priority = fresh.slice(0, MAX_PRIORITY).map((p) => p.key).concat(priority).slice(0, MAX_PRIORITY);
    deck = deck.concat(fresh.slice(MAX_PRIORITY).map((p) => p.key));
  }

  renderCount();

  // First photo of the night just landed while we were sitting on the holding
  // card — start the show immediately rather than waiting out the timer.
  if (started && !currentKey && pool.size) advance();
}

function nextKey() {
  while (priority.length) {
    const key = priority.shift();
    if (pool.has(key)) return key;
  }
  if (!deck.length) deck = shuffle(Array.from(pool.keys()));
  // Don't repeat the photo already on screen when there's an alternative.
  if (deck.length > 1 && deck[deck.length - 1] === currentKey) {
    deck.splice(deck.length - 2, 0, deck.pop());
  }
  return deck.pop();
}

function drop(key) {
  pool.delete(key);
  deck = deck.filter((k) => k !== key);
  priority = priority.filter((k) => k !== key);
}

/* -- playback ------------------------------------------------------------- */

async function advance() {
  clearTimeout(timer);

  // Up to a few attempts, in case the top of the deck is stale.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const key = nextKey();
    if (!key) {
      showHolding(pool.size === 0 ? 'Venter på det første billede…' : 'Indlæser…');
      timer = setTimeout(advance, 5000);
      return;
    }

    // One photo in the pool: leave it up rather than crossfading it into itself.
    if (key === currentKey && pool.size === 1) {
      timer = setTimeout(advance, slideMs);
      return;
    }

    const photo = pool.get(key);
    try {
      await preload(photo.url);
    } catch (e) {
      drop(key);       // deleted from the bucket, or never decodable (stray HEIC)
      continue;
    }

    paint(photo);
    currentKey = key;
    hideHolding();
    timer = setTimeout(advance, slideMs);
    return;
  }

  timer = setTimeout(advance, 3000);
}

function paint(photo) {
  const next = (slot + 1) % 2;
  const incoming = el.slides[next];
  incoming.querySelector('.slide-img').src = photo.url;
  incoming.querySelector('.slide-bg').style.backgroundImage = `url("${cssUrl(photo.url)}")`;

  el.slides[next].classList.add('is-visible');
  el.slides[slot].classList.remove('is-visible');
  slot = next;
}

function preload(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed'));
    img.src = url;
  });
}

/* -- chrome --------------------------------------------------------------- */

function showHolding(text) {
  el.holding.hidden = false;
  // Being locked outranks whatever playback was about to say, and playback
  // retries every few seconds, so the check belongs here rather than at each
  // call site.
  el.holdingStatus.textContent = locked ? LOCKED_MESSAGE : text;
}

function lock() {
  locked = true;
  showError('Låst');
  // Only take over the screen when there's nothing playing. A passcode rotated
  // while the party is still going shouldn't wipe a running slideshow — the
  // pool it already has keeps cycling behind the HUD badge.
  if (!currentKey) showHolding('');
}

function hideHolding() {
  el.holding.hidden = true;
}

function renderCount() {
  const n = pool.size;
  const time = new Date().toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit' });
  el.hudCount.textContent = `${n} ${n === 1 ? 'billede' : 'billeder'} · opdateret ${time}`;
}

function showError(text) {
  el.hudError.hidden = false;
  el.hudError.textContent = text;
}

function hideError() {
  el.hudError.hidden = true;
}

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

function setupIdleHiding() {
  let idleTimer;
  const wake = () => {
    document.body.classList.remove('is-idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('is-idle'), 3000);
  };
  ['mousemove', 'keydown', 'touchstart'].forEach((ev) =>
    document.addEventListener(ev, wake, { passive: true })
  );
  wake();
}

// Without this the laptop dims the projector output halfway through dinner.
async function keepScreenAwake() {
  if (!('wakeLock' in navigator)) return;
  let lock = null;
  const acquire = async () => {
    try { lock = await navigator.wakeLock.request('screen'); } catch (e) { /* denied */ }
  };
  await acquire();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && (!lock || lock.released)) acquire();
  });
}

/* -- helpers -------------------------------------------------------------- */

function shuffle(list) {
  for (let i = list.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

function cssUrl(url) {
  return url.replace(/["\\]/g, '\\$&');
}
