'use strict';

// End-to-end smoke test: boots the real server on a random port with a
// throwaway database and walks the full lifecycle — venue -> zone -> screen ->
// player pairing -> content -> playlist -> schedule -> manifest -> heartbeat ->
// emergency -> integration feed.

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'korvix-test-'));
process.env.KORVIX_DATA_DIR = tmp;
process.env.KORVIX_DB = path.join(tmp, 'test.db');
process.env.KORVIX_NO_DEMO = '1';
process.env.KORVIX_ADMIN_TOKEN = 'legacy-api-token-for-tests';
process.env.KORVIX_OFFLINE_MS = '150'; // fast offline detection for the alert test

const { start, server } = require('../src/server');

let base;
let adminToken = null; // superadmin session from first-run setup

async function api(method, urlPath, body, token = adminToken) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + urlPath, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test.before(async () => {
  await start(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
  // First-run setup creates the Korvix superadmin.
  const state = await api('GET', '/api/auth/state');
  if (!state.data.needs_setup) throw new Error('expected fresh install');
  const setup = await api('POST', '/api/auth/setup', {
    email: 'noc@korvix.au', password: 'super-secret-1', name: 'Korvix NOC',
  });
  if (setup.status !== 201) throw new Error('setup failed: ' + JSON.stringify(setup.data));
  adminToken = setup.data.token;
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('full venue lifecycle', async (t) => {
  let orgId, venueId, zoneId, screenId, deviceKey, mediaId, playlistId;

  await t.test('create business, venue, zone, screen', async () => {
    const org = await api('POST', '/api/orgs', { name: 'Test Hospitality Group' });
    assert.strictEqual(org.status, 201);
    orgId = org.data.id;

    // Superadmin must say which business the venue belongs to
    const noOrg = await api('POST', '/api/venues', { name: 'Orphan' });
    assert.strictEqual(noOrg.status, 400);

    const venue = await api('POST', '/api/venues', { name: 'Test Tavern', timezone: 'Australia/Sydney', org_id: orgId });
    assert.strictEqual(venue.status, 201);
    venueId = venue.data.id;

    const zone = await api('POST', `/api/venues/${venueId}/zones`, { name: 'Main Bar' });
    assert.strictEqual(zone.status, 201);
    zoneId = zone.data.id;

    const screen = await api('POST', `/api/venues/${venueId}/screens`, { name: 'Bar TV', zone_id: zoneId });
    assert.strictEqual(screen.status, 201);
    assert.strictEqual(screen.data.status, 'unpaired');
    screenId = screen.data.id;
  });

  await t.test('player pairing flow', async () => {
    const hello = await api('POST', '/api/player/hello', { player_info: { user_agent: 'test' } });
    assert.strictEqual(hello.data.status, 'pending');
    assert.match(hello.data.pairing_code, /^[A-Z2-9]{6}$/);
    deviceKey = hello.data.device_key;

    const paired = await api('POST', `/api/screens/${screenId}/pair`, { pairing_code: hello.data.pairing_code });
    assert.strictEqual(paired.status, 200);
    assert.strictEqual(paired.data.status, 'online');

    const again = await api('POST', '/api/player/hello', { device_key: deviceKey });
    assert.strictEqual(again.data.status, 'paired');
  });

  await t.test('content, playlist and schedule', async () => {
    const media = await api('POST', `/api/venues/${venueId}/media`, {
      name: 'Taps slide', type: 'html', content: '<h1>On tap</h1>', duration_seconds: 8,
    });
    assert.strictEqual(media.status, 201);
    mediaId = media.data.id;

    const badMedia = await api('POST', `/api/venues/${venueId}/media`, { name: 'x', type: 'nope' });
    assert.strictEqual(badMedia.status, 400);

    const playlist = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Bar loop' });
    playlistId = playlist.data.id;
    const item = await api('POST', `/api/playlists/${playlistId}/items`, { media_id: mediaId });
    assert.strictEqual(item.status, 201);

    const schedule = await api('POST', `/api/venues/${venueId}/schedules`, {
      name: 'All day', playlist_id: playlistId, zone_id: zoneId,
      start_time: '00:00', end_time: '24:00',
    });
    assert.strictEqual(schedule.status, 201);
  });

  await t.test('manifest resolves schedule and content', async () => {
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.status, 200);
    assert.strictEqual(manifest.data.venue.name, 'Test Tavern');
    assert.strictEqual(manifest.data.playlist.name, 'Bar loop');
    assert.strictEqual(manifest.data.playlist.items.length, 1);
    assert.strictEqual(manifest.data.playlist.items[0].content, '<h1>On tap</h1>');
    assert.strictEqual(manifest.data.emergency, null);
  });

  await t.test('heartbeat marks screen online in health overview', async () => {
    const beat = await api('POST', `/api/player/${deviceKey}/heartbeat`, { player_info: { current_item: 'Taps slide' } });
    assert.strictEqual(beat.status, 200);
    const health = await api('GET', '/api/health/overview');
    const v = health.data.venues.find((x) => x.id === venueId);
    assert.strictEqual(v.screens_online, 1);
    assert.strictEqual(v.screens_offline, 0);
  });

  await t.test('emergency broadcast overrides and clears', async () => {
    const em = await api('POST', '/api/emergencies', {
      venue_id: venueId, level: 'evacuation', title: 'EVACUATE', message: 'Use nearest exit',
    });
    assert.strictEqual(em.status, 201);

    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.emergency.level, 'evacuation');
    assert.strictEqual(manifest.data.emergency.title, 'EVACUATE');

    const cleared = await api('POST', `/api/emergencies/${em.data.id}/clear`);
    assert.strictEqual(cleared.status, 200);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.emergency, null);
  });

  await t.test('integration feed lands in manifest', async () => {
    const feed = await api('POST', `/api/integrations/${venueId}/gaming`, {
      jackpots: [{ name: 'Mega Link', amount: 9999.99 }],
    });
    assert.strictEqual(feed.status, 200);

    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.feeds.gaming.jackpots[0].amount, 9999.99);

    const bad = await api('POST', `/api/integrations/${venueId}/nonsense`, {});
    assert.strictEqual(bad.status, 400);
  });

  await t.test('schedule specificity: screen beats zone beats venue', async () => {
    const venuePl = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Venue-wide' });
    await api('POST', `/api/playlists/${venuePl.data.id}/items`, { media_id: mediaId });
    await api('POST', `/api/venues/${venueId}/schedules`, {
      name: 'Venue fallback', playlist_id: venuePl.data.id, priority: 99,
    });
    // Zone-targeted "Bar loop" must still win despite lower priority.
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist.name, 'Bar loop');

    const screenPl = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Screen-specific' });
    await api('POST', `/api/playlists/${screenPl.data.id}/items`, { media_id: mediaId });
    await api('POST', `/api/venues/${venueId}/schedules`, {
      name: 'This screen only', playlist_id: screenPl.data.id, screen_id: screenId,
    });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist.name, 'Screen-specific');
  });

  await t.test('screen rotation is stored and delivered to the player', async () => {
    const bad = await api('PATCH', `/api/screens/${screenId}`, { rotation: 45 });
    assert.strictEqual(bad.status, 400);
    const ok = await api('PATCH', `/api/screens/${screenId}`, { rotation: 270 });
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(ok.data.rotation, 270);
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.screen.rotation, 270);
  });

  await t.test('raffle draw lifecycle: create, spin without repeats, clear', async () => {
    const bad = await api('POST', `/api/venues/${venueId}/draws`, { name: 'Bad', range_start: 10, range_end: 5 });
    assert.strictEqual(bad.status, 400);

    const draw = await api('POST', `/api/venues/${venueId}/draws`, {
      name: 'Meat Raffle', range_start: 1, range_end: 3,
    });
    assert.strictEqual(draw.status, 201);
    assert.strictEqual(draw.data.status, 'ready');
    assert.strictEqual(draw.data.remaining, 3);
    const drawId = draw.data.id;

    // No takeover before the first spin
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.draw, null);

    // Spin all three: numbers must be unique and within range
    const seen = new Set();
    for (let i = 0; i < 3; i++) {
      const spin = await api('POST', `/api/draws/${drawId}/draw`);
      assert.strictEqual(spin.status, 200);
      const n = spin.data.latest_number;
      assert.ok(n >= 1 && n <= 3, `number ${n} in range`);
      assert.ok(!seen.has(n), `number ${n} not repeated`);
      seen.add(n);
    }
    const exhausted = await api('POST', `/api/draws/${drawId}/draw`);
    assert.strictEqual(exhausted.status, 409);

    // Live draw reaches the player with the latest number and history
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.draw.name, 'Meat Raffle');
    assert.ok(seen.has(manifest.data.draw.number));
    assert.strictEqual(manifest.data.draw.previous_numbers.length, 2);
    assert.strictEqual(manifest.data.draw.range_end, 3);

    // Clear returns screens to scheduled content
    await api('POST', `/api/draws/${drawId}/clear`);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.draw, null);
  });

  await t.test('zone-targeted draw only reaches screens in that zone', async () => {
    const otherZone = await api('POST', `/api/venues/${venueId}/zones`, { name: 'Gaming' });
    const draw = await api('POST', `/api/venues/${venueId}/draws`, {
      name: 'Gaming only', range_start: 1, range_end: 50, zone_id: otherZone.data.id,
    });
    await api('POST', `/api/draws/${draw.data.id}/draw`);
    // Our screen is in "Main Bar", not "Gaming" — no takeover
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.draw, null);
    await api('DELETE', `/api/draws/${draw.data.id}`);
  });

  await t.test('staff remote: token grants draw control, rotation revokes it', async () => {
    // No token yet
    const none = await api('GET', `/api/venues/${venueId}/remote-token`);
    assert.strictEqual(none.data.token, null);

    // Garbage token is rejected
    const garbage = await api('GET', '/api/remote/deadbeef');
    assert.strictEqual(garbage.status, 404);

    // Generate and use
    const gen = await api('POST', `/api/venues/${venueId}/remote-token`);
    assert.strictEqual(gen.status, 200);
    const token = gen.data.token;
    assert.match(token, /^[0-9a-f]{32}$/);

    const home = await api('GET', `/api/remote/${token}`);
    assert.strictEqual(home.status, 200);
    assert.strictEqual(home.data.venue.name, 'Test Tavern');
    assert.ok(Array.isArray(home.data.zones));

    // Full draw lifecycle through the remote
    const draw = await api('POST', `/api/remote/${token}/draws`, {
      name: 'Remote Raffle', range_start: 1, range_end: 10,
    });
    assert.strictEqual(draw.status, 201);
    const spin = await api('POST', `/api/remote/${token}/draws/${draw.data.id}/draw`);
    assert.strictEqual(spin.status, 200);
    assert.ok(spin.data.latest_number >= 1 && spin.data.latest_number <= 10);
    const cleared = await api('POST', `/api/remote/${token}/draws/${draw.data.id}/clear`);
    assert.strictEqual(cleared.status, 200);

    // Rotating the token revokes the old one
    const rotated = await api('POST', `/api/venues/${venueId}/remote-token`);
    assert.notStrictEqual(rotated.data.token, token);
    const revoked = await api('GET', `/api/remote/${token}`);
    assert.strictEqual(revoked.status, 404);
    const fresh = await api('GET', `/api/remote/${rotated.data.token}`);
    assert.strictEqual(fresh.status, 200);
  });

  await t.test('proof-of-play: heartbeat batch lands in the report', async () => {
    const beat = await api('POST', `/api/player/${deviceKey}/heartbeat`, {
      player_info: {},
      plays: [
        { media_id: mediaId, name: 'Taps slide', started_at: new Date().toISOString(), duration: 8.2 },
        { media_id: mediaId, name: 'Taps slide', started_at: new Date().toISOString(), duration: 7.8 },
        { media_id: 'bogus-no-start' }, // must be ignored, not crash
      ],
    });
    assert.strictEqual(beat.status, 200);

    const report = await api('GET', `/api/venues/${venueId}/reports/plays`);
    assert.strictEqual(report.status, 200);
    const row = report.data.media.find((m) => m.media_id === mediaId);
    assert.strictEqual(row.plays, 2);
    assert.strictEqual(row.seconds, 16);
    assert.strictEqual(row.screens, 1);
    assert.strictEqual(report.data.screens[0].plays, 2);
    assert.strictEqual(report.data.total_plays, 2);
  });

  await t.test('offline detection alerts once, recovery clears it', async () => {
    const monitor = require('../src/monitor');
    // Fresh heartbeat -> not offline
    await api('POST', `/api/player/${deviceKey}/heartbeat`, { player_info: {} });
    assert.strictEqual(monitor.checkOffline(), 0);

    // Wait past the (test-shortened) threshold -> exactly one alert
    await new Promise((r) => setTimeout(r, 250));
    assert.strictEqual(monitor.checkOffline(), 1);
    assert.strictEqual(monitor.checkOffline(), 0); // no duplicate alert

    let events = (await api('GET', '/api/events')).data.events;
    assert.strictEqual(events[0].type, 'screen.offline');

    // Heartbeat again -> recovered event, alert re-armed
    await api('POST', `/api/player/${deviceKey}/heartbeat`, { player_info: {} });
    events = (await api('GET', '/api/events')).data.events;
    assert.strictEqual(events[0].type, 'screen.recovered');
    assert.strictEqual(monitor.checkOffline(), 0);
  });

  await t.test('preview manifest does not affect online status', async () => {
    const before = (await api('GET', `/api/venues/${venueId}/screens`)).data.screens[0].last_seen_at;
    await new Promise((r) => setTimeout(r, 20));
    await api('GET', `/api/player/${deviceKey}/manifest?preview=1`);
    const after = (await api('GET', `/api/venues/${venueId}/screens`)).data.screens[0].last_seen_at;
    assert.strictEqual(after, before);

    await api('GET', `/api/player/${deviceKey}/manifest`);
    const bumped = (await api('GET', `/api/venues/${venueId}/screens`)).data.screens[0].last_seen_at;
    assert.notStrictEqual(bumped, before);
  });

  await t.test('venue location persists for auto-weather', async () => {
    const patched = await api('PATCH', `/api/venues/${venueId}`, { latitude: -33.8688, longitude: 151.2093 });
    assert.strictEqual(patched.data.latitude, -33.8688);
    assert.strictEqual(patched.data.longitude, 151.2093);
  });

  await t.test('backup endpoint returns a valid SQLite snapshot', async () => {
    const res = await fetch(base + `/api/backup?token=${adminToken}`); // query token, as browser downloads use
    assert.strictEqual(res.status, 200);
    assert.match(res.headers.get('content-disposition'), /korvix-backup-.*\.db/);
    const buf = Buffer.from(await res.arrayBuffer());
    assert.strictEqual(buf.subarray(0, 15).toString(), 'SQLite format 3');
  });

  await t.test('graphics upload lifecycle: upload, use, protect, delete', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await fetch(base + '/api/upload?name=promo.png', {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: png,
    });
    const uploaded = await up.json();
    assert.strictEqual(up.status, 201);
    assert.match(uploaded.url, /^\/uploads\/.+promo\.png$/);

    // File is served back with immutable caching
    const got = await fetch(base + uploaded.url);
    assert.strictEqual(got.status, 200);
    assert.strictEqual(Buffer.from(await got.arrayBuffer()).length, png.length);
    assert.match(got.headers.get('cache-control'), /immutable/);

    // Unsupported extensions are rejected
    const bad = await fetch(base + '/api/upload?name=hack.exe', {
      method: 'POST', headers: { Authorization: `Bearer ${adminToken}` }, body: png,
    });
    assert.strictEqual(bad.status, 400);

    // Create media from the upload with contain fit -> reaches the manifest
    const graphic = await api('POST', `/api/venues/${venueId}/media`, {
      name: 'Uploaded promo', type: 'image', src: uploaded.url, fit: 'contain',
    });
    assert.strictEqual(graphic.data.fit, 'contain');

    // Uploads list shows usage
    const list = await api('GET', '/api/uploads');
    const fileName = uploaded.url.split('/').pop();
    const entry = list.data.files.find((f) => f.name === fileName);
    assert.strictEqual(entry.used_by.length, 1);
    assert.strictEqual(entry.used_by[0].name, 'Uploaded promo');

    // In-use file is protected from deletion unless forced
    const blocked = await api('DELETE', `/api/uploads/${fileName}`);
    assert.strictEqual(blocked.status, 409);
    const forced = await api('DELETE', `/api/uploads/${fileName}?force=1`);
    assert.strictEqual(forced.status, 200);
    await api('DELETE', `/api/media/${graphic.data.id}`);
  });

  await t.test('fit flows through the playlist manifest', async () => {
    const patched = await api('PATCH', `/api/media/${mediaId}`, { fit: 'contain' });
    assert.strictEqual(patched.data.fit, 'contain');
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist.items[0].fit, 'contain');
    await api('PATCH', `/api/media/${mediaId}`, { fit: 'cover' });
  });

  await t.test('screen channels: racing/sports screens override schedules', async () => {
    const bad = await api('PATCH', `/api/screens/${screenId}`, { channel: 'bogus' });
    assert.strictEqual(bad.status, 400);

    await api('PATCH', `/api/screens/${screenId}`, { channel: 'racing1' });
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.screen.channel, 'racing1');
    assert.strictEqual(manifest.data.playlist.items.length, 1);
    assert.strictEqual(manifest.data.playlist.items[0].src, 'racing:1');
    assert.strictEqual(manifest.data.schedule, null);

    await api('PATCH', `/api/screens/${screenId}`, { channel: 'racing-results' });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist.items[0].src, 'racing:results');

    // Racing feed arrives via the webhook (or the built-in TAB poller)
    const feed = await api('POST', `/api/integrations/${venueId}/racing`, {
      jurisdiction: 'NSW',
      races: [{ meeting: 'Randwick', number: 6, type: 'R', name: 'Hcp', start: new Date(Date.now() + 300000).toISOString() }],
      results: [{ meeting: 'Rosehill', number: 4, type: 'R', placings: ['1st #7 Coastal Runner'] }],
    });
    assert.strictEqual(feed.status, 200);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.feeds.racing.races[0].meeting, 'Randwick');
    assert.strictEqual(manifest.data.feeds.racing.results[0].placings[0], '1st #7 Coastal Runner');

    // Back to main -> scheduled playlist returns
    await api('PATCH', `/api/screens/${screenId}`, { channel: 'main' });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.notStrictEqual(manifest.data.playlist.id, 'channel:main');
    assert.ok(manifest.data.playlist.items[0].media_id);
  });

  await t.test('calendar-dated schedules beat weekly ones and expire', async () => {
    const sydney = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Australia/Sydney' }).format(d);
    const today = sydney(new Date());
    const yesterday = sydney(new Date(Date.now() - 86400000));

    const eventPl = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Xmas Special' });
    await api('POST', `/api/playlists/${eventPl.data.id}/items`, { media_id: mediaId });

    // Same specificity as the existing screen-targeted weekly schedule, but
    // dated for today -> the calendar event wins without touching priority.
    const event = await api('POST', `/api/venues/${venueId}/schedules`, {
      name: 'Event day', playlist_id: eventPl.data.id, screen_id: screenId,
      start_date: today, end_date: today,
    });
    assert.strictEqual(event.status, 201);
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist.name, 'Xmas Special');

    // Move the window to yesterday -> expired, weekly schedule resumes
    await api('PATCH', `/api/schedules/${event.data.id}`, { start_date: yesterday, end_date: yesterday });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.notStrictEqual(manifest.data.playlist.name, 'Xmas Special');

    const badDate = await api('POST', `/api/venues/${venueId}/schedules`, {
      playlist_id: eventPl.data.id, start_date: '25/12/2026',
    });
    assert.strictEqual(badDate.status, 400);
    const backwards = await api('POST', `/api/venues/${venueId}/schedules`, {
      playlist_id: eventPl.data.id, start_date: '2026-12-26', end_date: '2026-12-20',
    });
    assert.strictEqual(backwards.status, 400);

    await api('DELETE', `/api/schedules/${event.data.id}`);
    await api('DELETE', `/api/playlists/${eventPl.data.id}`);
  });

  await t.test('venue racing jurisdiction persists', async () => {
    const patched = await api('PATCH', `/api/venues/${venueId}`, { racing_jurisdiction: 'nsw' });
    assert.strictEqual(patched.data.racing_jurisdiction, 'NSW');
    const off = await api('PATCH', `/api/venues/${venueId}`, { racing_jurisdiction: null });
    assert.strictEqual(off.data.racing_jurisdiction, null);
  });

  await t.test('menu boards: designer CRUD, widget media, instant sold-out', async () => {
    const menu = await api('POST', `/api/venues/${venueId}/menus`, {
      name: 'Bistro Dinner',
      sections: [{
        title: 'Mains',
        items: [
          { name: 'Chicken Schnitzel', desc: 'w/ chips & salad', price: 24.5 },
          { name: 'Grilled Barramundi', price: 29, sold_out: false },
        ],
      }],
    });
    assert.strictEqual(menu.status, 201);
    const menuId = menu.data.id;

    // A widget media item was auto-created, ready for playlists
    const { data: { media: lib } } = await api('GET', `/api/venues/${venueId}/media`);
    const board = lib.find((m) => m.src === `menuboard:${menuId}`);
    assert.ok(board, 'board widget exists in the library');
    assert.strictEqual(board.name, 'Bistro Dinner board');

    // Menu data reaches the player manifest
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    let served = manifest.data.menus.find((m) => m.id === menuId);
    assert.strictEqual(served.sections[0].items[0].name, 'Chicken Schnitzel');
    assert.strictEqual(served.sections[0].items[0].sold_out, false);

    // Sold-out toggle lands on screens via a plain PATCH
    const sections = menu.data.sections;
    sections[0].items[1].sold_out = true;
    await api('PATCH', `/api/menus/${menuId}`, { sections });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    served = manifest.data.menus.find((m) => m.id === menuId);
    assert.strictEqual(served.sections[0].items[1].sold_out, true);

    // Theme + item photos + venue logo flow through to the player
    const themed = await api('PATCH', `/api/menus/${menuId}`, {
      theme: 'chalkboard',
      sections: [{ title: 'Mains', items: [{ name: 'Schnitzel', price: 24.5, photo: '/uploads/schnitty.png', featured: true }] }],
    });
    assert.strictEqual(themed.data.theme, 'chalkboard');
    assert.strictEqual(themed.data.sections[0].items[0].featured, true);
    const badTheme = await api('PATCH', `/api/menus/${menuId}`, { theme: 'neon-vaporwave' });
    assert.strictEqual(badTheme.data.theme, 'classic'); // unknown themes fall back

    await api('PATCH', `/api/venues/${venueId}`, { logo_url: '/uploads/logo.png' });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.venue.logo, '/uploads/logo.png');
    served = manifest.data.menus.find((m) => m.id === menuId);
    assert.strictEqual(served.sections[0].items[0].photo, '/uploads/schnitty.png');
    await api('PATCH', `/api/venues/${venueId}`, { logo_url: null });

    // Deleting the menu takes its board media with it
    await api('DELETE', `/api/menus/${menuId}`);
    const after = await api('GET', `/api/venues/${venueId}/media`);
    assert.ok(!after.data.media.find((m) => m.src === `menuboard:${menuId}`));
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.ok(!manifest.data.menus.find((m) => m.id === menuId));
  });

  await t.test('split-screen layouts: side playlist + ticker in the manifest', async () => {
    const bad = await api('PATCH', `/api/screens/${screenId}`, { layout: 'diagonal' });
    assert.strictEqual(bad.status, 400);

    const sidePl = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Side promos' });
    await api('POST', `/api/playlists/${sidePl.data.id}/items`, { media_id: mediaId });
    await api('POST', `/api/integrations/${venueId}/ticker`, { messages: ['Happy hour 3-6pm', 'Live music Friday'] });

    await api('PATCH', `/api/screens/${screenId}`, { layout: 'side-ticker', side_playlist_id: sidePl.data.id });
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.screen.layout, 'side-ticker');
    assert.strictEqual(manifest.data.side_playlist.items.length, 1);
    assert.deepStrictEqual(manifest.data.ticker, ['Happy hour 3-6pm', 'Live music Friday']);

    // Full layout: extras drop away
    await api('PATCH', `/api/screens/${screenId}`, { layout: 'full' });
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.side_playlist, null);
    assert.strictEqual(manifest.data.ticker, null);
    await api('DELETE', `/api/playlists/${sidePl.data.id}`);
  });

  await t.test('unpair returns player to pending', async () => {
    await api('POST', `/api/screens/${screenId}/unpair`);
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.status, 404);
  });
});

