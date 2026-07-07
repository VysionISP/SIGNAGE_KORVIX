'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const DATA_DIR = process.env.KORVIX_DATA_DIR || path.join(__dirname, '..', 'data');

let db;

function id() {
  return crypto.randomBytes(8).toString('hex');
}

function now() {
  return new Date().toISOString();
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'Australia/Sydney',
  address TEXT DEFAULT '',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS zones (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS screens (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  orientation TEXT NOT NULL DEFAULT 'landscape',
  rotation INTEGER NOT NULL DEFAULT 0, -- degrees the player rotates output: 0|90|180|270
  device_key TEXT UNIQUE,
  last_seen_at TEXT,
  player_info TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

-- Unpaired player devices waiting to be claimed from the dashboard.
CREATE TABLE IF NOT EXISTS pairings (
  pairing_code TEXT PRIMARY KEY,
  device_key TEXT NOT NULL UNIQUE,
  player_info TEXT DEFAULT '{}',
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS media (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- type: image | video | url | html | widget
  type TEXT NOT NULL,
  -- image/video/url: the src URL. widget: widget name (jackpot|menu|weather|welcome|clock).
  src TEXT DEFAULT '',
  -- html: inline markup rendered full-screen by the player.
  content TEXT DEFAULT '',
  duration_seconds INTEGER NOT NULL DEFAULT 10,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlists (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS playlist_items (
  id TEXT PRIMARY KEY,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL DEFAULT 0,
  duration_override INTEGER
);

-- Dayparting rules. Target is screen > zone > whole venue (most specific wins),
-- then priority breaks ties. Times are venue-local HH:MM; end < start wraps midnight.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE CASCADE,
  screen_id TEXT REFERENCES screens(id) ON DELETE CASCADE,
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  days_of_week TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
  start_time TEXT NOT NULL DEFAULT '00:00',
  end_time TEXT NOT NULL DEFAULT '24:00',
  priority INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- Emergency broadcast takes over every targeted screen instantly.
CREATE TABLE IF NOT EXISTS emergencies (
  id TEXT PRIMARY KEY,
  venue_id TEXT REFERENCES venues(id) ON DELETE CASCADE, -- NULL = all venues
  level TEXT NOT NULL DEFAULT 'alert',                   -- evacuation | lockdown | alert | notice
  title TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  cleared_at TEXT
);

-- Live data pushed in from integrations (POS, gaming, weather, ...). Widgets render these.
CREATE TABLE IF NOT EXISTS feeds (
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  source TEXT NOT NULL,        -- pos | gaming | weather | custom
  payload TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL,
  PRIMARY KEY (venue_id, source)
);

-- Raffle / promotional number draws. A draw owns a ticket range; each spin
-- picks an undrawn number and takes over the targeted screens until cleared.
CREATE TABLE IF NOT EXISTS draws (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  zone_id TEXT REFERENCES zones(id) ON DELETE SET NULL, -- NULL = whole venue
  name TEXT NOT NULL,
  range_start INTEGER NOT NULL,
  range_end INTEGER NOT NULL,
  drawn_numbers TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'ready',  -- ready | live | cleared
  created_at TEXT NOT NULL,
  drawn_at TEXT
);

-- Proof-of-play: one row per content item actually shown on a screen.
-- Powers reporting for venue promos and the cross-venue advertising network.
CREATE TABLE IF NOT EXISTS plays (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT NOT NULL,
  screen_id TEXT NOT NULL,
  media_id TEXT NOT NULL,
  media_name TEXT NOT NULL DEFAULT '',
  started_at TEXT NOT NULL,
  duration_seconds REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plays_venue_time ON plays (venue_id, started_at);
CREATE INDEX IF NOT EXISTS idx_plays_time ON plays (started_at);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venue_id TEXT,
  screen_id TEXT,
  type TEXT NOT NULL,
  detail TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
`;

function open() {
  if (db) return db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = process.env.KORVIX_DB || path.join(DATA_DIR, 'korvix.db');
  db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA);
  migrate();
  return db;
}

// Additive column migrations for databases created by earlier versions.
function migrate() {
  const screenCols = db.prepare('PRAGMA table_info(screens)').all().map((c) => c.name);
  if (!screenCols.includes('rotation')) {
    db.exec('ALTER TABLE screens ADD COLUMN rotation INTEGER NOT NULL DEFAULT 0');
  }
  if (!screenCols.includes('alerted')) {
    // 1 while an offline alert is outstanding, so we alert once per outage.
    db.exec('ALTER TABLE screens ADD COLUMN alerted INTEGER NOT NULL DEFAULT 0');
  }
  const venueCols = db.prepare('PRAGMA table_info(venues)').all().map((c) => c.name);
  if (!venueCols.includes('remote_token')) {
    // Bearer for the staff remote app; NULL until an admin generates one.
    db.exec('ALTER TABLE venues ADD COLUMN remote_token TEXT');
  }
  if (!venueCols.includes('latitude')) {
    // Set to enable automatic weather feeds (Open-Meteo, no API key needed).
    db.exec('ALTER TABLE venues ADD COLUMN latitude REAL');
    db.exec('ALTER TABLE venues ADD COLUMN longitude REAL');
  }
}

function get(sql, ...params) { return open().prepare(sql).get(...params); }
function all(sql, ...params) { return open().prepare(sql).all(...params); }
function run(sql, ...params) { return open().prepare(sql).run(...params); }

function logEvent(type, { venueId = null, screenId = null, detail = '' } = {}) {
  run('INSERT INTO events (venue_id, screen_id, type, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    venueId, screenId, type, String(detail), now());
}

function isEmpty() {
  return !get('SELECT id FROM venues LIMIT 1');
}

module.exports = { open, get, all, run, id, now, logEvent, isEmpty, DATA_DIR };
