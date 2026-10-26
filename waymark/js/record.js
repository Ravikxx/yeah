import { uploadRoute } from './api.js?v=202610262113';
import { $, esc, makeMap, routeLine, dotIcon, pinIcon, toast, cueGlyph } from './ui.js?v=202610262113';
import { prepareTrack, detectTurns, formatDistance, formatClock, formatDuration } from './geo.js?v=202610262113';

const MAX_SECONDS = 600; // 10 min at ~1.3 Mbps stays under the server's 95 MB cap
const MAX_BYTES = 90 * 1024 * 1024;
const MIME_CHOICES = ['video/mp4;codecs=avc1,mp4a.40.2', 'video/mp4', 'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];

const S = {
  stream: null, facing: 'environment', hasAudio: true,
  watchId: null, lastFix: null,
  recorder: null, chunks: [], bytes: 0, recording: false, t0: 0, tick: null,
  track: [], notes: [], noteAt: null, turnsSeen: 0,
  thumb: null, wakeLock: null,
  blob: null, blobUrl: null, // a finished recording waiting for review
  hudMap: null, trail: null, here: null, reviewMap: null,
};

const el = {};
let wired = false;

export function enterRecorder() {
  wire();
  if (S.blob) { showReview(); return leaveRecorder; }
  el.intro.hidden = false;
  el.hud.hidden = true;
  el.review.hidden = true;
  el.camError.hidden = true;
  return leaveRecorder;
}

function leaveRecorder() {
  if (S.recording) stopRecording({ discard: true });
  stopCamera();
  stopGps();
  releaseWakeLock();
}

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['recIntro', 'recHud', 'review', 'cam', 'camStart', 'camError', 'recBtn', 'noteBtn', 'flipBtn', 'recClose',
    'gpsChip', 'timeChip', 'distChip', 'noteSheet', 'noteForm', 'noteText', 'noteCancel', 'quickNotes', 'hudCue',
    'reviewVideo', 'reviewStats', 'reviewForm', 'uploadBtn', 'upProg', 'upError', 'saveLocal', 'discardBtn', 'visHint']) {
    el[id] = document.getElementById(id);
  }
  el.intro = el.recIntro; el.hud = el.recHud;

  el.camStart.addEventListener('click', start);
  el.recBtn.addEventListener('click', () => (S.recording ? stopRecording() : startRecording()));
  el.flipBtn.addEventListener('click', flip);
  el.recClose.addEventListener('click', closeRecorder);
  el.noteBtn.addEventListener('click', openNote);
  el.noteCancel.addEventListener('click', closeNote);
  el.quickNotes.addEventListener('click', (e) => {
    if (e.target.matches('button')) addNote(e.target.textContent.trim());
  });
  el.noteForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = el.noteText.value.trim();
    if (text) addNote(text);
  });
  el.reviewForm.addEventListener('submit', (e) => { e.preventDefault(); upload(); });
  el.reviewForm.addEventListener('change', (e) => {
    if (e.target.name === 'listed') {
      el.visHint.textContent = e.target.value === '1'
        ? 'Public routes appear on the map for everyone.'
        : 'Only people you send the link to can find this route.';
    }
  });
  el.discardBtn.addEventListener('click', confirmTwice(el.discardBtn, 'Tap again to discard', discard));
  addEventListener('beforeunload', (e) => {
    if (S.recording || S.blob) { e.preventDefault(); e.returnValue = ''; }
  });
}

// Two-tap confirmation, since the page can't rely on confirm() dialogs.
function confirmTwice(btn, prompt, action) {
  let armed = null;
  const original = btn.textContent;
  return () => {
    if (armed) { clearTimeout(armed); armed = null; btn.textContent = original; action(); return; }
    btn.textContent = prompt;
    armed = setTimeout(() => { armed = null; btn.textContent = original; }, 3000);
  };
}

async function start() {
  el.camError.hidden = true;
  if (!window.isSecureContext) return showCamError('The camera only works over https. Open this site with an https:// address.');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    return showCamError('This browser can’t record video. Try a recent Chrome, Safari or Firefox.');
  }
  el.camStart.disabled = true;
  startGps(); // ask for location inside the tap, before the camera prompt (iPhone only prompts then)
  try {
    await startCamera();
  } catch (err) {
    el.camStart.disabled = false;
    return showCamError(cameraErrorText(err));
  }
  el.camStart.disabled = false;
  el.intro.hidden = true;
  el.hud.hidden = false;
  setupHudMap();
}

function showCamError(msg) {
  el.camError.textContent = msg;
  el.camError.hidden = false;
}

