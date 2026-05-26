// WebSocket bridge.
//
// Contract:
//   export function attachWs(server) -> void

import { WebSocketServer } from 'ws';

import { bus, log } from '../events.js';
import { config } from '../config.js';

export function attachWs(server) {
  // noServer mode so we can intercept upgrades and check the auth token.
  // When DASHBOARD_TOKEN is empty, behavior is identical to the old default
  // (every upgrade for /ws is accepted).
  const wss = new WebSocketServer({ noServer: true, path: '/ws' });

  server.on('upgrade', (req, socket, head) => {
    if (!req.url || !req.url.startsWith('/ws')) return; // not our concern
    if (config.auth.token) {
      let token = '';
      try {
        const u = new URL(req.url, 'http://x');
        token = u.searchParams.get('token') || '';
      } catch { /* ignore */ }
      // Also accept Authorization: Bearer <token> as a fallback.
      if (!token) {
        const h = req.headers && req.headers.authorization ? String(req.headers.authorization) : '';
        const m = /^Bearer\s+(.+)$/i.exec(h);
        if (m) token = m[1];
      }
      if (token !== config.auth.token) {
        try {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
        } catch { /* ignore */ }
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  function broadcast(obj) {
    let data;
    try {
      data = JSON.stringify(obj);
    } catch (err) {
      log('error', 'ws broadcast serialize failed', { error: String(err) });
      return;
    }
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) {
        try { client.send(data); } catch { /* ignore */ }
      }
    }
  }

  // ── Event coalescer ─────────────────────────────────────────────────
  // For very bursty event types we accumulate events in a small buffer and
  // flush them as a single {type:'<X>_batch', events:[...]} message after a
  // short window. Currently only `log` is coalesced — it's by far the
  // chattiest channel during AI runs, and clients (the dashboard log pane)
  // don't care about exact inter-arrival timing. `message` is intentionally
  // NOT coalesced to preserve per-message UI animations and ordering.
  const COALESCE_FLUSH_MS = 80;
  const COALESCE_THRESHOLD = 5;
  const coalesceState = new Map(); // type -> { buf: [], timer: Timeout|null }

  function flushCoalesced(type) {
    const st = coalesceState.get(type);
    if (!st) return;
    if (st.timer) { clearTimeout(st.timer); st.timer = null; }
    const events = st.buf;
    st.buf = [];
    if (!events.length) return;
    if (events.length === 1) {
      // Single event in the window — keep original shape, no batch overhead.
      broadcast(events[0]);
    } else {
      broadcast({ type: `${type}_batch`, events });
    }
  }

  function broadcastCoalesced(type, payload) {
    let st = coalesceState.get(type);
    if (!st) {
      st = { buf: [], timer: null };
      coalesceState.set(type, st);
    }
    st.buf.push(payload);
    // Flush immediately if we've crossed the burst threshold.
    if (st.buf.length >= COALESCE_THRESHOLD) {
      flushCoalesced(type);
      return;
    }
    if (!st.timer) {
      st.timer = setTimeout(() => flushCoalesced(type), COALESCE_FLUSH_MS);
    }
  }

  // Bus -> WS forwarding.
  const listeners = [
    ['qr',           ({ qr }) => broadcast({ type: 'qr', qr })],
    ['ready',        ({ info }) => broadcast({ type: 'ready', info })],
    ['disconnected', ({ reason }) => broadcast({ type: 'disconnected', reason })],
    ['message',      ({ chatId, message }) => broadcast({ type: 'message', chatId, message })],
    ['queue',        (payload) => broadcast({ type: 'queue', ...payload })],
    ['reply_sent',   ({ chatId, jobId, body }) => broadcast({ type: 'reply_sent', chatId, jobId, body })],
    ['settings',     ({ chatId, settings }) => broadcast({ type: 'settings', chatId, settings })],
    ['analysis',     ({ chatId, analysis }) => broadcast({ type: 'analysis', chatId, analysis })],
    ['log',          ({ level, msg, meta, t }) => broadcastCoalesced('log', { type: 'log', level, msg, meta, t })],
    ['media',        ({ chatId, media }) => broadcast({ type: 'media', chatId, media })],
    ['personas',     ({ action, persona, id }) => broadcast({ type: 'personas', action, persona, id })],
    ['sync',         (payload) => broadcast({ type: 'sync', ...payload })],
    ['transcript',   (payload) => broadcast({ type: 'transcript', ...payload })],
    ['trigger',      (payload) => broadcast({ type: 'trigger', ...payload })],
    ['suggestion',           (payload) => broadcast({ type: 'suggestion', ...payload })],
    ['suggestion_resolved',  (payload) => broadcast({ type: 'suggestion_resolved', ...payload })],
    ['ack',                  ({ messageId, chatId, ack }) => broadcast({ type: 'ack', messageId, chatId, ack })],
    ['schedule',             (payload) => broadcast({ type: 'schedule', ...payload })],
    ['autocomplete',         (payload) => broadcast({ type: 'autocomplete', ...payload })],
    ['memory_added',         (payload) => broadcast({ type: 'memory_added', ...payload })],
    ['memory_removed',       (payload) => broadcast({ type: 'memory_removed', ...payload })],
    ['safety',               (payload) => broadcast({ type: 'safety', ...payload })],
    ['quality',              (payload) => broadcast({ type: 'quality', ...payload })],
    ['profile',              (payload) => broadcast({ type: 'profile', ...payload })],
    ['schedule_entry',       (payload) => broadcast({ type: 'schedule_entry', ...payload })],
    ['contact_bio',          (payload) => broadcast({ type: 'contact_bio', ...payload })],
    ['bio_suggestion',       (payload) => broadcast({ type: 'bio_suggestion', ...payload })],
    ['ai_session',           (payload) => broadcast({ type: 'ai_session', ...payload })],
    ['summary',              (payload) => broadcast({ type: 'summary', ...payload })],
    ['summary_folder',       (payload) => broadcast({ type: 'summary_folder', ...payload })],
    ['calendar_source',      (payload) => broadcast({ type: 'calendar_source', ...payload })],
    ['appointment',          (payload) => broadcast({ type: 'appointment', ...payload })],
  ];

  for (const [event, handler] of listeners) {
    bus.on(event, handler);
  }

  wss.on('connection', (client) => {
    client.isAlive = true;
    client.on('pong', () => { client.isAlive = true; });

    client.on('message', (raw) => {
      let parsed;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        return;
      }
      if (parsed && parsed.type === 'ping') {
        if (client.readyState === client.OPEN) {
          try { client.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
        }
      }
    });

    client.on('error', (err) => {
      log('warn', 'ws client error', { error: String(err) });
    });

    try {
      client.send(JSON.stringify({ type: 'hello' }));
    } catch { /* ignore */ }
  });

  // Heartbeat: ping every 30s, terminate dead sockets.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.isAlive === false) {
        try { client.terminate(); } catch { /* ignore */ }
        continue;
      }
      client.isAlive = false;
      try { client.ping(); } catch { /* ignore */ }
    }
  }, 30000);

  wss.on('close', () => {
    clearInterval(heartbeat);
    // Flush + clear any pending coalescer timers so we don't leak.
    for (const type of coalesceState.keys()) {
      const st = coalesceState.get(type);
      if (st && st.timer) { clearTimeout(st.timer); st.timer = null; }
    }
    coalesceState.clear();
    for (const [event, handler] of listeners) {
      bus.off(event, handler);
    }
  });
}
