import { listRoutes, getRoute, thumbUrl, mine } from './api.js';
import { $, esc, makeMap, pinIcon, dotIcon, toast, modeWord } from './ui.js';
import { distance, formatDistance, formatDuration, formatClock } from './geo.js';

let map, pins, meMarker;
let me = null;
let loadToken = 0;

export function showHome({ mineOnly }) {
  if (!map) {
    map = makeMap('homeMap', { scrollWheelZoom: true });
    map.setView([39.5, -98.35], 4);
    pins = L.layerGroup().addTo(map);
    $('#nearMe').addEventListener('click', () => locate(true));
    navigator.permissions?.query({ name: 'geolocation' })
      .then((s) => s.state === 'granted' && locate(false))
      .catch(() => {});
  }
  requestAnimationFrame(() => map.invalidateSize());
  document.title = mineOnly ? 'My routes · Waymark' : 'Waymark';
  $('#listTitle').textContent = mineOnly ? 'My routes' : 'Routes';
  load(mineOnly);
  return () => {};
}

async function load(mineOnly) {
  const token = ++loadToken;
  const list = $('#routeList');
  list.innerHTML = '<li class="skeleton"></li><li class="skeleton"></li><li class="skeleton"></li>';
  try {
    let routes;
    if (mineOnly) {
      const ids = Object.keys(mine());
      // Includes link-only routes, which the public list leaves out.
      const got = await Promise.all(ids.map((id) => getRoute(id).catch(() => null)));
      routes = got.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt);
    } else {
      routes = await listRoutes();
    }
    if (token !== loadToken) return;
    render(routes, mineOnly);
  } catch (err) {
    if (token !== loadToken) return;
    list.innerHTML = `<li class="empty"><p>${esc(err.message)}</p><button class="btn" type="button" id="retry">Try again</button></li>`;
    $('#retry').addEventListener('click', () => load(mineOnly));
  }
}

function render(routes, mineOnly) {
  const list = $('#routeList');
  pins.clearLayers();
  if (me) {
    for (const r of routes) r._away = r.start ? distance(me, { lat: r.start[0], lng: r.start[1] }) : Infinity;
    routes.sort((a, b) => a._away - b._away);
  }
  if (!routes.length) {
    list.innerHTML = mineOnly
      ? `<li class="empty">
          <p>You haven’t uploaded any routes from this browser yet. Routes you record show up here, including link-only ones.</p>
          <a class="btn btn-primary" href="#/record">Record your first route</a></li>`
      : `<li class="empty">
          <p><b>No public routes yet.</b> Record the way to a place people get lost: a hidden building entrance, a trailhead, the right pickup door.</p>
          <a class="btn btn-primary" href="#/record">Record the first route</a></li>`;
    if (me) map.setView([me.lat, me.lng], 14);
    return;
  }

  list.innerHTML = routes.map((r, i) => {
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
  }).join('');

  const bounds = [];
  const markers = {};
  routes.forEach((r, i) => {
    if (!r.start) return;
    const m = L.marker(r.start, { icon: pinIcon(String(i + 1)), title: r.title, riseOnHover: true })
      .on('click', () => (location.hash = `#/r/${r.id}`))
      .on('mouseover', () => hot(r.id, true))
      .on('mouseout', () => hot(r.id, false))
      .addTo(pins);
    markers[r.id] = { m, i };
    bounds.push(r.start);
    if (r.end) bounds.push(r.end);
  });
  if (me) bounds.push([me.lat, me.lng]);
  if (bounds.length) map.fitBounds(bounds, { padding: [40, 40], maxZoom: 16 });

  function hot(id, on) {
    list.querySelector(`[data-id="${id}"]`)?.classList.toggle('is-hot', on);
    const mk = markers[id];
    if (mk) mk.m.setIcon(pinIcon(String(mk.i + 1), on ? 'is-hot' : ''));
  }
  list.querySelectorAll('.route-card').forEach((card) => {
    card.addEventListener('mouseenter', () => hot(card.dataset.id, true));
    card.addEventListener('mouseleave', () => hot(card.dataset.id, false));
  });
  lastRender = { routes, mineOnly };
}

let lastRender = null;

function locate(userAsked) {
  if (!navigator.geolocation) return userAsked && toast('This browser can’t share your location.');
  const btn = $('#nearMe');
  btn.disabled = true;
  navigator.geolocation.getCurrentPosition((pos) => {
    btn.disabled = false;
    me = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    if (meMarker) meMarker.setLatLng([me.lat, me.lng]);
    else meMarker = L.marker([me.lat, me.lng], { icon: dotIcon(), interactive: false, zIndexOffset: 1000 }).addTo(map);
    if (lastRender) render(lastRender.routes, lastRender.mineOnly);
  }, (err) => {
    btn.disabled = false;
    if (userAsked) {
      toast(err.code === 1
        ? 'Location is blocked for this site. Allow it in your browser settings to sort by distance.'
        : 'Couldn’t get your location. Try again in a moment.');
    }
  }, { enableHighAccuracy: false, timeout: 15000, maximumAge: 60000 });
}
