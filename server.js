#!/usr/bin/env node
/**
 * server.js — zero-dependency static server for local development.
 *
 * Usage:
 *   node server.js                 # http://localhost:8080
 *   node server.js --https         # https://<lan-ip>:8443 (self-signed)
 *   node server.js --port 3000     # custom port
 *   node server.js --host 0.0.0.0  # bind address
 *
 * Geolocation requires a secure context:
 *   - http://localhost  is treated as secure by Chrome (desktop testing).
 *   - On a phone you need real HTTPS -> use --https and accept the
 *     self-signed certificate warning, or deploy behind a real certificate.
 */

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CERT_DIR = path.join(ROOT, 'certs');

/* --------------------------------------------------------------- options */

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = args[i + 1];
  return next && !next.startsWith('--') ? next : true;
};

const useHttps = args.includes('--https');
const port = Number(flag('port', useHttps ? 8443 : 8080));
const host = String(flag('host', '0.0.0.0'));

/* ------------------------------------------------------------- mime types */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

/* ---------------------------------------------------------------- helpers */

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address);
    }
  }
  return out;
}

async function serveFile(req, res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const stat = await fsp.stat(filePath);

  if (stat.isDirectory()) {
    return serveFile(req, res, path.join(filePath, 'index.html'));
  }

  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // Dev server: always revalidate so edits show up immediately.
    'Cache-Control': 'no-cache',
    'Service-Worker-Allowed': '/',
  };

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(filePath).pipe(res);
}

async function handle(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith('/')) pathname += 'index.html';

    // Block path traversal.
    const filePath = path.normalize(path.join(ROOT, pathname));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403).end('Forbidden');
      return;
    }

    try {
      await serveFile(req, res, filePath);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404 Not Found');
    }
  } catch (err) {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' }).end('500 ' + err.message);
  }
}

/* ------------------------------------------------------------------- TLS */

function ensureCertificate(hosts) {
  fs.mkdirSync(CERT_DIR, { recursive: true });
  const keyFile = path.join(CERT_DIR, 'key.pem');
  const certFile = path.join(CERT_DIR, 'cert.pem');

  if (fs.existsSync(keyFile) && fs.existsSync(certFile)) {
    return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
  }

  const alt = hosts.filter(Boolean).map((h) => `DNS:${h}`).concat(['IP:127.0.0.1']).join(',');

  console.log('Generating a self-signed certificate in ./certs ...');
  execFileSync(
    'openssl',
    [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
      '-keyout', keyFile,
      '-out', certFile,
      '-days', '825',
      '-subj', '/CN=geofence-beep.local',
      '-addext', `subjectAltName=${alt}`,
    ],
    { stdio: ['ignore', 'ignore', 'ignore'] },
  );

  return { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) };
}

/* ------------------------------------------------------------------ boot */

const scheme = useHttps ? 'https' : 'http';
let server;

if (useHttps) {
  const ips = lanAddresses();
  const creds = ensureCertificate(['localhost', ...ips]);
  server = https.createServer(creds, handle);
} else {
  server = http.createServer(handle);
}

server.listen(port, host, () => {
  console.log('');
  console.log('  Geofence Beep — development server');
  console.log('  ---------------------------------');
  console.log(`  Local:    ${scheme}://localhost:${port}/`);
  for (const ip of lanAddresses()) {
    console.log(`  Network:  ${scheme}://${ip}:${port}/`);
  }
  if (useHttps) {
    console.log('');
    console.log('  The certificate is self-signed: Chrome will warn once.');
    console.log('  Tap "Advanced" -> "Proceed to ... (unsafe)" to continue.');
  } else {
    console.log('');
    console.log('  Note: a phone on the LAN needs HTTPS for geolocation.');
    console.log('  Restart with:  node server.js --https');
  }
  console.log('');
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: node server.js --port ${port + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});
