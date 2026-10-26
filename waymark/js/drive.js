// Drive & capture: be the street-view car. The camera and GPS run nonstop;
// every CHUNK_SECONDS the recording is cut into a piece that's queued for
// upload while the next piece starts. Each piece is a video plus the GPS
// track on the same clock, which is all street view needs.

import { pickMime } from './record.js?v=202610260147';
import * as queue from './queue.js?v=202610260147';
import * as coverage from './coverage.js?v=202610260147';
import { findView } from './street.js?v=202610260147';
import { prepareTrack, distance, bearing, formatDistance, formatClock } from './geo.js?v=202610260147';
import { $, esc, makeMap, routeLine, viewerIcon, drawCoverage, toast } from './ui.js?v=202610260147';
import { coverageLines } from './street.js?v=202610260147';
import { planTrip } from './directions.js?v=202610260147';
import * as copilot from './copilot.js?v=202610260147';
import { searchPlaces } from './api.js?v=202610260147';
import { snapToTrack } from './geo.js?v=202610260147';
import { navLine, pinIcon, arrowGlyph, cueGlyph } from './ui.js?v=202610260147';

const CHUNK_SECONDS = (() => {
  try { return Number(localStorage.getItem('waymark.debug.chunkSeconds')) || 120; } catch { return 120; }
})();
const MIN_CHUNK_METERS = 10;      // skip short pieces where you barely moved; a short last piece is still real footage
const KEEP_STILL_SECONDS = 20;    // ...but keep longer waits (a red light): stopping and going again is training data
const VIDEO_BPS = 500_000;        // ~4 MB a minute; plenty for 480p at 15 fps

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
  stopCopilot();
  if (S.capturing) stopCapture(); // keep the footage: pieces are already queued
  stopCamera();
  stopGps();
  stopCompass();
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
  document.getElementById('lensPills').addEventListener('click', (e) => {
    const b = e.target.closest('.lens-pill');
    if (b && b.getAttribute('aria-pressed') !== 'true') switchCamera({ facing: 'environment', name: b.dataset.name });
  });
  document.getElementById('driveFlip').addEventListener('click', () => {
    const cur = currentCam();
    const front = cur ? lenses.front.includes(cur) : savedCam().facing === 'user';
    const last = savedCam().name || '0.5×'; // the back lens you had before flipping
    switchCamera(front ? { facing: 'environment', name: last } : { facing: 'user', name: last });
  });
  document.getElementById('missionBtn').addEventListener('click', newMission);
  wirePlaces();
  wireCopilot();
  for (const r of document.querySelectorAll('input[name="ridemode"]')) {
    r.addEventListener('change', () => {
      const mode = rideMode();
      document.getElementById('missionOpts').hidden = mode === 'free';
      document.getElementById('missionChoose').hidden = mode !== 'dest';
      document.getElementById('backRoadsPick').hidden = mode !== 'dest';
      if (mode === 'free') endMission();
    });
  }
  document.getElementById('missionEnd').addEventListener('click', () => endMission('Trip ended.'));
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
  // (Motion & orientation is asked on the record tap: iPhone handles one prompt per tap,
  // and asking for it here blocked the camera prompt.)
  try {
    S.stream = await Promise.race([openCamera(savedCam()),
      new Promise((_, no) => setTimeout(() => no(new Error('no answer from the camera after 15 s; close other apps using it and try again')), 15000))]);
  } catch (err) {
    el.driveStart.disabled = false;
    return showError(err?.name === 'NotAllowedError'
      ? 'Camera access is blocked. Allow the camera for this site in your browser settings, then try again.'
      : `The camera didn’t start (${err?.message || err}).`);
  }
  el.driveStart.disabled = false;
  el.dcam.srcObject = S.stream;
  el.dcam.play().catch(() => {});
  renderCamControls();
  el.intro.hidden = true;
  el.hud.hidden = false;
  setupMap();
}

// 640x480 at 15 fps (never over 24): far less battery than 720p30, still enough for street view and training.
const CAMERA = { facingMode: { ideal: 'environment' }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } };

// ---------- camera: lens picker + front/back flip ----------
// Lenses are separate cameras to the browser ("Back Ultra Wide Camera",
// "Back Camera", "Back Telephoto Camera" on iPhone). Names are only readable
// once camera access is granted. The choice is remembered on this phone.

const CAM_KEY = 'waymark.camera';
let lenses = { back: [], front: [] };

function savedCam() {
  try { return JSON.parse(localStorage.getItem(CAM_KEY)) || { facing: 'environment', name: '0.5×' }; } catch { return { facing: 'environment', name: '0.5×' }; }
}
function saveCam(c) { try { localStorage.setItem(CAM_KEY, JSON.stringify(c)); } catch { /* private mode */ } }

const gum = (video) => navigator.mediaDevices.getUserMedia({ video, audio: false });

async function listCams() {
  const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput' && d.deviceId);
  const isFront = (d) => /front|user|face/i.test(d.label);
  const back = cams.filter((d) => !isFront(d) && !/dual|triple/i.test(d.label)); // skip iPhone's combined virtual cameras
  const name = (d, i) => /ultra ?wide/i.test(d.label) ? '0.5×' : /tele/i.test(d.label) ? 'Tele' : i === 0 ? '1×' : `Lens ${i + 1}`;
  const plain = back.filter((d) => !/ultra ?wide|tele/i.test(d.label));
  const order = { '0.5×': 0, '1×': 1, Tele: 2 };
  lenses = {
    back: back.map((d) => ({ deviceId: d.deviceId, label: d.label, name: name(d, plain.indexOf(d) < 0 ? 0 : plain.indexOf(d)) }))
      .sort((x, y) => (order[x.name] ?? 9) - (order[y.name] ?? 9)),
    front: cams.filter(isFront).map((d) => ({ deviceId: d.deviceId, label: d.label, name: 'Front' })),
  };
}

