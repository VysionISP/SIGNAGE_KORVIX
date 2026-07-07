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

  function render() {
    $('venue-name').textContent = state.venue.name;
    $('new-draw-wrap').style.display = 'block';

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
    if (!spin && !clear) return;
    if (busy) return;
    busy = true;
    try {
      if (spin) {
        if (navigator.vibrate) navigator.vibrate(80);
        const updated = await api('POST', `/api/remote/${token}/draws/${spin.dataset.spin}/draw`);
        freshNumbers.add(updated.id);
      } else {
        await api('POST', `/api/remote/${token}/draws/${clear.dataset.clear}/clear`);
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
