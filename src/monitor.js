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

const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');
const mailer = require('./mailer');

const OFFLINE_AFTER_MS = parseInt(process.env.KORVIX_OFFLINE_MS, 10) || 90 * 1000;
const ALERT_WEBHOOK = process.env.KORVIX_ALERT_WEBHOOK || '';
const PLAYS_RETENTION_DAYS = parseInt(process.env.KORVIX_PLAYS_RETENTION_DAYS, 10) || 90;
const BACKUPS_KEPT = parseInt(process.env.KORVIX_BACKUPS_KEPT, 10) || 14;

// Screen offline/recovery emails go to the owning business (orgs.alert_email).
// A no-op until SMTP is configured — the webhook keeps working regardless.
function emailOrgAlert(venueId, subject, bodyHtml) {
  if (!mailer.configured()) return;
  const org = db.get(
    'SELECT o.* FROM orgs o JOIN venues v ON v.org_id = o.id WHERE v.id = ?', venueId);
  if (!org?.alert_email) return;
  mailer.sendMail({
    to: org.alert_email,
    subject,
    html: mailer.template(subject, bodyHtml),
  });
}

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
    emailOrgAlert(screen.venue_id, `✅ Screen back online: ${screen.name}`,
      `<p><b>${screen.name}</b> at <b>${venue ? venue.name : 'your venue'}</b> is showing content again.</p>`);
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
    emailOrgAlert(screen.venue_id, `⚠️ Screen offline: ${screen.name}`,
      `<p><b>${screen.name}</b> at <b>${screen.venue_name}</b> stopped responding`
      + ` (last seen ${screen.last_seen_at}).</p>`
      + '<p>Usual fixes: check the TV is on and its power/network cables are in,'
      + ' or power-cycle the media player. It will show as recovered here as soon as it reconnects.</p>');
  }
  return stale.length;
}

function prunePlays() {
  const cutoff = new Date(Date.now() - PLAYS_RETENTION_DAYS * 86400 * 1000).toISOString();
  db.run('DELETE FROM plays WHERE started_at < ?', cutoff);
}

// Expired console photos (and other self-expiring media): remove the rows and
// their uploaded files once past their expiry.
function pruneExpiredMedia() {
  const expired = db.all('SELECT * FROM media WHERE expires_at IS NOT NULL AND expires_at < ?', db.now());
  for (const m of expired) {
    db.run('DELETE FROM media WHERE id = ?', m.id); // playlist_items cascade
    if (m.src && m.src.startsWith('/uploads/')) {
      const file = path.join(db.DATA_DIR, 'uploads', path.basename(m.src));
      try { fs.unlinkSync(file); } catch { /* already gone */ }
    }
    db.logEvent('media.expired', { venueId: m.venue_id, detail: m.name, actor: 'system' });
  }
  if (expired.length) {
    const { nudgeVenue } = require('./routes/admin');
    for (const vid of new Set(expired.map((m) => m.venue_id))) nudgeVenue(vid);
  }
  return expired.length;
}

// ---- automated nightly backups ----------------------------------------------

const BACKUP_DIR = path.join(db.DATA_DIR, 'backups');

function runBackup() {
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const stamp = new Date().toISOString().slice(0, 10);
    const file = path.join(BACKUP_DIR, `signage-${stamp}.db`);
    if (fs.existsSync(file)) return file; // already done today
    db.open().exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
    // keep the newest N, drop the rest
    const all = fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).sort().reverse();
    for (const old of all.slice(BACKUPS_KEPT)) {
      try { fs.unlinkSync(path.join(BACKUP_DIR, old)); } catch { /* ignore */ }
    }
    db.logEvent('backup.created', { detail: path.basename(file), actor: 'system' });
    return file;
  } catch (err) {
    console.error('[korvix] nightly backup failed:', err.message);
    return null;
  }
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

function cleanupResets() {
  db.run('DELETE FROM password_resets WHERE expires_at < ?', db.now());
}

// On the 1st of each month, draft this month's licence invoices. Idempotent
// (one per business per period), so re-runs and manual generation coexist.
function monthlyInvoices() {
  if (new Date().getDate() !== 1) return;
  try {
    const created = require('./routes/admin').generateInvoices(new Date().toISOString().slice(0, 7));
    if (created.length) console.log(`[korvix] drafted ${created.length} licence invoice(s) for the new month`);
  } catch (err) {
    console.error('[korvix] monthly invoicing failed:', err.message);
  }
}

function start() {
  // .unref() so timers never hold the process open (tests, shutdown).
  setInterval(() => {
    checkOffline();
    prunePlays();
    pruneExpiredMedia();
    cleanupResets();
    require('./auth').cleanupSessions();
  }, 30 * 1000).unref();
  setInterval(refreshWeather, 30 * 60 * 1000).unref();
  setTimeout(refreshWeather, 5000).unref(); // first pass shortly after boot
  // One backup per calendar day; runBackup() no-ops if today's already exists.
  setInterval(runBackup, 60 * 60 * 1000).unref();
  setTimeout(runBackup, 15000).unref();
  setInterval(monthlyInvoices, 60 * 60 * 1000).unref();
  setTimeout(monthlyInvoices, 20000).unref();
  if (!ALERT_WEBHOOK) {
    console.log('[korvix] tip: set KORVIX_ALERT_WEBHOOK to get screen offline/recovery alerts (Slack/Teams/any JSON webhook)');
  }
  if (!mailer.configured()) {
    console.log('[korvix] tip: set SMTP_HOST/SMTP_USER/SMTP_PASS/MAIL_FROM to enable password reset, invite and alert emails');
  }
}

module.exports = { start, markSeen, checkOffline, prunePlays, pruneExpiredMedia, runBackup, cleanupResets, refreshWeather, postWebhook, OFFLINE_AFTER_MS, BACKUP_DIR };
