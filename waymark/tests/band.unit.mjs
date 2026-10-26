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
