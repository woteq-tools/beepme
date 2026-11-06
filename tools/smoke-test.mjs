#!/usr/bin/env node
/**
 * tools/smoke-test.mjs — end-to-end smoke test.
 *
 * Drives the app in a real (headless) Chrome with a mocked Geolocation API and
 * asserts that the geofence actually behaves the way it is supposed to:
 * one beep per entry, no beep on jitter, re-arming after leaving, accuracy
 * filtering, the boundary buffer, persistence, the service worker and offline
 * operation.
 *
 * Optional dependency:
 *   npm install --no-save puppeteer-core
 *
 * Usage:
 *   npm start                 # in one terminal
 *   npm run test              # in another
 *
 * The Chrome binary is auto-detected; override it with CHROME=/path/to/chrome.
 */

import fs from 'node:fs';

let puppeteer;
try {
  puppeteer = (await import('puppeteer-core')).default;
} catch {
  console.error(
    '\n  puppeteer-core is not installed.\n' +
      '  Run:  npm install --no-save puppeteer-core\n',
  );
  process.exit(2);
}

const BASE = process.env.BASE || 'http://localhost:8080';
const CHROME =
  process.env.CHROME ||
  ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'].find((p) =>
    fs.existsSync(p),
  );

if (!CHROME) {
  console.error('\n  No Chrome binary found. Set CHROME=/path/to/chrome\n');
  process.exit(2);
}

const results = [];
const check = (name, pass, extra = '') => {
  results.push(pass);
  console.log(`  ${pass ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? ' — ' + extra : ''}`);
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--autoplay-policy=no-user-gesture-required',
  ],
});

