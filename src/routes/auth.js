'use strict';

// Authentication + tenant management API.
//   /api/auth/*  — first-run setup, login/logout, current user
//   /api/orgs    — businesses (superadmin manages; org admins see their own)
//   /api/users   — logins within a business (org admins manage their editors)

const crypto = require('node:crypto');
const db = require('../db');
const auth = require('../auth');
const mailer = require('../mailer');
const { sendJson, readJson, HttpError, required } = require('../util');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// Who to blame in the audit trail ('API token' for the legacy env key).
const actorOf = (req) => req.user?.email || req.user?.name || null;

// Public URL of this install, for links in emails. Prefer the reverse-proxy
// headers Caddy sets; fall back to the Host header for direct access.
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || 'http';
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost').split(',')[0].trim();
  return `${proto}://${host}`;
}

function publicUser(u, orgName) {
  return {
    id: u.id, org_id: u.org_id, email: u.email, name: u.name, role: u.role,
    org_name: orgName ?? u.org_name ?? null,
    created_at: u.created_at, last_login_at: u.last_login_at,
  };
}

// ---- session lifecycle (no auth required) ----------------------------------

// Does the install need first-run setup?
route('GET', '/api/auth/state', (req, res) => {
  const hasUsers = !!db.get('SELECT id FROM users LIMIT 1');
  sendJson(res, 200, {
    needs_setup: !hasUsers,
    brand: mailer.BRAND,
    email_configured: mailer.configured(),
  });
});

// First-run only: create the Korvix superadmin.
route('POST', '/api/auth/setup', async (req, res) => {
  if (db.get('SELECT id FROM users LIMIT 1')) {
    throw new HttpError(409, 'setup already completed — log in instead');
  }
  const body = await readJson(req);
  required(body, 'email', 'password');
  if (String(body.password).length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  const userId = db.id();
  db.run('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, NULL, ?, ?, ?, ?, ?)',
    userId, String(body.email).trim(), body.name || 'Korvix Admin',
    auth.hashPassword(body.password), 'superadmin', db.now());
  db.logEvent('auth.setup', { detail: body.email, actor: String(body.email).trim() });
  const token = auth.createSession(userId);
  sendJson(res, 201, { token, user: publicUser(db.get('SELECT * FROM users WHERE id = ?', userId)) });
});

route('POST', '/api/auth/login', async (req, res) => {
  const body = await readJson(req);
  required(body, 'email', 'password');
  const user = db.get('SELECT * FROM users WHERE email = ?', String(body.email).trim());
  if (!user || !auth.verifyPassword(body.password, user.password_hash)) {
    throw new HttpError(401, 'wrong email or password');
  }
  db.run('UPDATE users SET last_login_at = ? WHERE id = ?', db.now(), user.id);
  db.logEvent('auth.login', { detail: user.email, actor: user.email });
  const token = auth.createSession(user.id);
  const org = user.org_id ? db.get('SELECT name FROM orgs WHERE id = ?', user.org_id) : null;
  sendJson(res, 200, { token, user: publicUser(user, org?.name) });
});

// ---- password reset (no auth required) ---------------------------------------

// Ask for a reset link. Always answers with a generic OK so the endpoint can't
// be used to probe which emails have accounts.
route('POST', '/api/auth/forgot', async (req, res) => {
  const body = await readJson(req);
  required(body, 'email');
  if (!mailer.configured()) {
    throw new HttpError(503, 'email is not set up on this server yet — ask your administrator to reset your password from the Users page');
  }
  const user = db.get('SELECT * FROM users WHERE email = ?', String(body.email).trim());
  if (user) {
    const token = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    db.run('DELETE FROM password_resets WHERE user_id = ?', user.id);
    db.run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      sha256(token), user.id, db.now(), expires);
    const link = `${baseUrl(req)}/admin/?reset=${token}`;
    mailer.sendMail({
      to: user.email,
      subject: `Reset your ${mailer.BRAND} password`,
      html: mailer.template('Reset your password',
        `<p>Someone (hopefully you) asked to reset the password for <b>${user.email}</b>.</p>`
        + mailer.button(link, 'Choose a new password')
        + '<p>This link works for 1 hour.</p>'),
    });
    db.logEvent('auth.reset_requested', { detail: user.email, actor: user.email });
  }
  sendJson(res, 200, { ok: true, message: 'if that email has an account, a reset link is on its way' });
});

