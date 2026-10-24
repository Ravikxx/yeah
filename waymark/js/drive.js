// Drive & capture: be the street-view car. The camera and GPS run nonstop;
// every CHUNK_SECONDS the recording is cut into a piece that's queued for
// upload while the next piece starts. Each piece is a video plus the GPS
// track on the same clock, which is all street view needs.

import { pickMime } from './record.js';
import * as queue from './queue.js';
import * as coverage from './coverage.js';
import { findView } from './street.js';
import { prepareTrack, distance, bearing, formatDistance, formatClock } from './geo.js';
import { $, esc, makeMap, routeLine, viewerIcon, drawCoverage, toast } from './ui.js';
import { coverageLines } from './street.js';

const CHUNK_SECONDS = (() => {
  try { return Number(localStorage.getItem('waymark.debug.chunkSeconds')) || 120; } catch { return 120; }
})();
const MIN_CHUNK_METERS = 10;      // skip pieces where you barely moved; a short last piece is still real footage
const VIDEO_BPS = 1_500_000;      // ~11 MB a minute

const S = {
  stream: null, watchId: null, lastFix: null, heading: null,
  capturing: false, session: null, sessionT0: 0, mode: 'drive', listed: true,
  chunk: null, timer: null, tick: null, wakeLock: null,
  meters: 0, pieces: 0, skipped: 0, recentFixes: [],
  map: null, covLayer: null, trail: null, me: null,
};
const el = {};
let wired = false;
let unsubs = [];

export function enterDrive() {
  wire();
  if (!S.capturing) {
    el.intro.hidden = false;
    el.hud.hidden = true;
    el.done.hidden = true;
    el.error.hidden = true;
  }
  unsubs.push(queue.onStatus(renderUpload));
  unsubs.push(coverage.onChange(drawMapCoverage));
  return leaveDrive;
}

function leaveDrive() {
  if (S.capturing) stopCapture(); // keep the footage: pieces are already queued
  stopCamera();
  stopGps();
  unsubs.forEach((u) => u());
  unsubs = [];
}

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['driveIntro', 'driveHud', 'driveDone', 'dcam', 'driveStart', 'driveError', 'driveBtn', 'driveClose',
    'dGps', 'dTime', 'dDist', 'dUpload', 'driveMap', 'streetStatus', 'driveSummary', 'driveAgain', 'driveForm']) {
    el[id] = document.getElementById(id);
  }
  el.intro = el.driveIntro; el.hud = el.driveHud; el.done = el.driveDone; el.error = el.driveError;
  el.driveStart.addEventListener('click', start);
  el.driveBtn.addEventListener('click', () => (S.capturing ? stopCapture() : startCapture()));
  el.driveClose.addEventListener('click', () => { location.hash = '#/'; });
  el.driveAgain.addEventListener('click', () => {
    el.done.hidden = true;
    if (S.stream) el.hud.hidden = false; else el.intro.hidden = false;
  });
  addEventListener('beforeunload', (e) => {
    if (S.capturing || queue.status.waiting) { e.preventDefault(); e.returnValue = ''; }
  });
}

async function start() {
  el.error.hidden = true;
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return showError('This browser can’t record video here. Use a recent Chrome or Safari over https.');
  }
  const f = el.driveForm.elements;
  S.mode = f.dmode.value;
  S.listed = f.dlisted.value === '1';
  el.driveStart.disabled = true;
  startGps(); // ask for location right away, while the tap still counts (iPhone only prompts then)
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false,
    });
  } catch (err) {
    el.driveStart.disabled = false;
    return showError(err?.name === 'NotAllowedError'
      ? 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.'
      : `The camera didn’t start (${err?.message || err}).`);
  }
  el.driveStart.disabled = false;
  el.dcam.srcObject = S.stream;
  el.dcam.play().catch(() => {});
  el.intro.hidden = true;
  el.hud.hidden = false;
  setupMap();
}

function showError(msg) {
  el.error.textContent = msg;
  el.error.hidden = false;
}

function stopCamera() {
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  if (el.dcam) el.dcam.srcObject = null;
}

// ---------- GPS ----------

