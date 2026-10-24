// The full-screen footage viewer used by street view, trip preview and live
// navigation: one <video> showing the right moment of the right recording,
// a mini map with a view cone, a compass, and a slot for the direction sign.

import { videoUrl } from './api.js';
import { compass } from './directions.js';
import { makeMap, viewerIcon, drawCoverage } from './ui.js';
import { coverageLines } from './street.js';
import * as coverage from './coverage.js';

const el = {};
let wired = false;
let mini, covLayer, extraLayer, marker;
let currentId = null;
let token = 0;

function wire() {
  if (wired) return;
  wired = true;
  for (const id of ['stageVideo', 'stageLoading', 'stageEmpty', 'stageInfo', 'stageSign', 'stageNote', 'stageMini', 'compass', 'svControls', 'navControls', 'stageExit']) {
    el[id] = document.getElementById(id);
  }
  el.stageVideo.addEventListener('error', () => {
    if (!currentId) return;
    el.stageLoading.hidden = true;
    showEmpty('<h3>This footage couldn’t be played</h3><p>The video may still be uploading, or this browser can’t play its format.</p>');
  });
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
  const v = el.stageVideo;
  if (!v) return;
  v.pause();
  v.playbackRate = 1;
}

function drawMini() {
  drawCoverage(covLayer, coverageLines(coverage.getIndex()), { arrows: mini.getZoom() >= 16 });
}

const once = (target, ev, ms = 15000) => new Promise((resolve, reject) => {
  const t = setTimeout(() => { target.removeEventListener(ev, ok); reject(new Error('timeout')); }, ms);
  function ok() { clearTimeout(t); resolve(); }
  target.addEventListener(ev, ok, { once: true });
});

// Shows recording `seg` at time t. Resolves false if a newer call superseded it.
export async function showFrame(seg, t, { play = false } = {}) {
  const my = ++token;
  const v = el.stageVideo;
  hideEmpty();
  try {
    if (currentId !== seg.id) {
      el.stageLoading.hidden = false;
      currentId = seg.id;
      v.src = videoUrl(seg.id);
      await once(v, 'loadedmetadata');
      if (my !== token) return false;
    }
    if (Math.abs(v.currentTime - t) > 0.08) {
      if (!v.paused && !play) v.pause();
      v.currentTime = Math.max(0, t);
      await once(v, 'seeked', 20000);
      if (my !== token) return false;
    }
  } catch {
    if (my === token) { el.stageLoading.hidden = true; currentId = null; }
    return false;
  }
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

// Forget the loaded recording (e.g. it was deleted).
export function reset() {
  currentId = null;
  token++;
  if (el.stageVideo) { el.stageVideo.removeAttribute('src'); el.stageVideo.load(); }
}

export const video = () => el.stageVideo;
export const miniMap = () => mini;
