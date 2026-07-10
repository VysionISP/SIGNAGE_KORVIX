'use strict';

// Standalone billing console — superadmin only. Everything money lives here:
// licence prices, monthly invoices (draft -> sent -> paid), current usage.
// Shares the dashboard's session; anyone else is bounced to /admin/.

(() => {
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const token = () => localStorage.getItem('korvix.session');
  const money = (n) => '$' + Number(n).toLocaleString('en-AU', { maximumFractionDigits: 2 });

  let bill = null;      // /api/billing (prices + usage rollup)
  let invoices = [];    // /api/billing/invoices
  let filter = 'all';

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
    [bill, invoices] = await Promise.all([
      api('GET', '/api/billing'),
      api('GET', '/api/billing/invoices').then((r) => r.invoices),
    ]);
    render();
  }

  function render() {
    const mainCount = bill.businesses.reduce((n, b) => n + b.main, 0);
    const basicCount = bill.businesses.reduce((n, b) => n + b.basic, 0);
    const outstanding = invoices.filter((i) => i.status !== 'paid').reduce((n, i) => n + i.total, 0);
    const paidThisYear = invoices
      .filter((i) => i.status === 'paid' && i.period.startsWith(String(new Date().getFullYear())))
      .reduce((n, i) => n + i.total, 0);

    $('#kpis').innerHTML = `
      <div class="kpi"><div class="label">Monthly revenue</div><div class="value" style="color:var(--accent)">${money(bill.total_monthly)}</div></div>
      <div class="kpi"><div class="label">Main screens</div><div class="value">${mainCount}</div></div>
      <div class="kpi"><div class="label">Basic screens</div><div class="value">${basicCount}</div></div>
      <div class="kpi"><div class="label">Businesses</div><div class="value">${bill.businesses.length}</div></div>
      <div class="kpi"><div class="label">Outstanding</div><div class="value" style="color:${outstanding ? 'var(--warn)' : 'var(--good)'}">${money(outstanding)}</div></div>
      <div class="kpi"><div class="label">Collected ${new Date().getFullYear()}</div><div class="value" style="color:var(--good)">${money(paidThisYear)}</div></div>`;

    $('#pr-main').value = bill.prices.main;
    $('#pr-basic').value = bill.prices.basic;

    const visible = invoices.filter((i) => filter === 'all' || i.status === filter);
    $('#inv-table').innerHTML = `
      <tr><th>Period</th><th>Business</th><th class="num">Total</th><th>Status</th><th>Issued</th><th style="text-align:right">Actions</th></tr>
      ${visible.map((i) => `
      <tr>
        <td style="font-variant-numeric:tabular-nums">${esc(i.period)}</td>
        <td><b>${esc(i.org_name)}</b>${i.org_email ? `<span class="muted" style="font-size:12px"> · ${esc(i.org_email)}</span>` : ''}</td>
        <td class="num" style="font-weight:700">${money(i.total)}</td>
        <td><span class="badge ${esc(i.status)}">${esc(i.status.toUpperCase())}</span></td>
        <td class="muted">${new Date(i.created_at).toLocaleDateString('en-AU')}${i.sent_at ? ` · sent ${new Date(i.sent_at).toLocaleDateString('en-AU')}` : ''}</td>
        <td style="text-align:right;white-space:nowrap">
          <a class="btn small secondary" style="text-decoration:none" target="_blank"
            href="/api/billing/invoices/${i.id}/print?token=${encodeURIComponent(token() || '')}">Print</a>
          <button class="btn small secondary" data-send="${i.id}">✉ Email</button>
          ${i.status === 'paid'
            ? `<button class="btn small secondary" data-unpaid="${i.id}">↩ Unpaid</button>`
            : `<button class="btn small" data-paid="${i.id}">✓ Mark paid</button>`}
          <button class="btn small danger" data-del="${i.id}">✕</button>
        </td>
      </tr>`).join('') || `<tr><td class="muted" colspan="6">No ${filter === 'all' ? '' : filter + ' '}invoices yet — pick a month above and hit Generate.</td></tr>`}`;

    $('#usage-table').innerHTML = `
      <tr><th>Business / venue</th><th class="num">Main</th><th class="num">Basic</th><th class="num">Unpaired (free)</th><th class="num">Per month</th></tr>
      ${bill.businesses.map((b) => `
      <tr>
        <td><b>${esc(b.name)}</b></td>
        <td class="num">${b.main}</td><td class="num">${b.basic}</td>
        <td class="num muted">${b.unpaired || ''}</td>
        <td class="num" style="font-weight:700">${money(b.monthly)}</td>
      </tr>
      ${b.venues.map((v) => `
      <tr class="venue-row">
        <td style="padding-left:34px">↳ ${esc(v.name)}</td>
        <td class="num">${v.main}</td><td class="num">${v.basic}</td>
        <td class="num">${v.unpaired || ''}</td>
        <td class="num">${money(v.monthly)}</td>
      </tr>`).join('')}`).join('') || '<tr><td class="muted" colspan="5">No businesses yet</td></tr>'}`;
  }

  // ---- actions -------------------------------------------------------------------

  $('#pr-save').onclick = async () => {
    await api('PATCH', '/api/billing/prices', {
      main: parseFloat($('#pr-main').value),
      basic: parseFloat($('#pr-basic').value),
    });
    $('#pr-note').textContent = '✓ Saved — applies to new invoices';
    setTimeout(() => { $('#pr-note').textContent = ''; }, 2500);
    load();
  };

  $('#inv-generate').onclick = async () => {
    const period = $('#inv-period').value || new Date().toISOString().slice(0, 7);
    const out = await api('POST', '/api/billing/invoices/generate', { period });
    alert(out.created
      ? `${out.created} invoice(s) drafted for ${out.period}.`
      : `Nothing new — every business already has a ${out.period} invoice (or has no billable screens).`);
    load();
  };

  $('#inv-filters').onclick = (e) => {
    const chip = e.target.closest('[data-filter]');
    if (!chip) return;
    filter = chip.dataset.filter;
    document.querySelectorAll('#inv-filters .chip').forEach((c) => c.classList.toggle('on', c === chip));
    render();
  };

  $('#inv-table').onclick = async (e) => {
    const send = e.target.closest('[data-send]');
    const paid = e.target.closest('[data-paid]');
    const unpaid = e.target.closest('[data-unpaid]');
    const del = e.target.closest('[data-del]');
    if (send) {
      send.textContent = 'Sending…';
      try { await api('POST', `/api/billing/invoices/${send.dataset.send}/send`); }
      finally { load(); }
    } else if (paid) {
      await api('POST', `/api/billing/invoices/${paid.dataset.paid}/paid`, { paid: true });
      load();
    } else if (unpaid) {
      await api('POST', `/api/billing/invoices/${unpaid.dataset.unpaid}/paid`, { paid: false });
      load();
    } else if (del && confirm('Delete this invoice? (The usage data stays; you can regenerate.)')) {
      await api('DELETE', `/api/billing/invoices/${del.dataset.del}`);
      load();
    }
  };

  $('#usage-csv').onclick = () => {
    const lines = [['business', 'venue', 'main_screens', 'basic_screens', 'main_price', 'basic_price', 'monthly_total'].join(',')];
    for (const b of bill.businesses) {
      for (const v of b.venues) {
        lines.push([JSON.stringify(b.name), JSON.stringify(v.name), v.main, v.basic, bill.prices.main, bill.prices.basic, v.monthly].join(','));
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = `usage-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  // ---- boot -----------------------------------------------------------------------

  (async () => {
    const state = await (await fetch('/api/auth/state')).json();
    if (state.brand) {
      document.title = `${state.brand} — Billing`;
      const words = state.brand.split(' ');
      $('#brand').innerHTML = `${esc(words[0].toUpperCase())} <span>BILLING</span>`;
    }
    if (!token()) { location.href = '/admin/'; return; }
    let me;
    try { me = (await api('GET', '/api/auth/me')).user; } catch { return; }
    if (me.role !== 'superadmin') { location.href = '/admin/'; return; }
    $('#who').textContent = me.email || me.name;
    $('#inv-period').value = new Date().toISOString().slice(0, 7);
    await load();
    $('#overlay').remove();
    setInterval(load, 30000);
  })();
})();
