'use strict';

// Wheel Spin + Members Badge Draw engines. Same shape as CashKing: one
// active game per venue per type, a live flag that takes over the venue's
// screens, crypto randomness for anything with a prize on it.

const crypto = require('node:crypto');
const db = require('./db');
const { HttpError } = require('./util');

const parse = (s, fallback) => { try { return JSON.parse(s); } catch { return fallback; } };

// ---- Wheel Spin -------------------------------------------------------------

function createWheel(venueId, opts = {}) {
  const wedges = (Array.isArray(opts.wedges) ? opts.wedges : [])
    .map((w) => ({ label: String(w.label || '').trim().slice(0, 40), weight: Math.max(0, Number(w.weight) || 1) }))
    .filter((w) => w.label);
  if (wedges.length < 2 || wedges.length > 24) throw new HttpError(400, 'wheel needs 2-24 wedges');
  if (!wedges.some((w) => w.weight > 0)) throw new HttpError(400, 'at least one wedge needs a weight above 0');
  const wheelId = db.id();
  db.run('INSERT INTO wheels (id, venue_id, name, wedges, created_at) VALUES (?, ?, ?, ?, ?)',
    wheelId, venueId, String(opts.name || 'Wheel Spin').slice(0, 60), JSON.stringify(wedges), db.now());
  return db.get('SELECT * FROM wheels WHERE id = ?', wheelId);
}

// Weighted pick — weights set the odds; the wheel just draws them equal-sized.
function spinWheel(wheel) {
  if (wheel.status !== 'active') throw new HttpError(409, 'wheel is archived');
  const wedges = parse(wheel.wedges, []);
  const total = wedges.reduce((n, w) => n + w.weight, 0);
  let roll = crypto.randomInt(Math.max(1, Math.round(total * 1000)));
  let index = 0;
  for (let i = 0; i < wedges.length; i++) {
    roll -= Math.round(wedges[i].weight * 1000);
    if (roll < 0) { index = i; break; }
  }
  const spin = { index, label: wedges[index].label, at: db.now() };
  db.run('UPDATE wheels SET last_spin = ? WHERE id = ?', JSON.stringify(spin), wheel.id);
  return spin;
}

function wheelView(wheel) {
  return {
    id: wheel.id,
    name: wheel.name,
    status: wheel.status,
    live: !!wheel.live,
    wedges: parse(wheel.wedges, []).map((w) => ({ label: w.label })), // odds stay server-side
    last_spin: parse(wheel.last_spin, null),
  };
}

function currentWheel(venueId) {
  return db.get("SELECT * FROM wheels WHERE venue_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 1", venueId) || null;
}

// ---- Members Badge Draw ---------------------------------------------------------

// "1234 Karen M." or "1234, Karen M." — one member per line.
function parseMembers(text) {
  return String(text || '').split('\n')
    .map((line) => line.trim().replace(/^(\S+)[,\s]+/, '$1\t'))
    .filter(Boolean)
    .map((line) => {
      const [number, ...rest] = line.split('\t');
      return { number: number.replace(/,$/, ''), name: rest.join(' ').trim() };
    })
    .filter((m) => m.number);
}

function createBadgeDraw(venueId, opts = {}) {
  const members = Array.isArray(opts.members) ? opts.members : parseMembers(opts.members_text);
  if (!members.length) throw new HttpError(400, 'paste at least one member (one per line: number then name)');
  if (members.length > 100000) throw new HttpError(400, 'member list too large');
  const start = Number(opts.prize_start);
  const increment = Number(opts.increment);
  if (!Number.isFinite(start) || start < 0) throw new HttpError(400, 'prize_start must be a number');
  if (!Number.isFinite(increment) || increment < 0) throw new HttpError(400, 'increment must be a number');
  const claimMinutes = Math.min(60, Math.max(1, parseInt(opts.claim_minutes, 10) || 3));
  const drawId = db.id();
  db.run(
    `INSERT INTO badge_draws (id, venue_id, name, prize_start, increment, prize_current, claim_minutes, members, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    drawId, venueId, String(opts.name || 'Members Badge Draw').slice(0, 60),
    start, increment, start, claimMinutes, JSON.stringify(members), db.now());
  return db.get('SELECT * FROM badge_draws WHERE id = ?', drawId);
}

function drawMember(badge) {
  if (badge.status !== 'active') throw new HttpError(409, 'badge draw is archived');
  const current = parse(badge.current, null);
  if (current && current.outcome === 'pending') {
    throw new HttpError(409, 'a member is already on screen — record claimed or no-show first');
  }
  const members = parse(badge.members, []);
  if (!members.length) throw new HttpError(409, 'no members loaded');
  const member = members[crypto.randomInt(members.length)];
  const drawnAt = Date.now();
  const next = {
    number: member.number, name: member.name,
    drawn_at: new Date(drawnAt).toISOString(),
    deadline: new Date(drawnAt + badge.claim_minutes * 60000).toISOString(),
    outcome: 'pending',
  };
  db.run('UPDATE badge_draws SET current = ? WHERE id = ?', JSON.stringify(next), badge.id);
  return next;
}

// claimed -> winner takes prize_current, pot resets to base.
// unclaimed -> pot jackpots by the increment for next time.
function resolveBadge(badge, claimed) {
  const current = parse(badge.current, null);
  if (!current || current.outcome !== 'pending') throw new HttpError(409, 'no draw waiting on an outcome');
  const outcome = claimed ? 'claimed' : 'unclaimed';
  const history = parse(badge.history, []);
  history.unshift({ number: current.number, name: current.name, outcome, prize: badge.prize_current, at: db.now() });
  const newPrize = claimed ? badge.prize_start : badge.prize_current + badge.increment;
  db.run('UPDATE badge_draws SET current = ?, history = ?, prize_current = ? WHERE id = ?',
    JSON.stringify({ ...current, outcome, prize: badge.prize_current }),
    JSON.stringify(history.slice(0, 20)), newPrize, badge.id);
  return db.get('SELECT * FROM badge_draws WHERE id = ?', badge.id);
}

function badgeView(badge) {
  return {
    id: badge.id,
    name: badge.name,
    status: badge.status,
    live: !!badge.live,
    prize: badge.prize_current,
    prize_start: badge.prize_start,
    increment: badge.increment,
    claim_minutes: badge.claim_minutes,
    members_count: parse(badge.members, []).length,
    current: parse(badge.current, null),
    history: parse(badge.history, []).slice(0, 5),
  };
}

function currentBadge(venueId) {
  return db.get("SELECT * FROM badge_draws WHERE venue_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 1", venueId) || null;
}

module.exports = {
  createWheel, spinWheel, wheelView, currentWheel,
  createBadgeDraw, drawMember, resolveBadge, badgeView, currentBadge, parseMembers,
};
