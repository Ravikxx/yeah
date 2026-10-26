import { getRoute, getDirections, videoUrl, ownerToken, deleteRoute } from './api.js?v=202610261903';
import { $, esc, makeMap, routeLine, pinIcon, dotIcon, toast, cueGlyph, arrowGlyph, modeWord, turnSignHtml } from './ui.js?v=202610261903';
import { stepText, compass } from './directions.js?v=202610261903';
import { prepareTrack, buildCues, atTime, snapToTrack, distance, bearing, formatDistance, formatDuration, formatClock } from './geo.js?v=202610261903';

const GMAPS_MODE = { walk: 'walking', bike: 'bicycling', drive: 'driving' };
const OFF_ROUTE_M = 40;

let map, layers, playDot, meDot;
let wired = false;
let R = null; // current route state
const el = {};

export function showRoute(id) {
  wire();
  if (!map) {
    map = makeMap('rtMap');
    layers = L.layerGroup().addTo(map);
  }
  reset();
  load(id);
  return leaveRoute;
}

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['rtTitle', 'rtBadge', 'rtFromTo', 'rtMeta', 'rtDesc', 'rtVideo', 'sign', 'notePop', 'followBanner',
    'timeline', 'tlFill', 'tlTicks', 'speed', 'followBtn', 'toStartBtn', 'shareBtn', 'deleteBtn', 'toStart', 'cueList', 'videoWrap']) {
    el[id] = document.getElementById(id);
  }
  const v = el.rtVideo;
  v.addEventListener('loadedmetadata', fixDuration);
  for (const ev of ['timeupdate', 'seeked', 'loadeddata']) v.addEventListener(ev, () => R && sync());
  v.addEventListener('play', () => { if (R) { stopFollow(); loop(); } });
  v.addEventListener('error', () => R && toast('The video couldn’t be played in this browser.'));
  el.speed.addEventListener('change', (e) => (v.playbackRate = Number(e.target.value)));

  const seekFromEvent = (e) => {
    if (!R) return;
    const r = el.timeline.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
    seek(f * R.duration);
  };
  el.timeline.addEventListener('pointerdown', (e) => {
    el.timeline.setPointerCapture(e.pointerId);
    seekFromEvent(e);
    const move = (ev) => seekFromEvent(ev);
    el.timeline.addEventListener('pointermove', move);
    el.timeline.addEventListener('pointerup', () => el.timeline.removeEventListener('pointermove', move), { once: true });
  });
  el.timeline.addEventListener('keydown', (e) => {
    if (!R) return;
    if (e.key === 'ArrowRight') { seek(v.currentTime + 5); e.preventDefault(); }
    if (e.key === 'ArrowLeft') { seek(v.currentTime - 5); e.preventDefault(); }
  });
  el.cueList.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-t]');
    if (b && R) { seek(Math.max(0, Number(b.dataset.t) - 4)); v.play().catch(() => {}); }
  });
  el.followBtn.addEventListener('click', () => (R?.follow ? stopFollow() : startFollow()));
  el.toStartBtn.addEventListener('click', directionsToStart);
  el.shareBtn.addEventListener('click', share);
  el.deleteBtn.addEventListener('click', armDelete);
}

function reset() {
  stopFollow();
  R = null;
  const v = el.rtVideo;
  v.pause();
  v.removeAttribute('src');
  v.load();
  el.rtTitle.textContent = 'Loading route…';
  el.rtBadge.hidden = true;
  el.rtFromTo.innerHTML = '';
  el.rtMeta.textContent = '';
  el.rtDesc.hidden = true;
  el.sign.innerHTML = '';
  el.notePop.hidden = true;
  el.toStart.hidden = true;
  el.cueList.innerHTML = '';
  el.tlTicks.innerHTML = '';
  el.tlFill.style.width = '0';
  el.deleteBtn.hidden = true;
  el.deleteBtn.textContent = 'Delete';
  layers.clearLayers();
  playDot = meDot = null;
  el.speed.querySelector('input[value="1"]').checked = true;
  v.playbackRate = 1;
}

