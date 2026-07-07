'use strict';

// Player-facing API. A player device is a browser in kiosk mode (smart TV,
// Raspberry Pi, Android box) pointing at /player/. Lifecycle:
//
//   1. POST /api/player/hello  -> paired? get manifest : show pairing code
//   2. GET  /api/player/:key/events (SSE) -> instant refresh nudges
//   3. GET  /api/player/:key/manifest    -> what to play right now
//   4. POST /api/player/:key/heartbeat   -> health telemetry every 30s

const crypto = require('node:crypto');
const db = require('../db');
const sse = require('../sse');
const { sendJson, readJson, HttpError } = require('../util');
const { buildManifest } = require('../scheduler');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

// Unambiguous alphabet for codes typed off a TV screen.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function pairingCode() {
  let code = '';
  for (let i = 0; i < 6; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

function findScreen(deviceKey) {
  return db.get('SELECT * FROM screens WHERE device_key = ?', deviceKey);
}

// Idempotent bootstrap. Body: { device_key?, player_info? }.
route('POST', '/api/player/hello', async (req, res) => {
  const body = await readJson(req);
  const info = JSON.stringify(body.player_info || {});
  const deviceKey = body.device_key || null;

  if (deviceKey) {
    const screen = findScreen(deviceKey);
    if (screen) {
      db.run('UPDATE screens SET last_seen_at = ?, player_info = ? WHERE id = ?', db.now(), info, screen.id);
      sendJson(res, 200, { status: 'paired', device_key: deviceKey, screen_id: screen.id });
      return;
    }
    const pending = db.get('SELECT * FROM pairings WHERE device_key = ?', deviceKey);
    if (pending) {
      sendJson(res, 200, { status: 'pending', device_key: deviceKey, pairing_code: pending.pairing_code });
      return;
    }
  }

  // Unknown device: mint a key + code and wait to be claimed from the dashboard.
  const newKey = crypto.randomBytes(16).toString('hex');
  const code = pairingCode();
  db.run('INSERT INTO pairings (pairing_code, device_key, player_info, created_at) VALUES (?, ?, ?, ?)',
    code, newKey, info, db.now());
  sendJson(res, 200, { status: 'pending', device_key: newKey, pairing_code: code });
});

route('GET', '/api/player/:deviceKey/manifest', (req, res, params) => {
  const screen = findScreen(params.deviceKey);
  if (!screen) throw new HttpError(404, 'device not paired');
  db.run('UPDATE screens SET last_seen_at = ? WHERE id = ?', db.now(), screen.id);
  sendJson(res, 200, buildManifest(screen));
});

route('POST', '/api/player/:deviceKey/heartbeat', async (req, res, params) => {
  const screen = findScreen(params.deviceKey);
  if (!screen) throw new HttpError(404, 'device not paired');
  const body = await readJson(req);
  const wasOffline = screen.last_seen_at
    && (Date.now() - Date.parse(screen.last_seen_at)) > 90 * 1000;
  db.run('UPDATE screens SET last_seen_at = ?, player_info = ? WHERE id = ?',
    db.now(), JSON.stringify(body.player_info || {}), screen.id);
  if (wasOffline) {
    db.logEvent('screen.recovered', { venueId: screen.venue_id, screenId: screen.id, detail: screen.name });
  }
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/player/:deviceKey/events', (req, res, params) => {
  // Pending (unpaired) devices may subscribe too, so pairing flips them live
  // the moment the dashboard claims the code.
  const known = findScreen(params.deviceKey)
    || db.get('SELECT * FROM pairings WHERE device_key = ?', params.deviceKey);
  if (!known) throw new HttpError(404, 'unknown device');
  sse.subscribe(params.deviceKey, res);
});

module.exports = { routes };
