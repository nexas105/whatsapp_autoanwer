// macOS notification bridge.
//
// Exports:
//   - notify(title, msg, { sound? }): fire a single macOS desktop notification
//     via `osascript`. Throttled to one notification per MIN_GAP_MS to avoid
//     spam when many events fire in a burst.
//   - installNotifBridge(): subscribes to the application bus and translates
//     selected events ('disconnected', 'suggestion', 'auth_failure') into
//     notifications. Idempotent — calling twice is a no-op.

import { spawn } from 'node:child_process';
import { bus, log } from './events.js';

let lastNotifTs = 0;
const MIN_GAP_MS = 2000;

export function notify(title, msg, { sound = false } = {}) {
  const now = Date.now();
  if (now - lastNotifTs < MIN_GAP_MS) return;
  lastNotifTs = now;
  const escTitle = String(title || 'WhatsApp AutoAnswer').replace(/"/g, '\\"');
  const escMsg = String(msg || '').replace(/"/g, '\\"');
  const script = `display notification "${escMsg}" with title "${escTitle}"${sound ? ' sound name "Glass"' : ''}`;
  try {
    spawn('osascript', ['-e', script], { stdio: 'ignore', detached: true }).unref();
  } catch (err) {
    log('warn', 'notify failed', { error: String(err) });
  }
}

let _installed = false;

export function installNotifBridge() {
  if (_installed) return;
  _installed = true;

  bus.on('disconnected', ({ reason } = {}) => {
    notify('WhatsApp getrennt', String(reason || ''));
  });

  bus.on('suggestion', ({ chatId, suggestion } = {}) => {
    // Best-effort chat label — we don't import repo here to avoid a
    // start-up cycle with the DB; chatId is informative enough.
    const label = (suggestion && suggestion.chat_name) || chatId || '';
    notify('Neue Antwortvorschläge warten', String(label));
  });

  bus.on('auth_failure', ({ msg } = {}) => {
    notify('Auth-Fehler', String(msg || ''));
  });
}
