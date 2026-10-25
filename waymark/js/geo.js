// Geometry for recorded routes: distances, interpolation, turn detection,
// and snapping a live position onto a route.
//
// A track is an array of points {t, lat, lng, acc} where t is seconds since
// the recording started (the same clock as the video), plus a cumulative
// distance `d` in meters added by prepareTrack().

const EARTH = 6371000;
const RAD = Math.PI / 180;

export function distance(a, b) {
  const dLat = (b.lat - a.lat) * RAD;
  const dLng = (b.lng - a.lng) * RAD;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.min(1, Math.sqrt(h)));
}

// Compass bearing a -> b in degrees, 0 = north, clockwise.
export function bearing(a, b) {
  const y = Math.sin((b.lng - a.lng) * RAD) * Math.cos(b.lat * RAD);
  const x = Math.cos(a.lat * RAD) * Math.sin(b.lat * RAD) -
    Math.sin(a.lat * RAD) * Math.cos(b.lat * RAD) * Math.cos((b.lng - a.lng) * RAD);
  return (Math.atan2(y, x) / RAD + 360) % 360;
}

// Signed smallest difference to - from, in (-180, 180]. Positive = clockwise = right.
export function turnAngle(from, to) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// Server/wire format is [t, lat, lng, acc]; accept either shape.
export function prepareTrack(raw, maxAccuracy = 35) {
  let pts = raw.map((p) => (Array.isArray(p) ? { t: p[0], lat: p[1], lng: p[2], acc: p[3], look: p[7] ?? null } : { ...p }));
  pts.sort((a, b) => a.t - b.t);
  const good = pts.filter((p) => p.acc == null || p.acc <= maxAccuracy);
  if (good.length >= 2) pts = good;
  let d = 0;
  pts.forEach((p, i) => {
    if (i) d += distance(pts[i - 1], p);
    p.d = d;
  });
  return pts;
}

function lerp(a, b, f) { return a + (b - a) * f; }

function interpolate(pts, key, value) {
  if (!pts.length) return null;
  if (value <= pts[0][key]) return { ...pts[0] };
  const last = pts[pts.length - 1];
  if (value >= last[key]) return { ...last };
  let lo = 0, hi = pts.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (pts[mid][key] <= value) lo = mid; else hi = mid;
  }
  const a = pts[lo], b = pts[hi];
  const span = b[key] - a[key];
  const f = span > 0 ? (value - a[key]) / span : 0;
  return { t: lerp(a.t, b.t, f), d: lerp(a.d, b.d, f), lat: lerp(a.lat, b.lat, f), lng: lerp(a.lng, b.lng, f) };
}

export const atTime = (pts, t) => interpolate(pts, 't', t);
export const atDistance = (pts, d) => interpolate(pts, 'd', d);

function smooth(pts, window = 2) {
  return pts.map((p, i) => {
    let lat = 0, lng = 0, n = 0;
    for (let j = Math.max(0, i - window); j <= Math.min(pts.length - 1, i + window); j++) {
      lat += pts[j].lat; lng += pts[j].lng; n++;
    }
    return { ...p, lat: lat / n, lng: lng / n };
  });
}

function resample(pts, step) {
  const total = pts[pts.length - 1].d;
  const out = [];
  for (let d = 0; d <= total; d += step) out.push(atDistance(pts, d));
  return out;
}

export function classifyTurn(angle) {
  const a = Math.abs(angle);
  const side = angle > 0 ? 'right' : 'left';
  if (a >= 150) return { kind: 'uturn', side, text: 'Make a U-turn' };
  if (a >= 110) return { kind: 'sharp', side, text: `Sharp ${side}` };
  if (a >= 60) return { kind: 'turn', side, text: `Turn ${side}` };
  return { kind: 'slight', side, text: `Bear ${side}` };
}

