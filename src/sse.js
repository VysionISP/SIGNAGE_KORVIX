'use strict';

// Server-Sent Events hub. Players subscribe with their device key; the CMS
// broadcasts "refresh" nudges (content/schedule changed, emergency raised or
// cleared) and players re-fetch their manifest. The manifest is the single
// source of truth; SSE is only the wake-up signal, so a missed event degrades
// gracefully to the player's normal polling interval.

const clients = new Map(); // deviceKey -> Set<res>

function subscribe(deviceKey, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 5000\n\n');
  let set = clients.get(deviceKey);
  if (!set) clients.set(deviceKey, (set = new Set()));
  set.add(res);

  const ping = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* cleaned up on close */ }
  }, 25000);

  res.on('close', () => {
    clearInterval(ping);
    set.delete(res);
    if (!set.size) clients.delete(deviceKey);
  });
}

function send(deviceKey, event, data = {}) {
  const set = clients.get(deviceKey);
  if (!set) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of set) {
    try { res.write(frame); } catch { set.delete(res); }
  }
}

function broadcast(deviceKeys, event, data = {}) {
  for (const key of deviceKeys) send(key, event, data);
}

function broadcastAll(event, data = {}) {
  for (const key of clients.keys()) send(key, event, data);
}

function connectedKeys() {
  return [...clients.keys()];
}

module.exports = { subscribe, send, broadcast, broadcastAll, connectedKeys };
