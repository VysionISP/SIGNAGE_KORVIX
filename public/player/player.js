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
  const urlParams = new URLSearchParams(location.search);
  const previewKey = urlParams.get('preview');

  // Kiosk URL: /player/?key=<deviceKey> pins this browser to its paired
  // screen permanently — pairing survives page refreshes, reboots and TV
  // browsers that wipe localStorage. If the key was revoked (screen unpaired
  // or deleted), it's remembered as dead so the normal pairing flow can run.
  const urlKey = urlParams.get('key');
  const usableUrlKey = urlKey && localStorage.getItem('korvix.dead_url_key') !== urlKey ? urlKey : null;

  let deviceKey = previewKey || usableUrlKey || localStorage.getItem(STORE_KEY) || null;
  let manifest = null;
  const playQueue = []; // proof-of-play events, flushed with each heartbeat
  let eventSource = null;
  let itemIndex = -1;
  let advanceTimer = null;
  let currentLayer = null;
  let connected = false;

  const $ = (id) => document.getElementById(id);
  const stage = $('stage');

  // Brand comes from the server (KORVIX_BRAND env) so a rebrand is one env var.
  function applyBrand(brand) {
    if (!brand) return;
    document.title = `${brand} Player`;
    document.querySelectorAll('.brand').forEach((el) => { el.textContent = brand.toUpperCase(); });
  }
  fetch('/api/auth/state').then((r) => r.json()).then((s) => applyBrand(s.brand)).catch(() => {});

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
      if (usableUrlKey) {
        if (state.status === 'paired' && state.device_key === usableUrlKey) {
          localStorage.removeItem('korvix.dead_url_key');
        } else if (state.device_key !== usableUrlKey) {
          // The pinned key is no longer valid — don't fight it on every boot.
          localStorage.setItem('korvix.dead_url_key', usableUrlKey);
        }
      }
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
    const prevManifestSnapshot = {
      side: JSON.stringify(manifest && manifest.side_playlist),
      ticker: JSON.stringify(manifest && manifest.ticker),
      layout: manifest && manifest.screen && manifest.screen.layout,
    };
    manifest = next;
    renderStatus();
    renderSleep();
    renderRotation();
    renderLayout(prevManifestSnapshot);
    renderEmergency();
    renderDraw();
    renderCashKing();
    renderWheel();
    renderBadge();

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
    } else {
      // Rotation continues, but whatever widget is on screen right now gets
      // its fresh data immediately — menu edits, sold-outs, jackpot ticks
      // land live instead of waiting for the next pass.
      refreshLiveWidgets();
    }
  }

  // Re-render the currently displayed widget layers in place (main + side).
  // The rendered HTML is remembered per layer so identical output is a no-op
  // — no flicker on the 60s background refresh.
  function refreshLiveWidgets() {
    const refresh = (layer, item) => {
      if (!layer || !item || item.type !== 'widget') return;
      const slide = layer.querySelector('.html-slide');
      if (!slide) return;
      const html = renderWidget(item.src);
      if (layer._widgetHtml !== html) {
        layer._widgetHtml = html;
        slide.innerHTML = html;
        fitMenuBoards(layer);
      }
    };
    refresh(currentLayer, playableItems()[itemIndex]);
    refresh(sideLayer, sideItems[sideIndex]);
  }

  function playableItems() {
    return (manifest && manifest.playlist && manifest.playlist.items) || [];
  }

  // ---- overnight sleep --------------------------------------------------------
  // The venue sets a blackout window (e.g. 00:00–07:00) and every screen goes
  // dark for it, computed against the venue's own timezone. Emergencies still
  // punch through (their overlay sits above this one).

  function venueMinutesNow() {
    const parts = new Intl.DateTimeFormat('en-AU', {
      timeZone: manifest.venue.timezone, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date()).split(':');
    return (parseInt(parts[0], 10) % 24) * 60 + parseInt(parts[1], 10);
  }

  function renderSleep() {
    const sleep = manifest && manifest.venue && manifest.venue.sleep;
    let asleep = false;
    if (sleep && sleep.start && sleep.end && sleep.start !== sleep.end) {
      try {
        const toMin = (s) => { const [h, m] = s.split(':').map(Number); return h * 60 + (m || 0); };
        const now = venueMinutesNow();
        const start = toMin(sleep.start);
        const end = toMin(sleep.end);
        asleep = end > start ? (now >= start && now < end) : (now >= start || now < end);
      } catch { asleep = false; }
    }
    $('sleep').style.display = asleep ? 'flex' : 'none';
  }
  setInterval(() => { if (manifest) renderSleep(); }, 30 * 1000);

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
      fitMenuBoards(layer);
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
      case 'widget': {
        const html = renderWidget(item.src);
        layer._widgetHtml = html;
        layer.innerHTML = `<div class="html-slide">${html}</div>`;
        break;
      }
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

  // Live countdown ticker for racing widgets: elements carrying data-jump
  // (an ISO start time) get re-formatted every second, no re-render needed.
  function fmtJump(ms) {
    if (ms <= -150000) return 'RACING';
    if (ms <= 0) return 'JUMPING';
    const total = Math.floor(ms / 1000);
    const h = Math.floor(total / 3600), m = Math.floor((total % 3600) / 60), s = total % 60;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${String(s).padStart(2, '0')}s`;
  }
  setInterval(() => {
    document.querySelectorAll('[data-jump]').forEach((el) => {
      const ms = Date.parse(el.dataset.jump) - Date.now();
      el.textContent = fmtJump(ms);
      el.style.color = ms <= 120000 ? '#f87171' : '';
    });
  }, 1000);

  const RACE_ICON = { R: '🏇', H: '🐎', G: '🐕' };

  function racingWidget(sub) {
    const racing = ((manifest && manifest.feeds) || {}).racing || {};
    if (sub === 'results') {
      const results = racing.results || [];
      const rows = results.slice(0, 5).map((r) => `
        <div style="text-align:left;margin-bottom:1.6vh">
          <div style="font-size:2.2vw;font-weight:700">${RACE_ICON[r.type] || '🏇'} ${esc(r.meeting)} R${esc(r.number)}</div>
          <div style="font-size:1.9vw;opacity:.9">${(r.placings || []).map(esc).join(' &nbsp;·&nbsp; ')}</div>
        </div>`).join('');
      return widgetShell('RACING RESULTS',
        rows || '<div style="opacity:.7;font-size:2.5vw">Results will appear here as races settle…</div>',
        '#1c1917,#44403c');
    }
    const idx = parseInt(sub, 10) - 1;
    const race = (racing.races || [])[idx];
    const kicker = ['NEXT TO GO', '2ND RACE', '3RD RACE'][idx] || 'RACING';
    if (!race) {
      return widgetShell(kicker, '<h1>🏇 Racing</h1><div style="opacity:.7;font-size:2.4vw">Awaiting racing feed…</div>', '#052e16,#14532d');
    }
    return widgetShell(kicker,
      `<h1 style="font-size:5vw">${RACE_ICON[race.type] || '🏇'} ${esc(race.meeting)} <span style="opacity:.8">R${esc(race.number)}</span></h1>` +
      `<div style="font-size:2.3vw;opacity:.9">${esc(race.name)}${race.distance ? ` · ${esc(race.distance)}m` : ''}${race.location ? ` · ${esc(race.location)}` : ''}</div>` +
      `<div class="big" data-jump="${esc(race.start)}" style="margin-top:2vh">--</div>` +
      `<div style="font-size:1.9vw;opacity:.7;margin-top:1vh">${(racing.races || []).slice(idx + 1, idx + 3).map((n) => `${esc(n.meeting)} R${esc(n.number)}`).join(' &nbsp;then&nbsp; ')}</div>`,
      '#052e16,#14532d');
  }

  // Designed menu board: themed, with optional item photos and the venue
  // logo up top. Data lives in manifest.menus / manifest.venue.logo.
  // rule/titleRule are full border-bottom shorthands; frame wraps the whole
  // board; nameExtra/sectionExtra are appended CSS for glow/texture effects.
  const MENU_THEMES = {
    classic: {
      bg: 'linear-gradient(160deg,#1c1410,#0d0906)', font: 'system-ui,sans-serif',
      name: '#fff', section: '#fbbf24', rule: '.15vh solid #fbbf2488', titleRule: '.3vh double #fbbf2488',
      text: '#fff', muted: 'rgba(255,255,255,.75)', leader: 'rgba(255,255,255,.35)', sold: '#f87171',
    },
    chalkboard: {
      bg: 'radial-gradient(ellipse at 30% 15%,#2b2d31 0%,#1a1b1e 55%,#0f1012 100%)',
      font: "'Chalkboard SE','Segoe Print','Bradley Hand','Comic Sans MS',cursive",
      name: '#f5f5f4', section: '#fde68a', rule: '.25vh dashed rgba(253,230,138,.55)', titleRule: '.25vh dashed rgba(245,245,244,.5)',
      text: '#e7e5e4', muted: 'rgba(231,229,228,.65)', leader: 'rgba(231,229,228,.3)', sold: '#fca5a5',
      frame: 'border:1.5vh solid #6d4c33;box-shadow:inset 0 0 7vh rgba(0,0,0,.6);box-sizing:border-box;',
      nameExtra: 'text-shadow:0 0 .7vh rgba(255,255,255,.3);',
      sectionExtra: 'text-shadow:0 0 .5vh rgba(253,230,138,.35);',
    },
    modern: {
      bg: 'linear-gradient(160deg,#faf7f2,#ece5d8)', font: 'system-ui,sans-serif',
      name: '#1c1917', section: '#c2410c', rule: '.15vh solid #c2410c66', titleRule: '.2vh solid #c2410c66',
      text: '#292524', muted: 'rgba(41,37,36,.65)', leader: 'rgba(41,37,36,.3)', sold: '#dc2626',
    },
    pub: {
      bg: 'linear-gradient(160deg,#3b1212,#190707)', font: "Georgia,'Times New Roman',serif",
      name: '#fde68a', section: '#fde68a', rule: '.15vh solid #fde68a66', titleRule: '.3vh double #fde68a66',
      text: '#fef3c7', muted: 'rgba(254,243,199,.7)', leader: 'rgba(254,243,199,.3)', sold: '#fca5a5',
    },
    coastal: {
      bg: 'linear-gradient(165deg,#f0f9ff,#dbeafe 55%,#e0f2fe)', font: 'system-ui,sans-serif',
      name: '#0c4a6e', section: '#0284c7', rule: '.15vh solid #0284c766', titleRule: '.3vh double #0c4a6e55',
      text: '#0f172a', muted: 'rgba(15,23,42,.6)', leader: 'rgba(15,23,42,.3)', sold: '#dc2626',
    },
    neon: {
      bg: 'radial-gradient(ellipse at top,#1a1033,#0a0614 75%)', font: 'system-ui,sans-serif',
      name: '#22d3ee', section: '#f472b6', rule: '.15vh solid #f472b688', titleRule: '.2vh solid #22d3ee66',
      text: '#f8fafc', muted: 'rgba(248,250,252,.7)', leader: 'rgba(244,114,182,.4)', sold: '#facc15',
      nameExtra: 'text-shadow:0 0 1vw #22d3ee,0 0 3vw rgba(34,211,238,.5);',
      sectionExtra: 'text-shadow:0 0 .8vw rgba(244,114,182,.8);',
    },
    minimal: {
      bg: '#0a0a0a', font: 'system-ui,sans-serif',
      name: '#fafafa', section: '#fafafa', rule: '.1vh solid rgba(250,250,250,.35)', titleRule: '.1vh solid rgba(250,250,250,.5)',
      text: '#e5e5e5', muted: 'rgba(229,229,229,.55)', leader: 'rgba(229,229,229,.2)', sold: '#a3a3a3',
      sectionExtra: 'letter-spacing:.35em;font-weight:600;',
    },
    cafe: {
      bg: 'linear-gradient(160deg,#efe4d3,#e0cdb2)', font: "Georgia,'Times New Roman',serif",
      name: '#4a2e19', section: '#7c4a22', rule: '.15vh solid #7c4a2266', titleRule: '.3vh double #4a2e1966',
      text: '#3c2a1a', muted: 'rgba(60,42,26,.65)', leader: 'rgba(60,42,26,.3)', sold: '#b91c1c',
    },
  };

  function menuBoardWidget(menuId) {
    const menu = ((manifest && manifest.menus) || []).find((m) => m.id === menuId);
    if (!menu) {
      return widgetShell('MENU', '<h1>Menu board</h1><div style="opacity:.7;font-size:2.4vw">This menu was deleted — remove it from the playlist.</div>', '#1c1917,#3f3f46');
    }
    const T = MENU_THEMES[menu.theme] || MENU_THEMES.classic;
    const price = (p) => p == null ? '' : '$' + Number(p).toFixed(2).replace(/\.00$/, '');
    const logo = manifest.venue.logo
      ? `<img src="${esc(manifest.venue.logo)}" style="max-height:9vh;max-width:26vw;object-fit:contain;margin-bottom:1vh">` : '';

    // Featured items break out into a hero strip under the title: big photo,
    // big price, FEATURED tag in the theme accent. They leave the list flow.
    const featured = menu.sections.flatMap((s) => s.items.filter((i) => i.featured)).slice(0, 3);
    // Photos keep a natural 16:9 crop (aspect-ratio, not a fixed strip) so
    // dishes aren't beheaded. Descriptions show in full when the featured
    // cards have the board to themselves; only when list sections need the
    // space below do they clamp (5 lines) to protect the rest of the menu.
    const hasListBelow = menu.sections.some((s) => s.items.some((i) => !i.featured));
    const descClamp = hasListBelow
      ? 'display:-webkit-box;-webkit-line-clamp:5;-webkit-box-orient:vertical;overflow:hidden;' : '';
    const heroHtml = featured.length ? `
      <div style="display:flex;gap:2vw;width:100%;margin-bottom:2.6vh;align-items:stretch">
        ${featured.map((item) => `
        <div style="flex:1;max-width:${featured.length === 1 ? '46vw' : '30vw'};margin:0 auto;text-align:left;
          border:.15vw solid ${T.section};border-radius:1vw;overflow:hidden;${item.sold_out ? 'opacity:.5;' : ''}
          box-shadow:0 .8vh 2.5vh rgba(0,0,0,.35);display:flex;flex-direction:column">
          ${item.photo ? `<img src="${esc(item.photo)}" style="width:100%;aspect-ratio:16/9;height:auto;object-fit:cover;object-position:center;display:block">` : ''}
          <div style="padding:1.2vh 1.2vw 1.5vh">
            <div style="font-size:1.15vw;font-weight:800;letter-spacing:.25em;color:${T.section};${T.sectionExtra || ''}">★ FEATURED${item.sold_out ? ' · SOLD OUT' : ''}</div>
            <div style="display:flex;align-items:baseline;gap:1vw;margin-top:.5vh">
              <span style="font-size:2.5vw;font-weight:800;${item.sold_out ? 'text-decoration:line-through;' : ''}">${esc(item.name)}</span>
              <span style="flex:1"></span>
              <span style="font-size:2.6vw;font-weight:900;color:${T.section};font-variant-numeric:tabular-nums">${price(item.price)}</span>
            </div>
            ${item.desc ? `<div style="font-size:1.4vw;line-height:1.5;color:${T.muted};margin-top:.3vh;${descClamp}">${esc(item.desc)}</div>` : ''}
          </div>
        </div>`).join('')}
      </div>` : '';

    const sectionsHtml = menu.sections.map((section) => ({
      ...section, items: section.items.filter((i) => !i.featured),
    })).filter((section) => section.items.length).map((section) => `
      <div style="break-inside:avoid;margin-bottom:2.6vh;text-align:left">
        <div style="font-size:2.4vw;font-weight:800;letter-spacing:.14em;color:${T.section};border-bottom:${T.rule};padding-bottom:.6vh;margin-bottom:1.2vh;text-transform:uppercase;${T.sectionExtra || ''}">${esc(section.title)}</div>
        ${section.items.map((item) => `
          <div style="margin-bottom:1.2vh;${item.sold_out ? 'opacity:.45' : ''};display:flex;gap:.9vw;align-items:flex-start">
            ${item.photo ? `<img src="${esc(item.photo)}" style="width:6.5vh;height:6.5vh;object-fit:cover;border-radius:.8vh;flex-shrink:0;box-shadow:0 .3vh .8vh rgba(0,0,0,.35)">` : ''}
            <div style="flex:1;min-width:0">
              <div style="display:flex;align-items:baseline;gap:.8vw">
                <span style="font-size:1.9vw;font-weight:700;${item.sold_out ? 'text-decoration:line-through' : ''}">${esc(item.name)}</span>
                ${item.sold_out ? `<span style="font-size:1.1vw;font-weight:800;color:${T.sold};border:.1vw solid ${T.sold};border-radius:.4vw;padding:0 .5vw">SOLD OUT</span>` : ''}
                <span style="flex:1;border-bottom:.2vh dotted ${T.leader};transform:translateY(-.5vh)"></span>
                <span style="font-size:1.9vw;font-weight:700;font-variant-numeric:tabular-nums">${price(item.price)}</span>
              </div>
              ${item.desc ? `<div style="font-size:1.35vw;color:${T.muted};margin-top:.2vh">${esc(item.desc)}</div>` : ''}
            </div>
          </div>`).join('')}
      </div>`).join('');
    const cols = menu.sections.length >= 3 ? 3 : menu.sections.length === 2 ? 2 : 1;
    return `<div class="widget" style="background:${T.bg};color:${T.text};font-family:${T.font};justify-content:flex-start;padding:3vh 4vw;${T.frame || ''}">
      ${logo}
      <div style="font-size:3.6vw;font-weight:900;letter-spacing:.2em;text-transform:uppercase;margin-bottom:2.4vh;border-bottom:${T.titleRule};padding-bottom:1vh;width:100%;text-align:center;color:${T.name};${T.nameExtra || ''}">${esc(menu.name)}</div>
      ${heroHtml}
      <div data-menufit style="columns:${cols};column-gap:3.5vw;width:100%;flex:1;overflow:hidden">${sectionsHtml}</div>
    </div>`;
  }

  // Menu boards must never clip: if the list area overflows its box, zoom it
  // down (hero cards keep their size — only the lists shrink) until it fits.
  function fitMenuBoards(scope) {
    if (!scope || !scope.querySelectorAll) return;
    scope.querySelectorAll('[data-menufit]').forEach((el) => {
      el.style.zoom = '';
      for (let pass = 0; pass < 4; pass++) {
        if (el.scrollHeight <= el.clientHeight + 2 || !el.scrollHeight) break;
        const next = (parseFloat(el.style.zoom) || 1) * (el.clientHeight / el.scrollHeight);
        el.style.zoom = String(Math.max(0.55, next));
        if (next <= 0.55) break;
      }
    });
  }

  function renderWidget(name) {
    const feeds = (manifest && manifest.feeds) || {};
    if (name.startsWith('racing:')) return racingWidget(name.slice(7));
    if (name.startsWith('menuboard:')) return menuBoardWidget(name.slice(10));
    if (name.startsWith('qr:')) return qrWidget(name.slice(3));
    if (name.startsWith('countdown:')) return countdownWidget(name.slice(10));
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
      case 'cashking': {
        const promo = manifest.card_game_promo;
        if (!promo) {
          return widgetShell('CASHKING', '<h1>🃏 CashKing</h1><div style="opacity:.7;font-size:2.5vw">Coming soon to this venue</div>', '#14532d,#052012');
        }
        if (promo.status === 'won') {
          return widgetShell('🃏 ' + esc(promo.name.toUpperCase()),
            `<h1>WON! ${moneyAud(promo.jackpot)}</h1><div style="font-size:2.6vw;opacity:.9">The Joker has been found — new game starting soon!</div>`,
            '#78350f,#451a03');
        }
        return widgetShell('🃏 ' + esc(promo.name.toUpperCase()) + ' JACKPOT',
          `<div class="big">${moneyAud(promo.jackpot)}</div>` +
          `<div style="font-size:2.6vw;margin-top:1vh">${promo.cards_left} cards left — could be the Joker!</div>` +
          (promo.session_text ? `<div style="font-size:2.2vw;opacity:.85;margin-top:1.5vh">${esc(promo.session_text)}</div>` : ''),
          '#14532d,#052012');
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
        const welcomeLogo = manifest.venue.logo
          ? `<img src="${esc(manifest.venue.logo)}" style="max-height:14vh;max-width:34vw;object-fit:contain;margin-bottom:2vh">` : '';
        return widgetShell('WELCOME TO',
          `${welcomeLogo}<h1>${esc(manifest.venue.name)}</h1><div class="big" style="font-size:6vw">${timeString}</div>` +
          '<div style="font-size:2.2vw;opacity:.8;margin-top:2vh">Open 7 days · 7am til late</div>',
          '#111827,#334155');
      }
    }
  }

  function widgetShell(kicker, inner, gradient) {
    return `<div class="widget" style="background:linear-gradient(135deg,${gradient})">` +
      `<div class="kicker">${kicker}</div>${inner}</div>`;
  }

  // 'qr:<url>|<label>' — big scannable code (generated & cached by the server).
  function qrWidget(spec) {
    const [url, label] = spec.split('|');
    if (!url) return widgetShell('SCAN ME', '<div style="opacity:.7;font-size:2.5vw">No link set for this QR slide</div>', '#111827,#334155');
    const pretty = url.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return widgetShell('SCAN ME',
      `${label ? `<h1>${esc(label)}</h1>` : ''}` +
      `<div style="background:#fff;padding:2.2vh;border-radius:2vh;display:inline-block;margin-top:1vh">` +
      `<img src="/qr?data=${encodeURIComponent(url)}" style="width:34vh;height:34vh;display:block" alt="QR code"></div>` +
      `<div style="font-size:2.2vw;opacity:.85;margin-top:2.5vh">${esc(pretty)}</div>`,
      '#111827,#334155');
  }

  // 'countdown:<ISO datetime>|<label>' — live days/hours/mins/secs.
  function countdownWidget(spec) {
    const [when, label] = spec.split('|');
    const target = Date.parse(when);
    if (!Number.isFinite(target)) {
      return widgetShell('COUNTDOWN', '<div style="opacity:.7;font-size:2.5vw">No date set for this countdown</div>', '#1e1b4b,#4338ca');
    }
    return widgetShell('COUNTING DOWN TO',
      `${label ? `<h1>${esc(label)}</h1>` : ''}` +
      `<div class="countdown-live" data-countdown="${esc(when)}" style="margin-top:2vh"></div>`,
      '#1e1b4b,#4338ca');
  }

  function countdownSegments(ms) {
    if (ms <= 0) return '<div style="font-size:8vw;font-weight:900">IT&rsquo;S ON!</div>';
    const total = Math.floor(ms / 1000);
    const d = Math.floor(total / 86400), h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60), s = total % 60;
    const seg = (n, unit) => `<div style="display:inline-block;margin:0 1vw;min-width:9vw">` +
      `<div style="font-size:7vw;font-weight:900;font-variant-numeric:tabular-nums;background:rgba(0,0,0,.35);border-radius:1.5vh;padding:1vh 0">${String(n).padStart(2, '0')}</div>` +
      `<div style="font-size:1.8vw;opacity:.75;letter-spacing:.2em;margin-top:.8vh">${unit}</div></div>`;
    return (d > 0 ? seg(d, 'DAYS') : '') + seg(h, 'HOURS') + seg(m, 'MINS') + (d > 0 ? '' : seg(s, 'SECS'));
  }

  setInterval(() => {
    document.querySelectorAll('[data-countdown]').forEach((el) => {
      const html = countdownSegments(Date.parse(el.dataset.countdown) - Date.now());
      if (el._cd !== html) { el._cd = html; el.innerHTML = html; }
    });
  }, 1000);

  // ---- split-screen layout: side panel rotation + ticker strip ----------------------

  let sideItems = [];
  let sideIndex = -1;
  let sideTimer = null;
  let sideLayer = null;

  function renderLayout(prev) {
    const layout = (manifest && manifest.screen && manifest.screen.layout) || 'full';
    const root = $('root');
    root.classList.toggle('lay-side', layout === 'side' || layout === 'side-ticker');
    root.classList.toggle('lay-ticker', layout === 'ticker' || layout === 'side-ticker');

    // Ticker
    const messages = (manifest && manifest.ticker) || [];
    if (JSON.stringify(manifest.ticker) !== prev.ticker || layout !== prev.layout) {
      const el = $('tk-text');
      if (messages.length) {
        const text = messages.join('      •      ');
        el.textContent = text;
        el.style.animationDuration = Math.max(18, text.length * 0.28) + 's';
      } else {
        el.textContent = '';
      }
    }

    // Side panel rotation
    const sideJson = JSON.stringify(manifest.side_playlist);
    if (sideJson !== prev.side || layout !== prev.layout) {
      clearTimeout(sideTimer);
      sideTimer = null;
      sideIndex = -1;
      $('side').innerHTML = '';
      sideLayer = null;
      sideItems = (manifest.side_playlist && manifest.side_playlist.items) || [];
      if (sideItems.length && (layout === 'side' || layout === 'side-ticker')) nextSideItem();
    }
  }

  function nextSideItem() {
    clearTimeout(sideTimer);
    if (!sideItems.length) return;
    sideIndex = (sideIndex + 1) % sideItems.length;
    const item = sideItems[sideIndex];
    const layer = buildSideLayer(item);
    const old = sideLayer;
    sideLayer = layer;
    $('side').appendChild(layer);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      layer.classList.add('visible');
      fitMenuBoards(layer);
      if (old) { old.classList.remove('visible'); setTimeout(() => old.remove(), 700); }
    }));
    sideTimer = setTimeout(nextSideItem, Math.max(1, item.duration || 10) * 1000);
  }

  // Side layers: images/videos fill the panel directly; html/widget slides are
  // authored for a full 16:9 viewport, so render them full-size and scale down
  // to the panel width (vertically centred) — everything looks as designed.
  function buildSideLayer(item) {
    const layer = document.createElement('div');
    layer.className = 'layer';
    if (item.type === 'image') {
      const img = document.createElement('img');
      img.src = item.src;
      img.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
      layer.appendChild(img);
    } else if (item.type === 'video') {
      const video = document.createElement('video');
      video.src = item.src;
      video.autoplay = true; video.muted = true; video.playsInline = true; video.loop = true;
      video.style.objectFit = item.fit === 'contain' ? 'contain' : 'cover';
      layer.appendChild(video);
    } else {
      const panel = $('side');
      const scale = panel.clientWidth / window.innerWidth;
      const wrap = document.createElement('div');
      wrap.style.cssText = `width:${window.innerWidth}px;height:${window.innerHeight}px;`
        + `transform:scale(${scale});transform-origin:top left;position:absolute;`
        + `top:${Math.max(0, (panel.clientHeight - window.innerHeight * scale) / 2)}px;left:0`;
      const inner = item.type === 'widget' ? renderWidget(item.src) : (item.content || '');
      if (item.type === 'widget') layer._widgetHtml = inner;
      wrap.innerHTML = `<div class="html-slide">${inner}</div>`;
      layer.appendChild(wrap);
    }
    return layer;
  }

  // ---- physical rotation ----------------------------------------------------------

  function renderRotation() {
    const rotation = (manifest && manifest.screen && manifest.screen.rotation) || 0;
    const root = $('root');
    root.classList.remove('rot90', 'rot180', 'rot270');
    if (rotation) root.classList.add(`rot${rotation}`);
  }

  // ---- raffle number draw takeover --------------------------------------------------

  // Slot-machine reveal: one blur-spinning reel per digit, reels lock in
  // left to right with a thump, then the number goes gold under a confetti
  // burst. Timings: ~1.2s all-spin, 0.55s stagger per lock, 0.85s settle.
  let lastDrawKey = null;
  let drawTimers = [];
  let stopConfetti = null;

  function clearDrawAnim() {
    drawTimers.forEach(clearTimeout);
    drawTimers = [];
    if (stopConfetti) { stopConfetti(); stopConfetti = null; }
  }

  function renderDraw() {
    const overlay = $('draw');
    const draw = manifest && manifest.draw;
    if (!draw || draw.number == null) {
      overlay.style.display = 'none';
      clearDrawAnim();
      lastDrawKey = null;
      return;
    }
    $('draw-name').textContent = draw.name;
    overlay.style.display = 'flex';

    const key = `${draw.id}:${draw.number}:${draw.drawn_at}`;
    if (key === lastDrawKey) return; // same result, keep the settled board
    lastDrawKey = key;
    clearDrawAnim();
    overlay.classList.remove('celebrate');

    const prevEl = $('draw-prev');
    prevEl.classList.remove('show');
    prevEl.textContent = draw.previous_numbers && draw.previous_numbers.length
      ? `Already drawn: ${draw.previous_numbers.join('  ·  ')}` : '';

    const digits = String(draw.number).split('');
    const reels = $('draw-reels');
    reels.classList.remove('done');
    reels.style.fontSize = Math.min(20, 62 / digits.length) + 'vw';
    const stripHtml = '<div class="strip">'
      + '01234567890123456789'.split('').map((d) => `<span>${d}</span>`).join('') + '</div>';
    reels.innerHTML = digits.map(() => `<div class="reel spinning">${stripHtml}</div>`).join('');
    const reelEls = [...reels.children];

    const SPIN_MS = 1200, STAGGER_MS = 550, SETTLE_MS = 850;
    digits.forEach((digitChar, i) => {
      drawTimers.push(setTimeout(() => {
        const reel = reelEls[i];
        const strip = reel.firstElementChild;
        // Freeze the CSS spin where it is, then glide to the target digit
        // (second copy in the strip, so the reel always rolls downward).
        strip.style.transform = getComputedStyle(strip).transform;
        reel.classList.remove('spinning');
        void strip.offsetHeight; // commit frozen position before transitioning
        strip.style.transition = `transform ${SETTLE_MS}ms cubic-bezier(.15,.85,.3,1.12)`;
        strip.style.transform = `translateY(${-(10 + Number(digitChar)) * 1.14}em)`;
        reel.classList.add('locked');

        if (i === digits.length - 1) {
          drawTimers.push(setTimeout(() => {
            reels.classList.add('done');
            overlay.classList.add('celebrate');
            prevEl.classList.add('show');
            stopConfetti = launchConfetti($('draw-confetti'));
          }, SETTLE_MS));
        }
      }, SPIN_MS + i * STAGGER_MS));
    });
  }

  function launchConfetti(canvas) {
    canvas.width = canvas.offsetWidth;
    canvas.height = canvas.offsetHeight;
    const ctx = canvas.getContext('2d');
    const COLORS = ['#fbbf24', '#f472b6', '#a78bfa', '#f8fafc', '#34d399', '#60a5fa'];
    const parts = Array.from({ length: 170 }, (_, i) => {
      const fromLeft = i % 2 === 0;
      return {
        x: fromLeft ? -12 : canvas.width + 12,
        y: canvas.height * (0.55 + Math.random() * 0.35),
        vx: (fromLeft ? 1 : -1) * (canvas.width / 220) * (2.5 + Math.random() * 5),
        vy: -(canvas.height / 110) * (1.6 + Math.random() * 1.8),
        w: 6 + Math.random() * 9,
        h: 4 + Math.random() * 6,
        rot: Math.random() * Math.PI,
        vr: (Math.random() - 0.5) * 0.35,
        color: COLORS[i % COLORS.length],
        life: 0,
      };
    });
    let raf = null;
    let stopped = false;
    const gravity = canvas.height / 2600;
    const step = () => {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of parts) {
        p.life++;
        p.x += p.vx; p.vx *= 0.988;
        p.y += p.vy; p.vy += gravity;
        p.rot += p.vr;
        const alpha = Math.max(0, 1 - p.life / 260);
        if (alpha <= 0 || p.y > canvas.height + 30) continue;
        alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      if (alive && !stopped) raf = requestAnimationFrame(step);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
    raf = requestAnimationFrame(step);
    return () => {
      stopped = true;
      if (raf) cancelAnimationFrame(raf);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    };
  }

  // ---- CashKing live board takeover ----------------------------------------------

  const moneyAud = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const SUIT_GLYPH = { S: '♠', H: '♥', D: '♦', C: '♣' };
  let lastCkPick = null;

  function ckCardFace(code) {
    if (code === 'JOKER') return '🃏';
    return code.slice(0, -1) + (SUIT_GLYPH[code.slice(-1)] || '');
  }

  function renderCashKing() {
    const overlay = $('cashking');
    const game = manifest && manifest.card_game;
    if (!game) {
      overlay.style.display = 'none';
      lastCkPick = null;
      return;
    }
    overlay.style.display = 'flex';
    $('ck-name').textContent = game.name.toUpperCase();
    $('ck-sub').textContent = `${game.cards_left} cards left · find the Joker` + (game.session_text ? ` · ${game.session_text}` : '');
    $('ck-jackpot').textContent = moneyAud(game.jackpot);

    const pickKey = game.last_pick ? `${game.last_pick.index}:${game.last_pick.at}` : null;
    const isFresh = pickKey && pickKey !== lastCkPick;
    lastCkPick = pickKey;

    $('ck-board').innerHTML = game.cards.map((c) => {
      if (!c.revealed) return `<div class="ck-card down">${c.i + 1}</div>`;
      const red = c.card && 'HD'.includes(c.card.slice(-1));
      const fresh = isFresh && game.last_pick.index === c.i ? ' fresh' : '';
      return `<div class="ck-card up${red ? ' red' : ''}${c.card === 'JOKER' ? ' joker' : ''}${fresh}">${ckCardFace(c.card)}</div>`;
    }).join('');

    if (game.won) {
      $('ck-won').style.display = 'flex';
      $('ck-won-amount').textContent = moneyAud(game.jackpot);
      $('ck-won-sub').textContent = `${game.name} at ${manifest.venue.name} — congratulations!`;
    } else {
      $('ck-won').style.display = 'none';
      $('ck-banner').textContent = game.last_pick && isFresh
        ? `Card #${game.last_pick.index + 1} — no Joker! Jackpot rolls on 🡒 ${moneyAud(game.jackpot)}`
        : (game.last_pick ? `Last card: #${game.last_pick.index + 1}` : 'Waiting for tonight’s pick…');
    }
  }

  // ---- Wheel Spin takeover ----------------------------------------------------

  const WHEEL_COLORS = ['#7c3aed', '#db2777', '#f59e0b', '#059669', '#2563eb', '#dc2626', '#0891b2', '#65a30d'];
  let wheelId = null;
  let wheelRotation = 0;
  let lastSpinKey = null;
  let wheelTimer = null;
  let stopWheelConfetti = null;

  function wheelSvg(wedges) {
    const cx = 50, cy = 50, r = 48;
    const seg = 360 / wedges.length;
    let parts = '';
    wedges.forEach((w, i) => {
      const a0 = (i * seg - 90) * Math.PI / 180;
      const a1 = ((i + 1) * seg - 90) * Math.PI / 180;
      const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
      const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
      parts += `<path d="M${cx},${cy} L${x0.toFixed(2)},${y0.toFixed(2)} A${r},${r} 0 ${seg > 180 ? 1 : 0} 1 ${x1.toFixed(2)},${y1.toFixed(2)} Z" fill="${WHEEL_COLORS[i % WHEEL_COLORS.length]}" stroke="#0b0a1f" stroke-width=".7"/>`;
      const mid = (i + 0.5) * seg - 90;
      const lx = cx + r * 0.6 * Math.cos(mid * Math.PI / 180);
      const ly = cy + r * 0.6 * Math.sin(mid * Math.PI / 180);
      const fontSize = Math.min(4.4, 30 / Math.max(6, w.label.length));
      parts += `<text x="${lx.toFixed(2)}" y="${ly.toFixed(2)}" font-size="${fontSize}" fill="#fff" font-weight="700" font-family="system-ui,sans-serif" text-anchor="middle" dominant-baseline="middle" transform="rotate(${mid.toFixed(1)} ${lx.toFixed(2)} ${ly.toFixed(2)})">${esc(w.label)}</text>`;
    });
    return `<svg viewBox="0 0 100 100"><g id="wh-g">${parts}</g><circle cx="50" cy="50" r="7" fill="#0b0a1f" stroke="#fbbf24" stroke-width="1.6"/></svg>`;
  }

  function renderWheel() {
    const overlay = $('wheelov');
    const wheel = manifest && manifest.wheel;
    if (!wheel) {
      overlay.style.display = 'none';
      clearTimeout(wheelTimer);
      if (stopWheelConfetti) { stopWheelConfetti(); stopWheelConfetti = null; }
      wheelId = null;
      lastSpinKey = null;
      return;
    }
    overlay.style.display = 'flex';
    $('wh-name').textContent = wheel.name;

    const disc = $('wh-disc');
    if (wheelId !== wheel.id || !disc.firstChild) {
      wheelId = wheel.id;
      wheelRotation = 0;
      lastSpinKey = wheel.last_spin ? `${wheel.last_spin.index}:${wheel.last_spin.at}` : null; // don't replay old spins
      disc.style.transition = 'none';
      disc.style.transform = 'rotate(0deg)';
      disc.innerHTML = wheelSvg(wheel.wedges);
      $('wh-result').innerHTML = '<span style="opacity:.6">Ready to spin…</span>';
    }

    const spin = wheel.last_spin;
    const key = spin ? `${spin.index}:${spin.at}` : null;
    if (!spin || key === lastSpinKey) return;
    lastSpinKey = key;

    // Roll 4 extra turns, land the winning wedge centre under the pointer.
    const seg = 360 / wheel.wedges.length;
    const targetMod = (360 - ((spin.index + 0.5) * seg)) % 360;
    const delta = ((targetMod - (wheelRotation % 360)) % 360 + 360) % 360 + 4 * 360;
    wheelRotation += delta;
    $('wh-result').innerHTML = '<span style="opacity:.7">Spinning…</span>';
    disc.style.transition = 'transform 5s cubic-bezier(.12,.65,.15,1)';
    disc.style.transform = `rotate(${wheelRotation}deg)`;
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => {
      $('wh-result').innerHTML = `<span class="win">🎉 ${esc(spin.label)}</span>`;
      if (stopWheelConfetti) stopWheelConfetti();
      stopWheelConfetti = launchConfetti($('wh-confetti'));
    }, 5100);
  }

  // ---- Members Badge Draw takeover -----------------------------------------------

  let lastBadgeKey = null;
  let stopBadgeConfetti = null;

  function renderBadge() {
    const overlay = $('badgeov');
    const badge = manifest && manifest.badge_draw;
    if (!badge) {
      overlay.style.display = 'none';
      if (stopBadgeConfetti) { stopBadgeConfetti(); stopBadgeConfetti = null; }
      lastBadgeKey = null;
      return;
    }
    overlay.style.display = 'flex';
    $('bd-name').textContent = badge.name;
    $('bd-prize').textContent = moneyAud(badge.prize);

    const current = badge.current;
    const body = $('bd-body');
    if (!current) {
      body.innerHTML = '<div class="bd-sub" style="font-size:3vw">Tonight someone here wins it — are you in the room?</div>';
      return;
    }
    const key = `${current.number}:${current.drawn_at}:${current.outcome}`;
    if (key === lastBadgeKey) return;
    lastBadgeKey = key;

    if (current.outcome === 'pending') {
      body.innerHTML = `
        <div class="bd-member">#${esc(current.number)}</div>
        <div class="bd-membername">${esc(current.name || '')}</div>
        <div class="bd-count" data-count-to="${esc(current.deadline)}">--:--</div>
        <div class="bd-sub">Present your membership card at the bar before time runs out!</div>`;
    } else if (current.outcome === 'claimed') {
      $('bd-prize').textContent = moneyAud(current.prize ?? badge.prize);
      body.innerHTML = `
        <div class="bd-member" style="color:#fde68a">WINNER!</div>
        <div class="bd-membername">#${esc(current.number)} ${esc(current.name || '')}</div>
        <div class="bd-sub" style="font-size:2.8vw">Congratulations — collected in person! 🎉</div>`;
      if (stopBadgeConfetti) stopBadgeConfetti();
      stopBadgeConfetti = launchConfetti($('bd-confetti'));
    } else {
      body.innerHTML = `
        <div class="bd-member" style="opacity:.55">#${esc(current.number)}</div>
        <div class="bd-membername" style="opacity:.55">${esc(current.name || '')} wasn't here…</div>
        <div class="bd-sub" style="font-size:3vw;color:#fde68a;font-weight:800">JACKPOTS to ${moneyAud(badge.prize)} next draw!</div>`;
    }
  }

  // Claim-countdown ticker (mm:ss, red under 30s, TIME'S UP past deadline).
  setInterval(() => {
    document.querySelectorAll('[data-count-to]').forEach((el) => {
      const ms = Date.parse(el.dataset.countTo) - Date.now();
      if (ms <= 0) { el.textContent = "TIME'S UP"; el.style.color = '#f87171'; return; }
      const total = Math.ceil(ms / 1000);
      el.textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
      el.style.color = ms < 30000 ? '#f87171' : '';
    });
  }, 500);

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