test('multi-tenancy: businesses are isolated, roles enforced', async (t) => {
  let orgA, orgB, venueA, adminBToken, editorBToken, viewerBToken, venueB;

  await t.test('set up two businesses with users', async () => {
    orgA = (await api('POST', '/api/orgs', { name: 'Business A' })).data.id;
    orgB = (await api('POST', '/api/orgs', { name: 'Business B' })).data.id;
    venueA = (await api('POST', '/api/venues', { name: 'A Tavern', org_id: orgA })).data.id;

    const users = [
      { email: 'admin@b.com', role: 'admin' },
      { email: 'editor@b.com', role: 'editor' },
      { email: 'viewer@b.com', role: 'viewer' },
    ];
    for (const u of users) {
      const created = await api('POST', '/api/users', { ...u, password: 'password-1', org_id: orgB });
      assert.strictEqual(created.status, 201, JSON.stringify(created.data));
    }
    const login = (email) => api('POST', '/api/auth/login', { email, password: 'password-1' }, null);
    adminBToken = (await login('admin@b.com')).data.token;
    editorBToken = (await login('editor@b.com')).data.token;
    viewerBToken = (await login('viewer@b.com')).data.token;
    assert.ok(adminBToken && editorBToken && viewerBToken);

    const badLogin = await api('POST', '/api/auth/login', { email: 'admin@b.com', password: 'wrong' }, null);
    assert.strictEqual(badLogin.status, 401);
  });

  await t.test('org admin creates venues in their own business only', async () => {
    const venue = await api('POST', '/api/venues', { name: 'B Sports Bar' }, adminBToken);
    assert.strictEqual(venue.status, 201);
    assert.strictEqual(venue.data.org_id, orgB);
    venueB = venue.data.id;
  });

  await t.test('tenants cannot see each other', async () => {
    // B admin lists venues: only their own
    const list = await api('GET', '/api/venues', undefined, adminBToken);
    assert.ok(list.data.venues.every((v) => v.org_id === orgB));
    // Accessing A's venue by id 404s (no existence leak)
    for (const path of [`/api/venues/${venueA}/screens`, `/api/venues/${venueA}/media`, `/api/venues/${venueA}/reports/plays`]) {
      const res = await api('GET', path, undefined, adminBToken);
      assert.strictEqual(res.status, 404, path);
    }
    const write = await api('POST', `/api/venues/${venueA}/media`, { name: 'x', type: 'html' }, adminBToken);
    assert.strictEqual(write.status, 404);
    // Health overview scoped
    const health = await api('GET', '/api/health/overview', undefined, adminBToken);
    assert.ok(health.data.venues.every((v) => v.id !== venueA));
  });

  await t.test('roles: editor runs venues, cannot manage users; viewer read-only', async () => {
    const media = await api('POST', `/api/venues/${venueB}/media`, { name: 'B slide', type: 'html', content: '<h1>B</h1>' }, editorBToken);
    assert.strictEqual(media.status, 201);

    const editorUsers = await api('GET', '/api/users', undefined, editorBToken);
    assert.strictEqual(editorUsers.status, 403);
    const editorAddUser = await api('POST', '/api/users', { email: 'x@b.com', password: 'password-1', role: 'editor' }, editorBToken);
    assert.strictEqual(editorAddUser.status, 403);

    const viewerRead = await api('GET', `/api/venues/${venueB}/media`, undefined, viewerBToken);
    assert.strictEqual(viewerRead.status, 200);
    const viewerWrite = await api('POST', `/api/venues/${venueB}/media`, { name: 'nope', type: 'html' }, viewerBToken);
    assert.strictEqual(viewerWrite.status, 403);

    // Venue-wide emergency OK for editor; ALL-venues is Korvix-only
    const em = await api('POST', '/api/emergencies', { venue_id: venueB, title: 'Test', level: 'notice' }, editorBToken);
    assert.strictEqual(em.status, 201);
    await api('POST', `/api/emergencies/${em.data.id}/clear`, undefined, editorBToken);
    const globalEm = await api('POST', '/api/emergencies', { title: 'ALL', level: 'notice' }, adminBToken);
    assert.strictEqual(globalEm.status, 403);

    // Backup is Korvix-only
    const backup = await api('GET', '/api/backup', undefined, adminBToken);
    assert.strictEqual(backup.status, 403);
  });

  await t.test('org admin manages users in own org; superadmin protections hold', async () => {
    const users = await api('GET', '/api/users', undefined, adminBToken);
    assert.strictEqual(users.status, 200);
    assert.ok(users.data.users.every((u) => u.org_id === orgB));

    // B admin can't touch the superadmin
    const superUser = (await api('GET', '/api/users')).data.users.find((u) => u.role === 'superadmin');
    const touch = await api('PATCH', `/api/users/${superUser.id}`, { role: 'viewer' }, adminBToken);
    assert.strictEqual(touch.status, 404);
    // Nobody deletes the last superadmin
    const delSuper = await api('DELETE', `/api/users/${superUser.id}`);
    assert.strictEqual(delSuper.status, 400); // own account
  });

  await t.test('legacy env token still acts as superadmin API key', async () => {
    const res = await api('GET', '/api/venues', undefined, 'legacy-api-token-for-tests');
    assert.strictEqual(res.status, 200);
    assert.ok(res.data.venues.some((v) => v.id === venueA));
  });

  await t.test('logout kills the session', async () => {
    const out = await api('POST', '/api/auth/logout', {}, viewerBToken);
    assert.strictEqual(out.status, 200);
    const after = await api('GET', '/api/auth/me', undefined, viewerBToken);
    assert.strictEqual(after.status, 401);
  });

  await t.test('setup endpoint locked after first run', async () => {
    const again = await api('POST', '/api/auth/setup', { email: 'evil@x.com', password: 'hacktheplanet' }, null);
    assert.strictEqual(again.status, 409);
  });
});

