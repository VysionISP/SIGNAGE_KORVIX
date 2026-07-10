'use strict';

// Staff remote API — powers the installable phone app at /remote/.
// Authenticated by the venue's remote token (an unguessable 32-char secret an
// admin generates in the dashboard), so bar staff can run raffle draws
// without dashboard access. Rotating the token in the dashboard instantly
// revokes every phone that has the old link.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const db = require('../db');
const { sendJson, readJson, readBody, HttpError, required } = require('../util');
const { nudgeVenue } = require('./admin');
const { spinDraw, drawView } = require('../draws');
const cashking = require('../cardgame');
const games = require('../games');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Console actions are venue-token-authed, not per-login, so the audit trail
// attributes them to the device rather than a person.
const logEvent = (type, opts) => db.logEvent(type, { ...opts, actor: 'Games console' });

function venueForToken(token) {
  const venue = token && db.get('SELECT * FROM venues WHERE remote_token = ?', token);
  if (!venue) throw new HttpError(404, 'invalid or revoked remote link');
  return venue;
}

// Everything the remote app needs in one call (it polls this).
route('GET', '/api/remote/:token', (req, res, params) => {
  const venue = venueForToken(params.token);
  const draws = db.all(
    `SELECT d.*, z.name AS zone_name FROM draws d
     LEFT JOIN zones z ON z.id = d.zone_id
     WHERE d.venue_id = ? ORDER BY d.created_at DESC LIMIT 30`, venue.id);
  const game = cashking.currentGame(venue.id);
  const emergency = db.get(
    `SELECT * FROM emergencies WHERE active = 1 AND (venue_id IS NULL OR venue_id = ?)
     ORDER BY created_at DESC LIMIT 1`, venue.id);
  sendJson(res, 200, {
    brand: require('../mailer').BRAND,
    venue: { id: venue.id, name: venue.name },
    zones: db.all('SELECT id, name FROM zones WHERE venue_id = ? ORDER BY name', venue.id),
    playlists: db.all('SELECT id, name FROM playlists WHERE venue_id = ? ORDER BY name', venue.id),
    menus: db.all('SELECT * FROM menus WHERE venue_id = ? ORDER BY name', venue.id).map((m) => {
      let sections; try { sections = JSON.parse(m.sections); } catch { sections = []; }
      return { id: m.id, name: m.name, sections };
    }),
    draws: draws.map(drawView),
    card_game: game ? cashking.boardView(game) : null,
    wheel: (() => { const w = games.currentWheel(venue.id); return w ? games.wheelView(w) : null; })(),
    badge_draw: (() => { const b = games.currentBadge(venue.id); return b ? games.badgeView(b) : null; })(),
    emergency: emergency ? {
      id: emergency.id, level: emergency.level, title: emergency.title,
      message: emergency.message, created_at: emergency.created_at,
      venue_scoped: emergency.venue_id === venue.id, // global ones clear from the NOC only
    } : null,
  });
});

// One tap: end every game takeover and put all screens back on their
// scheduled content. Deliberately does NOT touch emergencies — those clear
// only via their explicit all-clear.
route('POST', '/api/remote/:token/return-to-advertising', (req, res, params) => {
  const venue = venueForToken(params.token);
  const draws = db.run("UPDATE draws SET status = 'cleared' WHERE venue_id = ? AND status = 'live'", venue.id).changes;
  const cardGames = db.run('UPDATE card_games SET live = 0 WHERE venue_id = ? AND live = 1', venue.id).changes;
  const wheels = db.run('UPDATE wheels SET live = 0 WHERE venue_id = ? AND live = 1', venue.id).changes;
  const badges = db.run('UPDATE badge_draws SET live = 0 WHERE venue_id = ? AND live = 1', venue.id).changes;
  if (draws || cardGames || wheels || badges) {
    logEvent('screens.returned', { venueId: venue.id, detail: `back to advertising (staff remote)` });
    nudgeVenue(venue.id);
  }
  sendJson(res, 200, { ok: true, cleared: { draws, card_games: cardGames, wheels, badge_draws: badges } });
});