// Finds turns in a prepared track. Works on a smoothed copy resampled every
// `step` meters, comparing the heading `arm` meters before and after each
// sample so GPS jitter doesn't read as turning.
export function detectTurns(pts, { step = 5, arm = 25, minAngle = 35, edge = 20, minGap = 25, smoothWindow = 4 } = {}) {
  if (pts.length < 2 || pts[pts.length - 1].d < 2 * arm + step) return [];
  const rs = resample(smooth(pts, smoothWindow), step);
  const k = Math.max(1, Math.round(arm / step));
  const total = pts[pts.length - 1].d;
  const cand = [];
  for (let i = k; i < rs.length - k; i++) {
    const angle = turnAngle(bearing(rs[i - k], rs[i]), bearing(rs[i], rs[i + k]));
    if (Math.abs(angle) >= minAngle && rs[i].d > edge && rs[i].d < total - edge) cand.push({ i, angle });
  }
  // Each bend produces a run of neighboring candidates; keep the sharpest one per run.
  const runs = [];
  for (const c of cand) {
    const run = runs[runs.length - 1];
    if (run && c.i - run[run.length - 1].i <= 2 && Math.sign(c.angle) === Math.sign(run[0].angle)) run.push(c);
    else runs.push([c]);
  }
  const turns = [];
  for (const run of runs) {
    const peak = run.reduce((m, c) => (Math.abs(c.angle) > Math.abs(m.angle) ? c : m));
    const p = rs[peak.i];
    // Measure the whole bend from before the run to after it, so a gentle
    // curve spread over many samples is classified by its total change.
    const a0 = rs[Math.max(0, run[0].i - k)], a1 = rs[run[0].i];
    const b0 = rs[run[run.length - 1].i], b1 = rs[Math.min(rs.length - 1, run[run.length - 1].i + k)];
    const angle = turnAngle(bearing(a0, a1), bearing(b0, b1));
    if (Math.abs(angle) < minAngle) continue;
    const prev = turns[turns.length - 1];
    if (prev && p.d - prev.d < minGap) {
      if (Math.abs(angle) > Math.abs(prev.angle)) turns[turns.length - 1] = { d: p.d, t: p.t, lat: p.lat, lng: p.lng, angle };
      continue;
    }
    turns.push({ d: p.d, t: p.t, lat: p.lat, lng: p.lng, angle });
  }
  return turns.map((t) => ({ ...t, ...classifyTurn(t.angle) }));
}

// Start, turns, notes, and arrival as one ordered list of cues.
export function buildCues(pts, notes = [], { to = '' } = {}) {
  if (!pts.length) return [];
  const first = pts[0], last = pts[pts.length - 1];
  const cues = [{ type: 'start', t: first.t, d: 0, lat: first.lat, lng: first.lng, text: 'Start here' }];
  for (const turn of detectTurns(pts)) cues.push({ type: 'turn', ...turn });
  for (const n of notes) {
    const p = atTime(pts, n.t);
    cues.push({ type: 'note', t: n.t, d: p.d, lat: p.lat, lng: p.lng, text: n.text });
  }
  cues.push({ type: 'arrive', t: last.t, d: last.d, lat: last.lat, lng: last.lng, text: to ? `Arrive at ${to}` : 'You have arrived' });
  return cues.sort((a, b) => a.d - b.d || a.t - b.t);
}

// Local flat projection around a reference latitude, good to a few km.
function project(p, refLat) {
  return { x: p.lng * RAD * EARTH * Math.cos(refLat * RAD), y: p.lat * RAD * EARTH };
}

// Closest point on the route to `pos`. If `near` (meters along the route) is
// given, prefer segments around it so a route that doubles back doesn't make
// the live position jump to the other leg.
export function snapToTrack(pts, pos, near = null) {
  if (pts.length < 2) return null;
  const P = project(pos, pos.lat);
  let best = null;
  const consider = (lo, hi) => {
    for (let i = lo; i < hi; i++) {
      const a = pts[i], b = pts[i + 1];
      const A = project(a, pos.lat), B = project(b, pos.lat);
      const dx = B.x - A.x, dy = B.y - A.y;
      const len2 = dx * dx + dy * dy;
      const f = len2 ? Math.max(0, Math.min(1, ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2)) : 0;
      const off = Math.hypot(A.x + dx * f - P.x, A.y + dy * f - P.y);
      if (!best || off < best.off) {
        best = { off, d: lerp(a.d, b.d, f), t: lerp(a.t, b.t, f), lat: lerp(a.lat, b.lat, f), lng: lerp(a.lng, b.lng, f) };
      }
    }
  };
  if (near != null) {
    const lo = pts.findIndex((p) => p.d >= near - 60);
    const hi = pts.findIndex((p) => p.d > near + 250);
    consider(Math.max(0, lo), hi === -1 ? pts.length - 1 : hi);
    if (best && best.off <= 40) return best;
    best = null;
  }
  consider(0, pts.length - 1);
  return best;
}

// Units follow the reader's locale: US-style English gets feet and miles.
const IMPERIAL = /^en-(US|LR|MM)$/i.test(globalThis.navigator?.language || '');

export function formatDistance(m, { imperial = IMPERIAL } = {}) {
  if (imperial) {
    const ft = m * 3.28084;
    if (ft < 1000) return `${Math.max(10, Math.round(ft / 10) * 10)} ft`;
    const mi = m / 1609.344;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.max(5, Math.round(m / 5) * 5)} m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} km`;
}

export function formatDuration(s) {
  s = Math.max(0, Math.round(s));
  if (s < 60) return `${s} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

export function formatClock(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
