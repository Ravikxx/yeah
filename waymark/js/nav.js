// Navigation: directions from the router (the only outside service), drawn
// on the map and matched against your footage so you can preview the trip in
// street view, or drive it live with the matching view and turn signs.

import { planTrip } from './directions.js?v=202610260143';
import { searchPlaces } from './api.js?v=202610260143';
import * as coverage from './coverage.js?v=202610260143';
import * as stage from './stage.js?v=202610260143';
import { matchPlan, findView, headingAt } from './street.js?v=202610260143';
import { prepareTrack, atDistance, snapToTrack, distance, bearing, formatDistance, formatDuration } from './geo.js?v=202610260143';
import { $, esc, toast, navLine, pinIcon, arrowGlyph, cueGlyph, fitPadding } from './ui.js?v=202610260143';

let map, layer;
let plan = null;          // current trip
let from = null;          // null = your location
let to = null;
let picking = null;       // 'from' | 'to' while waiting for a map tap
let lastFix = null;
const el = {};

// ---------- directions panel ----------

export function initDirections(mainMap, navLayer) {
  map = mainMap;
  layer = navLayer;
  for (const id of ['dirFrom', 'dirTo', 'dirMe', 'dirForm', 'dirResult', 'dirSwap']) el[id] = document.getElementById(id);
  el.dirFrom.addEventListener('click', () => startPick('from'));
  el.dirTo.addEventListener('click', () => startPick('to'));
  el.dirMe.addEventListener('click', () => { from = null; names.from = null; renderFields(); compute(); });
  el.dirSwap.addEventListener('click', async () => {
    const wasPin = !!from;
    const start = from || await myLocation().catch(() => null);
    if (!to || !start) return;
    [from, to] = [to, start];
    [names.from, names.to] = [names.to, wasPin ? names.from : 'Your location'];
    renderFields();
    compute();
  });
  el.dirForm.addEventListener('change', () => compute());
  wireSearch();
  coverage.onChange(() => {
    if (!plan) return;
    plan.match = matchPlan(coverage.getIndex(), plan.latlngs);
    renderResult();
  });
  renderFields();
}

// ---------- address search ----------

let searchTimer, searchToken = 0;
function wireSearch() {
  const input = document.getElementById('dirQuery');
  const list = document.getElementById('dirResults');
  input.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (q.length < 3) { list.hidden = true; return; }
    searchTimer = setTimeout(async () => {
      const my = ++searchToken;
      list.hidden = false;
      list.innerHTML = '<li class="meta">Searching…</li>';
      try {
        const results = await searchPlaces(q, map.getCenter());
        if (my !== searchToken) return;
        list.innerHTML = results.length ? results.map((r, i) => `
          <li><div><b>${esc(r.name)}</b><span class="meta">${esc(r.address)}</span></div>
            <div class="result-actions">
              <button type="button" class="btn btn-nav btn-sm" data-i="${i}" data-as="to">Go here</button>
              <button type="button" class="btn btn-ghost btn-sm" data-i="${i}" data-as="from">Start here</button>
            </div></li>`).join('') : '<li class="meta">No places found. Try adding a city.</li>';
        list.onclick = (e) => {
          const b = e.target.closest('button[data-i]');
          if (!b) return;
          const r = results[Number(b.dataset.i)];
          const p = { lat: r.lat, lng: r.lng };
          if (b.dataset.as === 'from') from = p; else to = p;
          names[b.dataset.as] = r.name;
          picking = null;
          list.hidden = true;
          input.value = '';
          renderFields();
          if (to) compute(); else map.setView([p.lat, p.lng], 17);
        };
      } catch (err) {
        if (my === searchToken) list.innerHTML = `<li class="form-error">${esc(err.message)}</li>`;
      }
    }, 350);
  });
}
const names = { from: null, to: null };

function startPick(which) {
  picking = which;
  renderFields();
  toast(which === 'from' ? 'Tap the map to choose where you start.' : 'Tap the map to choose where you’re going.');
}

// The shell offers every map tap here first while a pick is pending.
export function handleMapPick(latlng) {
  if (!picking) return false;
  const p = { lat: latlng.lat, lng: latlng.lng };
  if (picking === 'from') from = p; else to = p;
  names[picking] = null;
  picking = null;
  renderFields();
  compute();
  return true;
}

