// The map app: full-screen map with captured streets drawn on it, a panel
// (bottom sheet on phones) with Explore / Directions / Routes / Mine, and the
// Drive & capture button.

import * as coverage from './coverage.js?v=202610252203';
import * as queue from './queue.js?v=202610252203';
import * as nav from './nav.js?v=202610252203';
import { showRoutes, wireNearMe, showFootage, renderQueueLine, wireExport } from './routes.js?v=202610252203';
import { coverageLines, coveredLength, findView } from './street.js?v=202610252203';
import { $, esc, makeMap, drawCoverage, dotIcon } from './ui.js?v=202610252203';
import { formatDistance } from './geo.js?v=202610252203';

const VIEW_KEY = 'waymark.view.v1';
let map, covLayer, navLayer, pinsLayer, meMarker;
let lines = [];
let wired = false;

function savedView() {
  try { return JSON.parse(localStorage.getItem(VIEW_KEY)); } catch { return null; }
}

function init() {
  wired = true;
  map = makeMap('map', { zoomControl: true });
  const v = savedView();
  if (v) map.setView(v.center, v.zoom); else map.setView([39.5, -98.35], 4);
  window.__waymark = { map }; // handle for automated tests
  covLayer = L.layerGroup().addTo(map);
  navLayer = L.layerGroup().addTo(map);
  pinsLayer = L.layerGroup().addTo(map);

  map.on('moveend', () => {
    try { localStorage.setItem(VIEW_KEY, JSON.stringify({ center: map.getCenter(), zoom: map.getZoom() })); } catch { /* fine */ }
    loadCoverage();
    renderStats();
  });
  map.on('zoomend', drawLines);
  map.on('click', onMapClick);
  coverage.onChange((idx) => { lines = coverageLines(idx); drawLines(); renderStats(); });

  nav.initDirections(map, navLayer);
  wireNearMe(map, pinsLayer);
  queue.onStatus(renderUpload);

  $('#locateBtn').addEventListener('click', locate);
  $('#sheetHandle').addEventListener('click', () => setSheet(!$('#panel').classList.contains('is-open')));
  if (!v) {
    navigator.permissions?.query({ name: 'geolocation' }).then((s) => s.state === 'granted' && locate()).catch(() => {});
  }
  loadCoverage();
}

export function showShell(tab) {
  if (!wired) init();
  requestAnimationFrame(() => map.invalidateSize());
  const spot = coverage.memory.lastSpot;
  if (spot) { map.setView([spot.lat, spot.lng], Math.max(map.getZoom(), 17)); coverage.memory.lastSpot = null; }
  document.title = { explore: 'Waymark', directions: 'Directions · Waymark', routes: 'Routes · Waymark', mine: 'Mine · Waymark' }[tab];
  document.querySelectorAll('[data-tab]').forEach((a) => {
    if (a.dataset.tab === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  for (const t of ['explore', 'directions', 'routes', 'mine']) $(`#pane-${t}`).hidden = t !== tab;
  if (tab !== 'explore') setSheet(true);
  if (tab === 'routes') showRoutes(map, pinsLayer); else pinsLayer.clearLayers();
  if (tab === 'mine') { wireExport(); showFootage(map); showRoutes(map, pinsLayer, { mineOnly: true }); renderQueueLine(queue.status); }
  coverage.refresh();
  loadCoverage();
  renderStats();
  return () => {};
}

function setSheet(open) {
  const panel = $('#panel');
  panel.classList.toggle('is-open', open);
  $('#sheetHandle').setAttribute('aria-expanded', String(open));
}

async function loadCoverage() {
  if (map.getZoom() < 11) { $('#mapHint').hidden = lines.length > 0; return; }
  try {
    const ok = await coverage.loadBox([map.getBounds().getWest(), map.getBounds().getSouth(), map.getBounds().getEast(), map.getBounds().getNorth()]);
    $('#mapHint').hidden = ok;
  } catch {
    $('#mapHint').hidden = true;
  }
}

function drawLines() {
  drawCoverage(covLayer, lines, {
    arrows: map.getZoom() >= 16,
    onPick: (latlng) => onMapClick({ latlng }),
  });
}

// How much street is captured in the current view, each stretch counted once.
function renderStats() {
  const b = map.getBounds();
  const len = coveredLength(lines, (lat, lng) => b.contains([lat, lng]));
  const el = $('#covStats');
  if (!len.any) {
    el.textContent = map.getZoom() < 11 ? 'Zoom in to see captured streets.' : 'No streets captured in this area yet.';
    return;
  }
  el.innerHTML = `In view: <b>${esc(formatDistance(len.any))}</b> of street captured, <b>${esc(formatDistance(len.both))}</b> of it both ways. Tap a colored street to look around.`;
}

function onMapClick(e) {
  if (nav.handleMapPick(e.latlng)) return;
  if (innerWidth < 760) setSheet(false);
  const v = findView(coverage.getIndex(), e.latlng, null, { radius: 30 });
  const html = `<div class="pop">
      <b>${v ? 'Street view here' : 'Dropped pin'}</b>
      <span class="meta">${e.latlng.lat.toFixed(5)}, ${e.latlng.lng.toFixed(5)}</span>
      <div class="pop-actions">
        ${v ? '<button type="button" class="btn btn-primary btn-sm" data-pop="view">Street view</button>' : ''}
        <button type="button" class="btn btn-nav btn-sm" data-pop="dir">Directions</button>
      </div>
      ${v ? '' : '<span class="meta">Not captured yet</span>'}
    </div>`;
  const pop = L.popup({ className: 'wm-popup', autoPanPaddingTopLeft: [20, 80] }).setLatLng(e.latlng).setContent(html).openOn(map);
  const root = pop.getElement();
  root.querySelector('[data-pop="dir"]').addEventListener('click', () => {
    map.closePopup();
    location.hash = '#/directions';
    nav.directionsTo(e.latlng);
  });
  root.querySelector('[data-pop="view"]')?.addEventListener('click', () => {
    location.hash = `#/view/${v.lat.toFixed(6)},${v.lng.toFixed(6)},${Math.round(v.heading)}`;
  });
}

function locate() {
  navigator.geolocation?.getCurrentPosition((pos) => {
    const ll = [pos.coords.latitude, pos.coords.longitude];
    if (meMarker) meMarker.setLatLng(ll);
    else meMarker = L.marker(ll, { icon: dotIcon(), interactive: false, zIndexOffset: 1000 }).addTo(map);
    map.setView(ll, Math.max(map.getZoom(), 16));
  }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

function renderUpload(st) {
  const pill = $('#uploadPill');
  renderQueueLine(st);
  if (!st.waiting && !st.uploading) { pill.hidden = !st.uploaded; pill.dataset.state = 'good'; pill.textContent = 'Uploaded'; return; }
  pill.hidden = false;
  pill.dataset.state = st.lastError ? 'bad' : 'fair';
  pill.textContent = st.uploading ? `Uploading ${st.waiting} · ${Math.round(st.progress * 100)}%` : `${st.waiting} to upload`;
  pill.title = st.lastError || '';
}