test('CashKing digital card game', async (t) => {
  let venueId, deviceKey, gameId, publicToken;

  await t.test('setup: venue with a paired screen', async () => {
    const org = await api('POST', '/api/orgs', { name: 'CashKing Test Org' });
    const venue = await api('POST', '/api/venues', { name: 'CK Tavern', org_id: org.data.id });
    venueId = venue.data.id;
    const screen = await api('POST', `/api/venues/${venueId}/screens`, { name: 'Main' });
    const hello = await api('POST', '/api/player/hello', {}, null);
    deviceKey = hello.data.device_key;
    await api('POST', `/api/screens/${screen.data.id}/pair`, { pairing_code: hello.data.pairing_code });
  });

  await t.test('create game: 53 shuffled cards, faces never leak', async () => {
    const game = await api('POST', `/api/venues/${venueId}/card-games`, {
      name: 'CashKing', jackpot_start: 1000, jackpot_increment: 150, session_text: 'Thursdays 7:30pm',
    });
    assert.strictEqual(game.status, 201);
    gameId = game.data.id;
    publicToken = game.data.public_token;
    assert.strictEqual(game.data.cards.length, 53);
    assert.strictEqual(game.data.jackpot, 1000);
    // No unrevealed card exposes its face
    assert.ok(game.data.cards.every((c) => !c.revealed && c.card === null));

    // Only one active game at a time
    const second = await api('POST', `/api/venues/${venueId}/card-games`, { jackpot_start: 1, jackpot_increment: 1 });
    assert.strictEqual(second.status, 409);
  });

  await t.test('promo widget data in manifest; board hidden until live', async () => {
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.card_game, null);
    assert.strictEqual(manifest.data.card_game_promo.jackpot, 1000);
    assert.strictEqual(manifest.data.card_game_promo.cards_left, 53);

    await api('POST', `/api/card-games/${gameId}/live`);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.card_game.cards.length, 53);
    assert.ok(manifest.data.card_game.cards.every((c) => c.card === null));
  });

  await t.test('picks: misses roll the jackpot, Joker wins, no repicks', async () => {
    // Pick cards until the Joker turns up; verify jackpot math along the way.
    let misses = 0;
    let won = false;
    for (let i = 0; i < 53 && !won; i++) {
      const pick = await api('POST', `/api/card-games/${gameId}/pick`, { index: i });
      assert.strictEqual(pick.status, 200, JSON.stringify(pick.data));
      if (pick.data.was_joker) {
        won = true;
        assert.strictEqual(pick.data.status, 'won');
        assert.strictEqual(pick.data.jackpot, 1000 + misses * 150);
        // Repick after win is rejected
        const after = await api('POST', `/api/card-games/${gameId}/pick`, { index: 52 });
        assert.strictEqual(after.status, 409);
      } else {
        misses++;
        assert.strictEqual(pick.data.jackpot, 1000 + misses * 150);
        assert.strictEqual(pick.data.cards[i].revealed, true);
        assert.notStrictEqual(pick.data.cards[i].card, null);
        // Same card can't be picked twice
        const dupe = await api('POST', `/api/card-games/${gameId}/pick`, { index: i });
        assert.strictEqual(dupe.status, 409);
      }
    }
    assert.ok(won, 'joker must be somewhere in 53 cards');

    // Winner state reaches the screens
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.card_game.won, true);
  });

  await t.test('public promo feed works without auth; archive hides it', async () => {
    const feed = await api('GET', `/api/public/cashking/${publicToken}`, undefined, null);
    assert.strictEqual(feed.status, 200);
    assert.strictEqual(feed.data.venue, 'CK Tavern');
    assert.strictEqual(feed.data.status, 'won');
    assert.ok(feed.data.last_card.was_joker);

    const bogus = await api('GET', '/api/public/cashking/nope', undefined, null);
    assert.strictEqual(bogus.status, 404);

    await api('POST', `/api/card-games/${gameId}/archive`);
    const gone = await api('GET', `/api/public/cashking/${publicToken}`, undefined, null);
    assert.strictEqual(gone.status, 404);
    // And a new game can now start
    const fresh = await api('POST', `/api/venues/${venueId}/card-games`, { jackpot_start: 500, jackpot_increment: 50 });
    assert.strictEqual(fresh.status, 201);
  });

  await t.test('console can start/archive games and run emergencies', async () => {
    const remote = await api('POST', `/api/venues/${venueId}/remote-token`);
    const tok = remote.data.token;

    // Active game blocks a second one from the console too
    const blocked = await api('POST', `/api/remote/${tok}/card-games`, { jackpot_start: 1, jackpot_increment: 1 }, null);
    assert.strictEqual(blocked.status, 409);

    // Emergency from the tablet: venue-scoped, reaches the player, clears
    const em = await api('POST', `/api/remote/${tok}/emergency`, {
      level: 'evacuation', title: 'FIRE — EVACUATE', message: 'Use the nearest exit',
    }, null);
    assert.strictEqual(em.status, 201);
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.emergency.title, 'FIRE — EVACUATE');
    let stateRes = await api('GET', `/api/remote/${tok}`, undefined, null);
    assert.strictEqual(stateRes.data.emergency.venue_scoped, true);

    const cleared = await api('POST', `/api/remote/${tok}/emergency/${em.data.id}/clear`, {}, null);
    assert.strictEqual(cleared.status, 200);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.emergency, null);

    // Archive the current game from the console, then start a fresh one
    stateRes = await api('GET', `/api/remote/${tok}`, undefined, null);
    await api('POST', `/api/remote/${tok}/card-games/${stateRes.data.card_game.id}/archive`, {}, null);
    const fresh = await api('POST', `/api/remote/${tok}/card-games`, {
      name: 'Console Game', jackpot_start: 750, jackpot_increment: 50,
    }, null);
    assert.strictEqual(fresh.status, 201);
    assert.strictEqual(fresh.data.jackpot, 750);
  });

  await t.test('return-to-advertising clears game takeovers but not emergencies', async () => {
    const tok = (await api('POST', `/api/venues/${venueId}/remote-token`)).data.token;
    // Put a draw and the card game live
    const draw = await api('POST', `/api/remote/${tok}/draws`, { name: 'RTA test', range_start: 1, range_end: 9 }, null);
    await api('POST', `/api/remote/${tok}/draws/${draw.data.id}/draw`, {}, null);
    const game = (await api('GET', `/api/remote/${tok}`, undefined, null)).data.card_game;
    await api('POST', `/api/remote/${tok}/card-games/${game.id}/live`, {}, null);
    // And an emergency, which must survive
    const em = await api('POST', `/api/remote/${tok}/emergency`, { level: 'notice', title: 'Survives' }, null);

    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.ok(manifest.data.draw);
    assert.ok(manifest.data.card_game);

    const rta = await api('POST', `/api/remote/${tok}/return-to-advertising`, {}, null);
    assert.strictEqual(rta.status, 200);
    assert.strictEqual(rta.data.cleared.draws, 1);
    assert.strictEqual(rta.data.cleared.card_games, 1);

    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.draw, null);
    assert.strictEqual(manifest.data.card_game, null);
    assert.strictEqual(manifest.data.emergency.title, 'Survives'); // untouched
    await api('POST', `/api/remote/${tok}/emergency/${em.data.id}/clear`, {}, null);
    await api('DELETE', `/api/draws/${draw.data.id}`);
  });

  await t.test('wheel spin: weighted pick, live takeover, odds stay hidden', async () => {
    const tok = (await api('POST', `/api/venues/${venueId}/remote-token`)).data.token;

    const bad = await api('POST', `/api/remote/${tok}/wheels`, { wedges: [{ label: 'only one' }] }, null);
    assert.strictEqual(bad.status, 400);

    // Weight 0 wedges can never win
    const wheel = await api('POST', `/api/remote/${tok}/wheels`, {
      name: 'Test Wheel',
      wedges: [{ label: 'never', weight: 0 }, { label: 'always', weight: 5 }, { label: 'nope', weight: 0 }],
    }, null);
    assert.strictEqual(wheel.status, 201);
    assert.strictEqual(wheel.data.wedges[0].weight, undefined); // odds not exposed

    await api('POST', `/api/remote/${tok}/wheels/${wheel.data.id}/live`, {}, null);
    for (let i = 0; i < 5; i++) {
      const spin = await api('POST', `/api/remote/${tok}/wheels/${wheel.data.id}/spin`, {}, null);
      assert.strictEqual(spin.data.spin.label, 'always');
    }
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.wheel.name, 'Test Wheel');
    assert.strictEqual(manifest.data.wheel.last_spin.label, 'always');

    await api('POST', `/api/remote/${tok}/wheels/${wheel.data.id}/end-session`, {}, null);
    const after = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(after.data.wheel, null);
  });

  await t.test('badge draw: claim resets pot, no-show jackpots it', async () => {
    const tok = (await api('POST', `/api/venues/${venueId}/remote-token`)).data.token;
    const badge = await api('POST', `/api/remote/${tok}/badge-draws`, {
      name: 'Friday Badge Draw', prize_start: 200, increment: 75, claim_minutes: 3,
      members_text: '1234 Karen M.\n2087, Dave T.\n3345 Robbo',
    }, null);
    assert.strictEqual(badge.status, 201);
    assert.strictEqual(badge.data.members_count, 3);
    assert.strictEqual(badge.data.prize, 200);

    await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/live`, {}, null);
    let drawn = await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/draw`, {}, null);
    assert.strictEqual(drawn.data.current.outcome, 'pending');
    assert.ok(['1234', '2087', '3345'].includes(drawn.data.current.number));

    // Can't draw again while one is pending
    const dupe = await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/draw`, {}, null);
    assert.strictEqual(dupe.status, 409);

    // Player sees it with a claim deadline
    let manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.badge_draw.current.outcome, 'pending');
    assert.ok(Date.parse(manifest.data.badge_draw.current.deadline) > Date.now());

    // No show -> pot jackpots
    let out = await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/outcome`, { claimed: false }, null);
    assert.strictEqual(out.data.prize, 275);
    assert.strictEqual(out.data.history[0].outcome, 'unclaimed');

    // Next draw claimed -> pot resets to the base
    await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/draw`, {}, null);
    out = await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/outcome`, { claimed: true }, null);
    assert.strictEqual(out.data.prize, 200);
    assert.strictEqual(out.data.history[0].outcome, 'claimed');
    assert.strictEqual(out.data.history[0].prize, 275); // the amount that was won

    await api('POST', `/api/remote/${tok}/badge-draws/${badge.data.id}/end-session`, {}, null);
    manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.badge_draw, null);
  });

  await t.test('staff remote can run the game', async () => {
    const remote = await api('POST', `/api/venues/${venueId}/remote-token`);
    const stateRes = await api('GET', `/api/remote/${remote.data.token}`, undefined, null);
    const game = stateRes.data.card_game;
    assert.strictEqual(game.jackpot, 750); // the game started from the console
    const live = await api('POST', `/api/remote/${remote.data.token}/card-games/${game.id}/live`, {}, null);
    assert.strictEqual(live.status, 200);
    const pick = await api('POST', `/api/remote/${remote.data.token}/card-games/${game.id}/pick`, { index: 7 }, null);
    assert.strictEqual(pick.status, 200);
    await api('POST', `/api/remote/${remote.data.token}/card-games/${game.id}/end-session`, {}, null);
  });
});

