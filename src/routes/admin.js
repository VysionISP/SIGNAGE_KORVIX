'use strict';

// Admin/CMS API: venues, zones, screens, media, playlists, schedules,
// emergency broadcast and fleet health. Consumed by the dashboard SPA.

const path = require('node:path');
const fs = require('node:fs');
const db = require('../db');
const sse = require('../sse');
const { sendJson, readJson, HttpError, required } = require('../util');
const { OFFLINE_AFTER_MS } = require('../monitor');

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
  const venues = db.all('SELECT * FROM venues ORDER BY name').map((v) => ({
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
  const body = await readJson(req);
  required(body, 'name');
  const venueId = db.id();
  db.run('INSERT INTO venues (id, name, timezone, address, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    venueId, body.name, body.timezone || 'Australia/Sydney', body.address || '',
    numOrNull(body.latitude), numOrNull(body.longitude), db.now());
  sendJson(res, 201, db.get('SELECT * FROM venues WHERE id = ?', venueId));
});

route('PATCH', '/api/venues/:id', async (req, res, params) => {
  const venue = mustFind(db.get('SELECT * FROM venues WHERE id = ?', params.id), 'venue');
  const body = await readJson(req);
  db.run('UPDATE venues SET name = ?, timezone = ?, address = ?, latitude = ?, longitude = ? WHERE id = ?',
    body.name ?? venue.name, body.timezone ?? venue.timezone, body.address ?? venue.address,
    body.latitude !== undefined ? numOrNull(body.latitude) : venue.latitude,
    body.longitude !== undefined ? numOrNull(body.longitude) : venue.longitude,
    venue.id);
  if (body.latitude !== undefined || body.longitude !== undefined) {
    require('../monitor').refreshWeather(); // async, fire-and-forget
  }
  sendJson(res, 200, db.get('SELECT * FROM venues WHERE id = ?', venue.id));
});

route('DELETE', '/api/venues/:id', (req, res, params) => {
  db.run('DELETE FROM venues WHERE id = ?', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- Zones ------------------------------------------------------------

route('POST', '/api/venues/:venueId/zones', async (req, res, params) => {
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
  const body = await readJson(req);
  required(body, 'name');
  const zoneId = db.id();
  db.run('INSERT INTO zones (id, venue_id, name, description) VALUES (?, ?, ?, ?)',
    zoneId, params.venueId, body.name, body.description || '');
  sendJson(res, 201, db.get('SELECT * FROM zones WHERE id = ?', zoneId));
});

route('DELETE', '/api/zones/:id', (req, res, params) => {
  db.run('DELETE FROM zones WHERE id = ?', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- Screens & pairing -------------------------------------------------

route('GET', '/api/venues/:venueId/screens', (req, res, params) => {
  const screens = db.all('SELECT * FROM screens WHERE venue_id = ? ORDER BY name', params.venueId);
  sendJson(res, 200, { screens: screens.map(withStatus) });
});

route('POST', '/api/venues/:venueId/screens', async (req, res, params) => {
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
  const body = await readJson(req);
  required(body, 'name');
  const screenId = db.id();
  db.run(
    'INSERT INTO screens (id, venue_id, zone_id, name, orientation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    screenId, params.venueId, body.zone_id || null, body.name,
    body.orientation === 'portrait' ? 'portrait' : 'landscape', db.now());
  sendJson(res, 201, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screenId)));
});

const ROTATIONS = new Set([0, 90, 180, 270]);

route('PATCH', '/api/screens/:id', async (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  const body = await readJson(req);
  let rotation = screen.rotation;
  if (body.rotation !== undefined) {
    rotation = parseInt(body.rotation, 10);
    if (!ROTATIONS.has(rotation)) throw new HttpError(400, 'rotation must be 0, 90, 180 or 270');
  }
  db.run('UPDATE screens SET name = ?, zone_id = ?, orientation = ?, rotation = ? WHERE id = ?',
    body.name ?? screen.name,
    body.zone_id !== undefined ? (body.zone_id || null) : screen.zone_id,
    body.orientation ?? screen.orientation,
    rotation,
    screen.id);
  if (screen.device_key) sse.send(screen.device_key, 'refresh', { reason: 'screen-updated' });
  sendJson(res, 200, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screen.id)));
});

route('DELETE', '/api/screens/:id', (req, res, params) => {
  const screen = db.get('SELECT * FROM screens WHERE id = ?', params.id);
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
  const body = await readJson(req);
  required(body, 'pairing_code');
  const code = String(body.pairing_code).trim().toUpperCase();
  const pairing = mustFind(db.get('SELECT * FROM pairings WHERE pairing_code = ?', code), 'pairing code');
  db.run('UPDATE screens SET device_key = NULL WHERE device_key = ?', pairing.device_key);
  db.run('UPDATE screens SET device_key = ?, player_info = ?, last_seen_at = ? WHERE id = ?',
    pairing.device_key, pairing.player_info, db.now(), screen.id);
  db.run('DELETE FROM pairings WHERE pairing_code = ?', code);
  db.logEvent('screen.paired', { venueId: screen.venue_id, screenId: screen.id, detail: code });
  sse.send(pairing.device_key, 'paired', { screen_id: screen.id });
  sendJson(res, 200, withStatus(db.get('SELECT * FROM screens WHERE id = ?', screen.id)));
});

route('POST', '/api/screens/:id/unpair', (req, res, params) => {
  const screen = mustFind(db.get('SELECT * FROM screens WHERE id = ?', params.id), 'screen');
  if (screen.device_key) sse.send(screen.device_key, 'unpaired', {});
  db.run('UPDATE screens SET device_key = NULL, last_seen_at = NULL WHERE id = ?', screen.id);
  sendJson(res, 200, { ok: true });
});

// ---- Media library ------------------------------------------------------

const MEDIA_TYPES = new Set(['image', 'video', 'url', 'html', 'widget']);

route('GET', '/api/venues/:venueId/media', (req, res, params) => {
  sendJson(res, 200, { media: db.all('SELECT * FROM media WHERE venue_id = ? ORDER BY created_at DESC', params.venueId) });
});

route('POST', '/api/venues/:venueId/media', async (req, res, params) => {
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
  const body = await readJson(req);
  required(body, 'name', 'type');
  if (!MEDIA_TYPES.has(body.type)) throw new HttpError(400, `type must be one of: ${[...MEDIA_TYPES].join(', ')}`);
  const mediaId = db.id();
  db.run(
    'INSERT INTO media (id, venue_id, name, type, src, content, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    mediaId, params.venueId, body.name, body.type, body.src || '', body.content || '',
    Math.max(1, parseInt(body.duration_seconds, 10) || 10), db.now());
  sendJson(res, 201, db.get('SELECT * FROM media WHERE id = ?', mediaId));
});

route('PATCH', '/api/media/:id', async (req, res, params) => {
  const media = mustFind(db.get('SELECT * FROM media WHERE id = ?', params.id), 'media');
  const body = await readJson(req);
  if (body.type && !MEDIA_TYPES.has(body.type)) throw new HttpError(400, 'invalid media type');
  db.run('UPDATE media SET name = ?, type = ?, src = ?, content = ?, duration_seconds = ? WHERE id = ?',
    body.name ?? media.name, body.type ?? media.type, body.src ?? media.src,
    body.content ?? media.content,
    body.duration_seconds ? Math.max(1, parseInt(body.duration_seconds, 10)) : media.duration_seconds,
    media.id);
  nudgeVenue(media.venue_id);
  sendJson(res, 200, db.get('SELECT * FROM media WHERE id = ?', media.id));
});

route('DELETE', '/api/media/:id', (req, res, params) => {
  const media = db.get('SELECT * FROM media WHERE id = ?', params.id);
  db.run('DELETE FROM media WHERE id = ?', params.id);
  if (media) nudgeVenue(media.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Playlists -----------------------------------------------------------

route('GET', '/api/venues/:venueId/playlists', (req, res, params) => {
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
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
  const body = await readJson(req);
  required(body, 'name');
  const playlistId = db.id();
  db.run('INSERT INTO playlists (id, venue_id, name, created_at) VALUES (?, ?, ?, ?)',
    playlistId, params.venueId, body.name, db.now());
  sendJson(res, 201, { ...db.get('SELECT * FROM playlists WHERE id = ?', playlistId), items: [] });
});

route('POST', '/api/playlists/:id/items', async (req, res, params) => {
  const playlist = mustFind(db.get('SELECT * FROM playlists WHERE id = ?', params.id), 'playlist');
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
  const body = await readJson(req);
  if (!Array.isArray(body.item_ids)) throw new HttpError(400, 'item_ids array required');
  body.item_ids.forEach((itemId, index) => {
    db.run('UPDATE playlist_items SET position = ? WHERE id = ? AND playlist_id = ?', index, itemId, playlist.id);
  });
  nudgeVenue(playlist.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/playlist-items/:id', (req, res, params) => {
  const item = db.get('SELECT pi.*, p.venue_id FROM playlist_items pi JOIN playlists p ON p.id = pi.playlist_id WHERE pi.id = ?', params.id);
  db.run('DELETE FROM playlist_items WHERE id = ?', params.id);
  if (item) nudgeVenue(item.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/playlists/:id', (req, res, params) => {
  const playlist = db.get('SELECT * FROM playlists WHERE id = ?', params.id);
  db.run('DELETE FROM playlists WHERE id = ?', params.id);
  if (playlist) nudgeVenue(playlist.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Schedules (dayparting) ----------------------------------------------

route('GET', '/api/venues/:venueId/schedules', (req, res, params) => {
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

route('POST', '/api/venues/:venueId/schedules', async (req, res, params) => {
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
  const body = await readJson(req);
  required(body, 'playlist_id');
  mustFind(db.get('SELECT id FROM playlists WHERE id = ?', body.playlist_id), 'playlist');
  const days = Array.isArray(body.days_of_week) && body.days_of_week.length
    ? body.days_of_week : [0, 1, 2, 3, 4, 5, 6];
  const scheduleId = db.id();
  db.run(
    `INSERT INTO schedules (id, venue_id, zone_id, screen_id, playlist_id, name, days_of_week, start_time, end_time, priority, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    scheduleId, params.venueId, body.zone_id || null, body.screen_id || null, body.playlist_id,
    body.name || '', JSON.stringify(days), body.start_time || '00:00', body.end_time || '24:00',
    parseInt(body.priority, 10) || 0);
  nudgeVenue(params.venueId);
  sendJson(res, 201, db.get('SELECT * FROM schedules WHERE id = ?', scheduleId));
});

route('PATCH', '/api/schedules/:id', async (req, res, params) => {
  const schedule = mustFind(db.get('SELECT * FROM schedules WHERE id = ?', params.id), 'schedule');
  const body = await readJson(req);
  db.run(
    `UPDATE schedules SET name = ?, zone_id = ?, screen_id = ?, playlist_id = ?, days_of_week = ?,
       start_time = ?, end_time = ?, priority = ?, active = ? WHERE id = ?`,
    body.name ?? schedule.name,
    body.zone_id !== undefined ? (body.zone_id || null) : schedule.zone_id,
    body.screen_id !== undefined ? (body.screen_id || null) : schedule.screen_id,
    body.playlist_id ?? schedule.playlist_id,
    Array.isArray(body.days_of_week) ? JSON.stringify(body.days_of_week) : schedule.days_of_week,
    body.start_time ?? schedule.start_time,
    body.end_time ?? schedule.end_time,
    body.priority !== undefined ? parseInt(body.priority, 10) || 0 : schedule.priority,
    body.active !== undefined ? (body.active ? 1 : 0) : schedule.active,
    schedule.id);
  nudgeVenue(schedule.venue_id);
  sendJson(res, 200, db.get('SELECT * FROM schedules WHERE id = ?', schedule.id));
});

route('DELETE', '/api/schedules/:id', (req, res, params) => {
  const schedule = db.get('SELECT * FROM schedules WHERE id = ?', params.id);
  db.run('DELETE FROM schedules WHERE id = ?', params.id);
  if (schedule) nudgeVenue(schedule.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Emergency broadcast ---------------------------------------------------

const EMERGENCY_LEVELS = new Set(['evacuation', 'lockdown', 'alert', 'notice']);

route('GET', '/api/emergencies', (req, res) => {
  sendJson(res, 200, { emergencies: db.all('SELECT * FROM emergencies ORDER BY created_at DESC LIMIT 50') });
});

route('POST', '/api/emergencies', async (req, res) => {
  const body = await readJson(req);
  required(body, 'title');
  const level = EMERGENCY_LEVELS.has(body.level) ? body.level : 'alert';
  const emergencyId = db.id();
  db.run('INSERT INTO emergencies (id, venue_id, level, title, message, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    emergencyId, body.venue_id || null, level, body.title, body.message || '', db.now());
  db.logEvent('emergency.activated', { venueId: body.venue_id || null, detail: `${level}: ${body.title}` });
  if (body.venue_id) nudgeVenue(body.venue_id); else nudgeAll();
  sendJson(res, 201, db.get('SELECT * FROM emergencies WHERE id = ?', emergencyId));
});

route('POST', '/api/emergencies/:id/clear', (req, res, params) => {
  const emergency = mustFind(db.get('SELECT * FROM emergencies WHERE id = ?', params.id), 'emergency');
  db.run('UPDATE emergencies SET active = 0, cleared_at = ? WHERE id = ?', db.now(), emergency.id);
  db.logEvent('emergency.cleared', { venueId: emergency.venue_id, detail: emergency.title });
  if (emergency.venue_id) nudgeVenue(emergency.venue_id); else nudgeAll();
  sendJson(res, 200, { ok: true });
});

// ---- Staff remote app access ---------------------------------------------------

const crypto = require('node:crypto');

// Generate (or rotate) the venue's staff-remote token. Rotating instantly
// revokes every phone holding the old link.
route('POST', '/api/venues/:id/remote-token', (req, res, params) => {
  const venue = mustFind(db.get('SELECT * FROM venues WHERE id = ?', params.id), 'venue');
  const token = crypto.randomBytes(16).toString('hex');
  db.run('UPDATE venues SET remote_token = ? WHERE id = ?', token, venue.id);
  db.logEvent('remote.token_rotated', { venueId: venue.id, detail: venue.name });
  sendJson(res, 200, { token, url: `/remote/?t=${token}` });
});

route('GET', '/api/venues/:id/remote-token', (req, res, params) => {
  const venue = mustFind(db.get('SELECT * FROM venues WHERE id = ?', params.id), 'venue');
  sendJson(res, 200, venue.remote_token
    ? { token: venue.remote_token, url: `/remote/?t=${venue.remote_token}` }
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
  const draws = db.all(
    `SELECT d.*, z.name AS zone_name FROM draws d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.venue_id = ? ORDER BY d.created_at DESC LIMIT 100`, params.venueId);
  sendJson(res, 200, { draws: draws.map(drawView) });
});

route('POST', '/api/venues/:venueId/draws', async (req, res, params) => {
  mustFind(db.get('SELECT id FROM venues WHERE id = ?', params.venueId), 'venue');
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
  const updated = spinDraw(draw);
  db.logEvent('draw.number', { venueId: draw.venue_id, detail: `${draw.name}: #${drawView(updated).latest_number}` });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, drawView(updated));
});

route('POST', '/api/draws/:id/clear', (req, res, params) => {
  const draw = mustFind(db.get('SELECT * FROM draws WHERE id = ?', params.id), 'draw');
  db.run("UPDATE draws SET status = 'cleared' WHERE id = ?", draw.id);
  db.logEvent('draw.cleared', { venueId: draw.venue_id, detail: draw.name });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

route('DELETE', '/api/draws/:id', (req, res, params) => {
  const draw = db.get('SELECT * FROM draws WHERE id = ?', params.id);
  db.run('DELETE FROM draws WHERE id = ?', params.id);
  if (draw && draw.status === 'live') nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- Fleet health & events ---------------------------------------------------

route('GET', '/api/health/overview', (req, res) => {
  const venues = db.all('SELECT * FROM venues ORDER BY name').map((v) => {
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
  sendJson(res, 200, { events: db.all('SELECT * FROM events ORDER BY id DESC LIMIT 100') });
});

// ---- Proof-of-play reporting ---------------------------------------------------
//
// Players report every item they actually displayed; this aggregates it for a
// date range (UTC days). The per-media table is the evidence base for the
// cross-venue advertising network: "your promo ran N times for M minutes".

route('GET', '/api/venues/:venueId/reports/plays', (req, res, params, url) => {
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

// Downloads a consistent snapshot of the whole CMS database.
route('GET', '/api/backup', (req, res) => {
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

module.exports = { routes, nudgeVenue, nudgeAll, screenStatus, OFFLINE_AFTER_MS };
