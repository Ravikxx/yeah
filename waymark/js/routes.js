// Route lists for the side panel: public walkthrough routes, your own routes,
// and your street-capture sessions.

import { listRoutes, getRoute, thumbUrl, mine, deleteRoute, exportData } from './api.js?v=202610261952';
import * as coverage from './coverage.js?v=202610261952';
import { $, esc, pinIcon, toast, modeWord, fitPadding } from './ui.js?v=202610261952';
import { distance, formatDistance, formatDuration, formatClock } from './geo.js?v=202610261952';

let me = null;

function card(r, i) {
  const meta = [
    formatDistance(r.distance),
    `${formatDuration(r.duration)} ${modeWord[r.mode] || 'walk'}`,
    me && Number.isFinite(r._away) ? `${formatDistance(r._away)} away` : '',
  ].filter(Boolean).join(' · ');
  const ft = [r.from && `<dt>From</dt><dd>${esc(r.from)}</dd>`, r.to && `<dt>To</dt><dd>${esc(r.to)}</dd>`].filter(Boolean).join('');
  return `<li><a class="route-card" href="#/r/${esc(r.id)}" data-id="${esc(r.id)}">
    <div class="thumb">
      ${r.hasThumb ? `<img src="${thumbUrl(r.id)}" alt="" loading="lazy">` : ''}
      <span class="num">${i + 1}</span><span class="dur">${formatClock(r.duration)}</span>
    </div>
    <div class="card-body">
      <h3>${esc(r.title)}</h3>
      ${ft ? `<dl class="ft">${ft}</dl>` : ''}
      <p class="meta">${meta}${r.listed ? '' : ' · <span class="badge">Link only</span>'}</p>
    </div></a></li>`;
}

let token = 0;
export async function showRoutes(map, pins, { mineOnly = false } = {}) {
  const list = mineOnly ? $('#myRouteList') : $('#routeList');
  const my = ++token;
  list.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li>';
  let routes;
  try {
    if (mineOnly) {
      const ids = Object.entries(mine()).filter(([, m]) => (m.kind || 'route') === 'route').map(([id]) => id);
      routes = (await Promise.all(ids.map((id) => getRoute(id).catch(() => null)))).filter(Boolean);
      routes.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      routes = await listRoutes();
    }
  } catch (err) {
    if (my !== token) return;
    list.innerHTML = `<li class="empty"><p>${esc(err.message)}</p></li>`;
    return;
  }
  if (my !== token) return;
  if (me) {
    for (const r of routes) r._away = r.start ? distance(me, { lat: r.start[0], lng: r.start[1] }) : Infinity;
    routes.sort((a, b) => a._away - b._away);
  }
  pins.clearLayers();
  if (!routes.length) {
    list.innerHTML = mineOnly
      ? '<li class="empty"><p>No routes recorded from this browser yet.</p></li>'
      : '<li class="empty"><p><b>No routes yet.</b> Record the way to a place people get lost, like a hidden entrance or the right pickup door.</p></li>';
    return;
  }
  list.innerHTML = routes.map(card).join('');
  routes.forEach((r, i) => {
    if (!r.start) return;
    L.marker(r.start, { icon: pinIcon(String(i + 1)), title: r.title, riseOnHover: true })
      .on('click', () => (location.hash = `#/r/${r.id}`)).addTo(pins);
  });
}

export function wireNearMe(map, pins) {
  $('#nearMe').addEventListener('click', () => {
    navigator.geolocation?.getCurrentPosition((pos) => {
      me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      showRoutes(map, pins);
    }, () => toast('Couldn’t get your location.'), { timeout: 15000, maximumAge: 60000 });
  });
}

// ---------- capture sessions ----------

