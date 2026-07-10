'use strict';

// Zero-dependency SMTP mailer. Works with any provider's SMTP credentials
// (Amazon SES, Resend, Mailgun, Postmark, a Google Workspace app password...).
//
//   SMTP_HOST=email-smtp.ap-southeast-2.amazonaws.com
//   SMTP_PORT=587                     # 587 STARTTLS (default) or 465 TLS
//   SMTP_USER=...   SMTP_PASS=...
//   MAIL_FROM="Venuecast <no-reply@yourdomain.com.au>"
//
// Until those are set, sendMail() quietly returns {skipped:true} — every
// email feature in the product is built to degrade gracefully around that.

const net = require('node:net');
const tls = require('node:tls');
const crypto = require('node:crypto');

const HOST = process.env.SMTP_HOST || '';
const PORT = parseInt(process.env.SMTP_PORT, 10) || 587;
const USER = process.env.SMTP_USER || '';
const PASS = process.env.SMTP_PASS || '';
const FROM = process.env.MAIL_FROM || USER;

const BRAND = process.env.KORVIX_BRAND || 'Korvix Signage';

function configured() {
  return !!(HOST && FROM);
}

const bareAddress = (s) => {
  const m = String(s).match(/<([^>]+)>/);
  return m ? m[1] : String(s).trim();
};

// Wraps a socket so SMTP replies can be awaited one at a time. Multi-line
// replies ("250-...\r\n250 ...") are complete when a line starts "NNN ".
function replyReader(socket, pending) {
  let buffer = '';
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8');
    const lines = buffer.split('\r\n').filter(Boolean);
    const last = lines[lines.length - 1];
    if (last && /^\d{3}[ ]/.test(last)) {
      const reply = buffer;
      buffer = '';
      const waiter = pending.shift();
      if (waiter) waiter.resolve(reply);
    }
  });
}

async function smtpSend(email) {
  const b64 = (s) => Buffer.from(s).toString('base64');
  const pending = [];
  let socket = null;
  let closed = false;

  const failAll = (err) => {
    closed = true;
    while (pending.length) pending.shift().reject(err);
  };
  const hook = (sock) => {
    replyReader(sock, pending);
    sock.setTimeout(20000, () => { sock.destroy(); failAll(new Error('smtp timeout')); });
    sock.on('error', (err) => failAll(err));
    sock.on('close', () => { if (!closed) failAll(new Error('smtp connection closed')); });
  };
  const read = () => new Promise((resolve, reject) => {
    if (closed) return reject(new Error('smtp connection closed'));
    pending.push({ resolve, reject });
  });
  const expect = async (prefix, label) => {
    const reply = await read();
    if (!reply.startsWith(prefix)) {
      throw new Error(`smtp ${label}: expected ${prefix}, got: ${reply.split('\r\n')[0]}`);
    }
    return reply;
  };
  const cmd = (line, prefix, label) => { socket.write(line + '\r\n'); return expect(prefix, label); };

  const connect = (opts) => new Promise((resolve, reject) => {
    const sock = opts.socket
      ? tls.connect({ socket: opts.socket, servername: HOST }, () => resolve(sock))
      : (PORT === 465
        ? tls.connect({ host: HOST, port: PORT, servername: HOST }, () => resolve(sock))
        : net.connect({ host: HOST, port: PORT }, () => resolve(sock)));
    sock.once('error', reject);
  });

  const body = [
    `From: ${FROM}`,
    `To: ${email.to}`,
    `Subject: ${String(email.subject || '').replace(/[\r\n]/g, ' ')}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomBytes(12).toString('hex')}@${bareAddress(FROM).split('@')[1] || 'signage'}>`,
    'MIME-Version: 1.0',
    email.html ? 'Content-Type: text/html; charset=utf-8' : 'Content-Type: text/plain; charset=utf-8',
    '',
    (email.html || email.text || '').replace(/^\./gm, '..'), // dot-stuffing
    '.',
  ].join('\r\n');

  try {
    socket = await connect({});
    hook(socket);
    await expect('220', 'greeting');
    await cmd('EHLO korvix-signage', '250', 'ehlo');

    if (!(socket instanceof tls.TLSSocket)) {
      await cmd('STARTTLS', '220', 'starttls');
      const plain = socket;
      plain.setTimeout(0);
      plain.removeAllListeners('data');
      plain.removeAllListeners('error');
      plain.removeAllListeners('close');
      socket = await connect({ socket: plain });
      hook(socket);
      await cmd('EHLO korvix-signage', '250', 'ehlo-tls');
    }

    if (USER) {
      await cmd('AUTH LOGIN', '334', 'auth');
      await cmd(b64(USER), '334', 'auth-user');
      await cmd(b64(PASS), '235', 'auth-pass');
    }
    await cmd(`MAIL FROM:<${bareAddress(FROM)}>`, '250', 'mail-from');
    await cmd(`RCPT TO:<${bareAddress(email.to)}>`, '250', 'rcpt-to');
    await cmd('DATA', '354', 'data');
    await cmd(body, '250', 'body');
    closed = true; // QUIT reply + close are best-effort from here
    socket.write('QUIT\r\n');
    socket.end();
    return { ok: true };
  } finally {
    closed = true;
    if (socket && !socket.destroyed) socket.destroy();
  }
}

function sendMail(email) {
  if (!configured()) return Promise.resolve({ skipped: true });
  return smtpSend(email).catch((err) => {
    console.error('[signage] email send failed:', err.message);
    return { ok: false, error: err.message };
  });
}

// Simple branded HTML shell for all product emails.
function template(title, bodyHtml) {
  return `<div style="background:#0b1220;padding:32px 16px;font-family:system-ui,sans-serif">
    <div style="max-width:520px;margin:0 auto;background:#121c30;border:1px solid #24334f;border-radius:12px;padding:28px;color:#e7edf7">
      <div style="font-weight:800;letter-spacing:.12em;margin-bottom:18px;color:#38bdf8">${BRAND.toUpperCase()}</div>
      <h2 style="margin:0 0 12px;font-size:18px;color:#fff">${title}</h2>
      <div style="font-size:14px;line-height:1.7;color:#c7d2e5">${bodyHtml}</div>
      <div style="margin-top:24px;font-size:11px;color:#8fa1bd">Sent by ${BRAND}. If this wasn't you, you can ignore this email.</div>
    </div>
  </div>`;
}

function button(href, label) {
  return `<p style="margin:20px 0"><a href="${href}" style="background:#38bdf8;color:#04202e;font-weight:700;
    padding:12px 22px;border-radius:8px;text-decoration:none;display:inline-block">${label}</a></p>
    <p style="font-size:12px;color:#8fa1bd">Or paste this link into your browser:<br>${href}</p>`;
}

module.exports = { sendMail, configured, template, button, BRAND };
