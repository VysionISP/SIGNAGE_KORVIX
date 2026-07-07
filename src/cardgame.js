'use strict';

// CashKing game engine — a digital "Jag the Joker".
//
// A game owns a cryptographically shuffled deck of 53 cards (52 + JOKER).
// One card is revealed per game night: a miss bumps the jackpot by the
// configured increment and the game rolls on to next week; the Joker wins
// the jackpot and ends the game. Unrevealed card faces NEVER leave the
// server — players and the public feed only see face-down slots — so the
// Joker's position cannot be sniffed from network traffic.

const crypto = require('node:crypto');
const db = require('./db');
const { HttpError } = require('./util');

const SUIT_NAMES = { S: 'Spades', H: 'Hearts', D: 'Diamonds', C: 'Clubs' };
const RANK_NAMES = {
  A: 'Ace', J: 'Jack', Q: 'Queen', K: 'King',
  2: '2', 3: '3', 4: '4', 5: '5', 6: '6', 7: '7', 8: '8', 9: '9', 10: '10',
};

function newDeck() {
  const codes = ['JOKER'];
  for (const suit of Object.keys(SUIT_NAMES)) {
    for (const rank of Object.keys(RANK_NAMES)) codes.push(`${rank}${suit}`);
  }
  // Fisher-Yates with crypto randomness — fairness matters when money's on it.
  for (let i = codes.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [codes[i], codes[j]] = [codes[j], codes[i]];
  }
  return codes.map((c) => ({ c, r: null, by: null }));
}

function prettyCard(code) {
  if (code === 'JOKER') return 'the JOKER';
  const suit = code.slice(-1);
  const rank = code.slice(0, -1);
  return `the ${RANK_NAMES[rank] || rank} of ${SUIT_NAMES[suit] || suit}`;
}

function parseDeck(game) {
  try { return JSON.parse(game.deck); } catch { return []; }
}

function cardsLeft(deck) {
  return deck.filter((d) => !d.r).length;
}

// What screens and dashboards may see: face-down slots stay anonymous.
function boardView(game) {
  const deck = parseDeck(game);
  let lastPick = null;
  try { lastPick = game.last_pick ? JSON.parse(game.last_pick) : null; } catch { /* ignore */ }
  return {
    id: game.id,
    name: game.name,
    status: game.status,
    live: !!game.live,
    jackpot: game.jackpot_current,
    jackpot_increment: game.jackpot_increment,
    session_text: game.session_text,
    cards_left: cardsLeft(deck),
    cards: deck.map((d, i) => ({ i, revealed: !!d.r, card: d.r ? d.c : null, by: d.by })),
    last_pick: lastPick,
    won: game.status === 'won',
    won_at: game.won_at,
  };
}

// Compact promo view for widgets, the public feed and marketing posts.
function promoView(game, venueName) {
  const deck = parseDeck(game);
  let lastPick = null;
  try { lastPick = game.last_pick ? JSON.parse(game.last_pick) : null; } catch { /* ignore */ }
  return {
    name: game.name,
    venue: venueName,
    status: game.status,
    live: !!game.live,
    jackpot: game.jackpot_current,
    jackpot_increment: game.jackpot_increment,
    cards_left: cardsLeft(deck),
    session_text: game.session_text,
    last_card: lastPick ? { card: lastPick.card, pretty: prettyCard(lastPick.card), at: lastPick.at, was_joker: lastPick.was_joker } : null,
    won_at: game.won_at,
  };
}