// ---- Wheel Spin from the tablet -------------------------------------------------

function ownedWheel(token, wheelId) {
  const venue = venueForToken(token);
  const wheel = db.get('SELECT * FROM wheels WHERE id = ? AND venue_id = ?', wheelId, venue.id);
  if (!wheel) throw new HttpError(404, 'wheel not found');
  return { venue, wheel };
}

route('POST', '/api/remote/:token/wheels', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const body = await readJson(req);
  const existing = games.currentWheel(venue.id);
  if (existing) db.run("UPDATE wheels SET status = 'archived', live = 0 WHERE id = ?", existing.id);
  const wheel = games.createWheel(venue.id, body);
  logEvent('wheel.created', { venueId: venue.id, detail: `${wheel.name} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 201, games.wheelView(wheel));
});

route('POST', '/api/remote/:token/wheels/:id/live', (req, res, params) => {
  const { venue, wheel } = ownedWheel(params.token, params.id);
  if (wheel.status === 'archived') throw new HttpError(409, 'wheel is archived');
  db.run('UPDATE wheels SET live = 1 WHERE id = ?', wheel.id);
  nudgeVenue(venue.id);
  sendJson(res, 200, games.wheelView(db.get('SELECT * FROM wheels WHERE id = ?', wheel.id)));
});

route('POST', '/api/remote/:token/wheels/:id/end-session', (req, res, params) => {
  const { venue, wheel } = ownedWheel(params.token, params.id);
  db.run('UPDATE wheels SET live = 0 WHERE id = ?', wheel.id);
  nudgeVenue(venue.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/remote/:token/wheels/:id/spin', (req, res, params) => {
  const { venue, wheel } = ownedWheel(params.token, params.id);
  const spin = games.spinWheel(wheel);
  logEvent('wheel.spun', { venueId: venue.id, detail: `${wheel.name}: ${spin.label}` });
  nudgeVenue(venue.id);
  sendJson(res, 200, { ...games.wheelView(db.get('SELECT * FROM wheels WHERE id = ?', wheel.id)), spin });
});

// ---- Members Badge Draw from the tablet -------------------------------------------

function ownedBadge(token, badgeId) {
  const venue = venueForToken(token);
  const badge = db.get('SELECT * FROM badge_draws WHERE id = ? AND venue_id = ?', badgeId, venue.id);
  if (!badge) throw new HttpError(404, 'badge draw not found');
  return { venue, badge };
}

route('POST', '/api/remote/:token/badge-draws', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const body = await readJson(req);
  const existing = games.currentBadge(venue.id);
  if (existing) db.run("UPDATE badge_draws SET status = 'archived', live = 0 WHERE id = ?", existing.id);
  const badge = games.createBadgeDraw(venue.id, body);
  logEvent('badge.created', { venueId: venue.id, detail: `${badge.name} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 201, games.badgeView(badge));
});

route('POST', '/api/remote/:token/badge-draws/:id/live', (req, res, params) => {
  const { venue, badge } = ownedBadge(params.token, params.id);
  if (badge.status === 'archived') throw new HttpError(409, 'badge draw is archived');
  db.run('UPDATE badge_draws SET live = 1 WHERE id = ?', badge.id);
  nudgeVenue(venue.id);
  sendJson(res, 200, games.badgeView(db.get('SELECT * FROM badge_draws WHERE id = ?', badge.id)));
});

route('POST', '/api/remote/:token/badge-draws/:id/end-session', (req, res, params) => {
  const { venue, badge } = ownedBadge(params.token, params.id);
  db.run('UPDATE badge_draws SET live = 0 WHERE id = ?', badge.id);
  nudgeVenue(venue.id);
  sendJson(res, 200, { ok: true });
});

