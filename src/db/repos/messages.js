import { getDb, now } from '../index.js';
import { touchChat } from './chats.js';

// ---------- messages ----------
export function insertMessage(msg) {
  const db = getDb();
  db.prepare(`
    INSERT INTO messages (id, chat_id, from_me, author, body, type, timestamp, is_auto, has_media, mentioned, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO NOTHING
  `).run(
    msg.id,
    msg.chatId,
    msg.fromMe ? 1 : 0,
    msg.author ?? null,
    msg.body ?? null,
    msg.type ?? 'chat',
    msg.timestamp,
    msg.isAuto ? 1 : 0,
    msg.hasMedia ? 1 : 0,
    msg.mentioned ? 1 : 0,
    msg.rawJson ?? null,
  );
  touchChat(msg.chatId, msg.timestamp);
}

// ---------- stories ----------
export function listStoryItems({ limit = 60 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT m.*, md.id AS media_id, md.kind AS media_kind, md.mime_type, md.file_path
    FROM messages m
    LEFT JOIN media md ON md.message_id = m.id
    WHERE m.chat_id = 'status@broadcast'
    ORDER BY m.timestamp DESC
    LIMIT ?
  `).all(limit);
}

export function listMessages(chatId, { limit = 50 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(1000, Math.max(1, Number(limit) || 50));
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, safeLimit);
}

// Cursor-based pagination: fetch messages with timestamp < beforeTs (newest first).
// Used by the UI when the user scrolls to the top of the messages pane to load
// older history. Pairs with /api/chats/:id/messages?before_ts=<ms>.
export function listMessagesBefore(chatId, beforeTs, { limit = 50 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
  const cursor = Number(beforeTs);
  if (!Number.isFinite(cursor)) return [];
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND timestamp < ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, cursor, safeLimit);
}

export function lastMessages(chatId, n) {
  const rows = listMessages(chatId, { limit: n });
  return rows.reverse();
}

// ---------- transcripts ----------
export function setMessageTranscript(messageId, transcript) {
  const db = getDb();
  db.prepare(`UPDATE messages SET transcript = ? WHERE id = ?`)
    .run(transcript ?? null, messageId);
}

export function getMessage(messageId) {
  const db = getDb();
  return db.prepare(`SELECT * FROM messages WHERE id = ?`).get(messageId);
}

// ---------- ack (read-receipts) ----------
export function setMessageAck(messageId, ack) {
  const db = getDb();
  db.prepare(`UPDATE messages SET ack = ? WHERE id = ?`).run(Number(ack) || 0, messageId);
}

// ---------- loop detection helpers ----------
// Returns last N auto-replies from this chat (newest first).
export function lastAutoReplies(chatId, n = 3) {
  const db = getDb();
  return db.prepare(`
    SELECT id, body, transcript, timestamp FROM messages
    WHERE chat_id = ? AND from_me = 1 AND is_auto = 1
      AND body IS NOT NULL AND length(body) > 0
    ORDER BY timestamp DESC LIMIT ?
  `).all(chatId, n);
}