const money = (n) => '$' + Number(n).toLocaleString('en-AU', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Marketing copy for each event — ready to pipe into socials/email via the
// game's promo webhook (Zapier/Make/anything that takes JSON with `text`).
function promoText(event, game, venueName) {
  const deck = parseDeck(game);
  const left = cardsLeft(deck);
  switch (event) {
    case 'live':
      return `🃏 ${game.name} is LIVE at ${venueName}! Tonight someone plays for ${money(game.jackpot_current)}.`;
    case 'miss': {
      const lp = JSON.parse(game.last_pick);
      return `🃏 ${game.name} at ${venueName}: card #${lp.index + 1} was ${prettyCard(lp.card)} — no Joker! `
        + `The jackpot rolls up to ${money(game.jackpot_current)} with ${left} cards left. ${game.session_text}`.trim();
    }
    case 'won':
      return `🎉 JOKER FOUND! ${game.name} at ${venueName} has been WON — ${money(game.jackpot_current)}! A new game starts soon.`;
    case 'created':
      return `🃏 A new ${game.name} game has started at ${venueName}! Jackpot starts at ${money(game.jackpot_current)} `
        + `and grows every week it isn't won. ${game.session_text}`.trim();
    default:
      return `${game.name} at ${venueName}: jackpot ${money(game.jackpot_current)}, ${left} cards left.`;
  }
}

async function fireWebhook(game, venueName, event) {
  if (!game.promo_webhook) return;
  const payload = {
    event: `cashking.${event}`,
    text: promoText(event, game, venueName),
    game: promoView(game, venueName),
  };
  try {
    await fetch(game.promo_webhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error('[korvix] cashking promo webhook failed:', err.message);
  }
}

function createGame(venueId, opts = {}) {
  const start = Number(opts.jackpot_start);
  const increment = Number(opts.jackpot_increment);
  if (!Number.isFinite(start) || start < 0) throw new HttpError(400, 'jackpot_start must be a number');
  if (!Number.isFinite(increment) || increment < 0) throw new HttpError(400, 'jackpot_increment must be a number');
  const gameId = db.id();
  db.run(
    `INSERT INTO card_games (id, venue_id, name, deck, jackpot_start, jackpot_increment, jackpot_current,
       session_text, promo_webhook, public_token, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    gameId, venueId, opts.name || 'CashKing', JSON.stringify(newDeck()),
    start, increment, start,
    opts.session_text || '', opts.promo_webhook || '',
    crypto.randomBytes(16).toString('hex'), db.now());
  return db.get('SELECT * FROM card_games WHERE id = ?', gameId);
}

// Reveal one card. Miss -> jackpot += increment. Joker -> game won.
function pickCard(game, index, pickedBy = '') {
  if (game.status !== 'active') throw new HttpError(409, `game is ${game.status} — start a new game`);
  const deck = parseDeck(game);
  const slot = deck[index];
  if (!slot) throw new HttpError(400, `card index must be 0-${deck.length - 1}`);
  if (slot.r) throw new HttpError(409, `card #${index + 1} is already revealed (${prettyCard(slot.c)})`);

  slot.r = db.now();
  slot.by = String(pickedBy || '');
  const wasJoker = slot.c === 'JOKER';
  const lastPick = JSON.stringify({ index, card: slot.c, was_joker: wasJoker, by: slot.by, at: slot.r });

  if (wasJoker) {
    db.run("UPDATE card_games SET deck = ?, last_pick = ?, status = 'won', won_at = ? WHERE id = ?",
      JSON.stringify(deck), lastPick, db.now(), game.id);
  } else {
    db.run('UPDATE card_games SET deck = ?, last_pick = ?, jackpot_current = jackpot_current + jackpot_increment WHERE id = ?',
      JSON.stringify(deck), lastPick, game.id);
  }
  return { game: db.get('SELECT * FROM card_games WHERE id = ?', game.id), wasJoker };
}

// The current (not archived) game for a venue, newest first.
function currentGame(venueId) {
  return db.get(
    "SELECT * FROM card_games WHERE venue_id = ? AND status != 'archived' ORDER BY created_at DESC LIMIT 1",
    venueId) || null;
}

module.exports = { createGame, pickCard, currentGame, boardView, promoView, promoText, fireWebhook, prettyCard, parseDeck, cardsLeft };