route('POST', '/api/remote/:token/badge-draws/:id/draw', (req, res, params) => {
  const { venue, badge } = ownedBadge(params.token, params.id);
  const drawn = games.drawMember(badge);
  logEvent('badge.drawn', { venueId: venue.id, detail: `${badge.name}: #${drawn.number} ${drawn.name}` });
  nudgeVenue(venue.id);
  sendJson(res, 200, games.badgeView(db.get('SELECT * FROM badge_draws WHERE id = ?', badge.id)));
});

route('POST', '/api/remote/:token/badge-draws/:id/outcome', async (req, res, params) => {
  const { venue, badge } = ownedBadge(params.token, params.id);
  const body = await readJson(req);
  const updated = games.resolveBadge(badge, !!body.claimed);
  logEvent(body.claimed ? 'badge.claimed' : 'badge.unclaimed', {
    venueId: venue.id,
    detail: body.claimed
      ? `$${badge.prize_current} claimed`
      : `unclaimed — jackpots to $${updated.prize_current}`,
  });
  nudgeVenue(venue.id);
  sendJson(res, 200, games.badgeView(updated));
});

// ---- Emergency broadcast from the venue tablet ---------------------------------
//
// Venue-scoped only: the tablet can take over its own venue's screens, never
// other tenants'. Global (all-venue) broadcasts remain Korvix-only.

const EMERGENCY_LEVELS = new Set(['evacuation', 'lockdown', 'alert', 'notice']);

route('POST', '/api/remote/:token/emergency', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const body = await readJson(req);
  required(body, 'title');
  const level = EMERGENCY_LEVELS.has(body.level) ? body.level : 'alert';
  const emergencyId = db.id();
  db.run('INSERT INTO emergencies (id, venue_id, level, title, message, active, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)',
    emergencyId, venue.id, level, body.title, body.message || '', db.now());
  logEvent('emergency.activated', { venueId: venue.id, detail: `${level}: ${body.title} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 201, { id: emergencyId, level });
});

route('POST', '/api/remote/:token/emergency/:id/clear', (req, res, params) => {
  const venue = venueForToken(params.token);
  const emergency = db.get('SELECT * FROM emergencies WHERE id = ? AND venue_id = ?', params.id, venue.id);
  if (!emergency) throw new HttpError(404, 'emergency not found (all-venue alerts are cleared by Korvix)');
  db.run('UPDATE emergencies SET active = 0, cleared_at = ? WHERE id = ?', db.now(), emergency.id);
  logEvent('emergency.cleared', { venueId: venue.id, detail: `${emergency.title} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 200, { ok: true });
});

// ---- CashKing from the staff phone ------------------------------------------

// Start a new game from the tablet (only when none is running).
route('POST', '/api/remote/:token/card-games', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const body = await readJson(req);
  const existing = cashking.currentGame(venue.id);
  if (existing && existing.status === 'active') {
    throw new HttpError(409, `"${existing.name}" is still running — find the Joker or archive it first`);
  }
  const game = cashking.createGame(venue.id, body);
  logEvent('cashking.created', { venueId: venue.id, detail: `${game.name} @ $${game.jackpot_start} (staff remote)` });
  cashking.fireWebhook(game, venue.name, 'created');
  nudgeVenue(venue.id);
  sendJson(res, 201, cashking.boardView(game));
});