// Opens the camera you asked for: front or back, and which back lens.
async function openCamera(want) {
  const facing = want.facing === 'user' ? 'user' : 'environment';
  let stream = await gum({ ...CAMERA, facingMode: { ideal: facing } });
  await listCams().catch(() => {});
  const pick = facing === 'user' ? lenses.front[0] : lenses.back.find((l) => l.name === want.name) || lenses.back.find((l) => l.name === '1×');
  const cur = stream.getVideoTracks()[0]?.getSettings().deviceId;
  if (pick && pick.deviceId !== cur) {
    stream.getTracks().forEach((t) => t.stop());
    try { stream = await gum({ ...CAMERA, facingMode: undefined, deviceId: { exact: pick.deviceId } }); }
    catch { stream = await gum({ ...CAMERA, facingMode: { ideal: facing } }); }
  }
  return stream;
}

function currentCam() {
  const id = S.stream?.getVideoTracks()[0]?.getSettings().deviceId;
  return [...lenses.back, ...lenses.front].find((l) => l.deviceId === id) || null;
}

function renderCamControls() {
  const box = document.getElementById('lensPills');
  const cur = currentCam();
  const front = cur ? lenses.front.includes(cur) : savedCam().facing === 'user';
  box.innerHTML = front ? '' : lenses.back.map((l) =>
    `<button type="button" class="lens-pill" aria-pressed="${l === cur}" data-name="${l.name}" title="${l.label.replace(/"/g, '')}">${l.name}</button>`).join('');
  box.hidden = front || lenses.back.length < 2;
  document.getElementById('driveFlip').hidden = false; // falls back to front/back by facing if lenses have no names
}