function startGps() {
  stopGps();
  if (!navigator.geolocation) { setGps('bad', 'No GPS'); return; }
  S.watchId = navigator.geolocation.watchPosition((pos) => { hideLocationHelp(); onFix(pos); }, (err) => {
    setGps('bad', err.code === 1 ? 'Location blocked' : 'GPS unavailable');
    if (err.code === 1) showLocationHelp();
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

const IS_APPLE = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent) && 'ontouchend' in document;
function showLocationHelp() {
  const box = document.getElementById('locHelp');
  box.innerHTML = `<b>Location is blocked for this site</b>
    ${IS_APPLE ? `<ol>
      <li>Open <b>Settings → Privacy &amp; Security → Location Services</b>. Make sure it’s on, then tap <b>Safari Websites</b> and choose <b>While Using the App</b> with <b>Precise Location</b> on.</li>
      <li>Back in Safari, tap the page-settings button left of the address, then <b>Website Settings → Location → Allow</b>.</li>
    </ol>` : `<p>Tap the icon left of the address bar, then <b>Permissions → Location → Allow</b>.</p>`}
    <button type="button" class="btn btn-primary btn-sm" id="locRetry">Try again</button>`;
  box.hidden = false;
  document.getElementById('locRetry').onclick = () => { setGps('wait', 'Finding GPS…'); startGps(); };
}
function hideLocationHelp() {
  const box = document.getElementById('locHelp');
  if (box) box.hidden = true;
}

function stopGps() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}

function setGps(state, text) {
  el.dGps.dataset.state = state;
  el.dGps.textContent = text;
}

function onFix(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
  const gpsSpeed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;     // m/s, from the phone
  const gpsHeading = Number.isFinite(pos.coords.heading) ? pos.coords.heading : null; // degrees, from the phone
  const now = performance.now();
  const fix = { lat, lng, acc, at: now };
  setGps(acc <= 15 ? 'good' : acc <= 35 ? 'fair' : 'bad', `GPS ±${formatDistance(acc)}`);

  // Heading from the last ~25 m of travel; GPS's own heading is noisy at low speed.
  S.recentFixes.push(fix);
  while (S.recentFixes.length > 2 && distance(S.recentFixes[0], fix) > 25) S.recentFixes.shift();
  if (distance(S.recentFixes[0], fix) > 8) S.heading = bearing(S.recentFixes[0], fix);

  if (S.capturing && S.chunk) {
    const prev = S.chunk.track[S.chunk.track.length - 1];
    if (prev && acc <= 35) S.meters += distance(prev, fix);
    S.chunk.track.push({ t: (now - S.chunk.t0) / 1000, lat, lng, acc, speed: gpsSpeed, heading: gpsHeading });
    S.trail?.eachLayer((l) => l.addLatLng([lat, lng]));
  }
  S.lastFix = fix;

  if (S.map) {
    if (!S.me) {
      S.me = L.marker([lat, lng], { icon: viewerIcon(S.heading), interactive: false, zIndexOffset: 1000 }).addTo(S.map);
      S.map.setView([lat, lng], 17);
    } else {
      S.me.setLatLng([lat, lng]);
      S.me.setIcon(viewerIcon(S.heading));
      S.map.panTo([lat, lng], { animate: false });
    }
  }
  maybeLoadCoverage(fix);
  renderStreetStatus(fix);
}

let lastCoverageLoad = null;
function maybeLoadCoverage(fix) {
  if (lastCoverageLoad && distance(lastCoverageLoad, fix) < 300) return;
  lastCoverageLoad = fix;
  coverage.loadAround(fix.lat, fix.lng, 700).catch(() => {});
}

// Tells you whether the street you're on still needs the other direction.
function renderStreetStatus(fix) {
  if (S.heading == null) { el.streetStatus.hidden = true; return; }
  const idx = coverage.getIndex();
  const opts = { radius: 20, maxTurn: 45 };
  const otherWay = findView(idx, fix, (S.heading + 180) % 360, opts);
  let thisWay = findView(idx, fix, S.heading, opts);
  if (thisWay && S.capturing && thisWay.seg.session === S.session) thisWay = null; // your own last few minutes
  let state, text;
  if (thisWay && otherWay) { state = 'both'; text = 'Both directions captured here'; }
  else if (otherWay) { state = 'filling'; text = 'Filling in the other direction'; }
  else if (thisWay) { state = 'one'; text = 'Already captured this way. Ride it back the other way too.'; }
  else { state = 'new'; text = S.capturing ? 'New street. Capturing it now.' : 'New street'; }
  el.streetStatus.dataset.state = state;
  el.streetStatus.textContent = text;
  el.streetStatus.hidden = false;
}

// ---------- map ----------

function setupMap() {
  if (!S.map) {
    S.map = makeMap('driveMap', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false });
    S.map.setView([20, 0], 2);
    S.covLayer = L.layerGroup().addTo(S.map);
  }
  requestAnimationFrame(() => S.map.invalidateSize());
  drawMapCoverage(coverage.getIndex());
}

function drawMapCoverage(idx) {
  if (!S.map) return;
  drawCoverage(S.covLayer, coverageLines(idx), { arrows: true });
}

