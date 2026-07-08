'use strict';

// Racing feed poller. Venues with a racing_jurisdiction set get a 'racing'
// feed refreshed from the TAB next-to-go public API every ~45s: the next
// races in order, plus best-effort results captured as races jump (max a
// couple of detail calls per cycle, so we stay polite). Screens on the
// racing channels render this feed with a live countdown.
//
// Venues with a licensed data supplier can instead push to the generic
// webhook (POST /api/integrations/:venueId/racing) with the same shape:
//   { races: [{meeting, number, name, type, start, distance, location}],
//     results: [{meeting, number, placings: ["1st #4 Name", ...]}] }

const db = require('./db');

const NTG_URL = (jurisdiction) =>
  `https://api.beta.tab.com.au/v1/tab-info-service/racing/next-to-go/races?jurisdiction=${jurisdiction}&maxRaces=12`;
const DETAIL_URL = (jurisdiction, r) =>
  `https://api.beta.tab.com.au/v1/tab-info-service/racing/dates/${r.date}/meetings/${r.type}/${r.mnemonic}/races/${r.number}?jurisdiction=${jurisdiction}`;

const MAX_DETAIL_CALLS = 2;   // per jurisdiction per cycle
const RESULTS_KEPT = 8;

// Races we saw jump, per jurisdiction, still awaiting a result.
const pendingResults = new Map(); // jurisdiction -> Map(key -> race)

const raceKey = (r) => `${r.date}:${r.mnemonic}:${r.number}`;

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`racing api ${res.status}`);
  return res.json();
}

function normalizeNtg(data) {
  return (data.races || []).map((race) => ({
    meeting: race.meeting?.meetingName || '',
    location: race.meeting?.location || '',
    type: race.meeting?.raceType || 'R',      // R gallops | H harness | G greyhounds
    mnemonic: race.meeting?.venueMnemonic || '',
    date: race.meeting?.meetingDate || '',
    number: race.raceNumber,
    name: race.raceName || '',
    distance: race.raceDistance || null,
    start: race.raceStartTime,                 // ISO — players count down client-side
  })).filter((r) => r.meeting && r.start);
}

function extractPlacings(detail) {
  // detail.results: array of runner-number arrays by placing; runners: names.
  if (!Array.isArray(detail.results) || !detail.results.length) return null;
  const names = new Map((detail.runners || []).map((run) => [run.runnerNumber, run.runnerName]));
  const ordinal = ['1st', '2nd', '3rd', '4th'];
  return detail.results.slice(0, 3).map((group, i) =>
    `${ordinal[i]} ${[].concat(group).map((n) => `#${n} ${names.get(n) || ''}`.trim()).join(' / ')}`);
}

async function pollJurisdiction(jurisdiction, previousPayload) {
  const races = normalizeNtg(await fetchJson(NTG_URL(jurisdiction)));

  // Track races that have jumped so we can chase their results.
  let pending = pendingResults.get(jurisdiction);
  if (!pending) pendingResults.set(jurisdiction, (pending = new Map()));
  const now = Date.now();
  for (const race of races) {
    if (Date.parse(race.start) < now && !pending.has(raceKey(race))) {
      pending.set(raceKey(race), { ...race, jumpedAt: now });
    }
  }

  const results = Array.isArray(previousPayload?.results) ? [...previousPayload.results] : [];
  let detailCalls = 0;
  for (const [key, race] of pending) {
    if (now - race.jumpedAt > 60 * 60 * 1000) { pending.delete(key); continue; } // stale, give up
    if (detailCalls >= MAX_DETAIL_CALLS) break;
    detailCalls++;
    try {
      const placings = extractPlacings(await fetchJson(DETAIL_URL(jurisdiction, race)));
      if (placings) {
        pending.delete(key);
        results.unshift({
          meeting: race.meeting, number: race.number, type: race.type,
          name: race.name, placings, at: db.now(),
        });
      }
    } catch { /* race not settled yet or api hiccup — retry next cycle */ }
  }

  return {
    jurisdiction,
    races: races.slice(0, 8),
    results: results.slice(0, RESULTS_KEPT),
  };
}

async function pollOnce() {
  const venues = db.all(
    "SELECT * FROM venues WHERE racing_jurisdiction IS NOT NULL AND racing_jurisdiction != ''");
  if (!venues.length) return;

  const byJurisdiction = new Map();
  for (const venue of venues) {
    const jur = venue.racing_jurisdiction.toUpperCase();
    if (!byJurisdiction.has(jur)) byJurisdiction.set(jur, []);
    byJurisdiction.get(jur).push(venue);
  }

  for (const [jurisdiction, jurVenues] of byJurisdiction) {
    let payload;
    try {
      const prevRow = db.get('SELECT payload FROM feeds WHERE venue_id = ? AND source = ?', jurVenues[0].id, 'racing');
      const previous = prevRow ? JSON.parse(prevRow.payload) : null;
      payload = await pollJurisdiction(jurisdiction, previous);
    } catch (err) {
      console.error(`[korvix] racing poll failed for ${jurisdiction}:`, err.message);
      continue;
    }
    const json = JSON.stringify(payload);
    for (const venue of jurVenues) {
      const existing = db.get('SELECT payload FROM feeds WHERE venue_id = ? AND source = ?', venue.id, 'racing');
      const changed = !existing || existing.payload !== json;
      db.run(
        `INSERT INTO feeds (venue_id, source, payload, updated_at) VALUES (?, 'racing', ?, ?)
         ON CONFLICT (venue_id, source) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        venue.id, json, db.now());
      // Only wake screens when the card actually changed — countdowns tick
      // client-side, so a same-list refresh needs no nudge.
      if (changed) require('./routes/admin').nudgeVenue(venue.id);
    }
  }
}

function start() {
  setInterval(() => { pollOnce().catch(() => {}); }, 45 * 1000).unref();
  setTimeout(() => { pollOnce().catch(() => {}); }, 3000).unref();
}

module.exports = { start, pollOnce };
