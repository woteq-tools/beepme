# Deployment

The app is published with **GitHub Pages** at:

> **https://woteq-tools.github.io/beepme/**

## How it works

`.github/workflows/deploy.yml` runs on every push to `main`:

1. `actions/configure-pages@v5` turns Pages on for the repository (`enablement: true`).
2. The **Stage the app** step copies only the files the app needs into `_site/`.
3. `actions/upload-pages-artifact@v3` uploads `_site/` as the Pages artifact.
4. `actions/deploy-pages@v4` publishes it.

Nothing is built — there is no bundler and no dependency install step. The app is
plain HTML, CSS, ES modules and JSON.

## Staged files

```
_site/
├── index.html
├── manifest.json
├── sw.js
├── .nojekyll
├── css/styles.css
├── js/{app,audio,geo,map,storage,wakeLock}.js
├── icons/*.png
└── vendor/leaflet/{leaflet.js,leaflet.css,images/*}
```

`tools/`, `server.js`, `package.json` and the README are **not** published — they
are development-only.

## Subpath safety

Everything in the app uses **relative** URLs (`./css/styles.css`, `js/app.js`,
`manifest.json`, `sw.js`), so it works unchanged from a subpath such as
`/beepme/`. Concretely:

* `navigator.serviceWorker.register('sw.js')` resolves to `/beepme/sw.js`, giving a
  service worker scope of `/beepme/`.
* The ES module imports in `js/app.js` resolve relative to the module URL.
* The Leaflet CSS resolves `images/*` relative to the stylesheet.
* `manifest.json` uses `"start_url": "./index.html"` and `"scope": "./"`.

This was verified by serving the app from a `/beepme/` subpath and running the full
end-to-end suite (`npm test`) against it — including the service worker scope and
the offline reload.

## Manual deployment

You can also publish from the `main` branch directly
(**Settings → Pages → Source → Deploy from a branch → `main` / `/ (root)`**).
The Actions workflow is preferred because it publishes only the files the app
needs.

## Versioning the service worker

`sw.js` caches the app shell under `geofence-beep-shell-v1.0.0`. When you change
the app, bump `VERSION` in `sw.js` so the old cache is deleted and the new assets
are fetched:

```js
const VERSION = 'v1.0.1';
```

Same-origin assets are served **network-first with a 3-second timeout**, so a
normal code change reaches the browser on the next reload even without a version
bump — but bumping the version is what clears stale entries from the cache.

## Manual testing on a phone

The deployed URL already uses HTTPS, so a phone on mobile data can open it
directly:

1. Open <https://woteq-tools.github.io/beepme/> in Chrome for Android.
2. Allow location access when prompted.
3. Use **⋮ → Add to Home screen / Install app** to install it.
