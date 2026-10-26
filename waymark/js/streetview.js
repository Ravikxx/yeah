// Street view: stand anywhere you've captured and look around, using your
// own footage. Forward and back step along the recording; Turn around jumps
// to the pass made in the other direction; Left and Right take a crossing
// street when it was captured going that way. Drive plays the footage and
// rolls on into the next piece.

import * as stage from './stage.js?v=202610261821';
import * as coverage from './coverage.js?v=202610261821';
import { findView, viewOptions, headingAt } from './street.js?v=202610261821';
import { atTime, atDistance } from './geo.js?v=202610261821';
import { compass } from './directions.js?v=202610261821';
import { mine } from './api.js?v=202610261821';
import { toast, esc } from './ui.js?v=202610261821';

let view = null;
let opts = null;
let driving = false;
let active = false;
let wired = false;
const el = {};

export function enterStreetView(lat, lng, heading) {
  wire();
  active = true;
  driving = false;
  view = null;
  stage.open('street');
  stage.setExit('#/', 'Back to the map');
  stage.setInfo('Finding footage…');
  stage.setPosition(lat, lng, heading ?? 0);
  renderControls(null);
  stage.miniMap().on('click', onMiniClick);
  addEventListener('keydown', onKey);
  start(lat, lng, heading);
  return leave;
}

async function start(lat, lng, heading) {
  try { await coverage.loadAround(lat, lng, 600); } catch { /* use what's loaded */ }
  if (!active) return;
  const idx = coverage.getIndex();
  const pos = { lat, lng };
  const v = (heading != null && findView(idx, pos, heading)) || findView(idx, pos, null, { radius: 40 });
  if (!v) {
    stage.reset(); // don't leave the last place's footage behind the message
    stage.setInfo('');
    stage.showEmpty(`<h3>No street view here yet</h3>
      <p>This street hasn’t been captured. Drive it with the camera on, once each way, and you’ll be able to look both directions here.</p>
      <div class="actions"><a class="btn btn-primary" href="#/drive">Drive &amp; capture</a><a class="btn btn-on-dark" href="#/">Back to the map</a></div>`);
    return;
  }
  go(v);
}

function leave() {
  active = false;
  driving = false;
  stage.close();
  stage.miniMap()?.off('click', onMiniClick);
  removeEventListener('keydown', onKey);
  if (view) coverage.memory.lastSpot = { lat: view.lat, lng: view.lng };
}

function wire() {
  if (wired) return;
  wired = true;
  el.controls = document.getElementById('svControls');
  el.controls.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-act]');
    if (b && !b.disabled) act(b.dataset.act);
  });
  stage.on('timeupdate', onDriveTime);
  stage.on('ended', () => active && driving && rollOn());
}

// The frame being loaded right now, so Drive can wait for it.
let framePending = Promise.resolve();

async function go(v, { play = false } = {}) {
  view = v;
  opts = viewOptions(coverage.getIndex(), v);
  renderControls(opts);
  stage.setPosition(v.lat, v.lng, v.heading);
  renderInfo();
  history.replaceState(null, '', `#/view/${v.lat.toFixed(6)},${v.lng.toFixed(6)},${Math.round(v.heading)}`);
  framePending = stage.showFrame(v.seg, v.t, { play: play || driving });
  await framePending;
}

