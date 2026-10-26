// Street view from your own footage.
//
// Every recording (a named route or a street capture) is a video plus a GPS
// track on the same clock. To "stand" somewhere facing some direction, find
// the recording that passed closest to that spot while heading the same way,
// and show the video frame from that moment. Driving a street once each way
// gives you both directions, like the two passes of a street-view car.

import { prepareTrack, atDistance, bearing, turnAngle, distance, snapToTrack } from './geo.js?v=202610261528';

const SAMPLE_M = 5;       // spacing of indexed samples along each recording
const CELL = 0.0003;      // grid cell in degrees (~33 m north-south)

// Heading of travel at distance d along a prepared track, measured across
// `span` meters either side so GPS wobble doesn't swing it.
export function headingAt(pts, d, span = 10) {
  const total = pts[pts.length - 1].d;
  const a = atDistance(pts, Math.max(0, d - span));
  const b = atDistance(pts, Math.min(total, d + span));
  return distance(a, b) < 1 ? null : bearing(a, b);
}

// segments: [{id, track, ...}] as returned by /api/coverage.
// Returns an index used by every lookup below.
export function buildIndex(segments) {
  const segs = [];
  const grid = new Map();
  for (const raw of segments) {
    const pts = prepareTrack(raw.track);
    if (pts.length < 2 || pts[pts.length - 1].d < SAMPLE_M * 2) continue;
    const seg = { ...raw, pts, samples: [] };
    const total = pts[pts.length - 1].d;
    const scanned = pts.some((q) => q.look != null && Math.abs(q.look) > LOOK_MAX);
    // Every SAMPLE_M meters, plus the exact end so consecutive pieces of a
    // recording meet with no hole between them.
    const ds = [];
    for (let d = 0; d <= total; d += SAMPLE_M) ds.push(d);
    if (total - ds[ds.length - 1] > 0.5) ds.push(total);
    for (const d of ds) {
      const p = atDistance(pts, d);
      const heading = headingAt(pts, d);
      if (heading == null) continue; // standing still: no direction to file it under
      const t = scanned ? forwardTime(pts, p) : p.t;
      if (t == null) continue; // camera was turned to the side here (looking for traffic)
      const s = { seg, d, t, lat: p.lat, lng: p.lng, heading };
      seg.samples.push(s);
      const key = cellKey(p.lat, p.lng);
      if (!grid.has(key)) grid.set(key, []);
      grid.get(key).push(s);
    }
    segs.push(seg);
  }
  return { segs, grid, byId: new Map(segs.map((s) => [s.id, s])) };
}

// Time to show for a spot: the frame at `p`, unless the rider had the camera
// turned to the side then (look recorded from the compass, e.g. scanning for
// cross traffic at a stop). Then another moment at the same spot, facing ahead.
const LOOK_MAX = 35;
function forwardTime(pts, p) {
  const near = pts.filter((q) => Math.abs(q.t - p.t) <= 15);
  const at = near.reduce((a, q) => (Math.abs(q.t - p.t) < Math.abs(a.t - p.t) ? q : a), near[0] || { t: p.t, look: null });
  if (at.look == null || Math.abs(at.look) <= LOOK_MAX) return p.t;
  const ok = near.filter((q) => q.look != null && Math.abs(q.look) <= LOOK_MAX && distance(q, p) < 4);
  if (!ok.length) return null;
  return ok.reduce((a, q) => (Math.abs(q.t - p.t) < Math.abs(a.t - p.t) ? q : a)).t;
}

const cellKey = (lat, lng) => `${Math.floor(lat / CELL)}:${Math.floor(lng / CELL)}`;

function* nearby(index, pos, radius) {
  const r = Math.ceil(radius / 30) + 1;
  const ci = Math.floor(pos.lat / CELL), cj = Math.floor(pos.lng / CELL);
  for (let i = ci - r; i <= ci + r; i++) {
    for (let j = cj - r; j <= cj + r; j++) {
      const bucket = index.grid.get(`${i}:${j}`);
      if (bucket) yield* bucket;
    }
  }
}

