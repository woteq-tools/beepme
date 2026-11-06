# Geofence Beep

An installable Android **PWA** that beeps and vibrates the moment you walk, cycle,
drive or ride into a circle you placed on a map.

**Live:** <https://woteq-tools.github.io/beepme/>

Set a centre (tap the map or type lat/lng), choose a radius, press **Start Tracking**,
and the app plays a Web Audio alert plus a haptic buzz when you cross the boundary —
once per entry.

> **Read this first:** browsers have no background geolocation. The alert only fires
> while the app is open in the foreground with the screen on. The app uses the
> **Screen Wake Lock API** to keep the screen alive for you, and shows this warning
> in the UI. If you need alerts with the phone locked or in the background, you need a
> native Android app (Kotlin) or a Capacitor wrapper with a background geolocation
> plugin — see [Limitations](#limitations).

---

## Features

| | |
|---|---|
| **Map** | Leaflet + OpenStreetMap, vendored locally so it works offline |
| **Circle** | Tap the map, drag the pin, or enter exact coordinates; radius 10 m – 5 km |
| **Persistence** | `localStorage` — the circle survives reloads, restarts and offline launches |
| **Tracking** | `navigator.geolocation.watchPosition()` with `enableHighAccuracy: true` |
| **Distance** | Haversine great-circle distance on every fix |
| **False triggers** | Accuracy filter (default: discard fixes worse than 50 m) **and** a boundary buffer (hysteresis) |
| **Alert** | Web Audio beep (4-tone) + `navigator.vibrate()` + visual flash + toast |
| **Re-arm** | Fires once per entry; re-arms only after the user is clearly outside again |
| **Screen** | Screen Wake Lock, re-acquired whenever the page becomes visible |
| **PWA** | `manifest.json` (standalone), service worker (app shell + map tiles), `beforeinstallprompt` install button |
| **Offline** | App shell precached; viewed map tiles cached in a size-capped cache |
| **Errors** | Clear messages for permission denied, GPS unavailable and timeout |

No accounts, no server, no analytics — the circle is stored only on the device.

---

## File structure

```
geofence-beep/
├── index.html                  # single-page UI
├── manifest.json               # PWA manifest (standalone, icons, shortcut)
├── sw.js                       # service worker (app shell + tile caching)
├── server.js                   # zero-dependency dev server (HTTP + HTTPS)
├── package.json                # npm scripts
├── css/
│   └── styles.css              # mobile-first styles, dark + light themes
├── js/
│   ├── app.js                  # orchestration: UI wiring, tracking, alerts, PWA
│   ├── geo.js                  # Haversine + geofence entry/exit state machine
│   ├── audio.js                # Web Audio beep + vibration
│   ├── map.js                  # Leaflet wrapper (circle, pins, live position)
│   ├── storage.js              # config load/save with validation
│   └── wakeLock.js             # Screen Wake Lock wrapper
├── icons/
│   ├── icon-192.png            # launcher icon
│   ├── icon-512.png            # launcher icon
│   ├── icon-maskable-512.png   # Android adaptive icon
│   └── favicon.png
├── vendor/
│   └── leaflet/                # Leaflet 1.9.4 (BSD-2-Clause) + LICENSE.txt
├── tools/
│   ├── make-icons.py           # regenerates the PNG icons
│   ├── check.js                # bundle sanity checks (npm run check)
│   └── smoke-test.mjs          # end-to-end test in headless Chrome (npm run test)
└── certs/                      # generated self-signed certificate (git-ignored)
```

Everything is static — no build step, no runtime dependencies, no framework.

---

## Setup

### 1. Run it locally (desktop)

```bash
node server.js            # or: npm start
```

Open <http://localhost:8080>.

Chrome treats `http://localhost` as a **secure context**, so geolocation, the Wake
Lock and the service worker all work on the desktop without any certificates.

### 2. Run it on your Android phone

A phone talking to your laptop over the LAN is **not** a secure context, so plain
HTTP will not give you geolocation. Use the built-in HTTPS server:

```bash
node server.js --https    # or: npm run start:https
```

It prints something like:

```
Local:    https://localhost:8443/
Network:  https://192.168.1.42:8443/
```

1. Put the phone and the computer on the same Wi-Fi.
2. Open the **Network** URL in Chrome on the phone.
3. The certificate is self-signed, so Chrome warns once — tap
   **Advanced → Proceed to … (unsafe)**.
4. Tap **Start Tracking** and allow location access.

> The self-signed certificate is fine for testing. For anything else, deploy to a
> host with a real certificate (next section).

### 3. Deploy

Any static host works — the app is plain files with relative paths, so it can live
in a subdirectory.

| Host | How |
|---|---|
| **GitHub Pages** | This repo: push to `main`, the `Deploy to GitHub Pages` workflow publishes it to <https://woteq-tools.github.io/beepme/> |
| **Netlify** | Drag the folder onto <https://app.netlify.com/drop> |
| **Vercel** | `npx vercel --prod` |
| **Cloudflare Pages** | Connect the repo, build command *(none)*, output directory `/` |
| **Your own server** | Copy the files and serve them over HTTPS (nginx, Caddy, Apache) |

All of these give you HTTPS automatically, which is what the Geolocation API
requires.

The GitHub Pages workflow stages only the files the app needs (`index.html`,
`manifest.json`, `sw.js`, `css/`, `js/`, `icons/`, `vendor/leaflet/`) into `_site`
and uploads that as the Pages artifact. See [DEPLOY.md](DEPLOY.md) for the details.

### 4. Install on Android

1. Open the app in **Chrome for Android**.
2. Tap the **Install app** button in the header (it appears when Chrome fires
   `beforeinstallprompt`).
   - If it does not appear, use **⋮ → Add to Home screen / Install app**.
3. Launch it from the home screen — it opens in standalone mode with no browser UI.

### 5. Optional: regenerate the icons

```bash
python3 tools/make-icons.py     # or: npm run icons
```

Requires Pillow (`pip install pillow`). Edit the drawing constants at the top of
`tools/make-icons.py` to change the artwork.

### 6. Optional: verify the bundle

```bash
npm run check
```

Parses every JS file, resolves every reference in `index.html` / `manifest.json` /
`sw.js`, confirms the icons are the size the manifest claims, and checks that the
service worker precache list matches the files on disk.

### 7. Optional: run the end-to-end test

```bash
npm install --no-save puppeteer-core
npm start                 # terminal 1
npm test                  # terminal 2
```

The test drives a real headless Chrome with a mocked Geolocation API and asserts the
behaviour that matters: one beep per entry, no beep while jittering inside the
circle, re-arming after leaving, poor-accuracy fixes being ignored, the boundary
buffer suppressing false triggers, persistence to `localStorage`, the service
worker, and a full offline reload.

---

## How it works

### Distance

`js/geo.js` implements the Haversine formula against the IUGG mean Earth radius
(6 371 008.8 m), which is accurate to well under a metre for the short distances a
city geofence deals with.

### Entry / exit state machine

The naive version of this app — `if (distance < radius) beep()` — beeps constantly
when you stand on the edge, because GPS noise alone is often larger than the
difference between two fixes. This app uses **hysteresis**:

```
exitThreshold  = radius + buffer     ← "definitely outside", re-arm here
enterThreshold = radius - buffer     ← "definitely inside", beep here
```

* Below `enterThreshold` → **inside** → beep + vibrate, switch state to `inside`.
* Above `exitThreshold` → **outside** → switch state to `outside`, re-armed.
* In between → the **uncertain band**. The state is left completely alone, so
  jitter around the edge can never produce a beep, and standing still inside the
  circle never re-triggers it.

The buffer defaults to 10 m and is adjustable (0–200 m) under
*Exact coordinates & advanced*. It is capped at half the radius, so a tiny circle
with a huge buffer can still fire.

### Accuracy filtering

Any fix whose `accuracy` is worse than the limit (default 50 m, adjustable 10–200 m)
is **discarded outright** — it does not update the distance, the zone or the state
machine. The UI says *"Waiting for a better fix (accuracy 120 m > 50 m)"* so it is
clear the app is working, not stuck.

### Audio unlock

Android Chrome will not start an `AudioContext` without a user gesture. The
**Start Tracking** button (and the **Test beep** button) create and `resume()` the
context synchronously inside the click handler, then play a one-frame silent buffer
to fully release the audio pipeline. The context is also resumed on
`visibilitychange`, because Android suspends it when the app is backgrounded.

### Wake Lock

`navigator.wakeLock.request('screen')` is requested when tracking starts. The lock
is released by the browser whenever the page is hidden, so it is re-acquired on every
`visibilitychange → visible`. If the lock is lost while tracking, the status line
tells the user to tap the screen.

### Service worker

| Request type | Strategy |
|---|---|
| Navigation | network-first (with navigation preload) → cached shell → offline page |
| App shell (same origin) | network-first with a 3 s timeout → cached copy |
| `tile.openstreetmap.org` | stale-while-revalidate into a separate cache, capped at 800 tiles |

The app shell is precached on install, so the app opens and works offline after the
first visit. The same-origin strategy is network-first on purpose: your browser
always runs the code that is actually deployed, and an edit shows up on the next
reload instead of two. When the device is offline the network request fails
immediately, so the cached copy is served without any delay.

Only tiles you actually looked at are cached, so the load on the OSM tile servers
stays reasonable.

---

## Configuration

Everything is stored under the `geofence-beep:config:v1` key in `localStorage`:

```json
{
  "center": { "lat": 52.52, "lng": 13.405 },
  "radius": 100,
  "buffer": 10,
  "maxAccuracy": 50,
  "sound": true,
  "vibrate": true,
  "beepOnStartInside": false
}
```

* **buffer** — hysteresis band at the boundary (see above).
* **maxAccuracy** — fixes worse than this are ignored.
* **beepOnStartInside** — by default, starting a tracking session while already
  inside the circle does *not* beep (there was no entry). Enable it if you want the
  alert anyway.

---

## Limitations

* **Foreground only.** There is no background geolocation in browsers. If the app is
  closed, backgrounded, or the phone is locked, no alert is fired. The Wake Lock
  mitigates this by keeping the screen on, but it cannot fully replace a native
  background service.
* **Battery / GPS.** `enableHighAccuracy: true` uses the GPS chip, which is
  accurate but power-hungry. A long trip will drain the battery faster than usual.
* **The first fix is slow.** With high accuracy enabled, a cold GPS fix can take
  10–60 seconds outdoors.
* **Doors and buildings.** A 3-D building can put the GPS fix on the wrong side of a
  wall — the buffer is your only protection. Use a generous radius for indoor
  targets.
* **OSM tiles.** The public OSM tile servers are for light use only. For heavy or
  long-term offline use, point `TILE_URL` in `js/map.js` at your own tile server or
  a self-hosted style.
* **iOS Safari** works too (Web Audio, Vibration API and Wake Lock are supported on
  recent iOS), but there is no `beforeinstallprompt` — use
  *Share → Add to Home Screen*. The install button adapts automatically.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| "HTTPS required" | You are on plain HTTP from a non-localhost origin. Use `--https` or deploy. |
| "Location permission denied" | Tap the lock/padlock icon in Chrome's address bar → Permissions → Location → Allow. Then press Start again. |
| No beep, no vibration | Tap **Test beep & vibration** first — Android requires a user gesture before audio is allowed. Also check the media volume and that the phone is not on silent. |
| Distance jumps around | Raise the **buffer** and lower the **max accuracy** limit under *advanced*. |
| Never triggers | Check the status line: if it says *"Waiting for a better fix"*, the accuracy limit is too strict — raise it. |
| App does not appear installable | You need HTTPS, a valid `manifest.json` and a registered service worker. Run `npm run check`. |
| Map is blank offline | Only tiles you viewed before are cached. Load the area while online first. |

---

## Privacy

The geofence, the radius and your preferences never leave the device — there is no
backend. The only network requests are to `tile.openstreetmap.org` for map tiles
(the usual OSM tile-usage terms apply) and to your own origin for the app files.

---

## Credits

* [Leaflet](https://leafletjs.com/) 1.9.4 — BSD-2-Clause, vendored in `vendor/leaflet/`
* Map tiles © [OpenStreetMap contributors](https://www.openstreetmap.org/copyright)
