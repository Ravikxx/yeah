// Keeps the footage in and around the map view loaded and indexed, so street
// view, the coverage layer and navigation all read from one place.

import { getCoverage, mine } from './api.js?v=202610270002';
import { buildIndex } from './street.js?v=202610270002';

const MAX_SPAN = 0.6;
const segs = new Map();
let index = buildIndex([]);
let loaded = []; // [w, s, e, n] boxes already fetched
const listeners = new Set();

export const getIndex = () => index;
// Where street view or navigation last was, so the map can pick up there.
export const memory = { lastSpot: null };
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

function rebuild() {
  index = buildIndex([...segs.values()]);
  listeners.forEach((fn) => fn(index));
}

const contains = (a, b) => a[0] <= b[0] && a[1] <= b[1] && a[2] >= b[2] && a[3] >= b[3];

// Ids of this browser's own recordings, newest first, so private footage
// shows up for its owner.
function myIds() {
  return Object.entries(mine())
    .sort((a, b) => (b[1].createdAt || 0) - (a[1].createdAt || 0))
    .map(([id]) => id)
    .slice(0, 300);
}

// box: [west, south, east, north]. Resolves to false if the area is too big to load.
export async function loadBox(box) {
  const pad = Math.min(0.02, (box[2] - box[0]) * 0.25);
  const b = [box[0] - pad, box[1] - pad, box[2] + pad, box[3] + pad];
  if (b[2] - b[0] > MAX_SPAN || b[3] - b[1] > MAX_SPAN) return false;
  if (loaded.some((l) => contains(l, b))) return true;
  const found = await getCoverage(b, myIds());
  loaded.push(b);
  let changed = false;
  for (const s of found) {
    if (!segs.has(s.id)) { segs.set(s.id, s); changed = true; }
  }
  if (changed) rebuild();
  return true;
}

export const loadAround = (lat, lng, meters = 400) => {
  const dLat = meters / 111320, dLng = meters / (111320 * Math.cos(lat * Math.PI / 180));
  return loadBox([lng - dLng, lat - dLat, lng + dLng, lat + dLat]);
};

export const boundsToBox = (b) => [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

// A capture that just finished uploading: show it without a refetch.
export function add(seg) {
  segs.set(seg.id, seg);
  rebuild();
}

export function remove(id) {
  if (segs.delete(id)) rebuild();
}

// Forget what was fetched so the next look pulls in other people's new footage.
export function refresh() { loaded = []; }