// Best view at `pos` looking along `heading`. Returns null when nothing was
// recorded there going that way. Each degree of heading mismatch costs as
// much as 0.4 m of distance, so a slightly farther pass in the right
// direction beats a closer one that's angled off.
export function findView(index, pos, heading, { radius = 25, maxTurn = 60, exclude = null } = {}) {
  let best = null;
  for (const s of nearby(index, pos, radius)) {
    if (exclude && s.seg.id === exclude) continue;
    const off = distance(pos, s);
    if (off > radius) continue;
    const turn = heading == null ? 0 : Math.abs(turnAngle(s.heading, heading));
    if (turn > maxTurn) continue;
    const score = off + turn * 0.4 - (s.seg.createdAt || 0) / 1e15; // newest wins ties
    if (!best || score < best.score) best = { s, score, off, turn };
  }
  if (!best) return null;
  // Refine from the 5 m sample to the exact point on that recording.
  const snap = snapToTrack(best.s.seg.pts, pos, best.s.d) || best.s;
  return {
    seg: best.s.seg, id: best.s.seg.id, t: snap.t, d: snap.d, lat: snap.lat, lng: snap.lng,
    heading: headingAt(best.s.seg.pts, snap.d) ?? best.s.heading, off: best.off, turn: best.turn,
  };
}

// What you can do from a view, like street view's arrows: keep going,
// turn around (needs the other-direction pass), or turn onto a crossing street.
export function viewOptions(index, view, { step = 12 } = {}) {
  const here = { lat: view.lat, lng: view.lng };
  const total = view.seg.pts[view.seg.pts.length - 1].d;
  const ahead = view.d + step <= total ? { ...view, ...stepAlong(view, step) } : null;
  const back = view.d - step >= 0 ? { ...view, ...stepAlong(view, -step) } : null;
  const behind = findView(index, here, (view.heading + 180) % 360, { radius: 20, maxTurn: 45 });
  const side = (deg) => {
    const v = findView(index, here, (view.heading + deg + 360) % 360, { radius: 22, maxTurn: 40 });
    return v && Math.abs(turnAngle(view.heading, v.heading)) > 50 ? v : null;
  };
  return { ahead, back, behind, left: side(-90), right: side(90) };
}

function stepAlong(view, delta) {
  const d = view.d + delta;
  const p = atDistance(view.seg.pts, d);
  return { d, t: p.t, lat: p.lat, lng: p.lng, heading: headingAt(view.seg.pts, d) ?? view.heading };
}

// Splits recordings into map lines tagged by how the street is covered:
// both = recorded in each direction, one = only this way so far.
// Several passes over the same street (the two directions sit a lane or
// more apart, plus GPS drift) are drawn as ONE line: a sample is drawn only
// if its recording has the smallest id among all passes along that street
// there, in either direction. Crossing streets don't count as the same street.
export function coverageLines(index, { step = 10, radius = 20 } = {}) {
  const lines = [];
  for (const seg of index.segs) {
    let run = null, hidden = null; // hidden: the last sample skipped because another pass is drawn there
    // Every `step` meters, plus the very last sample so a piece's line reaches its end.
    const ks = [];
    for (let k = 0; k < seg.samples.length; k += Math.max(1, Math.round(step / SAMPLE_M))) ks.push(k);
    if (seg.samples.length && ks[ks.length - 1] !== seg.samples.length - 1) ks.push(seg.samples.length - 1);
    for (const k of ks) {
      const s = seg.samples[k];
      let both = false, drawn = true, opposite = null, oppDist = Infinity;
      for (const o of nearby(index, s, radius)) {
        if (o.seg === seg) continue;
        const dist = distance(s, o);
        if (dist > radius) continue;
        const turn = Math.abs(turnAngle(s.heading, o.heading));
        if (turn >= 135) { both = true; if (dist < oppDist) { oppDist = dist; opposite = o; } }
        // Hide this pass only where a lower-id pass runs BESIDE it. A pass that
        // merely ends a little way ahead mustn't hide it, or the line has gaps
        // wherever recordings start and stop at different places.
        const along = Math.abs(dist * Math.cos(turnAngle(s.heading, bearing(s, o)) * Math.PI / 180));
        if ((turn >= 135 || turn <= 45) && o.seg.id < seg.id && along <= 4) drawn = false; // its samples are 5 m apart, so "beside" is within ~2.5 m along
      }
      // A U-turn within one recording also covers both ways.
      if (!both) {
        for (const o of nearby(index, s, radius)) {
          if (o.seg === seg && Math.abs(o.d - s.d) >= 40 && distance(s, o) <= radius && Math.abs(turnAngle(s.heading, o.heading)) >= 135) { both = true; break; }
        }
      }
      // A street captured both ways is drawn down its middle, halfway between
      // the two passes, so hand-offs between recordings line up.
      const at = opposite ? [(s.lat + opposite.lat) / 2, (s.lng + opposite.lng) / 2] : [s.lat, s.lng];
      if (!drawn) {
        // Hand-off to another pass: reach one sample into its stretch so the
        // two lines overlap a little instead of leaving a gap.
        if (run) run.latlngs.push(at);
        run = null;
        hidden = at;
        continue;
      }
      if (!run || run.both !== both) {
        if (run) run.latlngs.push(at); // join runs so the line has no gaps
        run = { id: seg.id, both, heading: s.heading, latlngs: [] };
        if (hidden) run.latlngs.push(hidden); // taking over: start one sample back
        lines.push(run);
      }
      run.latlngs.push(at);
      hidden = null;
    }
  }
  // Where one piece of footage ends a few meters from where the next one's
  // line starts, join them so the street reads as one line.
  const out = lines.filter((l) => l.latlngs.length >= 2);
  for (const l of out) {
    const [lat, lng] = l.latlngs[l.latlngs.length - 1];
    let best = null, bestD = 6;
    for (const o of out) {
      if (o === l || o.both !== l.both) continue;
      const d = distance({ lat, lng }, { lat: o.latlngs[0][0], lng: o.latlngs[0][1] });
      if (d < bestD) { bestD = d; best = o; }
    }
    if (best && bestD > 0.01) l.latlngs.push(best.latlngs[0]);
  }
  return out;
}

