import { config, api } from './config.js';
import { eventKey as readEventKey } from './event-key.js';

const COUNT_STORAGE = 'wps.sharedCount';
const CONCURRENCY = 2;

// HEIC is in the list because iPhones occasionally hand one over intact. It
// uploads fine; whether it renders in the slideshow is up to the TV's browser,
// and the UI says as much.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

const el = {
  gate: document.getElementById('gate'),
  uploader: document.getElementById('uploader'),
  dropzone: document.getElementById('dropzone'),
  input: document.getElementById('file-input'),
  pick: document.getElementById('pick-btn'),
  queue: document.getElementById('queue'),
  tally: document.getElementById('tally'),
  maxMb: document.getElementById('max-mb'),
};

const maxBytes = (config.maxUploadMB || 12) * 1024 * 1024;
const eventKey = readEventKey();

let active = 0;
const pending = [];

init();

function init() {
  if (el.maxMb) el.maxMb.textContent = String(config.maxUploadMB || 12);

  if (!eventKey || !config.apiBase) {
    el.gate.hidden = false;
    return;
  }

  el.uploader.hidden = false;
  renderTally();

  el.pick.addEventListener('click', () => el.input.click());
  el.input.addEventListener('change', () => {
    addFiles(el.input.files);
    el.input.value = '';   // so picking the same photo twice still fires change
  });

  // Desktop convenience; phones never see it.
  ['dragenter', 'dragover'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.add('is-dragging');
    })
  );
  ['dragleave', 'drop'].forEach((ev) =>
    el.dropzone.addEventListener(ev, (e) => {
      e.preventDefault();
      el.dropzone.classList.remove('is-dragging');
    })
  );
  el.dropzone.addEventListener('drop', (e) => {
    if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files);
  });
}

/* -- queue ---------------------------------------------------------------- */

function addFiles(fileList) {
  Array.from(fileList).forEach((file) => {
    const item = createItem(file);
    if (file.size > maxBytes) {
      item.fail(`For stor (${mb(file.size)} MB) — maks. ${config.maxUploadMB} MB`, false);
      return;
    }
    pending.push(item);
  });
  pump();
}

function pump() {
  while (active < CONCURRENCY && pending.length) {
    const item = pending.shift();
    active += 1;
    run(item).finally(() => {
      active -= 1;
      pump();
    });
  }
}

async function run(item) {
  try {
    await upload(item);
  } catch (err) {
    // One automatic retry: on a crowded venue network the first PUT often dies
    // mid-flight and a second attempt just works.
    if (err && err.retryable) {
      await sleep(1200);
      try {
        await upload(item);
        return;
      } catch (err2) {
        item.fail(message(err2), true);
        return;
      }
    }
    item.fail(message(err), Boolean(err && err.retryable));
  }
}

async function upload(item) {
  item.setState('Forbereder…');
  item.setProgress(0);

  const prepared = item.prepared || (await prepare(item.file));
  item.prepared = prepared;
  item.setThumb(prepared.blob);
  if (prepared.raw) item.note('sendt som den er');

  item.setState('Sender…');
  const ticket = await requestTicket(prepared);
  await put(ticket.uploadUrl, prepared.blob, prepared.contentType, (p) => item.setProgress(p));

  item.done();
  bumpTally();
}

async function requestTicket(prepared) {
  let res;
  try {
    res = await fetch(api('/api/upload-url'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Event-Key': eventKey },
      body: JSON.stringify({ contentType: prepared.contentType, size: prepared.blob.size }),
    });
  } catch (e) {
    throw retryable(new Error('Ingen forbindelse'));
  }

  if (res.status === 403) throw new Error('Scan QR-koden igen');
  if (res.status === 429) throw retryable(new Error('Vent et øjeblik'));
  if (!res.ok) throw retryable(new Error(`Fejl i uploadtjenesten (${res.status})`));

  return res.json();
}

/* -- image processing ----------------------------------------------------- */

