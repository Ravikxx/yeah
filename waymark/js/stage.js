// The full-screen footage viewer used by street view, trip preview and live
// navigation: the right moment of the right recording, a mini map with a view
// cone, a compass, and a slot for the direction sign.
//
// Two <video> players take turns: the next piece of footage loads in the
// hidden one while the current frame stays on screen, then they swap. So
// moving between 2-minute pieces never flashes black.

import { videoUrl } from './api.js?v=202610270002';
import { compass } from './directions.js?v=202610270002';
import { makeMap, viewerIcon, drawCoverage } from './ui.js?v=202610270002';
import { coverageLines } from './street.js?v=202610270002';
import * as coverage from './coverage.js?v=202610270002';

const el = {};
let wired = false;
let mini, covLayer, extraLayer, marker;
let players = [];        // [{ v, id }], players[0] is on screen
let token = 0;
const handlers = [];     // [event, fn] for the on-screen player only

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['stageVideo', 'stageLoading', 'stageEmpty', 'stageInfo', 'stageSign', 'stageNote', 'stageMini', 'compass', 'svControls', 'navControls', 'stageExit']) {
    el[id] = document.getElementById(id);
  }
  players = [{ v: el.stageVideo, id: null }, { v: document.getElementById('stageVideo2'), id: null }];
  for (const p of players) {
    p.v.addEventListener('error', () => {
      if (p !== players[0] || !p.id) return;
      el.stageLoading.hidden = true;
      showEmpty('<h3>This footage couldn’t be played</h3><p>The video may still be uploading, or this browser can’t play its format.</p>');
    });
    for (const ev of ['timeupdate', 'ended', 'seeked', 'play', 'pause']) {
      p.v.addEventListener(ev, (e) => { if (p === players[0]) handlers.forEach(([n, fn]) => n === ev && fn(e)); });
    }
  }
  coverage.onChange(() => mini && drawMini());
}

export function open(mode) {
  wire();
  el.svControls.hidden = mode !== 'street';
  el.navControls.hidden = mode === 'street';
  el.stageSign.hidden = true;
  el.stageNote.hidden = true;
  hideEmpty();
  if (!mini) {
    mini = makeMap('stageMini', { zoomControl: false, attributionControl: false });
    covLayer = L.layerGroup().addTo(mini);
    extraLayer = L.layerGroup().addTo(mini);
    mini.setView([20, 0], 2);
    mini.on('zoomend', drawMini);
  }
  extraLayer.clearLayers();
  requestAnimationFrame(() => mini.invalidateSize());
  drawMini();
  return { video: el.stageVideo, mini, extraLayer };
}

export function close() {
  token++;
  for (const p of players) { p.v.pause(); p.v.playbackRate = 1; }
}

function drawMini() {
  drawCoverage(covLayer, coverageLines(coverage.getIndex()), { arrows: mini.getZoom() >= 16 });
}

const once = (target, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { target.removeEventListener(ev, ok); reject(new Error('timeout')); }, ms);
  function ok() { clearTimeout(t); resolve(); }
  target.addEventListener(ev, ok, { once: true });
});

// Listen to the on-screen player, whichever of the two it is.
export function on(ev, fn) { wire(); handlers.push([ev, fn]); }

function load(p, seg) {
  if (p.id === seg.id) return;
  p.id = seg.id;
  p.v.src = videoUrl(seg.id);
  p.v.load();
}

// Starts fetching a piece in the hidden player, so showing it later is instant.
export function preload(seg) {
  wire();
  if (!seg || players[0].id === seg.id) return;
  load(players[1], seg);
}

function swap() {
  const [front, back] = players;
  back.v.classList.add('is-front');
  front.v.classList.remove('is-front');
  front.v.pause();
  players = [back, front];
}

// Shows recording `seg` at time t. Resolves false if a newer call superseded it.
export async function showFrame(seg, t, { play = false } = {}) {
  wire();
  const my = ++token;
  hideEmpty();
  // Same piece as on screen: just seek. Otherwise prepare the hidden player,
  // keeping the current frame up meanwhile, and swap when it's ready.
  const p = players[0].id === seg.id ? players[0] : players[1];
  const v = p.v;
  const blank = !players[0].id || players[0].v.readyState < 2;
  try {
    if (p.id !== seg.id || v.readyState < 1) {
      if (blank) el.stageLoading.hidden = false;
      load(p, seg);
      if (v.readyState < 1) await once(v, 'loadedmetadata');
      if (my !== token) return false;
    }
    if (Math.abs(v.currentTime - t) > 0.08 || v.readyState < 2) {
      if (!v.paused && !play) v.pause();
      v.currentTime = Math.max(0, t);
      await once(v, 'seeked', 20000);
      if (my !== token) return false;
    }
  } catch {
    if (my === token) { el.stageLoading.hidden = true; p.id = null; }
    return false;
  }
  if (p !== players[0]) swap();
  el.stageLoading.hidden = true;
  if (play) v.play().catch(() => {});
  else if (!v.paused) v.pause();
  return true;
}

export function setPosition(lat, lng, heading, { follow = true } = {}) {
  if (!mini) return;
  if (!marker) marker = L.marker([lat, lng], { icon: viewerIcon(heading), interactive: false, zIndexOffset: 1000 }).addTo(mini);
  else { marker.setLatLng([lat, lng]); marker.setIcon(viewerIcon(heading)); }
  if (follow) {
    if (mini.getZoom() < 15) mini.setView([lat, lng], 17, { animate: false });
    else if (!mini.getBounds().pad(-0.25).contains([lat, lng])) mini.panTo([lat, lng], { animate: false });
  }
  el.compass.style.setProperty('--rot', `${-(heading || 0)}deg`);
  el.compass.title = `Facing ${compass(heading || 0)}`;
}

export function setInfo(html) { el.stageInfo.innerHTML = html; }
export function setExit(href, label) { el.stageExit.href = href; el.stageExit.setAttribute('aria-label', label); el.stageExit.title = label; }

export function setSign(html) {
  el.stageSign.hidden = !html;
  if (html && el.stageSign.innerHTML !== html) el.stageSign.innerHTML = html;
}

export function setNote(html) {
  el.stageNote.hidden = !html;
  if (html && el.stageNote.innerHTML !== html) el.stageNote.innerHTML = html;
}

export function showEmpty(html) {
  el.stageEmpty.innerHTML = html;
  el.stageEmpty.hidden = false;
}

export function hideEmpty() {
  if (el.stageEmpty) el.stageEmpty.hidden = true;
}

// Forget the loaded recordings (e.g. they were deleted).
export function reset() {
  token++;
  for (const p of players) { p.id = null; p.v.removeAttribute('src'); p.v.load(); }
}

// The player currently on screen.
export const video = () => { wire(); return players[0].v; };
export const miniMap = () => mini;
