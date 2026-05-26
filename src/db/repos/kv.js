import { getDb } from '../index.js';

// ---------- kv ----------
export function kvGet(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM kv WHERE key=?`).get(key);
  return row?.value ?? null;
}

export function kvSet(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

// ---------- global config ----------
export function getGlobalConfig() {
  const raw = kvGet('global_config');
  const defaults = {
    quiet_hours_enabled: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00',
    quiet_hours_allow_suggestions: true,
    pii_redaction_enabled: true,
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

export function setGlobalConfig(patch) {
  const cur = getGlobalConfig();
  const next = { ...cur, ...(patch || {}) };
  kvSet('global_config', JSON.stringify(next));
  return next;
}