test('racing source normalizers', () => {
  const { normalizeTab, normalizeLadbrokes, ladbrokesPlacings } = require('../src/racing');

  const tab = normalizeTab({
    races: [{
      meeting: { meetingName: 'Randwick', location: 'NSW', raceType: 'R', venueMnemonic: 'RAN', meetingDate: '2026-07-08' },
      raceNumber: 6, raceName: 'City Tattersalls Hcp', raceDistance: 1400,
      raceStartTime: '2026-07-08T05:30:00.000Z',
    }, {
      meeting: null, raceNumber: 1, raceStartTime: '2026-07-08T05:40:00.000Z', // junk -> dropped
    }],
  });
  assert.strictEqual(tab.length, 1);
  assert.strictEqual(tab[0].meeting, 'Randwick');
  assert.strictEqual(tab[0].type, 'R');
  assert.strictEqual(tab[0].source, 'tab');

  const lb = normalizeLadbrokes({
    data: {
      next_to_go_ids: ['b', 'a'],
      race_summaries: {
        a: {
          race_id: 'a', meeting_name: 'Menangle', venue_state: 'NSW', venue_country: 'AUS',
          category_id: '161d9be2-e909-4326-8c2c-35ed71fb460b', race_number: 3,
          race_name: 'Pace 2300m', race_form: { distance: { distance: 2300 } },
          advertised_start: { seconds: 1780000000 },
        },
        b: {
          race_id: 'b', meeting_name: 'Ascot', venue_country: 'GBR', // overseas -> dropped
          category_id: '4a2788f8-e825-4d36-9894-efd4baf1cfae', race_number: 2,
          advertised_start: { seconds: 1780000100 },
        },
      },
    },
  });
  assert.strictEqual(lb.length, 1);
  assert.strictEqual(lb[0].meeting, 'Menangle');
  assert.strictEqual(lb[0].type, 'H');
  assert.strictEqual(lb[0].distance, 2300);
  assert.strictEqual(lb[0].start, new Date(1780000000 * 1000).toISOString());
  assert.strictEqual(lb[0].source, 'ladbrokes');

  assert.deepStrictEqual(ladbrokesPlacings({
    data: { results: [
      { position: 2, runner_number: 5, name: 'Midnight Ale' },
      { position: 1, runner_number: 7, name: 'Coastal Runner' },
    ] },
  }), ['1st #7 Coastal Runner', '2nd #5 Midnight Ale']);
  assert.strictEqual(ladbrokesPlacings({ data: {} }), null);
});

