// Replays recorded rides through the band logic (js/band.js, the same code the phone runs) and scores it.
//   node tests/band.replay.mjs /path/to/waymark-ai/data
// Each ride's telemetry.csv gives time, speed, GPS track and (on newer rides) the phone's compass. The compass is
// stepped at 10 Hz like the phone's timer; truth = where the rider really ended up 5/10/15 m on, as metres to the
// left of the way the phone faced.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { turnRateFrom, smoothRate, turnArc, planBand, DISTS } from '../js/band.js';

const DATA = process.argv[2] || '/home/user/waymark-ai/data';
const wrap = (a) => ((a + 540) % 360) - 180;
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : NaN; };
const num = (x) => (x === '' || x == null ? null : Number(x));

function load(id) {
  const f = `${DATA}/${id}/telemetry.csv`;
  if (!existsSync(f)) return null;
  const [head, ...lines] = readFileSync(f, 'utf8').trim().split('\n'); const cols = head.split(',');
  const rows = lines.map((l) => Object.fromEntries(l.split(',').map((v, i) => [cols[i], v])))
    .map((r) => ({ t: num(r.t_s), lat: num(r.lat), lng: num(r.lng), acc: num(r.accuracy_m) ?? 99, v: num(r.speed_mps) ?? 0, gh: num(r.heading_deg), c: num(r.compass_deg) }))
    .filter((r) => r.t != null && r.lat != null);
  return rows.length > 20 && rows.filter((r) => r.c != null).length > 20 ? rows : null;
}

// where the rider was 5/10/15 m further along, left of the facing direction (null if unknown)
function truthAt(rows, k, facing) {
  const lat0 = rows[k].lat, m = [111320, 111320 * Math.cos(lat0 * Math.PI / 180)];
  const P = rows.slice(k).map((r) => [(r.lat - rows[k].lat) * m[0], (r.lng - rows[k].lng) * m[1]]);
  const h = facing * Math.PI / 180, left = [Math.sin(h), -Math.cos(h)];
  const out = []; let d = 0, j = 1;
  for (const want of DISTS) {
    while (j < P.length && d + Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]) < want) { d += Math.hypot(P[j][0] - P[j - 1][0], P[j][1] - P[j - 1][1]); j++; }
    if (j >= P.length || rows[k + j].t - rows[k].t > 8 || Math.max(...rows.slice(k, k + j + 1).map((r) => r.acc)) > 12) return null;
    out.push(P[j][0] * left[0] + P[j][1] * left[1]);
  }
  return out;
}

// the compass at time t (linear between samples, around the circle)
function compassAt(rows, t) {
  let i = rows.findIndex((r) => r.t > t); if (i <= 0) return null;
  const a = rows[i - 1], b = rows[i]; if (a.c == null || b.c == null || b.t - a.t > 3) return null;
  return a.c + wrap(b.c - a.c) * (t - a.t) / (b.t - a.t);
}
const speedAt = (rows, t) => { const i = rows.findIndex((r) => r.t > t); return i <= 0 ? 0 : rows[i - 1].v + (rows[i].v - rows[i - 1].v) * (t - rows[i - 1].t) / (rows[i].t - rows[i - 1].t || 1); };

// the way the logic worked before today's fixes: any 5 deg/s over 0.8 s counts, switched on or off
function oldArc(hist, v, now) {
  if (hist.length < 6 || v < 0.8) return [0, 0, 0];
  const last = hist.at(-1), old = hist.find((q) => now - q.t <= 800) || hist[0], dt = (last.t - old.t) / 1000; if (dt < 0.4) return [0, 0, 0];
  const r = wrap(last.h - old.h) / dt; if (Math.abs(r) < 5) return [0, 0, 0];
  return DISTS.map((d) => Math.max(-0.8 * d, Math.min(0.8 * d, -(r * Math.PI / 180) / Math.max(v, 1.5) * d * d / 2)));
}

function run(rows, { wobble = 0 } = {}) {
  const hist = []; let rate = 0, st = null; const out = [];
  const t0 = rows[0].t, t1 = rows.at(-1).t - 9;
  for (let t = t0 + 2; t < t1; t += 0.1) {
    const c = compassAt(rows, t); if (c == null) continue;
    const now = t * 1000, v = speedAt(rows, t);
    hist.push({ t: now, h: (c + wobble * Math.sin(t * 2 * Math.PI * 2.3) + (wobble ? (Math.sin(t * 17.3) * wobble) / 3 : 0) + 360) % 360 });
    while (hist.length && now - hist[0].t > 1500) hist.shift();
    rate = smoothRate(rate, turnRateFrom(hist, v, now));
    const band = planBand(st, { now, v, rate, path: null, lane: { x: [0.5, 0.5, 0.5] }, lookId: Math.floor(t / 2) });
    st = band.state;
    const k = rows.findIndex((r) => r.t >= t); if (k < 0 || v < 2) continue;
    out.push({ t, v, c, ys: band.ys, old: oldArc(hist, v, now), k, conf: band.conf });
  }
  return out;
}

