'use strict';

// Resolves what a screen should be showing right now:
//   1. An active emergency for the screen's venue (or a global one) overrides everything.
//   2. Otherwise the best matching schedule wins. Specificity: screen > zone > venue-wide,
//      then higher priority, then later start time (so "happy hour 15:00" beats the
//      all-day loop it overlaps).
//   3. No match -> the player shows its standby card.

const db = require('./db');
const cashking = require('./cardgame');
const games = require('./games');

// Venue-local weekday (0=Sun..6=Sat), minutes since midnight, and the local
// calendar date (plus yesterday's, for windows that wrap past midnight).
function venueClock(timezone, date = new Date()) {
  const opts = {
    weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  };
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, ...opts }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).formatToParts(date);
  }
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  const minutes = (parseInt(get('hour'), 10) % 24) * 60 + parseInt(get('minute'), 10);
  const localDate = `${get('year')}-${get('month')}-${get('day')}`;
  const prevMs = Date.UTC(+get('year'), +get('month') - 1, +get('day')) - 86400000;
  const prev = new Date(prevMs);
  const prevDate = `${prev.getUTCFullYear()}-${String(prev.getUTCMonth() + 1).padStart(2, '0')}-${String(prev.getUTCDate()).padStart(2, '0')}`;
  return { day: dayIndex, minutes, date: localDate, prevDate };
}

function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map((n) => parseInt(n, 10) || 0);
  return h * 60 + m;
}

// True when `minutes` falls inside [start, end); end<=start wraps past midnight.
function inWindow(minutes, startTime, endTime) {
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (end === start) return true; // treat zero-length as all-day
  if (end > start) return minutes >= start && minutes < end;
  return minutes >= start || minutes < end;
}

function matchDay(daysJson, day, minutes, startTime, endTime) {
  let days;
  try { days = JSON.parse(daysJson); } catch { days = [0, 1, 2, 3, 4, 5, 6]; }
  if (!Array.isArray(days) || !days.length) days = [0, 1, 2, 3, 4, 5, 6];
  if (days.includes(day)) return inWindow(minutes, startTime, endTime) && minutes >= 0;
  // A wrapping window (e.g. Fri 21:00-02:00) still applies in the small hours
  // of the following day.
  const prev = (day + 6) % 7;
  const start = toMinutes(startTime);
  const end = toMinutes(endTime);
  if (days.includes(prev) && end <= start && minutes < end) return true;
  return false;
}

function specificity(schedule) {
  if (schedule.screen_id) return 2;
  if (schedule.zone_id) return 1;
  return 0;
}

// Calendar bounds + weekly pattern + time window, wrap-aware: the small hours
// of a midnight-wrapping window belong to YESTERDAY's date and weekday.
function matchesSchedule(schedule, clock) {
  let days;
  try { days = JSON.parse(schedule.days_of_week); } catch { days = [0, 1, 2, 3, 4, 5, 6]; }
  if (!Array.isArray(days) || !days.length) days = [0, 1, 2, 3, 4, 5, 6];
  const inDates = (d) => (!schedule.start_date || d >= schedule.start_date)
    && (!schedule.end_date || d <= schedule.end_date);

  const start = toMinutes(schedule.start_time);
  const end = toMinutes(schedule.end_time);
  const wraps = end < start;
  if (!wraps) { // plain window (end===start counts as all-day via inWindow)
    return days.includes(clock.day)
      && inWindow(clock.minutes, schedule.start_time, schedule.end_time)
      && inDates(clock.date);
  }
  if (clock.minutes >= start) return days.includes(clock.day) && inDates(clock.date);
  if (clock.minutes < end) return days.includes((clock.day + 6) % 7) && inDates(clock.prevDate);
  return false;
}

function activeEmergency(venueId) {
  return db.get(
    `SELECT * FROM emergencies
     WHERE active = 1 AND (venue_id IS NULL OR venue_id = ?)
     ORDER BY created_at DESC LIMIT 1`,
    venueId,
  ) || null;
}

// Latest live draw targeting this screen (venue-wide, or its zone).
function activeDraw(screen) {
  return db.get(
    `SELECT * FROM draws
     WHERE venue_id = ? AND status = 'live'
       AND (zone_id IS NULL OR zone_id = ?)
     ORDER BY drawn_at DESC LIMIT 1`,
    screen.venue_id, screen.zone_id ?? '',
  ) || null;
}

function resolveSchedule(screen, date = new Date()) {
  const venue = db.get('SELECT * FROM venues WHERE id = ?', screen.venue_id);
  if (!venue) return null;
  const clock = venueClock(venue.timezone, date);

  const candidates = db.all(
    `SELECT * FROM schedules
     WHERE venue_id = ? AND active = 1
       AND (screen_id IS NULL OR screen_id = ?)
       AND (zone_id IS NULL OR zone_id = ?)`,
    screen.venue_id, screen.id, screen.zone_id ?? '',
  ).filter((s) => matchesSchedule(s, clock));

  if (!candidates.length) return null;
  const dated = (s) => (s.start_date || s.end_date) ? 1 : 0;
  candidates.sort((a, b) =>
    specificity(b) - specificity(a)
    || dated(b) - dated(a) // a calendar event outranks the everyday loop
    || b.priority - a.priority
    || toMinutes(b.start_time) - toMinutes(a.start_time));
  return candidates[0];
}