async function load(id) {
  let route;
  try {
    route = await getRoute(id);
  } catch (err) {
    el.rtTitle.textContent = 'Route not found';
    el.rtMeta.textContent = /not found/i.test(err.message) ? 'This route doesn’t exist, or its owner deleted it.' : err.message;
    return;
  }
  const pts = prepareTrack(route.track);
  const cues = buildCues(pts, route.notes, { to: route.to });
  const last = pts[pts.length - 1];
  R = { id, route, pts, cues, duration: last.t, lastD: null, follow: null, mode: route.mode || 'walk' };

  document.title = `${route.title} · Waymark`;
  el.rtTitle.textContent = route.title;
  el.rtBadge.hidden = route.listed;
  el.rtFromTo.innerHTML = [route.from && `<span><em>From</em>${esc(route.from)}</span>`, route.to && `<span><em>To</em>${esc(route.to)}</span>`]
    .filter(Boolean).join('');
  const turns = cues.filter((c) => c.type === 'turn').length;
  el.rtMeta.textContent = [
    formatDistance(last.d),
    `${formatDuration(route.duration)} ${modeWord[R.mode]}`,
    `${turns} turn${turns === 1 ? '' : 's'}`,
    new Date(route.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }),
  ].join(' · ');
  if (route.description) { el.rtDesc.textContent = route.description; el.rtDesc.hidden = false; }
  el.deleteBtn.hidden = !ownerToken(id);

  el.rtVideo.src = videoUrl(id);
  drawMap();
  drawCueList();
  drawTicks();
  sync();
}

// Chrome's MediaRecorder WebM files report an infinite duration until the
// browser is forced to scan to the end once.
function fixDuration() {
  const v = el.rtVideo;
  if (Number.isFinite(v.duration) && v.duration > 0) {
    if (R) { R.duration = v.duration; drawTicks(); }
    return;
  }
  const onDur = () => {
    if (!Number.isFinite(v.duration)) return;
    v.removeEventListener('durationchange', onDur);
    v.currentTime = 0;
    if (R) { R.duration = v.duration; drawTicks(); }
  };
  v.addEventListener('durationchange', onDur);
  v.currentTime = 1e101;
}

function drawMap() {
  const ll = R.pts.map((p) => [p.lat, p.lng]);
  const line = routeLine(ll).addTo(layers);
  line.eachLayer((l) => l.on('click', (e) => {
    const s = snapToTrack(R.pts, { lat: e.latlng.lat, lng: e.latlng.lng });
    if (s) seek(s.t);
  }));
  for (const c of R.cues) {
    if (c.type !== 'turn' && c.type !== 'note') continue;
    L.marker([c.lat, c.lng], {
      icon: L.divIcon({ className: `cue-dot ${c.type}`, html: '<span></span>', iconSize: [18, 18], iconAnchor: [9, 9] }),
      title: c.text,
    }).on('click', () => seek(Math.max(0, c.t - 4))).addTo(layers);
  }
  L.marker(ll[0], { icon: pinIcon('A'), title: 'Start' }).addTo(layers);
  L.marker(ll[ll.length - 1], { icon: pinIcon('B', 'end'), title: 'End' }).addTo(layers);
  playDot = L.marker(ll[0], { icon: dotIcon('here'), interactive: false, zIndexOffset: 900 }).addTo(layers);
  requestAnimationFrame(() => {
    map.invalidateSize();
    map.fitBounds(ll, { padding: [30, 30], maxZoom: 18 });
  });
}

function drawCueList() {
  el.cueList.innerHTML = R.cues.map((c, i) => `
    <li class="${c.type}" data-i="${i}">
      <button type="button" data-t="${c.t.toFixed(2)}">
        <span class="cue-ico">${cueGlyph(c, 28)}</span>
        <span class="cue-text">${esc(c.text)}</span>
        <span class="cue-at">${c.type === 'start' ? '0:00' : formatDistance(c.d)}</span>
      </button>
    </li>`).join('');
}

function drawTicks() {
  if (!R) return;
  el.tlTicks.innerHTML = R.cues
    .filter((c) => c.type === 'turn' || c.type === 'note')
    .map((c) => `<i class="${c.type}" style="left:${(100 * Math.min(1, c.t / R.duration)).toFixed(2)}%" title="${esc(c.text)}"></i>`)
    .join('');
}

function seek(t) {
  const v = el.rtVideo;
  v.currentTime = Math.max(0, Math.min(R.duration - 0.05, t));
}

