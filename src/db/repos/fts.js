import { getDb } from '../index.js';

// ---------- full-text search ----------
// FTS5 query escaper: wrap each token in quotes so users can type free text
// without worrying about FTS operators like AND/OR/NEAR/parentheses.
function sanitizeFtsQuery(raw) {
  const tokens = String(raw || '')
    .toLowerCase()
    .replace(/["'`]/g, ' ')
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 2);
  if (!tokens.length) return null;
  return tokens.map((t) => `"${t}"*`).join(' OR ');
}

function makeSnippet(body, transcript) {
  const text = body && body.trim() ? body : (transcript ? `🎤 ${transcript}` : '');
  return text.length > 200 ? text.slice(0, 200) + '…' : text;
}

export function searchMessages(query, { chatId = null, limit = 30, fromMe = null } = {}) {
  const ftsQ = sanitizeFtsQuery(query);
  if (!ftsQ) return [];
  const db = getDb();
  const wheres = [`messages_fts MATCH ?`];
  const params = [ftsQ];
  if (chatId) {
    wheres.push(`messages_fts.chat_id = ?`);
    params.push(chatId);
  }
  if (fromMe === true || fromMe === 1) {
    wheres.push(`messages_fts.from_me = 1`);
  } else if (fromMe === false || fromMe === 0) {
    wheres.push(`messages_fts.from_me = 0`);
  }
  params.push(Number(limit) || 30);
  const rows = db.prepare(`
    SELECT
      m.id          AS id,
      m.chat_id     AS chat_id,
      m.from_me     AS from_me,
      m.body        AS body,
      m.transcript  AS transcript,
      m.timestamp   AS timestamp,
      m.has_media   AS has_media,
      c.name        AS chat_name,
      c.is_group    AS is_group,
      bm25(messages_fts) AS score
    FROM messages_fts
    JOIN messages m ON m.id = messages_fts.message_id
    LEFT JOIN chats c ON c.id = m.chat_id
    WHERE ${wheres.join(' AND ')}
    ORDER BY score ASC, m.timestamp DESC
    LIMIT ?
  `).all(...params);
  return rows.map((r) => ({ ...r, snippet: makeSnippet(r.body, r.transcript) }));
}
