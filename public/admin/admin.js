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

  // ---- API helper (with optional admin token) -------------------------------

  async function api(method, path, body) {
    const headers = {};
    const token = localStorage.getItem('korvix.token');
    if (token) headers.Authorization = `Bearer ${token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const res = await fetch(path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401) {
      const entered = prompt('Admin token required:');
      if (entered) {
        localStorage.setItem('korvix.token', entered.trim());
        return api(method, path, body);
      }
      throw new Error('unauthorised');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      alert(`${method} ${path} failed: ${data.error || res.status}`);
      throw new Error(data.error || String(res.status));
    }
    return data;
  }

  const venue = () => venues.find((v) => v.id === venueId) || venues[0] || null;

  // ---- shell -----------------------------------------------------------------

  async function loadVenues() {
    venues = (await api('GET', '/api/venues')).venues;
    if (!venue() && venues.length) venueId = venues[0].id;
    const sel = $('#venue-select');
    sel.innerHTML = venues.map((v) =>
      `<option value="${v.id}" ${v.id === venueId ? 'selected' : ''}>${esc(v.name)}</option>`).join('')
      || '<option>No venues yet</option>';
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
    const created = await api('POST', '/api/venues', { name, timezone });
    venueId = created.id;
    localStorage.setItem('korvix.venue', venueId);
    await refresh();
  });

  $('#nav').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-tab]');
    if (!btn) return;
    activeTab = btn.dataset.tab;
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('active', b === btn));
    document.querySelectorAll('section.tab').forEach((s) =>
      s.classList.toggle('active', s.id === `tab-${activeTab}`));
    render();
  });

  async function refresh() {
    await loadVenues();
    await render();
  }

  async function render() {
    const v = venue();
    if (!v) {
      $('#tab-overview').innerHTML = '<div class="card">No venues yet — click <b>+ Venue</b> to create one.</div>';
      return;
    }
    venueId = v.id;
    const renderers = {
      overview: renderOverview, screens: renderScreens, content: renderContent,
      playlists: renderPlaylists, schedules: renderSchedules, draws: renderDraws,
      emergency: renderEmergency, integrations: renderIntegrations, reports: renderReports,
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
        <a class="btn small secondary" download style="text-decoration:none"
           href="/api/backup${localStorage.getItem('korvix.token') ? `?token=${encodeURIComponent(localStorage.getItem('korvix.token'))}` : ''}">⬇ Download backup</a>
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
    const [{ screens }, { pairings }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/screens`),
      api('GET', '/api/pairings'),
    ]);
    const zones = venue().zones || [];

    $('#tab-screens').innerHTML = `
      <h2>Screens</h2>
      <table>
        <thead><tr><th>Name</th><th>Zone</th><th>Rotation</th><th>Status</th><th>Last seen</th><th></th></tr></thead>
        <tbody>${screens.map((s) => `
          <tr>
            <td>${esc(s.name)} <span class="muted">${s.orientation}</span></td>
            <td class="muted">${esc(zoneName(s.zone_id))}</td>
            <td><select data-rotate="${s.id}">
              ${[0, 90, 180, 270].map((r) => `<option value="${r}" ${(s.rotation || 0) === r ? 'selected' : ''}>${r}&deg;</option>`).join('')}
            </select></td>
            <td><span class="pill ${s.status}">${s.status}</span></td>
            <td class="muted">${s.last_seen_at ? new Date(s.last_seen_at).toLocaleString() : '—'}</td>
            <td class="row" style="justify-content:flex-end">
              ${s.device_key
                ? `<a class="btn small secondary" href="/player/?preview=${esc(s.device_key)}" target="_blank" style="text-decoration:none">👁 Preview</a>
                   <button class="btn small secondary" data-act="unpair" data-id="${s.id}">Unpair</button>`
                : `<button class="btn small" data-act="pair" data-id="${s.id}">Pair device</button>`}
              <button class="btn small danger" data-act="del-screen" data-id="${s.id}">Delete</button>
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="6">No screens yet</td></tr>'}
        </tbody>
      </table>

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
      <p class="muted">Open <a href="/player/" target="_blank">/player/</a> on any screen — it shows a pairing code. Claim it with the “Pair device” button on a screen above.</p>
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
      const sel = e.target.closest('[data-rotate]');
      if (!sel) return;
      await api('PATCH', `/api/screens/${sel.dataset.rotate}`, { rotation: parseInt(sel.value, 10) });
    };
    $('#tab-screens').onclick = async (e) => {
      const el = e.target.closest('[data-act]');
      if (!el) return;
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

  // Upload files and auto-create a media entry for each. Returns error names.
  async function uploadGraphics(files) {
    const failed = [];
    for (const file of files) {
      try {
        const up = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
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

  async function renderContent() {
    const [{ media }, uploads] = await Promise.all([
      api('GET', `/api/venues/${venueId}/media`),
      api('GET', '/api/uploads'),
    ]);
    const mb = (bytes) => (bytes / 1024 / 1024).toFixed(1) + ' MB';

    $('#tab-content').innerHTML = `
      <h2>Upload your graphics</h2>
      <div id="dropzone" class="card" style="border:2px dashed var(--line);text-align:center;padding:34px;cursor:pointer">
        <div style="font-size:32px">🖼️</div>
        <div style="margin:6px 0"><b>Drag &amp; drop images or videos here</b> — or click to choose files</div>
        <div class="muted">JPG, PNG, WebP, GIF, SVG, MP4, WebM · up to 200 MB each ·
        each file becomes a media item ready to add to playlists</div>
        <input id="dz-input" type="file" accept="image/*,video/*" multiple style="display:none">
      </div>
      <div id="dz-progress" class="muted" style="margin:8px 2px"></div>

      <h2>Media library</h2>
      <table>
        <thead><tr><th></th><th>Name</th><th>Type</th><th>Duration</th><th>Sizing</th><th></th></tr></thead>
        <tbody>${media.map((m) => `
          <tr>
            <td style="width:96px">${mediaThumb(m)}</td>
            <td>${esc(m.name)}<div class="muted" style="font-size:11px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${m.type === 'html' ? '(inline slide)' : esc(m.src)}</div></td>
            <td><span class="pill level-notice">${esc(m.type)}</span></td>
            <td class="muted">${m.duration_seconds}s</td>
            <td>${m.type === 'image' || m.type === 'video'
              ? `<button class="btn small secondary" data-fit="${m.id}" data-cur="${m.fit || 'cover'}" title="cover = fill the screen (crops) · contain = show the whole graphic (letterbox)">
                  ${(m.fit || 'cover') === 'cover' ? '↔ Fill screen' : '▣ Show all'}</button>`
              : '<span class="muted">—</span>'}</td>
            <td style="text-align:right"><button class="btn small danger" data-del="${m.id}">Delete</button></td>
          </tr>`).join('') || '<tr><td class="muted" colspan="6">No media yet — drop some graphics above</td></tr>'}
        </tbody>
      </table>

      <h2>Uploaded files <span class="muted" style="font-weight:400;font-size:13px">· ${mb(uploads.total_bytes)} on disk</span></h2>
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

      <h2>Add media by URL or slide</h2>
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
            <input id="md-src" placeholder="https://… or /uploads/… — widgets: jackpot, menu, weather, sports, birthdays, happyhour, welcome"></label>
          <label>Or upload a file<input id="md-file" type="file" accept="image/*,video/*"></label>
        </div>
        <label style="display:block;margin-bottom:10px" id="md-html-wrap">HTML slide markup
          <textarea id="md-html" placeholder="&lt;div&gt;…full-screen slide markup…&lt;/div&gt;"></textarea></label>
        <button class="btn" id="md-add">Add media</button>
      </div>`;

    $('#md-add').onclick = async () => {
      const name = $('#md-name').value.trim();
      const type = $('#md-type').value;
      if (!name) return alert('Name required');
      let src = $('#md-src').value.trim();
      const file = $('#md-file').files[0];
      if (file) {
        const up = await fetch(`/api/upload?name=${encodeURIComponent(file.name)}`, { method: 'POST', body: file });
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
      await uploadGraphics([...files]);
      $('#dz-progress').textContent = '';
      render();
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

  async function renderSchedules() {
    const [{ schedules }, { playlists }, { screens }] = await Promise.all([
      api('GET', `/api/venues/${venueId}/schedules`),
      api('GET', `/api/venues/${venueId}/playlists`),
      api('GET', `/api/venues/${venueId}/screens`),
    ]);
    const zones = venue().zones || [];

    $('#tab-schedules').innerHTML = `
      <h2>Schedules (dayparting)</h2>
      <p class="muted">Most specific target wins: screen &gt; zone &gt; whole venue, then priority. End before start runs past midnight.</p>
      <table>
        <thead><tr><th>Name</th><th>Target</th><th>Playlist</th><th>Days</th><th>Time</th><th>Priority</th><th>Active</th><th></th></tr></thead>
        <tbody>${schedules.map((s) => {
          let days = [];
          try { days = JSON.parse(s.days_of_week); } catch { /* ignore */ }
          const dayLabel = days.length === 7 ? 'Every day' : days.map((d) => DAY_NAMES[d]).join(' ');
          const target = s.screen_name ? `Screen: ${esc(s.screen_name)}` : s.zone_name ? `Zone: ${esc(s.zone_name)}` : 'Whole venue';
          return `<tr style="${s.active ? '' : 'opacity:.45'}">
            <td>${esc(s.name) || '<span class="muted">—</span>'}</td>
            <td class="muted">${target}</td>
            <td>${esc(s.playlist_name)}</td>
            <td class="muted">${dayLabel}</td>
            <td>${esc(s.start_time)}–${esc(s.end_time)}</td>
            <td class="muted">${s.priority}</td>
            <td><button class="btn small secondary" data-act="toggle" data-id="${s.id}" data-active="${s.active}">${s.active ? 'On' : 'Off'}</button></td>
            <td style="text-align:right"><button class="btn small danger" data-act="del" data-id="${s.id}">✕</button></td>
          </tr>`;
        }).join('') || '<tr><td class="muted" colspan="8">No schedules yet</td></tr>'}
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
        priority: parseInt($('#sc-priority').value, 10) || 0,
        days_of_week: days,
      });
      render();
    };
    $('#tab-schedules').onclick = async (e) => {
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

  async function renderDraws() {
    const [{ draws }, remote] = await Promise.all([
      api('GET', `/api/venues/${venueId}/draws`),
      api('GET', `/api/venues/${venueId}/remote-token`),
    ]);
    const zones = venue().zones || [];
    const remoteUrl = remote.url ? location.origin + remote.url : null;

    $('#tab-draws').innerHTML = `
      <h2>Staff remote app 📱</h2>
      <div class="card">
        <p class="muted" style="margin-top:0">Bar staff run draws from their phone — no dashboard login.
        Send them this link; opening it in Chrome on Android (or Safari on iPhone) offers
        <b>Add to Home Screen</b>, which installs it as the <b>Korvix Draws</b> app.
        Generating a new link instantly cuts off the old one.</p>
        <div class="row">
          ${remoteUrl
            ? `<input readonly id="remote-url" value="${esc(remoteUrl)}" style="flex:1;min-width:280px;font-family:monospace;font-size:12px">
               <button class="btn small secondary" id="remote-copy">Copy link</button>
               <button class="btn small secondary" id="remote-rotate">Generate new link (revoke old)</button>`
            : '<button class="btn" id="remote-rotate">Generate staff app link</button>'}
        </div>
      </div>

      <h2>Raffle number draws</h2>
      <p class="muted">Set up a ticket range, then hit <b>Draw number</b> — targeted screens take over with a spinning number and reveal the winner.
      Draw again for “winner not present”: a number is never repeated within the same draw. <b>Clear</b> returns screens to normal content.</p>

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
              <button class="btn small" data-act="spin" data-id="${d.id}" ${d.remaining <= 0 ? 'disabled' : ''}>
                ${d.drawn_numbers.length ? 'Draw again' : 'Draw number'}</button>
              ${d.status === 'live' ? `<button class="btn small secondary" data-act="clear" data-id="${d.id}">Clear</button>` : ''}
              <button class="btn small danger" data-act="del" data-id="${d.id}">✕</button>
            </td>
          </tr>`).join('') || '<tr><td class="muted" colspan="6">No draws yet</td></tr>'}
        </tbody>
      </table>`;

    $('#remote-rotate').onclick = async () => {
      if (remoteUrl && !confirm('Generate a new link? Every phone using the current link loses access.')) return;
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
      const { act, id } = el.dataset;
      if (act === 'spin') {
        await api('POST', `/api/draws/${id}/draw`);
        render();
      } else if (act === 'clear') {
        await api('POST', `/api/draws/${id}/clear`);
        render();
      } else if (act === 'del') {
        if (confirm('Delete this draw and its history?')) {
          await api('DELETE', `/api/draws/${id}`);
          render();
        }
      }
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
            <option value="">ALL venues</option>
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

  // ---- boot -------------------------------------------------------------------------------

  (async () => {
    await refresh();
    setInterval(() => {
      if (activeTab === 'overview') render();
      else renderBanner();
    }, 15000);
  })();
})();