test('scheduler time-window helpers', () => {
  const { inWindow, matchDay } = require('../src/scheduler');
  // plain window
  assert.strictEqual(inWindow(11 * 60 + 45, '11:30', '15:00'), true);
  assert.strictEqual(inWindow(15 * 60, '11:30', '15:00'), false);
  // wraps midnight: 21:00 - 02:00
  assert.strictEqual(inWindow(23 * 60, '21:00', '02:00'), true);
  assert.strictEqual(inWindow(1 * 60, '21:00', '02:00'), true);
  assert.strictEqual(inWindow(3 * 60, '21:00', '02:00'), false);
  // Friday-night window still matched at 1am Saturday
  assert.strictEqual(matchDay('[5]', 6, 60, '21:00', '02:00'), true);
  assert.strictEqual(matchDay('[5]', 6, 3 * 60, '21:00', '02:00'), false);
  assert.strictEqual(matchDay('[5]', 5, 22 * 60, '21:00', '02:00'), true);

  // Calendar bounds, wrap-aware: the small hours belong to yesterday's date.
  const { matchesSchedule } = require('../src/scheduler');
  const fridayNight = {
    days_of_week: '[5]', start_time: '21:00', end_time: '02:00',
    start_date: '2026-07-10', end_date: '2026-07-10', // a Friday
  };
  const fri11pm = { day: 5, minutes: 23 * 60, date: '2026-07-10', prevDate: '2026-07-09' };
  const sat1am = { day: 6, minutes: 60, date: '2026-07-11', prevDate: '2026-07-10' };
  const nextSat1am = { day: 6, minutes: 60, date: '2026-07-18', prevDate: '2026-07-17' };
  assert.strictEqual(matchesSchedule(fridayNight, fri11pm), true);
  assert.strictEqual(matchesSchedule(fridayNight, sat1am), true);   // spillover past midnight
  assert.strictEqual(matchesSchedule(fridayNight, nextSat1am), false); // wrong week
  const openEnded = { ...fridayNight, start_date: null, end_date: null };
  assert.strictEqual(matchesSchedule(openEnded, nextSat1am), true); // weekly, no dates
});

