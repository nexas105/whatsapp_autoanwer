// Calendar sources (iCal URLs with cached events) + confirmed appointments
// the bot booked via chat after the contact agreed.
import { getDb } from '../index.js';

const now = () => Date.now();

// ---------- calendar_sources ----------

export function listCalendarSources({ enabledOnly = false } = {}) {
  const db = getDb();
  const sql = enabledOnly
    ? `SELECT * FROM calendar_sources WHERE enabled = 1 ORDER BY id ASC`
    : `SELECT * FROM calendar_sources ORDER BY id ASC`;
  return db.prepare(sql).all();
}

export function getCalendarSource(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM calendar_sources WHERE id = ?`).get(Number(id));
}

export function insertCalendarSource({ name, ical_url, color = null, enabled = true }) {
  if (!name || !String(name).trim()) throw new Error('name required');
  if (!ical_url || !String(ical_url).trim()) throw new Error('ical_url required');
  const db = getDb();
  const t = now();
  const info = db.prepare(`
    INSERT INTO calendar_sources (name, ical_url, color, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(name.trim(), ical_url.trim(), color, enabled === false ? 0 : 1, t, t);
  return getCalendarSource(Number(info.lastInsertRowid));
}

export function updateCalendarSource(id, patch) {
  const db = getDb();
  const cur = getCalendarSource(id);
  if (!cur) throw new Error('calendar source not found');
  const merged = {
    name: patch.name !== undefined ? patch.name : cur.name,
    ical_url: patch.ical_url !== undefined ? patch.ical_url : cur.ical_url,
    color: patch.color !== undefined ? patch.color : cur.color,
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : cur.enabled,
  };
  db.prepare(`
    UPDATE calendar_sources SET name=?, ical_url=?, color=?, enabled=?, updated_at=?
    WHERE id=?
  `).run(merged.name, merged.ical_url, merged.color, merged.enabled, now(), Number(id));
  return getCalendarSource(id);
}

export function deleteCalendarSource(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM calendar_sources WHERE id = ?`).run(Number(id)).changes > 0;
}

// Persist parsed events + bookkeeping after an iCal fetch.
export function setCalendarSourceFetched(id, { events, error = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE calendar_sources
    SET events_json = ?, last_fetched_at = ?, last_error = ?, updated_at = ?
    WHERE id = ?
  `).run(
    events ? JSON.stringify(events) : null,
    Date.now(),
    error,
    Date.now(),
    Number(id),
  );
  return getCalendarSource(id);
}

export function getCalendarSourceEvents(id) {
  const s = getCalendarSource(id);
  if (!s || !s.events_json) return [];
  try { return JSON.parse(s.events_json) || []; } catch { return []; }
}

// ---------- confirmed_appointments ----------

const VALID_APPT_STATUS = new Set(['tentative', 'confirmed', 'cancelled']);

export function listAppointments({ chatId = null, sinceTs = null, untilTs = null, limit = 100 } = {}) {
  const db = getDb();
  const wheres = [`status != 'cancelled'`];
  const params = [];
  if (chatId) { wheres.push(`chat_id = ?`); params.push(chatId); }
  if (sinceTs != null) { wheres.push(`start_ts >= ?`); params.push(sinceTs); }
  if (untilTs != null) { wheres.push(`start_ts <= ?`); params.push(untilTs); }
  params.push(limit);
  return db.prepare(`
    SELECT * FROM confirmed_appointments
    WHERE ${wheres.join(' AND ')}
    ORDER BY start_ts ASC
    LIMIT ?
  `).all(...params);
}

export function getAppointment(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM confirmed_appointments WHERE id = ?`).get(Number(id));
}

export function insertAppointment({ chatId, messageId = null, title, notes = null, start_ts, end_ts, status = 'tentative' }) {
  if (!chatId) throw new Error('chatId required');
  if (!title || !String(title).trim()) throw new Error('title required');
  if (!Number.isFinite(start_ts)) throw new Error('start_ts required');
  if (!Number.isFinite(end_ts) || end_ts <= start_ts) throw new Error('end_ts must be > start_ts');
  if (!VALID_APPT_STATUS.has(status)) status = 'tentative';
  const db = getDb();
  const t = now();
  const info = db.prepare(`
    INSERT INTO confirmed_appointments (chat_id, message_id, title, notes, start_ts, end_ts, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(chatId, messageId, title.trim(), notes, start_ts, end_ts, status, t, t);
  return getAppointment(Number(info.lastInsertRowid));
}

export function updateAppointment(id, patch) {
  const db = getDb();
  const cur = getAppointment(id);
  if (!cur) throw new Error('appointment not found');
  const merged = {
    title: patch.title !== undefined ? patch.title : cur.title,
    notes: patch.notes !== undefined ? patch.notes : cur.notes,
    start_ts: patch.start_ts !== undefined ? patch.start_ts : cur.start_ts,
    end_ts: patch.end_ts !== undefined ? patch.end_ts : cur.end_ts,
    status: patch.status && VALID_APPT_STATUS.has(patch.status) ? patch.status : cur.status,
  };
  if (!Number.isFinite(merged.end_ts) || merged.end_ts <= merged.start_ts) {
    throw new Error('end_ts must be > start_ts');
  }
  db.prepare(`
    UPDATE confirmed_appointments
    SET title=?, notes=?, start_ts=?, end_ts=?, status=?, updated_at=?
    WHERE id=?
  `).run(merged.title, merged.notes, merged.start_ts, merged.end_ts, merged.status, now(), Number(id));
  return getAppointment(id);
}

export function deleteAppointment(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM confirmed_appointments WHERE id = ?`).run(Number(id)).changes > 0;
}
