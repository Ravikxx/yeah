// Turn-by-turn from the router (OSRM responses via the Waymark Worker).

import { getDirections } from './api.js';
import { formatDistance } from './geo.js';

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
export async function planTrip(mode, from, to, bearing = null) {
  const data = await getDirections(mode, from, to, bearing);
  if (data.code !== 'Ok' || !data.routes?.length) throw new Error('No route found between those points.');
  const r = data.routes[0];
  const latlngs = r.geometry.coordinates.map(([lng, lat]) => [lat, lng]);
  let along = 0;
  const steps = r.legs.flatMap((leg) => leg.steps).map((s) => {
    const step = { ...s, at: along, text: stepText(s), title: maneuverTitle(s), angle: maneuverAngle(s.maneuver) };
    along += s.distance;
    return step;
  });
  return { mode, from, to, latlngs, steps, distance: r.distance, duration: r.duration };
}
