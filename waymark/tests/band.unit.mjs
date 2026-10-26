// Small checks on the planner's blending. node tests/band.unit.mjs
import assert from 'node:assert/strict';
import { planBand, ROUTE_WEIGHT } from '../js/band.js';
const base = { now: 1000, v: 5, rate: 0, lane: null };
const near = (a, b) => a.every((x, i) => Math.abs(x - b[i]) < 1e-9);
// route + model: blended with the per-distance weights
let o = planBand(null, { ...base, path: [0, 0, 0], route: [-2, -4, -6] });
assert.ok(near(o.ys, [-2, -4, -6].map((y, i) => ROUTE_WEIGHT[i] * y)), 'blend');
// no route: the model alone
o = planBand(null, { ...base, path: [1, 2, 3], route: null });
assert.ok(near(o.ys, [1, 2, 3]), 'model alone');
// slow: the route itself, the model ignored
o = planBand(null, { ...base, v: 0.5, path: [9, 9, 9], route: [-1, -2, -3] });
assert.ok(near(o.ys, [-1, -2, -3]), 'route when slow');
// slow and no route: nothing to show but a straight band
o = planBand(null, { ...base, v: 0.5, path: [9, 9, 9], route: null });
assert.ok(near(o.ys, [0, 0, 0]), 'straight when unknown');
// never past ~35 degrees sideways, whatever comes in
o = planBand(null, { ...base, path: [50, 50, 50], route: null });
assert.ok(o.ys.every((y, i) => Math.abs(y) <= 0.7 * [5, 10, 15][i] + 1e-9), 'clamped');
// model and route far apart: the band fades (confidence drops over a few updates)
let st = null; for (let i = 0; i < 12; i++) st = planBand(st, { ...base, now: 1000 + i * 100, path: [8, 0, 0], route: [-8, 0, 0] }).state;
assert.ok(st.conf < 0.6, 'fades when the model and the route disagree');
// lane smoothing happens once per AI look, not on every redraw
const lane = (x) => ({ x: [x, x, x] });
st = planBand(null, { ...base, lane: lane(0.5), lookId: 1 }).state;
const a = planBand(st, { ...base, now: 1100, lane: lane(0.6), lookId: 2 });
const b = planBand(a.state, { ...base, now: 1200, lane: lane(0.6), lookId: 2 });
assert.ok(Math.abs(a.laneX[0] - 0.535) < 1e-9 && near(b.laneX, a.laneX), 'one step per look');
console.log('PASS');

// ---- obstacles and rules
import { avoidCars, nearestStop } from '../js/band.js';
const D = [5, 10, 15];
// a parked car just ahead of the line of the band: the band moves away from it, and keeps going
let a2 = avoidCars([0, 0, 0], [{ dist: 8, side: 0.3, moving: false }], { v: 5 });
assert.ok(a2.ys[1] > 1 && a2.stopAt == null, 'passes a parked car (moves left, since it is just right of the line)');
a2 = avoidCars([0, 0, 0], [{ dist: 8, side: -0.3, moving: false }], { v: 5 });
assert.ok(a2.ys[1] < -1, 'moves right when the car is just left of the line');
// a car parked well out to the side: nothing changes
a2 = avoidCars([0, 0, 0], [{ dist: 8, side: 3.5, moving: false }], { v: 5 });
assert.deepEqual(a2.ys, [0, 0, 0]);
// parked on one side and another car on the other: no room, the band ends behind the first
a2 = avoidCars([0, 0, 0], [{ dist: 8, side: 0.3, moving: false }, { dist: 8, side: -1.8, moving: false }], { v: 5 });
assert.ok(a2.stopAt != null && a2.stopAt <= 5.0001, 'stops short when boxed in');
// a moving car in the lane: the band ends behind it at 3 m + 1.5 s of speed (5 m/s -> 10.5 m)
a2 = avoidCars([0, 0, 0], [{ dist: 14, side: 0, moving: true }], { v: 5 });
assert.ok(Math.abs(a2.stopAt - 3.5) < 1e-9 && a2.slow, 'follows a moving car');
// a far moving car: no stop yet
a2 = avoidCars([0, 0, 0], [{ dist: 24, side: 0, moving: true }], { v: 2 });
assert.equal(a2.stopAt, null);
// the nearest stop wins
assert.equal(nearestStop(null, 12, 6, null), 6);
assert.equal(nearestStop(null, null), null);
console.log('PASS (obstacles)');
// a car dead centre in the path: still passes it (1.5 m is room enough), doesn't stop
a2 = avoidCars([0, 0, 0], [{ dist: 9, side: 0, moving: false }], { v: 5 });
assert.ok(a2.stopAt == null && a2.ys[1] > 1.2, 'passes a car right in the path');
console.log('PASS (centre)');
