// Runs the whole app in a headless browser (fake camera, fake GPS), turns the co-pilot on and checks that it
// really produces looks, with no errors. It catches wiring mistakes the unit tests can't (a missing import
// broke the co-pilot once). Needs `playwright`, and the site served somewhere only this machine can reach:
//   (cd <a folder holding a link named "waymark" to this folder> && python3 -m http.server 8766 --bind 127.0.0.1) &
//   NODE_PATH=$(npm root -g) node tests/app.smoke.cjs http://127.0.0.1:8766/waymark/
const { chromium } = require('playwright');
(async () => {
  const base = process.argv[2] || 'http://127.0.0.1:8766/waymark/';
  const b = await chromium.launch({ args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--autoplay-policy=no-user-gesture-required'] });
  const ctx = await b.newContext({ permissions: ['geolocation', 'camera', 'microphone'], geolocation: { latitude: 40.4898, longitude: -81.4457, accuracy: 5 }, viewport: { width: 430, height: 900 } });
  const p = await ctx.newPage();
  await p.addInitScript(() => { // like an iPhone after you tap Allow on motion access
    if (window.DeviceOrientationEvent) DeviceOrientationEvent.requestPermission = async () => 'granted';
    if (window.DeviceMotionEvent) DeviceMotionEvent.requestPermission = async () => 'granted';
  });
  const errors = new Set();
  p.on('console', (m) => { if (m.type() === 'error' && /copilot/i.test(m.text())) errors.add(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errors.add(String(e).slice(0, 300)));
  await p.goto(`${base}index.html${process.env.STRICT ? '?coep=strict' : ''}#/drive`);
  await p.waitForSelector('#driveStart', { timeout: 20000 });
  await p.click('#driveStart');
  await p.waitForTimeout(4000);
  for (let i = 0; i < 3; i++) await p.click('#dGps'); // three taps on the GPS chip turn the sensor box on
  await p.click('#copilotBtn');
  // fake sensors: the compass turning right and the gyroscope reporting a turn, for ~3 s
  await p.evaluate(() => {
    let h = 100, n = 0;
    const id = setInterval(() => {
      h = (h + 0.8) % 360;
      window.dispatchEvent(Object.assign(new Event('deviceorientation'), { webkitCompassHeading: h }));
      window.dispatchEvent(new DeviceMotionEvent('devicemotion', { rotationRate: { alpha: 0, beta: 0, gamma: 40 }, accelerationIncludingGravity: { x: 0, y: 9.8, z: 0 } }));
      if (++n > 150) clearInterval(id);
    }, 20);
  });
  let card = null;
  for (let i = 0; i < 40; i++) { // wait for the first look (the models load first)
    await p.waitForTimeout(2000);
    card = await p.evaluate(() => ({ alert: document.querySelector('#copilot .cp-alert')?.textContent, detail: document.querySelector('#copilot .cp-detail')?.textContent, ai: document.querySelector('#copilot .cp-ai')?.textContent }));
    if (card.ai && card.ai !== '–') break;
  }
  const laneCount = () => p.evaluate(() => Number((/lane updates (\d+)/.exec(document.getElementById('turnDbg')?.textContent || '') || [])[1] || 0));
  const n0 = await laneCount(); await p.waitForTimeout(10000); const n1 = await laneCount();
  card = await p.evaluate(() => ({ alert: document.querySelector('#copilot .cp-alert')?.textContent, detail: document.querySelector('#copilot .cp-detail')?.textContent, ai: document.querySelector('#copilot .cp-ai')?.textContent }));
  console.log(JSON.stringify(card));
  const dbg = await p.evaluate(() => document.getElementById('turnDbg')?.textContent || '');
  await b.close();
  const bad = [...errors];
  const laneN = n1 - n0;
  console.log('lane finder updates in 10 s:', laneN);
  if (laneN < 10) bad.push(`the band's lane finder only updated ${laneN} times in 10 s (it should run several times a second)`);
  if (!/gyro on/.test(dbg)) bad.push(`the gyroscope events never arrived (${card.detail})`);
  if (/problem/i.test(card.alert || '') || !card.ai || card.ai === '–') bad.push(`the co-pilot never produced a look (${card.alert}: ${card.detail})`);
  console.log(bad.length ? 'FAIL: ' + bad.join(' | ') : 'PASS');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL (script): ' + String(e).slice(0, 300)); process.exit(1); });