export function directionsTo(latlng) {
  to = { lat: latlng.lat, lng: latlng.lng };
  names.to = null;
  picking = null;
  renderFields();
  compute();
}

const fmtPoint = (p) => `${p.lat.toFixed(5)}, ${p.lng.toFixed(5)}`;

function renderFields() {
  el.dirFrom.textContent = picking === 'from' ? 'Tap the map…' : from ? (names.from || `Pin at ${fmtPoint(from)}`) : 'Your location';
  el.dirTo.textContent = picking === 'to' ? 'Tap the map…' : to ? (names.to || `Pin at ${fmtPoint(to)}`) : 'Search or tap the map to choose a destination';
  el.dirFrom.classList.toggle('is-picking', picking === 'from');
  el.dirTo.classList.toggle('is-picking', picking === 'to');
  el.dirTo.classList.toggle('is-empty', !to && picking !== 'to');
  el.dirMe.hidden = !from;
}

function myLocation() {
  if (lastFix && performance.now() - lastFix.at < 30000) return Promise.resolve(lastFix);
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('This browser can’t share your location.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve((lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, at: performance.now() })),
      (err) => reject(new Error(err.code === 1
        ? 'Location is blocked, so tap the A field and choose a start on the map.'
        : 'Couldn’t get your location. Tap the A field and choose a start on the map.')),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 15000 });
  });
}

let computeToken = 0;
async function compute() {
  if (!to) return;
  const my = ++computeToken;
  const mode = el.dirForm.elements.dirmode.value;
  el.dirResult.innerHTML = '<p class="meta">Finding a route…</p>';
  try {
    const start = from || await myLocation();
    const trip = await planTrip(mode, start, to);
    if (my !== computeToken) return;
    setPlan(trip);
  } catch (err) {
    if (my !== computeToken) return;
    el.dirResult.innerHTML = `<p class="form-error">${esc(err.message)}</p>`;
  }
}

function setPlan(trip) {
  plan = trip;
  plan.pts = prepareTrack(plan.latlngs.map(([lat, lng], i) => [i, lat, lng, null]));
  drawPlan();
  const lats = plan.latlngs.map((p) => p[0]), lngs = plan.latlngs.map((p) => p[1]);
  coverage.loadBox([Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)]).catch(() => {});
  plan.match = matchPlan(coverage.getIndex(), plan.latlngs);
  renderResult();
}

function drawPlan() {
  layer.clearLayers();
  if (!plan) return;
  navLine(plan.latlngs).addTo(layer);
  L.marker(plan.latlngs[0], { icon: pinIcon('A', 'nav') }).addTo(layer);
  L.marker(plan.latlngs[plan.latlngs.length - 1], { icon: pinIcon('B', 'nav end') }).addTo(layer);
  map.fitBounds(plan.latlngs, fitPadding());
}

function renderResult() {
  if (!plan) { el.dirResult.innerHTML = ''; return; }
  const pct = Math.round(plan.match.covered * 100);
  const covText = pct >= 98 ? 'All of this trip has street view from captured footage'
    : pct > 0 ? `${pct}% of this trip has street view from captured footage`
      : 'None of this trip has been captured yet. Drive it with Drive & capture to see it here.';
  el.dirResult.innerHTML = `
    <div class="trip">
      <div class="trip-head"><b>${esc(formatDuration(plan.duration))}</b><span>${esc(formatDistance(plan.distance))}</span></div>
      <div class="trip-cov"><div class="cov-bar"><span style="width:${pct}%"></span></div><p>${esc(covText)}</p></div>
      <div class="actions">
        <a class="btn btn-primary" href="#/nav/preview">${pct > 0 ? 'Preview in street view' : 'Preview'}</a>
        <a class="btn btn-nav" href="#/nav/live">Start</a>
      </div>
      <ol class="steps">${plan.steps.map((s) => `
        <li><span class="step-ico">${s.angle === 'arrive' ? cueGlyph({ type: 'arrive' }, 22) : arrowGlyph(s.angle, 22)}</span>
        <span>${esc(s.text)}</span></li>`).join('')}</ol>
    </div>`;
}

export const hasPlan = () => !!plan;
export const isPicking = () => !!picking;

// ---------- shared by preview and live ----------

function nextStep(d) {
  return plan.steps.find((s) => s.maneuver?.type !== 'depart' && s.at > d + 3) || null;
}

