'use strict';

// Multi-tenant auth. Businesses (orgs) own venues and users; a user belongs
// to exactly one org with a role, while Korvix superadmins (org_id NULL) see
// every tenant. Sessions are opaque bearer tokens (only their SHA-256 lands
// in the DB). The legacy KORVIX_ADMIN_TOKEN env var still authenticates as a
// virtual superadmin so scripted API automation keeps working.
//
// Roles: superadmin > admin (manage own business: users, venues, staff links)
//        > editor (run the venue: content, playlists, schedules, draws,
//        emergencies, uploads) > viewer (read-only + reports).

const crypto = require('node:crypto');
const db = require('./db');
const { HttpError } = require('./util');

const SESSION_DAYS = 30;
const LEGACY_TOKEN = process.env.KORVIX_ADMIN_TOKEN || '';

const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, superadmin: 4 };
const ORG_ROLES = new Set(['admin', 'editor', 'viewer']);

// ---- passwords -----------------------------------------------------------

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(password), salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const candidate = crypto.scryptSync(String(password), salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// ---- sessions --------------------------------------------------------------

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 86400 * 1000).toISOString();
  db.run('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
    sha256(token), userId, db.now(), expires);
  return token;
}

function destroySession(token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

function cleanupSessions() {
  db.run('DELETE FROM sessions WHERE expires_at < ?', db.now());
}

function userForToken(token) {
  if (!token) return null;
  if (LEGACY_TOKEN && token.length === LEGACY_TOKEN.length
    && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(LEGACY_TOKEN))) {
    return { id: '_legacy', org_id: null, email: '', name: 'API token', role: 'superadmin' };
  }
  const session = db.get(
    'SELECT * FROM sessions WHERE token_hash = ? AND expires_at > ?', sha256(token), db.now());
  if (!session) return null;
  const user = db.get('SELECT id, org_id, email, name, role FROM users WHERE id = ?', session.user_id);
  return user || null;
}

function bearerToken(req, url) {
  const header = req.headers.authorization || '';
  if (header.startsWith('Bearer ')) return header.slice(7);
  if (header) return header;
  // Browser downloads (<a href>) can't set headers.
  return url ? url.searchParams.get('token') || '' : '';
}

function resolveUser(req, url) {
  return userForToken(bearerToken(req, url));
}

// ---- authorization ------------------------------------------------------------

function requireRole(user, minRole) {
  if (!user || (ROLE_RANK[user.role] || 0) < ROLE_RANK[minRole]) {
    throw new HttpError(403, `requires ${minRole} access`);
  }
}

// Throws 404 for venues outside the user's business (not 403 — don't leak
// which venue ids exist across tenants).
function assertVenue(user, venueId, minRole = 'editor') {
  const venue = db.get('SELECT * FROM venues WHERE id = ?', venueId);
  if (!venue) throw new HttpError(404, 'venue not found');
  if (user.role !== 'superadmin' && venue.org_id !== user.org_id) {
    throw new HttpError(404, 'venue not found');
  }
  requireRole(user, minRole);
  return venue;
}

// Venue ids visible to this user (superadmin: all).
function visibleVenueIds(user) {
  const rows = user.role === 'superadmin'
    ? db.all('SELECT id FROM venues')
    : db.all('SELECT id FROM venues WHERE org_id = ?', user.org_id ?? '');
  return rows.map((r) => r.id);
}

module.exports = {
  hashPassword, verifyPassword,
  createSession, destroySession, cleanupSessions, resolveUser, bearerToken,
  requireRole, assertVenue, visibleVenueIds,
  ROLE_RANK, ORG_ROLES, SESSION_DAYS,
};
