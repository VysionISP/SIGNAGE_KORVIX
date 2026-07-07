'use strict';

// Background monitoring for the managed service:
//   - offline alerts: a paired screen that stops heartbeating gets one alert
//     (event log + optional webhook); recovery clears it and alerts again
//   - automatic weather: venues with a latitude/longitude get their weather
//     feed refreshed from Open-Meteo (free, no API key) every 30 minutes
//   - retention: proof-of-play rows are pruned after 90 days
//
// Webhook payloads are plain JSON with a `text` field, so the same URL works
// for Slack, Discord (append /slack), Teams, or any custom receiver.

const db = require('./db');

const OFFLINE_AFTER_MS = parseInt(process.env.KORVIX_OFFLINE_MS, 10) || 90 * 1000;
const ALERT_WEBHOOK = process.env.KORVIX_ALERT_WEBHOOK || '';
const PLAYS_RETENTION_DAYS = parseInt(process.env.KORVIX_PLAYS_RETENTION_DAYS, 10) || 90;

async function postWebhook(payload) {
  if (!ALERT_WEBHOOK) return;
  try {
    await fetch(ALERT_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[korvix] alert webhook failed:', err.message);
  }
}

// Record that a screen's player made contact. Clears an outstanding offline
// alert (and announces the recovery). Used by heartbeat/manifest/hello.
function markSeen(screen, playerInfoJson) {
  if (playerInfoJson !== undefined) {
    db.run('UPDATE screens SET last_seen_at = ?, alerted = 0, player_info = ? WHERE id = ?',
      db.now(), playerInfoJson, screen.id);
  } else {
    db.run('UPDATE screens SET last_seen_at = ?, alerted = 0 WHERE id = ?', db.now(), screen.id);
  }
  if (screen.alerted) {
    const venue = db.get('SELECT name FROM venues WHERE id = ?', screen.venue_id);
    db.logEvent('screen.recovered', { venueId: screen.venue_id, screenId: screen.id, detail: screen.name });
    postWebhook({
      event: 'screen.recovered',
      text: `✅ Screen back online: ${screen.name} @ ${venue ? venue.name : screen.venue_id}`,
      screen: screen.name,
      venue: venue ? venue.name : null,
    });
  }
}

// One pass of offline detection: alert once per outage.
function checkOffline() {
  const cutoff = new Date(Date.now() - OFFLINE_AFTER_MS).toISOString();
  const stale = db.all(
    `SELECT s.*, v.name AS venue_name FROM screens s
     JOIN venues v ON v.id = s.venue_id
     WHERE s.device_key IS NOT NULL AND s.alerted = 0
       AND s.last_seen_at IS NOT NULL AND s.last_seen_at < ?`,
    cutoff);
  for (const screen of stale) {
    db.run('UPDATE screens SET alerted = 1 WHERE id = ?', screen.id);
    db.logEvent('screen.offline', { venueId: screen.venue_id, screenId: screen.id, detail: screen.name });
    postWebhook({
      event: 'screen.offline',
      text: `⚠️ Screen OFFLINE: ${screen.name} @ ${screen.venue_name} (no heartbeat for ${Math.round(OFFLINE_AFTER_MS / 1000)}s)`,
      screen: screen.name,
      venue: screen.venue_name,
      last_seen_at: screen.last_seen_at,
    });
  }
  return stale.length;
}

function prunePlays() {
  const cutoff = new Date(Date.now() - PLAYS_RETENTION_DAYS * 86400 * 1000).toISOString();
  db.run('DELETE FROM plays WHERE started_at < ?', cutoff);
}

// ---- automatic weather (Open-Meteo) -----------------------------------------

const WMO_CONDITIONS = {
  0: 'Clear', 1: 'Mostly clear', 2: 'Partly cloudy', 3: 'Overcast',
  45: 'Fog', 48: 'Fog', 51: 'Drizzle', 53: 'Drizzle', 55: 'Drizzle',
  61: 'Light rain', 63: 'Rain', 65: 'Heavy rain', 66: 'Freezing rain', 67: 'Freezing rain',
  71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
  80: 'Showers', 81: 'Showers', 82: 'Heavy showers', 85: 'Snow showers', 86: 'Snow showers',
  95: 'Thunderstorm', 96: 'Thunderstorm', 99: 'Thunderstorm',
};

async function refreshWeather() {
  const venues = db.all('SELECT * FROM venues WHERE latitude IS NOT NULL AND longitude IS NOT NULL');
  for (const venue of venues) {
    try {
      const url = 'https://api.open-meteo.com/v1/forecast'
        + `?latitude=${venue.latitude}&longitude=${venue.longitude}`
        + '&current=temperature_2m,weather_code'
        + '&daily=temperature_2m_max,temperature_2m_min&forecast_days=1&timezone=auto';
      const res = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) throw new Error(`open-meteo ${res.status}`);
      const data = await res.json();
      const payload = {
        location: venue.name,
        temp_c: Math.round(data.current?.temperature_2m ?? 0),
        condition: WMO_CONDITIONS[data.current?.weather_code] || '',
        high_c: Math.round(data.daily?.temperature_2m_max?.[0] ?? 0),
        low_c: Math.round(data.daily?.temperature_2m_min?.[0] ?? 0),
        source: 'open-meteo',
      };
      db.run(
        `INSERT INTO feeds (venue_id, source, payload, updated_at) VALUES (?, 'weather', ?, ?)
         ON CONFLICT (venue_id, source) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        venue.id, JSON.stringify(payload), db.now());
    } catch (err) {
      console.error(`[korvix] weather refresh failed for ${venue.name}:`, err.message);
    }
  }
}

function start() {
  // .unref() so timers never hold the process open (tests, shutdown).
  setInterval(() => { checkOffline(); prunePlays(); require('./auth').cleanupSessions(); }, 30 * 1000).unref();
  setInterval(refreshWeather, 30 * 60 * 1000).unref();
  setTimeout(refreshWeather, 5000).unref(); // first pass shortly after boot
  if (!ALERT_WEBHOOK) {
    console.log('[korvix] tip: set KORVIX_ALERT_WEBHOOK to get screen offline/recovery alerts (Slack/Teams/any JSON webhook)');
  }
}

module.exports = { start, markSeen, checkOffline, prunePlays, refreshWeather, postWebhook, OFFLINE_AFTER_MS };
