import { getDb } from '../index.js';

// ---------- summary folders ----------
export function listSummaryFolders() {
  const db = getDb();
  return db.prepare(`SELECT * FROM summary_folders ORDER BY created_at DESC`).all();
}

export function createSummaryFolder(name) {
  if (!name || !String(name).trim()) throw new Error('name required');
  const db = getDb();
  const info = db.prepare(`INSERT INTO summary_folders (name, created_at) VALUES (?, ?)`)
    .run(String(name).trim(), Date.now());
  return db.prepare(`SELECT * FROM summary_folders WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function deleteSummaryFolder(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM summary_folders WHERE id = ?`).run(Number(id)).changes > 0;
}

// ---------- summaries ----------
export function listSummaries({ folderId = null, limit = 200 } = {}) {
  const db = getDb();
  if (
    folderId === null
    || folderId === undefined
    || folderId === ''
    || folderId === 'null'
  ) {
    return db.prepare(`SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?`).all(Number(limit) || 200);
  }
  return db.prepare(`SELECT * FROM summaries WHERE folder_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(Number(folderId), Number(limit) || 200);
}

export function getSummary(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM summaries WHERE id = ?`).get(Number(id));
}

export function insertSummary(s) {
  const db = getDb();
  const t = Date.now();
  const info = db.prepare(`
    INSERT INTO summaries (
      folder_id, chat_id, title, template, range_kind, range_value,
      system_prompt, content_md, message_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.folder_id ?? null,
    s.chat_id ?? null,
    s.title,
    s.template || 'general',
    s.range_kind || 'last_n',
    String(s.range_value || ''),
    s.system_prompt ?? null,
    s.content_md,
    Number(s.message_count) || 0,
    t,
    t,
  );
  return getSummary(Number(info.lastInsertRowid));
}

export function updateSummary(id, patch) {
  const db = getDb();
  const cur = getSummary(id);
  if (!cur) throw new Error('summary not found');
  const next = {
    folder_id: patch.folder_id !== undefined ? patch.folder_id : cur.folder_id,
    title: patch.title !== undefined ? patch.title : cur.title,
    content_md: patch.content_md !== undefined ? patch.content_md : cur.content_md,
  };
  db.prepare(`UPDATE summaries SET folder_id = ?, title = ?, content_md = ?, updated_at = ? WHERE id = ?`)
    .run(next.folder_id, next.title, next.content_md, Date.now(), Number(id));
  return getSummary(id);
}

export function deleteSummary(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM summaries WHERE id = ?`).run(Number(id)).changes > 0;
}

// All messages for a chat within an inclusive timestamp window (ms).
// Returns chronological (oldest first). Capped at `limit` (newest by default).
// Uses idx_messages_chat_ts (chat_id, timestamp DESC) for efficient range scan.
export function listMessagesInRange(chatId, fromMs, toMs, { limit = 5000 } = {}) {
  const db = getDb();
  const from = Number(fromMs) || 0;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : Date.now();
  const safeLimit = Math.min(20000, Math.max(1, Number(limit) || 5000));
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, from, to, safeLimit);
  return rows.reverse();
}
