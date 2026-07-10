'use strict';

// CashKing API. Admin/editor endpoints run the game; the public endpoint
// feeds websites and marketing tools with the current jackpot (no auth, by
// unguessable per-game token).

const db = require('../db');
const auth = require('../auth');
const { sendJson, readJson, HttpError } = require('../util');
const { nudgeVenue } = require('./admin');
const cashking = require('../cardgame');

// Audit-trail attribution ('API token' for the legacy env key).
const actorOf = (req) => req.user?.email || req.user?.name || null;

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

function gameById(id) {
  const game = db.get('SELECT * FROM card_games WHERE id = ?', id);
  if (!game) throw new HttpError(404, 'game not found');
  return game;
}

function venueName(venueId) {
  return db.get('SELECT name FROM venues WHERE id = ?', venueId)?.name || '';
}

route('GET', '/api/venues/:venueId/card-games', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const games = db.all(
    'SELECT * FROM card_games WHERE venue_id = ? ORDER BY created_at DESC LIMIT 20', params.venueId);
  sendJson(res, 200, {
    games: games.map((g) => ({ ...cashking.boardView(g), public_token: g.public_token, promo_webhook: g.promo_webhook })),
  });
});

route('POST', '/api/venues/:venueId/card-games', async (req, res, params) => {
  const venue = auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  const existing = cashking.currentGame(params.venueId);
  if (existing && existing.status === 'active') {
    throw new HttpError(409, `"${existing.name}" is still running — archive it or find the Joker first`);
  }
  const game = cashking.createGame(params.venueId, body);
  db.logEvent('cashking.created', { venueId: params.venueId, detail: `${game.name} @ $${game.jackpot_start}`, actor: actorOf(req) });
  cashking.fireWebhook(game, venue.name, 'created');
  nudgeVenue(params.venueId);
  sendJson(res, 201, { ...cashking.boardView(game), public_token: game.public_token });
});

route('PATCH', '/api/card-games/:id', async (req, res, params) => {
  const game = gameById(params.id);
  auth.assertVenue(req.user, game.venue_id, 'editor');
  const body = await readJson(req);
  const jackpot = body.jackpot_current !== undefined ? Number(body.jackpot_current) : game.jackpot_current;
  const increment = body.jackpot_increment !== undefined ? Number(body.jackpot_increment) : game.jackpot_increment;
  if (!Number.isFinite(jackpot) || !Number.isFinite(increment)) throw new HttpError(400, 'jackpot values must be numbers');
  db.run(
    'UPDATE card_games SET name = ?, session_text = ?, promo_webhook = ?, jackpot_current = ?, jackpot_increment = ? WHERE id = ?',
    body.name ?? game.name, body.session_text ?? game.session_text, body.promo_webhook ?? game.promo_webhook,
    jackpot, increment, game.id);
  nudgeVenue(game.venue_id);
  sendJson(res, 200, cashking.boardView(gameById(game.id)));
});

// Board takeover on every screen in the venue.
route('POST', '/api/card-games/:id/live', (req, res, params) => {
  const game = gameById(params.id);
  auth.assertVenue(req.user, game.venue_id, 'editor');
  if (game.status === 'archived') throw new HttpError(409, 'game is archived');
  db.run('UPDATE card_games SET live = 1 WHERE id = ?', game.id);
  db.logEvent('cashking.live', { venueId: game.venue_id, detail: game.name, actor: actorOf(req) });
  cashking.fireWebhook(gameById(game.id), venueName(game.venue_id), 'live');
  nudgeVenue(game.venue_id);
  sendJson(res, 200, cashking.boardView(gameById(game.id)));
});

route('POST', '/api/card-games/:id/end-session', (req, res, params) => {
  const game = gameById(params.id);
  auth.assertVenue(req.user, game.venue_id, 'editor');
  db.run('UPDATE card_games SET live = 0 WHERE id = ?', game.id);
  db.logEvent('cashking.session_ended', { venueId: game.venue_id, detail: game.name, actor: actorOf(req) });
  nudgeVenue(game.venue_id);
  sendJson(res, 200, cashking.boardView(gameById(game.id)));
});

route('POST', '/api/card-games/:id/pick', async (req, res, params) => {
  const game = gameById(params.id);
  auth.assertVenue(req.user, game.venue_id, 'editor');
  const body = await readJson(req);
  const index = parseInt(body.index, 10);
  if (!Number.isInteger(index)) throw new HttpError(400, 'index required (0-based card position)');
  const { game: updated, wasJoker } = cashking.pickCard(game, index, body.picked_by);
  const vName = venueName(game.venue_id);
  db.logEvent(wasJoker ? 'cashking.won' : 'cashking.miss', {
    venueId: game.venue_id,
    detail: `${updated.name}: #${index + 1} was ${cashking.prettyCard(JSON.parse(updated.last_pick).card)}`
      + (wasJoker ? ` — $${updated.jackpot_current} WON` : ''),
    actor: actorOf(req),
  });
  cashking.fireWebhook(updated, vName, wasJoker ? 'won' : 'miss');
  nudgeVenue(game.venue_id);
  sendJson(res, 200, { ...cashking.boardView(updated), was_joker: wasJoker });
});

route('POST', '/api/card-games/:id/archive', (req, res, params) => {
  const game = gameById(params.id);
  auth.assertVenue(req.user, game.venue_id, 'editor');
  db.run("UPDATE card_games SET status = 'archived', live = 0 WHERE id = ?", game.id);
  nudgeVenue(game.venue_id);
  sendJson(res, 200, { ok: true });
});

// ---- public promo feed (no auth — for websites, socials tooling, embeds) -----

route('GET', '/api/public/cashking/:token', (req, res, params) => {
  const game = db.get('SELECT * FROM card_games WHERE public_token = ?', params.token);
  if (!game || game.status === 'archived') throw new HttpError(404, 'not found');
  sendJson(res, 200, cashking.promoView(game, venueName(game.venue_id)));
});

module.exports = { routes };