// ---- SaaS pass: brand, emails, audit trail, sleep hours, cloning, console photos ----

test('SaaS features: brand, password reset, alerts, sleep, clone, photos, backups', async (t) => {
  const db = require('../src/db');
  let orgId, venueId, zoneId, screenId, deviceKey, remoteToken, playlistId, mediaId;

  await t.test('auth state exposes brand + email configuration', async () => {
    const state = await api('GET', '/api/auth/state');
    assert.strictEqual(state.status, 200);
    assert.strictEqual(state.data.brand, 'Korvix Signage'); // default until KORVIX_BRAND is set
    assert.strictEqual(state.data.email_configured, false); // no SMTP in the test env
  });

  await t.test('forgot password without SMTP explains itself; reset flow works with a token', async () => {
    const org = await api('POST', '/api/orgs', { name: 'Reset Test Group' });
    orgId = org.data.id;
    const user = await api('POST', '/api/users', {
      email: 'manager@resettest.au', password: 'first-password-1', role: 'admin', org_id: orgId,
    });
    assert.strictEqual(user.status, 201);

    // Unconfigured SMTP -> helpful 503, not a silent nothing.
    const forgot = await api('POST', '/api/auth/forgot', { email: 'manager@resettest.au' });
    assert.strictEqual(forgot.status, 503);
    assert.match(forgot.data.error, /email is not set up/);

    // Simulate the emailed token (what /forgot would create with SMTP configured).
    const crypto = require('node:crypto');
    const token = crypto.randomBytes(32).toString('hex');
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const uid = db.get('SELECT id FROM users WHERE email = ?', 'manager@resettest.au').id;
    db.run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      hash, uid, db.now(), new Date(Date.now() + 3600 * 1000).toISOString());

    // A live session that must die when the password resets.
    const login1 = await api('POST', '/api/auth/login', { email: 'manager@resettest.au', password: 'first-password-1' });
    assert.strictEqual(login1.status, 200);

    const weak = await api('POST', '/api/auth/reset', { token, password: 'short' });
    assert.strictEqual(weak.status, 400);
    const reset = await api('POST', '/api/auth/reset', { token, password: 'brand-new-password-1' });
    assert.strictEqual(reset.status, 200);

    const replay = await api('POST', '/api/auth/reset', { token, password: 'sneaky-replay-pass' });
    assert.strictEqual(replay.status, 400); // single use

    const oldPass = await api('POST', '/api/auth/login', { email: 'manager@resettest.au', password: 'first-password-1' });
    assert.strictEqual(oldPass.status, 401);
    const newPass = await api('POST', '/api/auth/login', { email: 'manager@resettest.au', password: 'brand-new-password-1' });
    assert.strictEqual(newPass.status, 200);
    const killed = await api('GET', '/api/auth/me', undefined, login1.data.token);
    assert.strictEqual(killed.status, 401); // reset signs out everywhere

    // Expired tokens don't work.
    const stale = crypto.randomBytes(32).toString('hex');
    db.run('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)',
      crypto.createHash('sha256').update(stale).digest('hex'), uid, db.now(),
      new Date(Date.now() - 1000).toISOString());
    const expired = await api('POST', '/api/auth/reset', { token: stale, password: 'whatever-password-1' });
    assert.strictEqual(expired.status, 400);
    require('../src/monitor').cleanupResets();
    assert.strictEqual(db.all('SELECT * FROM password_resets').length, 0);
  });

  await t.test('business alert email persists via PATCH', async () => {
    const set = await api('PATCH', `/api/orgs/${orgId}`, { alert_email: 'alerts@resettest.au' });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.data.alert_email, 'alerts@resettest.au');
    const keepName = await api('PATCH', `/api/orgs/${orgId}`, { name: 'Reset Test Group 2' });
    assert.strictEqual(keepName.data.alert_email, 'alerts@resettest.au'); // untouched fields stay
    const clear = await api('PATCH', `/api/orgs/${orgId}`, { alert_email: '' });
    assert.strictEqual(clear.data.alert_email, null);
  });

  await t.test('audit trail records who did it', async () => {
    const events = (await api('GET', '/api/events')).data.events;
    const orgEvent = events.find((e) => e.type === 'org.created' && e.detail === 'Reset Test Group');
    assert.ok(orgEvent, 'org.created event exists');
    assert.strictEqual(orgEvent.actor, 'noc@korvix.au');
    const login = events.find((e) => e.type === 'auth.login' && e.actor === 'manager@resettest.au');
    assert.ok(login, 'login attributed to the user');
  });

  await t.test('sleep hours: validated, stored, and delivered in the manifest', async () => {
    const venue = await api('POST', '/api/venues', { name: 'Sleepy Tavern', timezone: 'Australia/Sydney', org_id: orgId });
    venueId = venue.data.id;
    const zone = await api('POST', `/api/venues/${venueId}/zones`, { name: 'Bar' });
    zoneId = zone.data.id;
    const screen = await api('POST', `/api/venues/${venueId}/screens`, { name: 'Sleep TV', zone_id: zoneId });
    screenId = screen.data.id;
    const hello = await api('POST', '/api/player/hello', {});
    deviceKey = hello.data.device_key;
    const paired = await api('POST', `/api/screens/${screenId}/pair`, { pairing_code: hello.data.pairing_code });
    assert.strictEqual(paired.status, 200);

    const bad = await api('PATCH', `/api/venues/${venueId}`, { sleep_start: '25:99', sleep_end: 'nope' });
    assert.strictEqual(bad.data.sleep_start, null); // invalid times stored as null

    const set = await api('PATCH', `/api/venues/${venueId}`, { sleep_start: '00:30', sleep_end: '07:00' });
    assert.strictEqual(set.data.sleep_start, '00:30');
    assert.strictEqual(set.data.sleep_end, '07:00');

    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.deepStrictEqual(manifest.data.venue.sleep, { start: '00:30', end: '07:00' });
    assert.strictEqual(manifest.data.brand, 'Korvix Signage');

    const off = await api('PATCH', `/api/venues/${venueId}`, { sleep_start: '', sleep_end: '' });
    assert.strictEqual(off.data.sleep_start, null);
  });

  await t.test('venue clone copies content but not screens', async () => {
    // Build out the template venue.
    const media = await api('POST', `/api/venues/${venueId}/media`, {
      name: 'House Promo', type: 'image', src: '/uploads/none.jpg', duration_seconds: 8,
    });
    mediaId = media.data.id;
    const qr = await api('POST', `/api/venues/${venueId}/media`, {
      name: 'Menu QR', type: 'widget', src: 'qr:https://menu.example|Scan for menu', duration_seconds: 12,
    });
    assert.strictEqual(qr.status, 201);
    const menu = await api('POST', `/api/venues/${venueId}/menus`, {
      name: 'Bistro', theme: 'pub', sections: [{ title: 'Mains', items: [{ name: 'Parma', price: 25 }] }],
    });
    assert.strictEqual(menu.status, 201);
    const playlist = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Main Loop' });
    playlistId = playlist.data.id;
    await api('POST', `/api/playlists/${playlistId}/items`, { media_id: mediaId });
    const schedule = await api('POST', `/api/venues/${venueId}/schedules`, {
      name: 'All day', playlist_id: playlistId, days_of_week: [0, 1, 2, 3, 4, 5, 6],
      start_time: '00:00', end_time: '24:00',
    });
    assert.strictEqual(schedule.status, 201);

    const clone = await api('POST', `/api/venues/${venueId}/clone`, { name: 'Sleepy Tavern II' });
    assert.strictEqual(clone.status, 201);
    assert.strictEqual(clone.data.cloned.zones, 1);
    assert.strictEqual(clone.data.cloned.menus, 1);
    assert.strictEqual(clone.data.cloned.playlists, 1);
    assert.strictEqual(clone.data.cloned.schedules, 1);
    assert.ok(clone.data.cloned.media >= 3); // promo + qr + menuboard widget
    assert.strictEqual(clone.data.org_id, orgId);

    const newVenueId = clone.data.id;
    const screens = await api('GET', `/api/venues/${newVenueId}/screens`);
    assert.strictEqual(screens.data.screens.length, 0); // screens never cloned

    // The cloned menuboard widget points at the CLONED menu, not the original.
    const clonedMenus = (await api('GET', `/api/venues/${newVenueId}/menus`)).data.menus;
    assert.strictEqual(clonedMenus.length, 1);
    const clonedMedia = (await api('GET', `/api/venues/${newVenueId}/media`)).data.media;
    const board = clonedMedia.find((m) => m.type === 'widget' && m.src.startsWith('menuboard:'));
    assert.ok(board, 'menu board widget cloned');
    assert.strictEqual(board.src, `menuboard:${clonedMenus[0].id}`);

    // Cloned playlist references the cloned media row.
    const clonedPlaylists = (await api('GET', `/api/venues/${newVenueId}/playlists`)).data.playlists;
    assert.strictEqual(clonedPlaylists[0].items.length, 1);
    assert.notStrictEqual(clonedPlaylists[0].items[0].media_id, mediaId);
  });

  await t.test('console photo: upload, playlist insert, expiry pruning', async () => {
    const tokenRes = await api('POST', `/api/venues/${venueId}/remote-token`);
    remoteToken = tokenRes.data.token;

    // 1x1 PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
    const q = `name=special.png&playlist_id=${playlistId}&hours=3&label=Tonight%27s%20Special`;
    const up = await fetch(`${base}/api/remote/${remoteToken}/photo?${q}`, { method: 'POST', body: png });
    const upData = await up.json();
    assert.strictEqual(up.status, 201);
    assert.strictEqual(upData.playlist, 'Main Loop');
    assert.ok(upData.expires_at > db.now());

    // Wrong playlist (another venue's) is rejected.
    const otherPl = db.get('SELECT id FROM playlists WHERE venue_id != ?', venueId);
    if (otherPl) {
      const bad = await fetch(`${base}/api/remote/${remoteToken}/photo?name=x.png&playlist_id=${otherPl.id}`, { method: 'POST', body: png });
      assert.strictEqual(bad.status, 400);
    }

    // It plays now…
    const items = (await api('GET', `/api/venues/${venueId}/playlists`)).data.playlists
      .find((p) => p.id === playlistId).items;
    assert.ok(items.some((i) => i.media_id === upData.media_id));

    // …and disappears once expired: manifest filter + pruning.
    db.run('UPDATE media SET expires_at = ? WHERE id = ?', new Date(Date.now() - 1000).toISOString(), upData.media_id);
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    const manifestIds = ((manifest.data.playlist && manifest.data.playlist.items) || []).map((i) => i.media_id);
    assert.ok(!manifestIds.includes(upData.media_id), 'expired media filtered from manifest');

    const fileOnDisk = path.join(tmp, 'uploads', path.basename(db.get('SELECT src FROM media WHERE id = ?', upData.media_id).src));
    assert.ok(fs.existsSync(fileOnDisk));
    const pruned = require('../src/monitor').pruneExpiredMedia();
    assert.ok(pruned >= 1);
    assert.strictEqual(db.get('SELECT id FROM media WHERE id = ?', upData.media_id), undefined);
    assert.ok(!fs.existsSync(fileOnDisk), 'expired upload removed from disk');
  });

  await t.test('nightly backup writes a snapshot and is idempotent per day', async () => {
    const monitor = require('../src/monitor');
    const file = monitor.runBackup();
    assert.ok(file && fs.existsSync(file));
    const header = Buffer.alloc(16);
    fs.readSync(fs.openSync(file, 'r'), header, 0, 16, 0);
    assert.strictEqual(header.toString('utf8', 0, 15), 'SQLite format 3');
    assert.strictEqual(monitor.runBackup(), file); // same day -> same file, no churn
    const backupEvents = db.all("SELECT * FROM events WHERE type = 'backup.created'");
    assert.strictEqual(backupEvents.length, 1);
    assert.strictEqual(backupEvents[0].actor, 'system');
  });

  await t.test('/qr generates codes locally; mailer degrades gracefully', async () => {
    const res = await fetch(`${base}/qr`);
    assert.strictEqual(res.status, 400);

    const ok = await fetch(`${base}/qr?data=${encodeURIComponent('https://thetavern.com.au/menu')}`);
    assert.strictEqual(ok.status, 200);
    assert.match(ok.headers.get('content-type'), /image\/svg/);
    const svg = await ok.text();
    assert.match(svg, /^<svg /);
    assert.ok(svg.includes('<rect'), 'has modules');

    // structural sanity straight from the encoder
    const { qrMatrix } = require('../src/qrcode');
    const m = qrMatrix('HELLO');
    assert.strictEqual(m.length, 21); // version 1 is 21x21
    // finder pattern corners are dark
    assert.strictEqual(m[0][0], 1);
    assert.strictEqual(m[0][20], 1);
    assert.strictEqual(m[20][0], 1);
    assert.throws(() => qrMatrix('x'.repeat(500)), /too long/);
    const mailer = require('../src/mailer');
    assert.strictEqual(mailer.configured(), false);
    const sent = await mailer.sendMail({ to: 'x@y.z', subject: 'hi', text: 'hello' });
    assert.deepStrictEqual(sent, { skipped: true });
  });
});