function cameraErrorText(err) {
  if (err?.name === 'NotAllowedError') return 'Camera access is blocked. Allow the camera for this site in your browser settings, then tap the button again.';
  if (err?.name === 'NotFoundError' || err?.name === 'OverconstrainedError') return 'No usable camera was found on this device.';
  if (err?.name === 'NotReadableError') return 'Another app is using the camera. Close it and try again.';
  return `The camera didn’t start (${err?.message || err}).`;
}

async function startCamera() {
  stopCamera();
  const video = { facingMode: { ideal: S.facing }, width: { ideal: 640 }, height: { ideal: 480 }, frameRate: { ideal: 15, max: 24 } };
  try {
    S.stream = await navigator.mediaDevices.getUserMedia({ video, audio: true });
    S.hasAudio = true;
  } catch (err) {
    if (err?.name !== 'NotAllowedError' && err?.name !== 'NotFoundError') throw err;
    // Microphone refused or missing: record silent video rather than nothing.
    S.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
    S.hasAudio = false;
    toast('Recording without sound. The microphone isn’t available.');
  }
  el.cam.srcObject = S.stream;
  el.cam.style.transform = S.facing === 'user' ? 'scaleX(-1)' : '';
  await el.cam.play().catch(() => {});
}

function stopCamera() {
  S.stream?.getTracks().forEach((t) => t.stop());
  S.stream = null;
  if (el.cam) el.cam.srcObject = null;
}

async function flip() {
  if (S.recording) return;
  S.facing = S.facing === 'environment' ? 'user' : 'environment';
  try { await startCamera(); } catch (err) { toast(cameraErrorText(err)); }
}

function startGps() {
  if (!navigator.geolocation) { setGps('bad', 'No GPS in this browser'); return; }
  stopGps();
  S.watchId = navigator.geolocation.watchPosition(onFix, (err) => {
    setGps('bad', err.code === 1 ? 'Location blocked' : 'GPS unavailable');
    if (err.code === 1) toast('Location is blocked. Allow it for this site so the route can be mapped.');
  }, { enableHighAccuracy: true, maximumAge: 0, timeout: 30000 });
}

function stopGps() {
  if (S.watchId != null) navigator.geolocation.clearWatch(S.watchId);
  S.watchId = null;
}

function setGps(state, text) {
  el.gpsChip.dataset.state = state;
  el.gpsChip.textContent = text;
}

function onFix(pos) {
  const { latitude: lat, longitude: lng, accuracy: acc } = pos.coords;
  const gpsSpeed = Number.isFinite(pos.coords.speed) ? pos.coords.speed : null;     // m/s, from the phone
  const gpsHeading = Number.isFinite(pos.coords.heading) ? pos.coords.heading : null; // degrees, from the phone
  S.lastFix = { lat, lng, acc, at: performance.now() };
  const state = acc <= 15 ? 'good' : acc <= 35 ? 'fair' : 'bad';
  setGps(state, `GPS ±${formatDistance(acc)}`);
  if (S.recording) {
    S.track.push({ t: (performance.now() - S.t0) / 1000, lat, lng, acc, speed: gpsSpeed, heading: gpsHeading });
    S.trail?.eachLayer((l) => l.addLatLng([lat, lng]));
  }
  if (S.hudMap) {
    if (!S.here) {
      S.here = L.marker([lat, lng], { icon: dotIcon(), interactive: false }).addTo(S.hudMap);
      S.hudMap.setView([lat, lng], 17);
    } else {
      S.here.setLatLng([lat, lng]);
      S.hudMap.panTo([lat, lng], { animate: false });
    }
  }
}

function setupHudMap() {
  if (!S.hudMap) {
    S.hudMap = makeMap('recMap', { zoomControl: false, dragging: false, scrollWheelZoom: false, doubleClickZoom: false, touchZoom: false, keyboard: false });
    S.hudMap.setView([20, 0], 2);
  }
  requestAnimationFrame(() => S.hudMap.invalidateSize());
}

export function pickMime() {
  return MIME_CHOICES.find((m) => MediaRecorder.isTypeSupported?.(m)) || '';
}

