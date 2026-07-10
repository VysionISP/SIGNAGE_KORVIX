'use strict';

// Admin/CMS API: venues, zones, screens, media, playlists, schedules,
// emergency broadcast and fleet health. Consumed by the dashboard SPA.

const path = require('node:path');
const fs = require('node:fs');
const db = require('../db');
const sse = require('../sse');
const { sendJson, readJson, HttpError, required } = require('../util');
const { OFFLINE_AFTER_MS } = require('../monitor');
const auth = require('../auth');

// Audit-trail attribution ('API token' for the legacy env key).
const actorOf = (req) => req.user?.email || req.user?.name || null;

// Tenant scoping: assertVenue() 404s on venues outside the caller's business
// and enforces the minimum role. Sub-resources (screens, media, playlists,
// schedules, draws, emergencies) resolve to their venue first, then assert.

function nudgeVenue(venueId) {
  const keys = db.all(
    'SELECT device_key FROM screens WHERE venue_id = ? AND device_key IS NOT NULL', venueId,
  ).map((r) => r.device_key);
  sse.broadcast(keys, 'refresh', { reason: 'content-updated' });
}

function nudgeAll() {
  sse.broadcastAll('refresh', { reason: 'content-updated' });
}

function screenStatus(screen) {
  if (!screen.device_key) return 'unpaired';
  if (!screen.last_seen_at) return 'never-connected';
  const age = Date.now() - Date.parse(screen.last_seen_at);
  return age > OFFLINE_AFTER_MS ? 'offline' : 'online';
}

function withStatus(screen) {
  return { ...screen, status: screenStatus(screen) };
}

function mustFind(row, what) {
  if (!row) throw new HttpError(404, `${what} not found`);
  return row;
}

// route table: [method, pattern, handler]. Patterns use :param segments.
const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// ---- Venues -----------------------------------------------------------

route('GET', '/api/venues', (req, res) => {
  const rows = req.user.role === 'superadmin'
    ? db.all('SELECT v.*, o.name AS org_name FROM venues v LEFT JOIN orgs o ON o.id = v.org_id ORDER BY o.name, v.name')
    : db.all('SELECT v.*, o.name AS org_name FROM venues v LEFT JOIN orgs o ON o.id = v.org_id WHERE v.org_id = ? ORDER BY v.name', req.user.org_id ?? '');
  const venues = rows.map((v) => ({
    ...v,
    screens: db.all('SELECT * FROM screens WHERE venue_id = ?', v.id).map(withStatus),
    zones: db.all('SELECT * FROM zones WHERE venue_id = ? ORDER BY name', v.id),
  }));
  sendJson(res, 200, { venues });
});

function numOrNull(value) {
  const n = parseFloat(value);
  return Number.isFinite(n) ? n : null;
}

route('POST', '/api/venues', async (req, res) => {
  auth.requireRole(req.user, 'admin');
  const body = await readJson(req);
  required(body, 'name');
  let orgId = req.user.org_id;
  if (req.user.role === 'superadmin') {
    orgId = body.org_id;
    if (!orgId || !db.get('SELECT id FROM orgs WHERE id = ?', orgId)) {
      throw new HttpError(400, 'org_id (business) required when creating a venue as superadmin');
    }
  }
  const venueId = db.id();
  db.run('INSERT INTO venues (id, org_id, name, timezone, address, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    venueId, orgId, body.name, body.timezone || 'Australia/Sydney', body.address || '',
    numOrNull(body.latitude), numOrNull(body.longitude), db.now());
  sendJson(res, 201, db.get('SELECT * FROM venues WHERE id = ?', venueId));
});

route('PATCH', '/api/venues/:id', async (req, res, params) => {
  const venue = auth.assertVenue(req.user, params.id, 'editor'); // editors may set location etc.
  const body = await readJson(req);
  let orgId = venue.org_id;
  if (body.org_id !== undefined && body.org_id !== venue.org_id) {
    auth.requireRole(req.user, 'superadmin'); // only Korvix moves venues between businesses
    if (!db.get('SELECT id FROM orgs WHERE id = ?', body.org_id ?? '')) throw new HttpError(400, 'unknown business');
    orgId = body.org_id;
  }
  // Overnight screen sleep window (venue-local "HH:MM"; both or neither).
  const hhmm = (v) => (typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v.trim()) ? v.trim() : null);
  const sleepStart = body.sleep_start !== undefined ? hhmm(body.sleep_start) : venue.sleep_start;
  const sleepEnd = body.sleep_end !== undefined ? hhmm(body.sleep_end) : venue.sleep_end;
  db.run('UPDATE venues SET name = ?, timezone = ?, address = ?, logo_url = ?, latitude = ?, longitude = ?, racing_jurisdiction = ?, sleep_start = ?, sleep_end = ?, org_id = ? WHERE id = ?',
    body.name ?? venue.name, body.timezone ?? venue.timezone, body.address ?? venue.address,
    body.logo_url !== undefined ? (body.logo_url ? String(body.logo_url).slice(0, 300) : null) : venue.logo_url,
    body.latitude !== undefined ? numOrNull(body.latitude) : venue.latitude,
    body.longitude !== undefined ? numOrNull(body.longitude) : venue.longitude,
    body.racing_jurisdiction !== undefined
      ? (body.racing_jurisdiction ? String(body.racing_jurisdiction).trim().toUpperCase() : null)
      : venue.racing_jurisdiction,
    sleepStart, sleepEnd,
    orgId,
    venue.id);
  if (body.sleep_start !== undefined || body.sleep_end !== undefined) nudgeVenue(venue.id);
  if (body.latitude !== undefined || body.longitude !== undefined) {
    require('../monitor').refreshWeather(); // async, fire-and-forget
  }
  if (body.racing_jurisdiction !== undefined) {
    require('../racing').pollOnce().catch(() => {}); // fetch races right away
  }
  sendJson(res, 200, db.get('SELECT * FROM venues WHERE id = ?', venue.id));
});

route('DELETE', '/api/venues/:id', (req, res, params) => {
  auth.assertVenue(req.user, params.id, 'admin');
  db.run('DELETE FROM venues WHERE id = ?', params.id);
  sendJson(res, 200, { ok: true });
});

