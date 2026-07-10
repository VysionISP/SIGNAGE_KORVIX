'use strict';

// Menu board designer API. A menu is sections of items (name, description,
// price, sold_out); the player renders it as a polished board via the
// 'menuboard:<id>' widget. Creating a menu auto-creates that widget as a
// media item so it appears in the Content gallery ready to tick onto
// playlists; deleting the menu removes the widget with it. Every save nudges
// the venue, so marking something sold out updates the boards immediately.

const db = require('../db');
const auth = require('../auth');
const { sendJson, readJson, HttpError, required } = require('../util');
const { nudgeVenue } = require('./admin');

const routes = [];
function route(method, pattern, handler) { routes.push({ method, pattern, handler }); }

const THEMES = new Set(['classic', 'chalkboard', 'modern', 'pub']);

function cleanSections(raw) {
  if (!Array.isArray(raw)) throw new HttpError(400, 'sections must be an array');
  if (raw.length > 30) throw new HttpError(400, 'too many sections');
  return raw.map((section) => ({
    title: String(section.title || '').slice(0, 60),
    items: (Array.isArray(section.items) ? section.items : []).slice(0, 60).map((item) => ({
      name: String(item.name || '').slice(0, 80),
      desc: String(item.desc || '').slice(0, 160),
      price: item.price === '' || item.price === null || item.price === undefined
        ? null : (Number.isFinite(Number(item.price)) ? Number(item.price) : null),
      sold_out: !!item.sold_out,
      photo: item.photo ? String(item.photo).slice(0, 300) : null,
    })).filter((item) => item.name),
  })).filter((section) => section.title || section.items.length);
}

function cleanTheme(theme) {
  return THEMES.has(theme) ? theme : 'classic';
}

function menuView(menu) {
  let sections;
  try { sections = JSON.parse(menu.sections); } catch { sections = []; }
  return { id: menu.id, name: menu.name, theme: menu.theme || 'classic', sections, updated_at: menu.updated_at };
}

route('GET', '/api/venues/:venueId/menus', (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'viewer');
  const menus = db.all('SELECT * FROM menus WHERE venue_id = ? ORDER BY name', params.venueId);
  sendJson(res, 200, { menus: menus.map(menuView) });
});

route('POST', '/api/venues/:venueId/menus', async (req, res, params) => {
  auth.assertVenue(req.user, params.venueId, 'editor');
  const body = await readJson(req);
  required(body, 'name');
  const sections = cleanSections(body.sections || [{ title: 'Mains', items: [] }]);
  const menuId = db.id();
  db.run('INSERT INTO menus (id, venue_id, name, theme, sections, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    menuId, params.venueId, String(body.name).slice(0, 60), cleanTheme(body.theme), JSON.stringify(sections), db.now(), db.now());
  // The board is instantly usable: it shows up in the Content gallery.
  db.run(
    'INSERT INTO media (id, venue_id, name, type, src, content, duration_seconds, fit, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    db.id(), params.venueId, `${body.name} board`, 'widget', `menuboard:${menuId}`, '', 20, 'cover', db.now());
  nudgeVenue(params.venueId);
  sendJson(res, 201, menuView(db.get('SELECT * FROM menus WHERE id = ?', menuId)));
});

route('PATCH', '/api/menus/:id', async (req, res, params) => {
  const menu = db.get('SELECT * FROM menus WHERE id = ?', params.id);
  if (!menu) throw new HttpError(404, 'menu not found');
  auth.assertVenue(req.user, menu.venue_id, 'editor');
  const body = await readJson(req);
  const sections = body.sections !== undefined ? JSON.stringify(cleanSections(body.sections)) : menu.sections;
  db.run('UPDATE menus SET name = ?, theme = ?, sections = ?, updated_at = ? WHERE id = ?',
    body.name !== undefined ? String(body.name).slice(0, 60) : menu.name,
    body.theme !== undefined ? cleanTheme(body.theme) : (menu.theme || 'classic'),
    sections, db.now(), menu.id);
  nudgeVenue(menu.venue_id);
  sendJson(res, 200, menuView(db.get('SELECT * FROM menus WHERE id = ?', menu.id)));
});

route('DELETE', '/api/menus/:id', (req, res, params) => {
  const menu = db.get('SELECT * FROM menus WHERE id = ?', params.id);
  if (!menu) throw new HttpError(404, 'menu not found');
  auth.assertVenue(req.user, menu.venue_id, 'editor');
  db.run('DELETE FROM menus WHERE id = ?', menu.id);
  db.run("DELETE FROM media WHERE venue_id = ? AND type = 'widget' AND src = ?",
    menu.venue_id, `menuboard:${menu.id}`);
  nudgeVenue(menu.venue_id);
  sendJson(res, 200, { ok: true });
});

module.exports = { routes };
