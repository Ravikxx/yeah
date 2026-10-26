import { showShell } from './shell.js?v=202610262059';
import { enterDrive } from './drive.js?v=202610262059';
import { enterStreetView } from './streetview.js?v=202610262059';
import { enterPreview, enterLive } from './nav.js?v=202610262059';
import { enterRecorder } from './record.js?v=202610262059';
import { showRoute } from './route.js?v=202610262059';
import * as queue from './queue.js?v=202610262059';
import * as coverage from './coverage.js?v=202610262059';

// Hash routes:
//   #/  #/directions  #/routes  #/mine     the map app
//   #/drive                                 Drive & capture
//   #/view/<lat>,<lng>[,<heading>]          street view
//   #/nav/preview  #/nav/live               trip preview / live navigation
//   #/record  #/r/<id>                      walkthrough routes
const TABS = { '': 'explore', directions: 'directions', routes: 'routes', mine: 'mine' };
let leave = null;

function router() {
  const [section = '', arg = ''] = location.hash.replace(/^#\/?/, '').split('/');
  let view = 'shell';
  if (section === 'drive') view = 'drive';
  else if (section === 'view' || section === 'nav') view = 'stage';
  else if (section === 'record') view = 'record';
  else if (section === 'r' && arg) view = 'route';
  else if (!(section in TABS)) { location.replace('#/'); return; }

  try { leave?.(); } catch (err) { console.error(err); }
  leave = null;

  for (const v of ['shell', 'drive', 'stage', 'record', 'route']) document.getElementById(`view-${v}`).hidden = v !== view;
  document.getElementById('topbar').hidden = view !== 'route';
  if (view === 'route') window.scrollTo(0, 0);

  if (view === 'shell') leave = showShell(TABS[section]);
  else if (view === 'drive') { document.title = 'Drive & capture · Waymark'; leave = enterDrive(); }
  else if (view === 'record') { document.title = 'Record a route · Waymark'; leave = enterRecorder(); }
  else if (view === 'route') leave = showRoute(decodeURIComponent(arg));
  else if (section === 'nav') {
    document.title = arg === 'live' ? 'Navigating · Waymark' : 'Trip preview · Waymark';
    leave = arg === 'live' ? enterLive() : enterPreview();
  } else {
    document.title = 'Street view · Waymark';
    const [lat, lng, heading] = arg.split(',').map(Number);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) { location.replace('#/'); return; }
    leave = enterStreetView(lat, lng, Number.isFinite(heading) ? heading : null);
  }
}

// Footage finished uploading in the background shows up on every map at once.
queue.onUploaded(({ id, meta }) => {
  coverage.add({ id, kind: meta.kind, mode: meta.mode, listed: meta.listed, session: meta.session, createdAt: Date.now(), track: meta.track });
});
queue.kick(); // finish anything left from a previous visit

addEventListener('hashchange', router);
router();
