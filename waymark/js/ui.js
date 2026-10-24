// Shared UI bits: direction-sign glyphs, escaping, toasts, map styling.

export const $ = (sel, root = document) => root.querySelector(sel);

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Road-sign style arrow. `angle` is the turn in degrees (negative = left).
export function arrowGlyph(angle = 0, size = 48) {
  if (Math.abs(angle) >= 150) {
    const s = angle < 0 ? -1 : 1; // hook to the turning side
    const x = (v) => 24 + s * v;
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M${x(-8)} 44 V20 a8 8 0 0 1 ${s * 16} 0 V30" fill="none" stroke="currentColor" stroke-width="6" stroke-linecap="square"/>
      <path d="M${x(0)} 28 L${x(16)} 28 L${x(8)} 40 Z" fill="currentColor"/></svg>`;
  }
  const a = (angle * Math.PI) / 180;
  const ex = 24 + 12 * Math.sin(a), ey = 26 - 12 * Math.cos(a); // straight ahead: tip lands at y=5
  const hx = Math.sin(a), hy = -Math.cos(a); // head direction
  const px = -hy, py = hx; // perpendicular
  const tip = [ex + hx * 9, ey + hy * 9], l = [ex + px * 8, ey + py * 8], r = [ex - px * 8, ey - py * 8];
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
    <path d="M24 46 V26 L${ex.toFixed(1)} ${ey.toFixed(1)}" fill="none" stroke="currentColor" stroke-width="6" stroke-linejoin="miter"/>
    <path d="M${tip[0].toFixed(1)} ${tip[1].toFixed(1)} L${l[0].toFixed(1)} ${l[1].toFixed(1)} L${r[0].toFixed(1)} ${r[1].toFixed(1)} Z" fill="currentColor"/></svg>`;
}

export function cueGlyph(cue, size = 48) {
  if (cue.type === 'turn') return arrowGlyph(cue.angle, size);
  if (cue.type === 'arrive') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M12 44 V6" stroke="currentColor" stroke-width="5"/>
      <path d="M14 7 H38 L32 15 L38 23 H14 Z" fill="currentColor"/></svg>`;
  }
  if (cue.type === 'note') {
    return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
      <path d="M24 3 L45 24 L24 45 L3 24 Z" fill="none" stroke="currentColor" stroke-width="4.5"/>
      <path d="M24 13 V28" stroke="currentColor" stroke-width="5"/><circle cx="24" cy="34.5" r="3" fill="currentColor"/></svg>`;
  }
  return `<svg viewBox="0 0 48 48" width="${size}" height="${size}" aria-hidden="true" class="glyph">
    <circle cx="24" cy="24" r="15" fill="none" stroke="currentColor" stroke-width="6"/><circle cx="24" cy="24" r="5" fill="currentColor"/></svg>`;
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
