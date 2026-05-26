import { getDb, now } from '../index.js';
import { config } from '../../config.js';

// Helpers used across the app
export const STATUS_BROADCAST_ID = 'status@broadcast';
export function isStatusChat(chatId) {
  return chatId === STATUS_BROADCAST_ID;
}

// ---------- chats ----------
export function upsertChat({ id, name, isGroup }) {
  const db = getDb();
  const t = now();
  db.prepare(`
    INSERT INTO chats (id, name, is_group, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = COALESCE(excluded.name, chats.name),
      is_group = excluded.is_group,
      updated_at = excluded.updated_at
  `).run(id, name ?? null, isGroup ? 1 : 0, t, t);
}

export function touchChat(chatId, lastMessageAt) {
  const db = getDb();
  db.prepare(`UPDATE chats SET last_message_at = ?, updated_at = ? WHERE id = ?`)
    .run(lastMessageAt, now(), chatId);
}

// Perf: eliminated N+1 sub-queries. Previous version ran 4 correlated
// sub-selects per chat (~500 sub-queries on 100 chats). We now pre-aggregate
// last_msg / media counts / 24h counts in CTEs and LEFT-JOIN once.
// Now supports pagination via { limit, offset }.
export function listChats({ limit = 50, offset = 0 } = {}) {
  const db = getDb();
  const safeLimit = Math.min(500, Math.max(1, Number(limit) || 50));
  const safeOffset = Math.max(0, Number(offset) || 0);
  return db.prepare(`
    WITH last_msg AS (
      SELECT m.chat_id,
             m.body      AS last_body,
             m.from_me   AS last_from_me,
             m.has_media AS last_has_media
      FROM messages m
      JOIN (
        SELECT chat_id, MAX(timestamp) AS t
        FROM messages
        GROUP BY chat_id
      ) lm
        ON lm.chat_id = m.chat_id
       AND lm.t       = m.timestamp
    ),
    media_counts AS (
      SELECT chat_id, COUNT(*) AS media_count
      FROM media
      GROUP BY chat_id
    ),
    msgs_24h AS (
      SELECT chat_id, COUNT(*) AS messages_24h
      FROM messages
      WHERE timestamp >= ?
      GROUP BY chat_id
    )
    SELECT c.*,
           COALESCE(cs.auto_reply, 0)              AS auto_reply,
           COALESCE(cs.reply_delay_ms, ?)          AS reply_delay_ms,
           COALESCE(cs.context_messages, ?)        AS context_messages,
           cs.persona_id                           AS persona_id,
           COALESCE(cs.style_mimic_strength, 50)   AS style_mimic_strength,
           cs.persona_prompt                       AS persona_prompt,
           lm.last_body                            AS last_body,
           lm.last_from_me                         AS last_from_me,
           lm.last_has_media                       AS last_has_media,
           COALESCE(mc.media_count, 0)             AS media_count,
           COALESCE(m24.messages_24h, 0)           AS messages_24h
    FROM chats c
    LEFT JOIN chat_settings cs ON cs.chat_id = c.id
    LEFT JOIN last_msg       lm ON lm.chat_id = c.id
    LEFT JOIN media_counts   mc ON mc.chat_id = c.id
    LEFT JOIN msgs_24h      m24 ON m24.chat_id = c.id
    ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
    LIMIT ? OFFSET ?
  `).all(
    Date.now() - 24 * 60 * 60 * 1000,
    config.defaults.replyDelayMs,
    config.defaults.contextMessages,
    safeLimit,
    safeOffset,
  );
}

export function getChat(chatId) {
  const db = getDb();
  return db.prepare(`
    SELECT c.*,
           COALESCE(cs.auto_reply, 0)               AS auto_reply,
           COALESCE(cs.reply_delay_ms, ?)           AS reply_delay_ms,
           COALESCE(cs.context_messages, ?)         AS context_messages,
           cs.persona_id                            AS persona_id,
           COALESCE(cs.style_mimic_strength, 50)    AS style_mimic_strength,
           cs.persona_prompt                        AS persona_prompt
    FROM chats c
    LEFT JOIN chat_settings cs ON cs.chat_id = c.id
    WHERE c.id = ?
  `).get(config.defaults.replyDelayMs, config.defaults.contextMessages, chatId);
}