// Set up a new venue from an existing one: zones, content library, menus,
// playlists and schedules come across; screens don't (they get paired at the
// new site). Screen-targeted schedules are skipped — those screens don't
// exist yet.
route('POST', '/api/venues/:id/clone', async (req, res, params) => {
  const source = auth.assertVenue(req.user, params.id, 'admin');
  const body = await readJson(req);
  required(body, 'name');

  const venueId = db.id();
  db.run(
    `INSERT INTO venues (id, org_id, name, timezone, address, logo_url, racing_jurisdiction, sleep_start, sleep_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    venueId, source.org_id, String(body.name).slice(0, 80),
    body.timezone || source.timezone, body.address || '',
    source.logo_url, source.racing_jurisdiction, source.sleep_start, source.sleep_end, db.now());

  const zoneMap = {};
  for (const z of db.all('SELECT * FROM zones WHERE venue_id = ?', source.id)) {
    zoneMap[z.id] = db.id();
    db.run('INSERT INTO zones (id, venue_id, name, description) VALUES (?, ?, ?, ?)',
      zoneMap[z.id], venueId, z.name, z.description || '');
  }

  // Menus first, so their board widgets can be mapped like any other media.
  const menuMap = {};
  const mediaMap = {};
  for (const m of db.all('SELECT * FROM menus WHERE venue_id = ?', source.id)) {
    menuMap[m.id] = db.id();
    db.run('INSERT INTO menus (id, venue_id, name, theme, sections, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      menuMap[m.id], venueId, m.name, m.theme || 'classic', m.sections, db.now(), db.now());
  }
  for (const m of db.all('SELECT * FROM media WHERE venue_id = ? AND expires_at IS NULL', source.id)) {
    let src = m.src;
    if (m.type === 'widget' && String(m.src).startsWith('menuboard:')) {
      const newMenuId = menuMap[String(m.src).slice('menuboard:'.length)];
      if (!newMenuId) continue; // widget for a menu that no longer exists
      src = `menuboard:${newMenuId}`;
    }
    mediaMap[m.id] = db.id();
    db.run(
      `INSERT INTO media (id, venue_id, name, type, src, content, duration_seconds, fit, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      mediaMap[m.id], venueId, m.name, m.type, src, m.content || '', m.duration_seconds, m.fit || 'cover', db.now());
  }

  const playlistMap = {};
  for (const p of db.all('SELECT * FROM playlists WHERE venue_id = ?', source.id)) {
    playlistMap[p.id] = db.id();
    db.run('INSERT INTO playlists (id, venue_id, name, created_at) VALUES (?, ?, ?, ?)',
      playlistMap[p.id], venueId, p.name, db.now());
    for (const item of db.all('SELECT * FROM playlist_items WHERE playlist_id = ? ORDER BY position, id', p.id)) {
      if (!mediaMap[item.media_id]) continue; // expired/unclonable media
      db.run('INSERT INTO playlist_items (id, playlist_id, media_id, position, duration_override) VALUES (?, ?, ?, ?, ?)',
        db.id(), playlistMap[p.id], mediaMap[item.media_id], item.position, item.duration_override);
    }
  }

  let schedules = 0;
  for (const s of db.all('SELECT * FROM schedules WHERE venue_id = ? AND screen_id IS NULL', source.id)) {
    if (!playlistMap[s.playlist_id]) continue;
    db.run(
      `INSERT INTO schedules (id, venue_id, zone_id, screen_id, playlist_id, name, days_of_week, start_time, end_time, start_date, end_date, priority, active)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      db.id(), venueId, s.zone_id ? (zoneMap[s.zone_id] || null) : null, playlistMap[s.playlist_id],
      s.name, s.days_of_week, s.start_time, s.end_time, s.start_date, s.end_date, s.priority, s.active);
    schedules += 1;
  }

  db.logEvent('venue.cloned', { venueId, detail: `${body.name} (from ${source.name})`, actor: actorOf(req) });
  sendJson(res, 201, {
    ...db.get('SELECT * FROM venues WHERE id = ?', venueId),
    cloned: {
      zones: Object.keys(zoneMap).length,
      media: Object.keys(mediaMap).length,
      menus: Object.keys(menuMap).length,
      playlists: Object.keys(playlistMap).length,
      schedules,
    },
  });
});

// ---- Zones ------------------------------------------------------------

route('POST', '/api/venues/:venueId/zones', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'name');
  const zoneId = db.id();
  db.run('INSERT INTO zones (id, venue_id, name, description) VALUES (?, ?, ?, ?)',
    zoneId, params.venueId, body.name, body.description || '');
  sendJson(res, 201, db.get('SELECT * FROM zones WHERE id = ?', zoneId));
});

route('DELETE', '/api/zones/:id', (req, res, params) => {
  const zone = mustFind(db.get('SELECT * FROM zones WHERE id = ?', params.id), 'zone');
  auth.assertVenue(req.user, zone.venue_id, 'editor');
  db.run('DELETE FROM zones WHERE id = ?', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- Screens & pairing -------------------------------------------------

route('GET', '/api/venues/:venueId/screens', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const screens = db.all('SELECT * FROM screens WHERE venue_id = ? ORDER BY name', params.venueId);
  sendJson(res, 200, { screens: screens.map(withStatus) });
});

// Creating a screen creates a licence, so it's a provider action (billing
// console). Venue staff manage everything about a screen except its
// existence and its tier.
route('POST', '/api/venues/:venueId/screens', async (req, res, params) => {
  auth.requireRole(req.user, 'superadmin');
  if (!db.get('SELECT id FROM venues WHERE id = ?', params.venueId)) throw new HttpError(404, 'venue not found');
  const body = await readJson(req);
  required(body, 'name');
  const license = body.license !== undefined && LICENSES.has(body.license) ? body.license : 'main';
  const screenId = db.id();
  db.run(
    'INSERT INTO screens (id, venue_id, zone_id, name, orientation, license, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    screenId, params.venueId, body.zone_id || null, body.name,
    body.orientation === 'portrait' ? 'portrait' : 'landscape', license, db.now());
  db.logEvent('screen.created', { venueId: params.venueId, screenId,
    detail: `${body.name} (${license} licence)`, actor: actorOf(req) });
  sendJson(res, 201, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screenId)));
});

const ROTATIONS = new Set([0, 90, 180, 270]);
const SCREEN_CHANNELS = new Set(['main', 'racing1', 'racing2', 'racing3', 'racing-results', 'sports']);
const LAYOUTS = new Set(['full', 'side', 'ticker', 'side-ticker']);
const LICENSES = new Set(['main', 'basic', 'comp']); // comp = full features, $0 (superadmin-set)

route('PATCH', '/api/screens/:id', async (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  auth.assertVenue(req.user, screen.venue_id, 'editor');
  const body = await readJson(req);
  let rotation = screen.rotation;
  if (body.rotation !== undefined) {
    rotation = parseInt(body.rotation, 10);
    if (!ROTATIONS.has(rotation)) throw new HttpError(400, 'rotation must be 0, 90, 180 or 270');
  }
  if (body.channel !== undefined && !SCREEN_CHANNELS.has(body.channel)) {
    // 'menu:<id>' pins the screen to one of this venue's menu boards.
    const menuId = String(body.channel).startsWith('menu:') ? String(body.channel).slice(5) : null;
    if (!menuId || !db.get('SELECT id FROM menus WHERE id = ? AND venue_id = ?', menuId, screen.venue_id)) {
      throw new HttpError(400, `channel must be menu:<menu id> or one of: ${[...SCREEN_CHANNELS].join(', ')}`);
    }
  }
  if (body.layout !== undefined && !LAYOUTS.has(body.layout)) {
    throw new HttpError(400, `layout must be one of: ${[...LAYOUTS].join(', ')}`);
  }
  if (body.side_playlist_id) {
    const pl = db.get('SELECT venue_id FROM playlists WHERE id = ?', body.side_playlist_id);
    if (!pl || pl.venue_id !== screen.venue_id) throw new HttpError(400, 'unknown side playlist');
  }
  // Licence tier drives billing. Downgrading to basic drops any premium
  // channel back to main; putting a channel on a basic screen needs an upgrade.
  let license = screen.license || 'main';
  if (body.license !== undefined) {
    if (!LICENSES.has(body.license)) throw new HttpError(400, 'license must be main, basic or comp');
    // Comped (free, full-featured) licences are a provider decision only.
    if ((body.license === 'comp' || screen.license === 'comp') && req.user.role !== 'superadmin') {
      throw new HttpError(403, 'comped licences are set by your signage provider');
    }
    license = body.license;
  }
  let channel = body.channel ?? screen.channel ?? 'main';
  // Menu-board channels are ordinary content — fine on a basic licence.
  if (license === 'basic' && channel !== 'main' && !String(channel).startsWith('menu:')) {
    if (body.channel !== undefined && body.license === undefined) {
      throw new HttpError(400, 'racing/sports channels need a Main licence — upgrade this screen first');
    }
    channel = 'main'; // downgrade resets the channel
  }
  db.run('UPDATE screens SET name = ?, zone_id = ?, orientation = ?, rotation = ?, channel = ?, layout = ?, side_playlist_id = ?, license = ? WHERE id = ?',
    body.name ?? screen.name,
    body.zone_id !== undefined ? (body.zone_id || null) : screen.zone_id,
    body.orientation ?? screen.orientation,
    rotation,
    channel,
    body.layout ?? screen.layout ?? 'full',
    body.side_playlist_id !== undefined ? (body.side_playlist_id || null) : screen.side_playlist_id,
    license,
    screen.id);
  if (body.license !== undefined && body.license !== screen.license) {
    db.logEvent('screen.license', { venueId: screen.venue_id, screenId: screen.id,
      detail: `${screen.name}: ${screen.license || 'main'} -> ${license}`, actor: actorOf(req) });
  }
  if (screen.device_key) sse.send(screen.device_key, 'refresh', { reason: 'screen-updated' });
  sendJson(res, 200, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screen.id)));
});

route('DELETE', '/api/screens/:id', (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  auth.assertVenue(req.user, screen.venue_id, 'editor');
  db.run('DELETE FROM screens WHERE id = ?', params.id);
  if (screen?.device_key) sse.send(screen.device_key, 'unpaired', {});
  sendJson(res, 200, { ok: true });
});

// List devices that have registered but are not yet claimed by a screen.
route('GET', '/api/pairings', (req, res) => {
  sendJson(res, 200, { pairings: db.all('SELECT pairing_code, player_info, created_at FROM pairings ORDER BY created_at DESC') });
});

// Claim a device (by the 6-char code it shows on screen) for an existing screen.
route('POST', '/api/screens/:id/pair', async (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  auth.assertVenue(req.user, screen.venue_id, 'editor');
  const body = await readJson(req);
  required(body, 'pairing_code');
  const code = String(body.pairing_code).trim().toUpperCase();
  const pairing = mustFind(db.get('SELECT * FROM pairings WHERE pairing_code = ?', code), 'pairing code');
  db.run('UPDATE screens SET device_key = NULL WHERE device_key = ?', pairing.device_key);
  db.run('UPDATE screens SET device_key = ?, player_info = ?, last_seen_at = ? WHERE id = ?',
    pairing.device_key, pairing.player_info, db.now(), screen.id);
  db.run('DELETE FROM pairings WHERE pairing_code = ?', code);
  db.logEvent('screen.paired', { venueId: screen.venue_id, screenId: screen.id, detail: code, actor: actorOf(req) });
  sse.send(pairing.device_key, 'paired', { screen_id: screen.id });
  sendJson(res, 200, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screen.id)));
});

route('POST', '/api/screens/:id/unpair', (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  auth.assertVenue(req.user, screen.venue_id, 'editor');
  if (screen.device_key) sse.send(screen.device_key, 'unpaired', {});
  db.run('UPDATE screens SET device_key = NULL, last_seen_at = NULL WHERE id = ?', screen.id);
  sendJson(res, 200, { ok: true });
});

// ---- Media library ------------------------------------------------------

const MEDIA_TYPES = new Set(['image', 'video', 'url', 'html', 'widget']);
const FITS = new Set(['cover', 'contain']);
const UPLOAD_DIR = path.join(db.DATA_DIR, 'uploads');

// Which media rows reference an uploaded file (by its /uploads/... URL).
function usedBy(fileName) {
  return db.all(
    `SELECT m.id, m.name, v.name AS venue_name FROM media m
     JOIN venues v ON v.id = m.venue_id WHERE m.src = ?`, `/uploads/${fileName}`);
}

// List everything this business has uploaded, with usage + disk footprint.
// Files are namespaced <orgId>__name; superadmins see every tenant's files.
route('GET', '/api/uploads', (req, res) => {
  const prefix = req.user.role === 'superadmin' ? null : `${req.user.org_id || 'global'}__`;
  let files = [];
  try {
    files = fs.readdirSync(UPLOAD_DIR)
      .filter((f) => !f.startsWith('.'))
      .filter((f) => !prefix || f.startsWith(prefix))
      .map((f) => {
        const stat = fs.statSync(path.join(UPLOAD_DIR, f));
        return {
          name: f,
          url: `/uploads/${f}`,
          bytes: stat.size,
          uploaded_at: stat.mtime.toISOString(),
          used_by: usedBy(f),
        };
      })
      .sort((a, b) => b.uploaded_at.localeCompare(a.uploaded_at));
  } catch { /* no uploads yet */ }
  sendJson(res, 200, { files, total_bytes: files.reduce((n, f) => n + f.bytes, 0) });
});

route('DELETE', '/api/uploads/:name', (req, res, params, url) => {
  auth.requireRole(req.user, 'editor');
  const name = path.basename(params.name); // no traversal
  if (req.user.role !== 'superadmin' && !name.startsWith(`${req.user.org_id || 'global'}__`)) {
    throw new HttpError(404, 'file not found');
  }
  const file = path.join(UPLOAD_DIR, name);
  if (!fs.existsSync(file)) throw new HttpError(404, 'file not found');
  const refs = usedBy(name);
  if (refs.length && url.searchParams.get('force') !== '1') {
    throw new HttpError(409, `file is used by: ${refs.map((r) => r.name).join(', ')} — delete that media first or pass force=1`);
  }
  fs.unlinkSync(file);
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/venues/:venueId/media', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  sendJson(res, 200, { media: db.all('SELECT * FROM media WHERE venue_id = ? ORDER BY created_at DESC', params.venueId) });
});

route('POST', '/api/venues/:venueId/media', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'name', 'type');
  if (!MEDIA_TYPES.has(body.type)) throw new HttpError(400, `type must be one of: ${[...MEDIA_TYPES].join(', ')}`);
  const mediaId = db.id();
  db.run(
    'INSERT INTO media (id, venue_id, name, type, src, content, duration_seconds, fit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    mediaId, params.venueId, body.name, body.type, body.src || '', body.content || '',
    Math.max(1, parseInt(body.duration_seconds, 10) || 10),
    FITS.has(body.fit) ? body.fit : 'cover', db.now());
  sendJson(res, 201, db.get('SELECT * FROM media WHERE id = ?', mediaId));
});

route('PATCH', '/api/media/:id', async (req, res, params) => {
  const media = mustFind(db.get('SELECT * FROM media WHERE id = ?', params.id), 'media');
  auth.assertVenue(req.user, media.venue_id, 'editor');
  const body = await readJson(req);
  if (body.type && !MEDIA_TYPES.has(body.type)) throw new HttpError(400, 'invalid media type');
  if (body.fit && !FITS.has(body.fit)) throw new HttpError(400, 'fit must be cover or contain');
  db.run('UPDATE media SET name = ?, type = ?, src = ?, content = ?, duration_seconds = ?, fit = ? WHERE id = ?',
    body.name ?? media.name, body.type ?? media.type, body.src ?? media.src,
    body.content ?? media.content,
    body.duration_seconds ? Math.max(1, parseInt(body.duration_seconds, 10)) : media.duration_seconds,
    body.fit ?? media.fit,
    media.id);
  nudgeVenue(media.venue_id);
  sendJson(res, 200, db.get('SELECT * FROM media WHERE id = ?', media.id));
});

route('DELETE', '/api/media/:id', (req, res, params) => {
  const media = mustFind(db.get('SELECT * FROM media WHERE id = ?', params.id), 'media');
  auth.assertVenue(req.user, media.venue_id, 'editor');
  db.run('DELETE FROM media WHERE id = ?', params.id);
  if (media) nudgeVenue(media.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Playlists -----------------------------------------------------------

route('GET', '/api/venues/:venueId/playlists', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const playlists = db.all('SELECT * FROM playlists WHERE venue_id = ? ORDER BY name', params.venueId)
    .map((p) => ({
      ...p,
      items: db.all(
        `SELECT pi.id, pi.media_id, pi.position, pi.duration_override, m.name, m.type
         FROM playlist_items pi JOIN media m ON m.id = pi.media_id
         WHERE pi.playlist_id = ? ORDER BY pi.position, pi.id`, p.id),
    }));
  sendJson(res, 200, { playlists });
});

route('POST', '/api/venues/:venueId/playlists', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'name');
  const playlistId = db.id();
  db.run('INSERT INTO playlists (id, venue_id, name, created_at) VALUES (?, ?, ?, ?)',
    playlistId, params.venueId, body.name, db.now());
  sendJson(res, 201, { ...db.get('SELECT * FROM playlists WHERE id = ?', playlistId), items: [] });
});

route('POST', '/api/playlists/:id/items', async (req, res, params) => {
  const playlist = mustFind(db.get('SELECT * FROM playlists WHERE id = ?', params.id), 'playlist');
  auth.assertVenue(req.user, playlist.venue_id, 'editor');
  const body = await readJson(req);
  required(body, 'media_id');
  mustFind(db.get('SELECT id FROM media WHERE id = ?', body.media_id), 'media');
  const max = db.get('SELECT COALESCE(MAX(position), -1) AS p FROM playlist_items WHERE playlist_id = ?', playlist.id).p;
  const itemId = db.id();
  db.run('INSERT INTO playlist_items (id, playlist_id, media_id, position, duration_override) VALUES (?, ?, ?, ?, ?)',
    itemId, playlist.id, body.media_id, max + 1, body.duration_override || null);
  nudgeVenue(playlist.venue_id);
  sendJson(res, 201, db.get('SELECT * FROM playlist_items WHERE id = ?', itemId));
});

// Replace item order: body { item_ids: [...] } in the desired sequence.
route('POST', '/api/playlists/:id/reorder', async (req, res, params) => {
  const playlist = mustFind(db.get('SELECT * FROM playlists WHERE id = ?', params.id), 'playlist');
  auth.assertVenue(req.user, playlist.venue_id, 'editor');
  const body = await readJson(req);
  if (!Array.isArray(body.item_ids)) throw new HttpError(400, 'item_ids array required');
  body.item_ids.forEach((itemId, index) => {
    db.run('UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?', index, itemId, playlist.id);
  });
  nudgeVenue(playlist.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/playlist-items/:id', (req, res, params) => {
  const item = mustFind(db.get('SELECT pi.*, p.venue_id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.id = ?', params.id), 'playlist item');
  auth.assertVenue(req.user, item.venue_id, 'editor');
  db.run('DELETE FROM playlist_items WHERE id = ?', params.id);
  if (item) nudgeVenue(item.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/playlists/:id', (req, res, params) => {
  const playlist = mustFind(db.get('SELECT * FROM playlists WHERE id = ?', params.id), 'playlist');
  auth.assertVenue(req.user, playlist.venue_id, 'editor');
  db.run('DELETE FROM playlists WHERE id = ?', params.id);
  if (playlist) nudgeVenue(playlist.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Schedules (dayparting) ----------------------------------------------

route('GET', '/api/venues/:venueId/schedules', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  sendJson(res, 200, {
    schedules: db.all(
      `SELECT s.*, p.name AS playlist_name, z.name AS zone_name, sc.name AS screen_name
       FROM schedules s
       JOIN playlists p ON p.id = s.playlist_id
       LEFT JOIN zones z ON z.id = s.zone_id
       LEFT JOIN screens sc ON sc.id = s.screen_id
       WHERE s.venue_id = ?
       ORDER BY s.start_time`, params.venueId),
  });
});

function cleanDate(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) throw new HttpError(400, `${label} must be YYYY-MM-DD`);
  return String(value);
}

route('POST', '/api/venues/:venueId/schedules', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'playlist_id');
  mustFind(db.get('SELECT id FROM playlists WHERE id = ?', body.playlist_id), 'playlist');
  const days = Array.isArray(body.days_of_week) && body.days_of_week.length
    ? body.days_of_week : [0, 1, 2, 3, 4, 5, 6];
  const startDate = cleanDate(body.start_date, 'start_date');
  const endDate = cleanDate(body.end_date, 'end_date');
  if (startDate && endDate && endDate < startDate) throw new HttpError(400, 'end_date is before start_date');
  const scheduleId = db.id();
  db.run(
    `INSERT INTO schedules (id, venue_id, zone_id, screen_id, playlist_id, name, days_of_week, start_time, end_time, start_date, end_date, priority, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    scheduleId, params.venueId, body.zone_id || null, body.screen_id || null, body.playlist_id,
    body.name || '', JSON.stringify(days), body.start_time || '00:00', body.end_time || '24:00',
    startDate, endDate,
    parseInt(body.priority, 10) || 0);
  nudgeVenue(params.venueId);
  sendJson(res, 201, db.get('SELECT * FROM schedules WHERE id = ?', scheduleId));
});

route('PATCH', '/api/schedules/:id', async (req, res, params) => {
  const schedule = mustFind(db.get('SELECT * FROM schedules WHERE id = ?', params.id), 'schedule');
  auth.assertVenue(req.user, schedule.venue_id, 'editor');
  const body = await readJson(req);
  db.run(
    `UPDATE schedules SET name = ?, zone_id = ?, screen_id = ?, playlist_id = ?, days_of_week = ?,
       start_time = ?, end_time = ?, start_date = ?, end_date = ?, priority = ?, active = ? WHERE id = ?`,
    body.name ?? schedule.name,
    body.zone_id !== undefined ? (body.zone_id || null) : schedule.zone_id,
    body.screen_id !== undefined ? (body.screen_id || null) : schedule.screen_id,
    body.playlist_id ?? schedule.playlist_id,
    Array.isArray(body.days_of_week) ? JSON.stringify(body.days_of_week) : schedule.days_of_week,
    body.start_time ?? schedule.start_time,
    body.end_time ?? schedule.end_time,
    body.start_date !== undefined ? cleanDate(body.start_date, 'start_date') : schedule.start_date,
    body.end_date !== undefined ? cleanDate(body.end_date, 'end_date') : schedule.end_date,
    body.priority !== undefined ? parseInt(body.priority, 10) || 0 : schedule.priority,
    body.active !== undefined ? (body.active ? 1 : 0) : schedule.active,
    schedule.id);
  nudgeVenue(schedule.venue_id);
  sendJson(res, 200, db.get('SELECT * FROM schedules WHERE id = ?', schedule.id));
});

route('DELETE', '/api/schedules/:id', (req, res, params) => {
  const schedule = mustFind(db.get('SELECT * FROM schedules WHERE id = ?', params.id), 'schedule');
  auth.assertVenue(req.user, schedule.venue_id, 'editor');
  db.run('DELETE FROM schedules WHERE id = ?', params.id);
  if (schedule) nudgeVenue(schedule.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Emergency broadcast ---------------------------------------------------

const EMERGENCY_LEVELS = new Set(['evacuation', 'lockdown', 'alert', 'notice']);

route('GET', '/api/emergencies', (req, res) => {
  const emergencies = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM emergencies ORDER BY created_at DESC LIMIT 50')
    : db.all(
      `SELECT e.* FROM emergencies e
       WHERE e.venue_id IS NULL OR e.venue_id IN (SELECT id FROM venues WHERE org_id = ?)
       ORDER BY e.created_at DESC LIMIT 50`, req.user.org_id ?? '');
  sendJson(res, 200, { emergencies });
});

route('POST', '/api/emergencies', async (req, res) => {
  const body = await readJson(req);
  required(body, 'title');
  if (body.venue_id) auth.assertVenue(req.user, body.venue_id, 'editor');
  else auth.requireRole(req.user, 'superadmin'); // ALL venues = every tenant: Korvix only
  const level = EMERGENCY_LEVELS.has(body.level) ? body.level : 'alert';
  const emergencyId = db.id();
  db.run('INSERT INTO emergencies (id, venue_id, level, title, message, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    emergencyId, body.venue_id || null, level, body.title, body.message || '', db.now());
  db.logEvent('emergency.activated', { venueId: body.venue_id || null, detail: `${level}: ${body.title}`, actor: actorOf(req) });
  if (body.venue_id) nudgeVenue(body.venue_id); else nudgeAll();
  sendJson(res, 201, db.get('SELECT * FROM emergencies WHERE id = ?', emergencyId));
});

route('POST', '/api/emergencies/:id/clear', (req, res, params) => {
  const emergency = mustFind(db.get('SELECT * FROM emergencies WHERE id = ?', params.id), 'emergency');
  if (emergency.venue_id) auth.assertVenue(req.user, emergency.venue_id, 'editor');
  else auth.requireRole(req.user, 'superadmin');
  db.run('UPDATE emergencies SET active = 0, cleared_at = ? WHERE id = ?', db.now(), emergency.id);
  db.logEvent('emergency.cleared', { venueId: emergency.venue_id, detail: emergency.title, actor: actorOf(req) });
  if (emergency.venue_id) nudgeVenue(emergency.venue_id); else nudgeAll();
  sendJson(res, 200, { ok: true });
});

// ---- Staff remote app access ---------------------------------------------------

const crypto = require('node:crypto');

// Generate (or rotate) the venue's staff-remote token. Rotating instantly
// revokes every phone holding the old link.
route('POST', '/api/venues/:id/remote-token', (req, res, params) => {
  const venue = auth.assertVenue(req.user, params.id, 'admin');
  const token = crypto.randomBytes(16).toString('hex');
  db.run('UPDATE venues SET remote_token = ? WHERE id = ?', token, venue.id);
  db.logEvent('remote.token_rotated', { venueId: venue.id, detail: venue.name, actor: actorOf(req) });
  sendJson(res, 200, { token, url: `/games/${token}` });
});

route('GET', '/api/venues/:id/remote-token', (req, res, params) => {
  const venue = auth.assertVenue(req.user, params.id, 'admin');
  sendJson(res, 200, venue.remote_token
    ? { token: venue.remote_token, url: `/games/${venue.remote_token}` }
    : { token: null, url: null });
});

// ---- Raffle number draws ------------------------------------------------------
//
// A draw owns a ticket range (start..end inclusive). Each "spin" picks a random
// number not drawn before in this draw — so "winner not present, draw again"
// never repeats a ticket. While live, targeted screens show a full-screen
// takeover; clearing returns them to scheduled content.

const { spinDraw, drawView } = require('../draws');

route('GET', '/api/venues/:venueId/draws', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const draws = db.all(
    `SELECT d.*, z.name AS zone_name FROM draws d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.venue_id = ? ORDER BY d.created_at DESC LIMIT 100`, params.venueId);
  sendJson(res, 200, { draws: draws.map(drawView) });
});

route('POST', '/api/venues/:venueId/draws', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'name');
  const start = parseInt(body.range_start, 10);
  const end = parseInt(body.range_end, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new HttpError(400, 'range_start and range_end must be integers with end >= start');
  }
  if (end - start > 1_000_000) throw new HttpError(400, 'range too large (max 1,000,000 tickets)');
  if (body.zone_id) mustFind(db.get('SELECT id FROM zones WHERE id = ?', body.zone_id), 'zone');
  const drawId = db.id();
  db.run(
    `INSERT INTO draws (id, venue_id, zone_id, name, range_start, range_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    drawId, params.venueId, body.zone_id || null, body.name, start, end, db.now());
  sendJson(res, 201, drawView(db.get('SELECT * FROM draws WHERE id = ?', drawId)));
});

route('POST', '/api/draws/:id/draw', (req, res, params) => {
  const draw = mustFind(db.get('SELECT * FROM draws WHERE id = ?', params.id), 'draw');
  auth.assertVenue(req.user, draw.venue_id, 'editor');
  const updated = spinDraw(draw);
  db.logEvent('draw.number', { venueId: draw.venue_id, detail: `${draw.name}: #${drawView(updated).latest_number}`, actor: actorOf(req) });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, drawView(updated));
});

route('POST', '/api/draws/:id/clear', (req, res, params) => {
  const draw = mustFind(db.get('SELECT * FROM draws WHERE id = ?', params.id), 'draw');
  auth.assertVenue(req.user, draw.venue_id, 'editor');
  db.run("UPDATE draws SET status = 'cleared' WHERE id = ?", draw.id);
  db.logEvent('draw.cleared', { venueId: draw.venue_id, detail: draw.name, actor: actorOf(req) });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/draws/:id', (req, res, params) => {
  const draw = mustFind(db.get('SELECT * FROM draws WHERE id = ?', params.id), 'draw');
  auth.assertVenue(req.user, draw.venue_id, 'editor');
  db.run('DELETE FROM draws WHERE id = ?', params.id);
  if (draw && draw.status === 'live') nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Licensing & billing ---------------------------------------------------
//
// Two screen tiers: 'main' (everything — game takeovers, racing/sports
// channels) and 'basic' (playlists, menus, widgets). Prices are per screen
// per month, set by the superadmin; only PAIRED screens are billed, so
// placeholder screens cost nothing until a device is actually on the wall.

const DEFAULT_PRICES = { main: 49, basic: 19 };

function licensePrices() {
  try {
    const stored = JSON.parse(db.getSetting('license_prices') || '{}');
    return {
      main: Number.isFinite(Number(stored.main)) ? Number(stored.main) : DEFAULT_PRICES.main,
      basic: Number.isFinite(Number(stored.basic)) ? Number(stored.basic) : DEFAULT_PRICES.basic,
    };
  } catch { return { ...DEFAULT_PRICES }; }
}

// A business pays its negotiated rate where one is set, else the standard.
function pricesFor(org, standard = licensePrices()) {
  return {
    main: Number.isFinite(org?.price_main) ? org.price_main : standard.main,
    basic: Number.isFinite(org?.price_basic) ? org.price_basic : standard.basic,
  };
}

function billingSettings() {
  const rate = parseFloat(db.getSetting('billing_gst_rate'));
  return {
    gst_rate: Number.isFinite(rate) ? rate : 10, // AU default; 0 if prices are GST-inclusive
    company: db.getSetting('billing_company') || '',
  };
}

route('GET', '/api/billing', (req, res) => {
  auth.requireRole(req.user, 'admin'); // org admins see their own bill
  const standard = licensePrices();
  const orgs = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM orgs ORDER BY name')
    : db.all('SELECT * FROM orgs WHERE id = ?', req.user.org_id ?? '');

  const businesses = orgs.map((org) => {
    const prices = pricesFor(org, standard);
    const suspended = org.status === 'suspended';
    const venues = db.all('SELECT * FROM venues WHERE org_id = ? ORDER BY name', org.id).map((v) => {
      const screens = db.all('SELECT license, device_key FROM screens WHERE venue_id = ?', v.id);
      const paired = screens.filter((s) => s.device_key);
      const main = paired.filter((s) => (s.license || 'main') === 'main').length;
      const comp = paired.filter((s) => s.license === 'comp').length;
      const basic = paired.length - main - comp;
      return {
        id: v.id, name: v.name, main, basic, comp,
        unpaired: screens.length - paired.length,
        monthly: suspended ? 0 : main * prices.main + basic * prices.basic,
      };
    });
    const main = venues.reduce((n, v) => n + v.main, 0);
    const basic = venues.reduce((n, v) => n + v.basic, 0);
    const comp = venues.reduce((n, v) => n + v.comp, 0);
    return {
      id: org.id, name: org.name, venues, main, basic, comp,
      status: org.status || 'active',
      custom_pricing: Number.isFinite(org.price_main) || Number.isFinite(org.price_basic),
      prices,
      unpaired: venues.reduce((n, v) => n + v.unpaired, 0),
      monthly: suspended ? 0 : main * prices.main + basic * prices.basic,
    };
  });

  sendJson(res, 200, {
    prices: standard,
    settings: billingSettings(),
    businesses,
    total_monthly: businesses.reduce((n, b) => n + b.monthly, 0),
  });
});

// GST + the company/payment block printed on every invoice.
route('PATCH', '/api/billing/settings', async (req, res) => {
  auth.requireRole(req.user, 'superadmin');
  const body = await readJson(req);
  if (body.gst_rate !== undefined) {
    const n = Number(body.gst_rate);
    if (!Number.isFinite(n) || n < 0 || n > 50) throw new HttpError(400, 'gst_rate must be 0-50');
    db.setSetting('billing_gst_rate', String(n));
  }
  if (body.company !== undefined) db.setSetting('billing_company', String(body.company).slice(0, 1000));
  sendJson(res, 200, { settings: billingSettings() });
});

route('PATCH', '/api/billing/prices', async (req, res) => {
  auth.requireRole(req.user, 'superadmin');
  const body = await readJson(req);
  const current = licensePrices();
  const clean = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
  };
  const prices = {
    main: body.main !== undefined ? clean(body.main, current.main) : current.main,
    basic: body.basic !== undefined ? clean(body.basic, current.basic) : current.basic,
  };
  db.setSetting('license_prices', JSON.stringify(prices));
  db.logEvent('billing.prices', { detail: `main $${prices.main} / basic $${prices.basic} per screen/mo`, actor: actorOf(req) });
  sendJson(res, 200, { prices });
});

// ---- invoices ---------------------------------------------------------------

// Snapshot one business's current billable screens into invoice lines.
function invoiceLines(org) {
  const prices = pricesFor(org);
  const lines = [];
  for (const v of db.all('SELECT * FROM venues WHERE org_id = ? ORDER BY name', org.id)) {
    const paired = db.all('SELECT license FROM screens WHERE venue_id = ? AND device_key IS NOT NULL', v.id);
    const main = paired.filter((s) => (s.license || 'main') === 'main').length;
    const comp = paired.filter((s) => s.license === 'comp').length;
    const basic = paired.length - main - comp;
    if (!main && !basic && !comp) continue;
    lines.push({
      venue: v.name, main, basic, comp,
      main_price: prices.main, basic_price: prices.basic,
      total: main * prices.main + basic * prices.basic, // comped screens are $0
    });
  }
  return lines;
}

// Create any missing invoices for a period (YYYY-MM). Idempotent — the
// (org, period) UNIQUE constraint means each business is invoiced once a
// month no matter how often this runs. Called monthly by the monitor and
// on demand from the billing panel.
function generateInvoices(period, actor = 'system') {
  const { gst_rate } = billingSettings();
  const created = [];
  for (const org of db.all('SELECT * FROM orgs')) {
    if (org.status === 'suspended') continue; // billing pauses while suspended
    if (db.get('SELECT id FROM invoices WHERE org_id = ? AND period = ?', org.id, period)) continue;
    const lines = invoiceLines(org);
    const subtotal = lines.reduce((n, l) => n + l.total, 0);
    if (!subtotal) continue; // nothing billable — no invoice
    const gst = Math.round(subtotal * gst_rate) / 100; // gst_rate is a percentage
    const invoiceId = db.id();
    db.run('INSERT INTO invoices (id, org_id, period, lines, total, gst, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      invoiceId, org.id, period, JSON.stringify(lines), subtotal + gst, gst, db.now());
    db.logEvent('billing.invoice', { detail: `${org.name} ${period}: $${subtotal + gst}${gst ? ` (incl $${gst} GST)` : ''}`, actor });
    created.push(invoiceId);
  }
  return created;
}

function invoiceView(inv) {
  let lines; try { lines = JSON.parse(inv.lines); } catch { lines = []; }
  const org = db.get('SELECT name, alert_email FROM orgs WHERE id = ?', inv.org_id);
  return { ...inv, lines, org_name: org?.name || '(deleted business)', org_email: org?.alert_email || null };
}

function ownedInvoice(req, id) {
  const inv = db.get('SELECT * FROM invoices WHERE id = ?', id);
  if (!inv) throw new HttpError(404, 'invoice not found');
  if (req.user.role !== 'superadmin' && req.user.org_id !== inv.org_id) throw new HttpError(404, 'invoice not found');
  return inv;
}

route('GET', '/api/billing/invoices', (req, res) => {
  auth.requireRole(req.user, 'admin');
  const rows = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM invoices ORDER BY period DESC, created_at DESC LIMIT 200')
    : db.all('SELECT * FROM invoices WHERE org_id = ? ORDER BY period DESC LIMIT 60', req.user.org_id ?? '');
  sendJson(res, 200, { invoices: rows.map(invoiceView) });
});

route('POST', '/api/billing/invoices/generate', async (req, res) => {
  auth.requireRole(req.user, 'superadmin');
  const body = await readJson(req);
  const period = /^\d{4}-\d{2}$/.test(body.period || '') ? body.period : new Date().toISOString().slice(0, 7);
  const created = generateInvoices(period, actorOf(req));
  sendJson(res, 200, { period, created: created.length });
});

route('POST', '/api/billing/invoices/:id/paid', async (req, res, params) => {
  auth.requireRole(req.user, 'superadmin');
  const inv = ownedInvoice(req, params.id);
  const body = await readJson(req);
  const paid = body.paid !== false;
  db.run('UPDATE invoices SET status = ?, paid_at = ? WHERE id = ?',
    paid ? 'paid' : (inv.sent_at ? 'sent' : 'draft'), paid ? db.now() : null, inv.id);
  if (paid) db.logEvent('billing.paid', { detail: `${invoiceView(inv).org_name} ${inv.period}: $${inv.total}`, actor: actorOf(req) });
  sendJson(res, 200, invoiceView(db.get('SELECT * FROM invoices WHERE id = ?', inv.id)));
});

route('DELETE', '/api/billing/invoices/:id', (req, res, params) => {
  auth.requireRole(req.user, 'superadmin');
  const inv = ownedInvoice(req, params.id);
  db.run('DELETE FROM invoices WHERE id = ?', inv.id);
  sendJson(res, 200, { ok: true });
});

// Email the invoice to the business's billing address (needs SMTP + an
// alert email set on the Businesses tab).
route('POST', '/api/billing/invoices/:id/send', async (req, res, params) => {
  auth.requireRole(req.user, 'superadmin');
  const mailer = require('../mailer');
  const inv = invoiceView(ownedInvoice(req, params.id));
  if (!mailer.configured()) throw new HttpError(503, 'email is not set up on this server yet (SMTP_HOST/MAIL_FROM)');
  if (!inv.org_email) throw new HttpError(400, 'this business has no billing email — set one on the Businesses tab');
  const money = (n) => '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  const subtotal = inv.total - (inv.gst || 0);
  const company = billingSettings().company;
  const rows = inv.lines.map((l) => `<tr>
      <td style="padding:6px 10px 6px 0">${l.venue}</td>
      <td style="padding:6px 10px;text-align:right">${l.main} × ${money(l.main_price)}${l.comp ? ` (+${l.comp} comped)` : ''}</td>
      <td style="padding:6px 10px;text-align:right">${l.basic} × ${money(l.basic_price)}</td>
      <td style="padding:6px 0 6px 10px;text-align:right;font-weight:700">${money(l.total)}</td>
    </tr>`).join('');
  const result = await mailer.sendMail({
    to: inv.org_email,
    subject: `${mailer.BRAND} — screen licences for ${inv.period} (${money(inv.total)})`,
    html: mailer.template(`Tax invoice — ${inv.period}`,
      `<p>Screen licences for <b>${inv.org_name}</b>, period <b>${inv.period}</b>.</p>
      <table style="width:100%;border-collapse:collapse;font-size:13px">
        <tr style="opacity:.7"><td></td><td style="text-align:right">Main</td><td style="text-align:right">Basic</td><td style="text-align:right">Total</td></tr>
        ${rows}
        ${inv.gst ? `<tr><td colspan="3" style="padding-top:8px">Subtotal</td><td style="padding-top:8px;text-align:right">${money(subtotal)}</td></tr>
        <tr><td colspan="3">GST</td><td style="text-align:right">${money(inv.gst)}</td></tr>` : ''}
        <tr><td colspan="3" style="padding-top:10px;font-weight:700">Total due${inv.gst ? ' (incl. GST)' : ''}</td>
        <td style="padding-top:10px;text-align:right;font-weight:800;font-size:16px">${money(inv.total)}</td></tr>
      </table>` + (company ? `<p style="white-space:pre-line;font-size:12px;opacity:.8;margin-top:16px">${company.replace(/</g, '&lt;')}</p>` : '')),
  });
  if (result.ok === false) throw new HttpError(502, 'email failed to send: ' + result.error);
  db.run("UPDATE invoices SET status = CASE WHEN status = 'paid' THEN 'paid' ELSE 'sent' END, sent_at = ? WHERE id = ?", db.now(), inv.id);
  db.logEvent('billing.sent', { detail: `${inv.org_name} ${inv.period} -> ${inv.org_email}`, actor: actorOf(req) });
  sendJson(res, 200, invoiceView(db.get('SELECT * FROM invoices WHERE id = ?', inv.id)));
});

// Printable invoice (superadmin or the owning business admin). Plain HTML so
// the browser's print-to-PDF does the rest; ?token= keeps it a normal link.
route('GET', '/api/billing/invoices/:id/print', (req, res, params) => {
  auth.requireRole(req.user, 'admin');
  const inv = invoiceView(ownedInvoice(req, params.id));
  const BRAND = require('../mailer').BRAND;
  const money = (n) => '$' + Number(n).toFixed(2).replace(/\.00$/, '');
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html><head><meta charset="utf-8"><title>Invoice ${esc(inv.period)} — ${esc(inv.org_name)}</title>
  <style>body{font-family:system-ui,sans-serif;max-width:720px;margin:40px auto;color:#111;padding:0 20px}
  table{width:100%;border-collapse:collapse;margin-top:24px}
  td,th{padding:10px 8px;border-bottom:1px solid #ddd;text-align:left}
  th{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#666}
  .num{text-align:right}.total td{border-bottom:none;font-weight:800;font-size:18px;padding-top:18px}
  .badge{display:inline-block;padding:3px 10px;border-radius:20px;font-size:12px;font-weight:700;
    background:${inv.status === 'paid' ? '#dcfce7;color:#166534' : inv.status === 'sent' ? '#dbeafe;color:#1e40af' : '#f3f4f6;color:#374151'}}
  @media print{.noprint{display:none}}</style></head><body>
  <div style="display:flex;justify-content:space-between;align-items:baseline">
    <h1 style="letter-spacing:.06em">${esc(BRAND.toUpperCase())}</h1>
    <span class="badge">${esc(inv.status.toUpperCase())}</span>
  </div>
  <p><b>Tax invoice</b> — screen licences<br>
  Billed to: <b>${esc(inv.org_name)}</b><br>
  Period: <b>${esc(inv.period)}</b> · Issued: ${new Date(inv.created_at).toLocaleDateString('en-AU')}</p>
  <table><tr><th>Venue</th><th class="num">Main screens</th><th class="num">Basic screens</th><th class="num">Amount</th></tr>
  ${inv.lines.map((l) => `<tr><td>${esc(l.venue)}</td>
    <td class="num">${l.main} × ${money(l.main_price)}${l.comp ? ` <span style="color:#888">(+${l.comp} comped)</span>` : ''}</td>
    <td class="num">${l.basic} × ${money(l.basic_price)}</td>
    <td class="num">${money(l.total)}</td></tr>`).join('')}
  ${inv.gst ? `<tr><td colspan="3">Subtotal</td><td class="num">${money(inv.total - inv.gst)}</td></tr>
  <tr><td colspan="3">GST</td><td class="num">${money(inv.gst)}</td></tr>` : ''}
  <tr class="total"><td colspan="3">Total due${inv.gst ? ' (incl. GST)' : ''}</td><td class="num">${money(inv.total)}</td></tr></table>
  ${billingSettings().company ? `<p style="color:#444;font-size:13px;margin-top:28px;white-space:pre-line;border-top:1px solid #ddd;padding-top:14px">${esc(billingSettings().company)}</p>` : ''}
  <p style="color:#666;font-size:13px;margin-top:20px">Generated by ${esc(BRAND)}.</p>
  <button class="noprint" onclick="print()" style="padding:10px 22px;font-size:15px">Print / save as PDF</button>
  </body></html>`);
});


// ---- Fleet health & events ---------------------------------------------------

route('GET', '/api/health/overview', (req, res) => {
  const rows = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM venues ORDER BY name')
    : db.all('SELECT * FROM venues WHERE org_id = ? ORDER BY name', req.user.org_id ?? '');
  const venues = rows.map((v) => {
    const screens = db.all('SELECT * FROM screens WHERE venue_id = ?', v.id).map(withStatus);
    return {
      id: v.id,
      name: v.name,
      screens_total: screens.length,
      screens_online: screens.filter((s) => s.status === 'online').length,
      screens_offline: screens.filter((s) => s.status === 'offline').length,
      screens_unpaired: screens.filter((s) => s.status === 'unpaired' || s.status === 'never-connected').length,
      emergency: !!db.get('SELECT id FROM emergencies WHERE active = 1 AND (venue_id IS NULL OR venue_id = ?)', v.id),
      screens,
    };
  });
  sendJson(res, 200, { venues, connected_players: sse.connectedKeys().length });
});

route('GET', '/api/events', (req, res) => {
  const events = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM events ORDER BY id DESC LIMIT 100')
    : db.all(
      `SELECT * FROM events
       WHERE venue_id IN (SELECT id FROM venues WHERE org_id = ?)
       ORDER BY id DESC LIMIT 100`, req.user.org_id ?? '');
  sendJson(res, 200, { events });
});

// ---- Proof-of-play reporting ---------------------------------------------------
//
// Players report every item they actually displayed; this aggregates it for a
// date range (UTC days). The per-media table is the evidence base for the
// cross-venue advertising network: "your promo ran N times for M minutes".

route('GET', '/api/venues/:venueId/reports/plays', (req, res, params, url) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400 * 1000).toISOString().slice(0, 10);
  const from = (url.searchParams.get('from') || weekAgo).slice(0, 10);
  const to = (url.searchParams.get('to') || today).slice(0, 10);
  const lo = `${from}T00:00:00.000Z`;
  const hi = `${to}T23:59:59.999Z`;

  const media = db.all(
    `SELECT media_id, media_name,
            COUNT(*) AS plays,
            ROUND(SUM(duration_seconds)) AS seconds,
            COUNT(DISTINCT screen_id) AS screens
     FROM plays WHERE venue_id = ? AND started_at >= ? AND started_at <= ?
     GROUP BY media_id, media_name ORDER BY plays DESC`, params.venueId, lo, hi);

  const screens = db.all(
    `SELECT p.screen_id, COALESCE(s.name, '(removed screen)') AS screen_name,
            COUNT(*) AS plays, ROUND(SUM(p.duration_seconds)) AS seconds
     FROM plays p LEFT JOIN screens s ON s.id = p.screen_id
     WHERE p.venue_id = ? AND p.started_at >= ? AND p.started_at <= ?
     GROUP BY p.screen_id ORDER BY plays DESC`, params.venueId, lo, hi);

  sendJson(res, 200, {
    from, to,
    total_plays: media.reduce((n, m) => n + m.plays, 0),
    total_seconds: media.reduce((n, m) => n + (m.seconds || 0), 0),
    media, screens,
  });
});

// ---- Backup ----------------------------------------------------------------------

// Downloads a consistent snapshot of the whole CMS database (all tenants).
route('GET', '/api/backup', (req, res) => {
  auth.requireRole(req.user, 'superadmin');
  const stamp = new Date().toISOString().slice(0, 10);
  const tmp = path.join(db.DATA_DIR, `.backup-${process.pid}-${Date.now()}.db`);
  db.open().exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
  const size = fs.statSync(tmp).size;
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': size,
    'Content-Disposition': `attachment; filename="korvix-backup-${stamp}.db"`,
  });
  const stream = fs.createReadStream(tmp);
  const cleanup = () => fs.unlink(tmp, () => {});
  stream.on('close', cleanup);
  stream.on('error', cleanup);
  stream.pipe(res);
});

module.exports = { routes, nudgeVenue, nudgeAll, screenStatus, OFFLINE_AFTER_MS, generateInvoices };
