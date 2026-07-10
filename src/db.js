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
-- A business (tenant): owns venues and users. Korvix superadmins sit outside
-- any org (org_id NULL) and see everything.
CREATE TABLE IF NOT EXISTS orgs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  org_id TEXT REFERENCES orgs(id) ON DELETE CASCADE, -- NULL = Korvix superadmin
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'editor', -- superadmin | admin | editor | viewer
  created_at TEXT NOT NULL,
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

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
  -- image/video sizing: cover (fill screen, crop) | contain (letterbox, show all)
  fit TEXT NOT NULL DEFAULT 'cover',
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

-- CashKing: digital "Jag the Joker" card game. 53 shuffled cards (52 + Joker)
-- revealed one per game night; jackpot increments on every miss until the
-- Joker is found. Card faces stay server-side until revealed.
CREATE TABLE IF NOT EXISTS card_games (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'CashKing',
  status TEXT NOT NULL DEFAULT 'active',   -- active | won | archived
  live INTEGER NOT NULL DEFAULT 0,         -- 1 = board takeover on all venue screens
  deck TEXT NOT NULL,                      -- JSON [{c:'AS', r:revealed_at|null, by:name|null}, ...]
  jackpot_start REAL NOT NULL DEFAULT 1000,
  jackpot_increment REAL NOT NULL DEFAULT 100,
  jackpot_current REAL NOT NULL DEFAULT 1000,
  session_text TEXT NOT NULL DEFAULT '',   -- e.g. 'Thursdays 7:30pm'
  promo_webhook TEXT NOT NULL DEFAULT '',  -- marketing webhook fired on every game event
  public_token TEXT NOT NULL,              -- for the no-auth website/embed JSON feed
  last_pick TEXT,                          -- JSON {index, card, was_joker, by, at}
  created_at TEXT NOT NULL,
  won_at TEXT
);

