'use strict';

// Korvix Games — the venue games console (installable PWA for the venue
// tablet / staff phones). Home screen lists every game with live status;
// tap in to run one. Auths by the venue token from the /games/<token> link:
// captured from the URL on first open, then kept in localStorage.

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
  let view = 'home'; // home | cashking | draws | emergency
  let busy = false;
  const freshNumbers = new Set(); // draw ids whose latest number should pop

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/remote/sw.js');

  const moneyAud = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const CK_SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const ckFace = (c) => c === 'JOKER' ? '🃏' : c.slice(0, -1) + (CK_SUITS[c.slice(-1)] || '');

  function showError(msg, fatal = false) {
    const el = $('error');
    el.style.display = 'block';
    el.textContent = msg;
    if (fatal) { $('connecting').style.display = 'none'; $('views').innerHTML = ''; }
  }
  function flashError(msg) {
    showError(msg);
    setTimeout(() => { $('error').style.display = 'none'; }, 4000);
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
      showError('No access link. Ask your manager for the games console link from the Korvix dashboard.', true);
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
        showError('This link has been revoked. Ask your manager for a new games console link.', true);
      } else {
        $('conn-state').textContent = 'offline — retrying…';
      }
    }
  }

  // ---- rendering ---------------------------------------------------------------

  function render() {
    if (!state) return;
    // Don't clobber a form the user is typing into (5s poll re-renders).
    const active = document.activeElement;
    if (active && $('views').contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;

    $('venue-name').textContent = state.venue.name;
    renderBanner();
    const views = { home: homeHtml, cashking: cashkingHtml, draws: drawsHtml, emergency: emergencyHtml };
    $('views').innerHTML = (views[view] || homeHtml)();
    freshNumbers.clear();
  }

  function renderBanner() {
    const banner = $('em-banner');
    const em = state.emergency;
    if (!em) { banner.style.display = 'none'; return; }
    banner.style.display = 'block';
    banner.innerHTML = `🚨 ${esc(em.level.toUpperCase())}: ${esc(em.title)} — LIVE ON ALL SCREENS` +
      (em.venue_scoped
        ? '<button class="btn-clear" data-em-clear style="margin-top:12px;background:#fff;color:#7f1d1d;font-weight:800">✅ ALL CLEAR — end broadcast</button>'
        : '<div style="font-size:13px;font-weight:400;margin-top:8px;opacity:.9">Issued by Korvix for all venues — it will be cleared centrally.</div>');
  }

  const backBtn = '<button class="back" data-nav="home">← All games</button>';

  function homeHtml() {
    const game = state.card_game && state.card_game.status !== 'archived' ? state.card_game : null;
    const ckSub = !game ? 'No game running — tap to start one'
      : game.won ? `WON ${moneyAud(game.jackpot)} — tap to start the next game`
        : `${moneyAud(game.jackpot)} jackpot · ${game.cards_left} cards left${game.live ? ' · LIVE ON SCREENS' : ''}`;

    const activeDraws = state.draws.filter((d) => d.status !== 'cleared' || d.drawn_numbers.length);
    const liveDraw = state.draws.find((d) => d.status === 'live');
    const drawSub = liveDraw ? `#${liveDraw.latest_number} on screens now — ${esc(liveDraw.name)}`
      : activeDraws.length ? `${activeDraws.length} draw${activeDraws.length === 1 ? '' : 's'} set up — tap to run`
        : 'Tap to set up a raffle draw';

    return `
      <button class="tile" data-nav="cashking">
        <span class="emoji">🃏</span>
        <span><span class="t-title">CashKing</span><br><span class="t-sub">${ckSub}</span></span>
        <span class="t-go">›</span>
      </button>
      <button class="tile" data-nav="draws">
        <span class="emoji">🎰</span>
        <span><span class="t-title">Raffle Draws</span><br><span class="t-sub">${drawSub}</span></span>
        <span class="t-go">›</span>
      </button>
      <button class="tile em ${state.emergency ? 'active' : ''}" data-nav="emergency">
        <span class="emoji">🚨</span>
        <span><span class="t-title">Emergency</span><br><span class="t-sub">${state.emergency ? 'BROADCAST ACTIVE — tap to manage' : 'Take over every screen with an alert'}</span></span>
        <span class="t-go">›</span>
      </button>`;
  }

  // ---- CashKing view -------------------------------------------------------------

  function cashkingHtml() {
    const game = state.card_game && state.card_game.status !== 'archived' ? state.card_game : null;
    if (!game) {
      return `${backBtn}
      <div class="card">
        <h2>🃏 Start a CashKing game</h2>
        <div class="muted">53 shuffled cards on the big screens — misses roll the jackpot up, the Joker wins it.</div>
        <input id="ckn-name" placeholder="Game name" value="CashKing">
        <div class="range-row">
          <label>Starting jackpot $<input id="ckn-start" type="number" inputmode="numeric" value="1000"></label>
          <label>Rise per miss $<input id="ckn-inc" type="number" inputmode="numeric" value="100"></label>
        </div>
        <input id="ckn-session" placeholder="Game nights — e.g. Thursdays 7:30pm">
        <button class="btn-new" data-ck-new>Shuffle deck &amp; start game</button>
      </div>`;
    }
    return `${backBtn}
      <div class="card">
        <h2>🃏 ${esc(game.name)} <span class="pill ${game.live ? 'live' : game.won ? 'cleared' : 'ready'}">${game.won ? 'WON' : game.live ? 'live' : 'idle'}</span></h2>
        <div class="muted">${game.cards_left} cards left${game.session_text ? ` · ${esc(game.session_text)}` : ''}</div>
        <div class="number"><div class="n">${moneyAud(game.jackpot)}</div></div>
        ${game.won ? '<div class="prev" style="font-size:15px">🎉 Joker found — jackpot won!</div>' : ''}
        ${game.live && !game.won ? '<div class="prev">Tap the winner’s card to reveal it on all screens</div>' : ''}
        ${game.live ? `<div class="ck-grid">${game.cards.map((c) => {
          if (!c.revealed) return game.won ? `<div class="rev" style="opacity:.25">${c.i + 1}</div>` : `<button data-ck-pick="${c.i}">${c.i + 1}</button>`;
          const red = c.card && 'HD'.includes(c.card.slice(-1));
          return `<div class="rev${red ? ' red' : ''}${c.card === 'JOKER' ? ' joker' : ''}">${ckFace(c.card)}</div>`;
        }).join('')}</div>` : ''}
        ${game.live
          ? '<button class="btn-clear" data-ck="end">End session — screens back to normal</button>'
          : (game.won ? '' : '<button class="btn-live" data-ck="live">🔴 GO LIVE on all screens</button>')}
        ${game.won ? '<button class="btn-clear" data-ck-archive>Archive game — start the next one</button>' : ''}
      </div>`;
  }

  // ---- Draws view -----------------------------------------------------------------

  function drawsHtml() {
    const active = state.draws.filter((d) => d.status !== 'cleared' || d.drawn_numbers.length);
    const cards = active.map((d) => {
      const prev = d.drawn_numbers.slice(0, -1);
      return `
      <div class="card">
        <h2>${esc(d.name)} <span class="pill ${d.status}">${d.status}</span></h2>
        <div class="muted">Tickets ${d.range_start}–${d.range_end}${d.zone_name ? ` · ${esc(d.zone_name)} screens` : ''} · ${d.remaining} left</div>
        ${d.latest_number != null ? `
          <div class="number"><div class="n ${freshNumbers.has(d.id) ? 'fresh' : ''}">#${d.latest_number}</div></div>
          ${prev.length ? `<div class="prev">Earlier: ${prev.map((n) => '#' + n).join('  ')}</div>` : ''}` : ''}
        <button class="btn-draw" data-spin="${d.id}" ${d.remaining <= 0 ? 'disabled' : ''}>
          ${d.latest_number != null ? '🎲 DRAW AGAIN' : '🎲 DRAW NUMBER'}</button>
        ${d.status === 'live' ? `<button class="btn-clear" data-clear="${d.id}">Done — clear screens</button>` : ''}
      </div>`;
    }).join('');

    return `${backBtn}
      ${cards || '<div class="card muted" style="text-align:center">No draws set up yet — create one below.</div>'}
      <div class="card">
        <h2>＋ New draw</h2>
        <input id="nd-name" placeholder="Draw name — e.g. Friday Meat Raffle">
        <div class="range-row">
          <label>First ticket #<input id="nd-start" type="number" inputmode="numeric" value="1"></label>
          <label>Last ticket #<input id="nd-end" type="number" inputmode="numeric" value="100"></label>
        </div>
        <select id="nd-zone"><option value="">Show on: whole venue</option>
          ${state.zones.map((z) => `<option value="${z.id}">Show on: ${esc(z.name)} only</option>`).join('')}
        </select>
        <button class="btn-new" data-nd-add>Create draw</button>
      </div>`;
  }

  // ---- Emergency view ----------------------------------------------------------------

  function emergencyHtml() {
    return `${backBtn}
      <div class="card">
        <h2>🚨 Emergency broadcast</h2>
        <div class="muted">Takes over every screen in this venue instantly. You'll be asked to confirm.</div>
        <input id="em-title" placeholder="Headline — e.g. EVACUATE NOW" value="Emergency — please follow staff directions">
        <input id="em-message" placeholder="Message — e.g. Move calmly to the nearest exit">
        <div class="em-grid">
          <button class="em-evac" data-em="evacuation">🔥 EVACUATION</button>
          <button class="em-lock" data-em="lockdown">🔒 LOCKDOWN</button>
          <button class="em-alert" data-em="alert">⚠️ ALERT</button>
          <button class="em-notice" data-em="notice">ℹ️ NOTICE</button>
        </div>
      </div>`;
  }

  // ---- actions (all delegated so re-renders never lose handlers) ---------------------

  document.body.addEventListener('click', async (e) => {
    const nav = e.target.closest('[data-nav]');
    if (nav) { view = nav.dataset.nav; render(); return; }

    const spin = e.target.closest('[data-spin]');
    const clear = e.target.closest('[data-clear]');
    const ckPick = e.target.closest('[data-ck-pick]');
    const ckAct = e.target.closest('[data-ck]');
    const ckArchive = e.target.closest('[data-ck-archive]');
    const ckNew = e.target.closest('[data-ck-new]');
    const ndAdd = e.target.closest('[data-nd-add]');
    const emLevel = e.target.closest('[data-em]');
    const emClear = e.target.closest('[data-em-clear]');
    if (!spin && !clear && !ckPick && !ckAct && !ckArchive && !ckNew && !ndAdd && !emLevel && !emClear) return;
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
      } else if (ckArchive) {
        if (!confirm('Archive this game? You can then start the next one.')) { busy = false; return; }
        await api('POST', `/api/remote/${token}/card-games/${state.card_game.id}/archive`);
      } else if (ckNew) {
        await api('POST', `/api/remote/${token}/card-games`, {
          name: $('ckn-name').value.trim() || 'CashKing',
          jackpot_start: parseFloat($('ckn-start').value) || 0,
          jackpot_increment: parseFloat($('ckn-inc').value) || 0,
          session_text: $('ckn-session').value.trim(),
        });
      } else if (ndAdd) {
        const name = $('nd-name').value.trim();
        if (!name) { flashError('Give the draw a name first.'); busy = false; return; }
        await api('POST', `/api/remote/${token}/draws`, {
          name,
          range_start: parseInt($('nd-start').value, 10),
          range_end: parseInt($('nd-end').value, 10),
          zone_id: $('nd-zone').value || null,
        });
      } else if (emLevel) {
        const level = emLevel.dataset.em;
        if (!confirm(`Broadcast ${level.toUpperCase()} to EVERY screen in ${state.venue.name}?`)) { busy = false; return; }
        if (navigator.vibrate) navigator.vibrate([120, 60, 120]);
        await api('POST', `/api/remote/${token}/emergency`, {
          level,
          title: $('em-title').value.trim() || level.toUpperCase(),
          message: $('em-message').value.trim(),
        });
      } else if (emClear) {
        if (!confirm('All clear — end the emergency broadcast?')) { busy = false; return; }
        await api('POST', `/api/remote/${token}/emergency/${state.emergency.id}/clear`);
      }
      await load();
    } catch (err) {
      flashError(err.message);
    } finally {
      busy = false;
      render();
    }
  });

  load();
  setInterval(load, 5000); // keep multiple staff devices in sync
})();
