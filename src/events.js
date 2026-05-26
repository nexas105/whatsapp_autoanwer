import { EventEmitter } from 'node:events';

// Application-wide event bus used to push updates to WebSocket clients
// and let modules react to each other without circular imports.
//
// Events:
//   'qr'         { qr: string }                       — QR string from whatsapp-web.js
//   'ready'      { info: object }                     — WA client authenticated
//   'auth_failure' { msg: string }
//   'disconnected' { reason: string }
//   'message'    { chatId, message }                  — every persisted incoming/outgoing message
//   'queue'      { chatId, jobId, status, fireAt? }   — reply queue state changes
//   'reply_sent' { chatId, jobId, body }              — sent auto-reply
//   'settings'   { chatId, settings }                 — settings changed
//   'analysis'   { chatId, analysis }                 — new analysis available
//   'log'        { level, msg, meta }                 — diagnostic log line
export const bus = new EventEmitter();
bus.setMaxListeners(64);

// Small ring buffer of recent error/warn log entries, surfaced by the
// /api/health endpoint so the UI Health modal can show the latest
// problems without subscribing to the live log stream.
export const recentErrors = [];
bus.on('log', ({ level, msg, meta, t }) => {
  if (level === 'error' || level === 'warn') {
    recentErrors.push({ level, msg, meta, t });
    if (recentErrors.length > 50) recentErrors.shift();
  }
});

export function log(level, msg, meta) {
  bus.emit('log', { level, msg, meta, t: Date.now() });
  const out = level === 'error' ? console.error : console.log;
  out(`[${level}] ${msg}`, meta ?? '');
}