function playlistItems(playlistId) {
  return db.all(
    `SELECT pi.id AS item_id, pi.duration_override, m.*
     FROM playlist_items pi JOIN media m ON m.id = pi.media_id
     WHERE pi.playlist_id = ?
     ORDER BY pi.position, pi.id`,
    playlistId,
  ).map((row) => ({
    id: row.item_id,
    media_id: row.id,
    name: row.name,
    type: row.type,
    src: row.src,
    content: row.content,
    fit: row.fit || 'cover',
    duration: row.duration_override ?? row.duration_seconds,
  }));
}

// Dedicated channels: the screen skips schedules and permanently shows one
// live widget (racing next-to-go boards, results, sports fixtures).
const CHANNELS = {
  racing1: { widget: 'racing:1', name: 'Racing — Next To Go' },
  racing2: { widget: 'racing:2', name: 'Racing — 2nd Race' },
  racing3: { widget: 'racing:3', name: 'Racing — 3rd Race' },
  'racing-results': { widget: 'racing:results', name: 'Racing — Results' },
  sports: { widget: 'sports', name: 'Sports — Live & Upcoming' },
};

function channelPlaylist(channel) {
  const def = CHANNELS[channel];
  if (!def) return null;
  return {
    id: `channel:${channel}`,
    name: def.name,
    items: [{
      id: `channel:${channel}`, media_id: `channel:${channel}`, name: def.name,
      type: 'widget', src: def.widget, content: '', fit: 'cover', duration: 30,
    }],
  };
}

// The full document a player needs to run autonomously until the next nudge.
function buildManifest(screen) {
  const venue = db.get('SELECT * FROM venues WHERE id = ?', screen.venue_id);
  const zone = screen.zone_id ? db.get('SELECT * FROM zones WHERE id = ?', screen.zone_id) : null;
  const emergency = activeEmergency(screen.venue_id);
  const draw = activeDraw(screen);
  const game = cashking.currentGame(screen.venue_id);
  const dedicated = channelPlaylist(screen.channel);
  const schedule = dedicated ? null : resolveSchedule(screen);
  const playlist = schedule
    ? db.get('SELECT * FROM playlists WHERE id = ?', schedule.playlist_id)
    : null;

  const feeds = {};
  for (const f of db.all('SELECT * FROM feeds WHERE venue_id = ?', screen.venue_id)) {
    try { feeds[f.source] = { ...JSON.parse(f.payload), _updated_at: f.updated_at }; }
    catch { feeds[f.source] = { _updated_at: f.updated_at }; }
  }

  return {
    generated_at: db.now(),
    refresh_seconds: 60,
    screen: {
      id: screen.id,
      name: screen.name,
      orientation: screen.orientation,
      rotation: screen.rotation || 0,
      channel: screen.channel || 'main',
    },
    venue: { id: venue.id, name: venue.name, timezone: venue.timezone },
    zone: zone ? { id: zone.id, name: zone.name } : null,
    emergency: emergency && {
      id: emergency.id,
      level: emergency.level,
      title: emergency.title,
      message: emergency.message,
    },
    // Live board takes over every venue screen; the promo view feeds the
    // 'cashking' playlist widget between game nights.
    card_game: game && game.live ? cashking.boardView(game) : null,
    wheel: (() => { const w = games.currentWheel(screen.venue_id); return w && w.live ? games.wheelView(w) : null; })(),
    badge_draw: (() => { const b = games.currentBadge(screen.venue_id); return b && b.live ? games.badgeView(b) : null; })(),
    card_game_promo: game ? cashking.promoView(game, venue.name) : null,
    draw: draw && (() => {
      let numbers = [];
      try { numbers = JSON.parse(draw.drawn_numbers); } catch { /* ignore */ }
      return {
        id: draw.id,
        name: draw.name,
        number: numbers[numbers.length - 1] ?? null,
        previous_numbers: numbers.slice(0, -1),
        range_start: draw.range_start,
        range_end: draw.range_end,
        drawn_at: draw.drawn_at,
      };
    })(),
    schedule: schedule && { id: schedule.id, name: schedule.name, ends: schedule.end_time },
    playlist: dedicated || (playlist && {
      id: playlist.id,
      name: playlist.name,
      items: playlistItems(playlist.id),
    }),
    feeds,
  };
}

module.exports = { venueClock, inWindow, matchDay, matchesSchedule, resolveSchedule, buildManifest, activeEmergency, activeDraw, playlistItems };