// ---------- capture ----------

function startCapture() {
  if (!S.stream) return;
  S.capturing = true;
  S.session = Math.random().toString(36).slice(2, 10);
  S.sessionT0 = performance.now();
  S.meters = 0; S.pieces = 0; S.skipped = 0;
  if (S.trail) S.trail.remove();
  S.trail = routeLine(S.lastFix ? [[S.lastFix.lat, S.lastFix.lng]] : []).addTo(S.map);
  S.trail.eachLayer((l) => l.getElement?.()?.classList.add('live-trail'));
  newChunk();
  S.tick = setInterval(onTick, 500);
  el.driveBtn.classList.add('is-recording');
  el.driveBtn.setAttribute('aria-label', 'Stop capturing');
  el.dTime.hidden = false;
  el.dDist.hidden = false;
  navigator.wakeLock?.request('screen').then((w) => (S.wakeLock = w)).catch(() => {});
  if (!S.lastFix || performance.now() - S.lastFix.at > 10000) toast('Waiting for GPS. Footage is kept, and the map fills in once GPS locks.');
}

function newChunk() {
  const mimeType = pickMime();
  const rec = new MediaRecorder(S.stream, { ...(mimeType && { mimeType }), videoBitsPerSecond: VIDEO_BPS });
  const chunk = { rec, parts: [], track: [], t0: performance.now(), startedAt: Date.now() };
  // Start the piece where you are, so pieces join up on the map.
  if (S.lastFix && performance.now() - S.lastFix.at < 10000) {
    chunk.track.push({ t: 0, lat: S.lastFix.lat, lng: S.lastFix.lng, acc: S.lastFix.acc });
  }
  rec.ondataavailable = (e) => e.data?.size && chunk.parts.push(e.data);
  rec.onstop = () => finishChunk(chunk);
  rec.start(1000);
  S.chunk = chunk;
}

function onTick() {
  const secs = (performance.now() - S.sessionT0) / 1000;
  el.dTime.textContent = formatClock(secs);
  el.dDist.textContent = formatDistance(S.meters);
  if (S.chunk && (performance.now() - S.chunk.t0) / 1000 >= CHUNK_SECONDS) {
    const old = S.chunk;
    newChunk();            // start the next piece first so there's no gap
    old.rec.stop();
  }
}

async function finishChunk(chunk) {
  const type = (chunk.rec.mimeType || chunk.parts[0]?.type || 'video/webm').split(';')[0];
  const blob = new Blob(chunk.parts, { type });
  chunk.parts = [];
  const pts = prepareTrack(chunk.track);
  const moved = pts.length >= 2 ? pts[pts.length - 1].d : 0;
  if (pts.length < 2 || moved < MIN_CHUNK_METERS || !blob.size) { S.skipped++; return; }
  S.pieces++;
  await queue.enqueue({
    blob,
    meta: {
      kind: 'capture', mode: S.mode, listed: S.listed, session: S.session,
      title: '', track: chunk.track.map((p) => [p.t, p.lat, p.lng, p.acc, p.speed ?? null, p.heading ?? null]),
    },
    createdAt: chunk.startedAt,
  });
}

function stopCapture() {
  if (!S.capturing) return;
  S.capturing = false;
  clearInterval(S.tick);
  const last = S.chunk;
  S.chunk = null;
  try { last?.rec.stop(); } catch { /* already stopped */ }
  el.driveBtn.classList.remove('is-recording');
  el.driveBtn.setAttribute('aria-label', 'Start capturing');
  el.dTime.hidden = true;
  el.dDist.hidden = true;
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
  const mins = (performance.now() - S.sessionT0) / 60000;
  el.driveSummary.innerHTML = `You captured <b>${esc(formatDistance(S.meters))}</b> of street in <b>${Math.max(1, Math.round(mins))} min</b>.
    Pieces still uploading keep going in the background while this site is open.`;
  if (location.hash.startsWith('#/drive')) { el.hud.hidden = true; el.done.hidden = false; }
}

function renderUpload(st) {
  if (!el.dUpload) return;
  let text, state;
  if (st.uploading) { text = `Uploading ${Math.round(st.progress * 100)}% · ${st.waiting} left`; state = 'fair'; }
  else if (st.waiting) { text = `${st.waiting} waiting to upload`; state = st.lastError ? 'bad' : 'fair'; }
  else if (st.uploaded) { text = `${st.uploaded} uploaded`; state = 'good'; }
  else { text = 'Nothing to upload yet'; state = 'wait'; }
  el.dUpload.textContent = text;
  el.dUpload.dataset.state = state;
  el.dUpload.title = st.lastError || '';
}
