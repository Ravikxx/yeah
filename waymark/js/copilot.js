// Co-pilot: runs the Waymark driving model on this phone, about once a second,
// on the Drive camera, and says what it would do. Nothing leaves the phone.
//
// Same inputs as training (waymark-ai/v2/see.py + train2.py), in the same order:
//   picture summary now and its change from 1 s ago (ResNet-18, above the handlebars) 512+512
//   stop sign, traffic light (+ red / green), car ahead                                9
//   stop sign in the last 3 looks                                                      2
//   what the last left/right scan showed (10 s) and the camera angle now               7
//   how cars moved since the last look                                                 4
//   zoomed look at the sign area (stop sign, light colour); speed limit, bike target   5+2
//   directions: next turn, metres to it, metres to destination                        10
// then scaler + PCA on the picture part, and gradient-boosted trees.

const ORT = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.20.1/dist/';
const FILES = { resnet: 'ai/model/resnet18.onnx', detector: 'ai/model/detector.onnx', trees: 'ai/model/model.json?v=4' }; // bump ?v= when retrained
const CACHE = 'waymark-copilot-v2';
const COCO = { 13: 'stop', 10: 'light', 3: 'car', 8: 'car', 6: 'car', 4: 'car' };
const CROP = 0.72, MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225];

let ort = null, R = null, D = null, M = null;

