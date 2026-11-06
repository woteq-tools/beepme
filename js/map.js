/**
 * map.js — Leaflet map: geofence circle, centre pin, live user position.
 *
 * Markers are built from pure CSS (divIcon) so the app needs no image
 * assets at runtime and keeps working offline.
 */

const L = window.L;

export const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const CENTER_ICON = L.divIcon({
  className: 'ctr-marker',
  html: '<div class="ring"></div>',
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const ME_ICON = L.divIcon({
  className: 'me-marker',
  html: '<div class="core"></div>',
  iconSize: [16, 16],
  iconAnchor: [8, 8],
});

export class GeofenceMap {
  /**
   * @param {HTMLElement} el container element
   * @param {{onPick?: (latlng:{lat:number,lng:number}) => void}} handlers
   */
  constructor(el, handlers = {}) {
    this.handlers = handlers;
    this.follow = false;
    this.lastUserLatLng = null;

    this.map = L.map(el, {
      zoomControl: true,
      attributionControl: true,
      tap: true,
      preferCanvas: false,
    }).setView([20, 0], 2);

    this.tileLayer = L.tileLayer(TILE_URL, {
      maxZoom: 19,
      minZoom: 2,
      attribution: TILE_ATTRIBUTION,
      crossOrigin: true,
      updateWhenIdle: false,
      keepBuffer: 3,
    }).addTo(this.map);

    this.circle = L.circle([0, 0], {
      radius: 100,
      color: '#ff8a3d',
      weight: 2,
      opacity: 0.95,
      fillColor: '#ff8a3d',
      fillOpacity: 0.13,
      interactive: false,
    }).addTo(this.map);

    this.centerMarker = L.marker([0, 0], {
      icon: CENTER_ICON,
      draggable: true,
      interactive: false,
      keyboard: false,
      zIndexOffset: 500,
    }).addTo(this.map);

    this.meMarker = L.marker([0, 0], {
      icon: ME_ICON,
      interactive: false,
      keyboard: false,
      zIndexOffset: 1000,
    }).addTo(this.map);

    this.accuracyCircle = L.circle([0, 0], {
      radius: 0,
      color: '#4f8cff',
      weight: 1,
      opacity: 0.5,
      fillColor: '#4f8cff',
      fillOpacity: 0.12,
      interactive: false,
    }).addTo(this.map);

    this.map.on('click', (e) => {
      if (this.handlers.onPick) this.handlers.onPick(e.latlng);
    });

    this.centerMarker.on('dragend', () => {
      const pos = this.centerMarker.getLatLng();
      if (this.handlers.onPick) this.handlers.onPick({ lat: pos.lat, lng: pos.lng });
    });

    // Leaflet needs a nudge on some mobile browsers when it is created
    // inside a container that is still being laid out.
    setTimeout(() => this.map.invalidateSize(), 250);
    window.addEventListener('orientationchange', () => setTimeout(() => this.map.invalidateSize(), 300));
  }

  /** Move the geofence circle and its centre pin. */
  setCenter(latlng) {
    this.centerMarker.setLatLng(latlng);
    this.circle.setLatLng(latlng);
    if (!this.follow) {
      this.map.setView(latlng, Math.max(this.map.getZoom(), 15));
    }
  }

  /** Change the circle radius in metres. */
  setRadius(metres) {
    this.circle.setRadius(metres);
  }

  /** Update the live user position marker. */
  setUserPosition(latlng, accuracy) {
    this.lastUserLatLng = latlng;
    this.meMarker.setLatLng(latlng);
    this.meMarker.setOpacity(1);
    this.meMarker.getElement()?.classList.add('tracking');

    if (Number.isFinite(accuracy) && accuracy > 0) {
      this.accuracyCircle.setLatLng(latlng);
      this.accuracyCircle.setRadius(accuracy);
      this.accuracyCircle.setStyle({ opacity: 0.5 });
    } else {
      this.accuracyCircle.setRadius(0);
    }

    if (this.follow) {
      this.map.setView(latlng, this.map.getZoom());
    }
  }

  /** Hide the live position marker (tracking stopped). */
  clearUserPosition() {
    this.meMarker.setOpacity(0);
    this.meMarker.getElement()?.classList.remove('tracking');
    this.accuracyCircle.setRadius(0);
    this.follow = false;
  }

  /** Fit the view so the whole circle is visible. */
  fitCircle() {
    if (!this.circle.getLatLng()) return;
    this.map.fitBounds(this.circle.getBounds(), { padding: [40, 40] });
  }

  setFollow(on) {
    this.follow = Boolean(on);
    if (this.follow && this.lastUserLatLng) {
      this.map.setView(this.lastUserLatLng, Math.max(this.map.getZoom(), 16));
    }
  }

  /** Centre the map on a coordinate (used for the manual lat/lng entry). */
  flyTo(latlng, zoom = 16) {
    this.map.setView(latlng, zoom);
  }
}
