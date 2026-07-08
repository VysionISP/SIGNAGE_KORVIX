'use strict';

// Inbound integration webhooks. POS (BEPOZ / SwiftPOS / H&L), gaming systems,
// weather services etc. push JSON here; the payload is stored per venue as a
// named feed and delivered to players inside their manifest, where widgets
// (menu boards, jackpot displays, weather panels) render it live.
//
// Example — BEPOZ menu sync:
//   curl -X POST http://cms/api/integrations/<venueId>/pos \
//     -H 'Content-Type: application/json' \
//     -d '{"specials":[{"name":"Chicken Schnitzel","price":18.5}],"sold_out":["Barramundi"]}'
//
// Example — gaming jackpot tick:
//   curl -X POST http://cms/api/integrations/<venueId>/gaming \
//     -d '{"jackpots":[{"name":"Mega Link","amount":12847.50}]}'

const db = require('../db');
const { sendJson, readJson, HttpError } = require('../util');
const { nudgeVenue } = require('./admin');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

const SOURCES = new Set(['pos', 'gaming', 'weather', 'sports', 'racing', 'membership', 'custom']);

route('POST', '/api/integrations/:venueId/:source', async (req, res, params) => {
  if (!SOURCES.has(params.source)) {
    throw new HttpError(400, `unknown source; expected one of: ${[...SOURCES].join(', ')}`);
  }
  const venue = db.get('SELECT id FROM venues WHERE id = ?', params.venueId);
  if (!venue) throw new HttpError(404, 'venue not found');
  const payload = await readJson(req);
  db.run(
    `INSERT INTO feeds (venue_id, source, payload, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (venue_id, source) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
    params.venueId, params.source, JSON.stringify(payload), db.now());
  db.logEvent('feed.updated', { venueId: params.venueId, detail: params.source });
  nudgeVenue(params.venueId);
  sendJson(res, 200, { ok: true, source: params.source });
});

route('GET', '/api/integrations/:venueId', (req, res, params) => {
  const feeds = db.all('SELECT * FROM feeds WHERE venue_id = ? ORDER BY source', params.venueId)
    .map((f) => {
      let payload;
      try { payload = JSON.parse(f.payload); } catch { payload = {}; }
      return { source: f.source, updated_at: f.updated_at, payload };
    });
  sendJson(res, 200, { feeds });
});

route('DELETE', '/api/integrations/:venueId/:source', (req, res, params) => {
  db.run('DELETE FROM feeds WHERE venue_id = ? AND source = ?', params.venueId, params.source);
  nudgeVenue(params.venueId);
  sendJson(res, 200, { ok: true });
});

module.exports = { routes };