// ---- Licensing & billing ---------------------------------------------------------

test('licensing: main vs basic screens drive features and billing', async (t) => {
  let orgId, venueId, mainScreen, basicScreen, mainKey, basicKey;

  await t.test('setup: venue with one main + one basic screen, both paired', async () => {
    const org = await api('POST', '/api/orgs', { name: 'Billing Test Group' });
    orgId = org.data.id;
    const venue = await api('POST', '/api/venues', { name: 'Billed Arms Hotel', org_id: orgId });
    venueId = venue.data.id;

    const pairUp = async (name) => {
      const screen = await api('POST', `/api/venues/${venueId}/screens`, { name });
      const hello = await api('POST', '/api/player/hello', {});
      const paired = await api('POST', `/api/screens/${screen.data.id}/pair`, { pairing_code: hello.data.pairing_code });
      assert.strictEqual(paired.status, 200);
      return { id: screen.data.id, key: hello.data.device_key };
    };
    ({ id: mainScreen, key: mainKey } = await pairUp('Front Bar TV'));
    ({ id: basicScreen, key: basicKey } = await pairUp('Bottle Shop Screen'));

    const bad = await api('PATCH', `/api/screens/${basicScreen}`, { license: 'platinum' });
    assert.strictEqual(bad.status, 400);
    const set = await api('PATCH', `/api/screens/${basicScreen}`, { license: 'basic' });
    assert.strictEqual(set.data.license, 'basic');
  });

  await t.test('basic screens refuse premium channels; downgrade resets them', async () => {
    const refused = await api('PATCH', `/api/screens/${basicScreen}`, { channel: 'racing1' });
    assert.strictEqual(refused.status, 400);
    assert.match(refused.data.error, /Main licence/);

    // main screen takes the channel fine, then downgrading drops it back
    await api('PATCH', `/api/screens/${mainScreen}`, { channel: 'racing1' });
    const downgraded = await api('PATCH', `/api/screens/${mainScreen}`, { license: 'basic' });
    assert.strictEqual(downgraded.data.channel, 'main');
    await api('PATCH', `/api/screens/${mainScreen}`, { license: 'main' }); // restore
  });

  await t.test('game takeovers only reach main-licence screens', async () => {
    const draw = await api('POST', `/api/venues/${venueId}/draws`, {
      name: 'Meat Raffle', range_start: 1, range_end: 100,
    });
    const spun = await api('POST', `/api/draws/${draw.data.id}/draw`);
    assert.strictEqual(spun.status, 200);

    const mainManifest = await api('GET', `/api/player/${mainKey}/manifest`);
    assert.ok(mainManifest.data.draw, 'main screen shows the draw');
    assert.strictEqual(mainManifest.data.screen.license, 'main');

    const basicManifest = await api('GET', `/api/player/${basicKey}/manifest`);
    assert.strictEqual(basicManifest.data.draw, null, 'basic screen skips the takeover');
    assert.strictEqual(basicManifest.data.screen.license, 'basic');
    assert.strictEqual(basicManifest.data.emergency, null); // and no channel leak
    await api('POST', `/api/draws/${draw.data.id}/clear`);
  });

  await t.test('emergencies ignore the licence tier', async () => {
    const em = await api('POST', '/api/emergencies', { venue_id: venueId, level: 'alert', title: 'Test alert' });
    const basicManifest = await api('GET', `/api/player/${basicKey}/manifest`);
    assert.ok(basicManifest.data.emergency, 'safety broadcasts reach basic screens');
    await api('POST', `/api/emergencies/${em.data.id}/clear`);
  });

  await t.test('billing rolls up paired screens by tier at the configured prices', async () => {
    const before = await api('GET', '/api/billing');
    assert.strictEqual(before.status, 200);

    const set = await api('PATCH', '/api/billing/prices', { main: 60, basic: 25 });
    assert.deepStrictEqual(set.data.prices, { main: 60, basic: 25 });

    const bill = await api('GET', '/api/billing');
    const biz = bill.data.businesses.find((b) => b.name === 'Billing Test Group');
    assert.ok(biz, 'business appears on the bill');
    const venue = biz.venues.find((v) => v.id === venueId);
    assert.strictEqual(venue.main, 1);
    assert.strictEqual(venue.basic, 1);
    assert.strictEqual(venue.monthly, 60 + 25);

    // unpaired screens are free
    await api('POST', `/api/venues/${venueId}/screens`, { name: 'Placeholder' });
    const bill2 = await api('GET', '/api/billing');
    const venue2 = bill2.data.businesses.find((b) => b.id === orgId).venues.find((v) => v.id === venueId);
    assert.strictEqual(venue2.monthly, 85, 'unpaired screen adds nothing');
    assert.strictEqual(venue2.unpaired, 1);
  });

  await t.test('org admins see only their own bill; editors see none', async () => {
    const admin = await api('POST', '/api/users', {
      email: 'admin@billedarms.au', password: 'billing-pass-1', role: 'admin', org_id: orgId,
    });
    assert.strictEqual(admin.status, 201);
    const login = await api('POST', '/api/auth/login', { email: 'admin@billedarms.au', password: 'billing-pass-1' });
    const own = await api('GET', '/api/billing', undefined, login.data.token);
    assert.strictEqual(own.status, 200);
    assert.strictEqual(own.data.businesses.length, 1);
    assert.strictEqual(own.data.businesses[0].id, orgId);

    const priceDenied = await api('PATCH', '/api/billing/prices', { main: 1 }, login.data.token);
    assert.strictEqual(priceDenied.status, 403);
  });
});