async function startRecording() {
  if (!S.stream) return;
  const mimeType = pickMime();
  try {
    S.recorder = new MediaRecorder(S.stream, {
      ...(mimeType && { mimeType }),
      videoBitsPerSecond: 500_000,
      ...(S.hasAudio && { audioBitsPerSecond: 64_000 }),
    });
  } catch (err) {
    toast(`Recording couldn’t start (${err.message}).`);
    return;
  }
  S.chunks = []; S.bytes = 0; S.track = []; S.notes = []; S.turnsSeen = 0; S.thumb = null;
  S.t0 = performance.now();
  // Seed the track with the current fix if it's fresh, so the route starts where you stand.
  if (S.lastFix && performance.now() - S.lastFix.at < 10000) {
    S.track.push({ t: 0, lat: S.lastFix.lat, lng: S.lastFix.lng, acc: S.lastFix.acc });
  } else {
    toast('Recording without a GPS fix yet. The map will fill in once GPS locks.');
  }
  if (S.trail) S.trail.remove();
  S.trail = routeLine(S.track.map((p) => [p.lat, p.lng])).addTo(S.hudMap);

  S.recorder.ondataavailable = (e) => {
    if (!e.data?.size) return;
    S.chunks.push(e.data);
    S.bytes += e.data.size;
    if (S.bytes > MAX_BYTES && S.recording) { toast('Reached the size limit, so recording stopped.'); stopRecording(); }
  };
  S.recorder.onstop = finishRecording;
  S.recorder.start(1000);
  S.recording = true;

  el.recBtn.classList.add('is-recording');
  el.recBtn.setAttribute('aria-label', 'Stop recording');
  el.noteBtn.disabled = false;
  el.flipBtn.disabled = true;
  el.timeChip.hidden = false;
  el.distChip.hidden = false;
  S.tick = setInterval(onTick, 250);
  setTimeout(captureThumb, 1500);
  requestWakeLock();
}

function onTick() {
  const secs = (performance.now() - S.t0) / 1000;
  el.timeChip.textContent = `${formatClock(secs)} / ${formatClock(MAX_SECONDS)}`;
  if (S.track.length >= 2) {
    const pts = prepareTrack(S.track);
    el.distChip.textContent = formatDistance(pts[pts.length - 1].d);
    // Every couple of seconds, call out newly detected turns so the recorder knows they were caught.
    if (Math.round(secs * 4) % 8 === 0) {
      const turns = detectTurns(pts);
      if (turns.length > S.turnsSeen) {
        const t = turns[turns.length - 1];
        flashCue(`<div class="plate plate-green"><span class="plate-glyph">${cueGlyph({ type: 'turn', angle: t.angle })}</span>
          <span class="plate-text"><b>${esc(t.text)}</b><small>Turn added to the route</small></span></div>`);
      }
      S.turnsSeen = turns.length;
    }
  }
  if (secs >= MAX_SECONDS) { toast('Reached 10 minutes, so recording stopped.'); stopRecording(); }
}

let cueTimer;
function flashCue(html) {
  el.hudCue.innerHTML = html;
  el.hudCue.hidden = false;
  clearTimeout(cueTimer);
  cueTimer = setTimeout(() => (el.hudCue.hidden = true), 2600);
}

function captureThumb() {
  const v = el.cam;
  if (!v.videoWidth) return;
  const w = 480, h = Math.round((v.videoHeight / v.videoWidth) * w);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(v, 0, 0, w, h);
  c.toBlob((b) => (S.thumb = b), 'image/jpeg', 0.72);
}

function openNote() {
  // Pin the note to the moment the button was tapped, not when typing finishes.
  S.noteAt = { t: (performance.now() - S.t0) / 1000, fix: S.lastFix };
  el.noteText.value = '';
  el.noteSheet.hidden = false;
}

function closeNote() {
  el.noteSheet.hidden = true;
  S.noteAt = null;
}

function addNote(text) {
  if (!S.recording || !S.noteAt) return closeNote();
  const { t, fix } = S.noteAt;
  S.notes.push({ t, text: text.slice(0, 280), lat: fix?.lat ?? null, lng: fix?.lng ?? null });
  closeNote();
  flashCue(`<div class="plate plate-amber"><span class="plate-text"><b>${esc(text)}</b></span></div>`);
}

function stopRecording({ discard = false } = {}) {
  if (!S.recording) return;
  S.recording = false;
  S.discardOnStop = discard;
  clearInterval(S.tick);
  closeNote();
  try { S.recorder.stop(); } catch { finishRecording(); }
  el.recBtn.classList.remove('is-recording');
  el.recBtn.setAttribute('aria-label', 'Start recording');
  el.noteBtn.disabled = true;
  el.flipBtn.disabled = false;
  el.timeChip.hidden = true;
  el.distChip.hidden = true;
  releaseWakeLock();
}

function finishRecording() {
  if (S.discardOnStop) { S.chunks = []; S.discardOnStop = false; return; }
  const type = (S.recorder?.mimeType || S.chunks[0]?.type || 'video/webm').split(';')[0];
  S.blob = new Blob(S.chunks, { type });
  S.chunks = [];
  S.recDuration = (performance.now() - S.t0) / 1000;
  stopCamera();
  stopGps();
  showReview();
}