route('POST', '/api/remote/:token/card-games/:id/archive', (req, res, params) => {
  const { venue, game } = ownedGame(params.token, params.id);
  db.run("UPDATE card_games SET status = 'archived', live = 0 WHERE id = ?", game.id);
  logEvent('cashking.archived', { venueId: venue.id, detail: `${game.name} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 200, { ok: true });
});

function ownedGame(token, gameId) {
  const venue = venueForToken(token);
  const game = db.get('SELECT * FROM card_games WHERE id = ? AND venue_id = ?', gameId, venue.id);
  if (!game) throw new HttpError(404, 'game not found');
  return { venue, game };
}

route('POST', '/api/remote/:token/card-games/:id/live', (req, res, params) => {
  const { venue, game } = ownedGame(params.token, params.id);
  if (game.status === 'archived') throw new HttpError(409, 'game is archived');
  db.run('UPDATE card_games SET live = 1 WHERE id = ?', game.id);
  logEvent('cashking.live', { venueId: venue.id, detail: `${game.name} (staff remote)` });
  cashking.fireWebhook(db.get('SELECT * FROM card_games WHERE id = ?', game.id), venue.name, 'live');
  nudgeVenue(venue.id);
  sendJson(res, 200, cashking.boardView(db.get('SELECT * FROM card_games WHERE id = ?', game.id)));
});

route('POST', '/api/remote/:token/card-games/:id/end-session', (req, res, params) => {
  const { venue, game } = ownedGame(params.token, params.id);
  db.run('UPDATE card_games SET live = 0 WHERE id = ?', game.id);
  nudgeVenue(venue.id);
  sendJson(res, 200, cashking.boardView(db.get('SELECT * FROM card_games WHERE id = ?', game.id)));
});

route('POST', '/api/remote/:token/card-games/:id/pick', async (req, res, params) => {
  const { venue, game } = ownedGame(params.token, params.id);
  const body = await readJson(req);
  const index = parseInt(body.index, 10);
  if (!Number.isInteger(index)) throw new HttpError(400, 'index required');
  const { game: updated, wasJoker } = cashking.pickCard(game, index, body.picked_by);
  logEvent(wasJoker ? 'cashking.won' : 'cashking.miss', {
    venueId: venue.id,
    detail: `${updated.name}: #${index + 1} (staff remote)` + (wasJoker ? ` — $${updated.jackpot_current} WON` : ''),
  });
  cashking.fireWebhook(updated, venue.name, wasJoker ? 'won' : 'miss');
  nudgeVenue(venue.id);
  sendJson(res, 200, { ...cashking.boardView(updated), was_joker: wasJoker });
});

// ---- Menus from the tablet --------------------------------------------------------
//
// Kitchen runs out of the parma? Staff flip it to sold out right on the
// tablet and every board in the venue updates within a second. Toggle-only:
// menu text/prices stay dashboard-managed.

route('POST', '/api/remote/:token/menus/:id/sold-out', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const menu = db.get('SELECT * FROM menus WHERE id = ? AND venue_id = ?', params.id, venue.id);
  if (!menu) throw new HttpError(404, 'menu not found');
  const body = await readJson(req);
  const si = parseInt(body.section, 10);
  const ii = parseInt(body.item, 10);
  let sections;
  try { sections = JSON.parse(menu.sections); } catch { sections = []; }
  const item = sections?.[si]?.items?.[ii];
  if (!item) throw new HttpError(400, 'unknown menu item');
  item.sold_out = !!body.sold_out;
  db.run('UPDATE menus SET sections = ?, updated_at = ? WHERE id = ?',
    JSON.stringify(sections), db.now(), menu.id);
  logEvent(item.sold_out ? 'menu.sold_out' : 'menu.back_on', {
    venueId: venue.id, detail: `${menu.name}: ${item.name}`,
  });
  nudgeVenue(venue.id);
  sendJson(res, 200, { ok: true, item: { name: item.name, sold_out: item.sold_out } });
});

// ---- Photo to screen ------------------------------------------------------------
//
// Staff snap a photo on the tablet (tonight's special, a poster, a lost dog)
// and it slots straight into a playlist, then quietly removes itself after
// the chosen number of hours.

const PHOTO_EXTS = { '.jpg': 1, '.jpeg': 1, '.png': 1, '.webp': 1, '.gif': 1 };