const ids = readdirSync(DATA).filter((id) => load(id));
const stats = { n: 0, turn: 0, rightNew: 0, rightOld: 0, missNew: [], missOld: [], missStraight: [], tMissNew: [], tMissOld: [], tMissStraight: [], bendNew: 0, bendOld: 0, bendNewW: 0, bendOldW: 0, straight: 0, over: 0 };
for (const id of ids) {
  const rows = load(id);
  // how this phone sat on the bars: compass minus the GPS heading while riding steadily
  const offs = rows.filter((r) => r.v > 3 && r.gh != null && r.c != null).map((r) => wrap(r.c - r.gh)); if (offs.length < 8) continue;
  const off = med(offs.map((o) => wrap(o - offs[0]))) + offs[0];
  for (const [wob, key] of [[0, ''], [6, 'W']]) {
    for (const o of run(rows, { wobble: wob })) {
      const tr = truthAt(rows, o.k, o.c - off); if (!tr) continue;
      if (!wob) {
        stats.n++; stats.missNew.push(Math.abs(o.ys[1] - tr[1])); stats.missOld.push(Math.abs(o.old[1] - tr[1])); stats.missStraight.push(Math.abs(tr[1]));
        if (Math.abs(tr[1]) > 2) { stats.turn++; stats.tMissNew.push(Math.abs(o.ys[1] - tr[1])); stats.tMissOld.push(Math.abs(o.old[1] - tr[1])); stats.tMissStraight.push(Math.abs(tr[1]));
          if (Math.sign(o.ys[1]) === Math.sign(tr[1])) stats.rightNew++; if (Math.sign(o.old[1]) === Math.sign(tr[1])) stats.rightOld++; }
        if (o.ys.some((y, i) => Math.abs(y) > 0.8 * DISTS[i] + 1e-9)) stats.over++;
      }
      if (Math.abs(tr[1]) < 0.7 && Math.abs(tr[2]) < 1.2) { // truly straight: any bend is a false one (the zig-zag)
        if (!wob) stats.straight++;
        if (Math.abs(o.ys[1]) > 1) stats['bendNew' + key]++; if (Math.abs(o.old[1]) > 1) stats['bendOld' + key]++;
      }
    }
  }
}
const q = (n, d) => (100 * n / d).toFixed(1) + '%';
const m = (a) => med(a).toFixed(2);
console.log(`${ids.length} rides with a compass, ${stats.n} scored moments (2+ m/s), ${stats.turn} of them in a turn, ${stats.straight} on straight road`);
console.log(`median miss at 10 m   all moments:  new ${m(stats.missNew)}   before-fixes ${m(stats.missOld)}   straight-line guess ${m(stats.missStraight)}`);
console.log(`median miss at 10 m   in turns:      new ${m(stats.tMissNew)}   before-fixes ${m(stats.tMissOld)}   straight-line guess ${m(stats.tMissStraight)}`);
console.log(`bends the right way   in turns:      new ${q(stats.rightNew, stats.turn)}   before-fixes ${q(stats.rightOld, stats.turn)}`);
console.log(`FALSE bends on straight road (band >1 m off at 10 m):  clean compass: new ${q(stats.bendNew, stats.straight)} / before ${q(stats.bendOld, stats.straight)};   wobbly compass (+-6 deg shake): new ${q(stats.bendNewW, stats.straight)} / before ${q(stats.bendOldW, stats.straight)}`);
console.log(`band ever past the allowed sideways limit: ${stats.over} moments`);
// pass / fail
const bad = [];
if (stats.bendNewW / stats.straight > 0.03) bad.push('a shaky compass still bends the band on straight road');
if (stats.bendNew / stats.straight > 0.03) bad.push('false bends on straight road with a clean compass');
if (stats.over) bad.push('the band went past its sideways limit');
if (stats.rightNew / stats.turn < 0.6) bad.push('bends the right way in too few turns');
console.log(bad.length ? 'FAIL: ' + bad.join('; ') : 'PASS');
process.exit(bad.length ? 1 : 0);
