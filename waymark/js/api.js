// Talks to the Waymark Worker. Owner tokens for routes recorded in this
// browser are kept in localStorage so "My routes" and Delete work.

export const API_BASE = 'https://waymark-api.axion-collect.workers.dev';
const MINE_KEY = 'waymark.mine.v1';

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, { signal: AbortSignal.timeout?.(30000), ...opts }); // never wait forever
  } catch {
    throw new Error('Can’t reach the Waymark server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error || `Server error (${res.status})`), { status: res.status });
  return body;
}

export const listRoutes = () => request('/api/routes').then((b) => b.routes);
export const getRoute = (id) => request(`/api/routes/${encodeURIComponent(id)}`);
// bearing: your direction of travel, so the route starts the way you're going.
export const getDirections = (mode, from, to, bearing = null) =>
  request(`/api/directions?mode=${mode}&from=${from.lat.toFixed(6)},${from.lng.toFixed(6)}&to=${to.lat.toFixed(6)},${to.lng.toFixed(6)}${bearing == null ? '' : `&bearing=${Math.round(bearing)}`}`);
export const getCoverage = ([w, s, e, n], ids = []) =>
  request(`/api/coverage?bbox=${[w, s, e, n].map((v) => v.toFixed(5)).join(',')}${ids.length ? `&ids=${ids.join(',')}` : ''}`)
    .then((b) => b.segments);
export const searchPlaces = (q, near) =>
  request(`/api/search?q=${encodeURIComponent(q)}${near ? `&lat=${near.lat.toFixed(4)}&lng=${near.lng.toFixed(4)}` : ''}`).then((b) => b.results);
export const exportData = (ids) => request(`/api/export?ids=${ids.join(',')}`);
export const videoUrl = (id) => `${API_BASE}/api/routes/${encodeURIComponent(id)}/video`;
export const thumbUrl = (id) => `${API_BASE}/api/routes/${encodeURIComponent(id)}/thumb`;

export function mine() {
  try { return JSON.parse(localStorage.getItem(MINE_KEY)) || {}; } catch { return {}; }
}
function saveMine(m) {
  try { localStorage.setItem(MINE_KEY, JSON.stringify(m)); } catch { /* private mode: route still uploads */ }
}
export const ownerToken = (id) => mine()[id]?.token || null;

// Uploads a finished recording. onProgress(0..1) tracks the video upload.
// `created` ({id, token}) resumes an upload whose record already exists, and
// onCreated hears about a new one, so a retry never makes a duplicate.
export async function uploadRoute({ meta, video, thumb, created = null }, onProgress = () => {}, onCreated = () => {}) {
  let id = created?.id, token = created?.token;
  if (!id) {
    ({ id, ownerToken: token } = await request('/api/routes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...meta, videoType: video.type, videoBytes: video.size }),
    }));
    const m = mine();
    const lats = (meta.track || []).map((p) => p[1]), lngs = (meta.track || []).map((p) => p[2]);
    m[id] = {
      token, title: meta.title || '', kind: meta.kind || 'route', session: meta.session || null,
      listed: meta.listed !== false, createdAt: Date.now(),
      bbox: lats.length ? [Math.min(...lngs), Math.min(...lats), Math.max(...lngs), Math.max(...lats)] : null,
    };
    saveMine(m);
    await onCreated({ id, token });
  }

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/api/routes/${id}/video`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', video.type.split(';')[0]);
    // A connection can hang without ever failing (network switch, screen lock).
    // If no bytes move for 45 s, give up on this try; the queue retries it.
    let stall;
    const watch = () => { clearTimeout(stall); stall = setTimeout(() => xhr.abort(), 45000); };
    xhr.upload.onprogress = (e) => { watch(); if (e.lengthComputable) onProgress(e.loaded / e.total); };
    xhr.onloadend = () => clearTimeout(stall);
    xhr.onabort = () => reject(new Error('The upload stalled. Trying again…'));
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Video upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
      reject(Object.assign(new Error(msg), { status: xhr.status }));
    };
    xhr.onerror = () => reject(new Error('The video upload was interrupted. Check your connection and try again.'));
    xhr.send(video);
    watch();
  });

  if (thumb) {
    await fetch(`${API_BASE}/api/routes/${id}/thumb`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: thumb,
    }).catch(() => {}); // a missing thumbnail isn't worth failing the upload over
  }
  return id;
}

export async function deleteRoute(id) {
  try {
    await request(`/api/routes/${encodeURIComponent(id)}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken(id)}` },
    });
  } catch (err) {
    if (err.status !== 404) throw err; // already gone: just forget it locally
  }
  const m = mine();
  delete m[id];
  saveMine(m);
}
