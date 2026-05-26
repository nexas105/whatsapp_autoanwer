import { getDb, now } from '../index.js';

// ---------- chat memory ----------
export function listMemoryForChat(chatId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM chat_memory WHERE chat_id = ?
    ORDER BY pinned DESC, created_at DESC
  `).all(chatId);
}

export function addMemory(chatId, { note, source = 'manual', pinned = false }) {
  const db = getDb();
  if (!note || !String(note).trim()) throw new Error('note required');
  const info = db.prepare(`
    INSERT INTO chat_memory (chat_id, note, source, pinned, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(chatId, String(note).trim(), source, pinned ? 1 : 0, now());
  return db.prepare(`SELECT * FROM chat_memory WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function deleteMemory(id) {
  const db = getDb();
  const info = db.prepare(`DELETE FROM chat_memory WHERE id = ?`).run(Number(id));
  return info.changes > 0;
}

export function setMemoryPinned(id, pinned) {
  const db = getDb();
  db.prepare(`UPDATE chat_memory SET pinned = ? WHERE id = ?`).run(pinned ? 1 : 0, Number(id));
}
