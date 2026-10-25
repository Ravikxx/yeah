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

const ORT = new URL('../ai/ort/', import.meta.url).href; // onnxruntime-web 1.20.1, hosted here (multi-core mode can't load its helpers from another site)
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

// Where the models run: the GPU (WebGPU) when the browser has it; otherwise the CPU
// on all cores (when the page is cross-origin isolated, see coi-sw.js), else one core.
let RB = null, DB = null; // model bytes, to rebuild a session on the CPU if the GPU fails
const EP = { resnet: 'CPU', detector: 'CPU', threads: 1 };
const cpuName = () => (EP.threads > 1 ? `CPU×${EP.threads}` : 'CPU');
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took over ${ms / 1000} s`)), ms))]);
let gpuOk = null;
async function hasGpu() {
  if (gpuOk === null) {
    try { gpuOk = !!navigator.gpu && !!(await within(navigator.gpu.requestAdapter(), 5000, 'finding the GPU')); } catch { gpuOk = false; }
  }
  return gpuOk;
}
async function makeSession(bytes, key) {
  if (await hasGpu()) {
    try {
      const s = await within(ort.InferenceSession.create(bytes, { executionProviders: ['webgpu', 'wasm'] }), 20000, 'GPU setup');
      EP[key] = 'GPU'; return s;
    } catch (e) { console.warn('co-pilot: GPU not available for', key, e); gpuOk = false; }
  }
  EP[key] = cpuName();
  return ort.InferenceSession.create(bytes, { executionProviders: ['wasm'] });
}
export const backend = () => ({ ...EP });

export async function load(onProgress = () => {}) {
  if (M) return;
  ort = await import(`${ORT}ort.min.mjs`);
  ort.env.wasm.wasmPaths = ORT;
  EP.threads = self.crossOriginIsolated ? Math.max(1, Math.min(8, navigator.hardwareConcurrency || 4)) : 1;
  try { const n = Number(localStorage.getItem('waymark.debug.threads')); if (n > 0) EP.threads = Math.min(EP.threads, n); } catch { /* no storage */ }
  ort.env.wasm.numThreads = EP.threads;
  let got = 0; const approx = 125e6;
  const bump = (n) => { got += n; onProgress(Math.min(0.99, got / approx)); };
  const [r, d, t] = await Promise.all([fetchCached(FILES.resnet, bump), fetchCached(FILES.detector, bump), fetchCached(FILES.trees, bump)]);
  RB = r; DB = d;
  R = await makeSession(r, 'resnet');
  D = await makeSession(d, 'detector');
  M = JSON.parse(new TextDecoder().decode(t));
  // how many inputs this model takes (older ones have no zoom / speed-limit inputs)
  let top = 0;
  for (const k of ['speed', 'slow', 'turn']) for (const it of M[k].trees) for (const t of it) for (const n of t) if (!n[6]) top = Math.max(top, n[0]);
  M.extra = M.img + top + 1 - M.pca.length; // the inputs after the picture summary
  onProgress(1);
}

// ---------- seeing ----------
// The converted detector crashes (instead of returning an empty list) when a picture has
// nothing in it at all, e.g. a patch of sky. Treat that as "nothing found".
const NOTHING = { boxes: { data: [] }, labels: { data: [] }, scores: { data: [] } };
async function runDetector(x, shape) {
  try { return await D.run({ image: new ort.Tensor('float32', x, shape) }); }
  catch (e) {
    if (EP.detector !== 'GPU') return NOTHING;
    // On the GPU: try the CPU. If the CPU can do it, the GPU was the problem: stay on the CPU.
    try {
      const cpu = await ort.InferenceSession.create(DB, { executionProviders: ['wasm'] });
      const out = await cpu.run({ image: new ort.Tensor('float32', x, shape) });
      console.warn('co-pilot: detector moved to the CPU', e); D = cpu; EP.detector = cpuName();
      return out;
    } catch { return NOTHING; } // a picture with nothing in it, on either
  }
}
async function runResnet(feeds) {
  try { return await R.run(feeds); }
  catch (e) {
    if (EP.resnet !== 'GPU') throw e;
    console.warn('co-pilot: picture summary moved to the CPU', e);
    R = await ort.InferenceSession.create(RB, { executionProviders: ['wasm'] }); EP.resnet = cpuName();
    return R.run(feeds);
  }
}
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
  const out = await runResnet({ image: new ort.Tensor('float32', x, [1, 3, 224, 224]) });
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
  const o = await runDetector(x, [3, H, W]);
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
  let [x0, y0, x1, y1] = [ZOOM[0] * W, ZOOM[1] * H, ZOOM[2] * W, ZOOM[3] * H].map(Math.round);
  // the converted detector only handles pictures up to ~1.7x wider than tall (phone held sideways)
  if ((x1 - x0) / (y1 - y0) > 1.6) { const need = Math.round((x1 - x0) / 1.6); y0 = Math.max(0, y0 - Math.round((need - (y1 - y0)) / 2)); y1 = Math.min(H, y0 + need); }
  const w = x1 - x0, h = y1 - y0;
  cv.width = w; cv.height = h; cx.drawImage(video, x0, y0, w, h, 0, 0, w, h);
  const px = cx.getImageData(0, 0, w, h).data, n = w * h, x = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) { x[i] = px[i * 4] / 255; x[n + i] = px[i * 4 + 1] / 255; x[2 * n + i] = px[i * 4 + 2] / 255; }
  const o = await runDetector(x, [3, h, w]);
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
// How box b moved from image A to image B (half-size pixels): sideways shift
// dx and growth `scale`, found by trying shifts and sizes until the car's patch
// lines up best.
function matchBox(A, B, b, maxS, parked = null, { cx0 = 0, scale = true } = {}) {
  const [x0, y0, x1, y1] = [Math.max(0, b[0] >> 1), Math.max(0, b[1] >> 1), Math.min(A.w - 1, b[2] >> 1), Math.min(A.h - 1, b[3] >> 1)];
  const pts = [];
  const step = Math.max(1, Math.floor((x1 - x0) * (y1 - y0) / 1200)); // ~1200 sample pixels at most
  for (let k = 0, y = y0; y < y1; y++) for (let x = x0; x < x1; x++, k++) if (k % step === 0) pts.push(x, y, A.g[y * A.w + x]);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const err = (dx, dy, sc) => {
    let e = 0, n = 0;
    for (let i = 0; i < pts.length; i += 3) {
      const xb = Math.round(cx + (pts[i] - cx) * sc + dx), yb = Math.round(cy + (pts[i + 1] - cy) * sc + dy);
      if (xb < 0 || xb >= B.w || yb < 0 || yb >= B.h) continue;
      e += Math.abs(pts[i + 2] - B.g[yb * B.w + xb]); n++;
    }
    return n > 20 ? e / n : Infinity;
  };
  let best = { dx: 0, dy: 0, scale: 1, e: Infinity };
  const sx = x1 - x0 < 40 ? 1 : 2; // finer steps for small (far) cars
  const my = Math.max(4, Math.round((y1 - y0) * 0.15)); // a near car you ride up to also slides down
  // coarse: shift and size together (a near car can grow ~30% in 0.2 s), then fine around the best
  const [s0, s1] = scale ? [0.85, 1.4501] : [1, 1.0001];
  for (let sc = s0; sc <= s1; sc += 0.05) for (let dx = cx0 - maxS; dx <= cx0 + maxS; dx += sx * 2) for (let dy = -my; dy <= my; dy += 2) {
    const e = err(dx, dy, sc); if (e < best.e) best = { dx, dy, scale: sc, e };
  }
  const c = { ...best };
  const ds_ = scale ? 0.04 : 0;
  for (let sc = c.scale - ds_; sc <= c.scale + ds_ + 0.0001; sc += 0.01) for (let dx = c.dx - 3; dx <= c.dx + 3; dx++) for (let dy = c.dy - 2; dy <= c.dy + 2; dy++) {
    const e = err(dx, dy, sc); if (e < best.e) best = { dx, dy, scale: sc, e };
  }
  // How well "it's parked" fits: where a parked car would be, given your speed (a little slack)
  if (parked) {
    best.parkedE = Infinity;
    for (let sc = parked.scale - 0.03; sc <= parked.scale + 0.0301; sc += 0.01)
      for (let dx = Math.round(parked.dx) - 2; dx <= Math.round(parked.dx) + 2; dx++) for (let dy = -my; dy <= my; dy++) {
        const e = err(dx, dy, sc); if (e < best.parkedE) best.parkedE = e;
      }
  }
  return best;
}
function shiftOf(A, B, b, maxS) { return matchBox(A, B, b, maxS).dx; }

// Every car's own motion, in metres, with yours taken out (egoMps: GPS speed;
// hfovDeg: the lens). Distance from the car's height (cars are ~1.5 m tall),
// side position from where it sits in the picture. As you ride, a parked car
// grows by (your speed / its distance) per second and drifts outward with it;
// anything beyond that is the car moving. Parked cars never raise an alert.
const CAR_H = 1.5, LANE = 1.8; // m: car height; half your lane plus a margin
function carMotion(A, B, ds, W, H, secs, egoMps = 0, hfovDeg = 50) {
  const bg = shiftOf(A, B, [0, Math.round(H * 0.05), W, Math.round(H * 0.2)], 24); // sky line / buildings: you turning
  const f = (W / 2) / Math.tan(hfovDeg * Math.PI / 360);
  const out = [];
  for (const d of ds) {
    if (d.cls !== 'car' || d.score < 0.6) continue;
    const hPx = d.box[3] - d.box[1];
    if (hPx < 12) continue; // too far to judge
    const dist = Math.max(3, f * CAR_H / hPx);
    const offPx = (d.box[0] + d.box[2]) / 2 - W / 2;
    // where it would be if parked: grows by dist / (dist - your travel), drifts outward with that, plus your turning
    const pScale = dist / Math.max(1, dist - egoMps * secs);
    const m = matchBox(A, B, d.box, Math.round(A.w * 0.15), { scale: pScale, dx: bg + (offPx * (pScale - 1)) / 2 });
    const side = offPx * dist / f; // m, + = to your right
    // sideways: measured slide minus your turning and minus a parked car's outward drift
    const vPx = (m.dx - bg) * 2 / secs - offPx * egoMps / dist;
    const vSide = vPx * dist / f; // m/s, + = moving right
    // toward you: growth rate x distance = closing speed; a parked car closes at your speed
    const closing = hPx >= 40 ? (m.scale - 1) / secs * dist : null; // m/s (growth is only measurable for nearer cars)
    const own = closing == null ? null : closing - egoMps; // the car's own speed toward you
    // Parked unless the parked prediction clearly doesn't fit (its error well above the best match's)
    const fitsParked = m.parkedE <= m.e * 1.15 + 2;
    const noise = 1.5 * 2 / secs * dist / f; // m/s from a 1.5 px matching error
    const moving = !fitsParked && (Math.abs(vSide) > 1.5 + noise || (own != null && Math.abs(own) > Math.max(3, 0.6 * egoMps)));
    const inLane = Math.abs(side) < LANE;
    const intoLane = !inLane && Math.sign(vSide) === -Math.sign(side) && Math.abs(vSide) > 1.5 && (Math.abs(side) - LANE) / Math.abs(vSide) < 3;
    out.push({ box: d.box, dist, side, vSide, closing, moving, fitsParked,
      crossing: moving && dist < 40 && Math.abs(vSide) > 1.5 && (inLane || intoLane),
      closingIn: moving && inLane && closing != null && closing > 1 && dist / closing < 4 });
  }
  return out;
}
// For the tracker: the current frame (half-size grayscale), and a detector-only pass.
export function frameGray(video) { const im = grab(video); return { g: gray(im.px, im.W, im.H), W: im.W, H: im.H }; }
export async function detectFrame(video) {
  const im = grab(video); const ds = await detect(im);
  return { dets: ds, frame: { g: gray(im.px, im.W, im.H), W: im.W, H: im.H } };
}

// ---------- car tracker ----------
// Cars found by the detector (about once a second) are followed frame to frame
// (several times a second) by matching their patch. For every step, the part of
// a car's sideways movement that a parked car wouldn't make (given your speed
// and its distance) is added up; a car counts as moving only after it has gone
// 1.5+ m on its own, mostly one way, within about a second. Matching noise
// jitters back and forth and cancels out; parked cars never add up.
export function makeTracker() {
  let tracks = [], prev = null, prevT = 0, nextId = 1;
  const iou = (a, b) => {
    const x = Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])), y = Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1]));
    const u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - x * y;
    return u > 0 ? (x * y) / u : 0;
  };
  // whole-scene shift (you turning, bumps): upper part of the picture minus the cars, no size change
  function sceneShift(A, B, W, H) {
    return matchBox(A, B, [0, Math.round(H * 0.08), W, Math.round(H * 0.6)], 14, null, { scale: false });
  }
  return {
    addDetections(ds, g, W, H, t) {
      for (const d of ds) {
        if (d.cls !== 'car' || d.score < 0.6) continue;
        const b = d.box;
        if (b[3] - b[1] < 16 || b[0] < 4 || b[2] > W - 4) continue; // too small, or cut off at the edge
        const tr = tracks.find((q) => iou(q.box, b) > 0.3);
        if (tr) { tr.box = b.slice(); tr.seen = t; } else tracks.push({ id: nextId++, box: b.slice(), seen: t, hist: [], v: 0 });
      }
      tracks = tracks.filter((q) => t - q.seen < 2.5 && !q.lost);
    },
    update(g, t, egoMps, hfovDeg, W, H) {
      if (!prev) { prev = g; prevT = t; return []; }
      const dt = Math.max(0.05, t - prevT);
      const f = (W / 2) / Math.tan(hfovDeg * Math.PI / 360);
      const bg = sceneShift(prev, g, W, H);
      // camera turning (handlebar scan, steering, a bump): near and far things shift by different
      // amounts, so car motion can't be judged; start counting again once the view settles
      const turning = Math.abs(bg.dx * 2) / dt > W * 0.25 || Math.abs(bg.dy * 2) / dt > H * 0.15;
      if (turning) for (const tr of tracks) tr.hist = [];
      const stopped = egoMps < 1.2;
      const out = [];
      for (const tr of tracks) {
        const b = tr.box, hPx = b[3] - b[1];
        const dist = Math.max(3, f * CAR_H / hPx), offPx = (b[0] + b[2]) / 2 - W / 2;
        const pScale = dist / Math.max(1, dist - egoMps * dt);
        const parkedDx = bg.dx + (offPx * (pScale - 1)) / 2; // half-size px
        const predDx = Math.round(parkedDx + tr.v * dt / 2); // where it'd be if it kept its own speed
        const m = matchBox(prev, g, b, Math.max(6, Math.round(hPx * 0.25)), null, { cx0: predDx });
        if (!(m.e < 40)) { tr.lost = true; continue; }
        const ownPx = (m.dx - parkedDx) * 2; // full-size px of sideways movement a parked car wouldn't make
        const ownM = ownPx * dist / f;
        const side0 = offPx * dist / f; // m to your right, from this step's box
        if (!turning) tr.hist.push({ t, ownM, dist, side: side0, h: hPx });
        if (!tr.hist.length) { tr.v = ownPx / dt; continue; }
        tr.hist = tr.hist.filter((h) => t - h.t <= 1.2);
        tr.v = ownPx / dt; // px/s, for predicting the next step
        // move the box with the car
        const cx = (b[0] + b[2]) / 2 + m.dx * 2, cy = (b[1] + b[3]) / 2 + m.dy * 2, w = (b[2] - b[0]) * m.scale, h = hPx * m.scale;
        tr.box = [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
        if (tr.box[0] < 2 || tr.box[2] > W - 2) { tr.lost = true; continue; } // left the picture
        // moving: 1.5+ m on its own within ~1 s, mostly in one direction
        const H_ = tr.hist, span = H_.length > 1 ? H_[H_.length - 1].t - H_[0].t + dt : dt;
        const sum = H_.reduce((a, h) => a + h.ownM, 0), sameWay = H_.filter((h) => Math.sign(h.ownM) === Math.sign(sum)).length / H_.length;
        const vSide = sum / span; // m/s, + = moving right
        // stopped: nothing should move but moving cars, so be sensitive; riding: need much clearer evidence
        // riding: the car's sideways position in metres must really change too (an oncoming car
        // in its own lane, or a parked one, stays the same distance to the side)
        const dSide = H_[H_.length - 1].side - H_[0].side;
        const moving = H_.length >= 4 && sameWay >= 0.75 && (stopped ? Math.abs(sum) > 1.5
          : Math.abs(sum) > 3 && Math.abs(vSide) > 3 && Math.sign(dSide) === Math.sign(sum) && Math.abs(dSide) > 2);
        const side = offPx * dist / f;
        const inLane = Math.abs(side) < LANE;
        const intoLane = !inLane && Math.sign(vSide) === -Math.sign(side) && (Math.abs(side) - LANE) / Math.max(0.1, Math.abs(vSide)) < (stopped ? 3 : 2);
        // getting closer in your lane: distance falling faster than it would for a parked car
        const d0 = H_[0].dist, closing = H_.length >= 4 ? (d0 - dist) / span : 0; // m/s
        const ownAlong = closing - egoMps; // + = coming toward you, - = going away
        const movingAlong = H_.length >= 4 && hPx >= 40 && H_[0].h >= 40 && Math.abs(ownAlong) > Math.max(3, 0.5 * egoMps); // growth only measurable on nearer cars
        out.push({ id: tr.id, box: tr.box, dist, side, vSide, moving: moving || movingAlong,
          crossing: moving && dist < (stopped ? 40 : 30) && (inLane || intoLane),
          closingIn: movingAlong && inLane && closing > 1 && dist / closing < (stopped ? 4 : 3) });
      }
      tracks = tracks.filter((q) => !q.lost);
      prev = g; prevT = t;
      return out;
    },
  };
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
// recent: the last few full looks {t, emb, dets, look}, to compare with the one ~1 s ago as in training
const S = { hist: [], recent: [], stops: [] };
export function reset() { S.hist = []; S.recent = []; S.stops = []; S.zoom = null; S.zoomHist = []; }

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
  const emb = await embed(video, W, H); // one model at a time: single-threaded WebAssembly can't run two at once
  const ds = await detect(img);
  const df = detFeats(ds, W, H);
  const lk = state.look ?? null;
  S.hist = S.hist.filter((h) => t - h.t <= 10); S.hist.unshift({ t, look: lk, df });
  // stop signs seen in the last ~2 s (as in training)
  S.stops = [...S.stops.filter((q) => t - q.t <= 2.2), { t, ds: ds.filter((x) => x.cls === 'stop' && x.score >= 0.5) }];
  const recent = S.stops.flatMap((q) => q.ds);
  // "1 s ago": the look closest to a second earlier; none between 0.6 and 1.4 s back counts as no change
  const back = S.recent.filter((q) => t - q.t >= 0.6 && t - q.t <= 1.4);
  const old = back.length ? back.reduce((a, q) => (Math.abs(t - q.t - 1) < Math.abs(t - a.t - 1) ? q : a)) : null;
  const sameView = old && (lk == null || old.look == null || Math.abs(lk - old.look) < 20);
  const mo = sameView ? motionFeats(ds, old.dets, W, H) : [0, 0, 0, 0];
  const prev = old ? old.emb : emb;
  const x = [...emb, ...emb.map((v, i) => v - prev[i]), ...df, Math.max(0, ...recent.map((d) => d.score)), recent.length,
    ...scanFeats(S.hist, t), ...mo, ...(M.extra > 32 ? [...zoomFeats(t), state.limit ?? 25, Math.min(state.limit ?? 25, 20)] : []), ...navFeats(state.nav)];
  S.recent = [...S.recent.filter((q) => t - q.t <= 2), { t, emb, dets: ds, look: lk }];
  const p = predictRow(x);
  // follow the directions when a turn is under 30 m away (as in training)
  const nv = x.slice(-10);
  if (nv[6] < 30 && (nv[1] || nv[2])) p.turn = nv[1] ? [0.75, 0.25, 0] : [0, 0.25, 0.75];
  return { ...p, W, H,
    seen: { stop: df[0] >= 0.5 || recent.length > 0, red: df[2] >= 0.5 && df[4] > df[5] && df[4] > 0.01, green: df[2] >= 0.5 && df[5] > df[4] && df[5] > 0.01,
      carAhead: df[7] > 0.12 }, // moving-car alerts come from the tracker (makeTracker)
    dets: ds, frame: { g: gray(img.px, W, H), W, H } };
}
export const _test = { gray, matchBox, carMotion, makeTracker, detect: (img) => detect(img) };
