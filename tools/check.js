#!/usr/bin/env node
/**
 * tools/check.js — sanity checks for the PWA bundle.
 *
 * Verifies that:
 *   - every JS file parses
 *   - every file referenced by index.html / manifest.json / sw.js exists
 *   - the service worker precache list matches the files on disk
 *   - the icons are the sizes the manifest claims
 *
 * Run with:  npm run check
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
let failures = 0;

const ok = (msg) => console.log(`  \x1b[32m✓\x1b[0m ${msg}`);
const fail = (msg) => {
  failures += 1;
  console.log(`  \x1b[31m✗\x1b[0m ${msg}`);
};
const section = (msg) => console.log(`\n\x1b[1m${msg}\x1b[0m`);

const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

/* ------------------------------------------------------------- JS syntax */

section('JavaScript syntax');
const jsFiles = ['server.js', 'sw.js', 'js/app.js', 'js/audio.js', 'js/geo.js', 'js/map.js', 'js/storage.js', 'js/wakeLock.js'];
for (const file of jsFiles) {
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, file)], { stdio: 'pipe' });
    ok(file);
  } catch (err) {
    fail(`${file}\n${err.stderr?.toString() ?? ''}`);
  }
}

/* ------------------------------------------------------------------ HTML */

section('index.html references');
const html = await fsp.readFile(path.join(ROOT, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
for (const ref of refs) {
  if (ref.startsWith('http')) continue;
  exists(ref) ? ok(ref) : fail(`missing: ${ref}`);
}

/* -------------------------------------------------------------- manifest */

section('manifest.json');
let manifest = {};
try {
  manifest = JSON.parse(await fsp.readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
  ok('parses');
} catch (err) {
  fail(`invalid JSON: ${err.message}`);
}

for (const key of ['name', 'short_name', 'start_url', 'display', 'icons']) {
  manifest[key] ? ok(`has "${key}"`) : fail(`missing "${key}"`);
}
manifest.display === 'standalone' ? ok('display is standalone') : fail('display must be "standalone"');

for (const icon of manifest.icons ?? []) {
  const iconPath = path.join(ROOT, icon.src);
  if (!fs.existsSync(iconPath)) {
    fail(`missing icon: ${icon.src}`);
    continue;
  }
  const buf = await fsp.readFile(iconPath);
  // PNG IHDR: bytes 16..24 hold width and height as big-endian uint32.
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const declared = icon.sizes.split('x').map(Number);
  if (width === declared[0] && height === declared[1]) {
    ok(`${icon.src} is ${width}x${height} (${icon.purpose})`);
  } else {
    fail(`${icon.src} is ${width}x${height} but the manifest says ${icon.sizes}`);
  }
}

/* -------------------------------------------------------- service worker */

section('sw.js precache list');
const sw = await fsp.readFile(path.join(ROOT, 'sw.js'), 'utf8');
const listMatch = sw.match(/const SHELL_ASSETS = \[([\s\S]*?)\];/);
if (!listMatch) {
  fail('could not find SHELL_ASSETS in sw.js');
} else {
  const assets = [...listMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  for (const asset of assets) {
    if (asset === './') continue;
    const rel = asset.replace(/^\.\//, '');
    exists(rel) ? ok(asset) : fail(`precached but missing: ${asset}`);
  }

  // Every local module that index.html loads should be precached.
  for (const file of jsFiles.filter((f) => f.startsWith('js/'))) {
    assets.includes(`./${file}`) ? ok(`${file} is precached`) : fail(`${file} is not precached`);
  }
}

/* --------------------------------------------------------------- results */

console.log('');
if (failures === 0) {
  console.log('\x1b[32mAll checks passed.\x1b[0m\n');
  process.exit(0);
} else {
  console.log(`\x1b[31m${failures} check(s) failed.\x1b[0m\n`);
  process.exit(1);
}
