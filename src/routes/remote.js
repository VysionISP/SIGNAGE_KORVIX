'use strict';

// Staff remote API — powers the installable phone app at /remote/.
// Authenticated by the venue's remote token (an unguessable 32-char secret an
// admin generates in the dashboard), so bar staff can run raffle draws
// without dashboard access. Rotating the token in the dashboard instantly
// revokes every phone that has the old link.

const db = require('../db');
const { sendJson, readJson, HttpError, required } = require('../util');
const { nudgeVenue } = require('./admin');
const { spinDraw, drawView } = require('../draws');
const cashking = require('../cardgame');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

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
    venue: { id: venue.id, name: venue.name },
    zones: db.all('SELECT id, name FROM zones WHERE venue_id = ? ORDER BY name', venue.id),
    draws: draws.map(drawView),
    card_game: game ? cashking.boardView(game) : null,
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
  const games = db.run('UPDATE card_games SET live = 0 WHERE venue_id = ? AND live = 1', venue.id).changes;
  if (draws || games) {
    db.logEvent('screens.returned', { venueId: venue.id, detail: `back to advertising (staff remote)` });
    nudgeVenue(venue.id);
  }
  sendJson(res, 200, { ok: true, cleared: { draws, card_games: games } });
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
  db.logEvent('emergency.activated', { venueId: venue.id, detail: `${level}: ${body.title} (staff remote)` });
  nudgeVenue(venue.id);
  sendJson(res, 201, { id: emergencyId, level });
});

route('POST', '/api/remote/:token/emergency/:id/clear', (req, res, params) => {
  const venue = venueForToken(params.token);
  const emergency = db.get('SELECT * FROM emergencies WHERE id = ? AND venue_id = ?', params.id, venue.id);
  if (!emergency) throw new HttpError(404, 'emergency not found (all-venue alerts are cleared by Korvix)');
  db.run('UPDATE emergencies SET active = 0, cleared_at = ? WHERE id = ?', db.now(), emergency.id);
  db.logEvent('emergency.cleared', { venueId: venue.id, detail: `${emergency.title} (staff remote)` });
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
  db.logEvent('cashking.created', { venueId: venue.id, detail: `${game.name} @ $${game.jackpot_start} (staff remote)` });
  cashking.fireWebhook(game, venue.name, 'created');
  nudgeVenue(venue.id);
  sendJson(res, 201, cashking.boardView(game));
});

route('POST', '/api/remote/:token/card-games/:id/archive', (req, res, params) => {
  const { venue, game } = ownedGame(params.token, params.id);
  db.run("UPDATE card_games SET status = 'archived', live = 0 WHERE id = ?", game.id);
  db.logEvent('cashking.archived', { venueId: venue.id, detail: `${game.name} (staff remote)` });
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
  db.logEvent('cashking.live', { venueId: venue.id, detail: `${game.name} (staff remote)` });
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
  db.logEvent(wasJoker ? 'cashking.won' : 'cashking.miss', {
    venueId: venue.id,
    detail: `${updated.name}: #${index + 1} (staff remote)` + (wasJoker ? ` — $${updated.jackpot_current} WON` : ''),
  });
  cashking.fireWebhook(updated, venue.name, wasJoker ? 'won' : 'miss');
  nudgeVenue(venue.id);
  sendJson(res, 200, { ...cashking.boardView(updated), was_joker: wasJoker });
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
  db.logEvent('draw.created', { venueId: venue.id, detail: `${body.name} (staff remote)` });
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
  db.logEvent('draw.number', { venueId: draw.venue_id, detail: `${draw.name}: #${drawView(updated).latest_number} (staff remote)` });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, drawView(updated));
});

route('POST', '/api/remote/:token/draws/:id/clear', (req, res, params) => {
  const draw = ownedDraw(params.token, params.id);
  db.run("UPDATE draws SET status = 'cleared' WHERE id = ?", draw.id);
  db.logEvent('draw.cleared', { venueId: draw.venue_id, detail: `${draw.name} (staff remote)` });
  nudgeVenue(draw.venue_id);
  sendJson(res, 200, { ok: true });
});

module.exports = { routes };
