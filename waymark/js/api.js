// Talks to the Waymark Worker. Owner tokens for routes recorded in this
// browser are kept in localStorage so "My routes" and Delete work.

export const API_BASE = 'https://waymark-api.axion-collect.workers.dev';
const MINE_KEY = 'waymark.mine.v1';

async function request(path, opts = {}) {
  let res;
  try {
    res = await fetch(API_BASE + path, opts);
  } catch {
    throw new Error('Can’t reach the Waymark server. Check your connection and try again.');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Server error (${res.status})`);
  return body;
}

export const listRoutes = () => request('/api/routes').then((b) => b.routes);
export const getRoute = (id) => request(`/api/routes/${encodeURIComponent(id)}`);
export const getDirections = (mode, from, to) =>
  request(`/api/directions?mode=${mode}&from=${from.lat.toFixed(6)},${from.lng.toFixed(6)}&to=${to.lat.toFixed(6)},${to.lng.toFixed(6)}`);
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
export async function uploadRoute({ meta, video, thumb }, onProgress = () => {}) {
  const { id, ownerToken: token } = await request('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...meta, videoType: video.type, videoBytes: video.size }),
  });
  const m = mine();
  m[id] = { token, title: meta.title, createdAt: Date.now() };
  saveMine(m);

  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', `${API_BASE}/api/routes/${id}/video`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', video.type.split(';')[0]);
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Video upload failed (${xhr.status})`;
      try { msg = JSON.parse(xhr.responseText).error || msg; } catch { /* keep default */ }
      reject(new Error(msg));
    };
    xhr.onerror = () => reject(new Error('The video upload was interrupted. Check your connection and try again.'));
    xhr.send(video);
  });

  if (thumb) {
    await fetch(`${API_BASE}/api/routes/${id}/thumb`, {
      method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'image/jpeg' }, body: thumb,
    }).catch(() => {}); // a missing thumbnail isn't worth failing the upload over
  }
  return id;
}

export async function deleteRoute(id) {
  await request(`/api/routes/${encodeURIComponent(id)}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${ownerToken(id)}` },
  });
  const m = mine();
  delete m[id];
  saveMine(m);
}
