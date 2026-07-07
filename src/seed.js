'use strict';

// Seeds a complete demo venue — "The Korvix Tavern" — with zones, screens,
// content, playlists, dayparted schedules and live integration feeds, so the
// platform demonstrates itself on first run. Runs only when the DB is empty.

const db = require('./db');

function slide(bg, body) {
  return `<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:${bg};color:#fff;font-family:system-ui,sans-serif;padding:4vw;box-sizing:border-box">${body}</div>`;
}

function seedDemo() {
  const now = db.now();
  const orgId = db.id();
  db.run('INSERT INTO orgs (id, name, created_at) VALUES (?, ?, ?)',
    orgId, 'Demo Hospitality Group', now);
  const venueId = db.id();
  db.run('INSERT INTO venues (id, org_id, name, timezone, address, latitude, longitude, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    venueId, orgId, 'The Korvix Tavern', 'Australia/Sydney', '42 Demo Street, Sydney NSW', -33.8688, 151.2093, now);

  const zoneNames = ['Entrance', 'Main Bar', 'Bistro', 'Gaming Room', 'Sports Bar', 'Function Room'];
  const zones = {};
  for (const name of zoneNames) {
    const zoneId = db.id();
    db.run('INSERT INTO zones (id, venue_id, name) VALUES (?, ?, ?)', zoneId, venueId, name);
    zones[name] = zoneId;
  }

  const screens = [
    ['Entrance Portrait', 'Entrance', 'portrait'],
    ['Bar LED Wall', 'Main Bar', 'landscape'],
    ['Bistro Menu Board 1', 'Bistro', 'landscape'],
    ['Bistro Menu Board 2', 'Bistro', 'landscape'],
    ['Gaming Jackpot Display', 'Gaming Room', 'landscape'],
    ['Sports Bar Main', 'Sports Bar', 'landscape'],
    ['Function Room Door Sign', 'Function Room', 'portrait'],
  ];
  for (const [name, zone, orientation] of screens) {
    db.run('INSERT INTO screens (id, venue_id, zone_id, name, orientation, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      db.id(), venueId, zones[zone], name, orientation, now);
  }

  function media(name, type, { src = '', content = '', duration = 10 } = {}) {
    const mediaId = db.id();
    db.run('INSERT INTO media (id, venue_id, name, type, src, content, duration_seconds, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      mediaId, venueId, name, type, src, content, duration, now);
    return mediaId;
  }

  const m = {
    welcome: media('Welcome / opening hours', 'widget', { src: 'welcome', duration: 12 }),
    breakfast: media('Breakfast menu', 'html', {
      duration: 15,
      content: slide('linear-gradient(135deg,#3d2b1f,#8a5a2b)',
        '<div style="font-size:2vw;letter-spacing:.4em;opacity:.8">THE KORVIX TAVERN</div><h1 style="font-size:6vw;margin:.3em 0">Breakfast &middot; from 7am</h1><div style="font-size:2.6vw;line-height:1.9">Big Brekky &mdash; $19.90<br>Eggs Benedict &mdash; $17.50<br>Avo Smash &mdash; $15.00<br>Barista coffee &mdash; $4.50</div>'),
    }),
    lunch: media('Lunch menu', 'html', {
      duration: 15,
      content: slide('linear-gradient(135deg,#1d3a2a,#3f7d4e)',
        '<div style="font-size:2vw;letter-spacing:.4em;opacity:.8">BISTRO</div><h1 style="font-size:6vw;margin:.3em 0">Lunch &middot; 11:30&ndash;3</h1><div style="font-size:2.6vw;line-height:1.9">Chicken Schnitzel &mdash; $18.50<br>Steak Sandwich &mdash; $21.00<br>Caesar Salad &mdash; $16.50<br>$12 Lunch Specials weekdays</div>'),
    }),
    dinner: media('Dinner menu', 'html', {
      duration: 15,
      content: slide('linear-gradient(135deg,#241b3a,#5b2a6e)',
        '<div style="font-size:2vw;letter-spacing:.4em;opacity:.8">BISTRO</div><h1 style="font-size:6vw;margin:.3em 0">Dinner &middot; from 6pm</h1><div style="font-size:2.6vw;line-height:1.9">300g Rump &mdash; $32.00<br>Grilled Barramundi &mdash; $29.50<br>Pumpkin Risotto &mdash; $24.00<br>Kids eat free Sundays</div>'),
    }),
    menuBoard: media('Live menu board (POS feed)', 'widget', { src: 'menu', duration: 15 }),
    happyHour: media('Happy hour', 'html', {
      duration: 10,
      content: slide('linear-gradient(135deg,#7a3b00,#e8590c)',
        '<h1 style="font-size:7vw;margin:.2em 0">HAPPY HOUR</h1><div style="font-size:3.2vw">3pm &ndash; 6pm daily</div><div style="font-size:2.6vw;line-height:1.9;margin-top:1em">$6 schooners &middot; $8 house wine<br>$10 cocktails</div>'),
    }),
    taps: media('On tap tonight', 'html', {
      duration: 12,
      content: slide('linear-gradient(135deg,#10222e,#1f5a7a)',
        '<div style="font-size:2vw;letter-spacing:.4em;opacity:.8">MAIN BAR</div><h1 style="font-size:5.5vw;margin:.3em 0">On Tap</h1><div style="font-size:2.6vw;line-height:1.9">Korvix Lager &mdash; $8.50<br>Coastal Pale Ale &mdash; $9.50<br>Ginger Cider &mdash; $9.00<br>Guest tap: ask at the bar</div>'),
    }),
    liveMusic: media('Live music Friday', 'html', {
      duration: 10,
      content: slide('linear-gradient(135deg,#2b0f2e,#a1123d)',
        '<div style="font-size:2vw;letter-spacing:.4em;opacity:.8">THIS FRIDAY</div><h1 style="font-size:6.5vw;margin:.2em 0">LIVE MUSIC</h1><div style="font-size:3vw">The Flannel Shirts &middot; 7:30pm<br>Free entry &middot; Main Bar</div>'),
    }),
    poker: media('Poker night', 'html', {
      duration: 10,
      content: slide('linear-gradient(135deg,#0d2818,#14532d)',
        '<h1 style="font-size:6vw;margin:.2em 0">POKER NIGHT</h1><div style="font-size:3vw">Thursdays from 9pm</div><div style="font-size:2.4vw;margin-top:.8em;opacity:.9">$1,000 prize pool &middot; register at the bar</div>'),
    }),
    jackpot: media('Gaming jackpot (live feed)', 'widget', { src: 'jackpot', duration: 12 }),
    birthdays: media('Member birthdays (live feed)', 'widget', { src: 'birthdays', duration: 10 }),
    happyHourCountdown: media('Happy hour countdown (live)', 'widget', { src: 'happyhour', duration: 10 }),
    rgMessage: media('Responsible gambling message', 'html', {
      duration: 8,
      content: slide('#1a1a1a',
        '<div style="font-size:3vw;line-height:1.7;max-width:70%">What&rsquo;s gambling really costing you?<br>Set a limit and stick to it.</div><div style="font-size:2vw;margin-top:1.2em;opacity:.8">Gambling Help 1800 858 858 &middot; gamblinghelponline.org.au</div>'),
    }),
    sports: media('Sports schedule (live feed)', 'widget', { src: 'sports', duration: 12 }),
    weather: media('Local weather (live feed)', 'widget', { src: 'weather', duration: 8 }),
    membership: media('Membership promo', 'html', {
      duration: 10,
      content: slide('linear-gradient(135deg,#00343f,#00707f)',
        '<h1 style="font-size:5.5vw;margin:.2em 0">Become a Member</h1><div style="font-size:2.8vw;line-height:1.8">$5 a year &middot; member drink prices<br>birthday rewards &middot; weekly member draw</div><div style="font-size:2.2vw;margin-top:1em;opacity:.85">Sign up at reception</div>'),
    }),
    functions: media('Function room promo', 'html', {
      duration: 10,
      content: slide('linear-gradient(135deg,#3a2d0f,#8a6d1b)',
        '<h1 style="font-size:5vw;margin:.2em 0">Celebrate With Us</h1><div style="font-size:2.6vw;line-height:1.8">Birthdays &middot; engagements &middot; wakes &middot; corporate<br>Function rooms from $150</div><div style="font-size:2.2vw;margin-top:1em;opacity:.85">functions@korvixtavern.com.au</div>'),
    }),
  };

  function playlist(name, mediaIds) {
    const playlistId = db.id();
    db.run('INSERT INTO playlists (id, venue_id, name, created_at) VALUES (?, ?, ?, ?)',
      playlistId, venueId, name, now);
    mediaIds.forEach((mediaId, i) => {
      db.run('INSERT INTO playlist_items (id, playlist_id, media_id, position) VALUES (?, ?, ?, ?)',
        db.id(), playlistId, mediaId, i);
    });
    return playlistId;
  }

  const p = {
    entrance: playlist('Entrance loop', [m.welcome, m.membership, m.birthdays, m.liveMusic, m.weather, m.functions]),
    barDay: playlist('Bar — daytime', [m.taps, m.weather, m.happyHourCountdown, m.liveMusic, m.membership]),
    barHappy: playlist('Bar — happy hour', [m.happyHour, m.taps, m.liveMusic]),
    barNight: playlist('Bar — evening', [m.taps, m.liveMusic, m.poker, m.membership]),
    breakfast: playlist('Bistro — breakfast', [m.breakfast, m.weather]),
    lunch: playlist('Bistro — lunch', [m.lunch, m.menuBoard, m.membership]),
    dinner: playlist('Bistro — dinner', [m.dinner, m.menuBoard, m.liveMusic]),
    gaming: playlist('Gaming room loop', [m.jackpot, m.rgMessage, m.membership]),
    sportsBar: playlist('Sports bar loop', [m.sports, m.taps, m.happyHour]),
    functions: playlist('Function room loop', [m.functions, m.welcome]),
  };

  function schedule(name, playlistId, { zone = null, start = '00:00', end = '24:00', priority = 0, days = [0, 1, 2, 3, 4, 5, 6] } = {}) {
    db.run(
      `INSERT INTO schedules (id, venue_id, zone_id, screen_id, playlist_id, name, days_of_week, start_time, end_time, priority, active)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 1)`,
      db.id(), venueId, zone ? zones[zone] : null, playlistId, name,
      JSON.stringify(days), start, end, priority);
  }

  // Venue-wide fallback so every screen always has something.
  schedule('All day — entrance loop (fallback)', p.entrance, { priority: -10 });

  schedule('Entrance — all day', p.entrance, { zone: 'Entrance' });
  schedule('Bar — daytime', p.barDay, { zone: 'Main Bar', start: '10:00', end: '15:00' });
  schedule('Bar — happy hour', p.barHappy, { zone: 'Main Bar', start: '15:00', end: '18:00', priority: 5 });
  schedule('Bar — evening', p.barNight, { zone: 'Main Bar', start: '18:00', end: '02:00' });
  schedule('Bistro — breakfast', p.breakfast, { zone: 'Bistro', start: '07:00', end: '11:30' });
  schedule('Bistro — lunch', p.lunch, { zone: 'Bistro', start: '11:30', end: '15:00' });
  schedule('Bistro — dinner', p.dinner, { zone: 'Bistro', start: '17:30', end: '21:30' });
  schedule('Gaming — all day', p.gaming, { zone: 'Gaming Room' });
  schedule('Sports bar — all day', p.sportsBar, { zone: 'Sports Bar' });
  schedule('Function room — all day', p.functions, { zone: 'Function Room' });

  function feed(source, payload) {
    db.run('INSERT INTO feeds (venue_id, source, payload, updated_at) VALUES (?, ?, ?, ?)',
      venueId, source, JSON.stringify(payload), now);
  }

  feed('gaming', {
    jackpots: [
      { name: 'Mega Link Grand', amount: 12847.5 },
      { name: 'Cash Express', amount: 3210.85 },
      { name: 'Members Draw', amount: 850 },
    ],
  });
  feed('weather', { location: 'Sydney', temp_c: 21, condition: 'Partly cloudy', high_c: 24, low_c: 14 });
  feed('pos', {
    specials: [
      { name: 'Chicken Schnitzel + schooner', price: 22.0 },
      { name: '250g Rump Tuesday', price: 20.0 },
      { name: 'Fish Friday', price: 24.5 },
    ],
    sold_out: ['Pumpkin Risotto'],
    happy_hour: { active: false, from: '15:00', to: '18:00' },
  });
  feed('membership', {
    birthdays: [{ name: 'Karen M.' }, { name: 'Dave T.' }, { name: 'Robbo' }],
  });
  feed('sports', {
    fixtures: [
      { league: 'AFL', match: 'Swans v Magpies', when: 'Fri 7:40pm', channel: 'Main screens' },
      { league: 'NRL', match: 'Rabbitohs v Roosters', when: 'Sat 5:30pm', channel: 'Sports bar' },
      { league: 'A-League', match: 'Sydney FC v Victory', when: 'Sat 7:45pm', channel: 'Back bar' },
    ],
  });

  db.run(
    `INSERT INTO draws (id, venue_id, zone_id, name, range_start, range_end, created_at)
     VALUES (?, ?, NULL, ?, 1, 200, ?)`,
    db.id(), venueId, 'Friday Meat Raffle', now);

  db.logEvent('venue.seeded', { venueId, detail: 'The Korvix Tavern demo venue' });
  return venueId;
}

module.exports = seedDemo;
