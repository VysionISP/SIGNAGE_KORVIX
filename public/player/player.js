'use strict';

// Korvix signage player. Runs full-screen in any modern browser (smart TV,
// Raspberry Pi kiosk, Android box). Pairs with the CMS, then plays the
// manifest it is given. Resilient to network loss: the last manifest is kept
// in localStorage and playback continues from cache until the CMS is back.

(() => {
  const HEARTBEAT_MS = 30 * 1000;
  const STORE_KEY = 'korvix.device_key';
  const MANIFEST_KEY = 'korvix.last_manifest';

  // Dashboard live-preview: /player/?preview=<deviceKey> renders exactly what
  // that screen shows, without heartbeating or affecting its online status.
  const previewKey = new URLSearchParams(location.search).get('preview');

  let deviceKey = previewKey || localStorage.getItem(STORE_KEY) || null;
  let manifest = null;
  const playQueue = []; // proof-of-play events, flushed with each heartbeat
  let eventSource = null;
  let itemIndex = -1;
  let advanceTimer = null;
  let currentLayer = null;
  let connected = false;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  // ---- boot / pairing -------------------------------------------------------

  async function hello() {
    const res = await fetch('/api/player/hello', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_key: deviceKey, player_info: playerInfo() }),
    });
    if (!res.ok) throw new Error('hello failed: ' + res.status);
    return res.json();
  }

  function playerInfo() {
    return {
      user_agent: navigator.userAgent,
      resolution: `${screen.width}x${screen.height}`,
      viewport: `${innerWidth}x${innerHeight}`,
      started_at: bootTime,
    };
  }
  const bootTime = new Date().toISOString();

  async function boot() {
    if (previewKey) {
      show('stage');
      connectEvents();
      await refreshManifest();
      return;
    }
    try {
      const state = await hello();
      deviceKey = state.device_key;
      localStorage.setItem(STORE_KEY, deviceKey);
      setConnected(true);
      if (state.status === 'paired') {
        show('stage');
        connectEvents();
        await refreshManifest();
        startHeartbeat();
      } else {
        $('pairing-code').textContent = state.pairing_code;
        show('pairing');
        connectEvents(); // 'paired' event flips us live instantly
        setTimeout(boot, 15000); // belt-and-braces poll while pending
      }
    } catch (err) {
      setConnected(false);
      // Network down at boot: replay the cached manifest if we have one.
      const cached = localStorage.getItem(MANIFEST_KEY);
      if (cached && deviceKey) {
        try { applyManifest(JSON.parse(cached)); show('stage'); } catch { /* fall through */ }
      }
      setTimeout(boot, 10000);
    }
  }

  function show(which) {
    $('pairing').style.display = which === 'pairing' ? 'flex' : 'none';
    $('standby').style.display = which === 'standby' ? 'flex' : 'none';
    stage.style.display = which === 'stage' ? 'block' : 'none';
  }

  // ---- live events ----------------------------------------------------------

  function connectEvents() {
    if (eventSource) eventSource.close();
    eventSource = new EventSource(`/api/player/${deviceKey}/events`);
    eventSource.onopen = () => setConnected(true);
    eventSource.onerror = () => setConnected(false);
    eventSource.addEventListener('refresh', () => refreshManifest());
    eventSource.addEventListener('paired', () => {
      show('stage');
      refreshManifest();
      startHeartbeat();
    });
    eventSource.addEventListener('unpaired', () => {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(MANIFEST_KEY);
      deviceKey = null;
      stopPlayback();
      location.reload();
    });
  }

  function setConnected(ok) {
    connected = ok;
    $('status').classList.toggle('disconnected', !ok);
    renderStatus();
  }

  function renderStatus() {
    const name = manifest ? `${manifest.venue.name} · ${manifest.screen.name}` : 'not paired';
    $('status-text').textContent = `${previewKey ? 'PREVIEW · ' : ''}${name}${connected ? '' : ' · reconnecting'}`;
    if (previewKey) $('status').style.opacity = '.9';
  }

  // ---- manifest & playback ----------------------------------------------------

  async function refreshManifest() {
    try {
      const res = await fetch(`/api/player/${deviceKey}/manifest${previewKey ? '?preview=1' : ''}`, { cache: 'no-store' });
      if (res.status === 404) { // unpaired server-side
        if (previewKey) return;
        localStorage.removeItem(STORE_KEY);
        deviceKey = null;
        location.reload();
        return;
      }
      if (!res.ok) throw new Error('manifest ' + res.status);
      applyManifest(await res.json());
      localStorage.setItem(MANIFEST_KEY, JSON.stringify(manifest));
      setConnected(true);
    } catch {
      setConnected(false); // keep playing what we have
    } finally {
      clearTimeout(refreshManifest._t);
      const secs = (manifest && manifest.refresh_seconds) || 60;
      refreshManifest._t = setTimeout(refreshManifest, secs * 1000);
    }
  }

  function applyManifest(next) {
    const prevPlaylist = JSON.stringify(manifest && manifest.playlist);
    const prevEmergency = JSON.stringify(manifest && manifest.emergency);
    manifest = next;
    renderStatus();
    renderRotation();
    renderEmergency();
    renderDraw();

    const items = playableItems();
    if (!items.length) {
      stopPlayback();
      $('standby-name').textContent = `${manifest.venue.name} — ${manifest.screen.name}`;
      show('standby');
      return;
    }
    show('stage');
    const playlistChanged = JSON.stringify(manifest.playlist) !== prevPlaylist;
    const emergencyChanged = JSON.stringify(manifest.emergency) !== prevEmergency;
    if (playlistChanged || emergencyChanged || itemIndex < 0) {
      itemIndex = -1;
      nextItem();
    }
    // otherwise let the current rotation continue; new feed data shows on the
    // next pass through each widget.
  }

  function playableItems() {
    return (manifest && manifest.playlist && manifest.playlist.items) || [];
  }

  function stopPlayback() {
    finishCurrentPlay();
    clearTimeout(advanceTimer);
    advanceTimer = null;
    itemIndex = -1;
    stage.innerHTML = '';
    currentLayer = null;
  }

  // Proof-of-play: close out the item that was showing and queue it.
  let currentPlay = null;
  function finishCurrentPlay() {
    if (!currentPlay || previewKey) { currentPlay = null; return; }
    currentPlay.duration = Math.round((Date.now() - currentPlay._t0) / 100) / 10;
    delete currentPlay._t0;
    playQueue.push(currentPlay);
    if (playQueue.length > 500) playQueue.splice(0, playQueue.length - 500);
    currentPlay = null;
  }

  function nextItem() {
    clearTimeout(advanceTimer);
    const items = playableItems();
    if (!items.length) return;
    finishCurrentPlay();
    itemIndex = (itemIndex + 1) % items.length;
    const item = items[itemIndex];
    currentPlay = { media_id: item.media_id, name: item.name, started_at: new Date().toISOString(), _t0: Date.now() };
    const layer = buildLayer(item);

    const old = currentLayer;
    currentLayer = layer;
    stage.appendChild(layer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      layer.classList.add('visible');
      if (old) {
        old.classList.remove('visible');
        setTimeout(() => old.remove(), 700);
      }
    }));

    const secs = Math.max(1, item.duration || 10);
    // Videos advance on 'ended'; the timer is a fallback for stalled loads.
    const fallback = item.type === 'video' ? Math.max(secs, 300) : secs;
    advanceTimer = setTimeout(nextItem, fallback * 1000);
  }

  function buildLayer(item) {
    const layer = document.createElement('div');
    layer.className = 'layer';
    switch (item.type) {
      case 'image': {
        const img = document.createElement('img');
        img.src = item.src;
        img.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
        img.onerror = () => skipBroken();
        layer.appendChild(img);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        video.src = item.src;
        video.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
        video.autoplay = true;
        video.muted = true;
        video.playsInline = true;
        video.onended = () => nextItem();
        video.onerror = () => skipBroken();
        layer.appendChild(video);
        break;
      }
      case 'url': {
        const frame = document.createElement('iframe');
        frame.src = item.src;
        frame.setAttribute('sandbox', 'allow-scripts allow-same-origin');
        layer.appendChild(frame);
        break;
      }
      case 'widget':
        layer.innerHTML = `<div class="html-slide">${renderWidget(item.src)}</div>`;
        break;
      case 'html':
      default:
        layer.innerHTML = `<div class="html-slide">${item.content || ''}</div>`;
    }
    return layer;
  }

  function skipBroken() {
    clearTimeout(advanceTimer);
    advanceTimer = setTimeout(nextItem, 500);
  }

  // ---- widgets (render live integration feeds) --------------------------------

  const money = (n) => Number(n).toLocaleString('en-AU', { style: 'currency', currency: 'AUD' });
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function renderWidget(name) {
    const feeds = (manifest && manifest.feeds) || {};
    switch (name) {
      case 'jackpot': {
        const jackpots = (feeds.gaming && feeds.gaming.jackpots) || [];
        if (!jackpots.length) return widgetShell('GAMING', '<h1>Jackpots</h1><div style="opacity:.7;font-size:2.5vw">Awaiting gaming system feed…</div>', '#160b2e,#4c1d95');
        const [top, ...rest] = jackpots;
        const restRows = rest.map((j) => `<tr><td>${esc(j.name)}</td><td class="num">${money(j.amount)}</td></tr>`).join('');
        return widgetShell('CURRENT JACKPOT',
          `<h1>${esc(top.name)}</h1><div class="big">${money(top.amount)}</div>` +
          (restRows ? `<table>${restRows}</table>` : ''),
          '#160b2e,#4c1d95');
      }
      case 'menu': {
        const pos = feeds.pos || {};
        const specials = (pos.specials || []).map((s) =>
          `<tr><td>${esc(s.name)}</td><td class="num">${money(s.price)}</td></tr>`).join('');
        const soldOut = (pos.sold_out || []).map((s) => `<span class="strike">${esc(s)}</span>`).join(' · ');
        return widgetShell("TODAY'S SPECIALS",
          `<table>${specials || '<tr><td style="opacity:.7">Awaiting POS feed…</td></tr>'}</table>` +
          (soldOut ? `<div style="font-size:2vw;margin-top:3vh;opacity:.8">Sold out: ${soldOut}</div>` : ''),
          '#052e16,#166534');
      }
      case 'weather': {
        const w = feeds.weather || {};
        return widgetShell(esc(w.location || 'LOCAL WEATHER'),
          `<div class="big">${w.temp_c != null ? esc(w.temp_c) + '&deg;' : '--'}</div>` +
          `<div style="font-size:3vw">${esc(w.condition || '')}</div>` +
          (w.high_c != null ? `<div style="font-size:2.2vw;opacity:.8;margin-top:1vh">H ${esc(w.high_c)}&deg; · L ${esc(w.low_c)}&deg;</div>` : ''),
          '#0c2740,#155e75');
      }
      case 'sports': {
        const fixtures = (feeds.sports && feeds.sports.fixtures) || [];
        const rows = fixtures.map((f) =>
          `<tr><td style="opacity:.7">${esc(f.league)}</td><td>${esc(f.match)}</td><td class="num">${esc(f.when)}</td></tr>`).join('');
        return widgetShell('LIVE &amp; UPCOMING',
          `<h1>On The Big Screens</h1><table>${rows || '<tr><td style="opacity:.7">Awaiting sports feed…</td></tr>'}</table>`,
          '#101827,#1e3a5f');
      }
      case 'birthdays': {
        const members = (feeds.membership && feeds.membership.birthdays) || [];
        if (!members.length) {
          return widgetShell('MEMBERS', '<h1>🎂 Birthdays</h1><div style="opacity:.7;font-size:2.5vw">Awaiting membership feed…</div>', '#3f1d38,#831843');
        }
        const names = members.slice(0, 8).map((m) => esc(m.name || m)).join('<br>');
        return widgetShell('HAPPY BIRTHDAY TO OUR MEMBERS',
          `<div style="font-size:6vw">🎂</div><div style="font-size:3.4vw;line-height:1.7;font-weight:700">${names}</div>` +
          '<div style="font-size:2vw;opacity:.8;margin-top:2vh">Show your card at the bar for a birthday drink</div>',
          '#3f1d38,#831843');
      }
      case 'happyhour': {
        const hh = (feeds.pos && feeds.pos.happy_hour) || {};
        if (!hh.from || !hh.to) {
          return widgetShell('HAPPY HOUR', '<h1>Happy Hour</h1><div style="opacity:.7;font-size:2.5vw">Ask at the bar for today&rsquo;s times</div>', '#7a3b00,#e8590c');
        }
        const parts = new Intl.DateTimeFormat('en-AU', {
          timeZone: manifest.venue.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
        }).format(new Date()).split(':');
        const nowMin = parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
        const toMin = (s) => { const [h, m] = String(s).split(':').map(Number); return h * 60 + (m || 0); };
        const startMin = toMin(hh.from);
        const endMin = toMin(hh.to);
        const fmt = (mins) => mins >= 60 ? `${Math.floor(mins / 60)}h ${mins % 60}m` : `${mins}m`;
        let line;
        if (nowMin >= startMin && nowMin < endMin) {
          line = `<div class="big" style="font-size:7vw">ON NOW!</div><div style="font-size:3vw;margin-top:1vh">ends in ${fmt(endMin - nowMin)}</div>`;
        } else {
          const until = nowMin < startMin ? startMin - nowMin : (24 * 60 - nowMin) + startMin;
          line = `<div style="font-size:2.6vw;opacity:.85">starts in</div><div class="big" style="font-size:9vw">${fmt(until)}</div>`;
        }
        return widgetShell('HAPPY HOUR',
          line + `<div style="font-size:2.4vw;opacity:.85;margin-top:2vh">${esc(hh.from)} – ${esc(hh.to)} daily${hh.deal ? ' · ' + esc(hh.deal) : ''}</div>`,
          '#7a3b00,#e8590c');
      }
      case 'clock':
      case 'welcome':
      default: {
        const timeString = new Date().toLocaleTimeString('en-AU', {
          hour: 'numeric', minute: '2-digit', timeZone: manifest.venue.timezone,
        });
        return widgetShell('WELCOME TO',
          `<h1>${esc(manifest.venue.name)}</h1><div class="big" style="font-size:6vw">${timeString}</div>` +
          '<div style="font-size:2.2vw;opacity:.8;margin-top:2vh">Open 7 days · 7am til late</div>',
          '#111827,#334155');
      }
    }
  }

  function widgetShell(kicker, inner, gradient) {
    return `<div class="widget" style="background:linear-gradient(135deg,${gradient})">` +
      `<div class="kicker">${kicker}</div>${inner}</div>`;
  }

  // ---- physical rotation ----------------------------------------------------------

  function renderRotation() {
    const rotation = (manifest && manifest.screen && manifest.screen.rotation) || 0;
    const root = $('root');
    root.classList.remove('rot90', 'rot180', 'rot270');
    if (rotation) root.classList.add(`rot${rotation}`);
  }

  // ---- raffle number draw takeover --------------------------------------------------

  let lastDrawKey = null;
  let spinTimer = null;

  function renderDraw() {
    const overlay = $('draw');
    const draw = manifest && manifest.draw;
    if (!draw || draw.number == null) {
      overlay.style.display = 'none';
      clearInterval(spinTimer);
      lastDrawKey = null;
      return;
    }
    $('draw-name').textContent = draw.name;
    $('draw-prev').textContent = draw.previous_numbers && draw.previous_numbers.length
      ? `Already drawn: ${draw.previous_numbers.join('  ·  ')}` : '';
    overlay.style.display = 'flex';

    const key = `${draw.id}:${draw.number}:${draw.drawn_at}`;
    if (key === lastDrawKey) return; // same result, don't re-spin
    lastDrawKey = key;

    // Spin through random numbers in range for ~4s, then reveal the winner.
    const el = $('draw-number');
    el.classList.remove('revealed');
    clearInterval(spinTimer);
    const span = draw.range_end - draw.range_start + 1;
    const startedAt = Date.now();
    spinTimer = setInterval(() => {
      if (Date.now() - startedAt >= 4000) {
        clearInterval(spinTimer);
        el.textContent = draw.number;
        el.classList.add('revealed');
        return;
      }
      el.textContent = draw.range_start + Math.floor(Math.random() * span);
    }, 60);
  }

  // ---- emergency takeover -------------------------------------------------------

  function renderEmergency() {
    const overlay = $('emergency');
    const em = manifest && manifest.emergency;
    if (!em) {
      overlay.style.display = 'none';
      return;
    }
    overlay.className = '';
    overlay.classList.add(em.level);
    $('em-level').textContent = em.level.toUpperCase();
    $('em-title').textContent = em.title;
    $('em-message').textContent = em.message || '';
    overlay.style.display = 'flex';
  }

  // ---- heartbeat -----------------------------------------------------------------

  let heartbeatTimer = null;
  function startHeartbeat() {
    if (heartbeatTimer || previewKey) return;
    const beat = async () => {
      if (!deviceKey) return;
      const batch = playQueue.splice(0, playQueue.length);
      try {
        await fetch(`/api/player/${deviceKey}/heartbeat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            player_info: {
              ...playerInfo(),
              current_item: itemIndex >= 0 && playableItems()[itemIndex] ? playableItems()[itemIndex].name : null,
              playlist: manifest && manifest.playlist ? manifest.playlist.name : null,
            },
            plays: batch,
          }),
        });
        setConnected(true);
      } catch {
        playQueue.unshift(...batch); // resend once we're back online
        setConnected(false);
      }
    };
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  boot();
})();
