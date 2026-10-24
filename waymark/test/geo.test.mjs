// node --test waymark/test
import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareTrack, detectTurns, buildCues, snapToTrack, bearing, turnAngle, formatDistance, atTime } from '../js/geo.js';

// Walk at 1.4 m/s along legs given as [bearingDeg, meters], one fix per second,
// with optional GPS jitter in meters.
function walk(legs, { jitter = 0, seed = 1 } = {}) {
  let rnd = seed;
  const noise = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647 - 0.5) * 2 * jitter;
  let lat = 40.7, lng = -74.0, t = 0;
  const pts = [[0, lat, lng, 5]];
  for (const [deg, meters] of legs) {
    const steps = Math.round(meters / 1.4);
    for (let i = 0; i < steps; i++) {
      lat += (1.4 * Math.cos(deg * Math.PI / 180)) / 111320;
      lng += (1.4 * Math.sin(deg * Math.PI / 180)) / (111320 * Math.cos(lat * Math.PI / 180));
      t += 1;
      pts.push([t, lat + noise() / 111320, lng + noise() / 85000, 5]);
    }
  }
  return pts;
}

test('bearing and turnAngle conventions', () => {
  assert.ok(Math.abs(bearing({ lat: 0, lng: 0 }, { lat: 1, lng: 0 })) < 0.01); // north
  assert.ok(Math.abs(bearing({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }) - 90) < 0.01); // east
  assert.equal(turnAngle(350, 10), 20);
  assert.equal(turnAngle(10, 350), -20);
});

test('L-shaped walk: one right turn at the corner', () => {
  const pts = prepareTrack(walk([[0, 100], [90, 100]]));
  const turns = detectTurns(pts);
  assert.equal(turns.length, 1, JSON.stringify(turns));
  assert.equal(turns[0].side, 'right');
  assert.equal(turns[0].kind, 'turn');
  assert.ok(Math.abs(turns[0].d - 100) < 15, `corner at ${turns[0].d}`);
});

test('north, west, north: left then right', () => {
  const turns = detectTurns(prepareTrack(walk([[0, 80], [270, 80], [0, 80]])));
  assert.deepEqual(turns.map((t) => t.side), ['left', 'right']);
});

test('straight walk with 4 m GPS jitter has no turns', () => {
  const turns = detectTurns(prepareTrack(walk([[45, 300]], { jitter: 4 })));
  assert.equal(turns.length, 0, JSON.stringify(turns));
});

test('jittery corner still detected once', () => {
  const turns = detectTurns(prepareTrack(walk([[0, 120], [90, 120]], { jitter: 3, seed: 7 })));
  assert.equal(turns.length, 1, JSON.stringify(turns));
  assert.equal(turns[0].side, 'right');
});

test('gentle 40 degree bend is a bear, U-turn is a U-turn', () => {
  const bear = detectTurns(prepareTrack(walk([[0, 100], [40, 100]])));
  assert.equal(bear.length, 1);
  assert.equal(bear[0].kind, 'slight');
  const u = detectTurns(prepareTrack(walk([[0, 100], [180, 100]])));
  assert.equal(u.length, 1);
  assert.equal(u[0].kind, 'uturn');
});

test('cues are ordered start, turn, note, arrive', () => {
  const pts = prepareTrack(walk([[0, 100], [90, 100]]));
  const cues = buildCues(pts, [{ t: 120, text: 'Blue door' }], { to: 'Cafe' });
  assert.deepEqual(cues.map((c) => c.type), ['start', 'turn', 'note', 'arrive']);
  assert.equal(cues.at(-1).text, 'Arrive at Cafe');
});

test('snapToTrack finds progress and off-route distance', () => {
  const pts = prepareTrack(walk([[0, 100], [90, 100]]));
  const onCorner = atTime(pts, 71);
  const s = snapToTrack(pts, { lat: onCorner.lat, lng: onCorner.lng + 20 / 85000 });
  assert.ok(s.off < 25, `off ${s.off}`);
  const far = snapToTrack(pts, { lat: 40.7, lng: -74.0 + 300 / 85000 });
  assert.ok(far.off > 100);
});

test('out-and-back route: near hint keeps progress on the return leg', () => {
  const pts = prepareTrack(walk([[0, 100], [180, 100]]));
  const back = atTime(pts, 120); // ~32 m into the return leg
  const s = snapToTrack(pts, back, 140);
  assert.ok(s.d > 120, `snapped to d=${s.d}`);
});

test('formatDistance in both unit systems', () => {
  assert.equal(formatDistance(30, { imperial: false }), '30 m');
  assert.equal(formatDistance(2500, { imperial: false }), '2.5 km');
  assert.equal(formatDistance(30, { imperial: true }), '100 ft');
  assert.equal(formatDistance(1609.344 * 1.5, { imperial: true }), '1.5 mi');
});