// ---- Specials menu screens + tablet sold-out control -------------------------------

test('menu-board channel screens and tablet sold-out toggles', async (t) => {
  let orgId, venueId, screenId, deviceKey, menuId, remoteToken;

  await t.test('setup: venue, basic screen, specials menu, console token', async () => {
    const org = await api('POST', '/api/orgs', { name: 'Specials Test Group' });
    orgId = org.data.id;
    const venue = await api('POST', '/api/venues', { name: 'Specials Hotel', org_id: orgId });
    venueId = venue.data.id;
    const screen = await api('POST', `/api/venues/${venueId}/screens`, { name: 'Kitchen Board' });
    screenId = screen.data.id;
    const hello = await api('POST', '/api/player/hello', {});
    deviceKey = hello.data.device_key;
    await api('POST', `/api/screens/${screenId}/pair`, { pairing_code: hello.data.pairing_code });
    await api('PATCH', `/api/screens/${screenId}`, { license: 'basic' });

    const menu = await api('POST', `/api/venues/${venueId}/menus`, {
      name: 'Specials', sections: [{ title: 'Tonight', items: [
        { name: 'Parma Night', price: 20 }, { name: 'Steak Special', price: 30 },
      ] }],
    });
    menuId = menu.data.id;
    remoteToken = (await api('POST', `/api/venues/${venueId}/remote-token`)).data.token;
  });

  await t.test('menu channel works on a BASIC screen and feeds the board widget', async () => {
    const bad = await api('PATCH', `/api/screens/${screenId}`, { channel: 'menu:nope' });
    assert.strictEqual(bad.status, 400);

    const set = await api('PATCH', `/api/screens/${screenId}`, { channel: `menu:${menuId}` });
    assert.strictEqual(set.status, 200);
    assert.strictEqual(set.data.channel, `menu:${menuId}`);
    assert.strictEqual(set.data.license, 'basic'); // no upgrade needed

    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.screen.channel, `menu:${menuId}`);
    assert.strictEqual(manifest.data.playlist.items[0].type, 'widget');
    assert.strictEqual(manifest.data.playlist.items[0].src, `menuboard:${menuId}`);
    // and racing is still refused on basic
    const racing = await api('PATCH', `/api/screens/${screenId}`, { channel: 'racing1' });
    assert.strictEqual(racing.status, 400);
  });

  await t.test('tablet toggles sold out; boards see it via the manifest', async () => {
    const state = await api('GET', `/api/remote/${remoteToken}`);
    assert.strictEqual(state.data.menus.length, 1);
    assert.strictEqual(state.data.menus[0].sections[0].items[1].name, 'Steak Special');

    const flip = await api('POST', `/api/remote/${remoteToken}/menus/${menuId}/sold-out`,
      { section: 0, item: 1, sold_out: true });
    assert.strictEqual(flip.status, 200);
    assert.strictEqual(flip.data.item.sold_out, true);

    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    const board = manifest.data.menus.find((m) => m.id === menuId);
    assert.strictEqual(board.sections[0].items[1].sold_out, true);
    assert.strictEqual(board.sections[0].items[0].sold_out, false);

    const restore = await api('POST', `/api/remote/${remoteToken}/menus/${menuId}/sold-out`,
      { section: 0, item: 1, sold_out: false });
    assert.strictEqual(restore.data.item.sold_out, false);

    const badIdx = await api('POST', `/api/remote/${remoteToken}/menus/${menuId}/sold-out`,
      { section: 9, item: 0, sold_out: true });
    assert.strictEqual(badIdx.status, 400);

    // another venue's console token cannot touch this menu
    const v2 = await api('POST', '/api/venues', { name: 'Other Pub', org_id: orgId });
    const t2 = (await api('POST', `/api/venues/${v2.data.id}/remote-token`)).data.token;
    const crossed = await api('POST', `/api/remote/${t2}/menus/${menuId}/sold-out`,
      { section: 0, item: 0, sold_out: true });
    assert.strictEqual(crossed.status, 404);
  });

  await t.test('deleting the menu drops the channel back to schedules', async () => {
    await api('DELETE', `/api/menus/${menuId}`);
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.data.playlist, null); // no schedule set up -> standby
  });
});
