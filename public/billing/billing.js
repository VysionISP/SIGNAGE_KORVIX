'use strict';

// Standalone billing console — superadmin only. Two levels:
//   Overview:        KPIs, standard pricing, invoice settings (GST/company),
//                    the invoice book, business book
//   Business detail: one customer's whole account — editable profile,
//                    custom pricing, suspension, users, venues + screen
//                    licences, invoice history
// Shares the dashboard's session; anyone else is bounced to /admin/.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => localStorage.getItem('korvix.session');
  const money = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });
  const when = (iso) => (iso ? new Date(iso).toLocaleDateString('en-AU') : '—');

  let bill = null;      // /api/billing (prices + settings + usage rollup)
  let invoices = [];    // /api/billing/invoices
  let orgs = [];        // /api/orgs (profiles + counts)
  let users = [];       // /api/users
  let venues = [];      // /api/venues (with screens)
  let filter = 'all';
  let bizId = null;     // null = overview, else business detail

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: {
        ...(token() ? { Authorization: `Bearer ${token()}` } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) { location.href = '/admin/'; throw new Error('unauthorised'); }
    if (!res.ok) { alert(data.error || `error ${res.status}`); throw new Error(data.error || res.status); }
    return data;
  }

  async function load() {
    [bill, invoices, orgs, users, venues] = await Promise.all([
      api('GET', '/api/billing'),
      api('GET', '/api/billing/invoices').then((r) => r.invoices),
      api('GET', '/api/orgs').then((r) => r.orgs),
      api('GET', '/api/users').then((r) => r.users),
      api('GET', '/api/venues').then((r) => r.venues),
    ]);
    render();
  }

  function render() {
    if (bizId && !orgs.find((o) => o.id === bizId)) bizId = null;
    $('#view').innerHTML = bizId ? bizHtml(bizId) : overviewHtml();
    bind();
  }

  // ---- invoice rows (shared) --------------------------------------------------------

  function invoiceRows(list, { showBiz = true } = {}) {
    return list.map((i) => `
      <tr>
        <td style="font-variant-numeric:tabular-nums">${esc(i.period)}</td>
        ${showBiz ? `<td class="click" data-openbiz="${esc(i.org_id)}"><b>${esc(i.org_name)}</b></td>` : ''}
        <td class="num" style="font-weight:700">${money(i.total)}${i.gst ? `<br><span class="muted" style="font-size:11px;font-weight:400">incl ${money(i.gst)} GST</span>` : ''}</td>
        <td><span class="badge ${esc(i.status)}">${esc(i.status.toUpperCase())}</span></td>
        <td class="muted">${when(i.created_at)}${i.sent_at ? ` · sent ${when(i.sent_at)}` : ''}${i.paid_at ? ` · paid ${when(i.paid_at)}` : ''}</td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn small secondary" style="text-decoration:none" target="_blank"
            href="/api/billing/invoices/${i.id}/print?token=${encodeURIComponent(token() || '')}">Print</a>
          <button class="btn small secondary" data-send="${i.id}">✉ Email</button>
          ${i.status === 'paid'
            ? `<button class="btn small secondary" data-unpaid="${i.id}">↩ Unpaid</button>`
            : `<button class="btn small" data-paid="${i.id}">✓ Mark paid</button>`}
          <button class="btn small danger" data-del="${i.id}">✕</button>
        </td>
      </tr>`).join('');
  }

  // ---- overview ------------------------------------------------------------------------

  function overviewHtml() {
    const mainCount = bill.businesses.reduce((n, b) => n + b.main, 0);
    const basicCount = bill.businesses.reduce((n, b) => n + b.basic, 0);
    const compCount = bill.businesses.reduce((n, b) => n + (b.comp || 0), 0);
    const outstanding = invoices.filter((i) => i.status !== 'paid').reduce((n, i) => n + i.total, 0);
    const paidThisYear = invoices
      .filter((i) => i.status === 'paid' && i.period.startsWith(String(new Date().getFullYear())))
      .reduce((n, i) => n + i.total, 0);
    const visible = invoices.filter((i) => filter === 'all' || i.status === filter);

    return `
      <div class="kpis">
        <div class="kpi"><div class="label">Monthly revenue</div><div class="value" style="color:var(--accent)">${money(bill.total_monthly)}</div></div>
        <div class="kpi"><div class="label">Main screens</div><div class="value">${mainCount}</div></div>
        <div class="kpi"><div class="label">Basic screens</div><div class="value">${basicCount}${compCount ? `<span class="muted" style="font-size:13px"> +${compCount} comped</span>` : ''}</div></div>
        <div class="kpi"><div class="label">Businesses</div><div class="value">${bill.businesses.length}</div></div>
        <div class="kpi"><div class="label">Outstanding</div><div class="value" style="color:${outstanding ? 'var(--warn)' : 'var(--good)'}">${money(outstanding)}</div></div>
        <div class="kpi"><div class="label">Collected ${new Date().getFullYear()}</div><div class="value" style="color:var(--good)">${money(paidThisYear)}</div></div>
      </div>

      <div class="grid2" style="margin-top:24px">
        <div>
          <h2 style="margin-top:0">Standard pricing</h2>
          <div class="card">
            <div class="row">
              <label class="muted">Main $<input id="pr-main" type="number" min="0" step="1" style="width:80px" value="${bill.prices.main}"></label>
              <label class="muted">Basic $<input id="pr-basic" type="number" min="0" step="1" style="width:80px" value="${bill.prices.basic}"></label>
              <button class="btn small" id="pr-save">Save</button>
              <span class="muted" id="pr-note"></span>
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">Per screen, per month, ex GST. Businesses with a negotiated rate keep it — set that on their account page.</div>
          </div>
        </div>
        <div>
          <h2 style="margin-top:0">Invoice settings</h2>
          <div class="card">
            <div class="row">
              <label class="muted">GST <input id="st-gst" type="number" min="0" max="50" step="0.5" style="width:70px" value="${bill.settings.gst_rate}">%</label>
              <span class="muted" style="font-size:12px">added on top — set 0 if your prices are GST-inclusive</span>
            </div>
            <textarea id="st-company" placeholder="Company details printed on every invoice — name, ABN, payment instructions…"
              style="width:100%;min-height:64px;margin-top:10px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;color:inherit">${esc(bill.settings.company)}</textarea>
            <div class="row" style="margin-top:8px"><button class="btn small" id="st-save">Save invoice settings</button><span class="muted" id="st-note"></span></div>
          </div>
        </div>
      </div>

      <h2 style="display:flex;align-items:center;gap:14px">Invoices
        <span style="flex:1"></span>
        <span class="row" style="font-weight:400">
          <input type="month" id="inv-period" value="${new Date().toISOString().slice(0, 7)}">
          <button class="btn small" id="inv-generate">Generate invoices</button>
        </span>
      </h2>
      <div class="row" id="inv-filters" style="margin-bottom:10px">
        ${['all', 'draft', 'sent', 'paid'].map((f) =>
          `<button class="chip ${filter === f ? 'on' : ''}" data-filter="${f}">${f[0].toUpperCase() + f.slice(1)}</button>`).join('')}
      </div>
      <table>
        <tr><th>Period</th><th>Business</th><th class="num">Total</th><th>Status</th><th>Dates</th><th style="text-align:right">Actions</th></tr>
        ${invoiceRows(visible) || `<tr><td class="muted" colspan="6">No ${filter === 'all' ? '' : filter + ' '}invoices yet — pick a month above and hit Generate.</td></tr>`}
      </table>

      <h2 style="display:flex;align-items:center;gap:14px">Businesses
        <span style="flex:1"></span>
        <span class="row" style="font-weight:400">
          <input id="org-name" placeholder="New business name" style="min-width:220px">
          <button class="btn small" id="org-add">＋ Add business</button>
          <button class="btn small secondary" id="usage-csv">⬇ Usage CSV</button>
        </span>
      </h2>
      <p class="muted" style="margin-top:0">Click a business to manage its account — profile, users, venues, pricing and invoices.</p>
      <table>
        <tr><th>Business</th><th>Contact</th><th class="num">Venues</th><th class="num">Users</th><th class="num">Screens</th><th>Rate</th><th class="num">Per month</th></tr>
        ${bill.businesses.map((b) => {
          const org = orgs.find((o) => o.id === b.id) || {};
          return `
          <tr class="click" data-openbiz="${esc(b.id)}">
            <td><b>${esc(b.name)}</b> ${b.status === 'suspended' ? '<span class="badge draft" style="background:#450a0a;color:#fca5a5">SUSPENDED</span>' : ''}
              <span class="muted" style="font-size:12px">manage ›</span></td>
            <td class="muted" style="font-size:13px">${esc(org.contact_name || org.alert_email || '—')}${org.contact_phone ? `<br>${esc(org.contact_phone)}` : ''}</td>
            <td class="num">${b.venues.length}</td>
            <td class="num">${org.users ?? ''}</td>
            <td class="num">${b.main}M · ${b.basic}B${b.comp ? ` · ${b.comp}C` : ''}${b.unpaired ? `<span class="muted"> +${b.unpaired}✕</span>` : ''}</td>
            <td class="muted" style="font-size:13px">${b.custom_pricing ? `<span style="color:var(--warn)">custom ${money(b.prices.main)}/${money(b.prices.basic)}</span>` : 'standard'}</td>
            <td class="num" style="font-weight:700">${b.status === 'suspended' ? '<span class="muted">paused</span>' : money(b.monthly)}</td>
          </tr>`;
        }).join('') || '<tr><td class="muted" colspan="7">No businesses yet</td></tr>'}
      </table>`;
  }

  // ---- business detail -------------------------------------------------------------------

  const ROLE_OPTIONS = ['admin', 'editor', 'viewer'];

  function licenceOptions(s, prices) {
    return `
      <option value="main" ${(s.license || 'main') === 'main' ? 'selected' : ''}>Main — ${money(prices.main)}</option>
      <option value="basic" ${s.license === 'basic' ? 'selected' : ''}>Basic — ${money(prices.basic)}</option>
      <option value="comp" ${s.license === 'comp' ? 'selected' : ''}>Comped — $0</option>`;
  }

  function bizHtml(id) {
    const org = orgs.find((o) => o.id === id);
    const usage = bill.businesses.find((b) => b.id === id) || { main: 0, basic: 0, comp: 0, monthly: 0, venues: [], unpaired: 0, prices: bill.prices, status: 'active' };
    const bizUsers = users.filter((u) => u.org_id === id);
    const bizVenues = venues.filter((v) => v.org_id === id);
    const bizInvoices = invoices.filter((i) => i.org_id === id);
    const outstanding = bizInvoices.filter((i) => i.status !== 'paid').reduce((n, i) => n + i.total, 0);
    const suspended = (org.status || 'active') === 'suspended';

    return `
      <p style="margin:0 0 16px"><a href="#" class="crumb" id="back">← All businesses</a></p>
      <div class="row" style="margin-bottom:16px">
        <h1 style="margin:0;font-size:24px">${esc(org.name)}</h1>
        ${suspended ? '<span class="badge" style="background:#450a0a;color:#fca5a5">SUSPENDED</span>' : '<span class="badge paid">ACTIVE</span>'}
        <div class="spacer"></div>
        <button class="btn small ${suspended ? '' : 'danger'}" id="biz-suspend">${suspended ? '▶ Reactivate' : '⏸ Suspend'}</button>
        <button class="btn small danger" id="biz-delete" ${bizVenues.length ? 'disabled title="Business still has venues"' : ''}>Delete business</button>
      </div>
      ${suspended ? '<p class="muted" style="margin-top:-8px">Suspended: their screens play basic content with a licence ribbon, games and channels are off, and no new invoices are drafted.</p>' : ''}

      <div class="kpis">
        <div class="kpi"><div class="label">Monthly</div><div class="value" style="color:var(--accent)">${suspended ? '—' : money(usage.monthly)}</div></div>
        <div class="kpi"><div class="label">Main</div><div class="value">${usage.main}</div></div>
        <div class="kpi"><div class="label">Basic</div><div class="value">${usage.basic}</div></div>
        <div class="kpi"><div class="label">Comped</div><div class="value">${usage.comp || 0}</div></div>
        <div class="kpi"><div class="label">Users</div><div class="value">${bizUsers.length}</div></div>
        <div class="kpi"><div class="label">Outstanding</div><div class="value" style="color:${outstanding ? 'var(--warn)' : 'var(--good)'}">${money(outstanding)}</div></div>
      </div>

      <div class="grid2" style="margin-top:24px">
        <div>
          <h2 style="margin-top:0">Business profile</h2>
          <div class="card">
            <div class="grid2">
              <label class="muted">Business name<input id="bp-name" value="${esc(org.name)}" style="width:100%;margin-top:4px"></label>
              <label class="muted">Contact person<input id="bp-contact" value="${esc(org.contact_name || '')}" placeholder="e.g. Dave the owner" style="width:100%;margin-top:4px"></label>
              <label class="muted">Phone<input id="bp-phone" value="${esc(org.contact_phone || '')}" placeholder="04xx xxx xxx" style="width:100%;margin-top:4px"></label>
              <label class="muted">Billing / alerts email<input id="bp-email" type="email" value="${esc(org.alert_email || '')}" placeholder="accounts@business.com.au" style="width:100%;margin-top:4px"></label>
              <label class="muted">Address<input id="bp-address" value="${esc(org.address || '')}" style="width:100%;margin-top:4px"></label>
              <label class="muted">ABN<input id="bp-abn" value="${esc(org.abn || '')}" style="width:100%;margin-top:4px"></label>
            </div>
            <label class="muted" style="display:block;margin-top:10px">Account notes (internal — never shown to the customer)
              <textarea id="bp-notes" style="width:100%;min-height:56px;margin-top:4px;background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px 10px;font:inherit;color:inherit">${esc(org.notes || '')}</textarea></label>
            <div class="row" style="margin-top:10px"><button class="btn small" id="bp-save">Save profile</button><span class="muted" id="bp-note"></span></div>
          </div>

          <h2>Pricing for this business</h2>
          <div class="card">
            <div class="row">
              <label class="muted">Main $<input id="bpr-main" type="number" min="0" step="1" style="width:80px"
                value="${Number.isFinite(org.price_main) ? org.price_main : ''}" placeholder="${bill.prices.main}"></label>
              <label class="muted">Basic $<input id="bpr-basic" type="number" min="0" step="1" style="width:80px"
                value="${Number.isFinite(org.price_basic) ? org.price_basic : ''}" placeholder="${bill.prices.basic}"></label>
              <button class="btn small" id="bpr-save">Save rates</button>
              ${usage.custom_pricing ? '<button class="btn small secondary" id="bpr-clear">Back to standard</button>' : ''}
            </div>
            <div class="muted" style="font-size:12px;margin-top:8px">Blank = the standard rate (${money(bill.prices.main)} / ${money(bill.prices.basic)}). Applies from the next invoice.</div>
          </div>

          <h2>Users</h2>
          <table>
            <tr><th>Login</th><th>Role</th><th>Last sign-in</th><th style="text-align:right"></th></tr>
            ${bizUsers.map((u) => `
            <tr>
              <td><b>${esc(u.name || u.email)}</b><br><span class="muted" style="font-size:12px">${esc(u.email)}</span></td>
              <td><select data-urole="${esc(u.id)}">
                ${ROLE_OPTIONS.map((r) => `<option ${u.role === r ? 'selected' : ''}>${r}</option>`).join('')}
              </select></td>
              <td class="muted">${u.last_login_at ? when(u.last_login_at) : 'never'}</td>
              <td style="text-align:right;white-space:nowrap">
                <button class="btn small secondary" data-upw="${esc(u.id)}">Reset password</button>
                <button class="btn small danger" data-udel="${esc(u.id)}" data-email="${esc(u.email)}">✕</button>
              </td>
            </tr>`).join('') || '<tr><td class="muted" colspan="4">No logins yet — add their first admin below.</td></tr>'}
          </table>
          <div class="card" style="margin-top:12px">
            <b style="font-size:13px">Add a user to this business</b>
            <div class="row" style="margin-top:8px">
              <input id="nu-name" placeholder="Name" style="width:130px">
              <input id="nu-email" type="email" placeholder="Email" style="min-width:190px">
            </div>
            <div class="row" style="margin-top:8px">
              <input id="nu-pass" placeholder="Temporary password (8+)" style="min-width:190px">
              <select id="nu-role">${ROLE_OPTIONS.map((r) => `<option ${r === 'admin' ? 'selected' : ''}>${r}</option>`).join('')}</select>
              <button class="btn small" id="nu-add">Add user</button>
            </div>
          </div>
        </div>

        <div>
          <h2 style="margin-top:0">Venues &amp; screen licences</h2>
          ${bizVenues.map((v) => `
          <div class="card" style="margin-bottom:12px">
            <div class="row">
              <input data-vname="${esc(v.id)}" value="${esc(v.name)}" style="font-weight:700;min-width:170px">
              <span class="muted" style="font-size:12px">${v.screens.filter((s) => s.device_key).length} paired</span>
              <div class="spacer"></div>
              <select data-vmove="${esc(v.id)}" title="Move venue to another business">
                ${orgs.map((o) => `<option value="${esc(o.id)}" ${o.id === id ? 'selected' : ''}>${esc(o.name)}</option>`).join('')}
              </select>
              <button class="btn small danger" data-vdel="${esc(v.id)}" data-name="${esc(v.name)}">✕</button>
            </div>
            ${v.screens.length ? `<table style="margin-top:10px">
              ${v.screens.map((s) => `
              <tr>
                <td>${esc(s.name)}</td>
                <td><span class="badge ${s.status === 'online' ? 'paid' : s.status === 'unpaired' ? 'draft' : 'sent'}">${esc(s.status.toUpperCase())}</span></td>
                <td style="text-align:right"><select data-slic="${esc(s.id)}">${licenceOptions(s, usage.prices)}</select></td>
              </tr>`).join('')}
            </table>` : '<div class="muted" style="margin-top:8px;font-size:13px">No screens yet.</div>'}
          </div>`).join('') || '<div class="card muted">No venues yet — add their first one below.</div>'}
          <div class="card">
            <div class="row">
              <input id="nv-name" placeholder="New venue name — e.g. The Railway Hotel" style="min-width:230px">
              <button class="btn small" id="nv-add">＋ Add venue</button>
            </div>
            <div class="muted" style="font-size:12px;margin-top:6px">Zones, content and screens are then set up in the signage dashboard (or clone an existing venue there).</div>
          </div>
        </div>
      </div>

      <h2>Invoices — ${esc(org.name)}</h2>
      <table>
        <tr><th>Period</th><th class="num">Total</th><th>Status</th><th>Dates</th><th style="text-align:right">Actions</th></tr>
        ${invoiceRows(bizInvoices, { showBiz: false }) || '<tr><td class="muted" colspan="5">No invoices yet for this business.</td></tr>'}
      </table>`;
  }

  // ---- event wiring (re-bound each render) --------------------------------------------

  function bind() {
    const on = (sel, fn) => { const el = $(sel); if (el) el.onclick = fn; };

    document.querySelectorAll('[data-openbiz]').forEach((el) => {
      el.onclick = () => { bizId = el.dataset.openbiz; render(); window.scrollTo(0, 0); };
    });
    on('#back', (e) => { e.preventDefault(); bizId = null; render(); });

    // overview
    on('#pr-save', async () => {
      await api('PATCH', '/api/billing/prices', {
        main: parseFloat($('#pr-main').value), basic: parseFloat($('#pr-basic').value),
      });
      $('#pr-note').textContent = '✓ Saved';
      setTimeout(load, 900);
    });
    on('#st-save', async () => {
      await api('PATCH', '/api/billing/settings', {
        gst_rate: parseFloat($('#st-gst').value),
        company: $('#st-company').value,
      });
      $('#st-note').textContent = '✓ Saved — shows on invoices from now on';
      setTimeout(load, 1200);
    });
    on('#inv-generate', async () => {
      const period = $('#inv-period').value || new Date().toISOString().slice(0, 7);
      const out = await api('POST', '/api/billing/invoices/generate', { period });
      alert(out.created
        ? `${out.created} invoice(s) drafted for ${out.period}.`
        : `Nothing new — every active business already has a ${out.period} invoice (or has no billable screens).`);
      load();
    });
    const filters = $('#inv-filters');
    if (filters) filters.onclick = (e) => {
      const chip = e.target.closest('[data-filter]');
      if (chip) { filter = chip.dataset.filter; render(); }
    };
    on('#org-add', async () => {
      const name = $('#org-name').value.trim();
      if (!name) return alert('Give the business a name.');
      const created = await api('POST', '/api/orgs', { name });
      bizId = created.id;
      load();
    });
    on('#usage-csv', () => {
      const lines = [['business', 'status', 'venue', 'main', 'basic', 'comped', 'main_price', 'basic_price', 'monthly_total'].join(',')];
      for (const b of bill.businesses) {
        for (const v of b.venues) {
          lines.push([JSON.stringify(b.name), b.status, JSON.stringify(v.name), v.main, v.basic, v.comp || 0, b.prices.main, b.prices.basic, v.monthly].join(','));
        }
      }
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
      a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    });

    // invoice actions (both views)
    document.querySelectorAll('[data-send]').forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation();
        el.textContent = 'Sending…';
        try { await api('POST', `/api/billing/invoices/${el.dataset.send}/send`); } finally { load(); }
      };
    });
    document.querySelectorAll('[data-paid]').forEach((el) => {
      el.onclick = async (e) => { e.stopPropagation(); await api('POST', `/api/billing/invoices/${el.dataset.paid}/paid`, { paid: true }); load(); };
    });
    document.querySelectorAll('[data-unpaid]').forEach((el) => {
      el.onclick = async (e) => { e.stopPropagation(); await api('POST', `/api/billing/invoices/${el.dataset.unpaid}/paid`, { paid: false }); load(); };
    });
    document.querySelectorAll('[data-del]').forEach((el) => {
      el.onclick = async (e) => {
        e.stopPropagation();
        if (!confirm('Delete this invoice? (Usage data stays; you can regenerate.)')) return;
        await api('DELETE', `/api/billing/invoices/${el.dataset.del}`);
        load();
      };
    });

    // business detail
    if (!bizId) return;
    const org = orgs.find((o) => o.id === bizId);

    on('#bp-save', async () => {
      await api('PATCH', `/api/orgs/${bizId}`, {
        name: $('#bp-name').value,
        contact_name: $('#bp-contact').value,
        contact_phone: $('#bp-phone').value,
        alert_email: $('#bp-email').value,
        address: $('#bp-address').value,
        abn: $('#bp-abn').value,
        notes: $('#bp-notes').value,
      });
      $('#bp-note').textContent = '✓ Saved';
      setTimeout(load, 900);
    });
    on('#bpr-save', async () => {
      await api('PATCH', `/api/orgs/${bizId}`, {
        price_main: $('#bpr-main').value === '' ? null : parseFloat($('#bpr-main').value),
        price_basic: $('#bpr-basic').value === '' ? null : parseFloat($('#bpr-basic').value),
      });
      load();
    });
    on('#bpr-clear', async () => {
      await api('PATCH', `/api/orgs/${bizId}`, { price_main: null, price_basic: null });
      load();
    });
    on('#biz-suspend', async () => {
      const suspended = (org.status || 'active') === 'suspended';
      if (!suspended && !confirm(`Suspend "${org.name}"? Their screens drop to basic content with a licence ribbon and invoicing pauses.`)) return;
      await api('PATCH', `/api/orgs/${bizId}`, { status: suspended ? 'active' : 'suspended' });
      load();
    });
    on('#biz-delete', async () => {
      if (!confirm(`Delete "${org.name}"? Its users lose access. (Only possible with no venues.)`)) return;
      await api('DELETE', `/api/orgs/${bizId}`);
      bizId = null;
      load();
    });

    on('#nu-add', async () => {
      const email = $('#nu-email').value.trim();
      const password = $('#nu-pass').value;
      if (!email || !password) return alert('Email and a temporary password are required.');
      await api('POST', '/api/users', {
        email, password, name: $('#nu-name').value.trim(),
        role: $('#nu-role').value, org_id: bizId,
      });
      load();
    });
    document.querySelectorAll('[data-urole]').forEach((el) => {
      el.onchange = async () => { await api('PATCH', `/api/users/${el.dataset.urole}`, { role: el.value }); load(); };
    });
    document.querySelectorAll('[data-upw]').forEach((el) => {
      el.onclick = async () => {
        const pw = prompt('New password for this user (8+ characters) — it signs them out everywhere:');
        if (pw) { await api('PATCH', `/api/users/${el.dataset.upw}`, { password: pw }); alert('Password updated.'); }
      };
    });
    document.querySelectorAll('[data-udel]').forEach((el) => {
      el.onclick = async () => {
        if (confirm(`Delete user ${el.dataset.email}?`)) { await api('DELETE', `/api/users/${el.dataset.udel}`); load(); }
      };
    });

    // venues
    on('#nv-add', async () => {
      const name = $('#nv-name').value.trim();
      if (!name) return alert('Give the venue a name.');
      await api('POST', '/api/venues', { name, org_id: bizId });
      load();
    });
    document.querySelectorAll('[data-vname]').forEach((el) => {
      el.onchange = async () => {
        const name = el.value.trim();
        if (name) await api('PATCH', `/api/venues/${el.dataset.vname}`, { name });
        load();
      };
    });
    document.querySelectorAll('[data-vmove]').forEach((el) => {
      el.onchange = async () => {
        const target = orgs.find((o) => o.id === el.value);
        if (!confirm(`Move this venue to "${target?.name}"? Users of ${org.name} lose access to it immediately.`)) { render(); return; }
        await api('PATCH', `/api/venues/${el.dataset.vmove}`, { org_id: el.value });
        load();
      };
    });
    document.querySelectorAll('[data-vdel]').forEach((el) => {
      el.onclick = async () => {
        const typed = prompt(`This permanently deletes "${el.dataset.name}" — its screens, media, playlists, schedules and games.\nType the venue name to confirm:`);
        if (typed === null) return;
        if (typed !== el.dataset.name) return alert('Name did not match — nothing deleted.');
        await api('DELETE', `/api/venues/${el.dataset.vdel}`);
        load();
      };
    });
    document.querySelectorAll('[data-slic]').forEach((el) => {
      el.onchange = async () => { await api('PATCH', `/api/screens/${el.dataset.slic}`, { license: el.value }); load(); };
    });
  }

  // ---- boot ---------------------------------------------------------------------------

  (async () => {
    const state = await (await fetch('/api/auth/state')).json();
    if (state.brand) {
      document.title = `${state.brand} — Billing`;
      $('#brand').innerHTML = `${esc(state.brand.split(' ')[0].toUpperCase())} <span>BILLING</span>`;
    }
    if (!token()) { location.href = '/admin/'; return; }
    let me;
    try { me = (await api('GET', '/api/auth/me')).user; } catch { return; }
    if (me.role !== 'superadmin') { location.href = '/admin/'; return; }
    $('#who').textContent = me.email || me.name;
    await load();
    const overlay = $('#overlay');
    if (overlay) overlay.remove();
    setInterval(() => { if (!document.activeElement || !/INPUT|SELECT|TEXTAREA/.test(document.activeElement.tagName)) load(); }, 45000);
  })();
})();