function signFor(d) {
  const s = nextStep(d);
  if (!s || plan.distance - d < 15) {
    return `<span class="plate-glyph">${cueGlyph({ type: 'arrive' })}</span><span class="plate-text"><b>You have arrived</b></span>`;
  }
  const dist = s.at - d;
  const glyph = s.angle === 'arrive' ? cueGlyph({ type: 'arrive' }) : arrowGlyph(s.angle);
  const sub = [dist < 20 ? 'Now' : `In ${formatDistance(dist)}`, s.name].filter(Boolean).join(' · ');
  return `<span class="plate-glyph">${glyph}</span><span class="plate-text"><b>${esc(s.title)}</b><small>${esc(sub)}</small></span>`;
}

function openNavStage(kind) {
  const { extraLayer } = stage.open('nav');
  stage.setExit('#/directions', 'Back to directions');
  navLine(plan.latlngs).addTo(extraLayer);
  for (const id of ['navPlay', 'navProg', 'navStatus', 'navSpeed', 'navEnd']) el[id] = document.getElementById(id);
  el.navPlay.hidden = kind !== 'preview';
  el.navSpeed.hidden = kind !== 'preview';
  el.navEnd.hidden = kind !== 'live';
  el.navEnd.onclick = () => { location.hash = '#/directions'; };
  return extraLayer;
}

function setProgress(d) {
  el.navProg.style.width = `${Math.min(100, (100 * d) / plan.distance).toFixed(1)}%`;
}

const NO_VIEW = '<h3>No street view on this stretch yet</h3><p>Capture it with Drive &amp; capture to fill it in.</p>';

// ---------- preview ----------

let P = null;

export function enterPreview() {
  if (!plan) { location.replace('#/directions'); return () => {}; }
  openNavStage('preview');
  P = { token: Symbol('preview'), i: 0, playing: true, rate: 2, done: false };
  el.navSpeed.querySelector('input[value="2"]').checked = true;
  el.navSpeed.onchange = (e) => { P.rate = Number(e.target.value); stage.video().playbackRate = P.rate; };
  el.navPlay.onclick = () => {
    if (P.done) { P.i = 0; P.done = false; P.playing = true; runPreview(P.token); }
    else P.playing = !P.playing;
    renderPlay();
  };
  renderPlay();
  const pct = Math.round(plan.match.covered * 100);
  stage.setInfo(`<b>Trip preview</b><span>${esc(formatDistance(plan.distance))} · ${pct}% captured</span>`);
  runPreview(P.token);
  return () => { P = null; stage.close(); };
}

function renderPlay() {
  el.navPlay.querySelector('.lbl').textContent = P.done ? 'Replay' : P.playing ? 'Pause' : 'Play';
  el.navPlay.classList.toggle('is-on', P.playing && !P.done);
}

const frame = () => new Promise((r) => requestAnimationFrame(r));
const alive = (tok) => P && P.token === tok;

function setD(d) {
  const p = atDistance(plan.pts, d);
  stage.setPosition(p.lat, p.lng, headingAt(plan.pts, d) ?? 0);
  stage.setSign(signFor(d));
  setProgress(d);
  el.navStatus.textContent = `${formatDistance(Math.max(0, plan.distance - d))} to go`;
}

async function runPreview(tok) {
  const runs = plan.match.runs;
  setD(0);
  for (let i = P.i; i < runs.length; i++) {
    if (!alive(tok)) return;
    P.i = i;
    const r = runs[i];
    if (r.id) {
      const shown = await stage.showFrame(r.seg, r.t0);
      stage.preload(runs.slice(i + 1).find((x) => x.id && x.id !== r.id)?.seg); // next piece, ready when needed
      if (!alive(tok)) return;
      const v = stage.video();
      v.playbackRate = P.rate;
      if (!shown || r.t1 - r.t0 < 0.6) { setD(r.d1); await hold(tok, 700); continue; }
      for (;;) {
        await frame();
        if (!alive(tok)) { v.pause(); return; }
        if (!P.playing) { if (!v.paused) v.pause(); continue; }
        if (v.paused && !v.ended) v.play().catch(() => {});
        const f = Math.max(0, Math.min(1, (v.currentTime - r.t0) / (r.t1 - r.t0)));
        setD(r.d0 + f * (r.d1 - r.d0));
        if (v.currentTime >= r.t1 || v.ended) break;
      }
      v.pause();
    } else {
      stage.showEmpty(NO_VIEW);
      const ms = Math.max(800, Math.min(2500, ((r.d1 - r.d0) / 40) * 1000));
      await hold(tok, ms, (f) => setD(r.d0 + f * (r.d1 - r.d0)));
      stage.hideEmpty();
    }
  }
  if (!alive(tok)) return;
  setD(plan.distance);
  P.done = true;
  renderPlay();
}

