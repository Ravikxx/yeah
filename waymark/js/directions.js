// Turn-by-turn from the router (OSRM responses via the Waymark Worker).

import { getDirections, getRoadSpeeds } from './api.js?v=202610261821';
import { formatDistance } from './geo.js?v=202610261821';

const COMPASS = ['north', 'northeast', 'east', 'southeast', 'south', 'southwest', 'west', 'northwest'];
export const compass = (deg) => COMPASS[Math.round(((deg % 360) + 360) % 360 / 45) % 8];

const ANGLE = { 'sharp left': -135, left: -90, 'slight left': -45, straight: 0, 'slight right': 45, right: 90, 'sharp right': 135, uturn: 180 };

// Arrow angle for a maneuver (negative = left), or 'arrive'.
export function maneuverAngle(m = {}) {
  if (m.type === 'arrive') return 'arrive';
  if (m.type === 'depart') return 0;
  return ANGLE[m.modifier] ?? 0;
}

export function stepText(s, { withDistance = true, arriveText = 'Arrive at your destination' } = {}) {
  const m = s.maneuver || {};
  const name = s.name ? ` onto ${s.name}` : '';
  const dist = withDistance && s.distance > 0 ? ` · ${formatDistance(s.distance)}` : '';
  switch (m.type) {
    case 'depart': return `Head ${compass(m.bearing_after || 0)}${s.name ? ` on ${s.name}` : ''}${dist}`;
    case 'arrive': return arriveText;
    case 'roundabout': case 'rotary': return `At the roundabout, take exit ${m.exit || 1}${name}${dist}`;
    default: {
      const mod = m.modifier || 'straight';
      if (mod === 'straight') return `Continue straight${name}${dist}`;
      if (mod === 'uturn') return `Make a U-turn${name}${dist}`;
      const verb = mod.startsWith('slight') ? `Bear ${mod.replace('slight ', '')}`
        : mod.startsWith('sharp') ? `Sharp ${mod.replace('sharp ', '')}` : `Turn ${mod}`;
      return `${verb}${name}${dist}`;
    }
  }
}

// Short sign wording for the maneuver itself ("Turn left", "Arrive").
export function maneuverTitle(s) {
  const m = s.maneuver || {};
  if (m.type === 'arrive') return 'Arrive';
  if (m.type === 'roundabout' || m.type === 'rotary') return `Roundabout, exit ${m.exit || 1}`;
  return stepText({ ...s, name: '' }, { withDistance: false });
}

// Fetches a trip and flattens it into what the map and signs need:
// latlngs for the line, and maneuvers with their distance along the trip.
export async function planTrip(mode, from, to, bearing = null, { backRoads = false } = {}) {
  if (backRoads) return planBackRoads(mode, from, to, bearing);
  const data = await getDirections(mode, from, to, bearing);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route found between those points.');
  return flatten(data.routes[0], mode, from, to);
}

function flatten(r, mode, from, to) {
  const latlngs = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  // A route through a via point comes in two legs; joining them, the middle
  // "arrive" disappears and the second "depart" just carries on.
  const raw = r.legs.flatMap((leg, li) => leg.steps.filter((s) => !(s.maneuver?.type === 'arrive' && li < r.legs.length - 1))
    .map((s, si) => (li > 0 && si === 0 && s.maneuver?.type === 'depart' ? { ...s, maneuver: { ...s.maneuver, type: 'continue', modifier: 'straight' } } : s)));
  let along = 0;
  const steps = raw.map((s) => {
    const step = { ...s, at: along, text: stepText(s), title: maneuverTitle(s), angle: maneuverAngle(s.maneuver) };
    along += s.distance;
    return step;
  });
  return { mode, from, to, latlngs, steps, distance: r.distance, duration: r.duration };
}

// ---------- back roads ----------
// A big road is one where cars are expected to go fast: the router's car speed
// estimate along the route (35-50 mph roads come out around 30-45; residential
// streets around 15). Numbered US/state routes count too, as a fallback.
// To find quieter ways, ask for the router's alternatives plus routes forced
// through points to either side of the straight line, then keep the one with
// the least big-road riding that isn't far longer.
const BIG_NAME = /highway|expressway|freeway|parkway|bypass|pike|route \d/i;
export const isBigRoad = (s) => Boolean(s.ref) || BIG_NAME.test(s.name || '');
const MID_MPH = 30, FAST_MPH = 38;