// Downscale + re-encode in the browser. Three wins: uploads finish on bad wifi,
// iPhone HEIC becomes something a TV browser can display, and the canvas
// round-trip drops EXIF — including the GPS tag on the guest's photo.
async function prepare(file) {
  const maxEdge = config.maxEdge || 2560;

  try {
    const img = await decode(file);
    const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(img.src);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    canvas.width = canvas.height = 0;   // iOS holds onto canvas memory otherwise
    if (!blob) throw new Error('encode failed');

    return { blob, contentType: 'image/jpeg', raw: false };
  } catch (e) {
    // Desktop Chrome/Firefox can't decode HEIC. Send the original and let the
    // guest know it may not make the screen.
    const type = ALLOWED_TYPES.includes(file.type) ? file.type : 'image/jpeg';
    if (file.size > maxBytes) throw new Error(`For stor (${mb(file.size)} MB)`);
    return { blob: file, contentType: type, raw: true };
  }
}

// The <img> path rather than createImageBitmap: every browser since ~2020
// applies EXIF orientation here, so portrait photos don't land sideways.
function decode(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('cannot decode'));
    };
    img.src = url;
  });
}

function put(url, blob, contentType, onProgress) {
  return new Promise((resolve, reject) => {
    // XHR, not fetch: fetch still has no upload progress event, and a progress
    // bar is the difference between "waiting" and "broken" on slow wifi.
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url, true);
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      else reject(retryable(new Error(`Lageret afviste den (${xhr.status})`)));
    };
    xhr.onerror = () => reject(retryable(new Error('Forbindelsen blev afbrudt')));
    xhr.ontimeout = () => reject(retryable(new Error('Tiden løb ud')));
    xhr.timeout = 120000;
    xhr.send(blob);
  });
}

/* -- per-file UI ---------------------------------------------------------- */

function createItem(file) {
  const li = document.createElement('li');
  li.className = 'item';
  li.innerHTML = `
    <img class="item-thumb" alt="">
    <div class="item-body">
      <div class="item-name"></div>
      <div class="item-bar"><span></span></div>
    </div>
    <div class="item-state">I kø</div>`;

  li.querySelector('.item-name').textContent = file.name || 'billede';
  el.queue.prepend(li);

  const bar = li.querySelector('.item-bar span');
  const state = li.querySelector('.item-state');
  const thumb = li.querySelector('.item-thumb');

  const item = {
    file,
    prepared: null,
    setState: (text) => { state.textContent = text; },
    setProgress: (p) => { bar.style.width = `${Math.round(p * 100)}%`; },
    setThumb: (blob) => { thumb.src = URL.createObjectURL(blob); },
    note: (text) => { li.querySelector('.item-name').textContent += ` · ${text}`; },
    done: () => {
      li.classList.remove('is-error');
      li.classList.add('is-done');
      state.textContent = 'Delt ✓';
      bar.style.width = '100%';
    },
    fail: (text, canRetry) => {
      li.classList.add('is-error');
      state.textContent = text;
      if (!canRetry) return;
      const btn = document.createElement('button');
      btn.className = 'retry';
      btn.type = 'button';
      btn.textContent = 'Prøv igen';
      btn.addEventListener('click', () => {
        btn.remove();
        li.classList.remove('is-error');
        pending.push(item);
        pump();
      });
      state.after(btn);
    },
  };

  return item;
}

function bumpTally() {
  const next = Number(read(COUNT_STORAGE) || 0) + 1;
  store(COUNT_STORAGE, String(next));
  renderTally();
}

function renderTally() {
  const n = Number(read(COUNT_STORAGE) || 0);
  if (!n) return;
  el.tally.hidden = false;
  el.tally.textContent = n === 1 ? 'Du har delt 1 billede. Tak.' : `Du har delt ${n} billeder. Tak.`;
}

/* -- small helpers -------------------------------------------------------- */

function retryable(err) { err.retryable = true; return err; }
function message(err) { return (err && err.message) || 'Noget gik galt'; }
function mb(bytes) { return (bytes / 1024 / 1024).toFixed(1); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function read(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } }
