'use strict';

// Korvix Draws — staff remote PWA. Installs to an Android/iOS home screen and
// runs raffle draws on the venue's screens without dashboard access. Auths by
// the venue remote token: taken from the shared link (?t=...) on first open,
// then kept in localStorage so the installed app needs no token in its URL.

(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const urlToken = new URLSearchParams(location.search).get('t');
  if (urlToken) {
    localStorage.setItem('korvix.remote_token', urlToken);
    history.replaceState(null, '', '/remote/'); // keep the secret out of the address bar
  }
  const token = localStorage.getItem('korvix.remote_token');

  let state = null;
  let busy = false;
  const freshNumbers = new Set(); // draw ids whose latest number should pop

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/remote/sw.js');

  function showError(msg, fatal = false) {
    const el = $('error');
    el.style.display = 'block';
    el.textContent = msg;
    if (fatal) { $('connecting').style.display = 'none'; $('draws').innerHTML = ''; }
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `error ${res.status}`), { status: res.status });
    return data;
  }

  async function load() {
    if (!token) {
      showError('No access link. Ask your manager for the Draws app link from the Korvix dashboard.', true);
      return;
    }
    try {
      state = await api('GET', `/api/remote/${token}`);
      $('error').style.display = 'none';
      $('connecting').style.display = 'none';
      $('conn-state').textContent = '';
      render();
    } catch (err) {
      if (err.status === 404) {
        showError('This link has been revoked. Ask your manager for a new Draws app link.', true);
      } else {
        $('conn-state').textContent = 'offline — retrying…';
      }
    }
  }

  const moneyAud = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const CK_SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const ckFace = (c) => c === 'JOKER' ? '🃏' : c.slice(0, -1) + (CK_SUITS[c.slice(-1)] || '');

  function renderCashKing() {
    const game = state.card_game;
    if (!game || game.status === 'archived') { $('cashking').innerHTML = ''; return; }
    $('cashking').innerHTML = `
      <div class="card">
        <h2>🃏 ${esc(game.name)} <span class="pill ${game.live ? 'live' : game.won ? 'cleared' : 'ready'}">${game.won ? 'WON' : game.live ? 'live' : 'idle'}</span></h2>
        <div class="muted">${game.cards_left} cards left${game.session_text ? ` · ${esc(game.session_text)}` : ''}</div>
        <div class="number"><div class="n">${moneyAud(game.jackpot)}</div></div>
        ${game.won ? `<div class="prev" style="font-size:15px">🎉 Joker found — jackpot won!</div>` : ''}
        ${game.live && !game.won ? '<div class="prev">Tap the winner’s card to reveal it on all screens</div>' : ''}
        ${game.live ? `<div class="ck-grid">${game.cards.map((c) => {
          if (!c.revealed) return game.won ? `<div class="rev" style="opacity:.25">${c.i + 1}</div>` : `<button data-ck-pick="${c.i}">${c.i + 1}</button>`;
          const red = c.card && 'HD'.includes(c.card.slice(-1));
          return `<div class="rev${red ? ' red' : ''}${c.card === 'JOKER' ? ' joker' : ''}">${ckFace(c.card)}</div>`;
        }).join('')}</div>` : ''}
        ${game.live
          ? '<button class="btn-clear" data-ck="end">End session — screens back to normal</button>'
          : (game.won ? '' : `<button class="btn-live" data-ck="live">🔴 GO LIVE on all screens</button>`)}
      </div>`;
  }

  function render() {
    $('venue-name').textContent = state.venue.name;
    $('new-draw-wrap').style.display = 'block';
    renderCashKing();

    const zoneSel = $('nd-zone');
    const current = zoneSel.value;
    zoneSel.innerHTML = '<option value="">Show on: whole venue</option>' +
      state.zones.map((z) => `<option value="${z.id}">Show on: ${esc(z.name)} only</option>`).join('');
    zoneSel.value = current;

    const active = state.draws.filter((d) => d.status !== 'cleared' || d.drawn_numbers.length);
    $('draws').innerHTML = active.map((d) => {
      const prev = d.drawn_numbers.slice(0, -1);
      return `
      <div class="card">
        <h2>${esc(d.name)} <span class="pill ${d.status}">${d.status}</span></h2>
        <div class="muted">Tickets ${d.range_start}–${d.range_end}${d.zone_name ? ` · ${esc(d.zone_name)} screens` : ''} · ${d.remaining} left</div>
        ${d.latest_number != null ? `
          <div class="number"><div class="n ${freshNumbers.has(d.id) ? 'fresh' : ''}">#${d.latest_number}</div></div>
          ${prev.length ? `<div class="prev">Earlier: ${prev.map((n) => '#' + n).join('  ')}</div>` : ''}` : ''}
        <button class="btn-draw" data-spin="${d.id}" ${d.remaining <= 0 || busy ? 'disabled' : ''}>
          ${d.latest_number != null ? '🎲 DRAW AGAIN' : '🎲 DRAW NUMBER'}</button>
        ${d.status === 'live' ? `<button class="btn-clear" data-clear="${d.id}">Done — clear screens</button>` : ''}
      </div>`;
    }).join('') || '<div class="card muted" style="text-align:center">No draws set up yet — create one below.</div>';
    freshNumbers.clear();
  }

  document.body.addEventListener('click', async (e) => {
    const spin = e.target.closest('[data-spin]');
    const clear = e.target.closest('[data-clear]');
    const ckPick = e.target.closest('[data-ck-pick]');
    const ckAct = e.target.closest('[data-ck]');
    if (!spin && !clear && !ckPick && !ckAct) return;
    if (busy) return;
    busy = true;
    try {
      if (spin) {
        if (navigator.vibrate) navigator.vibrate(80);
        const updated = await api('POST', `/api/remote/${token}/draws/${spin.dataset.spin}/draw`);
        freshNumbers.add(updated.id);
      } else if (clear) {
        await api('POST', `/api/remote/${token}/draws/${clear.dataset.clear}/clear`);
      } else if (ckPick) {
        const n = parseInt(ckPick.dataset.ckPick, 10);
        if (!confirm(`Reveal card #${n + 1} on all screens?`)) { busy = false; return; }
        if (navigator.vibrate) navigator.vibrate(80);
        const result = await api('POST', `/api/remote/${token}/card-games/${state.card_game.id}/pick`, { index: n });
        if (result.was_joker && navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 300]);
      } else if (ckAct) {
        await api('POST', `/api/remote/${token}/card-games/${state.card_game.id}/${ckAct.dataset.ck === 'live' ? 'live' : 'end-session'}`);
      }
      await load();
    } catch (err) {
      showError(err.message);
      setTimeout(() => { $('error').style.display = 'none'; }, 4000);
    } finally {
      busy = false;
      render();
    }
  });

  $('nd-add').addEventListener('click', async () => {
    const name = $('nd-name').value.trim();
    if (!name) return showError('Give the draw a name first.');
    try {
      await api('POST', `/api/remote/${token}/draws`, {
        name,
        range_start: parseInt($('nd-start').value, 10),
        range_end: parseInt($('nd-end').value, 10),
        zone_id: $('nd-zone').value || null,
      });
      $('nd-name').value = '';
      $('new-draw-wrap').removeAttribute('open');
      await load();
    } catch (err) {
      showError(err.message);
      setTimeout(() => { $('error').style.display = 'none'; }, 4000);
    }
  });

  load();
  setInterval(load, 5000); // keep multiple staff phones in sync
})();
