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
process.env.KORVIX_ADMIN_TOKEN = '';

const { start, server } = require('../src/server');

let base;

async function api(method, urlPath, body) {
  const res = await fetch(base + urlPath, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

test.before(async () => {
  await start(0, '127.0.0.1');
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('full venue lifecycle', async (t) => {
  let venueId, zoneId, screenId, deviceKey, mediaId, playlistId;

  await t.test('create venue, zone, screen', async () => {
    const venue = await api('POST', '/api/venues', { name: 'Test Tavern', timezone: 'Australia/Sydney' });
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

  await t.test('unpair returns player to pending', async () => {
    await api('POST', `/api/screens/${screenId}/unpair`);
    const manifest = await api('GET', `/api/player/${deviceKey}/manifest`);
    assert.strictEqual(manifest.status, 404);
  });
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
});
