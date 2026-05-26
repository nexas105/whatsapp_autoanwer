import { getDb, now } from '../index.js';

// ---------- scheduled messages (cron-style) ----------
export function listScheduledMessages({ enabledOnly = false } = {}) {
  const db = getDb();
  const sql = enabledOnly
    ? `SELECT * FROM scheduled_messages WHERE enabled = 1 ORDER BY id ASC`
    : `SELECT * FROM scheduled_messages ORDER BY id ASC`;
  return db.prepare(sql).all();
}

export function getScheduledMessage(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`).get(Number(id));
}

export function insertScheduledMessage(patch) {
  const db = getDb();
  if (!patch.name || !patch.schedule_spec || !patch.prompt) {
    throw new Error('name, schedule_spec, prompt required');
  }
  const t = now();
  const info = db.prepare(`
    INSERT INTO scheduled_messages
      (chat_id, name, schedule_kind, schedule_spec, prompt, mode, target_filter, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    patch.chat_id ?? null,
    patch.name,
    patch.schedule_kind || 'cron',
    patch.schedule_spec,
    patch.prompt,
    patch.mode || 'ai',
    patch.target_filter ? JSON.stringify(patch.target_filter) : null,
    patch.enabled === false ? 0 : 1,
    t, t,
  );
  return getScheduledMessage(Number(info.lastInsertRowid));
}

export function updateScheduledMessage(id, patch) {
  const db = getDb();
  const c = getScheduledMessage(id);
  if (!c) throw new Error('schedule not found');
  const next = {
    chat_id: patch.chat_id !== undefined ? patch.chat_id : c.chat_id,
    name: patch.name ?? c.name,
    schedule_kind: patch.schedule_kind ?? c.schedule_kind,
    schedule_spec: patch.schedule_spec ?? c.schedule_spec,
    prompt: patch.prompt ?? c.prompt,
    mode: patch.mode ?? c.mode,
    target_filter: patch.target_filter !== undefined
      ? (patch.target_filter ? JSON.stringify(patch.target_filter) : null)
      : c.target_filter,
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : c.enabled,
    next_run_at: patch.next_run_at !== undefined ? patch.next_run_at : c.next_run_at,
    last_run_at: patch.last_run_at !== undefined ? patch.last_run_at : c.last_run_at,
    last_result: patch.last_result !== undefined ? patch.last_result : c.last_result,
  };
  db.prepare(`
    UPDATE scheduled_messages SET
      chat_id=?, name=?, schedule_kind=?, schedule_spec=?, prompt=?, mode=?,
      target_filter=?, enabled=?, next_run_at=?, last_run_at=?, last_result=?, updated_at=?
    WHERE id=?
  `).run(
    next.chat_id, next.name, next.schedule_kind, next.schedule_spec, next.prompt, next.mode,
    next.target_filter, next.enabled, next.next_run_at, next.last_run_at, next.last_result,
    now(), Number(id),
  );
  return getScheduledMessage(id);
}

export function deleteScheduledMessage(id) {
  const db = getDb();
  const info = db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(Number(id));
  return info.changes > 0;
}