-- Menu boards: venue-editable menus rendered by the 'menuboard:<id>' widget.
-- sections JSON: [{title, items: [{name, desc, price, sold_out}]}]
CREATE TABLE IF NOT EXISTS menus (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Menu',
  sections TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Wheel Spin: configurable prize wheel. Wedges carry a label + probability
-- weight (equal-sized on screen; weight only affects the odds).
CREATE TABLE IF NOT EXISTS wheels (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Wheel Spin',
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived
  live INTEGER NOT NULL DEFAULT 0,
  wedges TEXT NOT NULL,                   -- JSON [{label, weight}]
  last_spin TEXT,                         -- JSON {index, label, at}
  created_at TEXT NOT NULL
);

-- Members Badge Draw: random member drawn on screen with a claim countdown.
-- Claimed -> prize resets to the base; unclaimed -> jackpots by the increment.
CREATE TABLE IF NOT EXISTS badge_draws (
  id TEXT PRIMARY KEY,
  venue_id TEXT NOT NULL REFERENCES venues(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT 'Members Badge Draw',
  status TEXT NOT NULL DEFAULT 'active',  -- active | archived
  live INTEGER NOT NULL DEFAULT 0,
  prize_start REAL NOT NULL DEFAULT 100,
  increment REAL NOT NULL DEFAULT 50,
  prize_current REAL NOT NULL DEFAULT 100,
  claim_minutes INTEGER NOT NULL DEFAULT 3,
  members TEXT NOT NULL DEFAULT '[]',     -- JSON [{number, name}]
  current TEXT,                           -- JSON {number, name, drawn_at, deadline, outcome}
  history TEXT NOT NULL DEFAULT '[]',     -- JSON [{number, name, outcome, prize, at}]
  created_at TEXT NOT NULL
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

-- Instance-wide key/value config (licence pricing, etc.)
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT ''
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
  if (!screenCols.includes('channel')) {
    // main = scheduled playlists; racing1/2/3, racing-results, sports = the
    // screen is dedicated to that live channel and ignores schedules.
    db.exec("ALTER TABLE screens ADD COLUMN channel TEXT NOT NULL DEFAULT 'main'");
  }
  if (!screenCols.includes('layout')) {
    // full | side (main + side panel) | ticker | side-ticker
    db.exec("ALTER TABLE screens ADD COLUMN layout TEXT NOT NULL DEFAULT 'full'");
    db.exec('ALTER TABLE screens ADD COLUMN side_playlist_id TEXT');
  }
  if (!screenCols.includes('alerted')) {
    // 1 while an offline alert is outstanding, so we alert once per outage.
    db.exec('ALTER TABLE screens ADD COLUMN alerted INTEGER NOT NULL DEFAULT 0');
  }
  if (!screenCols.includes('license')) {
    // Billing tier: 'main' (everything: game takeovers, racing/sports
    // channels) or 'basic' (playlists, menus, widgets — no games/channels).
    // Existing screens default to main so nothing regresses on upgrade.
    db.exec("ALTER TABLE screens ADD COLUMN license TEXT NOT NULL DEFAULT 'main'");
  }
  const eventCols = db.prepare('PRAGMA table_info(events)').all().map((c) => c.name);
  if (!eventCols.includes('actor')) {
    // Audit trail: which login (or system/console) did it.
    db.exec('ALTER TABLE events ADD COLUMN actor TEXT');
  }
  const orgCols = db.prepare('PRAGMA table_info(orgs)').all().map((c) => c.name);
  if (!orgCols.includes('alert_email')) {
    // Screen offline/recovery alerts go here per business (when email is configured).
    db.exec('ALTER TABLE orgs ADD COLUMN alert_email TEXT');
  }
  const mediaCols0 = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!mediaCols0.includes('expires_at')) {
    // Self-expiring media (e.g. tonight's-special photos posted from the console).
    db.exec('ALTER TABLE media ADD COLUMN expires_at TEXT');
  }
  const venueCols0 = db.prepare('PRAGMA table_info(venues)').all().map((c) => c.name);
  if (!venueCols0.includes('sleep_start')) {
    // Screens show black outside trading hours (venue-local HH:MM window).
    db.exec('ALTER TABLE venues ADD COLUMN sleep_start TEXT');
    db.exec('ALTER TABLE venues ADD COLUMN sleep_end TEXT');
  }
  const scheduleCols = db.prepare('PRAGMA table_info(schedules)').all().map((c) => c.name);
  if (!scheduleCols.includes('start_date')) {
    // Optional calendar bounds (venue-local YYYY-MM-DD). NULL = every week.
    db.exec('ALTER TABLE schedules ADD COLUMN start_date TEXT');
    db.exec('ALTER TABLE schedules ADD COLUMN end_date TEXT');
  }
  const mediaCols = db.prepare('PRAGMA table_info(media)').all().map((c) => c.name);
  if (!mediaCols.includes('fit')) {
    db.exec("ALTER TABLE media ADD COLUMN fit TEXT NOT NULL DEFAULT 'cover'");
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
  if (!venueCols.includes('logo_url')) {
    // Venue branding, shown on menu boards and the welcome widget.
    db.exec('ALTER TABLE venues ADD COLUMN logo_url TEXT');
  }
  const menuCols = db.prepare('PRAGMA table_info(menus)').all().map((c) => c.name);
  if (!menuCols.includes('theme')) {
    db.exec("ALTER TABLE menus ADD COLUMN theme TEXT NOT NULL DEFAULT 'classic'");
  }
  if (!venueCols.includes('racing_jurisdiction')) {
    // Set (NSW/VIC/QLD/...) to enable the built-in TAB next-to-go poller.
    db.exec('ALTER TABLE venues ADD COLUMN racing_jurisdiction TEXT');
  }
  if (!venueCols.includes('org_id')) {
    db.exec('ALTER TABLE venues ADD COLUMN org_id TEXT');
  }
  // Any venue without a business (pre-multi-tenant data) gets a default org
  // so it stays visible and assignable after the upgrade.
  const orphan = db.prepare('SELECT COUNT(*) AS n FROM venues WHERE org_id IS NULL').get();
  if (orphan.n > 0) {
    let org = db.prepare("SELECT id FROM orgs WHERE name = 'Default Business'").get();
    if (!org) {
      org = { id: id() };
      db.prepare('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)')
        .run(org.id, 'Default Business', now());
    }
    db.prepare('UPDATE venues SET org_id = ? WHERE org_id IS NULL').run(org.id);
  }
}

function get(sql, ...params) { return open().prepare(sql).get(...params); }
function all(sql, ...params) { return open().prepare(sql).all(...params); }
function run(sql, ...params) { return open().prepare(sql).run(...params); }

function logEvent(type, { venueId = null, screenId = null, detail = '', actor = null } = {}) {
  run('INSERT INTO events (venue_id, screen_id, type, detail, actor, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    venueId, screenId, type, String(detail), actor, now());
}

function getSetting(key, fallback = null) {
  const row = get('SELECT value FROM settings WHERE key = ?', key);
  return row ? row.value : fallback;
}

function setSetting(key, value) {
  run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    key, String(value));
}

function isEmpty() {
  return !get('SELECT id FROM venues LIMIT 1');
}

module.exports = { open, get, all, run, id, now, logEvent, getSetting, setSetting, isEmpty, DATA_DIR };