route('POST', '/api/remote/:token/photo', async (req, res, params, url) => {
  const venue = venueForToken(params.token);
  const original = (url.searchParams.get('name') || 'photo.jpg').replace(/[^\w.-]+/g, '_');
  const ext = path.extname(original).toLowerCase();
  if (!PHOTO_EXTS[ext]) throw new HttpError(400, 'photos only — jpg, png, webp or gif');

  const playlistId = url.searchParams.get('playlist_id') || '';
  const playlist = db.get('SELECT * FROM playlists WHERE id = ? AND venue_id = ?', playlistId, venue.id);
  if (!playlist) throw new HttpError(400, 'pick which playlist the photo should appear in');

  const hours = Math.min(Math.max(parseFloat(url.searchParams.get('hours')) || 24, 0.5), 24 * 7);
  const buf = await readBody(req, 30 * 1024 * 1024);
  if (!buf.length) throw new HttpError(400, 'empty upload');

  const uploadDir = path.join(db.DATA_DIR, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  const fileName = `${venue.org_id || 'global'}__console-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}${ext}`;
  fs.writeFileSync(path.join(uploadDir, fileName), buf);

  const label = (url.searchParams.get('label') || '').trim() || `Console photo ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
  const expiresAt = new Date(Date.now() + hours * 3600 * 1000).toISOString();
  const mediaId = db.id();
  db.run(
    `INSERT INTO media (id, venue_id, name, type, src, duration_seconds, fit, expires_at, created_at)
     VALUES (?, ?, ?, 'image', ?, 10, 'contain', ?, ?)`,
    mediaId, venue.id, label, `/uploads/${fileName}`, expiresAt, db.now());
  const pos = db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_items WHERE playlist_id = ?', playlist.id).p;
  db.run('INSERT INTO playlist_items (id, playlist_id, media_id, position) VALUES (?, ?, ?, ?)',
    db.id(), playlist.id, mediaId, pos);

  logEvent('media.console_photo', { venueId: venue.id, detail: `${label} → ${playlist.name} (expires ${hours}h)` });
  nudgeVenue(venue.id);
  sendJson(res, 201, { ok: true, media_id: mediaId, playlist: playlist.name, expires_at: expiresAt });
});

route('POST', '/api/remote/:token/draws', async (req, res, params) => {
  const venue = venueForToken(params.token);
  const body = await readJson(req);
  required(body, 'name');
  const start = parseInt(body.range_start, 10);
  const end = parseInt(body.range_end, 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) {
    throw new HttpError(400, 'ticket range invalid — last number must be >= first');
  }
  if (end - start > 1_000_000) throw new HttpError(400, 'range too large (max 1,000,000 tickets)');
  if (body.zone_id && !db.get('SELECT id FROM zones WHERE id = ? AND venue_id = ?', body.zone_id, venue.id)) {
    throw new HttpError(400, 'unknown zone');
  }
  const drawId = db.id();
  db.run(
    `INSERT INTO draws (id, venue_id, zone_id, name, range_start, range_end, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    drawId, venue.id, body.zone_id || null, body.name, start, end, db.now());
  logEvent('draw.created', { venueId: venue.id, detail: `${body.name} (staff remote)` });
  sendJson(res, 201, drawView(db.get('SELECT * FROM draws WHERE id = ?', drawId)));
});

function ownedDraw(token, drawId) {
  const venue = venueForToken(token);
  const draw = db.get('SELECT * FROM draws WHERE id = ? AND venue_id = ?', drawId, venue.id);
  if (!draw) throw new HttpError(404, 'draw not found');
  return draw;
}

route('POST', '/api/remote/:token/draws/:id/draw', (req, res, params) => {
  const draw = ownedDraw(params.token, params.id);
  const updated = spinDraw(draw);
  logEvent('draw.number', { venueId: draw.venue_id, detail: `${draw.name}: #${drawView(updated).latest_number} (staff remote)` });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, drawView(updated));
});

route('POST', '/api/remote/:token/draws/:id/clear', (req, res, params) => {
  const draw = ownedDraw(params.token, params.id);
  db.run("UPDATE draws SET status = 'cleared' WHERE id = ?", draw.id);
  logEvent('draw.cleared', { venueId: draw.venue_id, detail: `${draw.name} (staff remote)` });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

module.exports = { routes };
