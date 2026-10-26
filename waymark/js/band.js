// Where the blue band goes, as plain functions with no page in them (so a test can replay recorded rides through
// exactly the code the phone runs). One pipeline, in this order:
//   1. turn rate: how fast the compass is turning, ignoring wobble          (turnRateFrom, smoothRate)
//   2. the target path: the driver model (with directions), or the route itself when slow, or the
//      lane finder + the turn you're in (Free ride)                         (planBand)
//   3. one smoothing step, and one confidence number the band's opacity follows
// All offsets are metres to the LEFT (+) of the way you're facing, at 5, 10 and 15 m ahead.

export const DISTS = [5, 10, 15];
// How much the route's own shape counts against the driver model at 5, 10 and 15 m ahead. Chosen on rides the
// model never saw (see v2/planner_eval.py): the route is best close up and on straights, the model is best at
// seeing a turn coming, and the blend keeps both: 89% of turns bent the right way, 3% false bends.
export const ROUTE_WEIGHT = [0.8, 0.5, 0.3];
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Degrees a second, + = turning right, from compass samples [{ t (ms), h (deg) }] over the last ~0.8 s.
// null when unknown: too few samples, stale, nearly stopped, or a wobble (a real turn keeps going the same
// way; a bump on the road swings the bars back and forth).
export function turnRateFrom(hist, v, now) {
  if (!hist || hist.length < 6 || v < 0.8 || now - hist[hist.length - 1].t > 400) return null;
  const last = hist[hist.length - 1], old = hist.find((q) => now - q.t <= 800) || hist[0], dt = (last.t - old.t) / 1000;
  if (dt < 0.4) return null;
  const d = (a, b) => ((b.h - a.h + 540) % 360) - 180;
  const mid = hist.find((q) => q.t >= old.t + (last.t - old.t) / 2) || last;
  const r = d(old, last) / dt, r1 = d(old, mid) / (dt / 2), r2 = d(mid, last) / (dt / 2);
  if (r1 * r2 <= 0 || Math.min(Math.abs(r1), Math.abs(r2)) < 0.5 * Math.abs(r)) return null;
  return r;
}

// Rises and falls gradually, and decays to 0 when the compass says nothing: the band never flips between
// "turning" and "not".
// Eases in at 25% a step and out at 50%: the band straightens quickly once the turn is over.
export const smoothRate = (prev, tr) => { const p = prev ?? 0, t = tr ?? 0, k = Math.abs(t) < Math.abs(p) ? 0.5 : 0.25; return p * (1 - k) + t * k; };

// 0 below 4 deg/s, full from 12.
export const turnStrength = (rate) => clamp((Math.abs(rate) - 4) / 8, 0, 1);
// How much the lane finder still counts: fully up to 6 deg/s, not at all from 26 (in a turn the road in the
// picture is the road you're leaving).
export const laneWeight = (rate) => clamp(1 - (Math.abs(rate) - 6) / 20, 0, 1);

// The arc you're on (radius = speed / turn rate), as left offsets at the given distances.
export function turnArc(rate, v, dists = DISTS) {
  const s = turnStrength(rate);
  if (!s) return dists.map(() => 0);
  const k = (rate * Math.PI / 180) / Math.max(v, 1.5);
  return dists.map((d) => s * clamp(-k * d * d / 2, -0.8 * d, 0.8 * d));
}

