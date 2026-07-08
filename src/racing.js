'use strict';

// Racing feed poller with automatic source failover.
//
// Venues with a racing_jurisdiction set get a 'racing' feed refreshed every
// ~45s. Sources, tried in order until one works (the winner is remembered
// and retried first next cycle):
//   1. TAB info-service next-to-go   — blocked from some datacenter IPs
//   2. Ladbrokes public racing API   — same national next-to-go data
// Force one with KORVIX_RACING_SOURCE=tab|ladbrokes (default: auto).
//
// Results are chased best-effort after races jump (a couple of polite detail
// calls per cycle). Venues with a licensed supplier can bypass all of this by
// pushing to POST /api/integrations/:venueId/racing with the same shape:
//   { races: [{meeting, number, name, type, start, distance, location}],
//     results: [{meeting, number, placings: ["1st #4 Name", ...]}] }

const db = require('./db');

const SOURCE_MODE = (process.env.KORVIX_RACING_SOURCE || 'auto').toLowerCase();
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const MAX_DETAIL_CALLS = 2;   // per jurisdiction per cycle
const RESULTS_KEPT = 8;

let preferredSource = null;   // last source that worked

// Races we saw jump, per jurisdiction, still awaiting a result.
const pendingResults = new Map(); // jurisdiction -> Map(key -> race)

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { accept: 'application/json', 'user-agent': UA },
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) throw new Error(`racing api ${res.status}`);
  return res.json();
}

// ---- source: TAB info-service ------------------------------------------------

function normalizeTab(data) {
  return (data.races || []).map((race) => ({
    meeting: race.meeting?.meetingName || '',
    location: race.meeting?.location || '',
    type: race.meeting?.raceType || 'R',      // R gallops | H harness | G greyhounds
    number: race.raceNumber,
    name: race.raceName || '',
    distance: race.raceDistance || null,
    start: race.raceStartTime,                 // ISO — players count down client-side
    source: 'tab',
    detail: {
      date: race.meeting?.meetingDate || '',
      mnemonic: race.meeting?.venueMnemonic || '',
      type: race.meeting?.raceType || 'R',
    },
  })).filter((r) => r.meeting && r.start);
}

async function fetchTab(jurisdiction) {
  const data = await fetchJson(
    `https://api.beta.tab.com.au/v1/tab-info-service/racing/next-to-go/races?jurisdiction=${jurisdiction}&maxRaces=12`);
  return normalizeTab(data);
}

function tabPlacings(detail) {
  if (!Array.isArray(detail.results) || !detail.results.length) return null;
  const names = new Map((detail.runners || []).map((run) => [run.runnerNumber, run.runnerName]));
  const ordinal = ['1st', '2nd', '3rd'];
  return detail.results.slice(0, 3).map((group, i) =>
    `${ordinal[i]} ${[].concat(group).map((n) => `#${n} ${names.get(n) || ''}`.trim()).join(' / ')}`);
}

async function fetchTabResult(jurisdiction, race) {
  const d = race.detail || {};
  const data = await fetchJson(
    `https://api.beta.tab.com.au/v1/tab-info-service/racing/dates/${d.date}/meetings/${d.type}/${d.mnemonic}/races/${race.number}?jurisdiction=${jurisdiction}`);
  return tabPlacings(data);
}

// ---- source: Ladbrokes public API ---------------------------------------------

const LB_CATEGORY = {
  '4a2788f8-e825-4d36-9894-efd4baf1cfae': 'R', // thoroughbred
  '161d9be2-e909-4326-8c2c-35ed71fb460b': 'H', // harness
  '9daef0d7-bf3c-4f50-921d-8e818c60fe61': 'G', // greyhounds
};

function normalizeLadbrokes(data) {
  const d = data.data || {};
  const summaries = d.race_summaries || {};
  const order = Array.isArray(d.next_to_go_ids) && d.next_to_go_ids.length
    ? d.next_to_go_ids : Object.keys(summaries);
  return order.map((id) => summaries[id]).filter(Boolean)
    .filter((r) => !r.venue_country || r.venue_country === 'AUS' || r.venue_country === 'NZL')
    .map((r) => {
      const dist = r.race_form?.distance;
      const seconds = r.advertised_start?.seconds ?? r.advertised_start;
      return {
        meeting: r.meeting_name || r.venue_name || '',
        location: r.venue_state || r.venue_country || '',
        type: LB_CATEGORY[r.category_id] || 'R',
        number: r.race_number,
        name: r.race_name || '',
        distance: (dist && typeof dist === 'object' ? dist.distance : dist) || null,
        start: Number(seconds) ? new Date(Number(seconds) * 1000).toISOString() : null,
        source: 'ladbrokes',
        detail: { race_id: r.race_id || r.id || null },
      };
    }).filter((r) => r.meeting && r.start);
}

async function fetchLadbrokes() {
  const data = await fetchJson('https://api.ladbrokes.com.au/rest/v1/racing/?method=nextraces&count=15');
  return normalizeLadbrokes(data);
}

// Results shape on this API varies; extract defensively and give up quietly.
function ladbrokesPlacings(data) {
  const results = data?.data?.results || data?.results;
  if (!Array.isArray(results) || !results.length) return null;
  const ordinal = { 1: '1st', 2: '2nd', 3: '3rd' };
  const top = results
    .filter((r) => Number(r.position || r.place) >= 1 && Number(r.position || r.place) <= 3)
    .sort((a, b) => Number(a.position || a.place) - Number(b.position || b.place))
    .map((r) => `${ordinal[Number(r.position || r.place)]} #${r.runner_number ?? r.number ?? '?'} ${r.name || r.runner_name || ''}`.trim());
  return top.length ? top : null;
}

async function fetchLadbrokesResult(race) {
  if (!race.detail?.race_id) return null;
  const data = await fetchJson(
    `https://api.ladbrokes.com.au/rest/v1/racing/?method=racecard&id=${race.detail.race_id}`);
  return ladbrokesPlacings(data);
}

// ---- polling --------------------------------------------------------------------

const raceKey = (r) => r.detail?.race_id || `${r.detail?.date}:${r.detail?.mnemonic}:${r.number}`;

async function fetchRaces(jurisdiction) {
  const order = SOURCE_MODE === 'tab' ? ['tab']
    : SOURCE_MODE === 'ladbrokes' ? ['ladbrokes']
      : preferredSource === 'ladbrokes' ? ['ladbrokes', 'tab'] : ['tab', 'ladbrokes'];
  let lastErr = null;
  for (const source of order) {
    try {
      const races = source === 'tab' ? await fetchTab(jurisdiction) : await fetchLadbrokes();
      if (races.length) {
        if (preferredSource !== source) console.log(`[korvix] racing feed using ${source} (${jurisdiction})`);
        preferredSource = source;
        return { races, source };
      }
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('no racing source returned races');
}

async function pollJurisdiction(jurisdiction, previousPayload) {
  const { races, source } = await fetchRaces(jurisdiction);

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
      const placings = race.source === 'tab'
        ? await fetchTabResult(jurisdiction, race)
        : await fetchLadbrokesResult(race);
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
    source,
    races: races.slice(0, 8).map(({ detail, ...race }) => race), // keep internals out of the feed
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

module.exports = { start, pollOnce, normalizeTab, normalizeLadbrokes, ladbrokesPlacings };
