/**
 * geo.js — distance maths and the geofence entry/exit state machine.
 *
 * The geofence uses hysteresis so that GPS jitter around the boundary
 * cannot produce a burst of false beeps:
 *
 *   exitThreshold  = radius + buffer   -> we are definitely OUTSIDE, re-arm
 *   enterThreshold = radius - buffer   -> we are definitely INSIDE, beep
 *
 * Anything between the two thresholds is the "uncertain band": the state is
 * left untouched. That is the "small buffer at the boundary" that keeps the
 * alarm quiet until the user is genuinely inside the circle.
 */

/** Mean Earth radius (IUGG) in metres. */
export const EARTH_RADIUS_M = 6371008.8;

const toRad = (deg) => (deg * Math.PI) / 180;

/**
 * Great-circle distance between two {lat, lng} points, in metres.
 * @param {{lat:number,lng:number}} a
 * @param {{lat:number,lng:number}} b
 * @returns {number}
 */
export function haversineDistance(a, b) {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);

  const sinLat = Math.sin(dLat / 2);
  const sinLng = Math.sin(dLng / 2);

  const h =
    sinLat * sinLat +
    Math.cos(lat1) * Math.cos(lat2) * sinLng * sinLng;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Nominal membership (ignores the buffer) — what the UI shows the user. */
export const ZONE = {
  OUTSIDE: 'outside',
  NEAR: 'near',
  INSIDE: 'inside',
};

/**
 * Tracks whether the user is inside the geofence and emits a single
 * "entered" event per crossing. Re-arms only after the user leaves.
 */
export class Geofence {
  constructor(options = {}) {
    this.center = options.center ?? null;   // {lat, lng}
    this.radius = options.radius ?? 100;    // metres
    this.buffer = options.buffer ?? 10;     // metres
    this.maxAccuracy = options.maxAccuracy ?? 50; // metres
    this.beepOnStartInside = options.beepOnStartInside ?? false;

    /** 'outside' | 'inside' — the sticky state used for trigger/re-arm. */
    this.state = 'outside';
    /** True once we have seen the first usable fix. */
    this.initialized = false;
  }

  /** Update the geofence definition. Resets the machine if the centre moved. */
  configure(options = {}) {
    const moved =
      options.center !== undefined &&
      (!this.center ||
        Math.abs(options.center.lat - this.center.lat) > 1e-9 ||
        Math.abs(options.center.lng - this.center.lng) > 1e-9);

    if (options.center !== undefined) this.center = options.center;
    if (options.radius !== undefined) this.radius = options.radius;
    if (options.buffer !== undefined) this.buffer = options.buffer;
    if (options.maxAccuracy !== undefined) this.maxAccuracy = options.maxAccuracy;
    if (options.beepOnStartInside !== undefined) {
      this.beepOnStartInside = options.beepOnStartInside;
    }

    if (moved) {
      this.state = 'outside';
      this.initialized = false;
    }
    return this;
  }

  /** The buffer can never eat more than half the radius, or it would never fire. */
  get effectiveBuffer() {
    return Math.max(0, Math.min(this.buffer, this.radius / 2));
  }

  get enterThreshold() {
    return Math.max(0, this.radius - this.effectiveBuffer);
  }

  get exitThreshold() {
    return this.radius + this.effectiveBuffer;
  }

  /**
   * Evaluate one position fix.
   * @param {{lat:number,lng:number,accuracy?:number}} fix
   * @returns {{
   *   status: 'ok'|'no-center'|'poor-accuracy'|'ignored',
   *   distance: number|null,
   *   zone: string,
   *   stableZone: string,
   *   trigger: boolean,
   *   reason?: string
   * }}
   */
  evaluate(fix) {
    if (!this.center) {
      return { status: 'no-center', distance: null, zone: ZONE.OUTSIDE, stableZone: ZONE.OUTSIDE, trigger: false };
    }

    const distance = haversineDistance(fix, this.center);
    const accuracy = Number.isFinite(fix.accuracy) ? fix.accuracy : null;

    // Poor-accuracy fixes are discarded outright: we do not move the state.
    if (accuracy !== null && accuracy > this.maxAccuracy) {
      return {
        status: 'poor-accuracy',
        distance,
        zone: this.zoneFor(distance),
        stableZone: this.zoneFor(distance),
        trigger: false,
        reason: `accuracy ${Math.round(accuracy)} m > ${this.maxAccuracy} m`,
      };
    }

    // Nominal (user-facing) zone vs. buffered (alarm) zone.
    const zone = this.zoneFor(distance);
    const stableZone =
      distance <= this.enterThreshold
        ? ZONE.INSIDE
        : distance >= this.exitThreshold
          ? ZONE.OUTSIDE
          : ZONE.NEAR;

    let trigger = false;

    if (!this.initialized) {
      // First usable fix of this session: adopt the state, don't announce it.
      this.initialized = true;
      this.state = stableZone === ZONE.INSIDE ? 'inside' : 'outside';
      if (this.state === 'inside' && this.beepOnStartInside) trigger = true;
    } else if (this.state === 'inside') {
      if (stableZone === ZONE.OUTSIDE) {
        this.state = 'outside'; // re-armed for the next entry
      }
    } else if (stableZone === ZONE.INSIDE) {
      this.state = 'inside';
      trigger = true; // crossed outside -> inside
    }

    return { status: 'ok', distance, zone, stableZone, trigger };
  }

  /** Nominal zone for a distance (no buffer applied). */
  zoneFor(distance) {
    if (distance <= this.radius) return ZONE.INSIDE;
    if (distance <= this.radius + this.effectiveBuffer) return ZONE.NEAR;
    return ZONE.OUTSIDE;
  }

  /** Forget the current position state (used when tracking restarts). */
  reset() {
    this.state = 'outside';
    this.initialized = false;
  }
}

/**
 * Human-readable message for a GeolocationPositionError.
 * @param {number} code GeolocationPositionError.PERMISSION_DENIED | POSITION_UNAVAILABLE | TIMEOUT
 * @param {GeolocationPositionError} [err]
 */
export function describeGeolocationError(code, err) {
  switch (code) {
    case 1:
      return {
        title: 'Location permission denied',
        detail:
          'Allow location access for this site in the browser settings, then press Start again.',
      };
    case 2:
      return {
        title: 'GPS signal unavailable',
        detail:
          'No position could be determined. Move to an open area or enable location services, then retry.',
      };
    case 3:
      return {
        title: 'Location timed out',
        detail:
          'The device did not return a position in time. Move to an open area with a clearer sky and retry.',
      };
    default:
      return {
        title: 'Location error',
        detail: (err && err.message) || 'An unknown geolocation error occurred.',
      };
  }
}

/** Format metres for the UI (m below 1 km, otherwise km). */
export function formatDistance(metres) {
  if (!Number.isFinite(metres)) return '—';
  if (metres < 1000) return `${Math.round(metres)}`;
  return `${(metres / 1000).toFixed(metres < 10000 ? 2 : 1)}`;
}

export function distanceUnit(metres) {
  if (!Number.isFinite(metres)) return '';
  return metres < 1000 ? 'm' : 'km';
}

/** Format m/s as km/h. */
export function formatSpeed(mps) {
  if (!Number.isFinite(mps)) return '—';
  return `${(mps * 3.6).toFixed(mps < 1 ? 1 : 0)}`;
}