const closeRecorder = (() => {
  let armed = null;
  return () => {
    if (!S.recording) { location.hash = '#/'; return; }
    if (armed) { clearTimeout(armed); armed = null; stopRecording({ discard: true }); location.hash = '#/'; return; }
    toast('Tap × again to stop and throw away this recording.');
    armed = setTimeout(() => (armed = null), 3000);
  };
})();

function showReview() {
  el.intro.hidden = true;
  el.hud.hidden = true;
  el.review.hidden = false;
  el.upError.hidden = true;
  el.upProg.hidden = true;
  el.uploadBtn.disabled = false;
  if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
  S.blobUrl = URL.createObjectURL(S.blob);
  el.reviewVideo.src = S.blobUrl;
  const ext = S.blob.type.includes('mp4') ? 'mp4' : 'webm';
  el.saveLocal.href = S.blobUrl;
  el.saveLocal.download = `waymark-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.${ext}`;

  const pts = prepareTrack(S.track);
  const turns = pts.length >= 2 ? detectTurns(pts) : [];
  const dist = pts.length ? pts[pts.length - 1].d : 0;
  const mb = (S.blob.size / 1048576).toFixed(1);
  el.reviewStats.textContent = [
    formatDuration(S.recDuration || 0),
    formatDistance(dist),
    `${turns.length} turn${turns.length === 1 ? '' : 's'} detected`,
    `${S.notes.length} note${S.notes.length === 1 ? '' : 's'}`,
    `${mb} MB`,
  ].join(' · ');

  if (!S.reviewMap) S.reviewMap = makeMap('reviewMap');
  const m = S.reviewMap;
  m.eachLayer((l) => { if (!(l instanceof L.TileLayer)) m.removeLayer(l); });
  requestAnimationFrame(() => {
    m.invalidateSize();
    if (pts.length >= 2) {
      const ll = pts.map((p) => [p.lat, p.lng]);
      routeLine(ll).addTo(m);
      L.marker(ll[0], { icon: pinIcon('A') }).addTo(m);
      L.marker(ll[ll.length - 1], { icon: pinIcon('B', 'end') }).addTo(m);
      m.fitBounds(ll, { padding: [30, 30], maxZoom: 18 });
    } else if (pts.length === 1) {
      m.setView([pts[0].lat, pts[0].lng], 17);
    } else {
      m.setView([20, 0], 2);
    }
  });
  if (pts.length < 2) {
    showUploadError('GPS didn’t record enough points to map this route, so it can’t be uploaded. You can still save the video to this device. Next time, wait for the GPS chip to turn green before you start.');
    el.uploadBtn.disabled = true;
  }
}

function showUploadError(msg) {
  el.upError.textContent = msg;
  el.upError.hidden = false;
}

async function upload() {
  const f = el.reviewForm;
  const title = $('#rTitle').value.trim();
  if (!title) { $('#rTitle').focus(); return; }
  el.upError.hidden = true;
  el.uploadBtn.disabled = true;
  el.upProg.hidden = false;
  const bar = el.upProg.querySelector('.bar span');
  const label = el.upProg.querySelector('p');
  const total = (S.blob.size / 1048576).toFixed(1);
  const setP = (p) => {
    bar.style.width = `${Math.round(p * 100)}%`;
    label.textContent = `Uploading video… ${Math.round(p * 100)}% of ${total} MB`;
  };
  setP(0);
  try {
    const id = await uploadRoute({
      meta: {
        title,
        from: $('#rFrom').value.trim(),
        to: $('#rTo').value.trim(),
        description: $('#rDesc').value.trim(),
        mode: f.elements.mode.value,
        listed: f.elements.listed.value === '1',
        track: S.track.map((p) => [p.t, p.lat, p.lng, p.acc, p.speed ?? null, p.heading ?? null]),
        notes: S.notes,
      },
      video: S.blob,
      thumb: S.thumb,
    }, setP);
    label.textContent = 'Uploaded.';
    clearRecording();
    f.reset();
    toast('Route uploaded.');
    location.hash = `#/r/${id}`;
  } catch (err) {
    el.uploadBtn.disabled = false;
    el.upProg.hidden = true;
    showUploadError(`${err.message} Your recording is still here, so you can try again.`);
  }
}

function discard() {
  clearRecording();
  location.hash = '#/';
}

function clearRecording() {
  if (S.blobUrl) URL.revokeObjectURL(S.blobUrl);
  el.reviewVideo.removeAttribute('src');
  el.reviewVideo.load();
  S.blob = null; S.blobUrl = null; S.track = []; S.notes = []; S.thumb = null;
}

async function requestWakeLock() {
  try { S.wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* optional */ }
}
function releaseWakeLock() {
  S.wakeLock?.release().catch(() => {});
  S.wakeLock = null;
}