async function switchCamera(want) {
  if (S.switching) return;
  S.switching = true;
  saveCam(want);
  try {
    // While capturing, close the current piece and start a new one on the new camera.
    const old = S.capturing ? S.chunk : null;
    if (old) {
      S.chunk = null;
      await new Promise((r) => { old.rec.addEventListener('stop', r, { once: true }); old.rec.stop(); setTimeout(r, 2000); });
    }
    S.stream?.getTracks().forEach((t) => t.stop());
    S.stream = await openCamera(want);
    el.dcam.srcObject = S.stream;
    el.dcam.play().catch(() => {});
    if (S.capturing) newChunk();
    const cur = currentCam();
    toast(want.facing === 'user' ? 'Front camera. This films you, not the street.' : `${cur?.name || 'Back'} camera${cur?.label ? ` (${cur.label})` : ''}`);
  } catch (err) {
    showError(`That camera didn’t start (${err?.message || err}).`);
  } finally {
    S.switching = false;
    renderCamControls();
  }
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

// ---------- compass: where the camera points ----------
// Turning the handlebars at a stop to look for cross traffic points the camera
// sideways. The compass says where the phone points; comparing it with your
// direction of travel gives `look` (degrees, + = right), so street view can skip
// those frames and training can label them. The phone's mounting and the
// compass's own offset are learned while you ride straight.

const C = { heading: null, offsets: [] };
const wrap = (a) => ((a + 540) % 360) - 180;

function startCompass() {
  if (C.on || !('DeviceOrientationEvent' in window)) return;
  C.on = true;
  const listen = () => {
    window.addEventListener('deviceorientationabsolute', onOrient);
    window.addEventListener('deviceorientation', onOrient);
  };
  // iPhone asks first, and only from a tap (this runs inside the Start tap).
  if (typeof DeviceOrientationEvent.requestPermission === 'function') {
    DeviceOrientationEvent.requestPermission().then((r) => { if (r === 'granted') listen(); }).catch(() => {});
  } else listen();
}

function stopCompass() {
  window.removeEventListener('deviceorientationabsolute', onOrient);
  window.removeEventListener('deviceorientation', onOrient);
  C.on = false; C.heading = null;
}

function onOrient(e) {
  if (Number.isFinite(e.webkitCompassHeading)) C.heading = e.webkitCompassHeading; // iPhone
  else if (e.absolute && Number.isFinite(e.alpha)) C.heading = (360 - e.alpha) % 360; // Android
}

function lookAt(fix, gpsSpeed) {
  if (C.heading == null) return {};
  const compass = Math.round(C.heading);
  const moving = (gpsSpeed ?? 0) > 2 && S.heading != null;
  if (moving) {
    C.offsets.push(wrap(compass - S.heading));
    if (C.offsets.length > 60) C.offsets.shift();
  }
  if (C.offsets.length < 5 || S.heading == null) return { compass, look: null };
  // circular median-ish: average around the first offset
  const ref = C.offsets[0];
  const off = ref + C.offsets.reduce((a, o) => a + wrap(o - ref), 0) / C.offsets.length;
  return { compass, look: Math.round(wrap(compass - off - S.heading)) };
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

  if (S.odoFix && acc <= 35) S.odo = (S.odo || 0) + distance(S.odoFix, fix); // distance ridden, for the co-pilot's countdown
  if (acc <= 35) S.odoFix = fix;
  if (CP.on) checkLimit(fix);
  const lk = lookAt(fix, gpsSpeed);
  C.last = lk.look ?? null; // the co-pilot reads this between fixes
  S.gpsSpeed = gpsSpeed;
  if (gpsSpeed != null) S.speedHist = [...(S.speedHist || []).filter((q) => now - q.at < 6000), { at: now, v: gpsSpeed }];
  if (S.capturing && S.chunk) {
    const prev = S.chunk.track[S.chunk.track.length - 1];
    if (prev && acc <= 35) S.meters += distance(prev, fix);
    S.chunk.track.push({ t: (now - S.chunk.t0) / 1000, lat, lng, acc, speed: gpsSpeed, heading: gpsHeading, ...lk });
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
  missionFix(fix);
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
  startCompass(); // inside this tap, so iPhone can ask for motion & orientation
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
  const chunk = { rec, parts: [], track: [], nav: [], t0: performance.now(), startedAt: Date.now() };
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
  const secs = pts.length >= 2 ? pts[pts.length - 1].t - pts[0].t : 0;
  if (pts.length < 2 || (moved < MIN_CHUNK_METERS && secs < KEEP_STILL_SECONDS) || !blob.size) { S.skipped++; return; }
  S.pieces++;
  await queue.enqueue({
    blob,
    meta: {
      kind: 'capture', mode: S.mode, listed: S.listed, session: S.session,
      title: '', track: chunk.track.map((p) => (p.compass == null ? [p.t, p.lat, p.lng, p.acc, p.speed ?? null, p.heading ?? null]
        : [p.t, p.lat, p.lng, p.acc, p.speed ?? null, p.heading ?? null, p.compass, p.look])),
      nav: chunk.nav,
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

// ---------- trips: "drive to a random place near me" ----------
// Picks a destination within the chosen radius and gives normal turn-by-turn
// directions. While capturing, every GPS fix logs the road you're on and the
// instruction you were following; it's saved with the footage for training.

const M = { plan: null, layer: null, lastD: null, off: 0, rerouting: false };
const MI = 1609.344;

async function newMission() {
  const fix = S.lastFix;
  const btn = document.getElementById('missionBtn');
  if (!fix) { toast('Waiting for GPS before picking a destination.'); return; }
  const radius = Number(document.getElementById('missionRadius').value) * MI;
  btn.disabled = true;
  btn.textContent = 'Finding a place…';
  try {
    if (rideMode() === 'street') {
      if (await sameStreetMission(fix, radius)) return;
      toast('Couldn’t find a stretch of this street that far without turning. Try a shorter distance.');
      return;
    }
    let fallback = null;
    for (let tries = 0; tries < 6; tries++) {
      // Somewhere between 40% and 100% of the radius away: ahead of you
      // (within 90° of where you're going) when you're moving, so you don't
      // have to turn around; any direction before the first GPS heading.
      const dist = radius * (0.4 + 0.6 * Math.random());
      const deg = S.heading != null ? S.heading + (Math.random() * 2 - 1) * 90 : Math.random() * 360;
      const dest = {
        lat: fix.lat + (dist * Math.cos(deg * Math.PI / 180)) / 111320,
        lng: fix.lng + (dist * Math.sin(deg * Math.PI / 180)) / (111320 * Math.cos(fix.lat * Math.PI / 180)),
      };
      let trip;
      try { trip = await planTrip(S.mode, fix, dest, S.heading); } catch { continue; }
      const end = trip.latlngs[trip.latlngs.length - 1];
      // The router snaps to the nearest road; skip spots it can't reach sensibly.
      if (trip.distance < Math.min(150, radius * 0.3) || distance(fix, { lat: end[0], lng: end[1] }) > radius * 1.1 || trip.distance > radius * 3) continue;
      // Keep looking for a trip with no U-turns; settle for one if that's all there is.
      if (trip.steps.some((st) => st.maneuver?.modifier === 'uturn')) { fallback ??= trip; continue; }
      fallback = trip;
      break;
    }
    if (fallback) {
      if (backRoads()) { // same destination, quieter way there
        const end = fallback.latlngs[fallback.latlngs.length - 1];
        fallback = await planTrip(S.mode, fix, { lat: end[0], lng: end[1] }, S.heading, { backRoads: true }).catch(() => fallback);
      }
      startMission(fallback, radius);
      if (!S.capturing) toast('Destination set. Tap the red button to start capturing, then follow the directions.');
      return;
    }
    toast('Couldn’t find a reachable spot. Try again or pick a bigger distance.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Go';
  }
}

// ---------- co-pilot ----------
// The driving model watches the camera (on this phone) and says what it would
// do: its speed next to yours, and why it would slow down. It doesn't record
// anything or change what gets uploaded.

const CP = { on: false, voice: false, lastSaid: '', lastAt: 0, sign: null, light: null, secs: 0, signs: [], limit: null };
const MPH = 2.23694;
const BIKE_MAX_MPH = 20; // your bike's top speed: a 25 limit means ride about 20
const DEFAULT_LIMIT = 25; // Ohio, streets without a sign

// Speed limits from the signs read in your footage (ai/model/speed_signs.json):
// passing one in its direction sets the limit until the next sign (or 3 km).
function checkLimit(fix) {
  if (!CP.signs.length || S.heading == null) return;
  for (const s of CP.signs) {
    const turn = Math.abs(((S.heading - s.heading + 540) % 360) - 180);
    if (turn < 50 && distance(fix, s) < 40 && CP.limit?.mph !== s.mph) {
      CP.limit = { mph: s.mph, odo: S.odo || 0 };
      say(`Speed limit ${s.mph}`, false);
    }
  }
  if (CP.limit && (S.odo || 0) - CP.limit.odo > 3000) CP.limit = null;
}
const limitNow = () => CP.limit?.mph ?? DEFAULT_LIMIT;

function wireCopilot() {
  document.getElementById('copilotBtn').addEventListener('click', () => (CP.on ? stopCopilot() : startCopilot()));
  document.getElementById('copilotVoice').addEventListener('click', () => {
    CP.voice = !CP.voice;
    document.getElementById('copilotVoice').setAttribute('aria-pressed', String(CP.voice));
    if (CP.voice) say('Co-pilot voice on', true); // iPhone only speaks after a tap
  });
  // tap the card for the details (limit, slow-down odds, model speed); tap again to shrink it
  document.getElementById('copilot').addEventListener('click', (e) => {
    if (e.target.closest('#copilotVoice')) return;
    const box = e.currentTarget;
    if ('open' in box.dataset) delete box.dataset.open; else box.dataset.open = '';
  });
}

async function startCopilot() {
  CP.on = true;
  startCompass(); // inside the tap, so iPhone can ask for motion access
  const btn = document.getElementById('copilotBtn'), box = document.getElementById('copilot');
  btn.setAttribute('aria-pressed', 'true'); box.hidden = false;
  setCopilot({ alert: 'Getting ready…', detail: 'First time: downloads about 125 MB (once). Use Wi-Fi.' });
  try {
    await copilot.load((f) => CP.on && setCopilot({ alert: `Downloading ${Math.round(f * 100)}%`, detail: 'About 125 MB, only the first time.' }));
  } catch (err) {
    setCopilot({ alert: 'Co-pilot couldn’t start', detail: err.message || String(err) }); CP.on = false; return;
  }
  copilot.reset();
  fetch('ai/model/speed_signs.json').then((r) => r.json()).then((j) => { CP.signs = j.signs || []; }).catch(() => {});
  loopCopilot();
}

function stopCopilot() {
  CP.on = false;
  document.getElementById('copilotBtn')?.setAttribute('aria-pressed', 'false');
  const box = document.getElementById('copilot'); if (box) box.hidden = true;
  drawPath(null);
  try { speechSynthesis.cancel(); } catch { /* no speech */ }
}

// Horizontal field of view of the lens in use (for judging distance from a sign's size).
function hfov() {
  const name = currentCam()?.name || savedCam().name || '1×';
  const upright = (el.dcam?.videoHeight || 1) > (el.dcam?.videoWidth || 0);
  // [upright, sideways]; 1× calibrated from your rides (sign size vs where you stopped: ~46-53°)
  const base = { '0.5×': [90, 106], '1×': [50, 64], Tele: [15, 20] }[name] || [50, 64];
  return upright ? base[0] : base[1];
}

// Alternates: a full look (the model) and a zoomed look for signs far ahead.
async function loopCopilot() {
  // Cars are tracked several times a second (cheap); the detector finds new cars about once a
  // second; the full model look and the zoomed sign look take turns every couple of seconds.
  const T = copilot.makeTracker();
  let last = null, lastDet = 0, nextFull = 0, lastZoom = -1e9, pairStep = 0;
  const feed = (r, now) => { T.addDetections(r.dets, r.frame.g, r.frame.W, r.frame.H, now / 1000); track(r.frame, now); };
  const track = (fr, now) => {
    const cars = T.update(fr.g, now / 1000, S.gpsSpeed ?? 0, hfov(), fr.W, fr.H);
    CP.crossingAt = cars.some((c) => c.crossing) ? now : CP.crossingAt;
    CP.closingAt = cars.some((c) => c.closingIn) ? now : CP.closingAt;
    CP.movingAt = cars.some((c) => c.moving) ? now : CP.movingAt;
  };
  while (CP.on) {
    const t0 = performance.now(); let op = 'track';
    if (el.dcam?.videoWidth) {
      try {
        const key = CP.key = keyMoment(last);
        if (t0 >= nextFull) { op = 'look';
          last = await copilot.look(el.dcam, { look: C.last ?? null, nav: S.navNow || null, limit: limitNow(), map: mapAhead(), speed: S.gpsSpeed ?? 0 });
          drawPath(last.path, pathOpts(last));
          const done = performance.now();
          CP.secs = (done - t0) / 1000; lastDet = done; feed(last, done);
          // key moments: a look every second. Otherwise looks in pairs 1 s apart (so the model's
          // "1 s ago" input is real), then a 2 s pause.
          pairStep = key ? 0 : pairStep + 1;
          nextFull = t0 + (key || pairStep % 2 === 1 ? 1000 : 3000);
        } else if (t0 - lastZoom > (CP.sign || CP.cand ? 1500 : 2000) && nextFull - t0 > 400) { op = 'signs';
          const sg = await copilot.signs(el.dcam, hfov()); lastZoom = performance.now();
          // a stop sign counts once two zoomed looks in a row (within 3 s) see it with confidence;
          // one-off hits (red lights of cars, other red signs) are ignored
          if (sg.stop && sg.stop.score >= 0.6) {
            if (CP.cand && lastZoom - CP.cand.at < 3000) CP.sign = { dist: sg.stop.dist, odo: S.odo || 0, at: lastZoom };
            CP.cand = { at: lastZoom };
          }
          if (sg.light) CP.light = { ...sg.light, at: lastZoom };
        } else if (t0 - lastDet > 1000 && nextFull - t0 > 600) { op = 'detect';
          const r = await copilot.detectFrame(el.dcam); lastDet = performance.now(); feed(r, lastDet);
        } else {
          track(copilot.frameGray(el.dcam), t0);
        }
        if (CP.on && last) showCopilot(last, CP.secs || 1);
      } catch (err) { console.error('copilot', op, err, err?.stack); setCopilot({ alert: 'Co-pilot hit a problem', detail: err.message || String(err) }); }
    }
    await new Promise((r) => setTimeout(r, Math.max(30, 120 - (performance.now() - t0))));
  }
}

// The road's shape ahead from the directions' route line: its left offset at 5..40 m,
// measured from the route point next to you along the way the bike points (as in training).
function mapAhead() {
  const ahead = copilot.pathAhead(), pts = M.plan?.pts;
  if (!ahead || !pts?.length || M.lastD == null || S.heading == null) return null;
  const at = (d) => {
    const i = Math.max(1, pts.findIndex((p) => p.d >= d));
    if (pts[i]?.d == null || pts[i].d < d) return null;
    const a = pts[i - 1], b = pts[i], f = b.d > a.d ? (d - a.d) / (b.d - a.d) : 0;
    return { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
  };
  const p0 = at(M.lastD); if (!p0) return null;
  const h = S.heading * Math.PI / 180, kx = 111320 * Math.cos(p0.lat * Math.PI / 180);
  return ahead.mapd.map((d) => {
    const q = at(M.lastD + d);
    return q ? ((q.lng - p0.lng) * kx) * -Math.cos(h) + ((q.lat - p0.lat) * 111320) * Math.sin(h) : null;
  });
}

// Draws the driver's path on the camera view like Tesla's FSD (v13) screen: a solid glowing blue band
// (deeper blue where the AI wants to speed up), ending where it plans to stop, with a white stop line there.
// The phone sits on the handlebars ~1.1 m up, looking level: a point d m ahead is f·1.1/d below the middle.
// path: left offsets (m) at 5, 10, 15 m; opts: { stopAt (m) or null, faster (bool) }
function drawPath(path, opts = {}) {
  let cv = document.getElementById('cpPath');
  if (!path || !CP.on || !el.dcam?.videoWidth) { if (cv) cv.hidden = true; return; }
  if (!cv) { cv = document.createElement('canvas'); cv.id = 'cpPath'; cv.className = 'cp-path'; el.dcam.after(cv); }
  const ew = el.dcam.clientWidth, eh = el.dcam.clientHeight, vw = el.dcam.videoWidth, vh = el.dcam.videoHeight;
  cv.width = ew * devicePixelRatio; cv.height = eh * devicePixelRatio; cv.hidden = false;
  const g = cv.getContext('2d'); g.scale(devicePixelRatio, devicePixelRatio);
  const s = Math.max(ew / vw, eh / vh), ox = (ew - vw * s) / 2, oy = (eh - vh * s) / 2; // object-fit: cover
  const f = vw / 2 / Math.tan(hfov() * Math.PI / 360);
  const P = (d, y) => [ox + (vw / 2 - f * y / d) * s, oy + (vh / 2 + f * 1.1 / d) * s];
  // smooth centre line through (2 m, 0) and the model's points, sampled every half metre
  const ds = [2, ...copilot.pathAhead().dist], ys = [0, ...path];
  const yAt = (d) => {
    const i = Math.min(ds.length - 2, Math.max(0, ds.findIndex((x, k) => d <= ds[k + 1])));
    const u = (d - ds[i]) / (ds[i + 1] - ds[i]), y0 = ys[Math.max(0, i - 1)], y1 = ys[i], y2 = ys[i + 1], y3 = ys[Math.min(ys.length - 1, i + 2)];
    return 0.5 * (2 * y1 + (-y0 + y2) * u + (2 * y0 - 5 * y1 + 4 * y2 - y3) * u * u + (-y0 + 3 * y1 - 3 * y2 + y3) * u * u * u); // Catmull-Rom
  };
  const end = Math.max(3, Math.min(ds[ds.length - 1], opts.stopAt ?? Infinity));
  // FSD v13 style: a solid, saturated blue band with a lighter glowing core, crisp edges, fading
  // only at its tip (deeper blue when the AI wants to speed up)
  const band = (half, color, alphaNear) => {
    const L = [], R = [];
    for (let d = 2; d <= end + 1e-6; d += 0.5) { const y = yAt(d); L.push(P(d, y + half)); R.push(P(d, y - half)); }
    const near = P(2, 0)[1], far = P(end, yAt(end))[1];
    const grad = g.createLinearGradient(0, near, 0, far);
    grad.addColorStop(0, `rgba(${color}, ${alphaNear})`);
    grad.addColorStop(0.8, `rgba(${color}, ${alphaNear})`);
    grad.addColorStop(1, `rgba(${color}, 0)`);
    g.fillStyle = grad;
    g.beginPath(); [...L, ...R.reverse()].forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); g.fill();
  };
  g.shadowColor = 'rgba(40, 140, 255, 0.9)'; g.shadowBlur = 14;
  band(0.32, opts.faster ? '10, 105, 255' : '30, 128, 255', 0.95); // the band
  g.shadowBlur = 0;
  band(0.1, '150, 205, 255', 0.35);                                 // its lighter core
  if (opts.stopAt != null && opts.stopAt <= ds[ds.length - 1]) { // where it plans to stop: a white line across
    const y = yAt(end), a = P(end, y + 1.6), b = P(end, y - 1.6);
    g.strokeStyle = 'rgba(255, 255, 255, 0.92)'; g.lineWidth = Math.max(3, 0.25 * f * s / end); g.lineCap = 'round';
    g.beginPath(); g.moveTo(...a); g.lineTo(...b); g.stroke();
  }
}

// Where the path should end (a stop it plans) and whether the AI wants to go faster than you are.
function pathOpts(r) {
  const stopIn = stopAhead();
  const red = r.seen?.red || (CP.light && performance.now() - CP.light.at < 4000 && CP.light.red);
  const now = performance.now(), waitCar = now - (CP.crossingAt || -1e9) < 1500;
  const stopAt = stopIn != null ? Math.max(2.5, stopIn) : red || waitCar ? 4 : null;
  return { stopAt, faster: r.speed > (S.gpsSpeed ?? 0) + 1 };
}

// A key moment: something's happening, so the model looks every second (as the
// training uses 3 frames a second around these moments): a stop sign or light
// ahead, a car moving nearby, a turn coming up, or you slowing down / stopping /
// pulling away.
function keyMoment(r) {
  const now = performance.now();
  if (CP.sign || (CP.cand && now - CP.cand.at < 3000)) return true;
  if ((CP.light && now - CP.light.at < 4000) || r?.seen?.red || r?.seen?.green || r?.seen?.stop) return true;
  if (now - (CP.movingAt || -1e9) < 3000) return true;
  const nav = S.navNow;
  if (nav?.inM != null && nav.inM < 50 && /left|right|u-turn/i.test(nav.instruction || '')) return true;
  const sp = (S.speedHist || []).filter((q) => now - q.at < 5000).map((q) => q.v);
  if (sp.length >= 2) {
    const v = sp[sp.length - 1], hi = Math.max(...sp), lo = Math.min(...sp);
    if (hi > 2 && v < 0.7 * hi) return true;   // slowing down
    if (v < 0.6 && hi > 1.5) return true;      // just stopped
    if (lo < 0.6 && v > 1.0) return true;      // pulling away
  }
  return false;
}

// Distance left to the last stop sign seen: estimated from its size when seen,
// minus how far you've ridden since (GPS). Forgotten once passed or not seen again for 6 s.
function stopAhead() {
  const s = CP.sign;
  if (!s) return null;
  const left = s.dist - ((S.odo || 0) - s.odo);
  if (left < -5 || performance.now() - s.at > 6000) { CP.sign = null; return null; } // passed it, or not seen for 6 s
  return Math.max(0, left);
}

function showCopilot(r, secs) {
  const you = S.gpsSpeed != null ? `${Math.round(S.gpsSpeed * MPH)} mph` : '–';
  // turn calls only with directions: without them the model's turn guesses are no better than chance
  const turn = !S.navNow ? null : r.turn[0] > 0.5 ? 'left' : r.turn[2] > 0.5 ? 'right' : null;
  const stopIn = stopAhead();
  const redFar = CP.light && performance.now() - CP.light.at < 4000 && CP.light.red;
  const now = performance.now();
  r.seen.carCrossing = now - (CP.crossingAt || -1e9) < 1500; // from the tracker; hold the alert 1.5 s
  r.seen.carClosing = now - (CP.closingAt || -1e9) < 1500;
  const [alert, level] = r.seen.red || redFar ? ['Red light: stop', 'stop']
    : stopIn != null && stopIn < 10 ? ['Stop sign: stop', 'stop']
    : stopIn != null ? [`Stop sign in ${Math.round(stopIn * 3.281 / 5) * 5} ft`, 'slow']
    : r.seen.carCrossing ? ['Car crossing: wait', 'stop']
    : r.seen.carClosing ? ['Car ahead getting close: slow down', 'slow']
    : r.seen.stop ? ['Stop sign: slow down', 'slow']
    : r.slow >= 0.6 ? ['Slow down', 'slow']
    : turn ? [`Turn ${turn} coming`, 'info']
    : ['Clear', 'ok'];
  // never faster than the speed limit or what your bike can do
  const lim = limitNow(), aim = Math.min(lim, BIKE_MAX_MPH);
  const ai = Math.min(r.speed * MPH, aim);
  setCopilot({ alert, level, ai: `${Math.round(ai)} mph`, you, odds: `Limit ${lim}${CP.limit ? '' : '?'} · aim ${aim} · ${Math.round(r.slow * 100)}% slow-down`,
    detail: `Model look ${secs.toFixed(1)} s on ${copilot.backend().detector}${CP.key ? ' · focused' : ''}${r.seen.carAhead ? ' · car ahead' : ''}${r.seen.green ? ' · green light' : ''}` });
  if (level !== 'ok' && level !== 'info') say(alert.startsWith('Stop sign in') ? 'Stop sign ahead' : alert.split(':')[0]);
  else if (turn) say(`Turn ${turn}`);
}

function setCopilot({ alert, level = 'info', ai = '–', you = '–', odds = '', detail = '' }) {
  const box = document.getElementById('copilot');
  box.dataset.level = level;
  box.querySelector('.cp-alert').textContent = alert;
  box.querySelector('.cp-ai').textContent = ai;
  box.querySelector('.cp-you').textContent = you;
  box.querySelector('.cp-odds').textContent = odds;
  box.querySelector('.cp-detail').textContent = detail;
}

function say(text, force = false) {
  if (!CP.voice || !('speechSynthesis' in window)) return;
  const now = performance.now();
  if (!force && text === CP.lastSaid && now - CP.lastAt < 8000) return; // don't repeat the same call
  if (!force && now - CP.lastAt < 2500) return;
  CP.lastSaid = text; CP.lastAt = now;
  try { speechSynthesis.cancel(); speechSynthesis.speak(Object.assign(new SpeechSynthesisUtterance(text), { rate: 1.1 })); } catch { /* no speech */ }
}

// ---------- your own destinations ----------
// Search for a place (or pick one you used before) and get directions there.
// Back roads: prefer quiet streets (see directions.js). Neither is recorded as
// a model input; the training data only has the instructions you followed.

const PLACES_KEY = 'waymark.places', BACK_KEY = 'waymark.backRoads';
const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};
const backRoads = () => document.getElementById('backRoads').checked;

function wirePlaces() {
  const box = document.getElementById('backRoads');
  box.checked = store.get(BACK_KEY, false);
  box.addEventListener('change', () => store.set(BACK_KEY, box.checked));
  const sheet = document.getElementById('placeSheet'), q = document.getElementById('placeQuery');
  const results = document.getElementById('placeResults');
  document.getElementById('missionChoose').addEventListener('click', () => {
    sheet.hidden = false; results.hidden = true; q.value = ''; renderSaved(); q.focus();
  });
  document.getElementById('placeClose').addEventListener('click', () => { sheet.hidden = true; });
  let timer, token = 0, found = [];
  q.addEventListener('input', () => {
    clearTimeout(timer);
    const text = q.value.trim();
    if (text.length < 3) { results.hidden = true; return; }
    timer = setTimeout(async () => {
      const my = ++token;
      results.hidden = false;
      results.innerHTML = '<li class="meta">Searching…</li>';
      try {
        found = await searchPlaces(text, S.lastFix);
        if (my !== token) return;
        results.innerHTML = found.length ? found.map((r, i) => `<li><button type="button" class="place-go" data-i="${i}"><b>${esc(r.name)}</b><span>${esc(r.address)}</span></button></li>`).join('')
          : '<li class="meta">No places found. Try adding the street or town.</li>';
      } catch (err) {
        if (my === token) results.innerHTML = `<li class="meta">${esc(err.message)}</li>`;
      }
    }, 350);
  });
  results.addEventListener('click', (e) => {
    const b = e.target.closest('.place-go');
    if (b) goTo(found[Number(b.dataset.i)]);
  });
  document.getElementById('placeSaved').addEventListener('click', (e) => {
    const saved = store.get(PLACES_KEY, []);
    const x = e.target.closest('.place-x');
    if (x) { saved.splice(Number(x.dataset.i), 1); store.set(PLACES_KEY, saved); renderSaved(); return; }
    const b = e.target.closest('.place-go');
    if (b) goTo(saved[Number(b.dataset.i)]);
  });
}

function renderSaved() {
  const saved = store.get(PLACES_KEY, []);
  document.getElementById('placeSavedLabel').hidden = !saved.length;
  document.getElementById('placeSaved').innerHTML = saved.map((p, i) => `<li>
    <button type="button" class="place-go" data-i="${i}"><b>${esc(p.name)}</b><span>${esc(p.address || '')}</span></button>
    <button type="button" class="place-x" data-i="${i}" aria-label="Remove ${esc(p.name)}">×</button></li>`).join('');
}

async function goTo(place) {
  if (!place) return;
  const fix = S.lastFix;
  if (!fix) { toast('Waiting for GPS before getting directions.'); return; }
  const saved = store.get(PLACES_KEY, []).filter((p) => !(Math.abs(p.lat - place.lat) < 1e-5 && Math.abs(p.lng - place.lng) < 1e-5));
  store.set(PLACES_KEY, [{ name: place.name, address: place.address || '', lat: place.lat, lng: place.lng }, ...saved].slice(0, 12));
  document.getElementById('placeSheet').hidden = true;
  if (backRoads()) toast('Finding a way on back roads…');
  try {
    const trip = await planTrip(S.mode, fix, { lat: place.lat, lng: place.lng }, S.heading, { backRoads: backRoads() });
    startMission(trip, 0);
    const big = trip.bigRoadMeters;
    toast(`Directions to ${place.name}, ${formatDistance(trip.distance)}.` + (backRoads() && big != null
      ? (big < 50 ? ' All back roads.' : ` ${formatDistance(big)} on bigger roads; there’s no quieter way.`) : ''));
  } catch (err) {
    toast(err.message || 'Couldn’t get directions there.');
  }
}

// "This street only": a destination straight along the street you're on.
// Tries straight ahead first (or every direction if you're not moving yet)
// and keeps the first route that never leaves the starting street.
async function sameStreetMission(fix, radius) {
  const dirs = S.heading != null
    ? [S.heading, (S.heading + 180) % 360]
    : [0, 45, 90, 135, 180, 225, 270, 315];
  for (const deg of dirs) {
    for (const f of [1, 0.75, 0.5]) {
      const dist = radius * f;
      const dest = {
        lat: fix.lat + (dist * Math.cos(deg * Math.PI / 180)) / 111320,
        lng: fix.lng + (dist * Math.sin(deg * Math.PI / 180)) / (111320 * Math.cos(fix.lat * Math.PI / 180)),
      };
      let trip;
      try { trip = await planTrip(S.mode, fix, dest, deg); } catch { continue; }
      const road = trip.steps[0]?.name;
      const turns = trip.steps.slice(1).filter((s) => s.maneuver?.type !== 'arrive');
      const sameStreet = road && turns.every((s) => s.name === road && !/uturn|sharp/.test(s.maneuver?.modifier || ''));
      if (sameStreet && trip.distance >= Math.min(100, radius * 0.4) && trip.distance <= radius * 1.4) {
        startMission(trip, radius);
        toast(`Stay on ${road} for ${formatDistance(trip.distance)}.`);
        return true;
      }
    }
  }
  return false;
}

// During a trip the trip settings fold away behind "Trip options"
function tripBar(on) {
  const bar = document.getElementById('missionBar'), more = document.getElementById('missionMore');
  if (on) bar.dataset.trip = ''; else delete bar.dataset.trip;
  delete bar.dataset.open; more.setAttribute('aria-expanded', 'false');
  if (!more.onclick) more.onclick = () => {
    const open = !('open' in bar.dataset);
    if (open) bar.dataset.open = ''; else delete bar.dataset.open;
    more.setAttribute('aria-expanded', String(open));
  };
}

function startMission(trip, radius) {
  M.plan = trip;
  M.plan.pts = prepareTrack(trip.latlngs.map(([lat, lng], i) => [i, lat, lng, null]));
  M.radius = radius;
  M.lastD = null;
  M.off = 0;
  if (M.layer) M.layer.remove();
  M.layer = L.layerGroup([navLine(trip.latlngs), L.marker(trip.latlngs[trip.latlngs.length - 1], { icon: pinIcon('B', 'nav end') })]).addTo(S.map);
  S.map.setZoom(15);
  document.getElementById('missionEnd').hidden = false;
  tripBar(true);
  if (S.lastFix) missionFix(S.lastFix);
}

function endMission(message) {
  M.plan = null;
  S.navNow = null;
  if (M.layer) { M.layer.remove(); M.layer = null; }
  document.getElementById('missionSign').hidden = true;
  document.getElementById('missionEnd').hidden = true;
  tripBar(false);
  if (message) toast(message);
}

function setMissionSign(html) {
  const el = document.getElementById('missionSign');
  el.hidden = !html;
  if (html) el.innerHTML = `<div class="plate plate-green">${html}</div>`;
}

// The step you're on now (its road name is the road you're driving).
function current(plan, d) {
  let cur = plan.steps[0];
  for (const s of plan.steps) if (s.at <= d + 1) cur = s;
  return cur;
}

async function missionFix(fix) {
  const plan = M.plan;
  if (!plan) return;
  const snap = snapToTrack(plan.pts, fix, M.lastD);
  if (!snap || snap.off > 50) {
    setMissionSign('<span class="plate-text"><b>Off route</b><small>Finding a new way…</small></span>');
    logNav(fix, null, plan, null, null);
    if (++M.off >= 2 && !M.rerouting) {
      M.rerouting = true;
      try {
        const trip = await planTrip(S.mode, fix, plan.to, S.heading, { backRoads: backRoads() }); // keep going the way you are
        if (M.plan === plan) startMission(trip, M.radius);
      } catch { /* try again on the next fix */ }
      M.rerouting = false;
    }
    return;
  }
  M.off = 0;
  M.lastD = snap.d;
  const left = plan.distance - snap.d;
  const cur = current(plan, snap.d);
  if (left < 30) {
    logNav(fix, cur, plan, { title: 'Arrive', at: plan.distance }, snap.d);
    setMissionSign(`<span class="plate-glyph">${cueGlyph({ type: 'arrive' })}</span><span class="plate-text"><b>You’ve arrived</b><small>Pick a new destination to keep going</small></span>`);
    M.plan = null;
    document.getElementById('missionEnd').hidden = true;
    setTimeout(() => { if (!M.plan) endMission(); }, 8000);
    return;
  }
  const next = plan.steps.find((s) => s.maneuver?.type !== 'depart' && s.at > snap.d + 3);
  logNav(fix, cur, plan, next, snap.d);
  if (!next) return;
  const dist = next.at - snap.d;
  const glyph = next.angle === 'arrive' ? cueGlyph({ type: 'arrive' }) : arrowGlyph(next.angle);
  setMissionSign(`<span class="plate-glyph">${glyph}</span><span class="plate-text"><b>${esc(next.title)}</b>
    <small>${esc([dist < 20 ? 'Now' : `In ${formatDistance(dist)}`, next.name].filter(Boolean).join(' · '))} · ${esc(formatDistance(left))} to go</small></span>`);
}

function logNav(fix, cur, plan, next, d) {
  // what the directions say right now, in the same form as the training data (for the co-pilot)
  S.navNow = { instruction: next ? next.title + (next.name ? ` onto ${next.name}` : '') : (d === null ? 'Off route' : ''),
    inM: next && d !== null ? next.at - d : null, leftM: d !== null ? plan.distance - d : null };
  if (!S.capturing || !S.chunk) return;
  S.chunk.nav.push({
    t: (fix.at - S.chunk.t0) / 1000,
    road: cur?.name || '',
    next: next ? next.title + (next.name ? ` onto ${next.name}` : '') : (d === null ? 'Off route' : ''),
    nextIn: next && d !== null ? next.at - d : null,
    left: d !== null ? plan.distance - d : null,
  });
}

const rideMode = () => document.querySelector('input[name="ridemode"]:checked')?.value || 'free';