// Complete the reset with the emailed token.
route('POST', '/api/auth/reset', async (req, res) => {
  const body = await readJson(req);
  required(body, 'token', 'password');
  if (String(body.password).length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  const row = db.get('SELECT * FROM password_resets WHERE token_hash = ?', sha256(String(body.token)));
  if (!row || row.expires_at < db.now()) {
    throw new HttpError(400, 'that reset link is invalid or has expired — request a new one');
  }
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(body.password), row.user_id);
  db.run('DELETE FROM password_resets WHERE user_id = ?', row.user_id);
  db.run('DELETE FROM sessions WHERE user_id = ?', row.user_id); // sign out everywhere
  const user = db.get('SELECT * FROM users WHERE id = ?', row.user_id);
  db.logEvent('auth.reset_done', { detail: user?.email || row.user_id, actor: user?.email || null });
  sendJson(res, 200, { ok: true });
});

// ---- authenticated endpoints -------------------------------------------------

route('POST', '/api/auth/logout', (req, res) => {
  auth.destroySession(auth.bearerToken(req));
  sendJson(res, 200, { ok: true });
});

route('GET', '/api/auth/me', (req, res) => {
  const user = req.user;
  const org = user.org_id ? db.get('SELECT name FROM orgs WHERE id = ?', user.org_id) : null;
  sendJson(res, 200, { user: publicUser(user, org?.name) });
});

route('POST', '/api/auth/password', async (req, res) => {
  const body = await readJson(req);
  required(body, 'current_password', 'new_password');
  if (req.user.id === '_legacy') throw new HttpError(400, 'API token has no password');
  const user = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
  if (!auth.verifyPassword(body.current_password, user.password_hash)) {
    throw new HttpError(401, 'current password is wrong');
  }
  if (String(body.new_password).length < 8) throw new HttpError(400, 'password must be at least 8 characters');
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', auth.hashPassword(body.new_password), user.id);
  sendJson(res, 200, { ok: true });
});

// ---- businesses (orgs) ---------------------------------------------------------

route('GET', '/api/orgs', (req, res) => {
  const rows = req.user.role === 'superadmin'
    ? db.all('SELECT * FROM orgs ORDER BY name')
    : db.all('SELECT * FROM orgs WHERE id = ? ORDER BY name', req.user.org_id ?? '');
  sendJson(res, 200, {
    orgs: rows.map((o) => ({
      ...o,
      venues: db.get('SELECT COUNT(*) AS n FROM venues WHERE org_id = ?', o.id).n,
      users: db.get('SELECT COUNT(*) AS n FROM users WHERE org_id = ?', o.id).n,
    })),
  });
});

route('POST', '/api/orgs', async (req, res) => {
  auth.requireRole(req.user, 'superadmin');
  const body = await readJson(req);
  required(body, 'name');
  const orgId = db.id();
  db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)', orgId, body.name, db.now());
  db.logEvent('org.created', { detail: body.name, actor: actorOf(req) });
  sendJson(res, 201, db.get('SELECT * FROM orgs WHERE id = ?', orgId));
});

route('PATCH', '/api/orgs/:id', async (req, res, params) => {
  const org = db.get('SELECT * FROM orgs WHERE id = ?', params.id);
  if (!org) throw new HttpError(404, 'business not found');
  if (req.user.role !== 'superadmin') {
    if (req.user.org_id !== org.id) throw new HttpError(404, 'business not found');
    auth.requireRole(req.user, 'admin');
  }
  const body = await readJson(req);
  const alertEmail = body.alert_email === undefined ? org.alert_email
    : (String(body.alert_email).trim() || null);
  db.run('UPDATE orgs SET name = ?, alert_email = ? WHERE id = ?',
    body.name ?? org.name, alertEmail, org.id);
  sendJson(res, 200, db.get('SELECT * FROM orgs WHERE id = ?', org.id));
});

route('DELETE', '/api/orgs/:id', (req, res, params) => {
  auth.requireRole(req.user, 'superadmin');
  const venues = db.get('SELECT COUNT(*) AS n FROM venues WHERE org_id = ?', params.id).n;
  if (venues) throw new HttpError(409, `business still has ${venues} venue(s) — delete or reassign them first`);
  db.run('DELETE FROM orgs WHERE id = ?', params.id);
  sendJson(res, 200, { ok: true });
});

// ---- users ------------------------------------------------------------------------

function canManage(actor, target) {
  if (actor.role === 'superadmin') return true;
  return actor.role === 'admin' && target.org_id === actor.org_id && target.role !== 'superadmin';
}

route('GET', '/api/users', (req, res) => {
  auth.requireRole(req.user, 'admin');
  const rows = req.user.role === 'superadmin'
    ? db.all('SELECT u.*, o.name AS org_name FROM users u LEFT JOIN orgs o ON o.id = u.org_id ORDER BY o.name, u.email')
    : db.all('SELECT u.*, o.name AS org_name FROM users u JOIN orgs o ON o.id = u.org_id WHERE u.org_id = ? ORDER BY u.email', req.user.org_id);
  sendJson(res, 200, { users: rows.map((u) => publicUser(u)) });
});

