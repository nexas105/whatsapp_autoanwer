import { getDb, now } from '../index.js';

// ---------- media ----------
export function insertMedia({ chatId, messageId, mimeType, fileName, filePath, sizeBytes, kind, timestamp }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO media (chat_id, message_id, mime_type, file_name, file_path, size_bytes, kind, timestamp, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chatId,
    messageId,
    mimeType ?? null,
    fileName ?? null,
    filePath,
    sizeBytes ?? 0,
    kind ?? 'file',
    timestamp ?? Date.now(),
    now(),
  );
  return Number(info.lastInsertRowid);
}

export function getMedia(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM media WHERE id = ?`).get(Number(id));
}

export function listMediaForChat(chatId, { limit = 100 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM media WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, limit);
}

export function listMediaForMessage(messageId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM media WHERE message_id = ?`).all(messageId);
}
