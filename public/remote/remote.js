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
  let view = 'home'; // home | cashking | draws | wheel | badge | emergency
  let busy = false;
  let holdRenderUntil = 0; // lets a button show its "done ✓" flash briefly
  const forceCreate = { wheel: false, badge: false }; // show the setup form over an existing game
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
    if (Date.now() < holdRenderUntil) return;
    // Don't clobber a form the user is typing into (5s poll re-renders).
    const active = document.activeElement;
    if (active && $('views').contains(active) && /^(INPUT|SELECT|TEXTAREA)$/.test(active.tagName)) return;

    $('venue-name').textContent = state.venue.name;
    renderBanner();
    const views = {
      home: homeHtml, cashking: cashkingHtml, draws: drawsHtml,
      wheel: wheelHtml, badge: badgeHtml, emergency: emergencyHtml,
    };
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
      <button class="tile" data-nav="wheel">
        <span class="emoji">🎡</span>
        <span><span class="t-title">Wheel Spin</span><br><span class="t-sub">${state.wheel
          ? `${state.wheel.wedges.length} prizes${state.wheel.live ? ' · LIVE ON SCREENS' : ''}${state.wheel.last_spin ? ` · last: ${esc(state.wheel.last_spin.label)}` : ''}`
          : 'Tap to set up a prize wheel'}</span></span>
        <span class="t-go">›</span>
      </button>
      <button class="tile" data-nav="badge">
        <span class="emoji">🏅</span>
        <span><span class="t-title">Badge Draw</span><br><span class="t-sub">${state.badge_draw
          ? `${moneyAud(state.badge_draw.prize)} pot · ${state.badge_draw.members_count.toLocaleString()} members${state.badge_draw.live ? ' · LIVE' : ''}`
          : 'Tap to set up the members draw'}</span></span>
        <span class="t-go">›</span>
      </button>
      <button class="tile em ${state.emergency ? 'active' : ''}" data-nav="emergency">
        <span class="emoji">🚨</span>
        <span><span class="t-title">Emergency</span><br><span class="t-sub">${state.emergency ? 'BROADCAST ACTIVE — tap to manage' : 'Take over every screen with an alert'}</span></span>
        <span class="t-go">›</span>
      </button>
      <button class="btn-clear" data-return-ads style="margin-top:18px">
        📺 Return screens to advertising${(game && game.live) || liveDraw || state.wheel?.live || state.badge_draw?.live ? ' — a game is on screens now' : ''}
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

  // ---- Wheel Spin view ------------------------------------------------------------

  function wheelHtml() {
    const wheel = forceCreate.wheel ? null : state.wheel;
    if (!wheel) {
      return `${backBtn}
      <div class="card">
        <h2>🎡 Set up the prize wheel</h2>
        <div class="muted">One prize per line. Add <b>| weight</b> to change the odds — higher = more likely.
        e.g. <b>Free schnitty | 5</b> vs <b>$100 bar tab | 1</b>.</div>
        <input id="wh-name" placeholder="Wheel name" value="Wheel Spin">
        <textarea id="wh-wedges" rows="7" style="width:100%;margin-top:8px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit"
          placeholder="$50 bar tab | 1&#10;Meat tray | 3&#10;Free schnitty | 5&#10;House drink | 5&#10;Spin again | 2"></textarea>
        <button class="btn-new" data-wh-new>Build wheel</button>
      </div>`;
    }
    return `${backBtn}
      <div class="card">
        <h2>🎡 ${esc(wheel.name)} <span class="pill ${wheel.live ? 'live' : 'ready'}">${wheel.live ? 'live' : 'idle'}</span></h2>
        <div class="muted">${wheel.wedges.map((w) => esc(w.label)).join(' · ')}</div>
        ${wheel.last_spin ? `<div class="number"><div class="n" style="font-size:34px">🎉 ${esc(wheel.last_spin.label)}</div></div>` : ''}
        ${wheel.live
          ? `<button class="btn-draw" data-wh-spin>🎡 SPIN THE WHEEL</button>
             <button class="btn-clear" data-wh-end>End session — screens back to normal</button>`
          : '<button class="btn-live" data-wh-live>🔴 GO LIVE on all screens</button>'}
        <button class="btn-clear" data-wh-newwheel style="opacity:.7">Replace with a new wheel</button>
      </div>`;
  }

  // ---- Badge Draw view --------------------------------------------------------------

  function badgeHtml() {
    const badge = forceCreate.badge ? null : state.badge_draw;
    if (!badge) {
      return `${backBtn}
      <div class="card">
        <h2>🏅 Set up the members badge draw</h2>
        <div class="muted">Paste the member list — one per line, number then name (e.g. <b>1234 Karen M.</b>).
        Claimed = prize resets. Not claimed = pot jackpots by the rise amount.</div>
        <input id="bd-name" placeholder="Draw name" value="Members Badge Draw">
        <div class="range-row">
          <label>Starting prize $<input id="bd-start" type="number" inputmode="numeric" value="100"></label>
          <label>Rise if unclaimed $<input id="bd-inc" type="number" inputmode="numeric" value="50"></label>
        </div>
        <label class="muted" style="font-size:12px">Minutes to claim<input id="bd-mins" type="number" inputmode="numeric" value="3"></label>
        <textarea id="bd-members" rows="7" style="width:100%;margin-top:8px;background:var(--panel2);color:var(--text);border:1px solid var(--line);border-radius:10px;padding:12px;font:inherit"
          placeholder="1234 Karen M.&#10;2087 Dave T.&#10;3345 Robbo"></textarea>
        <button class="btn-new" data-bd-new>Create badge draw</button>
      </div>`;
    }
    const current = badge.current;
    const pending = current && current.outcome === 'pending';
    return `${backBtn}
      <div class="card">
        <h2>🏅 ${esc(badge.name)} <span class="pill ${badge.live ? 'live' : 'ready'}">${badge.live ? 'live' : 'idle'}</span></h2>
        <div class="muted">${badge.members_count.toLocaleString()} members · ${badge.claim_minutes} min to claim · rises ${moneyAud(badge.increment)} if unclaimed</div>
        <div class="number"><div class="n">${moneyAud(badge.prize)}</div></div>
        ${pending ? `
          <div class="prev" style="font-size:16px;font-weight:700">On screens now: #${esc(current.number)} ${esc(current.name || '')}</div>
          <button class="btn-live" data-bd-outcome="1">✅ CLAIMED — winner is here!</button>
          <button class="btn-clear" data-bd-outcome="0">❌ No show — jackpot it</button>` : `
          ${current ? `<div class="prev">Last: #${esc(current.number)} ${esc(current.name || '')} — ${current.outcome === 'claimed' ? 'claimed 🎉' : 'no show'}</div>` : ''}
          ${badge.live
            ? `<button class="btn-draw" data-bd-draw>🏅 DRAW A MEMBER</button>
               <button class="btn-clear" data-bd-end>End session — screens back to normal</button>`
            : '<button class="btn-live" data-bd-live>🔴 GO LIVE on all screens</button>'}`}
        <button class="btn-clear" data-bd-newdraw style="opacity:.7">Replace with a new draw setup</button>
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
    if (nav) { view = nav.dataset.nav; forceCreate.wheel = forceCreate.badge = false; render(); return; }
    const whNewWheel = e.target.closest('[data-wh-newwheel]');
    if (whNewWheel) { forceCreate.wheel = true; render(); return; }
    const bdNewDraw = e.target.closest('[data-bd-newdraw]');
    if (bdNewDraw) { forceCreate.badge = true; render(); return; }

    const spin = e.target.closest('[data-spin]');
    const clear = e.target.closest('[data-clear]');
    const ckPick = e.target.closest('[data-ck-pick]');
    const ckAct = e.target.closest('[data-ck]');
    const ckArchive = e.target.closest('[data-ck-archive]');
    const ckNew = e.target.closest('[data-ck-new]');
    const ndAdd = e.target.closest('[data-nd-add]');
    const emLevel = e.target.closest('[data-em]');
    const emClear = e.target.closest('[data-em-clear]');
    const returnAds = e.target.closest('[data-return-ads]');
    const whNew = e.target.closest('[data-wh-new]');
    const whLive = e.target.closest('[data-wh-live]');
    const whEnd = e.target.closest('[data-wh-end]');
    const whSpin = e.target.closest('[data-wh-spin]');
    const bdNew = e.target.closest('[data-bd-new]');
    const bdLive = e.target.closest('[data-bd-live]');
    const bdEnd = e.target.closest('[data-bd-end]');
    const bdDraw = e.target.closest('[data-bd-draw]');
    const bdOutcome = e.target.closest('[data-bd-outcome]');
    if (!spin && !clear && !ckPick && !ckAct && !ckArchive && !ckNew && !ndAdd && !emLevel && !emClear && !returnAds
      && !whNew && !whLive && !whEnd && !whSpin && !bdNew && !bdLive && !bdEnd && !bdDraw && !bdOutcome) return;
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
      } else if (returnAds) {
        await api('POST', `/api/remote/${token}/return-to-advertising`);
        returnAds.textContent = '✓ Screens back to advertising';
        holdRenderUntil = Date.now() + 1600;
        setTimeout(() => { holdRenderUntil = 0; render(); }, 1700);
      } else if (whNew) {
        const wedges = $('wh-wedges').value.split('\n').map((line) => {
          const [label, weight] = line.split('|').map((s) => s.trim());
          return { label, weight: weight ? parseFloat(weight) : 1 };
        }).filter((w) => w.label);
        await api('POST', `/api/remote/${token}/wheels`, { name: $('wh-name').value.trim() || 'Wheel Spin', wedges });
        forceCreate.wheel = false;
      } else if (whLive) {
        await api('POST', `/api/remote/${token}/wheels/${state.wheel.id}/live`);
      } else if (whEnd) {
        await api('POST', `/api/remote/${token}/wheels/${state.wheel.id}/end-session`);
      } else if (whSpin) {
        if (navigator.vibrate) navigator.vibrate(80);
        await api('POST', `/api/remote/${token}/wheels/${state.wheel.id}/spin`);
      } else if (bdNew) {
        await api('POST', `/api/remote/${token}/badge-draws`, {
          name: $('bd-name').value.trim() || 'Members Badge Draw',
          prize_start: parseFloat($('bd-start').value) || 0,
          increment: parseFloat($('bd-inc').value) || 0,
          claim_minutes: parseInt($('bd-mins').value, 10) || 3,
          members_text: $('bd-members').value,
        });
        forceCreate.badge = false;
      } else if (bdLive) {
        await api('POST', `/api/remote/${token}/badge-draws/${state.badge_draw.id}/live`);
      } else if (bdEnd) {
        await api('POST', `/api/remote/${token}/badge-draws/${state.badge_draw.id}/end-session`);
      } else if (bdDraw) {
        if (navigator.vibrate) navigator.vibrate(80);
        await api('POST', `/api/remote/${token}/badge-draws/${state.badge_draw.id}/draw`);
      } else if (bdOutcome) {
        const claimed = bdOutcome.dataset.bdOutcome === '1';
        if (!confirm(claimed ? 'Confirm: winner is here and claims the prize?' : 'Confirm: no show — jackpot the pot?')) { busy = false; return; }
        if (claimed && navigator.vibrate) navigator.vibrate([100, 60, 100, 60, 300]);
        await api('POST', `/api/remote/${token}/badge-draws/${state.badge_draw.id}/outcome`, { claimed });
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