// Waits `ms` of playing time (paused time doesn't count), reporting progress 0..1.
async function hold(tok, ms, onProgress = () => {}) {
  let elapsed = 0, last = performance.now();
  while (elapsed < ms) {
    await frame();
    if (!alive(tok)) return;
    const now = performance.now();
    if (P.playing) elapsed += (now - last) * P.rate;
    last = now;
    onProgress(Math.min(1, elapsed / ms));
  }
}

// ---------- live navigation ----------

let N = null;

export function enterLive() {
  if (!plan) { location.replace('#/directions'); return () => {}; }
  openNavStage('live');
  stage.setInfo('<b>Navigating</b><span>Finding your location…</span>');
  N = { lastD: null, off: 0, lastReroute: 0, lastLoad: null, viewId: null, lock: null };
  N.watch = navigator.geolocation?.watchPosition(onLiveFix, (err) => {
    stage.setInfo(`<b>Navigating</b><span>${err.code === 1 ? 'Location is blocked for this site' : 'Waiting for GPS…'}</span>`);
  }, { enableHighAccuracy: true, maximumAge: 1000, timeout: 30000 });
  navigator.wakeLock?.request('screen').then((w) => (N ? (N.lock = w) : w.release())).catch(() => {});
  return () => {
    if (N?.watch != null) navigator.geolocation.clearWatch(N.watch);
    N?.lock?.release().catch(() => {});
    N = null;
    stage.close();
  };
}

async function onLiveFix(pos) {
  if (!N) return;
  const me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
  lastFix = { ...me, at: performance.now() };
  // Direction of travel from the last ~10 m, so a new route doesn't start with a U-turn.
  if (!N.from) N.from = me;
  else if (distance(N.from, me) > 10) { N.heading = bearing(N.from, me); N.from = me; }
  if (!N.lastLoad || distance(N.lastLoad, me) > 300) {
    N.lastLoad = me;
    coverage.loadAround(me.lat, me.lng, 700).catch(() => {});
  }
  const snap = snapToTrack(plan.pts, me, N.lastD);
  if (!snap || snap.off > 50) {
    N.off++;
    stage.setPosition(me.lat, me.lng, 0);
    stage.setSign(`<span class="plate-text"><b>Off route</b><small>${snap ? `${esc(formatDistance(snap.off))} from the route` : ''}</small></span>`);
    if (N.off >= 2 && performance.now() - N.lastReroute > 15000) {
      N.lastReroute = performance.now();
      try {
        const trip = await planTrip(plan.mode, me, plan.to, N.heading ?? null);
        if (!N) return;
        setPlan(trip);
        stage.miniMap() && openNavStage('live');
        N.lastD = null;
        toast('Found a new route.');
      } catch { /* keep trying on later fixes */ }
    }
    return;
  }
  N.off = 0;
  N.lastD = snap.d;
  const heading = headingAt(plan.pts, snap.d) ?? 0;
  stage.setPosition(me.lat, me.lng, heading);
  stage.setSign(signFor(snap.d));
  setProgress(snap.d);
  const left = plan.distance - snap.d;
  el.navStatus.textContent = left < 15 ? 'Arrived' : `${formatDistance(left)} to go`;
  stage.setInfo(`<b>Navigating</b><span>${esc(formatDistance(left))} left</span>`);

  // Show what this spot looks like going your way, from captured footage.
  const v = findView(coverage.getIndex(), snap, heading, { radius: 25, maxTurn: 50 });
  if (!v) { stage.showEmpty(NO_VIEW); N.viewId = null; return; }
  stage.hideEmpty();
  const vid = stage.video();
  if (N.viewId !== v.id || Math.abs(vid.currentTime - v.t) > 1.2) {
    N.viewId = v.id;
    stage.showFrame(v.seg, v.t);
  }
}
