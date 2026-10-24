import { showHome } from './home.js';
import { enterRecorder } from './record.js';
import { showRoute } from './route.js';

// Hash routes: #/ (public routes), #/mine, #/record, #/r/<id>
let leave = null;

function router() {
  const [section, id] = location.hash.replace(/^#\/?/, '').split('/');
  const view = section === 'record' ? 'record' : section === 'r' && id ? 'route' : 'home';

  try { leave?.(); } catch (err) { console.error(err); }
  leave = null;

  for (const v of ['home', 'record', 'route']) document.getElementById(`view-${v}`).hidden = v !== view;
  document.getElementById('topbar').hidden = view === 'record';
  document.querySelectorAll('[data-nav]').forEach((a) => {
    const on = view === 'home' && (a.dataset.nav === 'mine') === (section === 'mine');
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  window.scrollTo(0, 0);

  if (view === 'record') { document.title = 'Record a route · Waymark'; leave = enterRecorder(); }
  else if (view === 'route') leave = showRoute(decodeURIComponent(id));
  else leave = showHome({ mineOnly: section === 'mine' });
}

addEventListener('hashchange', router);
router();
