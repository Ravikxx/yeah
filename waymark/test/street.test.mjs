import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, findView, viewOptions, coverageLines, matchPlan } from '../js/street.js';

// Drive at 8 m/s along legs [bearingDeg, meters] from a start point, one fix per second.
const M_LAT = 1 / 111320;
const M_LNG = 1 / (111320 * Math.cos(40.75 * Math.PI / 180));
function drive(start, legs, speed = 8) {
  let [lat, lng] = start, t = 0;
  const track = [[0, lat, lng, 5]];
  for (const [deg, meters] of legs) {
    for (let i = 0; i < Math.round(meters / speed); i++) {
      lat += speed * Math.cos(deg * Math.PI / 180) * M_LAT;
      lng += speed * Math.sin(deg * Math.PI / 180) * M_LNG;
      track.push([++t, lat, lng, 5]);
    }
  }
  return track;
}
const at = (start, north, east) => ({ lat: start[0] + north * M_LAT, lng: start[1] + east * M_LNG });

const O = [40.75, -73.99];
// Main St runs north 400 m. Driven north once (seg "up") and south once ("down", 4 m to the side like the other lane).
const up = { id: 'up', createdAt: 1, track: drive(O, [[0, 400]]) };
const down = { id: 'down', createdAt: 2, track: drive([O[0] + 400 * M_LAT, O[1] + 4 * M_LNG], [[180, 400]]) };
// Cross St runs east from Main St at 200 m north, driven east only.
const cross = { id: 'cross', createdAt: 3, track: drive([O[0] + 200 * M_LAT, O[1]], [[90, 300]]) };

test('facing north shows the northbound pass, facing south the southbound one', () => {
  const idx = buildIndex([up, down, cross]);
  const p = at(O, 100, 2);
  const n = findView(idx, p, 0);
  const s = findView(idx, p, 180);
  assert.equal(n.id, 'up');
  assert.equal(s.id, 'down');
  // The northbound pass reaches 100 m at about t = 12.5 s (8 m/s).
  assert.ok(Math.abs(n.t - 12.5) < 1.5, `t=${n.t}`);
});

test('no view when nothing was recorded going that way', () => {
  const idx = buildIndex([up]);
  assert.equal(findView(idx, at(O, 100, 0), 180), null);
  assert.equal(findView(idx, at(O, 100, 0), 90), null);
  assert.equal(findView(idx, at(O, 100, 200), 0), null); // 200 m away
});

test('arrows: ahead, turn around and a right turn at the crossing', () => {
  const idx = buildIndex([up, down, cross]);
  const v = findView(idx, at(O, 200, 0), 0);
  const o = viewOptions(idx, v);
  assert.equal(o.ahead.id, 'up');
  assert.ok(o.ahead.d > v.d);
  assert.equal(o.behind.id, 'down');
  assert.equal(o.right?.id, 'cross');
  assert.equal(o.left, null); // Cross St was never driven westbound
});

test('one-way street: turn around is unavailable', () => {
  const idx = buildIndex([up]);
  const o = viewOptions(idx, findView(idx, at(O, 150, 0), 0));
  assert.equal(o.behind, null);
});

test('coverage lines: Main St both ways, Cross St one way', () => {
  const lines = coverageLines(buildIndex([up, down, cross]));
  const main = lines.filter((l) => l.id === 'up');
  const crossLines = lines.filter((l) => l.id === 'cross');
  const bothShare = (ls) => {
    const n = ls.reduce((a, l) => a + l.latlngs.length, 0);
    return ls.filter((l) => l.both).reduce((a, l) => a + l.latlngs.length, 0) / n;
  };
  assert.ok(bothShare(main) > 0.8, `main both-ways share ${bothShare(main)}`);
  assert.ok(bothShare(crossLines) < 0.15, `cross both-ways share ${bothShare(crossLines)}`);
});

test('planned trip north then east is fully covered in two runs', () => {
  const idx = buildIndex([up, down, cross]);
  const plan = [[O[0], O[1]], [O[0] + 200 * M_LAT, O[1]], [O[0] + 200 * M_LAT, O[1] + 300 * M_LNG]];
  const m = matchPlan(idx, plan);
  assert.ok(m.covered > 0.9, `covered ${m.covered}`);
  const footage = m.runs.filter((r) => r.id);
  assert.deepEqual(footage.map((r) => r.id), ['up', 'cross']);
  assert.ok(footage[0].t1 > footage[0].t0);
});

test('planned trip the wrong way down a one-way capture is a gap', () => {
  const idx = buildIndex([up, cross]);
  const plan = [[O[0] + 200 * M_LAT, O[1] + 300 * M_LNG], [O[0] + 200 * M_LAT, O[1]]]; // westbound on Cross St
  const m = matchPlan(idx, plan);
  assert.ok(m.covered < 0.2, `covered ${m.covered}`);
});