function renderInfo() {
  const own = !!mine()[view.id];
  const when = view.seg.createdAt ? new Date(view.seg.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '';
  stage.setInfo(`<b>${own ? 'Your footage' : 'Shared footage'}</b><span>Facing ${esc(compass(view.heading))}${when ? ` · ${esc(when)}` : ''}</span>`);
}

function renderControls(o) {
  const set = (name, ok, why = '') => {
    const b = el.controls.querySelector(`[data-act="${name}"]`);
    b.disabled = !ok;
    b.title = ok ? b.dataset.label : why;
  };
  const has = !!view;
  set('ahead', has, 'Nothing captured ahead');
  set('back', has, 'Nothing captured behind');
  set('turn', !!o?.behind, 'Not captured going the other way yet. Ride this street back to fill it in.');
  set('drive', has);
  el.controls.querySelector('[data-act="left"]').hidden = !o?.left;
  el.controls.querySelector('[data-act="right"]').hidden = !o?.right;
  el.controls.querySelector('[data-act="drive"]').classList.toggle('is-on', driving);
  el.controls.querySelector('[data-act="drive"] .lbl').textContent = driving ? 'Pause' : 'Drive';
  const turnHint = el.controls.querySelector('.turn-hint');
  turnHint.hidden = !has || !!o?.behind;
}

// The next piece of footage that carries on from the end (or start) of this one.
function continuation(dir) {
  const pts = view.seg.pts;
  const p = atDistance(pts, dir > 0 ? pts[pts.length - 1].d : 0);
  return findView(coverage.getIndex(), p, view.heading, { radius: 30, maxTurn: 50, exclude: view.id });
}

function act(name) {
  if (!view) return;
  if (name !== 'drive' && driving) setDriving(false);
  switch (name) {
    case 'ahead': {
      const next = opts.ahead || continuation(1);
      return next ? go(next) : toast('That’s the end of the footage going this way.');
    }
    case 'back': {
      const prev = opts.back || continuation(-1);
      return prev ? go(prev) : toast('That’s where this footage starts.');
    }
    case 'turn':
      return opts.behind ? go(opts.behind) : toast('Not captured going the other way yet. Ride this street back to fill it in.');
    case 'left': return opts.left && go(opts.left);
    case 'right': return opts.right && go(opts.right);
    case 'drive': return setDriving(!driving);
  }
}

function setDriving(on) {
  driving = on;
  renderControls(opts);
  if (!on) { stage.video().pause(); return; }
  // If footage is still loading, playing now would be cut off when the frame
  // lands (it pauses on the chosen moment), so start once it's on screen.
  // Look the player up afterwards: the new frame may arrive in the other one.
  framePending.then(() => {
    if (!driving || !active) return;
    stage.video().play().catch((err) => {
      if (err.name === 'AbortError') return; // a newer frame took over; it plays if still driving
      driving = false;
      renderControls(opts);
    });
  });
}

let lastOpts = 0;
function onDriveTime() {
  if (!active || !driving || !view) return;
  const v = stage.video();
  const t = v.currentTime;
  const p = atTime(view.seg.pts, t);
  const heading = headingAt(view.seg.pts, p.d) ?? view.heading;
  view = { ...view, t, d: p.d, lat: p.lat, lng: p.lng, heading };
  stage.setPosition(p.lat, p.lng, heading);
  if (performance.now() - lastOpts > 1000) {
    lastOpts = performance.now();
    opts = viewOptions(coverage.getIndex(), view);
    renderControls(opts);
    renderInfo();
    history.replaceState(null, '', `#/view/${p.lat.toFixed(6)},${p.lng.toFixed(6)},${Math.round(heading)}`);
  }
  const end = view.seg.pts[view.seg.pts.length - 1].t;
  // A few seconds before this piece ends, start loading the one that follows.
  if (t >= end - 4 && preloadedFor !== view.id) { preloadedFor = view.id; stage.preload(continuation(1)?.seg); }
  if (t >= end - 0.15) rollOn();
}
let preloadedFor = null;

let rolling = false;
async function rollOn() {
  if (rolling) return; // 'ended' and the last timeupdate can both land here
  rolling = true;
  try {
    const next = continuation(1);
    if (next) await go(next, { play: true });
    else { setDriving(false); toast('That’s the end of the footage going this way.'); }
  } finally {
    rolling = false;
  }
}

function onMiniClick(e) {
  const idx = coverage.getIndex();
  const pos = { lat: e.latlng.lat, lng: e.latlng.lng };
  const v = findView(idx, pos, view?.heading ?? null, { radius: 40 }) || findView(idx, pos, null, { radius: 40 });
  if (v) { if (driving) setDriving(false); go(v); } else toast('No footage there yet.');
}

function onKey(e) {
  if (e.target.closest?.('input, textarea')) return;
  const map = { ArrowUp: 'ahead', ArrowDown: 'back', ArrowLeft: 'left', ArrowRight: 'right', u: 'turn', ' ': 'drive' };
  const name = map[e.key];
  if (!name) return;
  e.preventDefault();
  if ((name === 'left' && !opts?.left) || (name === 'right' && !opts?.right)) return;
  act(name);
}
