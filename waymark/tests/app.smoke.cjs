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
  const errors = new Set();
  p.on('console', (m) => { if (m.type() === 'error' && /copilot/i.test(m.text())) errors.add(m.text().slice(0, 300)); });
  p.on('pageerror', (e) => errors.add(String(e).slice(0, 300)));
  await p.goto(`${base}index.html#/drive`);
  await p.waitForSelector('#driveStart', { timeout: 20000 });
  await p.click('#driveStart');
  await p.waitForTimeout(4000);
  await p.click('#copilotBtn');
  let card = null;
  for (let i = 0; i < 10; i++) {
    await p.waitForTimeout(5000);
    card = await p.evaluate(() => ({ alert: document.querySelector('#copilot .cp-alert')?.textContent, detail: document.querySelector('#copilot .cp-detail')?.textContent, ai: document.querySelector('#copilot .cp-ai')?.textContent }));
    if (card.ai && card.ai !== '–') break;
  }
  console.log(JSON.stringify(card));
  await b.close();
  const bad = [...errors];
  if (/problem/i.test(card.alert || '') || !card.ai || card.ai === '–') bad.push(`the co-pilot never produced a look (${card.alert}: ${card.detail})`);
  console.log(bad.length ? 'FAIL: ' + bad.join(' | ') : 'PASS');
  process.exit(bad.length ? 1 : 0);
})().catch((e) => { console.log('FAIL (script): ' + String(e).slice(0, 300)); process.exit(1); });
