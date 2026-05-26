import { getDb, now } from '../index.js';

// ---------- suggestions ----------
export function insertSuggestion({ chatId, triggerMsgId, variants }) {
  const db = getDb();
  const t = now();
  const info = db.prepare(`
    INSERT INTO suggestions (chat_id, trigger_msg_id, variants, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(chatId, triggerMsgId ?? null, JSON.stringify(variants || []), t, t);
  return getSuggestion(Number(info.lastInsertRowid));
}

export function getSuggestion(id) {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(Number(id));
  if (!r) return null;
  try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  return r;
}

export function listSuggestionsForChat(chatId, { status = 'pending', limit = 20 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM suggestions WHERE chat_id = ? AND status = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(chatId, status, limit);
  for (const r of rows) {
    try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  }
  return rows;
}

export function updateSuggestionStatus(id, { status, pickedIndex = null, sentBody = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE suggestions SET status = ?, picked_index = ?, sent_body = ?, updated_at = ?
    WHERE id = ?
  `).run(status, pickedIndex, sentBody, now(), Number(id));
  return getSuggestion(id);
}

export function updateSuggestionVariants(id, variants) {
  const db = getDb();
  db.prepare(`UPDATE suggestions SET variants = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(variants || []), now(), Number(id));
  return getSuggestion(id);
}

// Cross-chat list of all pending suggestions for the global approval-inbox.
// Joins chat name + group flag so the UI can show context per row.
export function listAllPendingSuggestions({ limit = 100 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*, c.name AS chat_name, c.is_group
    FROM suggestions s
    LEFT JOIN chats c ON c.id = s.chat_id
    WHERE s.status = 'pending'
    ORDER BY s.created_at DESC
    LIMIT ?
  `).all(limit);
  for (const r of rows) {
    try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  }
  return rows;
}