function sample(latlngs, n = 85) {
  let total = 0; const cum = [0];
  for (let i = 1; i < latlngs.length; i++) {
    const [a, b] = [latlngs[i - 1], latlngs[i]];
    total += Math.hypot((b[0] - a[0]) * 111320, (b[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180)); cum.push(total);
  }
  const step = Math.max(40, total / (n - 1)), out = [latlngs[0]];
  for (let i = 1, next = step; i < latlngs.length; i++) if (cum[i] >= next) { out.push(latlngs[i]); next = cum[i] + step; }
  if (out[out.length - 1] !== latlngs[latlngs.length - 1]) out.push(latlngs[latlngs.length - 1]);
  return out.slice(0, 85);
}

// Metres on fast roads (mph >= FAST), on medium ones, the worst speed seen,
// and where the longest run of fast-ish road is (to try detouring around it).
async function roadLoad(trip) {
  try {
    const pts = sample(trip.latlngs);
    const st = await getRoadSpeeds(pts);
    if (st.length) {
      let run = null, cur = null;
      st.forEach((x, i) => {
        if (x.mph >= MID_MPH) {
          if (!cur) cur = { i0: i, i1: i, m: 0 };
          cur.i1 = i; cur.m += x.m;
          if (!run || cur.m > run.m) run = { ...cur };
        } else cur = null;
      });
      const worst = run && { a: pts[run.i0], b: pts[run.i1 + 1] || pts[run.i1], m: run.m };
      return { fast: st.filter((x) => x.mph >= FAST_MPH).reduce((m, x) => m + x.m, 0),
               mid: st.filter((x) => x.mph >= MID_MPH && x.mph < FAST_MPH).reduce((m, x) => m + x.m, 0),
               top: Math.max(...st.map((x) => x.top)), worst };
    }
  } catch { /* fall back to route numbers */ }
  return { fast: trip.steps.reduce((m, s) => m + (isBigRoad(s) ? s.distance : 0), 0), mid: 0, top: null, worst: null };
}

const RAD = Math.PI / 180, EARTH = 6371000;
// Points `m` metres to either side of the line a->b, at its middle.
function besides(a, b, ms) {
  const dy = (b[0] - a[0]) * RAD * EARTH, dx = (b[1] - a[1]) * RAD * EARTH * Math.cos(a[0] * RAD);
  const len = Math.hypot(dx, dy) || 1, mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  return ms.flatMap((m) => [-1, 1].map((sg) => ({
    lat: mid[0] + sg * (dx / len) * m / (EARTH * RAD), lng: mid[1] - sg * (dy / len) * m / (EARTH * RAD * Math.cos(mid[0] * RAD)) })));
}

async function planBackRoads(mode, from, to, bearing) {
  const ask = (via) => getDirections(mode, from, to, bearing, via ? { via } : { alternatives: true })
    .then((d) => (d.routes || []).slice(0, via ? 1 : 3).map((r) => flatten(r, mode, from, to))).catch(() => []);
  const straight = Math.hypot((to.lat - from.lat) * RAD * EARTH, (to.lng - from.lng) * RAD * EARTH * Math.cos(from.lat * RAD));
  // first try: the router's own alternatives, plus routes through points on
  // either side of the straight line at 30/50/70% of the way
  const at = (f) => [from.lat + (to.lat - from.lat) * f, from.lng + (to.lng - from.lng) * f];
  const side = straight < 250 ? [] : [[0.15, 0.45], [0.35, 0.65], [0.55, 0.85]]
    .flatMap(([f0, f1]) => besides(at(f0), at(f1), [Math.max(120, Math.min(900, straight * 0.25)), Math.max(150, Math.min(1200, straight * 0.5))]));
  const first = await Promise.all([ask(null), ...side.map(ask)]);
  const all = first.flat();
  if (!all.length) throw new Error('No route found between those points.');
  const shortest = Math.min(...all.map((t) => t.distance));
  const okLen = (t) => t.distance <= shortest * 1.8 && !t.steps.some((s) => s.maneuver?.modifier === 'uturn');
  const score = (t, l) => t.distance + 6 * l.fast + 3 * l.mid;
  const scored = [];
  const add = async (trips) => {
    const fresh = trips.filter(okLen).filter((t) => !scored.some((s) => Math.abs(s.t.distance - t.distance) < 15));
    const loads = await Promise.all(fresh.map(roadLoad));
    fresh.forEach((t, i) => scored.push({ t, l: loads[i] }));
  };
  await add(all);
  if (!scored.length) await add(all.map((t) => ({ ...t }))); // nothing short enough: take what there is
  // Twice: detour around the longest fast stretch of the best route so far.
  for (let round = 0; round < 2; round++) {
    const best = scored.reduce((a, s) => (score(s.t, s.l) < score(a.t, a.l) ? s : a));
    if (!best.l.worst || best.l.worst.m < 100) break;
    await add((await Promise.all(besides(best.l.worst.a, best.l.worst.b, [250, 500]).map(ask))).flat());
  }
  const best = scored.length ? scored.reduce((a, s) => (score(s.t, s.l) < score(a.t, a.l) ? s : a)) : { t: all[0], l: { fast: 0, mid: 0 } };
  best.t.bigRoadMeters = Math.round(best.l.fast + best.l.mid);
  best.t.topCarMph = best.l.top;
  return best.t;
}