// st: what this returned last time (null at the start).
// in: { now (ms), v (m/s), rate (smoothed deg/s), path (driver model or null), lane ({x:[near,mid,far]} or null),
//       route (the map route's offsets at 5/10/15 m, or null), dists, lookId (changes with each new AI look),
//       acc (GPS accuracy m, optional) }
// -> { ys, laneX, conf, state }
export function planBand(st, { now, v, rate, path, lane, route = null, dists = DISTS, lookId = null, acc = 0 }) {
  const strength = turnStrength(rate);
  // with directions the driver model plans from the route's shape; below ~3 mph (where it was never trained)
  // the route itself is shown; with no directions the lane finder places the band and the turn you're in bends it
  let planned = path || null;
  const known = route && route.slice(0, 3).every((y) => y != null) ? route.slice(0, 3) : null;
  if (planned && v < 1.5) planned = known;
  else if (planned && known) planned = planned.map((y, i) => ROUTE_WEIGHT[i] * known[i] + (1 - ROUTE_WEIGHT[i]) * y);
  if (planned) planned = planned.map((y, i) => clamp(y, -0.7 * dists[i], 0.7 * dists[i]));
  const target = planned || (lane ? turnArc(rate, v, dists) : [0, 0, 0]);
  const keep = st && now - st.at < 3000;
  const w = strength > 0 ? 0.6 : 0.5;
  const ys = keep ? target.map((y, i) => w * y + (1 - w) * st.ys[i]) : target;

  // the lane finder jitters from look to look on a bumpy road: ease toward each NEW answer (not on every redraw),
  // and don't let the middle point swing out past near and far (that's the S-shape)
  let laneX = null, jitter = 0;
  if (lane && !planned) {
    const sameLook = keep && st.lane && lookId != null && st.lookId === lookId;
    if (sameLook) laneX = st.lane;
    else {
      laneX = keep && st.lane ? lane.x.map((x, i) => 0.35 * x + 0.65 * st.lane[i]) : lane.x.slice();
      if (keep && st.lane) jitter = Math.max(...lane.x.map((x, i) => Math.abs(x - st.lane[i])));
      const lo = Math.min(laneX[0], laneX[2]) - 0.02, hi = Math.max(laneX[0], laneX[2]) + 0.02;
      laneX[1] = clamp(laneX[1], lo, hi);
    }
  }

  // confidence: fades the band when the pieces disagree or the inputs are poor (a faint line is better than
  // a confident wrong one)
  let pen = 0;
  if (jitter > 0.10) pen += 0.35;                       // the lane finder jumped between looks
  if (acc > 30) pen += 0.25;                            // poor GPS
  if (path && route && v >= 1.5) {                      // the model and the route should roughly agree
    const gap = route.slice(0, 3).reduce((a, y, i) => a + (y == null ? 0 : Math.abs(y - path[i])), 0) / 3;
    pen += clamp((gap - 1.5) / 6, 0, 0.65);       // the further apart, the fainter
  }
  const conf = clamp(0.7 * (st?.conf ?? 1) + 0.3 * (1 - pen), 0.35, 1);
  return { ys, laneX, conf, state: { ys, lane: laneX, at: now, conf, lookId } };
}

// ---------- obstacles and rules: they change where the band goes, not just what the text says ----------
const CLEAR = 1.6;     // metres between a car's middle and the band's middle (car half-width + room for a bike)
const MAX_SHIFT = 1.5; // never swerve more than this to pass a parked car

