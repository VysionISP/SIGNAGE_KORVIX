'use strict';

// Korvix signage player. Runs full-screen in any modern browser (smart TV,
// Raspberry Pi kiosk, Android box). Pairs with the CMS, then plays the
// manifest it is given. Resilient to network loss: the last manifest is kept
// in localStorage and playback continues from cache until the CMS is back.

(() => {
  const HEARTBEAT_MS = 30 * 1000;
  const STORE_KEY = 'korvix.device_key';
  const MANIFEST_KEY = 'korvix.last_manifest';

  let deviceKey = localStorage.getItem(STORE_KEY) || null;
  let manifest = null;
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
    $('status-text').textContent = `${name}${connected ? '' : ' · reconnecting'}`;
  }

  // ---- manifest & playback ----------------------------------------------------

  async function refreshManifest() {
    try {
      const res = await fetch(`/api/player/${deviceKey}/manifest`, { cache: 'no-store' });
      if (res.status === 404) { // unpaired server-side
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
    renderEmergency();

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
    clearTimeout(advanceTimer);
    advanceTimer = null;
    itemIndex = -1;
    stage.innerHTML = '';
    currentLayer = null;
  }

  function nextItem() {
    clearTimeout(advanceTimer);
    const items = playableItems();
    if (!items.length) return;
    itemIndex = (itemIndex + 1) % items.length;
    const item = items[itemIndex];
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
        img.onerror = () => skipBroken();
        layer.appendChild(img);
        break;
      }
      case 'video': {
        const video = document.createElement('video');
        video.src = item.src;
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
    if (heartbeatTimer) return;
    const beat = async () => {
      if (!deviceKey) return;
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
          }),
        });
        setConnected(true);
      } catch {
        setConnected(false);
      }
    };
    heartbeatTimer = setInterval(beat, HEARTBEAT_MS);
    beat();
  }

  boot();
})();
