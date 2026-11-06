/**
 * app.js — Geofence Beep
 *
 * Wires together the map, the geolocation watcher, the audio/vibration
 * alert, the wake lock and the PWA plumbing (manifest + service worker).
 */

import {
  Geofence,
  ZONE,
  describeGeolocationError,
  formatDistance,
  distanceUnit,
  formatSpeed,
} from './geo.js';
import { Beeper, vibrate } from './audio.js';
import { WakeKeeper } from './wakeLock.js';
import { GeofenceMap } from './map.js';
import { loadConfig, saveConfig } from './storage.js';

const $ = (id) => document.getElementById(id);

/** How long without a fix before we warn the user that tracking may be stalled. */
const STALE_AFTER_MS = 25_000;

/* ------------------------------------------------------------------ state */

const state = {
  config: loadConfig(),
  tracking: false,
  watchId: null,
  lastFix: null,          // { lat, lng, accuracy, speed, at }
  lastDistance: null,
  lastZone: ZONE.OUTSIDE,
  installPrompt: null,
  audioReady: false,
};

const geofence = new Geofence();
const beeper = new Beeper();
const wake = new WakeKeeper();
let map = null;

/* ------------------------------------------------------------- UI helpers */

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`.trim();
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast';
  }, 3600);
}

function setStatus(kind, title, detail) {
  $('stateDot').className = `dot dot-${kind}`;
  $('statusText').textContent = title;
  $('statusDetail').textContent = detail;
}

function setZone(zone) {
  const badge = $('zoneBadge');
  state.lastZone = zone;
  if (zone === ZONE.INSIDE) {
    badge.className = 'zone-badge zone-inside';
    badge.textContent = 'Inside circle';
  } else if (zone === ZONE.NEAR) {
    badge.className = 'zone-badge zone-near';
    badge.textContent = 'Near the edge';
  } else {
    badge.className = 'zone-badge zone-outside';
    badge.textContent = 'Outside circle';
  }
}

function setDistance(metres) {
  state.lastDistance = metres;
  if (!Number.isFinite(metres)) {
    $('distanceVal').textContent = '—';
    $('distanceVal').nextElementSibling.textContent = '';
    return;
  }
  $('distanceVal').textContent = formatDistance(metres);
  $('distanceVal').nextElementSibling.textContent = distanceUnit(metres);
}

function setMeta(accuracy, speed, agoMs) {
  $('accuracyVal').textContent = Number.isFinite(accuracy)
    ? `accuracy ${Math.round(accuracy)} m`
    : 'accuracy —';
  $('speedVal').textContent = Number.isFinite(speed) ? `${formatSpeed(speed)} km/h` : 'speed —';
  if (!Number.isFinite(agoMs)) {
    $('updatedVal').textContent = 'no fix yet';
  } else if (agoMs < 2000) {
    $('updatedVal').textContent = 'updated now';
  } else {
    $('updatedVal').textContent = `updated ${Math.round(agoMs / 1000)}s ago`;
  }
}

/* ------------------------------------------------------------ persistence */

function persist() {
  saveConfig(state.config);
}

function applyConfigToGeofence() {
  geofence.configure({
    center: state.config.center,
    radius: state.config.radius,
    buffer: state.config.buffer,
    maxAccuracy: state.config.maxAccuracy,
    beepOnStartInside: state.config.beepOnStartInside,
  });
}

function setCenter(latlng, { fly = true } = {}) {
  state.config.center = { lat: Number(latlng.lat), lng: Number(latlng.lng) };
  applyConfigToGeofence();
  map.setCenter(state.config.center);
  if (fly) map.flyTo(state.config.center, Math.max(map.map.getZoom(), 16));
  $('latInput').value = state.config.center.lat.toFixed(6);
  $('lngInput').value = state.config.center.lng.toFixed(6);
  persist();
  showMapHint('Circle moved — tap the map to place it again', 2600);
}

/** Show a transient hint on the map, then fade it out. */
let hintTimer = null;
function showMapHint(message, hideAfter = 0) {
  const hint = $('mapHint');
  clearTimeout(hintTimer);
  if (message) hint.textContent = message;
  hint.classList.remove('hidden');
  if (hideAfter > 0) {
    hintTimer = setTimeout(() => hint.classList.add('hidden'), hideAfter);
  }
}

function setRadius(metres) {
  const value = Math.min(5000, Math.max(10, Math.round(Number(metres) || 0)));
  state.config.radius = value;
  applyConfigToGeofence();
  map.setRadius(value);
  $('radiusInput').value = value;
  $('radiusNumber').value = value;
  syncRadiusChips(value);
  persist();
}

function syncRadiusChips(value) {
  document.querySelectorAll('.chip[data-radius]').forEach((chip) => {
    chip.classList.toggle('active', Number(chip.dataset.radius) === value);
  });
}

/* ----------------------------------------------------------- alert firing */

function fireAlert() {
  let sounded = false;
  if (state.config.sound) sounded = beeper.play({ pattern: 'alert' });
  if (state.config.vibrate) vibrate([280, 140, 280, 140, 600]);

  const flash = $('flash');
  flash.classList.remove('show');
  void flash.offsetWidth; // restart the CSS animation
  flash.classList.add('show');
  setTimeout(() => flash.classList.remove('show'), 1500);

  if (state.config.sound && !sounded) {
    toast('Entered the circle — sound blocked, tap Test beep', 'err');
  } else {
    toast('Entered the circle! 🔔', 'ok');
  }
  setStatus('live', 'Geofence entered', 'You are inside the circle — beeping once per entry.');
}

/* ------------------------------------------------------------ geolocation */

function onPosition(position) {
  const coords = position?.coords;
  if (!coords || !Number.isFinite(coords.latitude) || !Number.isFinite(coords.longitude)) {
    console.warn('Ignoring a position fix without usable coordinates');
    return;
  }

  const fix = {
    lat: coords.latitude,
    lng: coords.longitude,
    accuracy: Number.isFinite(coords.accuracy) ? coords.accuracy : null,
    speed: Number.isFinite(coords.speed) ? coords.speed : null,
    at: Date.now(),
  };
  state.lastFix = fix;

  // Always show where the user is, even before a circle is placed.
  map.setUserPosition(fix, fix.accuracy);

  const result = geofence.evaluate(fix);
  setDistance(result.distance);

  if (result.status === 'poor-accuracy') {
    setStatus('warn', 'Tracking', `Waiting for a better fix (${result.reason}).`);
    setZone(result.zone);
    setMeta(fix.accuracy, fix.speed, 0);
    return;
  }

  if (result.status === 'no-center') {
    setStatus('warn', 'Tracking', 'Tap the map to set the circle centre.');
    setMeta(fix.accuracy, fix.speed, 0);
    return;
  }

  setZone(result.zone);
  setMeta(fix.accuracy, fix.speed, 0);

  if (result.trigger) {
    fireAlert();
  } else if (state.lastZone === ZONE.INSIDE) {
    setStatus('live', 'Tracking', 'Inside the circle.');
  } else {
    const togo = Math.max(0, Math.round(result.distance - geofence.radius));
    setStatus(
      'live',
      'Tracking',
      togo > 0 ? `Outside the circle — ${togo} m to the edge.` : 'Outside the circle.',
    );
  }
}

let lastErrorToast = 0;
function onGeoError(error) {
  const { title, detail } = describeGeolocationError(error?.code, error);

  if (error?.code === 1) {
    // Permission denied — watching is pointless until the user changes it.
    stopTracking();
    setStatus('error', title, detail);
    toast(title, 'err');
    return;
  }

  setStatus('error', title, detail);

  // watchPosition repeats the same error on every attempt — do not spam.
  const now = Date.now();
  if (now - lastErrorToast > 10_000) {
    lastErrorToast = now;
    toast(title, 'err');
  }

  if (state.tracking) {
    setTimeout(() => {
      if (state.tracking) setStatus('warn', 'Tracking', `${detail} Still trying…`);
    }, 6000);
  }
}

function startWatch() {
  if (!('geolocation' in navigator)) {
    setStatus(
      'error',
      'Geolocation not available',
      'This browser does not expose the Geolocation API. Use Chrome on Android over HTTPS.',
    );
    toast('Geolocation not supported here', 'err');
    return false;
  }

  const options = {
    enableHighAccuracy: true,
    maximumAge: 0,
    timeout: 30_000,
  };

  state.watchId = navigator.geolocation.watchPosition(onPosition, onGeoError, options);
  return state.watchId !== null;
}

/* --------------------------------------------------------------- tracking */

async function startTracking() {
  if (state.tracking) return;

  if (!state.config.center) {
    toast('Tap the map to place the circle first', 'err');
    setStatus('warn', 'No circle yet', 'Tap the map to set the centre of your geofence.');
    return;
  }

  // Audio must be unlocked from inside the click gesture — do it first and
  // do not await anything before creating/resuming the AudioContext.
  const audioPromise = beeper.unlock();
  if (state.config.sound) {
    audioPromise.then((ok) => {
      state.audioReady = ok;
      if (!ok) {
        toast('Audio is blocked by the browser — tap Test beep', 'err');
      }
    });
    beeper.play({ pattern: 'test' }); // short confirmation chirp
  }
  if (state.config.vibrate) vibrate(60);

  state.tracking = true;
  geofence.reset();
  applyConfigToGeofence();

  updateStartButton();
  setStatus('live', 'Starting…', 'Acquiring a GPS fix…');

  const started = startWatch();
  if (!started) {
    state.tracking = false;
    updateStartButton();
    return;
  }

  await wake.request();
  if (!wake.active) {
    toast('Screen wake lock unavailable — keep the screen on manually', 'err');
  }
}

function stopTracking() {
  if (state.watchId !== null) {
    navigator.geolocation.clearWatch(state.watchId);
    state.watchId = null;
  }
  state.tracking = false;
  wake.release();
  map.clearUserPosition();
  $('followBtn').setAttribute('aria-pressed', 'false');
  updateStartButton();
  setStatus('idle', 'Not tracking', 'Press Start to begin');
  setZone(ZONE.OUTSIDE);
  setDistance(NaN);
  setMeta(NaN, NaN, null);
}

function updateStartButton() {
  const btn = $('startBtn');
  if (state.tracking) {
    btn.classList.add('stop');
    $('startBtnLabel').textContent = 'Stop Tracking';
  } else {
    btn.classList.remove('stop');
    $('startBtnLabel').textContent = 'Start Tracking';
  }
}

/* ---------------------------------------------------------- UI wiring */

function bindUi() {
  /* --- start / stop --- */
  $('startBtn').addEventListener('click', () => {
    if (state.tracking) stopTracking();
    else startTracking();
  });

  /* --- radius --- */
  $('radiusInput').addEventListener('input', (e) => setRadius(e.target.value));
  $('radiusNumber').addEventListener('change', (e) => setRadius(e.target.value));
  document.querySelectorAll('.chip[data-radius]').forEach((chip) => {
    chip.addEventListener('click', () => setRadius(chip.dataset.radius));
  });

  /* --- manual coordinates --- */
  $('applyCoordsBtn').addEventListener('click', () => {
    const lat = Number($('latInput').value);
    const lng = Number($('lngInput').value);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
      toast('Enter a valid latitude and longitude', 'err');
      return;
    }
    setCenter({ lat, lng });
    toast('Centre updated', 'ok');
  });

  /* --- map: place the centre at my position --- */
  $('centerHereBtn').addEventListener('click', () => {
    if (state.lastFix) {
      setCenter(state.lastFix);
      toast('Centre moved to your position', 'ok');
      return;
    }
    toast('Waiting for a GPS fix…');
    navigator.geolocation?.getCurrentPosition(
      (pos) => {
        setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        toast('Centre moved to your position', 'ok');
      },
      () => toast('No GPS fix available yet', 'err'),
      { enableHighAccuracy: true, timeout: 20_000 },
    );
  });

  /* --- map: follow toggle --- */
  $('followBtn').addEventListener('click', () => {
    const next = !map.follow;
    map.setFollow(next);
    $('followBtn').setAttribute('aria-pressed', String(next));
    toast(next ? 'Following your position' : 'Follow disabled');
  });

  /* --- advanced settings --- */
  $('bufferInput').addEventListener('change', (e) => {
    state.config.buffer = Math.min(200, Math.max(0, Number(e.target.value) || 0));
    applyConfigToGeofence();
    persist();
  });

  $('accuracyInput').addEventListener('input', (e) => {
    state.config.maxAccuracy = Number(e.target.value);
    $('accuracyLimitLabel').textContent = e.target.value;
    applyConfigToGeofence();
    persist();
  });

  $('soundToggle').addEventListener('change', (e) => {
    state.config.sound = e.target.checked;
    persist();
  });

  $('vibrateToggle').addEventListener('change', (e) => {
    state.config.vibrate = e.target.checked;
    persist();
  });

  $('beepOnStartToggle').addEventListener('change', (e) => {
    state.config.beepOnStartInside = e.target.checked;
    persist();
  });

  /* --- test beep (also unlocks audio) --- */
  $('testBeepBtn').addEventListener('click', () => {
    beeper.unlock().then((ok) => {
      state.audioReady = ok;
      if (state.config.sound) beeper.play({ pattern: 'test' });
      if (state.config.vibrate) vibrate(200);
      toast(ok ? 'Beep sent — check the volume' : 'Audio is blocked by the browser', ok ? 'ok' : 'err');
    });
  });

  /* --- keep the wake lock alive across screen locks --- */
  wake.onchange = (active) => {
    if (!active && state.tracking) {
      setStatus('warn', 'Tracking', 'Screen wake lock lost — tap the screen to restore it.');
    }
  };

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (state.tracking) {
      wake.revalidate();
      beeper.resume();
      // The watcher may have been throttled while hidden — ask for a fresh fix.
      navigator.geolocation?.getCurrentPosition(onPosition, () => {}, {
        enableHighAccuracy: true,
        maximumAge: 0,
        timeout: 15_000,
      });
    }
  });

  window.addEventListener('pagehide', () => {
    if (state.tracking) wake.release();
  });

  /* --- stale-fix watchdog --- */
  setInterval(() => {
    if (!state.tracking) return;
    const ago = state.lastFix ? Date.now() - state.lastFix.at : null;
    setMeta(state.lastFix?.accuracy ?? NaN, state.lastFix?.speed ?? NaN, ago);
    if (ago !== null && ago > STALE_AFTER_MS) {
      setStatus('warn', 'Tracking', 'No recent fix — the screen may have turned off.');
    }
  }, 5000);
}

/* ------------------------------------------------------------ PWA plumbing */

function bindInstallPrompt() {
  const btn = $('installBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.installPrompt = e;
    btn.hidden = false;
  });

  btn.addEventListener('click', async () => {
    if (!state.installPrompt) {
      toast('Use your browser menu → “Add to Home screen”', '');
      return;
    }
    state.installPrompt.prompt();
    const { outcome } = await state.installPrompt.userChoice;
    state.installPrompt = null;
    btn.hidden = true;
    if (outcome === 'accepted') toast('Installing…', 'ok');
  });

  window.addEventListener('appinstalled', () => {
    btn.hidden = true;
    state.installPrompt = null;
    toast('Installed — launch it from your home screen', 'ok');
  });

  // iOS Safari has no beforeinstallprompt; show the manual route instead.
  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (isIOS && !standalone) {
    btn.hidden = false;
    btn.textContent = 'Add to Home Screen';
    btn.addEventListener('click', () => {
      toast('Tap the Share icon, then “Add to Home Screen”', '');
    });
  }
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const register = () => {
    navigator.serviceWorker
      .register('sw.js')
      .then((reg) => {
        reg.addEventListener('updatefound', () => {
          const worker = reg.installing;
          if (!worker) return;
          worker.addEventListener('statechange', () => {
            if (worker.state === 'installed' && navigator.serviceWorker.controller) {
              toast('Update ready — reopen the app', '');
            }
          });
        });
      })
      .catch((err) => console.warn('Service worker registration failed', err));
  };

  // "load" may already have fired by the time we get here.
  if (document.readyState === 'complete') register();
  else window.addEventListener('load', register, { once: true });
}

/* -------------------------------------------------------------- bootstrap */

function syncUiFromConfig() {
  const cfg = state.config;

  $('radiusInput').value = cfg.radius;
  $('radiusNumber').value = cfg.radius;
  $('bufferInput').value = cfg.buffer;
  $('accuracyInput').value = cfg.maxAccuracy;
  $('accuracyLimitLabel').textContent = cfg.maxAccuracy;
  $('soundToggle').checked = cfg.sound;
  $('vibrateToggle').checked = cfg.vibrate;
  $('beepOnStartToggle').checked = cfg.beepOnStartInside;
  syncRadiusChips(cfg.radius);

  if (cfg.center) {
    $('latInput').value = cfg.center.lat.toFixed(6);
    $('lngInput').value = cfg.center.lng.toFixed(6);
  }
}

function checkEnvironment() {
  if (!window.isSecureContext) {
    setStatus(
      'error',
      'HTTPS required',
      'Geolocation needs a secure context. Open the app over HTTPS (or on localhost).',
    );
    toast('Geolocation requires HTTPS', 'err');
  }
  if (!('vibrate' in navigator)) {
    $('vibrateToggle').checked = false;
    $('vibrateToggle').disabled = true;
    state.config.vibrate = false;
  }
}

function init() {
  syncUiFromConfig();
  applyConfigToGeofence();

  map = new GeofenceMap($('map'), {
    onPick: (latlng) => {
      setCenter(latlng, { fly: false });
      const card = document.querySelector('.map-card');
      card.classList.add('is-dropping');
      setTimeout(() => card.classList.remove('is-dropping'), 400);
    },
  });

  if (state.config.center) {
    map.setCenter(state.config.center);
    map.setRadius(state.config.radius);
    map.flyTo(state.config.center, 16);
    setStatus('idle', 'Circle ready', 'Press Start to begin tracking');
    setZone(ZONE.OUTSIDE);
    showMapHint('Tap the map to move the circle', 4000);
  } else {
    map.setRadius(state.config.radius);
    setStatus('warn', 'No circle yet', 'Tap the map to set the centre of your geofence.');
    showMapHint('Tap the map to set the circle centre', 0);
  }

  bindUi();
  bindInstallPrompt();
  registerServiceWorker();
  checkEnvironment();
  updateStartButton();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
