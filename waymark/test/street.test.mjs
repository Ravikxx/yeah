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
  const main = lines.filter((l) => l.id === 'down' || l.id === 'up');
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

test('covered length counts a street once, however many passes', async () => {
  const { coveredLength } = await import('../js/street.js');
  // Main St 400 m driven both ways (twice northbound) + Cross St 300 m one way.
  const up2 = { id: 'up2', createdAt: 4, track: drive([O[0] + 1 * M_LAT, O[1] + 1 * M_LNG], [[0, 400]]) };
  const len = coveredLength(coverageLines(buildIndex([up, down, up2, cross])));
  assert.ok(Math.abs(len.any - 700) < 80, `any ${len.any}`);
  assert.ok(Math.abs(len.both - 400) < 60, `both ${len.both}`);
});

// Realistic: the two directions 10 m apart (opposite lanes) with drifting GPS error.
function lane(track, east, seed) {
  let r = seed, bx = 0, by = 0;
  const rnd = () => ((r = (r * 16807) % 2147483647) / 2147483647 - 0.5);
  return track.map(([t, lat, lng, acc]) => {
    bx = Math.max(-4, Math.min(4, bx + rnd())); by = Math.max(-4, Math.min(4, by + rnd()));
    return [t, lat + (by + rnd() * 3) * M_LAT, lng + (east + bx + rnd() * 3) * M_LNG, acc];
  });
}

test('both directions a lane apart draw as one green line, counted once', async () => {
  const { coveredLength } = await import('../js/street.js');
  const north = { id: 'n1', createdAt: 1, track: lane(drive(O, [[0, 400]]), -5, 3) };
  const south = { id: 's1', createdAt: 2, track: lane(drive([O[0] + 400 * M_LAT, O[1]], [[180, 400]]), 5, 9) };
  const north2 = { id: 'n2', createdAt: 3, track: lane(drive(O, [[0, 400]]), -3, 17) };
  const lines = coverageLines(buildIndex([north, south, north2]));
  const ids = new Set(lines.map((l) => l.id));
  assert.deepEqual([...ids], ['n1'], `drawn from ${[...ids]}`); // one pass drawn, the lowest id
  const len = coveredLength(lines);
  assert.ok(Math.abs(len.any - 400) < 50, `any ${len.any}`);
  assert.ok(len.both > 330, `both ${len.both}`);
});

test('a crossing street is still drawn at the intersection', () => {
  const lines = coverageLines(buildIndex([up, down, cross]));
  assert.ok(lines.some((l) => l.id === 'cross'), 'cross street missing');
});

test('no gaps where recordings start and stop at different places', async () => {
  const { coveredLength } = await import('../js/street.js');
  // Westbound-style pass split into pieces at 230 m; the other direction split at 130 m.
  const fullN = lane(drive(O, [[0, 400]]), -5, 5);
  const fullS = lane(drive([O[0] + 400 * M_LAT, O[1]], [[180, 400]]), 5, 7);
  const cut = (tr, m) => { const k = Math.round(m / 8); return [tr.slice(0, k + 1), tr.slice(k).map(([t, a, b, c]) => [t - tr[k][0], a, b, c])]; };
  const [n1, n2] = cut(fullN, 230), [s1, s2] = cut(fullS, 130);
  const segs = [{ id: 'm', track: n1 }, { id: 'b', track: n2 }, { id: 'z', track: s1 }, { id: 'a', track: s2 }];
  const lines = coverageLines(buildIndex(segs));
  // A gap is a stretch of the street that no drawn line SEGMENT covers.
  // Project each segment onto the street (it runs due north), merge the
  // intervals, and find the longest uncovered stretch.
  const spans = lines.flatMap((l) => l.latlngs.slice(1).map(([lat], i) => {
    const a = (l.latlngs[i][0] - O[0]) / M_LAT, b = (lat - O[0]) / M_LAT;
    return [Math.min(a, b), Math.max(a, b)];
  })).sort((x, y) => x[0] - y[0]);
  let reach = 30, worst = 0, at = 0;
  for (const [a, b] of spans) {
    if (b < 30) continue;
    if (a > 370) break;
    if (a > reach && a - reach > worst) { worst = a - reach; at = reach; }
    reach = Math.max(reach, b);
  }
  if (reach < 370 && 370 - reach > worst) { worst = 370 - reach; at = reach; }
  assert.ok(worst === 0, `uncovered stretch of ${worst.toFixed(1)} m at ${at.toFixed(0)} m`);
  const len = coveredLength(lines);
  assert.ok(Math.abs(len.any - 400) < 50, `any ${len.any}`);
});

test('a street captured both ways is drawn down its middle, without jogs', () => {
  const N = lane(drive(O, [[0, 400]]), -5, 21), S = lane(drive([O[0] + 400 * M_LAT, O[1]], [[180, 400]]), 5, 23);
  const cutAt = (tr, m) => { const k = Math.round(m / 8); return [tr.slice(0, k + 1), tr.slice(k).map(([t, a, b, c]) => [t - tr[k][0], a, b, c])]; };
  const [n1, n2] = cutAt(N, 150), [s1, s2] = cutAt(S, 220);
  const lines = coverageLines(buildIndex([{ id: 'q', track: n1 }, { id: 'c', track: n2 }, { id: 'k', track: s1 }, { id: 'f', track: s2 }]));
  const pts = lines.flatMap((l) => l.latlngs).map(([lat, lng]) => ({ m: (lat - O[0]) / M_LAT, east: (lng - O[1]) / M_LNG }))
    .filter((p) => p.m > 30 && p.m < 370).sort((a, b) => a.m - b.m);
  const maxOff = Math.max(...pts.map((p) => Math.abs(p.east)));
  let maxJog = 0;
  for (let i = 1; i < pts.length; i++) maxJog = Math.max(maxJog, Math.abs(pts[i].east - pts[i - 1].east));
  assert.ok(maxOff < 4, `drawn up to ${maxOff.toFixed(1)} m off the middle (lanes are 5 m either side)`);
  assert.ok(maxJog < 4, `sideways jog of ${maxJog.toFixed(1)} m between neighbors`);
});

test('a stop where the rider scanned left and right shows the facing-ahead moment', () => {
  // North 100 m at 8 m/s, stop 6 s at 100 m (looking left, then right), north again.
  const a = drive(O, [[0, 96]]);
  const [t0, lat, lng] = a[a.length - 1];
  // GPS creeps ~0.8 m per fix while stopped, so the 100 m sample lands mid-scan.
  const looks6 = [[0, 0], [300, -60], [300, -60], [60, 60], [60, 60], [0, 0]];
  const stop = looks6.map(([c, l], k) => [t0 + k + 1, lat + 0.8 * (k + 1) * M_LAT, lng, 5, 0, 0, c, l]);
  const b = drive([stop[5][1], lng], [[0, 96]]).slice(1).map(([t, la, ln, acc]) => [t + t0 + 6, la, ln, acc, 8, 0, 0, 0]);
  const idx = buildIndex([{ id: 'scan', createdAt: 1, track: [...a, ...stop, ...b] }]);
  const looks = new Map([...a, ...stop, ...b].map((p) => [p[0], p[7] ?? 0]));
  for (const s of idx.segs[0].samples) {
    const near = [...looks.keys()].reduce((x, k) => (Math.abs(k - s.t) < Math.abs(x - s.t) ? k : x));
    assert.ok(Math.abs(looks.get(near)) <= 35, `sample at ${s.d.toFixed(0)} m uses a sideways frame (t=${s.t})`);
  }
});
