'use strict';

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const db = require('./db');
const { sendJson, readBody, HttpError } = require('./util');
const seedDemo = require('./seed');
const monitor = require('./monitor');

const auth = require('./auth');

const adminRoutes = require('./routes/admin').routes;
const playerRoutes = require('./routes/player').routes;
const integrationRoutes = require('./routes/integrations').routes;
const remoteRoutes = require('./routes/remote').routes;
const authRoutes = require('./routes/auth').routes;

const PORT = parseInt(process.env.PORT, 10) || 4700;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

// ---- routing --------------------------------------------------------------

const allRoutes = [...adminRoutes, ...playerRoutes, ...integrationRoutes, ...remoteRoutes, ...authRoutes];

function compile(pattern) {
  const names = [];
  const regex = new RegExp('^' + pattern.replace(/:[^/]+/g, (seg) => {
    names.push(seg.slice(1));
    return '([^/]+)';
  }) + '$');
  return { regex, names };
}
for (const r of allRoutes) Object.assign(r, compile(r.pattern));

function matchRoute(method, pathname) {
  for (const r of allRoutes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(pathname);
    if (!m) continue;
    const params = {};
    r.names.forEach((n, i) => { params[n] = decodeURIComponent(m[i + 1]); });
    return { handler: r.handler, params };
  }
  return null;
}

// Endpoints with their own auth story: players use unguessable device keys,
// the staff remote a per-venue token, integrations push by venue id, and the
// auth bootstrap endpoints must be reachable before any session exists.
// Everything else under /api requires a logged-in user (or the legacy env
// token, which acts as a superadmin API key).
const OPEN_PREFIXES = ['/api/player/', '/api/integrations/', '/api/remote/'];
const OPEN_PATHS = new Set(['/api/auth/state', '/api/auth/login', '/api/auth/setup']);

function isOpenApi(pathname) {
  return OPEN_PATHS.has(pathname) || OPEN_PREFIXES.some((p) => pathname.startsWith(p));
}

// ---- uploads ----------------------------------------------------------------

async function handleUpload(req, res, url) {
  const original = (url.searchParams.get('name') || 'file').replace(/[^\w.-]+/g, '_');
  const ext = path.extname(original).toLowerCase();
  if (!MIME[ext]) throw new HttpError(400, `unsupported file extension: ${ext || '(none)'}`);
  const buf = await readBody(req, 200 * 1024 * 1024); // media files up to 200 MB
  if (!buf.length) throw new HttpError(400, 'empty upload');
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  // Files are namespaced by business so tenants only see their own library.
  const orgPrefix = `${req.user.org_id || 'global'}__`;
  const name = `${orgPrefix}${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}-${original}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, name), buf);
  sendJson(res, 201, { url: `/uploads/${name}`, bytes: buf.length });
}

// ---- static files -------------------------------------------------------------

function serveFile(res, filePath, cacheable) {
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  if (stat.isDirectory()) return serveFile(res, path.join(filePath, 'index.html'), cacheable);
  const ext = path.extname(filePath).toLowerCase();
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    // Players cache uploaded media hard (immutable names); app shell stays fresh.
    'Cache-Control': cacheable ? 'public, max-age=31536000, immutable' : 'no-cache',
  });
  fs.createReadStream(filePath).pipe(res);
  return true;
}

function safeJoin(root, requestPath) {
  const resolved = path.normalize(path.join(root, requestPath));
  if (!resolved.startsWith(root + path.sep) && resolved !== root) return null;
  return resolved;
}

// ---- server -----------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  try {
    if (pathname.startsWith('/api/')) {
      if (!isOpenApi(pathname)) {
        req.user = auth.resolveUser(req, url);
        if (!req.user) throw new HttpError(401, 'sign in required');
      }
      if (pathname === '/api/upload' && req.method === 'POST') {
        auth.requireRole(req.user, 'editor');
        return await handleUpload(req, res, url);
      }
      const match = matchRoute(req.method, pathname);
      if (!match) throw new HttpError(404, 'not found');
      return await match.handler(req, res, match.params, url);
    }

    if (pathname.startsWith('/uploads/')) {
      const file = safeJoin(UPLOAD_DIR, pathname.slice('/uploads/'.length));
      if (file && serveFile(res, file, true)) return;
      throw new HttpError(404, 'not found');
    }

    if (pathname === '/') {
      res.writeHead(302, { Location: '/admin/' });
      return res.end();
    }

    const file = safeJoin(PUBLIC_DIR, pathname);
    if (file && serveFile(res, file, false)) return;
    throw new HttpError(404, 'not found');
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(`[korvix] ${req.method} ${pathname}:`, err);
    if (!res.headersSent) sendJson(res, status, { error: err.message || 'internal error' });
    else res.end();
  }
});

function start(port = PORT, host = HOST) {
  db.open();
  if (db.isEmpty() && process.env.KORVIX_NO_DEMO !== '1') {
    seedDemo();
    console.log('[korvix] empty database — seeded "The Korvix Tavern" demo venue');
  }
  monitor.start();
  return new Promise((resolve) => {
    server.listen(port, host, () => {
      const addr = server.address();
      console.log(`[korvix] signage CMS listening on http://${host}:${addr.port}`);
      console.log(`[korvix] dashboard: http://localhost:${addr.port}/admin/`);
      console.log(`[korvix] player:    http://localhost:${addr.port}/player/`);
      const hasUsers = !!db.get('SELECT id FROM users LIMIT 1');
      if (!hasUsers) console.log('[korvix] no users yet — open the dashboard to create the first admin account');
      resolve(server);
    });
  });
}

if (require.main === module) start();

module.exports = { start, server };