// Lines up a planned route (e.g. from the router) with your footage.
// Returns runs of contiguous footage to play in order, gaps where nothing
// was recorded going that way, and the share of the trip that's covered.
export function matchPlan(index, planLatLngs, { step = 10 } = {}) {
  const plan = prepareTrack(planLatLngs.map(([lat, lng], i) => [i, lat, lng, null]));
  const total = plan[plan.length - 1].d;
  const runs = [];
  let covered = 0, n = 0;
  for (let d = 0; d <= total; d += step) {
    n++;
    const p = atDistance(plan, d);
    const heading = headingAt(plan, d, 12);
    const v = heading == null ? null : findView(index, p, heading, { radius: 20, maxTurn: 45 });
    const last = runs[runs.length - 1];
    if (v) covered++;
    if (v && last?.id === v.id && v.t >= last.t1 - 0.5 && v.t - last.t1 < 30) {
      last.t1 = v.t; last.d1 = d;
    } else if (v) {
      runs.push({ id: v.id, seg: v.seg, t0: v.t, t1: v.t, d0: d, d1: d });
    } else if (!last || last.id !== null) {
      runs.push({ id: null, d0: d, d1: d }); // gap
    } else {
      last.d1 = d;
    }
  }
  return { runs, covered: n ? covered / n : 0, total };
}

// Street length covered by coverage lines (as from coverageLines), counting
// a stretch once however many lines run along it. A sample adds `step`
// meters unless a sample already counted from a DIFFERENT line lies within
// `near` meters. `inView(lat, lng)` limits the count to an area.
export function coveredLength(lines, inView = () => true, { step = 10, near = 15 } = {}) {
  const cell = 0.0002;
  const grids = { any: new Map(), both: new Map() };
  const take = (grid, lat, lng, line) => {
    const ci = Math.floor(lat / cell), cj = Math.floor(lng / cell);
    for (let i = ci - 1; i <= ci + 1; i++) {
      for (let j = cj - 1; j <= cj + 1; j++) {
        for (const p of grid.get(`${i}:${j}`) || []) if (p.line !== line && distance(p, { lat, lng }) < near) return false;
      }
    }
    const k = `${ci}:${cj}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push({ lat, lng, line });
    return true;
  };
  let any = 0, both = 0;
  lines.forEach((l, n) => {
    for (const [lat, lng] of l.latlngs) {
      if (!inView(lat, lng)) continue;
      if (take(grids.any, lat, lng, n)) any += step;
      if (l.both && take(grids.both, lat, lng, n)) both += step;
    }
  });
  return { any, both };
}
