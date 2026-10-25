// Turn-by-turn from the router (OSRM responses via the Waymark Worker).

import { getDirections } from './api.js?v=202610251851';
import { formatDistance } from './geo.js?v=202610251851';

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
// Big roads here are numbered routes (US/state routes carry a ref like "SR 800")
// and anything named like a highway. To find quieter ways, ask for the router's
// alternatives plus routes forced through points to either side of the straight
// line, then keep the one with the least big-road distance that isn't much longer.
const BIG_NAME = /highway|expressway|freeway|parkway|bypass|pike|route \d/i;
export const isBigRoad = (s) => Boolean(s.ref) || BIG_NAME.test(s.name || '');

function bigMeters(trip) {
  return trip.steps.reduce((m, s) => m + (isBigRoad(s) ? s.distance : 0), 0);
}

async function planBackRoads(mode, from, to, bearing) {
  const R = 6371000, rad = Math.PI / 180;
  const dy = (to.lat - from.lat) * rad * R, dx = (to.lng - from.lng) * rad * R * Math.cos(from.lat * rad);
  const len = Math.hypot(dx, dy) || 1;
  const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  const side = (m) => ({ lat: mid.lat + (dx / len) * m / (R * rad), lng: mid.lng - (dy / len) * m / (R * rad * Math.cos(mid.lat * rad)) });
  const offsets = len < 300 ? [] : [-0.5, -0.25, 0.25, 0.5].map((f) => Math.max(150, Math.min(600, len * Math.abs(f))) * Math.sign(f));
  const asks = [getDirections(mode, from, to, bearing, { alternatives: true }).then((d) => (d.routes || []).map((r) => flatten(r, mode, from, to)))]
    .concat(offsets.map((o) => getDirections(mode, from, to, bearing, { via: side(o) }).then((d) => (d.routes || []).slice(0, 1).map((r) => flatten(r, mode, from, to)))));
  const trips = (await Promise.allSettled(asks)).flatMap((x) => (x.status === 'fulfilled' ? x.value : []));
  if (!trips.length) throw new Error('No route found between those points.');
  const shortest = Math.min(...trips.map((t) => t.distance));
  const ok = trips.filter((t) => t.distance <= shortest * 1.6 && !t.steps.some((s) => s.maneuver?.modifier === 'uturn'));
  const pool = ok.length ? ok : trips;
  const best = pool.reduce((a, t) => (bigMeters(t) * 4 + t.distance < bigMeters(a) * 4 + a.distance ? t : a));
  best.bigRoadMeters = Math.round(bigMeters(best));
  return best;
}