route('POST', '/api/users', async (req, res) => {
  auth.requireRole(req.user, 'admin');
  const body = await readJson(req);
  required(body, 'email', 'password', 'role');
  if (String(body.password).length < 8) throw new HttpError(400, 'password must be at least 8 characters');

  let orgId, role;
  if (req.user.role === 'superadmin') {
    role = body.role === 'superadmin' ? 'superadmin' : (auth.ORG_ROLES.has(body.role) ? body.role : null);
    if (!role) throw new HttpError(400, 'role must be superadmin, admin, editor or viewer');
    orgId = role === 'superadmin' ? null : body.org_id;
    if (role !== 'superadmin' && !db.get('SELECT id FROM orgs WHERE id = ?', orgId ?? '')) {
      throw new HttpError(400, 'org_id required for business users');
    }
  } else {
    if (!auth.ORG_ROLES.has(body.role)) throw new HttpError(400, 'role must be admin, editor or viewer');
    role = body.role;
    orgId = req.user.org_id;
  }
  if (db.get('SELECT id FROM users WHERE email = ?', String(body.email).trim())) {
    throw new HttpError(409, 'a user with that email already exists');
  }
  const userId = db.id();
  db.run('INSERT INTO users (id, org_id, email, name, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    userId, orgId, String(body.email).trim(), body.name || '', auth.hashPassword(body.password), role, db.now());
  db.logEvent('user.created', { detail: `${body.email} (${role})`, actor: actorOf(req) });

  // Welcome email (fire-and-forget; a no-op until SMTP is configured).
  const orgName = orgId ? db.get('SELECT name FROM orgs WHERE id = ?', orgId)?.name : null;
  mailer.sendMail({
    to: String(body.email).trim(),
    subject: `You've been added to ${mailer.BRAND}`,
    html: mailer.template(`Welcome to ${mailer.BRAND}`,
      `<p>${actorOf(req) || 'An administrator'} added you${orgName ? ` to <b>${orgName}</b>` : ''} as ${role === 'admin' ? 'an' : 'a'} <b>${role}</b>.</p>`
      + `<p>Sign in with this email address and the password they gave you — then change it from the account menu.</p>`
      + mailer.button(`${baseUrl(req)}/admin/`, 'Open the dashboard')),
  });
  sendJson(res, 201, publicUser(db.get('SELECT * FROM users WHERE id = ?', userId)));
});

route('PATCH', '/api/users/:id', async (req, res, params) => {
  const target = db.get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) throw new HttpError(404, 'user not found');
  if (!canManage(req.user, target)) throw new HttpError(404, 'user not found');
  const body = await readJson(req);

  let role = target.role;
  if (body.role && body.role !== target.role) {
    if (req.user.role === 'superadmin') {
      role = body.role;
      if (target.role === 'superadmin' && role !== 'superadmin'
        && db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").n <= 1) {
        throw new HttpError(409, 'cannot demote the last superadmin');
      }
    } else {
      if (!auth.ORG_ROLES.has(body.role)) throw new HttpError(400, 'invalid role');
      role = body.role;
    }
  }
  const passwordHash = body.password
    ? (String(body.password).length >= 8 ? auth.hashPassword(body.password)
      : (() => { throw new HttpError(400, 'password must be at least 8 characters'); })())
    : target.password_hash;

  db.run('UPDATE users SET name = ?, role = ?, password_hash = ? WHERE id = ?',
    body.name ?? target.name, role, passwordHash, target.id);
  if (body.password) db.run('DELETE FROM sessions WHERE user_id = ?', target.id);
  sendJson(res, 200, publicUser(db.get('SELECT * FROM users WHERE id = ?', target.id)));
});

route('DELETE', '/api/users/:id', (req, res, params) => {
  const target = db.get('SELECT * FROM users WHERE id = ?', params.id);
  if (!target) throw new HttpError(404, 'user not found');
  if (!canManage(req.user, target)) throw new HttpError(404, 'user not found');
  if (target.id === req.user.id) throw new HttpError(400, 'you cannot delete your own account');
  if (target.role === 'superadmin'
    && db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'superadmin'").n <= 1) {
    throw new HttpError(409, 'cannot delete the last superadmin');
  }
  db.run('DELETE FROM users WHERE id = ?', target.id);
  db.logEvent('user.deleted', { detail: target.email, actor: actorOf(req) });
  sendJson(res, 200, { ok: true });
});

module.exports = { routes };