export function showFootage(map) {
  const list = $('#footageList');
  const sessions = new Map();
  for (const [id, m] of Object.entries(mine())) {
    if (m.kind !== 'capture') continue;
    const key = m.session || id;
    if (!sessions.has(key)) sessions.set(key, { key, ids: [], createdAt: m.createdAt, bbox: null, listed: m.listed });
    const s = sessions.get(key);
    s.ids.push(id);
    s.createdAt = Math.min(s.createdAt, m.createdAt);
    if (m.bbox) s.bbox = s.bbox ? [Math.min(s.bbox[0], m.bbox[0]), Math.min(s.bbox[1], m.bbox[1]), Math.max(s.bbox[2], m.bbox[2]), Math.max(s.bbox[3], m.bbox[3])] : m.bbox;
  }
  const items = [...sessions.values()].sort((a, b) => b.createdAt - a.createdAt);
  if (!items.length) {
    list.innerHTML = `<li class="empty"><p>You haven’t captured any streets from this browser yet.</p>
      <a class="btn btn-rec" href="#/drive"><span class="rec-dot" aria-hidden="true"></span>Drive &amp; capture</a></li>`;
    return;
  }
  list.innerHTML = items.map((s) => {
    const when = new Date(s.createdAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
    return `<li class="footage" data-key="${esc(s.key)}">
      <div><b>${esc(when)}</b><span class="meta">${s.ids.length} piece${s.ids.length === 1 ? '' : 's'}${s.listed === false ? ' · only you' : ''}</span></div>
      <div class="footage-actions">
        ${s.bbox ? '<button type="button" class="btn btn-sm" data-act="show">Show</button>' : ''}
        <button type="button" class="btn btn-ghost btn-sm btn-danger-text" data-act="delete">Delete</button>
      </div></li>`;
  }).join('');
  list.onclick = async (e) => {
    const b = e.target.closest('button[data-act]');
    if (!b) return;
    const s = sessions.get(b.closest('[data-key]').dataset.key);
    if (b.dataset.act === 'show') {
      map.fitBounds([[s.bbox[1], s.bbox[0]], [s.bbox[3], s.bbox[2]]], fitPadding());
      return;
    }
    if (!b.dataset.armed) {
      b.dataset.armed = '1';
      b.textContent = 'Tap again to delete';
      setTimeout(() => { delete b.dataset.armed; b.textContent = 'Delete'; }, 3500);
      return;
    }
    b.disabled = true;
    b.textContent = 'Deleting…';
    try {
      for (const id of s.ids) { await deleteRoute(id); coverage.remove(id); }
      toast('Footage deleted.');
    } catch (err) {
      toast(err.message);
    }
    showFootage(map);
  };
}

export function renderQueueLine(st) {
  const el = $('#queueLine');
  if (!el) return;
  el.textContent = st.uploading ? `Uploading footage: ${Math.round(st.progress * 100)}%, ${st.waiting} piece${st.waiting === 1 ? '' : 's'} left.`
    : st.waiting ? `${st.waiting} piece${st.waiting === 1 ? '' : 's'} waiting to upload. ${st.lastError || ''}`
      : 'Everything you captured is uploaded.';
}


// Mine > Download for AI training: a file listing all your recordings (private
// ones included) with telemetry and video links, for tools/waymark_export.py.
let exportWired = false;
export function wireExport() {
  if (exportWired) return;
  exportWired = true;
  const btn = $('#exportBtn'), note = $('#exportNote');
  btn.addEventListener('click', async () => {
    const ids = Object.keys(mine());
    if (!ids.length) { note.textContent = 'Nothing recorded from this browser yet.'; return; }
    btn.disabled = true;
    note.textContent = 'Preparing…';
    try {
      const data = await exportData(ids);
      const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'waymark-export.json';
      document.body.append(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      const fixes = data.recordings.reduce((n, r) => n + r.track.length, 0);
      note.textContent = `Saved waymark-export.json: ${data.recordings.length} recordings, ${fixes} GPS points.`;
    } catch (err) {
      note.textContent = err.message;
    } finally {
      btn.disabled = false;
    }
  });
}
