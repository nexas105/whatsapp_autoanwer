// Safety helpers: risk classification, quiet hours, decision routing.
//
// Pure helpers; safe to import anywhere.

import { getGlobalConfig } from '../db/repo.js';

const RISK_PATTERNS = {
  money: /\b(\d+\s*[€$]|\d+\s*(euro|eur|usd|dollar)|geld|überweis|paypal|venmo|iban|konto|cash)\b/i,
  date: /\b(treffen|termin|datum|verabredung|uhr|morgen|übermorgen|nächste woche|wochenende)\b/i,
  conflict: /\b(streit|wütend|sauer|enttäuscht|nervt|hasse|schluss|aus|ärger)\b/i,
  sensitive: /\b(krank|krankenhaus|tot|gestorben|trennung|scheidung|operation|unfall|notfall)\b/i,
};

// Classify an incoming message for risky content.
// Returns { matched: boolean, categories: string[] }.
export function classifyRisk(text, message) {
  const categories = [];
  const t = String(text || '');
  for (const [cat, re] of Object.entries(RISK_PATTERNS)) {
    if (re.test(t)) categories.push(cat);
  }
  // "Unknown media" risk: image without transcript (no analysis text yet)
  if (message && message.has_media === 1 && !message.transcript && !t.trim()) {
    categories.push('unknown_media');
  }
  return { matched: categories.length > 0, categories };
}

// Parse "HH:MM" into a minutes-of-day integer (0..1439), or null if invalid.
function toMin(hhmm) {
  const m = String(hhmm || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const mn = Number(m[2]);
  if (h < 0 || h > 23 || mn < 0 || mn > 59) return null;
  return h * 60 + mn;
}

// Whether `date` falls inside the configured quiet-hours window.
// Window may wrap across midnight (e.g. 22:00 -> 08:00).
export function inQuietHours(date = new Date(), cfg = null) {
  cfg = cfg || getGlobalConfig();
  if (!cfg.quiet_hours_enabled) return false;
  const start = toMin(cfg.quiet_hours_start);
  const end = toMin(cfg.quiet_hours_end);
  if (start == null || end == null) return false;
  if (start === end) return false;
  const cur = date.getHours() * 60 + date.getMinutes();
  if (start < end) return cur >= start && cur < end;
  // Wraps midnight
  return cur >= start || cur < end;
}

// Decide what to do with this message based on all safety inputs.
// Returns one of: 'normal' (send), 'suggest' (downgrade), 'block' (do nothing).
export function decideSafety({ settings, message, riskMatched, now = Date.now() }) {
  if (!settings) return 'normal';

  if (settings.never_to_ai === 1) return 'block';
  if (settings.safety_mode === 'never_send') return 'block';
  if (settings.safety_mode === 'always_suggest') return 'suggest';
  if (settings.safety_mode === 'risk_aware' && riskMatched) return 'suggest';

  // Cooldown after manual reply
  if (settings.last_manual_reply_at && settings.cooldown_after_manual_ms) {
    const since = now - Number(settings.last_manual_reply_at);
    if (since >= 0 && since < Number(settings.cooldown_after_manual_ms)) return 'suggest';
  }

  // Quiet hours
  if (inQuietHours()) {
    const cfg = getGlobalConfig();
    return cfg.quiet_hours_allow_suggestions ? 'suggest' : 'block';
  }

  return 'normal';
}