let raf = null;
function loop() {
  cancelAnimationFrame(raf);
  const step = () => {
    if (!R || el.rtVideo.paused) return;
    sync();
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}

// Updates the sign, the dot, the timeline, and the cue list for the video's current moment.
function sync() {
  const t = el.rtVideo.currentTime || 0;
  const pos = atTime(R.pts, t);
  if (!pos) return;
  playDot?.setLatLng([pos.lat, pos.lng]);
  if (!R.follow && !el.rtVideo.paused && !map.getBounds().pad(-0.15).contains([pos.lat, pos.lng])) {
    map.panTo([pos.lat, pos.lng]);
  }
  const f = Math.min(1, t / R.duration);
  el.tlFill.style.width = `${(f * 100).toFixed(2)}%`;
  el.timeline.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  el.timeline.setAttribute('aria-valuetext', `${formatClock(t)} of ${formatClock(R.duration)}`);
  renderSign(pos);
  renderNote(t, pos);
  markCues(pos);
}

function renderSign(pos) {
  const ahead = R.cues.filter((c) => (c.type === 'turn' || c.type === 'arrive') && c.d > pos.d + 2);
  const next = ahead[0];
  let html;
  if (!next) {
    html = turnSignHtml({ glyph: cueGlyph({ type: 'arrive' }), dist: 'You have arrived', road: R.route.to || '' });
  } else if (pos.d < 8 && pos.t < R.pts[0].t + 3) {
    const probe = R.pts.find((p) => p.d > 25) || R.pts[R.pts.length - 1];
    const dir = compass(bearing(R.pts[0], probe));
    html = turnSignHtml({ glyph: arrowGlyph(0), dist: `Head ${dir}`,
      sub: next.type === 'arrive' ? `${formatDistance(next.d)} to go` : `Then ${next.text.toLowerCase()} in ${formatDistance(next.d)}` });
  } else {
    // big distance (or "Now"), then what happens there
    const dist = next.d - pos.d;
    const now = dist < 12;
    const what = next.type === 'arrive' ? (now ? next.text : R.route.to || 'Destination') : next.text;
    html = turnSignHtml({ glyph: cueGlyph(next), dist: now ? 'Now' : formatDistance(dist), road: what });
    el.sign.classList.toggle('is-now', now);
  }
  if (el.sign.innerHTML !== html) el.sign.innerHTML = html;
}

// A note shows from ~20 m before its spot until ~5 s after.
function renderNote(t, pos) {
  const note = R.cues.find((c) => c.type === 'note' && pos.d >= c.d - 20 && t <= c.t + 5);
  if (!note) { el.notePop.hidden = true; return; }
  const html = `<span class="plate-glyph">${cueGlyph(note, 40)}</span><span class="plate-text"><b>${esc(note.text)}</b></span>`;
  if (el.notePop.innerHTML !== html) el.notePop.innerHTML = html;
  el.notePop.hidden = false;
}

function markCues(pos) {
  let nextMarked = false;
  el.cueList.querySelectorAll('li').forEach((li) => {
    const c = R.cues[Number(li.dataset.i)];
    const past = c.d < pos.d - 3 && c.type !== 'arrive';
    li.classList.toggle('is-past', past);
    const isNext = !past && !nextMarked && c.type !== 'start';
    li.classList.toggle('is-next', isNext);
    if (isNext) nextMarked = true;
  });
}

// ---------- Follow live ----------

function startFollow() {
  if (!navigator.geolocation) return toast('This browser can’t share your location.');
  el.rtVideo.pause();
  el.followBtn.classList.add('is-on');
  el.followBtn.lastChild.textContent = ' Stop following';
  showBanner('Finding your location…');
  R.follow = { watch: navigator.geolocation.watchPosition(onFollowFix, (err) => {
    showBanner(err.code === 1 ? 'Location is blocked. Allow it for this site to follow the route.' : 'Can’t get your location right now.', true);
  }, { enableHighAccuracy: true, maximumAge: 2000, timeout: 30000 }) };
  navigator.wakeLock?.request('screen').then((w) => R?.follow && (R.follow.lock = w)).catch(() => {});
}

function stopFollow() {
  if (!R?.follow) return;
  navigator.geolocation.clearWatch(R.follow.watch);
  R.follow.lock?.release().catch(() => {});
  R.follow = null;
  el.followBtn.classList.remove('is-on');
  el.followBtn.lastChild.textContent = ' Follow live';
  el.followBanner.hidden = true;
  if (meDot) { meDot.remove(); meDot = null; }
}

function onFollowFix(pos) {
  if (!R?.follow) return;
  const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  if (meDot) meDot.setLatLng([me.lat, me.lng]);
  else meDot = L.marker([me.lat, me.lng], { icon: dotIcon(), interactive: false, zIndexOffset: 1000 }).addTo(layers);

  const snap = snapToTrack(R.pts, me, R.lastD);
  const total = R.pts[R.pts.length - 1].d;
  if (!snap || snap.off > OFF_ROUTE_M) {
    const toStart = distance(me, R.pts[0]);
    if (R.lastD == null && toStart > OFF_ROUTE_M) {
      showBanner(`You’re ${formatDistance(toStart)} from the start. Tap Directions to start to get there.`, true);
    } else {
      showBanner(`You’re ${formatDistance(snap.off)} off the route. Head back toward the blue line.`, true);
    }
    map.panTo([me.lat, me.lng]);
    return;
  }
  R.lastD = snap.d;
  // Show what this exact spot looked like on the recording.
  if (Math.abs(el.rtVideo.currentTime - snap.t) > 0.8) seek(snap.t);
  else sync();
  map.panTo([snap.lat, snap.lng]);
  const left = total - snap.d;
  if (left < 15) showBanner(`You’ve arrived${R.route.to ? ` at ${R.route.to}` : ''}.`, false, 1);
  else showBanner(`Following live · ${formatDistance(left)} to go`, false, snap.d / total);
}

function showBanner(text, off = false, progress = null) {
  el.followBanner.hidden = false;
  el.followBanner.classList.toggle('off', off);
  el.followBanner.innerHTML = `<span>${esc(text)}</span>${progress == null ? '' : `<span class="bar"><span style="width:${(progress * 100).toFixed(1)}%"></span></span>`}`;
}

// ---------- Directions to the start ----------

function directionsToStart() {
  if (!navigator.geolocation) return toast('This browser can’t share your location.');
  const btn = el.toStartBtn;
  btn.disabled = true;
  btn.textContent = 'Finding you…';
  navigator.geolocation.getCurrentPosition(async (pos) => {
    btn.disabled = false;
    btn.textContent = 'Directions to start';
    const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    const start = R.pts[0];
    const gmaps = `https://www.google.com/maps/dir/?api=1&origin=${me.lat},${me.lng}&destination=${start.lat},${start.lng}&travelmode=${GMAPS_MODE[R.mode]}`;
    const straight = distance(me, start);
    if (straight < 30) {
      el.toStart.innerHTML = `<h3>You’re at the start</h3><p class="meta">Press play to preview, or Follow live to go.</p>`;
      el.toStart.hidden = false;
      return;
    }
    if (meDot) meDot.setLatLng([me.lat, me.lng]);
    else meDot = L.marker([me.lat, me.lng], { icon: dotIcon(), interactive: false, zIndexOffset: 1000 }).addTo(layers);
    el.toStart.hidden = false;
    el.toStart.innerHTML = `<h3>Getting directions…</h3>`;
    try {
      const data = await getDirections(R.mode, me, start);
      if (data.code !== 'Ok' || !data.routes?.length) throw new Error('no route');
      const r = data.routes[0];
      const ll = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
      if (R.approach) R.approach.remove();
      R.approach = L.polyline(ll, { className: 'route-ghost', weight: 5 }).addTo(layers);
      map.fitBounds([...ll, ...R.pts.map((p) => [p.lat, p.lng])], { padding: [30, 30] });
      const steps = r.legs[0].steps.map((s) => stepText(s, { arriveText: 'Arrive at the start of the route' }));
      el.toStart.innerHTML = `
        <h3>${formatDistance(r.distance)} · ${formatDuration(r.duration)} to the start</h3>
        <ol>${steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
        <div class="actions">
          <a class="btn" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a>
          <button class="btn btn-primary" type="button" data-follow>Follow live when I get there</button>
        </div>`;
    } catch {
      el.toStart.innerHTML = `
        <h3>The start is ${formatDistance(straight)} away</h3>
        <p class="meta">Step-by-step directions aren’t available right now.</p>
        <div class="actions"><a class="btn" href="${gmaps}" target="_blank" rel="noopener">Open in Google Maps</a></div>`;
    }
    el.toStart.querySelector('[data-follow]')?.addEventListener('click', startFollow);
  }, (err) => {
    btn.disabled = false;
    btn.textContent = 'Directions to start';
    toast(err.code === 1 ? 'Location is blocked. Allow it for this site to get directions.' : 'Couldn’t get your location. Try again.');
  }, { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
}

// ---------- share / delete ----------

async function share() {
  const url = location.href;
  if (navigator.share) {
    try { await navigator.share({ title: R?.route.title || 'Waymark route', url }); return; } catch (e) { if (e.name === 'AbortError') return; }
  }
  try { await navigator.clipboard.writeText(url); toast('Link copied.'); } catch { toast(url, 8000); }
}

let deleteArmed = null;
async function armDelete() {
  if (!R) return;
  if (!deleteArmed) {
    el.deleteBtn.textContent = 'Tap again to delete for everyone';
    deleteArmed = setTimeout(() => { deleteArmed = null; el.deleteBtn.textContent = 'Delete'; }, 3500);
    return;
  }
  clearTimeout(deleteArmed);
  deleteArmed = null;
  el.deleteBtn.disabled = true;
  try {
    await deleteRoute(R.id);
    toast('Route deleted.');
    location.hash = '#/mine';
  } catch (err) {
    toast(err.message);
  } finally {
    el.deleteBtn.disabled = false;
    el.deleteBtn.textContent = 'Delete';
  }
}

function leaveRoute() {
  cancelAnimationFrame(raf);
  reset();
}