const page = await browser.newPage();
await page.setViewport({ width: 412, height: 915, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

const consoleErrors = [];
page.on('console', (m) => {
  if (m.type() === 'error') consoleErrors.push(m.text());
});
page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

/* --------------------------------------------------------- mocked GPS ---- */

const CENTER = { latitude: 52.52, longitude: 13.405 };
const mockPosition = { ...CENTER, accuracy: 5 };

await page.evaluateOnNewDocument((initial) => {
  window.__mockPosition = initial;
  window.__oscCount = 0;
  window.__vibeCount = 0;

  const RealAC = window.AudioContext || window.webkitAudioContext;
  const patch = function (...args) {
    const ctx = new RealAC(...args);
    const play = ctx.createOscillator.bind(ctx);
    ctx.createOscillator = () => {
      const osc = play();
      const start = osc.start.bind(osc);
      osc.start = (...a) => {
        window.__oscCount += 1;
        return start(...a);
      };
      return osc;
    };
    return ctx;
  };
  window.AudioContext = patch;
  window.webkitAudioContext = patch;

  navigator.vibrate = () => {
    window.__vibeCount += 1;
    return true;
  };

  Object.defineProperty(navigator, 'geolocation', {
    configurable: true,
    value: {
      getCurrentPosition: (cb) =>
        setTimeout(() => cb({ coords: window.__mockPosition, timestamp: Date.now() }), 50),
      watchPosition: (cb) => {
        window.__watchCb = cb;
        setTimeout(() => cb({ coords: window.__mockPosition, timestamp: Date.now() }), 50);
        return 1;
      },
      clearWatch: () => {
        window.__watchCb = null;
      },
    },
  });
}, mockPosition);

const move = async (latitude, longitude, accuracy = 5) => {
  await page.evaluate((p) => {
    window.__mockPosition = { latitude: p.latitude, longitude: p.longitude, accuracy: p.accuracy };
    if (window.__watchCb) window.__watchCb({ coords: window.__mockPosition, timestamp: Date.now() });
  }, { latitude, longitude, accuracy });
  await wait(250);
};

const counters = () => page.evaluate(() => ({ osc: window.__oscCount, vibe: window.__vibeCount }));

/* ---------------------------------------------------------------- run ---- */

console.log('\n\x1b[1mLoading app\x1b[0m');
await page.goto(BASE, { waitUntil: 'networkidle2', timeout: 30_000 });
await wait(800);
check('page loads', (await page.title()) === 'Geofence Beep');

console.log('\n\x1b[1mUI\x1b[0m');
const ui = await page.evaluate(() => ({
  leaflet: typeof window.L === 'object',
  tiles: document.querySelectorAll('.leaflet-tile').length,
  radius: document.getElementById('radiusInput').value,
}));
check('Leaflet loaded', ui.leaflet);
check('map tiles loaded', ui.tiles > 0, `${ui.tiles} tiles`);
check('default radius is 100 m', ui.radius === '100');

console.log('\n\x1b[1mSetting the circle\x1b[0m');
await page.evaluate(() => {
  document.getElementById('latInput').value = '52.520000';
  document.getElementById('lngInput').value = '13.405000';
  document.getElementById('applyCoordsBtn').click();
});
await wait(400);
const stored = await page.evaluate(() => localStorage.getItem('geofence-beep:config:v1'));
check('circle persisted to localStorage', !!stored && JSON.parse(stored).center?.lat === 52.52);

console.log('\n\x1b[1mTracking\x1b[0m');
await page.click('#startBtn');
await wait(900);
const t = await page.evaluate(() => ({
  label: document.getElementById('startBtnLabel').textContent,
  status: document.getElementById('statusText').textContent,
  distance: document.getElementById('distanceVal').textContent,
  zone: document.getElementById('zoneBadge').textContent,
}));
check('button shows Stop', t.label === 'Stop Tracking');
check('status is Tracking', t.status === 'Tracking');
check('distance computed', t.distance !== '—', `${t.distance} m`);
check('zone badge correct', t.zone === 'Inside circle', t.zone);

console.log('\n\x1b[1mEntry detection\x1b[0m');
const base = await counters();
await move(52.5235, 13.405);
check(
  'zone flips to Outside',
  (await page.evaluate(() => document.getElementById('zoneBadge').textContent)) === 'Outside circle',
);
await move(52.52, 13.405);
await wait(300);
const entered = await counters();
check('beep played on entry', entered.osc - base.osc === 4, `${entered.osc - base.osc} oscillators`);
check('vibration fired on entry', entered.vibe - base.vibe === 1);
check(
  'status announces the entry',
  (await page.evaluate(() => document.getElementById('statusText').textContent)) === 'Geofence entered',
);

await move(52.52005, 13.40502);
await move(52.5201, 13.40505);
await wait(300);
check('no repeat beep while staying inside', (await counters()).osc === entered.osc);

await move(52.524, 13.405);
await wait(250);
await move(52.52, 13.405);
await wait(300);
check('beeps again after re-entering', (await counters()).osc > entered.osc);

console.log('\n\x1b[1mAccuracy filter\x1b[0m');
const beforePoor = (await counters()).osc;
await move(52.5235, 13.405, 200);
await move(52.52, 13.405, 200);
await wait(300);
check('poor-accuracy fix ignored', (await counters()).osc === beforePoor);
check(
  'poor accuracy reported',
  /accuracy/i.test(await page.evaluate(() => document.getElementById('statusDetail').textContent)),
);

console.log('\n\x1b[1mBoundary buffer\x1b[0m');
await page.evaluate(() => {
  const el = document.getElementById('bufferInput');
  el.value = '50';
  el.dispatchEvent(new Event('change'));
});
const beforeBuffer = (await counters()).osc;
await move(52.5235, 13.405, 5);
await move(52.52045, 13.405, 5); // inside the radius, inside the buffer
await wait(300);
check('buffer prevents a false trigger', (await counters()).osc === beforeBuffer);

console.log('\n\x1b[1mStopping\x1b[0m');
await page.click('#startBtn');
await wait(300);
const stopped = await page.evaluate(() => ({
  label: document.getElementById('startBtnLabel').textContent,
  status: document.getElementById('statusText').textContent,
}));
check('button back to Start', stopped.label === 'Start Tracking');
check('status reset', stopped.status === 'Not tracking');

console.log('\n\x1b[1mPWA\x1b[0m');
const sw = await page.evaluate(async () => {
  const reg = await navigator.serviceWorker.getRegistration();
  return { active: !!reg?.active, scope: reg?.scope };
});
check('service worker registered', sw.active, sw.scope ?? '');
const manifest = await page.evaluate(async () => {
  const res = await fetch(document.querySelector('link[rel=manifest]').href);
  return res.json();
});
check('manifest served', manifest.display === 'standalone');
check('manifest has icons', manifest.icons.length >= 2, `${manifest.icons.length} icons`);
const cached = await page.evaluate(async () => {
  const key = (await caches.keys()).find((k) => k.includes('shell'));
  const cache = key ? await caches.open(key) : null;
  return cache ? (await cache.keys()).length : 0;
});
check('app shell cached', cached > 5, `${cached} entries`);

console.log('\n\x1b[1mOffline\x1b[0m');
await page.setOfflineMode(true);
await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
await wait(1200);
const offline = await page.evaluate(() => ({
  title: document.title,
  leaflet: typeof window.L === 'object',
  radius: document.getElementById('radiusInput')?.value,
}));
check('app loads offline', offline.title === 'Geofence Beep');
check('Leaflet available offline', offline.leaflet);
check('saved circle restored offline', offline.radius === '100');
await page.setOfflineMode(false);

console.log('\n\x1b[1mConsole\x1b[0m');
const errors = consoleErrors.filter((e) => !/favicon|ERR_INTERNET_DISCONNECTED|Failed to load resource/i.test(e));
check('no unexpected console errors', errors.length === 0, errors.slice(0, 2).join(' | '));

await browser.close();

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} checks passed\n`);
process.exit(failed ? 1 : 0);