// ---------- loading ----------
async function fetchCached(url, onBytes) {
  let cache = null;
  try { cache = await caches.open(CACHE); const hit = await cache.match(url); if (hit) return hit.arrayBuffer(); } catch { /* no Cache Storage */ }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn’t download the co-pilot model (${res.status})`);
  const total = Number(res.headers.get('Content-Length')) || 0;
  const reader = res.body.getReader(); const parts = []; let got = 0;
  for (;;) { const { done, value } = await reader.read(); if (done) break; parts.push(value); got += value.length; onBytes(value.length, total); }
  const buf = new Uint8Array(got); let o = 0; for (const p of parts) { buf.set(p, o); o += p.length; }
  try { await cache?.put(url, new Response(buf)); } catch { /* storage full: download again next time */ }
  return buf.buffer;
}

export async function load(onProgress = () => {}) {
  if (M) return;
  ort = await import(`${ORT}ort.min.mjs`);
  ort.env.wasm.wasmPaths = ORT;
  ort.env.wasm.numThreads = 1; // GitHub Pages can't enable multi-threaded WebAssembly
  let got = 0; const approx = 125e6;
  const bump = (n) => { got += n; onProgress(Math.min(0.99, got / approx)); };
  const [r, d, t] = await Promise.all([fetchCached(FILES.resnet, bump), fetchCached(FILES.detector, bump), fetchCached(FILES.trees, bump)]);
  R = await ort.InferenceSession.create(r, { executionProviders: ['wasm'] });
  D = await ort.InferenceSession.create(d, { executionProviders: ['wasm'] });
  M = JSON.parse(new TextDecoder().decode(t));
  onProgress(1);
}

// ---------- seeing ----------
const cv = document.createElement('canvas'), cx = cv.getContext('2d', { willReadFrequently: true });

function grab(video) {
  const W = video.videoWidth, H = video.videoHeight;
  cv.width = W; cv.height = H; cx.drawImage(video, 0, 0, W, H);
  return { W, H, px: cx.getImageData(0, 0, W, H).data };
}

// torchvision: crop top 72%, resize shorter side to 256, centre-crop 224, normalise
async function embed(video, W, H) {
  const ch = Math.round(H * CROP), s = 256 / Math.min(W, ch);
  const rw = Math.round(W * s), rh = Math.round(ch * s);
  const c = document.createElement('canvas'); c.width = 224; c.height = 224;
  const g = c.getContext('2d'); g.imageSmoothingQuality = 'high';
  g.drawImage(video, 0, 0, W, ch, -(rw - 224) / 2, -(rh - 224) / 2, rw, rh);
  const p = g.getImageData(0, 0, 224, 224).data, n = 224 * 224, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) x[k * n + i] = (p[i * 4 + k] / 255 - MEAN[k]) / STD[k];
  const out = await R.run({ image: new ort.Tensor('float32', x, [1, 3, 224, 224]) });
  return Array.from(out.emb.data);
}

function hsv255(r, g, b) { // PIL's HSV: all three in 0..255
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  let h = 0;
  if (d) h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [((h * 60 + 360) % 360) / 360 * 255, mx ? d / mx * 255 : 0, mx];
}

function lightColor(px, W, box) {
  const [x0, y0, x1, y1] = box.map(Math.round); let red = 0, green = 0, n = 0;
  for (let y = Math.max(0, y0); y < Math.max(y1, y0 + 1); y++) for (let x = Math.max(0, x0); x < Math.max(x1, x0 + 1); x++) {
    const i = (y * W + x) * 4, [h, s, v] = hsv255(px[i], px[i + 1], px[i + 2]); n++;
    if (s > 90 && v > 150) { if (h < 14 || h > 235) red++; else if (h > 80 && h < 140) green++; }
  }
  return [red / Math.max(1, n), green / Math.max(1, n)];
}

async function detect(img) {
  const { W, H, px } = img, n = W * H, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = px[i * 4] / 255; x[n + i] = px[i * 4 + 1] / 255; x[2 * n + i] = px[i * 4 + 2] / 255; }
  const o = await D.run({ image: new ort.Tensor('float32', x, [3, H, W]) });
  const line = H * (H > W ? 0.62 : 0.75), out = [];
  for (let i = 0; i < o.scores.data.length; i++) {
    const cls = COCO[Number(o.labels.data[i])], b = Array.from(o.boxes.data.slice(i * 4, i * 4 + 4));
    if (!cls || (b[1] + b[3]) / 2 > line) continue;
    const d = { cls, score: o.scores.data[i], box: b };
    if (cls === 'light') d.rgb = lightColor(px, W, b);
    out.push(d);
  }
  return out;
}

// ---------- zoomed look for signs ----------
// Stop signs (and lights) sit on the right, about a third of the way down. The
// detector shrinks every picture to 512 px, so a far sign is a few pixels; a
// crop of that area gets ~2.75x zoom and finds signs ~2-3 s earlier.
const ZOOM = [0.55, 0.18, 1.0, 0.47]; // x0, y0, x1, y1 as fractions of the frame
const SIGN_M = 0.76; // a stop sign is 30 in across

export async function signs(video, hfovDeg = 90) {
  const W = video.videoWidth, H = video.videoHeight;
  const [x0, y0, x1, y1] = [ZOOM[0] * W, ZOOM[1] * H, ZOOM[2] * W, ZOOM[3] * H].map(Math.round);
  const w = x1 - x0, h = y1 - y0;
  cv.width = w; cv.height = h; cx.drawImage(video, x0, y0, w, h, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data, n = w * h, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = px[i * 4] / 255; x[n + i] = px[i * 4 + 1] / 255; x[2 * n + i] = px[i * 4 + 2] / 255; }
  const o = await D.run({ image: new ort.Tensor('float32', x, [3, h, w]) });
  const f = (W / 2) / Math.tan(hfovDeg * Math.PI / 360); // focal length in pixels
  let stop = null, light = null, red = 0, green = 0;
  for (let i = 0; i < o.scores.data.length; i++) {
    const cls = COCO[Number(o.labels.data[i])], sc = o.scores.data[i], b = Array.from(o.boxes.data.slice(i * 4, i * 4 + 4));
    if (cls === 'stop' && sc >= 0.35 && (!stop || sc > stop.score)) stop = { score: sc, dist: f * SIGN_M / Math.max(1, b[2] - b[0]), width: (b[2] - b[0]) / W };
    if (cls === 'light' && sc >= 0.5) {
      const [r, g] = lightColor(px, w, b); red = Math.max(red, r); green = Math.max(green, g);
      if (!light || sc > light.score) light = { score: sc, red: r > g && r > 0.01, green: g > r && g > 0.01 };
    }
  }
  const t = performance.now() / 1000;
  S.zoom = { t, stop: stop ? stop.score : 0, width: stop ? stop.width : 0, red, green };
  S.zoomHist = [...(S.zoomHist || []).filter((z) => t - z.t <= 3), { t, stop: S.zoom.stop }];
  return { stop, light };
}

// ---------- quick motion: which cars are crossing ----------
// Looks a second apart are too far apart for a car crossing a busy road (it's
// gone by the next look). So each full look also grabs a second frame 0.2 s
// later and measures how far each car slid sideways between the two, by
// sliding the car's patch around until it lines up. The background's shift
// (handlebars turning) is measured the same way and taken out.
const GAP_MS = 200;
function gray(px, W, H) { // half size, grayscale
  const w = W >> 1, h = H >> 1, g = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = ((y * 2) * W + x * 2) * 4; g[y * w + x] = 0.3 * px[i] + 0.59 * px[i + 1] + 0.11 * px[i + 2];
  }
  return { g, w, h };
}
// best sideways shift (in half-size pixels) of box b from image A to image B
function shiftOf(A, B, b, maxS) {
  const [x0, y0, x1, y1] = [Math.max(0, b[0] >> 1), Math.max(0, b[1] >> 1), Math.min(A.w - 1, b[2] >> 1), Math.min(A.h - 1, b[3] >> 1)];
  const step = Math.max(1, Math.floor((x1 - x0) * (y1 - y0) / 1500)); // ~1500 sample pixels at most
  let best = 0, bestErr = Infinity;
  const sx = x1 - x0 < 40 ? 1 : 2; // finer steps for small (far) cars
  for (let dx = -maxS; dx <= maxS; dx += sx) for (let dy = -4; dy <= 4; dy += 2) {
    let err = 0, n = 0;
    for (let k = 0, y = y0; y < y1; y++) for (let x = x0; x < x1; x++, k++) {
      if (k % step) continue;
      const xb = x + dx, yb = y + dy;
      if (xb < 0 || xb >= B.w || yb < 0 || yb >= B.h) continue;
      err += Math.abs(A.g[y * A.w + x] - B.g[yb * B.w + xb]); n++;
    }
    if (n > 20 && err / n < bestErr) { bestErr = err / n; best = dx; }
  }
  return best;
}
function crossingCars(A, B, ds, W, H, secs) {
  const bg = shiftOf(A, B, [0, Math.round(H * 0.05), W, Math.round(H * 0.2)], 24); // sky line / buildings
  const out = [];
  for (const d of ds) {
    if (d.cls !== 'car' || d.score < 0.5) continue;
    const dx = shiftOf(A, B, d.box, Math.round(A.w * 0.15)) - bg;
    const v = (dx * 2) / W / secs; // picture widths per second, + = moving right
    const c = (d.box[0] + d.box[2]) / 2 / W;
    const towardOrAcross = (c < 0.5 && v > 0) || (c > 0.5 && v < 0) || (c > 0.25 && c < 0.75);
    if (Math.abs(v) > 0.1 && towardOrAcross && size(d, W, H) > 0.02) out.push({ box: d.box, v, size: size(d, W, H) });
  }
  return out;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- features (mirror see.py) ----------
const size = (x, W, H) => (x ? Math.sqrt(Math.max(0, (x.box[2] - x.box[0]) * (x.box[3] - x.box[1])) / (W * H)) : 0);
const best = (xs, key) => xs.reduce((a, x) => (a == null || key(x) > key(a) ? x : a), null);

function detFeats(ds, W, H) {
  const st = best(ds.filter((x) => x.cls === 'stop' && x.score >= 0.5), (x) => x.score);
  const lt = ds.filter((x) => x.cls === 'light' && x.score >= 0.5), nl = best(lt, (x) => size(x, W, H));
  const cars = ds.filter((x) => x.cls === 'car' && x.score >= 0.5);
  const ca = best(cars.filter((x) => { const c = (x.box[0] + x.box[2]) / 2 / W; return c > 0.3 && c < 0.7; }), (x) => size(x, W, H));
  return [st ? st.score : 0, size(st, W, H), nl ? nl.score : 0, size(nl, W, H),
    Math.max(0, ...lt.map((x) => x.rgb[0])), Math.max(0, ...lt.map((x) => x.rgb[1])), ca ? ca.score : 0, size(ca, W, H), cars.length];
}

// Your own motion taken out: riding forward, everything grows and drifts toward
// the edges (a parked car's offset from the middle grows with its size).
// closing = growth of the nearest car in your path; into = how far a car moved
// toward the middle beyond what a parked car would.
function motionFeats(now, prev, W, H) {
  const cars = (ds) => ds.filter((x) => x.cls === 'car' && x.score >= 0.5);
  const A = cars(now), B = cars(prev);
  if (!A.length) return [0, 0, 0, 0];
  const cx = (x) => (x.box[0] + x.box[2]) / 2 / W, cy = (x) => (x.box[1] + x.box[3]) / 2 / H;
  let closing = 0, into = 0, moving = 0, still = 0;
  for (const a of [...A].sort((p, q) => size(q, W, H) - size(p, W, H))) {
    const sa = size(a, W, H);
    const cand = B.filter((b) => { const r = size(b, W, H) / Math.max(sa, 1e-6); return r > 0.5 && r < 2 && Math.abs(cx(b) - cx(a)) < 0.45 && Math.abs(cy(b) - cy(a)) < 0.1; });
    if (!cand.length) continue;
    const b = best(cand, (q) => -(Math.abs(cx(q) - cx(a)) + Math.abs(cy(q) - cy(a))));
    const sb = size(b, W, H), offA = cx(a) - 0.5, offB = cx(b) - 0.5;
    const stat = offB * sa / Math.max(sb, 1e-6);
    if (Math.abs(offA - stat) > 0.03) moving++; else still++;
    if (sa > 0.05) {
      into = Math.max(into, Math.abs(stat) - Math.abs(offA));
      if (Math.abs(offA) < 0.15) closing = Math.max(closing, sa - sb);
    }
  }
  return [closing, into, moving, still];
}

function scanFeats(hist, now) {
  const L = hist.filter((h) => h.look != null && h.look < -35 && now - h.t <= 10);
  const Rt = hist.filter((h) => h.look != null && h.look > 35 && now - h.t <= 10);
  const mx = (hs, k) => Math.max(0, ...hs.map((h) => h.df[k]));
  const look = hist.length && hist[0].t === now ? hist[0].look : null;
  return [L.length ? 1 : 0, Rt.length ? 1 : 0, mx(L, 7), mx(Rt, 7), mx(L, 8), mx(Rt, 8), look == null ? NaN : look];
}

function navFeats(nav) {
  const ins = (nav?.instruction || '').toLowerCase();
  if (!ins) return [0, 0, 0, 0, 0, 0, 999, 0, 0, 9999];
  const d = Number.isFinite(nav.inM) ? nav.inM : 999;
  const has = (ws) => (ws.some((w) => ins.includes(w)) ? 1 : 0);
  const kind = [has(['turn left', 'slight left', 'sharp left', 'keep left', 'bear left']), has(['turn right', 'slight right', 'sharp right', 'keep right', 'bear right']),
    ins.includes('u-turn') ? 1 : 0, ins.startsWith('arrive') ? 1 : 0, ins.startsWith('off route') ? 1 : 0];
  const near = d < 40 ? 1 : 0;
  return [1, ...kind, Math.min(d, 999), near * kind[0], near * kind[1], Math.min(Number.isFinite(nav.leftM) ? nav.leftM : 9999, 9999)];
}

// ---------- the trained part ----------
function trees(model, z) {
  const k = model.base.length, raw = model.base.slice();
  for (const it of model.trees) for (let c = 0; c < k; c++) {
    const t = it[c]; let i = 0;
    while (!t[i][6]) { const [f, thr, l, r, ml] = t[i]; const v = z[f]; i = Number.isNaN(v) || v == null ? (ml ? l : r) : v <= thr ? l : r; }
    raw[c] += t[i][5];
  }
  return raw;
}

export function predictRow(x) { // x: the 1056 inputs; exported for the self-test
  const img = M.img, z = [];
  for (let j = 0; j < M.pca.length; j++) {
    let s = 0; const row = M.pca[j];
    for (let i = 0; i < img; i++) s += ((x[i] - M.mean[i]) / M.scale[i] - M.pcaMean[i]) * row[i];
    z.push(s);
  }
  for (let i = img; i < x.length; i++) z.push(x[i] == null ? NaN : x[i]);
  const speed = Math.min(M.maxSpeed, Math.max(0, trees(M.speed, z)[0]));
  const slow = 1 / (1 + Math.exp(-trees(M.slow, z)[0]));
  const tr = trees(M.turn, z), mx = Math.max(...tr), ex = tr.map((v) => Math.exp(v - mx)), sum = ex.reduce((a, b) => a + b, 0);
  return { speed, slow, turn: ex.map((v) => v / sum) };
}

// ---------- one look ----------
const S = { hist: [], prevEmb: null, prevDets: null, prevLook: null, stops: [] };
export function reset() { S.hist = []; S.prevEmb = null; S.prevDets = null; S.prevLook = null; S.stops = []; S.zoom = null; S.zoomHist = []; }

// zoomed look (from signs(), within the last 1.5 s): stop score + width now, best stop in 3 s, red, green
function zoomFeats(t) {
  const z = S.zoom && t - S.zoom.t <= 1.5 ? S.zoom : null;
  const recent = Math.max(0, ...(S.zoomHist || []).filter((q) => t - q.t <= 3).map((q) => q.stop));
  return [z ? z.stop : 0, z ? z.width : 0, recent, z ? z.red : 0, z ? z.green : 0];
}

// video: the camera <video>; state: { look (deg or null), nav: {instruction, inM, leftM} or null, limit (mph) }
export async function look(video, state) {
  const t = performance.now() / 1000;
  const img = grab(video), { W, H } = img;
  const A = gray(img.px, W, H), tA = performance.now();
  await sleep(GAP_MS);
  const B = gray(grab(video).px, W, H), gap = (performance.now() - tA) / 1000;
  const emb = await embed(video, W, H); // one model at a time: single-threaded WebAssembly can't run two at once
  const ds = await detect(img);
  const crossing = crossingCars(A, B, ds, W, H, gap);
  const df = detFeats(ds, W, H);
  const lk = state.look ?? null;
  S.hist = S.hist.filter((h) => t - h.t <= 10); S.hist.unshift({ t, look: lk, df });
  S.stops = [...S.stops.slice(-2), ds.filter((x) => x.cls === 'stop' && x.score >= 0.5)];
  const recent = S.stops.flat();
  const sameView = S.prevDets && (lk == null || S.prevLook == null || Math.abs(lk - S.prevLook) < 20);
  const mo = sameView ? motionFeats(ds, S.prevDets, W, H) : [0, 0, 0, 0];
  const prev = S.prevEmb || emb;
  const x = [...emb, ...emb.map((v, i) => v - prev[i]), ...df, Math.max(0, ...recent.map((d) => d.score)), recent.length,
    ...scanFeats(S.hist, t), ...mo, ...zoomFeats(t), state.limit ?? 25, Math.min(state.limit ?? 25, 20), ...navFeats(state.nav)];
  S.prevEmb = emb; S.prevDets = ds; S.prevLook = lk;
  const p = predictRow(x);
  // follow the directions when a turn is under 30 m away (as in training)
  const nv = x.slice(-10);
  if (nv[6] < 30 && (nv[1] || nv[2])) p.turn = nv[1] ? [0.75, 0.25, 0] : [0, 0.25, 0.75];
  return { ...p, dets: ds, W, H,
    seen: { stop: df[0] >= 0.5 || recent.length > 0, red: df[2] >= 0.5 && df[4] > df[5] && df[4] > 0.01, green: df[2] >= 0.5 && df[5] > df[4] && df[5] > 0.01,
      carAhead: df[7] > 0.12, carCrossing: mo[1] > 0.08 || crossing.length > 0, carClosing: mo[0] > 0.015 }, crossing };
}
export const _test = { gray, shiftOf, crossingCars, detect: (img) => detect(img) };
