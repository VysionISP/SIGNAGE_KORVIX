'use strict';

// Korvix Signage dashboard — vanilla JS SPA over the CMS API.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  let venues = [];
  let venueId = localStorage.getItem('korvix.venue') || null;
  let activeTab = 'overview';
  let me = null; // current user {id, org_id, org_name, email, name, role}

  const ROLE_RANK = { viewer: 1, editor: 2, admin: 3, superadmin: 4 };
  const hasRole = (min) => me && ROLE_RANK[me.role] >= ROLE_RANK[min];
  const sessionToken = () => localStorage.getItem('korvix.session');

  // ---- API helper (session bearer) -------------------------------------------

  async function api(method, path, body) {
    const headers = {};
    if (sessionToken()) headers.Authorization = `Bearer ${sessionToken()}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      showAuth('login');
      throw new Error('unauthorised');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`${method} ${path.split('?')[0]} failed: ${data.error || res.status}`);
      throw new Error(data.error || String(res.status));
    }
    return data;
  }

  // ---- login / first-run setup ---------------------------------------------------

  function showAuth(mode) {
    $('#auth-overlay').style.display = 'flex';
    $('#auth-heading').textContent = mode === 'setup'
      ? 'Welcome! Create the first admin account' : 'Sign in';
    $('#auth-name').style.display = mode === 'setup' ? 'block' : 'none';
    $('#auth-submit').textContent = mode === 'setup' ? 'Create account' : 'Sign in';
    $('#auth-submit').dataset.mode = mode;
    $('#auth-error').textContent = '';
  }

  async function submitAuth() {
    const mode = $('#auth-submit').dataset.mode || 'login';
    const email = $('#auth-email').value.trim();
    const password = $('#auth-password').value;
    if (!email || !password) return;
    const res = await fetch(mode === 'setup' ? '/api/auth/setup' : '/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, name: $('#auth-name').value.trim() }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      $('#auth-error').textContent = data.error || `error ${res.status}`;
      return;
    }
    localStorage.setItem('korvix.session', data.token);
    me = data.user;
    $('#auth-overlay').style.display = 'none';
    $('#auth-password').value = '';
    enterApp();
  }

  $('#auth-submit').addEventListener('click', submitAuth);
  $('#auth-password').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

  $('#logout-btn').addEventListener('click', async () => {
    try { await api('POST', '/api/auth/logout'); } catch { /* session may be dead */ }
    localStorage.removeItem('korvix.session');
    location.reload();
  });

  function applyRoleUi() {
    $('#user-chip').textContent = me ? `${me.name || me.email} · ${me.role}${me.org_name ? ' @ ' + me.org_name : ' @ Korvix'}` : '';
    $('#logout-btn').style.display = me && me.id !== '_legacy' ? '' : 'none';
    $('#add-venue-btn').style.display = hasRole('admin') ? '' : 'none';
    renderNav();
  }

  async function enterApp() {
    applyRoleUi();
    await refresh();
    startPolling();
  }

  const venue = () => venues.find((v) => v.id === venueId) || venues[0] || null;

  // ---- shell -----------------------------------------------------------------

  async function loadVenues() {
    venues = (await api('GET', '/api/venues')).venues;
    if (!venue() && venues.length) venueId = venues[0].id;
    const sel = $('#venue-select');
    const option = (v) => `<option value="${v.id}" ${v.id === venueId ? 'selected' : ''}>${esc(v.name)}</option>`;
    if (me && me.role === 'superadmin') {
      // Group venues by business for the Korvix view.
      const byOrg = {};
      for (const v of venues) (byOrg[v.org_name || '(unassigned)'] ||= []).push(v);
      sel.innerHTML = Object.entries(byOrg).map(([org, vs]) =>
        `<optgroup label="${esc(org)}">${vs.map(option).join('')}</optgroup>`).join('')
        || '<option>No venues yet</option>';
    } else {
      sel.innerHTML = venues.map(option).join('') || '<option>No venues yet</option>';
    }
  }

  $('#venue-select').addEventListener('change', (e) => {
    venueId = e.target.value;
    localStorage.setItem('korvix.venue', venueId);
    render();
  });

  $('#add-venue-btn').addEventListener('click', async () => {
    const name = prompt('Venue name:');
    if (!name) return;
    const timezone = prompt('Timezone:', 'Australia/Sydney') || 'Australia/Sydney';
    const payload = { name, timezone };
    if (me.role === 'superadmin') {
      const { orgs } = await api('GET', '/api/orgs');
      if (!orgs.length) return alert('Create a business first (Businesses tab).');
      const orgName = prompt(`Which business?\n${orgs.map((o) => o.name).join('\n')}`, orgs[0].name);
      const org = orgs.find((o) => o.name.toLowerCase() === (orgName || '').trim().toLowerCase());
      if (!org) return alert('No business by that name.');
      payload.org_id = org.id;
    }
    const created = await api('POST', '/api/venues', payload);
    venueId = created.id;
    localStorage.setItem('korvix.venue', venueId);
    await refresh();
  });

  // ---- navigation: top-level sections with sub-pages -------------------------

  const NAV = [
    { tab: 'overview', label: 'Overview' },
    { tab: 'screens', label: 'Screens' },
    { label: 'Media', tabs: [['content', 'Content'], ['menus', 'Menus'], ['playlists', 'Playlists'], ['schedules', 'Schedules']] },
    { label: 'Games', tabs: [['draws', 'Draws'], ['cashking', 'CashKing'], ['tablet', 'Manage Tablet', 'admin']] },
    { tab: 'emergency', label: 'Emergency' },
    {
      label: 'Settings',
      tabs: [['venue', 'Venue', 'admin'], ['integrations', 'Integrations'], ['reports', 'Reports'],
        ['users', 'Users', 'admin'], ['orgs', 'Businesses', 'superadmin']],
    },
  ];

  function navGroupOf(tab) {
    return NAV.find((n) => n.tabs && n.tabs.some(([t]) => t === tab)) || null;
  }
  function visibleTabs(group) {
    return group.tabs.filter(([, , minRole]) => !minRole || hasRole(minRole));
  }

  function renderNav() {
    const group = navGroupOf(activeTab);
    $('#nav').innerHTML = NAV.map((n) => {
      if (n.tabs && !visibleTabs(n).length) return '';
      const active = n.tab ? n.tab === activeTab : n === group;
      return `<button data-nav="${n.tab || n.label}" class="${active ? 'active' : ''}">${n.label}</button>`;
    }).join('');
    const subnav = $('#subnav');
    if (group) {
      subnav.className = 'show';
      subnav.innerHTML = visibleTabs(group).map(([tab, label]) =>
        `<button data-nav="${tab}" class="${tab === activeTab ? 'active' : ''}">${label}</button>`).join('');
    } else {
      subnav.className = '';
      subnav.innerHTML = '';
    }
    document.querySelectorAll('section.tab').forEach((s) =>
      s.classList.toggle('active', s.id === `tab-${activeTab}`));
  }

  function goTab(tab) {
    activeTab = tab;
    renderNav();
    render();
  }

  const navClick = (e) => {
    const btn = e.target.closest('button[data-nav]');
    if (!btn) return;
    const target = btn.dataset.nav;
    const group = NAV.find((n) => n.tabs && n.label === target);
    goTab(group ? visibleTabs(group)[0][0] : target);
  };
  $('#nav').addEventListener('click', navClick);
  $('#subnav').addEventListener('click', navClick);

  async function refresh() {
    await loadVenues();
    await render();
  }

  async function render() {
    const v = venue();
    if (activeTab !== 'users' && activeTab !== 'orgs') {
      if (!v) {
        $('#tab-overview').innerHTML = '<div class="card">No venues yet — '
          + (hasRole('admin') ? 'click <b>+ Venue</b> to create one.' : 'ask your administrator to add one.') + '</div>';
        return;
      }
      venueId = v.id;
    }
    const renderers = {
      overview: renderOverview, screens: renderScreens, content: renderContent,
      playlists: renderPlaylists, schedules: renderSchedules, draws: renderDraws,
      emergency: renderEmergency, integrations: renderIntegrations, reports: renderReports,
      users: renderUsers, orgs: renderOrgs, cashking: renderCashKing, tablet: renderTablet,
      venue: renderVenueSettings, menus: renderMenus,
    };
    await renderers[activeTab]();
    await renderBanner();
  }

  async function renderBanner() {
    const { emergencies } = await api('GET', '/api/emergencies');
    const active = emergencies.filter((e) => e.active);
    const banner = $('#emergency-banner');
    if (active.length) {
      const em = active[0];
      banner.style.display = 'block';
      banner.textContent = `⚠ EMERGENCY ACTIVE — ${em.level.toUpperCase()}: ${em.title} (see Emergency tab to clear)`;
    } else {
      banner.style.display = 'none';
    }
  }

  // ---- overview ---------------------------------------------------------------

  async function renderOverview() {
    const { venues: health, connected_players } = await api('GET', '/api/health/overview');
    const { events } = await api('GET', '/api/events');
    $('#fleet-summary').textContent =
      `${health.reduce((n, v) => n + v.screens_online, 0)} screens online · ${connected_players} live connections`;

    $('#tab-overview').innerHTML = `
      <h2>Fleet health</h2>
      <div class="cards">
        ${health.map((v) => `
          <div class="card">
            <h3>${esc(v.name)} ${v.emergency ? '<span class="pill offline">EMERGENCY</span>' : ''}</h3>
            <div class="stat">${v.screens_online}<span class="muted" style="font-size:14px">/${v.screens_total} online</span></div>
            <div class="muted">${v.screens_offline ? `⚠ ${v.screens_offline} offline · ` : ''}${v.screens_unpaired ? `${v.screens_unpaired} unpaired` : ''}&nbsp;</div>
          </div>`).join('')}
      </div>
      <h2>Screens — ${esc(venue().name)}</h2>
      ${screenTable(health.find((h) => h.id === venueId)?.screens || [])}
      <div class="row" style="margin-top:16px">
        <h2 style="margin:0">Recent activity</h2>
        <div class="spacer"></div>
        ${hasRole('superadmin') ? `<a class="btn small secondary" download style="text-decoration:none"
           href="/api/backup?token=${encodeURIComponent(sessionToken() || '')}">⬇ Download backup</a>` : ''}
      </div>
      <table><tbody>
        ${events.slice(0, 12).map((e) => `
          <tr><td class="muted" style="white-space:nowrap">${new Date(e.created_at).toLocaleString()}</td>
          <td>${esc(e.type)}</td><td class="muted">${esc(e.detail)}</td></tr>`).join('')
          || '<tr><td class="muted">No activity yet</td></tr>'}
      </tbody></table>`;
  }

  function screenTable(screens) {
    return `<table>
      <thead><tr><th>Screen</th><th>Zone</th><th>Status</th><th>Last seen</th><th>Now playing</th></tr></thead>
      <tbody>${screens.map((s) => {
        let info = {};
        try { info = JSON.parse(s.player_info || '{}'); } catch { /* ignore */ }
        return `<tr>
          <td>${esc(s.name)} <span class="muted">${s.orientation === 'portrait' ? '▯' : '▭'}</span></td>
          <td class="muted">${esc(zoneName(s.zone_id))}</td>
          <td><span class="pill ${s.status}">${s.status}</span></td>
          <td class="muted">${s.last_seen_at ? new Date(s.last_seen_at).toLocaleTimeString() : '—'}</td>
          <td class="muted">${esc(info.current_item || '')}${info.playlist ? ` <span style="opacity:.6">(${esc(info.playlist)})</span>` : ''}</td>
        </tr>`;
      }).join('') || '<tr><td class="muted" colspan="5">No screens yet</td></tr>'}</tbody></table>`;
  }

  function zoneName(zoneId) {
    const z = (venue()?.zones || []).find((z) => z.id === zoneId);
    return z ? z.name : '—';
  }

  // ---- screens ------------------------------------------------------------------

  async function renderScreens() {
    const [{ screens }, { pairings }, { playlists }, { feeds }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/screens`),
      api('GET', '/api/pairings'),
      api('GET', `/api/venues/${venueId}/playlists`),
      api('GET', `/api/integrations/${venueId}`),
    ]);
    const zones = venue().zones || [];
    const tickerMessages = (feeds.find((f) => f.source === 'ticker')?.payload?.messages) || [];

    $('#tab-screens').innerHTML = `
      <h2>Screens</h2>
      <p class="muted">Channel: <b>Main</b> plays scheduled playlists; <b>Racing</b> screens are dedicated
      next-to-go / results boards fed live (set the jurisdiction on the Integrations tab); <b>Sports</b> shows the fixtures feed full-time.</p>
      <table>
        <thead><tr><th>Name</th><th>Zone</th><th>Channel</th><th>Layout</th><th>Rotation</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
        <tbody>${screens.map((s) => `
          <tr>
            <td>${esc(s.name)} <span class="muted">${s.orientation}</span></td>
            <td class="muted">${esc(zoneName(s.zone_id))}</td>
            <td><select data-channel="${s.id}">
              ${[['main', 'Main (playlists)'], ['racing1', 'Racing — Next To Go'], ['racing2', 'Racing — 2nd race'],
                 ['racing3', 'Racing — 3rd race'], ['racing-results', 'Racing — Results'], ['sports', 'Sports']]
                .map(([v, label]) => `<option value="${v}" ${(s.channel || 'main') === v ? 'selected' : ''}>${label}</option>`).join('')}
            </select></td>
            <td>
              <select data-layout="${s.id}">
                ${[['full', 'Full screen'], ['side', 'Main + side panel'], ['ticker', 'Main + ticker'], ['side-ticker', 'Main + side + ticker']]
                  .map(([v, label]) => `<option value="${v}" ${(s.layout || 'full') === v ? 'selected' : ''}>${label}</option>`).join('')}
              </select>
              ${(s.layout === 'side' || s.layout === 'side-ticker') ? `
              <select data-sidepl="${s.id}" style="margin-top:4px" title="What plays in the side panel">
                <option value="">side panel: — pick playlist —</option>
                ${playlists.map((p) => `<option value="${p.id}" ${s.side_playlist_id === p.id ? 'selected' : ''}>side: ${esc(p.name)}</option>`).join('')}
              </select>` : ''}
            </td>
            <td><select data-rotate="${s.id}">
              ${[0, 90, 180, 270].map((r) => `<option value="${r}" ${(s.rotation || 0) === r ? 'selected' : ''}>${r}&deg;</option>`).join('')}
            </select></td>
            <td><span class="pill ${s.status}">${s.status}</span></td>
            <td class="muted">${s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : '—'}</td>
            <td class="row" style="justify-content:flex-end">
              ${s.device_key
                ? `<a class="btn small secondary" href="/player/?preview=${esc(s.device_key)}" target="_blank" style="text-decoration:none">👁 Preview</a>
                   <button class="btn small secondary" data-act="kiosk" data-key="${esc(s.device_key)}">Copy kiosk URL</button>
                   <button class="btn small secondary" data-act="unpair" data-id="${s.id}">Unpair</button>`
                : `<button class="btn small" data-act="pair" data-id="${s.id}">Pair device</button>`}
              <button class="btn small danger" data-act="del-screen" data-id="${s.id}">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="8">No screens yet</td></tr>'}
        </tbody>
      </table>

      <h2>Ticker messages <span class="muted" style="font-weight:400;font-size:13px">· shown on screens with a ticker layout</span></h2>
      <div class="card">
        <textarea id="ticker-msgs" placeholder="One message per line — e.g.&#10;Happy hour 3–6pm daily&#10;Live music Friday — The Flannel Shirts&#10;Book your Christmas party now" style="min-height:70px">${esc(tickerMessages.join('\n'))}</textarea>
        <button class="btn small" id="ticker-save" style="margin-top:8px">Save ticker</button>
      </div>

      <h2>Add screen</h2>
      <div class="form-grid card">
        <label>Name<input id="scr-name" placeholder="Bar LED Wall"></label>
        <label>Zone<select id="scr-zone">
          <option value="">— none —</option>
          ${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}
        </select></label>
        <label>Orientation<select id="scr-orient"><option>landscape</option><option>portrait</option></select></label>
        <button class="btn" id="scr-add">Add screen</button>
      </div>

      <h2>Zones</h2>
      <div class="row">
        ${zones.map((z) => `<span class="pill unpaired">${esc(z.name)} <a href="#" data-act="del-zone" data-id="${z.id}" style="color:inherit">✕</a></span>`).join('')}
        <input id="zone-name" placeholder="New zone name" style="max-width:180px">
        <button class="btn small" id="zone-add">Add zone</button>
      </div>

      <h2>Unpaired player devices</h2>
      <p class="muted">Open <a href="/player/" target="_blank">/player/</a> on any screen — it shows a pairing code. Claim it with the “Pair device” button on a screen above.
      Then set that screen's <b>kiosk URL</b> as the TV browser's homepage — it pins the pairing permanently, surviving refreshes,
      reboots and TV browsers that wipe their storage.</p>
      <table><tbody>
        ${pairings.map((pr) => `<tr><td style="font-family:monospace;font-size:16px;letter-spacing:.2em">${esc(pr.pairing_code)}</td>
          <td class="muted">registered ${new Date(pr.created_at).toLocaleString()}</td></tr>`).join('')
          || '<tr><td class="muted">No devices waiting to pair</td></tr>'}
      </tbody></table>`;

    $('#scr-add').onclick = async () => {
      const name = $('#scr-name').value.trim();
      if (!name) return alert('Screen name required');
      await api('POST', `/api/venues/${venueId}/screens`, {
        name, zone_id: $('#scr-zone').value || null, orientation: $('#scr-orient').value,
      });
      render();
    };
    $('#zone-add').onclick = async () => {
      const name = $('#zone-name').value.trim();
      if (!name) return;
      await api('POST', `/api/venues/${venueId}/zones`, { name });
      await refresh();
    };
    $('#tab-screens').onchange = async (e) => {
      const rotate = e.target.closest('[data-rotate]');
      if (rotate) return api('PATCH', `/api/screens/${rotate.dataset.rotate}`, { rotation: parseInt(rotate.value, 10) });
      const channel = e.target.closest('[data-channel]');
      if (channel) return api('PATCH', `/api/screens/${channel.dataset.channel}`, { channel: channel.value });
      const layout = e.target.closest('[data-layout]');
      if (layout) { await api('PATCH', `/api/screens/${layout.dataset.layout}`, { layout: layout.value }); return render(); }
      const sidepl = e.target.closest('[data-sidepl]');
      if (sidepl) return api('PATCH', `/api/screens/${sidepl.dataset.sidepl}`, { side_playlist_id: sidepl.value || null });
    };
    $('#ticker-save').onclick = async () => {
      const messages = $('#ticker-msgs').value.split('\n').map((l) => l.trim()).filter(Boolean);
      await api('POST', `/api/integrations/${venueId}/ticker`, { messages });
      $('#ticker-save').textContent = '✓ Saved';
      setTimeout(() => { $('#ticker-save').textContent = 'Save ticker'; }, 1500);
    };
    $('#tab-screens').onclick = async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'kiosk') {
        const url = `${location.origin}/player/?key=${el.dataset.key}`;
        try { await navigator.clipboard.writeText(url); el.textContent = 'Copied ✓'; }
        catch { prompt('Kiosk URL — set as the TV browser homepage:', url); }
        setTimeout(() => { el.textContent = 'Copy kiosk URL'; }, 1500);
        return;
      }
      e.preventDefault();
      const screenId = el.dataset.id;
      if (el.dataset.act === 'pair') {
        const code = prompt('Enter the pairing code shown on the screen:');
        if (code) { await api('POST', `/api/screens/${screenId}/pair`, { pairing_code: code }); render(); }
      } else if (el.dataset.act === 'unpair') {
        await api('POST', `/api/screens/${screenId}/unpair`); render();
      } else if (el.dataset.act === 'del-screen') {
        if (confirm('Delete this screen?')) { await api('DELETE', `/api/screens/${screenId}`); render(); }
      } else if (el.dataset.act === 'del-zone') {
        if (confirm('Delete this zone? Screens keep running but lose the zone assignment.')) {
          await api('DELETE', `/api/zones/${screenId}`); await refresh();
        }
      }
    };
  }

  // ---- content --------------------------------------------------------------------

  function mediaThumb(m) {
    if (m.type === 'image') return `<img src="${esc(m.src)}" loading="lazy" style="width:86px;height:52px;object-fit:cover;border-radius:6px;background:#000;display:block">`;
    if (m.type === 'video') return `<video src="${esc(m.src)}" preload="metadata" muted style="width:86px;height:52px;object-fit:cover;border-radius:6px;background:#000;display:block"></video>`;
    const icon = { html: '📝', widget: '📊', url: '🌐' }[m.type] || '🖼';
    return `<div style="width:86px;height:52px;border-radius:6px;background:var(--panel2);display:flex;align-items:center;justify-content:center;font-size:22px">${icon}</div>`;
  }

  // Raw-body upload with the session attached (api() is JSON-only).
  function uploadFile(file) {
    return fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, {
      method: 'POST',
      headers: sessionToken() ? { Authorization: `Bearer ${sessionToken()}` } : {},
      body: file,
    });
  }

  // Upload files and auto-create a media entry for each. Returns error names.
  async function uploadGraphics(files) {
    const failed = [];
    for (const file of files) {
      try {
        const up = await uploadFile(file);
        const uploaded = await up.json();
        if (!up.ok) throw new Error(uploaded.error || up.status);
        const isVideo = /^video\//.test(file.type) || /\.(mp4|webm)$/i.test(file.name);
        await api('POST', `/api/venues/${venueId}/media`, {
          name: file.name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' '),
          type: isVideo ? 'video' : 'image',
          src: uploaded.url,
          duration_seconds: isVideo ? 30 : 10,
        });
      } catch (err) {
        failed.push(`${file.name}: ${err.message}`);
      }
    }
    if (failed.length) alert('Some uploads failed:\n' + failed.join('\n'));
  }

  // "Where it plays" panels that stay open across re-renders.
  const whereOpen = new Set();

  async function renderContent() {
    const [{ media }, uploads, { playlists }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/media`),
      api('GET', '/api/uploads'),
      api('GET', `/api/venues/${venueId}/playlists`),
    ]);
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

    // media_id -> [{playlist, itemId}] so tick-boxes can add/remove directly.
    const playsIn = new Map();
    for (const p of playlists) {
      for (const item of p.items) {
        if (!playsIn.has(item.media_id)) playsIn.set(item.media_id, []);
        playsIn.get(item.media_id).push({ playlist: p, itemId: item.id });
      }
    }

    const card = (m) => {
      const inLists = playsIn.get(m.id) || [];
      const isFile = m.type === 'image' || m.type === 'video';
      return `
      <div class="mcard">
        <div class="mthumb">
          ${m.type === 'image' ? `<img src="${esc(m.src)}" loading="lazy">`
            : m.type === 'video' ? `<video src="${esc(m.src)}" preload="metadata" muted></video>`
              : ({ html: '📝', widget: '📊', url: '🌐' }[m.type] || '🖼')}
          <button class="mdel" data-del="${m.id}" title="Delete">✕</button>
          <span class="mdur" data-dur="${m.id}" data-cur="${m.duration_seconds}" title="Seconds on screen — click to change">${m.duration_seconds}s</span>
        </div>
        <div class="mbody">
          <div class="mname" data-rename="${m.id}" data-cur="${esc(m.name)}" title="Click to rename">${esc(m.name)}</div>
          <div class="mrow">
            ${inLists.length
              ? inLists.map((x) => `<span class="chip on">▶ ${esc(x.playlist.name)}</span>`).join('')
              : '<span class="chip" style="color:var(--warn)">not on any screens yet</span>'}
          </div>
          <div class="mrow">
            <button class="btn small secondary" data-where="${m.id}">Where it plays ▾</button>
            ${isFile ? `<button class="btn small secondary" data-fit="${m.id}" data-cur="${m.fit || 'cover'}"
              title="Fill screen crops to fit · Show all letterboxes">${(m.fit || 'cover') === 'cover' ? '↔ Fill screen' : '▣ Show all'}</button>` : ''}
          </div>
          <div class="mwhere ${whereOpen.has(m.id) ? 'open' : ''}" data-wherepanel="${m.id}">
            ${playlists.length ? playlists.map((p) => {
              const hit = inLists.find((x) => x.playlist.id === p.id);
              return `<label><input type="checkbox" data-toggle="${m.id}" data-pl="${p.id}" data-item="${hit ? hit.itemId : ''}" ${hit ? 'checked' : ''}>
                ${esc(p.name)}</label>`;
            }).join('')
              : `<div class="muted" style="font-size:12px">No playlists yet.</div>
                 <button class="btn small" data-mkloop="${m.id}" style="margin-top:6px">▶ Play on all screens (creates "Main loop")</button>`}
          </div>
        </div>
      </div>`;
    };

    $('#tab-content').innerHTML = `
      <div id="dropzone" class="card" style="border:2px dashed var(--line);text-align:center;padding:34px;cursor:pointer;margin-top:0">
        <div style="font-size:32px">🖼️</div>
        <div style="margin:6px 0;font-size:16px"><b>Drop your posters, menus or videos here</b> — or click to choose files</div>
        <div class="muted">JPG, PNG, GIF, MP4… up to 200 MB each. Then tick where each one plays.</div>
        <input id="dz-input" type="file" accept="image/*,video/*" multiple style="display:none">
      </div>
      <div id="dz-progress" class="muted" style="margin:8px 2px"></div>
      <div id="upload-hint">✓ Uploaded! Tick where each new graphic should play — it goes live on those screens straight away.</div>

      <h2>Your media <span class="muted" style="font-weight:400;font-size:13px">· click a name to rename · click the seconds badge to change how long it shows</span></h2>
      <div class="media-grid">
        ${media.map(card).join('') || '<div class="muted">Nothing here yet — drop some graphics above.</div>'}
      </div>

      <details class="adv">
        <summary>Advanced: add by web address, HTML slide or live widget</summary>
        <div class="card">
          <div class="form-grid">
            <label>Name<input id="md-name" placeholder="Happy hour promo"></label>
            <label>Type<select id="md-type">
              <option value="image">image — URL or upload</option>
              <option value="video">video — URL or upload</option>
              <option value="url">url — live web page</option>
              <option value="html">html — inline slide</option>
              <option value="widget">widget — live data</option>
            </select></label>
            <label>Duration (seconds)<input id="md-dur" type="number" value="10" min="1"></label>
          </div>
          <div class="form-grid">
            <label id="md-src-wrap">Source URL / widget name
              <input id="md-src" placeholder="https://… or /uploads/… — widgets: jackpot, menu, weather, sports, racing:1, birthdays, happyhour, cashking, welcome"></label>
            <label>Or upload a file<input id="md-file" type="file" accept="image/*,video/*"></label>
          </div>
          <label style="display:block;margin-bottom:10px" id="md-html-wrap">HTML slide markup
            <textarea id="md-html" placeholder="&lt;div&gt;…full-screen slide markup…&lt;/div&gt;"></textarea></label>
          <button class="btn" id="md-add">Add media</button>
        </div>
      </details>

      <details class="adv">
        <summary>Storage: uploaded files (${mb(uploads.total_bytes)} on disk)</summary>
        <table>
          <tbody>${uploads.files.map((f) => `
            <tr>
              <td><a href="${esc(f.url)}" target="_blank">${esc(f.name)}</a></td>
              <td class="muted">${mb(f.bytes)}</td>
              <td class="muted">${new Date(f.uploaded_at).toLocaleString()}</td>
              <td>${f.used_by.length
                ? `<span class="pill online">in use: ${esc(f.used_by.map((u) => u.name).join(', ')).slice(0, 60)}</span>`
                : '<span class="pill never-connected">unused</span>'}</td>
              <td style="text-align:right"><button class="btn small danger" data-delfile="${esc(f.name)}" data-used="${f.used_by.length}">Delete file</button></td>
            </tr>`).join('') || '<tr><td class="muted">Nothing uploaded yet</td></tr>'}
          </tbody>
        </table>
      </details>`;

    $('#md-add').onclick = async () => {
      const name = $('#md-name').value.trim();
      const type = $('#md-type').value;
      if (!name) return alert('Name required');
      let src = $('#md-src').value.trim();
      const file = $('#md-file').files[0];
      if (file) {
        const up = await uploadFile(file);
        const uploaded = await up.json();
        if (!up.ok) return alert('Upload failed: ' + (uploaded.error || up.status));
        src = uploaded.url;
      }
      await api('POST', `/api/venues/${venueId}/media`, {
        name, type, src, content: $('#md-html').value,
        duration_seconds: parseInt($('#md-dur').value, 10) || 10,
      });
      render();
    };
    // Drag & drop / click-to-choose upload
    const dropzone = $('#dropzone');
    const dzInput = $('#dz-input');
    const handleFiles = async (files) => {
      if (!files.length) return;
      $('#dz-progress').textContent = `Uploading ${files.length} file${files.length > 1 ? 's' : ''}…`;
      const before = new Set(media.map((m) => m.id));
      await uploadGraphics([...files]);
      $('#dz-progress').textContent = '';
      // Auto-open the "where it plays" panel on everything new.
      const after = (await api('GET', `/api/venues/${venueId}/media`)).media;
      after.filter((m) => !before.has(m.id)).forEach((m) => whereOpen.add(m.id));
      await render();
      const hint = $('#upload-hint');
      if (hint) hint.style.display = 'block';
    };
    dropzone.onclick = () => dzInput.click();
    dzInput.onchange = () => handleFiles(dzInput.files);
    dropzone.ondragover = (e) => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; };
    dropzone.ondragleave = () => { dropzone.style.borderColor = 'var(--line)'; };
    dropzone.ondrop = (e) => {
      e.preventDefault();
      dropzone.style.borderColor = 'var(--line)';
      handleFiles(e.dataTransfer.files);
    };

    // onclick (not addEventListener) so re-renders don't stack handlers
    $('#tab-content').onclick = async (e) => {
      if (e.target.closest('#dropzone')) return; // handled above
      const del = e.target.closest('[data-del]');
      if (del && confirm('Delete this media? It is removed from any playlists.')) {
        await api('DELETE', `/api/media/${del.dataset.del}`);
        return render();
      }
      const fit = e.target.closest('[data-fit]');
      if (fit) {
        await api('PATCH', `/api/media/${fit.dataset.fit}`, {
          fit: fit.dataset.cur === 'cover' ? 'contain' : 'cover',
        });
        return render();
      }
      const delFile = e.target.closest('[data-delfile]');
      if (delFile) {
        const used = delFile.dataset.used !== '0';
        const msg = used
          ? 'This file is STILL USED by media items — deleting it will break them. Delete anyway?'
          : 'Delete this uploaded file from the server?';
        if (!confirm(msg)) return;
        await api('DELETE', `/api/uploads/${encodeURIComponent(delFile.dataset.delfile)}?force=${used ? 1 : 0}`);
        return render();
      }
      const where = e.target.closest('[data-where]');
      if (where) {
        const mediaId = where.dataset.where;
        if (whereOpen.has(mediaId)) whereOpen.delete(mediaId); else whereOpen.add(mediaId);
        document.querySelector(`[data-wherepanel="${mediaId}"]`).classList.toggle('open');
        return;
      }
      const dur = e.target.closest('[data-dur]');
      if (dur) {
        const secs = prompt('Seconds on screen:', dur.dataset.cur);
        if (secs && parseInt(secs, 10) > 0) {
          await api('PATCH', `/api/media/${dur.dataset.dur}`, { duration_seconds: parseInt(secs, 10) });
          render();
        }
        return;
      }
      const rename = e.target.closest('[data-rename]');
      if (rename) {
        const name = prompt('Name:', rename.dataset.cur);
        if (name && name.trim()) {
          await api('PATCH', `/api/media/${rename.dataset.rename}`, { name: name.trim() });
          render();
        }
        return;
      }
      const mkloop = e.target.closest('[data-mkloop]');
      if (mkloop) {
        // First-run helper: one playlist playing on every screen, all day.
        const playlist = await api('POST', `/api/venues/${venueId}/playlists`, { name: 'Main loop' });
        await api('POST', `/api/venues/${venueId}/schedules`, { name: 'Main loop — all day', playlist_id: playlist.id });
        await api('POST', `/api/playlists/${playlist.id}/items`, { media_id: mkloop.dataset.mkloop });
        return render();
      }
    };

    // Tick-boxes: on = add to that playlist, off = pull it out. Instant.
    $('#tab-content').onchange = async (e) => {
      const toggle = e.target.closest('[data-toggle]');
      if (!toggle) return;
      whereOpen.add(toggle.dataset.toggle);
      if (toggle.checked) {
        await api('POST', `/api/playlists/${toggle.dataset.pl}/items`, { media_id: toggle.dataset.toggle });
      } else if (toggle.dataset.item) {
        await api('DELETE', `/api/playlist-items/${toggle.dataset.item}`);
      }
      render();
    };
  }

  // ---- menu board designer -------------------------------------------------------------

  function menuFromDom(card) {
    return {
      name: card.querySelector('[data-mn-name]').value.trim() || 'Menu',
      theme: card.querySelector('[data-mn-theme]').value,
      sections: [...card.querySelectorAll('[data-mn-section]')].map((sec) => ({
        title: sec.querySelector('[data-mn-title]').value.trim(),
        items: [...sec.querySelectorAll('[data-mn-item]')].map((row) => ({
          name: row.querySelector('[data-mn-iname]').value.trim(),
          desc: row.querySelector('[data-mn-idesc]').value.trim(),
          price: row.querySelector('[data-mn-iprice]').value.trim(),
          sold_out: row.querySelector('[data-mn-isold]').checked,
          photo: row.querySelector('[data-mn-iphoto]').value || null,
        })).filter((i) => i.name),
      })),
    };
  }

  const photoCellHtml = (photo) => photo
    ? `<img src="${esc(photo)}" style="width:30px;height:30px;object-fit:cover;border-radius:5px;vertical-align:middle">
       <a href="#" data-mn-clearphoto title="Remove photo" style="color:var(--bad);font-size:11px">✕</a>`
    : '<button class="btn small secondary" data-mn-photobtn title="Add a photo of this dish">📷</button>';

  const itemRowHtml = (item = {}) => `
    <div class="row" data-mn-item style="margin-top:6px;flex-wrap:nowrap">
      <span data-mn-photocell style="white-space:nowrap">${photoCellHtml(item.photo)}</span>
      <input type="hidden" data-mn-iphoto value="${esc(item.photo || '')}">
      <input data-mn-iname placeholder="Item — e.g. Chicken Schnitzel" value="${esc(item.name || '')}" style="flex:2;min-width:140px">
      <input data-mn-idesc placeholder="Description (optional)" value="${esc(item.desc || '')}" style="flex:3;min-width:120px">
      <input data-mn-iprice type="number" step="0.5" placeholder="$" value="${item.price ?? ''}" style="width:84px">
      <label style="display:flex;gap:4px;align-items:center;font-size:12px;color:var(--muted);white-space:nowrap">
        <input type="checkbox" data-mn-isold ${item.sold_out ? 'checked' : ''}>sold out</label>
      <button class="btn small danger" data-mn-delitem>✕</button>
    </div>`;

  const MENU_THEME_OPTIONS = [
    ['classic', 'Classic — dark & gold'], ['chalkboard', 'Chalkboard — timber frame'],
    ['modern', 'Modern — light & coral'], ['pub', 'Old Pub — deep red serif'],
    ['coastal', 'Coastal — light blue'], ['neon', 'Neon — cocktail bar'],
    ['minimal', 'Minimal — black & white'], ['cafe', 'Café — warm paper'],
  ];

  const sectionHtml = (section = { title: '', items: [{}] }) => `
    <div data-mn-section style="border:1px solid var(--line);border-radius:8px;padding:10px;margin-top:10px">
      <div class="row">
        <input data-mn-title placeholder="Section — e.g. Mains" value="${esc(section.title || '')}" style="font-weight:700;max-width:260px">
        <div class="spacer"></div>
        <button class="btn small secondary" data-mn-additem>+ item</button>
        <button class="btn small danger" data-mn-delsection>remove section</button>
      </div>
      ${(section.items && section.items.length ? section.items : [{}]).map(itemRowHtml).join('')}
    </div>`;

  async function renderMenus() {
    const { menus } = await api('GET', `/api/venues/${venueId}/menus`);

    $('#tab-menus').innerHTML = `
      <h2>Menu boards</h2>
      <p class="muted">Design menus here — each one appears in <b>Content</b> as a "<i>name</i> board" ready to tick onto
      playlists like any graphic. Every save (and every sold-out tick) updates the screens within a second.</p>
      <div class="row" style="margin-bottom:6px">
        <input id="mn-new-name" placeholder="New menu — e.g. Bistro Dinner" style="max-width:260px">
        <button class="btn" id="mn-create">Create menu</button>
      </div>
      ${menus.map((menu) => `
        <div class="card" data-mn-card="${menu.id}">
          <div class="row">
            <input data-mn-name value="${esc(menu.name)}" style="font-weight:800;font-size:16px;max-width:280px">
            <select data-mn-theme title="Board design">
              ${MENU_THEME_OPTIONS.map(([v, label]) => `<option value="${v}" ${(menu.theme || 'classic') === v ? 'selected' : ''}>${label}</option>`).join('')}
            </select>
            <span class="muted">updated ${new Date(menu.updated_at).toLocaleString()}</span>
            <div class="spacer"></div>
            <button class="btn" data-mn-save>Save to screens</button>
            <button class="btn small secondary" data-mn-addsection>+ section</button>
            <button class="btn small danger" data-mn-delete>Delete menu</button>
          </div>
          <div data-mn-sections>${menu.sections.map(sectionHtml).join('')}</div>
        </div>`).join('') || ''}
      <input type="file" id="mn-photo-file" accept="image/*" style="display:none">`;

    $('#mn-create').onclick = async () => {
      const name = $('#mn-new-name').value.trim();
      if (!name) return alert('Give the menu a name — e.g. Bistro Dinner');
      await api('POST', `/api/venues/${venueId}/menus`, { name, sections: [{ title: 'Mains', items: [] }] });
      render();
    };

    // Item photo upload: one shared hidden file input, aimed at the row
    // whose 📷 button was last clicked.
    let photoTargetRow = null;
    $('#mn-photo-file').onchange = async () => {
      const file = $('#mn-photo-file').files[0];
      if (!file || !photoTargetRow) return;
      const up = await uploadFile(file);
      const uploaded = await up.json();
      if (!up.ok) return alert('Photo upload failed: ' + (uploaded.error || up.status));
      photoTargetRow.querySelector('[data-mn-iphoto]').value = uploaded.url;
      photoTargetRow.querySelector('[data-mn-photocell]').innerHTML = photoCellHtml(uploaded.url);
      $('#mn-photo-file').value = '';
    };

    $('#tab-menus').onclick = async (e) => {
      const photoBtn = e.target.closest('[data-mn-photobtn]');
      if (photoBtn) {
        photoTargetRow = photoBtn.closest('[data-mn-item]');
        $('#mn-photo-file').click();
        return;
      }
      const clearPhoto = e.target.closest('[data-mn-clearphoto]');
      if (clearPhoto) {
        e.preventDefault();
        const row = clearPhoto.closest('[data-mn-item]');
        row.querySelector('[data-mn-iphoto]').value = '';
        row.querySelector('[data-mn-photocell]').innerHTML = photoCellHtml(null);
        return;
      }
      const card = e.target.closest('[data-mn-card]');
      if (!card) return;
      const menuId = card.dataset.mnCard;
      if (e.target.closest('[data-mn-save]')) {
        await api('PATCH', `/api/menus/${menuId}`, menuFromDom(card));
        e.target.textContent = '✓ Saved';
        setTimeout(() => { render(); }, 900);
      } else if (e.target.closest('[data-mn-addsection]')) {
        card.querySelector('[data-mn-sections]').insertAdjacentHTML('beforeend', sectionHtml());
      } else if (e.target.closest('[data-mn-additem]')) {
        e.target.closest('[data-mn-section]').insertAdjacentHTML('beforeend', itemRowHtml());
      } else if (e.target.closest('[data-mn-delitem]')) {
        e.target.closest('[data-mn-item]').remove();
      } else if (e.target.closest('[data-mn-delsection]')) {
        if (confirm('Remove this whole section?')) e.target.closest('[data-mn-section]').remove();
      } else if (e.target.closest('[data-mn-delete]')) {
        if (confirm('Delete this menu? Its board is removed from Content and any playlists.')) {
          await api('DELETE', `/api/menus/${menuId}`);
          render();
        }
      }
    };

    // Sold-out ticks and theme changes save immediately.
    $('#tab-menus').onchange = async (e) => {
      if (!e.target.matches('[data-mn-isold]') && !e.target.matches('[data-mn-theme]')) return;
      const card = e.target.closest('[data-mn-card]');
      if (card) await api('PATCH', `/api/menus/${card.dataset.mnCard}`, menuFromDom(card));
    };
  }

  // ---- playlists --------------------------------------------------------------------

  async function renderPlaylists() {
    const [{ playlists }, { media }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/playlists`),
      api('GET', `/api/venues/${venueId}/media`),
    ]);
    const mediaOptions = media.map((m) => `<option value="${m.id}">${esc(m.name)} (${m.type})</option>`).join('');

    $('#tab-playlists').innerHTML = `
      <h2>Playlists</h2>
      <div class="row" style="margin-bottom:14px">
        <input id="pl-name" placeholder="New playlist name" style="max-width:240px">
        <button class="btn" id="pl-add">Create playlist</button>
      </div>
      ${playlists.map((p) => `
        <div class="card" style="margin-bottom:14px">
          <div class="row">
            <h3 style="margin:0">${esc(p.name)}</h3>
            <span class="muted">${p.items.length} item${p.items.length === 1 ? '' : 's'}</span>
            <div class="spacer"></div>
            <button class="btn small danger" data-act="del-pl" data-id="${p.id}">Delete playlist</button>
          </div>
          <table style="margin-top:10px"><tbody>
            ${p.items.map((it, i) => `
              <tr>
                <td class="muted" style="width:30px">${i + 1}</td>
                <td>${esc(it.name)} <span class="muted">(${esc(it.type)})</span></td>
                <td style="text-align:right;white-space:nowrap">
                  <button class="btn small secondary" data-act="up" data-id="${it.id}" data-pl="${p.id}" ${i === 0 ? 'disabled' : ''}>↑</button>
                  <button class="btn small secondary" data-act="down" data-id="${it.id}" data-pl="${p.id}" ${i === p.items.length - 1 ? 'disabled' : ''}>↓</button>
                  <button class="btn small danger" data-act="del-item" data-id="${it.id}">✕</button>
                </td>
              </tr>`).join('') || '<tr><td class="muted">Empty — add media below</td></tr>'}
          </tbody></table>
          <div class="row" style="margin-top:10px">
            <select data-add-select="${p.id}">${mediaOptions}</select>
            <button class="btn small" data-act="add-item" data-id="${p.id}">Add to playlist</button>
          </div>
        </div>`).join('') || '<div class="muted">No playlists yet.</div>'}`;

    $('#pl-add').onclick = async () => {
      const name = $('#pl-name').value.trim();
      if (!name) return;
      await api('POST', `/api/venues/${venueId}/playlists`, { name });
      render();
    };
    $('#tab-playlists').onclick = async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      const { act, id, pl } = el.dataset;
      if (act === 'del-pl') {
        if (confirm('Delete playlist? Schedules using it are removed.')) {
          await api('DELETE', `/api/playlists/${id}`); render();
        }
      } else if (act === 'add-item') {
        const select = document.querySelector(`[data-add-select="${id}"]`);
        if (!select.value) return;
        await api('POST', `/api/playlists/${id}/items`, { media_id: select.value });
        render();
      } else if (act === 'del-item') {
        await api('DELETE', `/api/playlist-items/${id}`); render();
      } else if (act === 'up' || act === 'down') {
        const { playlists: fresh } = await api('GET', `/api/venues/${venueId}/playlists`);
        const playlist = fresh.find((x) => x.id === pl);
        const ids = playlist.items.map((it) => it.id);
        const i = ids.indexOf(id);
        const j = act === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        await api('POST', `/api/playlists/${pl}/reorder`, { item_ids: ids });
        render();
      }
    };
  }

  // ---- schedules ---------------------------------------------------------------------

  let calMonthOffset = 0;
  let timelineDay = new Date().getDay();

  function scheduleColor(i) {
    const palette = ['#38bdf8', '#a78bfa', '#f472b6', '#fbbf24', '#34d399', '#fb923c', '#60a5fa', '#e879f9'];
    return palette[i % palette.length];
  }

  async function renderSchedules() {
    const [{ schedules }, { playlists }, { screens }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/schedules`),
      api('GET', `/api/venues/${venueId}/playlists`),
      api('GET', `/api/venues/${venueId}/screens`),
    ]);
    const zones = venue().zones || [];
    const colorOf = new Map(schedules.map((s, i) => [s.id, scheduleColor(i)]));
    const toMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + (m || 0); };

    // ---- day timeline: bars on a 24h axis for the picked weekday ----
    const dayScheds = schedules.filter((s) => {
      if (!s.active) return false;
      let days; try { days = JSON.parse(s.days_of_week); } catch { days = []; }
      return !days.length || days.includes(timelineDay);
    });
    const bar = (s, startMin, endMin) => `
      <div title="${esc(s.name || s.playlist_name)} ${esc(s.start_time)}–${esc(s.end_time)}"
        style="position:absolute;left:${(startMin / 1440 * 100).toFixed(2)}%;width:${Math.max(0.6, (endMin - startMin) / 1440 * 100).toFixed(2)}%;
        top:3px;bottom:3px;background:${colorOf.get(s.id)}cc;border-radius:4px;overflow:hidden;white-space:nowrap;
        font-size:11px;font-weight:700;color:#04202e;padding:2px 6px">${esc(s.name || s.playlist_name)}</div>`;
    const timelineRows = dayScheds.map((s) => {
      const start = toMin(s.start_time), end = toMin(s.end_time) || 1440;
      const bars = end > start || end === start ? bar(s, start, end === start ? 1440 : end)
        : bar(s, start, 1440) + bar(s, 0, end); // wraps midnight
      const target = s.screen_name ? esc(s.screen_name) : s.zone_name ? esc(s.zone_name) : 'Venue';
      return `<div class="row" style="gap:8px;margin-top:4px;flex-wrap:nowrap">
        <div class="muted" style="width:130px;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:right">${target}${(s.start_date || s.end_date) ? ' 📅' : ''}</div>
        <div style="position:relative;flex:1;height:26px;background:var(--panel2);border-radius:4px">${bars}</div>
      </div>`;
    }).join('');
    const hourMarks = [0, 6, 12, 18, 24].map((h) =>
      `<span style="position:absolute;left:${h / 24 * 100}%;transform:translateX(-50%)">${h === 24 ? '12am' : h === 0 ? '12am' : h === 12 ? '12pm' : h < 12 ? h + 'am' : (h - 12) + 'pm'}</span>`).join('');

    // ---- month grid: dated campaigns ----
    const now = new Date();
    const monthStart = new Date(now.getFullYear(), now.getMonth() + calMonthOffset, 1);
    const monthLabel = monthStart.toLocaleDateString('en-AU', { month: 'long', year: 'numeric' });
    const daysInMonth = new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
    const firstDow = monthStart.getDay();
    const dated = schedules.filter((s) => s.active && (s.start_date || s.end_date));
    const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const todayIso = iso(new Date());
    let cells = '';
    for (let i = 0; i < firstDow; i++) cells += '<div></div>';
    for (let day = 1; day <= daysInMonth; day++) {
      const dateIso = iso(new Date(monthStart.getFullYear(), monthStart.getMonth(), day));
      const hits = dated.filter((s) => (!s.start_date || dateIso >= s.start_date) && (!s.end_date || dateIso <= s.end_date));
      cells += `<div style="min-height:52px;background:var(--panel2);border-radius:5px;padding:3px 5px;${dateIso === todayIso ? 'outline:2px solid var(--accent)' : ''}">
        <div class="muted" style="font-size:10px">${day}</div>
        ${hits.slice(0, 3).map((s) => `<div title="${esc(s.name || s.playlist_name)}" style="font-size:9.5px;font-weight:700;color:#04202e;background:${colorOf.get(s.id)};border-radius:3px;padding:0 4px;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.name || s.playlist_name)}</div>`).join('')}
        ${hits.length > 3 ? `<div class="muted" style="font-size:9px">+${hits.length - 3} more</div>` : ''}
      </div>`;
    }

    $('#tab-schedules').innerHTML = `
      <h2>Today's rhythm
        <span style="font-weight:400;font-size:13px;margin-left:8px">
          ${DAY_NAMES.map((d, i) => `<button class="btn small ${i === timelineDay ? '' : 'secondary'}" data-tlday="${i}" style="padding:2px 8px">${d}</button>`).join(' ')}
        </span>
      </h2>
      <div class="card">
        ${timelineRows || '<div class="muted">Nothing scheduled for this day.</div>'}
        <div class="muted" style="position:relative;height:16px;margin-top:6px;margin-left:138px;font-size:10px">${hourMarks}</div>
      </div>

      <h2>Calendar — dated campaigns
        <span style="font-weight:400;font-size:13px;margin-left:8px">
          <button class="btn small secondary" data-calnav="-1">‹</button>
          <b style="display:inline-block;min-width:130px;text-align:center">${monthLabel}</b>
          <button class="btn small secondary" data-calnav="1">›</button>
        </span>
      </h2>
      <div class="card">
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px;font-size:11px;color:var(--muted);text-align:center;margin-bottom:4px">
          ${DAY_NAMES.map((d) => `<div>${d}</div>`).join('')}
        </div>
        <div style="display:grid;grid-template-columns:repeat(7,1fr);gap:4px">${cells}</div>
        ${dated.length ? '' : '<p class="muted" style="margin-bottom:0">No dated campaigns this month — schedules with From/To dates show up here.</p>'}
      </div>

      <h2>Schedules (dayparting &amp; calendar)</h2>
      <p class="muted">Most specific target wins: screen &gt; zone &gt; whole venue; a schedule with calendar dates beats
      the everyday loop; then priority. End before start runs past midnight. Leave the dates blank for every-week schedules —
      set them for one-offs and seasonal campaigns (e.g. Christmas menu 20–26 Dec).</p>
      <table>
        <thead><tr><th>Name</th><th>Target</th><th>Playlist</th><th>Days</th><th>Time</th><th>Dates</th><th>Priority</th><th>Active</th><th></th></tr></thead>
        <tbody>${schedules.map((s) => {
          let days = [];
          try { days = JSON.parse(s.days_of_week); } catch { /* ignore */ }
          const dayLabel = days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(' ');
          const target = s.screen_name ? `Screen: ${esc(s.screen_name)}` : s.zone_name ? `Zone: ${esc(s.zone_name)}` : 'Whole venue';
          const fmtDate = (d) => d ? new Date(d + 'T12:00:00').toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: '2-digit' }) : null;
          const dates = !s.start_date && !s.end_date ? '<span class="muted">every week</span>'
            : `📅 ${fmtDate(s.start_date) || '…'}${(s.start_date === s.end_date && s.start_date) ? '' : ` – ${fmtDate(s.end_date) || 'ongoing'}`}`;
          return `<tr style="${s.active ? '' : 'opacity:.45'}">
            <td>${esc(s.name) || '<span class="muted">—</span>'}</td>
            <td class="muted">${target}</td>
            <td>${esc(s.playlist_name)}</td>
            <td class="muted">${dayLabel}</td>
            <td>${esc(s.start_time)}–${esc(s.end_time)}</td>
            <td>${dates}</td>
            <td class="muted">${s.priority}</td>
            <td><button class="btn small secondary" data-act="toggle" data-id="${s.id}" data-active="${s.active}">${s.active ? 'On' : 'Off'}</button></td>
            <td style="text-align:right"><button class="btn small danger" data-act="del" data-id="${s.id}">✕</button></td>
          </tr>`;
        }).join('') || '<tr><td class="muted" colspan="9">No schedules yet</td></tr>'}
        </tbody>
      </table>

      <h2>Add schedule</h2>
      <div class="card">
        <div class="form-grid">
          <label>Name<input id="sc-name" placeholder="Happy hour"></label>
          <label>Playlist<select id="sc-playlist">${playlists.map((p) => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label>
          <label>Zone (optional)<select id="sc-zone"><option value="">Whole venue</option>
            ${zones.map((z) => `<option value="${z.id}">${esc(z.name)}</option>`).join('')}</select></label>
          <label>Screen (optional)<select id="sc-screen"><option value="">—</option>
            ${screens.map((s) => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></label>
        </div>
        <div class="form-grid">
          <label>Start<input id="sc-start" type="time" value="07:00"></label>
          <label>End<input id="sc-end" type="time" value="23:00"></label>
          <label>From date (optional)<input id="sc-from" type="date"></label>
          <label>To date (optional)<input id="sc-to" type="date"></label>
          <label>Priority<input id="sc-priority" type="number" value="0"></label>
          <label>Days<div class="row" id="sc-days" style="gap:6px">
            ${DAY_NAMES.map((d, i) => `<label style="flex-direction:row;gap:3px;align-items:center"><input type="checkbox" value="${i}" checked>${d}</label>`).join('')}
          </div></label>
        </div>
        <button class="btn" id="sc-add">Add schedule</button>
      </div>`;

    $('#sc-add').onclick = async () => {
      const days = [...document.querySelectorAll('#sc-days input:checked')].map((c) => parseInt(c.value, 10));
      await api('POST', `/api/venues/${venueId}/schedules`, {
        name: $('#sc-name').value.trim(),
        playlist_id: $('#sc-playlist').value,
        zone_id: $('#sc-zone').value || null,
        screen_id: $('#sc-screen').value || null,
        start_time: $('#sc-start').value || '00:00',
        end_time: $('#sc-end').value || '24:00',
        start_date: $('#sc-from').value || null,
        end_date: $('#sc-to').value || null,
        priority: parseInt($('#sc-priority').value, 10) || 0,
        days_of_week: days,
      });
      render();
    };
    $('#tab-schedules').onclick = async (e) => {
      const tlday = e.target.closest('[data-tlday]');
      if (tlday) { timelineDay = parseInt(tlday.dataset.tlday, 10); return render(); }
      const calnav = e.target.closest('[data-calnav]');
      if (calnav) { calMonthOffset += parseInt(calnav.dataset.calnav, 10); return render(); }
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'del') {
        if (confirm('Delete schedule?')) { await api('DELETE', `/api/schedules/${el.dataset.id}`); render(); }
      } else if (el.dataset.act === 'toggle') {
        await api('PATCH', `/api/schedules/${el.dataset.id}`, { active: el.dataset.active !== '1' });
        render();
      }
    };
  }

  // ---- raffle number draws ----------------------------------------------------------

  async function renderTablet() {
    const remote = await api('GET', `/api/venues/${venueId}/remote-token`);
    const remoteUrl = remote.url ? location.origin + remote.url : null;

    $('#tab-tablet').innerHTML = `
      <h2>Venue tablet — games console 🎰</h2>
      <div class="card">
        <p class="muted" style="margin-top:0"><b>All games are run from this URL</b> — raffle draws, CashKing,
        Wheel Spin, the members badge draw, plus venue emergency broadcast and a one-tap
        "return screens to advertising". No dashboard login needed on the tablet.</p>
        <div class="row">
          ${remoteUrl
            ? `<input readonly id="remote-url" value="${esc(remoteUrl)}" style="flex:1;min-width:280px;font-family:monospace;font-size:12px">
               <button class="btn small secondary" id="remote-copy">Copy link</button>
               <button class="btn small secondary" id="remote-rotate">Generate new link (revoke old)</button>`
            : '<button class="btn" id="remote-rotate">Generate games console link</button>'}
        </div>
      </div>

      <h2>Setting up the tablet</h2>
      <div class="card muted" style="line-height:1.9">
        1. Open the link above in Chrome (Android) or Safari (iPad) on the venue tablet.<br>
        2. Use <b>Add to Home Screen</b> — it installs as the <b>Korvix Games</b> app: full-screen, own icon.<br>
        3. Recommended: pin the app (Android: Settings → Security → App pinning) so punters can't wander out of it.<br>
        4. Staff phones can install the same link — every device stays in sync automatically.
      </div>

      <h2>If the tablet is lost or staff leave</h2>
      <div class="card muted">
        Hit <b>Generate new link</b> above — every device holding the old link is cut off instantly.
        Then set the new link up on the replacement tablet.
      </div>`;

    const rotateBtn = $('#remote-rotate');
    if (rotateBtn) rotateBtn.onclick = async () => {
      if (remoteUrl && !confirm('Generate a new link? Every tablet and phone using the current link loses access.')) return;
      await api('POST', `/api/venues/${venueId}/remote-token`);
      render();
    };
    const copyBtn = $('#remote-copy');
    if (copyBtn) {
      copyBtn.onclick = async () => {
        try { await navigator.clipboard.writeText($('#remote-url').value); copyBtn.textContent = 'Copied ✓'; }
        catch { $('#remote-url').select(); document.execCommand('copy'); copyBtn.textContent = 'Copied ✓'; }
        setTimeout(() => { copyBtn.textContent = 'Copy link'; }, 1500);
      };
    }
  }

  async function renderDraws() {
    const { draws } = await api('GET', `/api/venues/${venueId}/draws`);
    const zones = venue().zones || [];

    $('#tab-draws').innerHTML = `
      <h2>Raffle number draws</h2>
      <p class="muted">Set up ticket ranges here; staff <b>run the draws from the games console</b> on the venue tablet.
      Screens take over with a spinning reel reveal. A number is never repeated within the same draw.</p>

      <h2>New draw</h2>
      <div class="form-grid card">
        <label>Name<input id="dr-name" placeholder="Friday Meat Raffle"></label>
        <label>First ticket #<input id="dr-start" type="number" value="1"></label>
        <label>Last ticket #<input id="dr-end" type="number" value="100"></label>
        <label>Show on<select id="dr-zone">
          <option value="">Whole venue</option>
          ${zones.map((z) => `<option value="${z.id}">Zone: ${esc(z.name)}</option>`).join('')}
        </select></label>
        <button class="btn" id="dr-add">Create draw</button>
      </div>

      <h2>Draws</h2>
      <table>
        <thead><tr><th>Name</th><th>Range</th><th>Shows on</th><th>Numbers drawn</th><th>Status</th><th></th></tr></thead>
        <tbody>${draws.map((d) => `
          <tr>
            <td>${esc(d.name)}</td>
            <td class="muted">${d.range_start}–${d.range_end}</td>
            <td class="muted">${d.zone_name ? `Zone: ${esc(d.zone_name)}` : 'Whole venue'}</td>
            <td>${d.drawn_numbers.length
              ? `<b style="font-size:16px">#${d.latest_number}</b>` +
                (d.drawn_numbers.length > 1 ? ` <span class="muted">(earlier: ${d.drawn_numbers.slice(0, -1).join(', ')})</span>` : '') +
                ` <span class="muted">· ${d.remaining} left</span>`
              : '<span class="muted">—</span>'}</td>
            <td><span class="pill ${d.status === 'live' ? 'online' : d.status === 'ready' ? 'unpaired' : 'never-connected'}">${d.status}</span></td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn small danger" data-act="del" data-id="${d.id}">✕</button>
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="6">No draws yet</td></tr>'}
        </tbody>
      </table>`;

    $('#dr-add').onclick = async () => {
      const name = $('#dr-name').value.trim();
      if (!name) return alert('Draw name required');
      await api('POST', `/api/venues/${venueId}/draws`, {
        name,
        range_start: parseInt($('#dr-start').value, 10),
        range_end: parseInt($('#dr-end').value, 10),
        zone_id: $('#dr-zone').value || null,
      });
      render();
    };
    $('#tab-draws').onclick = async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
      if (el.dataset.act === 'del' && confirm('Delete this draw and its history?')) {
        await api('DELETE', `/api/draws/${el.dataset.id}`);
        render();
      }
    };
  }

  // ---- CashKing (digital Jag the Joker) -------------------------------------------------

  const moneyAud = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const CK_SUITS = { S: '♠', H: '♥', D: '♦', C: '♣' };
  const ckFace = (c) => c === 'JOKER' ? '🃏' : c.slice(0, -1) + (CK_SUITS[c.slice(-1)] || '');

  function ckBoardHtml(game, clickable) {
    return `<div style="display:grid;grid-template-columns:repeat(9,1fr);gap:4px;margin:12px 0">
      ${game.cards.map((c) => {
        if (!c.revealed) {
          return clickable && game.status === 'active'
            ? `<button data-pick="${c.i}" title="Reveal card #${c.i + 1}" style="aspect-ratio:2/2.6;border-radius:5px;border:1px solid #3b82f6aa;background:linear-gradient(135deg,#1d4ed8,#172554);color:#93c5fd;font-weight:700;cursor:pointer">${c.i + 1}</button>`
            : `<div style="aspect-ratio:2/2.6;border-radius:5px;border:1px solid #3b82f6aa;background:linear-gradient(135deg,#1d4ed8,#172554);color:#93c5fd;font-weight:700;display:flex;align-items:center;justify-content:center">${c.i + 1}</div>`;
        }
        const red = c.card && 'HD'.includes(c.card.slice(-1));
        const joker = c.card === 'JOKER';
        return `<div style="aspect-ratio:2/2.6;border-radius:5px;display:flex;align-items:center;justify-content:center;font-weight:800;
          ${joker ? 'background:linear-gradient(135deg,#fbbf24,#b45309);color:#451a03'
            : `background:#f8fafc;color:${red ? '#dc2626' : '#0f172a'};opacity:.6`}">${ckFace(c.card)}</div>`;
      }).join('')}
    </div>`;
  }

  async function renderCashKing() {
    const { games } = await api('GET', `/api/venues/${venueId}/card-games`);
    const current = games.find((g) => g.status !== 'archived');
    const past = games.filter((g) => g !== current);

    $('#tab-cashking').innerHTML = `
      <h2>CashKing 🃏 <span class="muted" style="font-weight:400;font-size:13px">digital Jag the Joker</span></h2>
      <p class="muted">53 shuffled cards on every screen in the venue. One card revealed per game night —
      a miss rolls the jackpot up by your increment, the Joker wins it. Card faces stay on the server until
      revealed, so the board can't be cheated. <b>The game is run from the games console</b> on the venue
      tablet (link on the Manage Tablet page) — go live, reveal the winner's card, end the session. This page
      is for setup and monitoring.</p>

      ${current ? `
      <div class="card">
        <div class="row">
          <h3 style="margin:0">${esc(current.name)}</h3>
          <span class="pill ${current.won ? 'level-alert unpaired' : current.live ? 'online' : 'level-notice'}">${current.won ? 'WON' : current.live ? 'LIVE ON SCREENS' : 'idle'}</span>
          <span class="muted">${current.cards_left} cards left${current.session_text ? ` · ${esc(current.session_text)}` : ''}</span>
          <div class="spacer"></div>
          <div style="font-size:24px;font-weight:800;color:var(--warn)">${moneyAud(current.jackpot)}</div>
        </div>
        ${current.won ? `<p style="color:var(--warn);font-weight:700">🎉 Joker found — ${moneyAud(current.jackpot)} won! Archive this game to start a new one.</p>` : ''}
        ${ckBoardHtml(current, false)}
        <div class="row">
          <button class="btn small secondary" data-ck="edit">Edit jackpot / schedule / webhook</button>
          <button class="btn small secondary" data-ck="archive">Archive game</button>
        </div>
        <p class="muted" style="margin-bottom:0">Go live and reveal cards from the <b>games console</b> (venue tablet).
        Increment per miss: ${moneyAud(current.jackpot_increment)}.</p>
        <h2 style="font-size:14px">Automated promotion</h2>
        <div class="muted" style="font-size:13px">
          Public JSON feed for your website / socials tooling:<br>
          <code style="user-select:all">${location.origin}/api/public/cashking/${esc(current.public_token)}</code><br>
          Marketing webhook ${current.promo_webhook ? `(set): <code>${esc(current.promo_webhook)}</code>` : '(not set)'} —
          fired with a ready-to-post blurb on every game event: new game, go-live, jackpot roll-up, win.
        </div>
      </div>` : `
      <h2>Start a game</h2>
      <div class="card">
        <div class="form-grid">
          <label>Game name<input id="ck-name" value="CashKing"></label>
          <label>Starting jackpot $<input id="ck-start" type="number" value="1000" min="0"></label>
          <label>Increment per miss $<input id="ck-inc" type="number" value="150" min="0"></label>
          <label>Game nights (shown on screens)<input id="ck-session" placeholder="Thursdays 7:30pm"></label>
        </div>
        <label style="display:block;font-size:12px;color:var(--muted)">Marketing webhook URL (optional — Zapier/Make/Slack etc.)
          <input id="ck-hook" placeholder="https://hooks.zapier.com/…" style="width:100%;margin-top:4px"></label>
        <button class="btn" id="ck-create" style="margin-top:12px">Shuffle deck &amp; start game</button>
      </div>`}

      ${past.length ? `<h2>Past games</h2>
      <table><tbody>${past.map((g) => `
        <tr><td>${esc(g.name)}</td>
          <td><span class="pill ${g.won ? 'unpaired' : 'never-connected'}">${g.won ? 'won' : g.status}</span></td>
          <td class="muted">${g.won ? `${moneyAud(g.jackpot)} won ${g.won_at ? new Date(g.won_at).toLocaleDateString() : ''}` : `reached ${moneyAud(g.jackpot)}`}</td>
          <td class="muted">${53 - g.cards_left} cards revealed</td></tr>`).join('')}
      </tbody></table>` : ''}`;

    const createBtn = $('#ck-create');
    if (createBtn) createBtn.onclick = async () => {
      await api('POST', `/api/venues/${venueId}/card-games`, {
        name: $('#ck-name').value.trim() || 'CashKing',
        jackpot_start: parseFloat($('#ck-start').value) || 0,
        jackpot_increment: parseFloat($('#ck-inc').value) || 0,
        session_text: $('#ck-session').value.trim(),
        promo_webhook: $('#ck-hook').value.trim(),
      });
      render();
    };

    $('#tab-cashking').onclick = async (e) => {
      const act = e.target.closest('[data-ck]');
      if (!act || !current) return;
      if (act.dataset.ck === 'archive') {
        if (!confirm('Archive this game? It disappears from screens and the public feed.')) return;
        await api('POST', `/api/card-games/${current.id}/archive`);
      } else if (act.dataset.ck === 'edit') {
        const jackpot = prompt('Current jackpot $:', current.jackpot);
        if (jackpot === null) return;
        const increment = prompt('Increment per miss $:', current.jackpot_increment);
        if (increment === null) return;
        const session = prompt('Game nights text:', current.session_text);
        if (session === null) return;
        const hook = prompt('Marketing webhook URL (blank = off):', current.promo_webhook || '');
        if (hook === null) return;
        await api('PATCH', `/api/card-games/${current.id}`, {
          jackpot_current: parseFloat(jackpot), jackpot_increment: parseFloat(increment),
          session_text: session.trim(), promo_webhook: hook.trim(),
        });
      }
      render();
    };
  }

  // ---- emergency ----------------------------------------------------------------------

  async function renderEmergency() {
    const { emergencies } = await api('GET', '/api/emergencies');
    $('#tab-emergency').innerHTML = `
      <h2>Emergency broadcast</h2>
      <p class="muted">Instantly takes over every screen at the selected venue (or all venues). Players switch within a second via their live connection.</p>
      <div class="card">
        <div class="form-grid">
          <label>Scope<select id="em-scope">
            <option value="${venueId}">${esc(venue().name)} only</option>
            ${hasRole('superadmin') ? '<option value="">ALL venues (every business)</option>' : ''}
          </select></label>
          <label>Headline<input id="em-title" placeholder="EVACUATE NOW" value="Emergency — please follow staff directions"></label>
          <label>Message<input id="em-message" placeholder="Move calmly to the nearest exit…"></label>
        </div>
        <div class="em-buttons">
          <button class="em-evacuation" data-level="evacuation">🔥 EVACUATION</button>
          <button class="em-lockdown" data-level="lockdown">🔒 LOCKDOWN</button>
          <button class="em-alert" data-level="alert">⚠ ALERT</button>
          <button class="em-notice" data-level="notice">ℹ NOTICE</button>
        </div>
      </div>
      <h2>History</h2>
      <table><tbody>
        ${emergencies.map((em) => `
          <tr>
            <td><span class="pill level-${em.level}">${em.level}</span></td>
            <td>${esc(em.title)}</td>
            <td class="muted">${esc(em.message)}</td>
            <td class="muted">${new Date(em.created_at).toLocaleString()}</td>
            <td style="text-align:right">${em.active
              ? `<button class="btn small danger" data-clear="${em.id}">CLEAR — all safe</button>`
              : `<span class="muted">cleared ${em.cleared_at ? new Date(em.cleared_at).toLocaleTimeString() : ''}</span>`}</td>
          </tr>`).join('') || '<tr><td class="muted">No emergency broadcasts yet</td></tr>'}
      </tbody></table>`;

    $('#tab-emergency').onclick = async (e) => {
      const levelBtn = e.target.closest('[data-level]');
      if (levelBtn) {
        const level = levelBtn.dataset.level;
        if (!confirm(`Broadcast ${level.toUpperCase()} to ${$('#em-scope').selectedOptions[0].text}?`)) return;
        await api('POST', '/api/emergencies', {
          venue_id: $('#em-scope').value || null,
          level,
          title: $('#em-title').value.trim() || level.toUpperCase(),
          message: $('#em-message').value.trim(),
        });
        render();
      }
      const clearBtn = e.target.closest('[data-clear]');
      if (clearBtn) {
        await api('POST', `/api/emergencies/${clearBtn.dataset.clear}/clear`);
        render();
      }
    };
  }

  // ---- integrations -------------------------------------------------------------------

  async function renderIntegrations() {
    const { feeds } = await api('GET', `/api/integrations/${venueId}`);
    const base = location.origin;
    const v = venue();
    $('#tab-integrations').innerHTML = `
      <h2>Automatic weather 🌤</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Set the venue's coordinates and the CMS refreshes the weather feed
        itself every 30 minutes (Open-Meteo, free, no API key). Screens using the weather widget update automatically.</p>
        <div class="row">
          <label class="muted">Latitude <input id="wx-lat" type="number" step="0.0001" value="${v.latitude ?? ''}" placeholder="-33.87" style="width:130px"></label>
          <label class="muted">Longitude <input id="wx-lon" type="number" step="0.0001" value="${v.longitude ?? ''}" placeholder="151.21" style="width:130px"></label>
          <button class="btn small" id="wx-save">Save location</button>
          ${feeds.find((f) => f.source === 'weather')?.payload?.source === 'open-meteo'
            ? '<span class="pill online">auto-updating</span>' : ''}
        </div>
      </div>

      <h2>Racing feed 🏇</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Pick a jurisdiction and the CMS polls the TAB next-to-go API every 45 seconds —
        screens on the Racing channels (Screens tab) show the next three races with live countdowns, plus results as they settle.
        Venues with a licensed data supplier can instead push to the <code>racing</code> webhook below.</p>
        <div class="row">
          <select id="rc-jur">
            <option value="">Racing feed off</option>
            ${['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT'].map((j) =>
              `<option ${((v.racing_jurisdiction || '')) === j ? 'selected' : ''}>${j}</option>`).join('')}
          </select>
          <button class="btn small" id="rc-save">Save</button>
          ${feeds.find((f) => f.source === 'racing') ? '<span class="pill online">feed active</span>' : ''}
        </div>
      </div>

      <h2>Live data feeds</h2>
      <p class="muted">POS, gaming, weather and other systems push JSON here; widgets on screen render it live. Any update refreshes affected screens instantly.</p>
      <div class="cards">
        ${feeds.map((f) => `
          <div class="card">
            <h3>${esc(f.source)} <span class="muted" style="font-weight:400;font-size:12px">updated ${new Date(f.updated_at).toLocaleString()}</span></h3>
            <pre>${esc(JSON.stringify(f.payload, null, 2))}</pre>
          </div>`).join('') || '<div class="muted">No feeds received yet.</div>'}
      </div>
      <h2>Webhook endpoints</h2>
      <pre># BEPOZ / SwiftPOS / H&amp;L menu &amp; specials sync
curl -X POST ${base}/api/integrations/${venueId}/pos \\
  -H 'Content-Type: application/json' \\
  -d '{"specials":[{"name":"Chicken Schnitzel","price":18.5}],"sold_out":["Barramundi"]}'

# Gaming system jackpot tick
curl -X POST ${base}/api/integrations/${venueId}/gaming \\
  -d '{"jackpots":[{"name":"Mega Link Grand","amount":12847.50}]}'

# Weather service
curl -X POST ${base}/api/integrations/${venueId}/weather \\
  -d '{"location":"Sydney","temp_c":21,"condition":"Partly cloudy","high_c":24,"low_c":14}'

# Sports fixtures
curl -X POST ${base}/api/integrations/${venueId}/sports \\
  -d '{"fixtures":[{"league":"AFL","match":"Swans v Magpies","when":"Fri 7:40pm"}]}'

# Membership system — birthdays widget
curl -X POST ${base}/api/integrations/${venueId}/membership \\
  -d '{"birthdays":[{"name":"Karen M."},{"name":"Dave T."}]}'</pre>`;

    $('#wx-save').onclick = async () => {
      await api('PATCH', `/api/venues/${venueId}`, {
        latitude: $('#wx-lat').value || null,
        longitude: $('#wx-lon').value || null,
      });
      await refresh();
    };
    $('#rc-save').onclick = async () => {
      await api('PATCH', `/api/venues/${venueId}`, { racing_jurisdiction: $('#rc-jur').value || null });
      await refresh();
    };
  }

  // ---- venue settings ---------------------------------------------------------------------

  async function renderVenueSettings() {
    const v = venue();
    $('#tab-venue').innerHTML = `
      <h2>Venue settings — ${esc(v.name)}</h2>
      <div class="card">
        <div class="form-grid">
          <label>Venue name<input id="vs-name" value="${esc(v.name)}"></label>
          <label>Timezone<input id="vs-tz" value="${esc(v.timezone)}" list="tz-list">
            <datalist id="tz-list">
              ${['Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide',
                 'Australia/Perth', 'Australia/Hobart', 'Australia/Darwin'].map((t) => `<option>${t}</option>`).join('')}
            </datalist></label>
          <label>Address<input id="vs-addr" value="${esc(v.address || '')}"></label>
          <button class="btn" id="vs-save">Save</button>
        </div>
        <p class="muted" style="margin-bottom:0">Timezone drives all schedule dayparting for this venue.
        Weather location and the racing feed live under Settings → Integrations.</p>
      </div>

      <h2>Venue logo</h2>
      <div class="card">
        <div class="row">
          ${v.logo_url
            ? `<img src="${esc(v.logo_url)}" style="max-height:60px;max-width:220px;object-fit:contain;background:#fff2;border-radius:8px;padding:6px">`
            : '<span class="muted">No logo yet.</span>'}
          <input type="file" id="vs-logo" accept="image/*" style="max-width:240px">
          ${v.logo_url ? '<button class="btn small danger" id="vs-logo-remove">Remove logo</button>' : ''}
        </div>
        <p class="muted" style="margin-bottom:0">Shown on every menu board and the welcome screen.
        A PNG with a transparent background looks best.</p>
      </div>

      <h2 style="color:var(--bad)">Danger zone</h2>
      <div class="card">
        <div class="row">
          <div class="muted">Deleting a venue removes its screens, media, playlists, schedules and games permanently.</div>
          <div class="spacer"></div>
          <button class="btn danger" id="vs-delete">Delete this venue</button>
        </div>
      </div>`;

    $('#vs-save').onclick = async () => {
      const name = $('#vs-name').value.trim();
      if (!name) return alert('Venue name required');
      await api('PATCH', `/api/venues/${venueId}`, {
        name, timezone: $('#vs-tz').value.trim() || 'Australia/Sydney', address: $('#vs-addr').value.trim(),
      });
      await refresh();
      alert('Saved.');
    };
    $('#vs-logo').onchange = async () => {
      const file = $('#vs-logo').files[0];
      if (!file) return;
      const up = await uploadFile(file);
      const uploaded = await up.json();
      if (!up.ok) return alert('Logo upload failed: ' + (uploaded.error || up.status));
      await api('PATCH', `/api/venues/${venueId}`, { logo_url: uploaded.url });
      await refresh();
    };
    const logoRemove = $('#vs-logo-remove');
    if (logoRemove) logoRemove.onclick = async () => {
      await api('PATCH', `/api/venues/${venueId}`, { logo_url: null });
      await refresh();
    };

    $('#vs-delete').onclick = async () => {
      const typed = prompt(`This permanently deletes "${v.name}" and everything in it.\nType the venue name to confirm:`);
      if (typed !== v.name) { if (typed !== null) alert('Name did not match — nothing deleted.'); return; }
      await api('DELETE', `/api/venues/${venueId}`);
      localStorage.removeItem('korvix.venue');
      venueId = null;
      goTab('overview');
      await refresh();
    };
  }

  // ---- proof-of-play reports -------------------------------------------------------------

  let reportRange = null;

  async function renderReports() {
    const today = new Date().toISOString().slice(0, 10);
    const weekAgo = new Date(Date.now() - 6 * 86400 * 1000).toISOString().slice(0, 10);
    if (!reportRange) reportRange = { from: weekAgo, to: today };
    const report = await api('GET',
      `/api/venues/${venueId}/reports/plays?from=${reportRange.from}&to=${reportRange.to}`);
    const mins = (s) => Math.round((s || 0) / 60).toLocaleString();

    $('#tab-reports').innerHTML = `
      <h2>Proof of play</h2>
      <p class="muted">Every item actually shown on screen is logged by the players — the evidence base for supplier
      campaigns and the cross-venue advertising network. Retained ${'90'} days.</p>
      <div class="row card" style="margin-bottom:14px">
        <label class="muted">From <input type="date" id="rp-from" value="${reportRange.from}"></label>
        <label class="muted">To <input type="date" id="rp-to" value="${reportRange.to}"></label>
        <button class="btn small" id="rp-run">Run report</button>
        <div class="spacer"></div>
        <div class="muted">${report.total_plays.toLocaleString()} plays · ${mins(report.total_seconds)} minutes on screen</div>
        <button class="btn small secondary" id="rp-csv" ${report.media.length ? '' : 'disabled'}>Download CSV</button>
      </div>

      <h2>By content</h2>
      <table>
        <thead><tr><th>Content</th><th>Plays</th><th>Minutes on screen</th><th>Screens reached</th></tr></thead>
        <tbody>${report.media.map((m) => `
          <tr><td>${esc(m.media_name)}</td><td>${m.plays.toLocaleString()}</td>
          <td>${mins(m.seconds)}</td><td>${m.screens}</td></tr>`).join('')
          || '<tr><td class="muted" colspan="4">No plays recorded in this range yet — data appears once players report in.</td></tr>'}
        </tbody>
      </table>

      <h2>By screen</h2>
      <table>
        <thead><tr><th>Screen</th><th>Plays</th><th>Minutes on screen</th></tr></thead>
        <tbody>${report.screens.map((s) => `
          <tr><td>${esc(s.screen_name)}</td><td>${s.plays.toLocaleString()}</td><td>${mins(s.seconds)}</td></tr>`).join('')
          || '<tr><td class="muted" colspan="3">No data</td></tr>'}
        </tbody>
      </table>`;

    $('#rp-run').onclick = () => {
      reportRange = { from: $('#rp-from').value || weekAgo, to: $('#rp-to').value || today };
      render();
    };
    $('#rp-csv').onclick = () => {
      const rows = [['content', 'plays', 'seconds_on_screen', 'screens_reached'],
        ...report.media.map((m) => [m.media_name, m.plays, m.seconds || 0, m.screens])];
      const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      a.download = `korvix-proof-of-play-${reportRange.from}-to-${reportRange.to}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    };
  }

  // ---- users (per-business logins) --------------------------------------------------------

  async function renderUsers() {
    const { users } = await api('GET', '/api/users');
    const isSuper = me.role === 'superadmin';
    const orgs = isSuper ? (await api('GET', '/api/orgs')).orgs : [];

    $('#tab-users').innerHTML = `
      <h2>Users ${isSuper ? '' : `— ${esc(me.org_name || '')}`}</h2>
      <p class="muted">Admins manage the business (users, venues, staff app links). Editors run screens and content.
      Viewers get read-only access and reports.</p>
      <table>
        <thead><tr>${isSuper ? '<th>Business</th>' : ''}<th>Name</th><th>Email</th><th>Role</th><th>Last login</th><th></th></tr></thead>
        <tbody>${users.map((u) => `
          <tr>
            ${isSuper ? `<td class="muted">${esc(u.org_name || 'Korvix')}</td>` : ''}
            <td>${esc(u.name)}</td>
            <td>${esc(u.email)}</td>
            <td><select data-role="${u.id}" ${u.id === me.id ? 'disabled' : ''}>
              ${(isSuper ? ['superadmin', 'admin', 'editor', 'viewer'] : ['admin', 'editor', 'viewer'])
                .map((r) => `<option ${r === u.role ? 'selected' : ''}>${r}</option>`).join('')}
            </select></td>
            <td class="muted">${u.last_login_at ? new Date(u.last_login_at).toLocaleString() : 'never'}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn small secondary" data-pw="${u.id}">Reset password</button>
              ${u.id === me.id ? '' : `<button class="btn small danger" data-deluser="${u.id}" data-email="${esc(u.email)}">✕</button>`}
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="6">No users</td></tr>'}
        </tbody>
      </table>

      <h2>Add user</h2>
      <div class="form-grid card">
        ${isSuper ? `<label>Business<select id="us-org">
          ${orgs.map((o) => `<option value="${o.id}">${esc(o.name)}</option>`).join('')}
          <option value="">— Korvix (superadmin) —</option>
        </select></label>` : ''}
        <label>Name<input id="us-name" placeholder="Sam the Manager"></label>
        <label>Email<input id="us-email" type="email" placeholder="sam@venue.com.au"></label>
        <label>Password<input id="us-pass" type="password" placeholder="min 8 characters"></label>
        <label>Role<select id="us-role">
          <option value="admin">admin — manage this business</option>
          <option value="editor" selected>editor — run screens & content</option>
          <option value="viewer">viewer — read-only + reports</option>
        </select></label>
        <button class="btn" id="us-add">Add user</button>
      </div>`;

    $('#us-add').onclick = async () => {
      const orgSel = $('#us-org');
      const body = {
        name: $('#us-name').value.trim(),
        email: $('#us-email').value.trim(),
        password: $('#us-pass').value,
        role: $('#us-role').value,
      };
      if (isSuper) {
        body.org_id = orgSel.value || null;
        if (!orgSel.value) body.role = 'superadmin';
      }
      if (!body.email || !body.password) return alert('Email and password required');
      await api('POST', '/api/users', body);
      render();
    };
    $('#tab-users').onchange = async (e) => {
      const sel = e.target.closest('[data-role]');
      if (!sel) return;
      await api('PATCH', `/api/users/${sel.dataset.role}`, { role: sel.value });
      render();
    };
    $('#tab-users').onclick = async (e) => {
      const pw = e.target.closest('[data-pw]');
      if (pw) {
        const newPass = prompt('New password (min 8 characters) — this signs the user out everywhere:');
        if (newPass) { await api('PATCH', `/api/users/${pw.dataset.pw}`, { password: newPass }); alert('Password updated.'); }
        return;
      }
      const del = e.target.closest('[data-deluser]');
      if (del && confirm(`Delete user ${del.dataset.email}?`)) {
        await api('DELETE', `/api/users/${del.dataset.deluser}`);
        render();
      }
    };
  }

  // ---- businesses (superadmin) ---------------------------------------------------------------

  async function renderOrgs() {
    const { orgs } = await api('GET', '/api/orgs');
    const allVenues = (await api('GET', '/api/venues')).venues; // superadmin: every tenant
    $('#tab-orgs').innerHTML = `
      <h2>Businesses</h2>
      <p class="muted">Each business owns its venues, users and media library — tenants never see each other.
      Create the business, assign its venues below, then add their admin login in the Users tab.</p>
      <div class="row" style="margin-bottom:14px">
        <input id="org-name" placeholder="New business name — e.g. Harbourside Hotels Group" style="min-width:280px">
        <button class="btn" id="org-add">Create business</button>
      </div>
      <table>
        <thead><tr><th>Business</th><th>Venues</th><th>Users</th><th>Created</th><th></th></tr></thead>
        <tbody>${orgs.map((o) => `
          <tr>
            <td>${esc(o.name)}</td>
            <td>${o.venues}</td>
            <td>${o.users}</td>
            <td class="muted">${new Date(o.created_at).toLocaleDateString()}</td>
            <td style="text-align:right;white-space:nowrap">
              <button class="btn small secondary" data-rename="${o.id}" data-name="${esc(o.name)}">Rename</button>
              <button class="btn small danger" data-delorg="${o.id}" ${o.venues ? 'disabled title="Business still has venues"' : ''}>✕</button>
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="5">No businesses yet</td></tr>'}
        </tbody>
      </table>

      <h2>Which business owns each venue</h2>
      <p class="muted">A user sees every venue in their business — so give each owner their own business and
      move their pubs into it here. Moving a venue moves its screens, media and games with it.</p>
      <table>
        <thead><tr><th>Venue</th><th>Business</th></tr></thead>
        <tbody>${allVenues.map((v) => `
          <tr>
            <td>${esc(v.name)} <span class="muted">· ${v.screens.length} screen${v.screens.length === 1 ? '' : 's'}</span></td>
            <td><select data-vorg="${v.id}" data-cur="${esc(v.org_id || '')}">
              ${orgs.map((o) => `<option value="${o.id}" ${o.id === v.org_id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
            </select></td>
          </tr>`).join('') || '<tr><td class="muted" colspan="2">No venues yet</td></tr>'}
        </tbody>
      </table>`;

    $('#tab-orgs').onchange = async (e) => {
      const sel = e.target.closest('[data-vorg]');
      if (!sel) return;
      const orgName = orgs.find((o) => o.id === sel.value)?.name || '?';
      if (!confirm(`Move this venue to "${orgName}"? Users of the old business lose access to it immediately.`)) {
        sel.value = sel.dataset.cur;
        return;
      }
      await api('PATCH', `/api/venues/${sel.dataset.vorg}`, { org_id: sel.value });
      await refresh();
    };

    $('#org-add').onclick = async () => {
      const name = $('#org-name').value.trim();
      if (!name) return;
      await api('POST', '/api/orgs', { name });
      render();
    };
    $('#tab-orgs').onclick = async (e) => {
      const rename = e.target.closest('[data-rename]');
      if (rename) {
        const name = prompt('Business name:', rename.dataset.name);
        if (name) { await api('PATCH', `/api/orgs/${rename.dataset.rename}`, { name }); await refresh(); }
        return;
      }
      const del = e.target.closest('[data-delorg]');
      if (del && confirm('Delete this business? Its users lose access.')) {
        await api('DELETE', `/api/orgs/${del.dataset.delorg}`);
        render();
      }
    };
  }

  // ---- boot -------------------------------------------------------------------------------

  let pollTimer = null;
  function startPolling() {
    if (pollTimer) return;
    pollTimer = setInterval(() => {
      if (!me) return;
      if (activeTab === 'overview') render();
      else renderBanner();
    }, 15000);
  }

  (async () => {
    const state = await (await fetch('/api/auth/state')).json();
    if (state.needs_setup) return showAuth('setup');
    if (!sessionToken()) return showAuth('login');
    try {
      me = (await api('GET', '/api/auth/me')).user;
      enterApp();
    } catch { /* api() already showed the login overlay */ }
  })();
})();