// cars: [{ dist (m ahead), side (m, + = YOUR RIGHT), moving }] seen in the last second or so.
// ys: the planned left offsets at `dists`. -> { ys, stopAt, slow }
//   - a parked car in the way: the band moves to the side with room to pass; if that side is blocked too, it
//     ends behind the car
//   - a car moving in your lane: the band ends behind it, at a gap of 3 m + 1.5 s of speed (as in the simulator)
export function avoidCars(ys, cars, { v = 0, dists = DISTS } = {}) {
  const at = (arr, d) => { // the band's left offset d metres ahead (0 at the wheel)
    if (d <= dists[0]) return arr[0] * d / dists[0];
    for (let i = 1; i < dists.length; i++) if (d <= dists[i]) return arr[i - 1] + (arr[i] - arr[i - 1]) * (d - dists[i - 1]) / (dists[i] - dists[i - 1]);
    return arr[arr.length - 1];
  };
  const gap = 3 + 1.5 * v;
  let out = ys.slice(), stopAt = null, slow = false;
  const list = (cars || []).filter((c) => c.dist > 2 && c.dist < 25).map((c) => ({ ...c, x: -c.side })).sort((a, b) => a.dist - b.dist);
  for (const c of list) {
    const off = at(out, c.dist) - c.x;                      // + = the band is to the car's left
    if (Math.abs(off) >= CLEAR) continue;                   // already clear of it
    if (c.moving) {                                         // follow it, don't pass
      if (c.dist - gap < 12) { stopAt = Math.min(stopAt ?? Infinity, Math.max(2.5, c.dist - gap)); slow = true; }
      continue;
    }
    const dir = off >= 0 ? 1 : -1, shift = Math.min(MAX_SHIFT, CLEAR - Math.abs(off));
    const moved = out.map((y, i) => y + dir * shift * Math.exp(-(((dists[i] - c.dist) / 6) ** 2)));
    // room to pass? not if the move would put the band into another car
    if (list.some((o) => o !== c && Math.abs(at(moved, o.dist) - o.x) < 1.2)) { stopAt = Math.min(stopAt ?? Infinity, Math.max(2.5, c.dist - 3)); slow = true; }
    else out = moved;
  }
  return { ys: out, stopAt, slow };
}

// The nearest of the places the band should end (stop sign / red light / crossing car / the car ahead), or null.
export const nearestStop = (...ds) => { const v = ds.filter((d) => d != null); return v.length ? Math.min(...v) : null; };

// ---------- turning, from the gyroscope (no lag; the compass heading is filtered and arrives about a second late) ----------
// Yaw rate (deg/s about the vertical) from the gyroscope: its rotation vector dotted with "up". "Up" is the
// gravity direction in the phone's own axes (accelerometer, smoothed by the caller), so it doesn't matter how the
// phone is tilted on the bars. The overall sign differs between phones and browsers, so it is learned (calibSign).
// rot, grav: {x, y, z}.
export function yawFromMotion(rot, grav) {
  const n = Math.hypot(grav.x, grav.y, grav.z);
  if (!n || n < 5) return null; // not a plausible gravity reading (free fall, or no sensor)
  return (rot.x * grav.x + rot.y * grav.y + rot.z * grav.z) / n;
}

// Degrees a second over the last `span` ms from gyro samples [{ t (ms), w (deg/s) }], or null: too few / stale
// samples, nearly stopped, or a wobble (a real turn keeps going the same way).
export function gyroTurnFrom(hist, v, now, span = 500) {
  if (!hist || v < 0.8) return null;
  const last = hist[hist.length - 1];
  if (!last || now - last.t > 300) return null;
  const win = hist.filter((q) => now - q.t <= span);
  if (win.length < 6) return null;
  const mean = (a) => a.reduce((s, q) => s + q.w, 0) / a.length;
  const r = mean(win), h = win.length >> 1, r1 = mean(win.slice(0, h)), r2 = mean(win.slice(h));
  if (r1 * r2 <= 0 || Math.min(Math.abs(r1), Math.abs(r2)) < 0.5 * Math.abs(r)) return null;
  const recent = hist.filter((q) => now - q.t <= 150); // the latest 150 ms: what the turn is doing right now
  return recent.length >= 3 ? mean(recent) : r;
}

// Learns whether the gyro's sign matches the compass's (+ = turning right) by watching both during real turns.
export const newCalib = () => ({ sum: 0 });
export function calibUpdate(c, gyro, compass) {
  if (Math.abs(compass) > 10 && Math.abs(gyro) > 5) c.sum = clamp(c.sum + Math.sign(gyro * compass) * Math.min(Math.abs(compass), 40), -1000, 1000);
}
export const calibSign = (c) => (Math.abs(c.sum) >= 150 ? Math.sign(c.sum) : 0); // 0 = not sure yet: keep using the compass
