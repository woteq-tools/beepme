/**
 * storage.js — persistent configuration (localStorage with a safe fallback).
 *
 * The saved circle survives reloads, browser restarts and offline launches.
 * If localStorage is unavailable (private mode / disabled cookies) the app
 * still runs, it just will not remember the geofence.
 */

export const STORAGE_KEY = 'geofence-beep:config:v1';

export const DEFAULTS = {
  center: null,             // { lat, lng } of the circle centre
  radius: 100,              // metres
  buffer: 10,               // metres of hysteresis at the boundary
  maxAccuracy: 50,          // metres — fixes worse than this are discarded
  sound: true,
  vibrate: true,
  beepOnStartInside: false,
};

const clamp = (value, min, max, fallback) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

/** Normalise anything that comes out of storage into a valid config. */
export function normalise(raw) {
  const cfg = { ...DEFAULTS, ...(raw && typeof raw === 'object' ? raw : {}) };

  if (cfg.center) {
    const lat = Number(cfg.center.lat);
    const lng = Number(cfg.center.lng);
    if (Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
      cfg.center = { lat, lng };
    } else {
      cfg.center = null;
    }
  } else {
    cfg.center = null;
  }

  cfg.radius = clamp(cfg.radius, 10, 5000, DEFAULTS.radius);
  cfg.buffer = clamp(cfg.buffer, 0, 200, DEFAULTS.buffer);
  cfg.maxAccuracy = clamp(cfg.maxAccuracy, 10, 200, DEFAULTS.maxAccuracy);
  cfg.sound = Boolean(cfg.sound);
  cfg.vibrate = Boolean(cfg.vibrate);
  cfg.beepOnStartInside = Boolean(cfg.beepOnStartInside);

  return cfg;
}

/** Load the saved configuration (never throws). */
export function loadConfig() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    return normalise(JSON.parse(raw));
  } catch (err) {
    console.warn('Could not read saved geofence', err);
    return { ...DEFAULTS };
  }
}

/** Persist the configuration. @returns {boolean} true when it was stored */
export function saveConfig(config) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(normalise(config)));
    return true;
  } catch (err) {
    console.warn('Could not save geofence', err);
    return false;
  }
}

/** Remove the saved configuration. */
export function clearConfig() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
