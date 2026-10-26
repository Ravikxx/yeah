// Shared UI bits: direction-sign glyphs, escaping, toasts, map styling.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Maneuver arrow (rounded, like a car's turn card). `angle` is the turn in degrees (negative = left).
export function arrowGlyph(angle = 0, size = 48) {
  if (Math.abs(angle) >= 150) {
    const s = angle < 0 ? -1 : 1; // hook to the turning side
    const x = (v) => 24 + s * v;
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M${x(-8)} 43 V20 a8 8 0 0 1 ${s * 16} 0 V29" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
      <path d="M${x(1.5)} 28.5 L${x(14.5)} 28.5 L${x(8)} 38.5 Z" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  }
  const a = (angle * Math.PI) / 180;
  const ex = 24 + 12 * Math.sin(a), ey = 26 - 12 * Math.cos(a); // straight ahead: tip lands at y=5
  const hx = Math.sin(a), hy = -Math.cos(a); // head direction
  const px = -hy, py = hx; // perpendicular
  const tip = [ex + hx * 8.5, ey + hy * 8.5], l = [ex + px * 7.5, ey + py * 7.5], r = [ex - px * 7.5, ey - py * 7.5];
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
    <path d="M24 43 V26 L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="5.5" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L${l[0].toFixed(1)} ${l[1].toFixed(1)} L${r[0].toFixed(1)} ${r[1].toFixed(1)} Z" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
}

export function cueGlyph(cue, size = 48) {
  if (cue.type === 'turn') return arrowGlyph(cue.angle, size);
  if (cue.type === 'arrive') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M13 43 V7" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>
      <path d="M15 8 H36 L30.5 15.5 L36 23 H15 Z" fill="currentColor" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round"/></svg>`;
  }
  if (cue.type === 'note') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M24 4.5 L43.5 24 L24 43.5 L4.5 24 Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>
      <path d="M24 15 V27" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/><circle cx="24" cy="33.5" r="2.8" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
    <circle cx="24" cy="24" r="14" fill="none" stroke="currentColor" stroke-width="5"/><circle cx="24" cy="24" r="5" fill="currentColor"/></svg>`;
}

// Turn card contents: the maneuver arrow, the distance in big type, the street
// under it, then a quieter line. Goes inside a .plate (drive HUD, footage viewer).
export function turnSignHtml({ glyph = '', dist = '', road = '', sub = '' }) {
  return `${glyph ? `<span class="plate-glyph">${glyph}</span>` : ''}<span class="plate-text"><b>${esc(dist)}</b>`
    + `${road ? `<span class="plate-road">${esc(road)}</span>` : ''}${sub ? `<small>${esc(sub)}</small>` : ''}</span>`;
}

let toastTimer;
export function toast(msg, ms = 3200) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), ms);
}

export function makeMap(el, opts = {}) {
  const map = L.map(el, { zoomControl: false, attributionControl: true, ...opts });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    className: 'osm-tiles',
  }).addTo(map);
  if (opts.zoomControl !== false) L.control.zoom({ position: 'bottomright' }).addTo(map);
  // Directions draw in their own pane so they stay above captured-street lines.
  map.createPane('navPane').style.zIndex = 450;
  return map;
}

export function routeLine(latlngs) {
  return L.layerGroup([
    L.polyline(latlngs, { className: 'route-casing', weight: 10, lineCap: 'round', lineJoin: 'round' }),
    L.polyline(latlngs, { className: 'route-line', weight: 5, lineCap: 'round', lineJoin: 'round' }),
  ]);
}

export function pinIcon(label, cls = '') {
  return L.divIcon({ className: `pin ${cls}`, html: `<span><i class="pin-label">${esc(label)}</i></span>`, iconSize: [30, 38], iconAnchor: [15, 38] });
}

export function dotIcon(cls = '') {
  return L.divIcon({ className: `dot ${cls}`, html: '<span></span>', iconSize: [22, 22], iconAnchor: [11, 11] });
}

export const modeWord = { walk: 'walk', bike: 'ride', drive: 'drive' };

// ---- street coverage + navigation drawing ----

// Coverage lines from street.coverageLines(): green where a street was
// captured both ways, amber (with direction chevrons when zoomed in) where
// only one way so far. onPick(latlng) fires when a line is tapped.
export function drawCoverage(layer, lines, { arrows = false, onPick = null } = {}) {
  layer.clearLayers();
  for (const l of lines) {
    const casing = L.polyline(l.latlngs, { className: 'cov-casing', weight: 9, lineCap: 'round', lineJoin: 'round', interactive: !!onPick });
    const line = L.polyline(l.latlngs, { className: l.both ? 'cov-both' : 'cov-one', weight: 5, lineCap: 'round', lineJoin: 'round', interactive: !!onPick });
    if (onPick) {
      for (const p of [casing, line]) p.on('click', (e) => { L.DomEvent.stop(e); onPick(e.latlng); });
    }
    layer.addLayer(casing).addLayer(line);
  }
  if (!arrows) return;
  let n = 0;
  for (const l of lines) {
    if (l.both) continue;
    for (let i = 3; i < l.latlngs.length - 1 && n < 400; i += 6, n++) {
      const a = l.latlngs[i - 1], b = l.latlngs[i + 1];
      const deg = (Math.atan2((b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), b[0] - a[0]) * 180) / Math.PI;
      layer.addLayer(L.marker(l.latlngs[i], { icon: chevronIcon(deg), interactive: false, keyboard: false }));
    }
  }
}

export function chevronIcon(heading) {
  return L.divIcon({
    className: 'cov-chevron',
    html: `<svg viewBox="0 0 12 12" width="12" height="12" style="transform:rotate(${heading.toFixed(0)}deg)"><path d="M2 9 L6 3 L10 9" fill="none" stroke="currentColor" stroke-width="2.4"/></svg>`,
    iconSize: [12, 12], iconAnchor: [6, 6],
  });
}

export function navLine(latlngs) {
  return L.layerGroup([
    L.polyline(latlngs, { pane: 'navPane', className: 'nav-casing', weight: 11, lineCap: 'round', lineJoin: 'round', interactive: false }),
    L.polyline(latlngs, { pane: 'navPane', className: 'nav-line', weight: 6, lineCap: 'round', lineJoin: 'round', interactive: false }),
  ]);
}

// "You are here, looking this way": a dot with a view cone.
export function viewerIcon(heading = 0) {
  return L.divIcon({
    className: 'viewer-mark',
    html: `<svg viewBox="0 0 60 60" width="60" height="60" style="transform:rotate(${(heading || 0).toFixed(0)}deg)">
      <path d="M30 30 L14 4 A30 30 0 0 1 46 4 Z" class="cone"/>
      <circle cx="30" cy="30" r="8" class="dot"/></svg>`,
    iconSize: [60, 60], iconAnchor: [30, 30],
  });
}

// Padding for fitBounds that keeps content out from under the side panel
// (desktop) or the bottom sheet (phones).
export function fitPadding() {
  const panel = document.getElementById('panel');
  if (!panel || panel.offsetParent === null) return { padding: [40, 40] };
  const r = panel.getBoundingClientRect();
  return innerWidth < 760
    ? { paddingTopLeft: [30, 70], paddingBottomRight: [30, innerHeight - r.top + 30] }
    : { paddingTopLeft: [r.right + 30, 40], paddingBottomRight: [70, 40] };
}
