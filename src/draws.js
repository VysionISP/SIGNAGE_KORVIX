'use strict';

// Shared raffle-draw spin logic (used by the admin API and the staff remote).

const crypto = require('node:crypto');
const db = require('./db');
const { HttpError } = require('./util');

function drawnNumbers(draw) {
  try { return JSON.parse(draw.drawn_numbers); } catch { return []; }
}

// Picks a uniformly random undrawn number, records it, and marks the draw
// live. Throws 409 when the range is exhausted. Returns the fresh row.
function spinDraw(draw) {
  const numbers = drawnNumbers(draw);
  const total = draw.range_end - draw.range_start + 1;
  if (numbers.length >= total) {
    throw new HttpError(409, 'all numbers in this range have been drawn');
  }
  const taken = new Set(numbers);
  let slot = crypto.randomInt(total - numbers.length);
  let picked = null;
  for (let n = draw.range_start; n <= draw.range_end; n++) {
    if (taken.has(n)) continue;
    if (slot === 0) { picked = n; break; }
    slot--;
  }
  numbers.push(picked);
  db.run("UPDATE draws SET drawn_numbers = ?, status = 'live', drawn_at = ? WHERE id = ?",
    JSON.stringify(numbers), db.now(), draw.id);
  return db.get('SELECT * FROM draws WHERE id = ?', draw.id);
}

function drawView(draw) {
  const numbers = drawnNumbers(draw);
  return {
    ...draw,
    drawn_numbers: numbers,
    latest_number: numbers[numbers.length - 1] ?? null,
    remaining: (draw.range_end - draw.range_start + 1) - numbers.length,
  };
}

module.exports = { spinDraw, drawView, drawnNumbers };
