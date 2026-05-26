import { getDb } from '../index.js';
import { getChat } from './chats.js';
import { listMemoryForChat } from './memory.js';
import { latestAnalysis } from './settings.js';

// ---------- stats ----------
export function getDashboardStats() {
  const db = getDb();
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  return {
    chats_total: db.prepare(`SELECT COUNT(*) AS n FROM chats`).get().n,
    chats_auto: db.prepare(`SELECT COUNT(*) AS n FROM chat_settings WHERE auto_reply = 1`).get().n,
    chats_with_persona: db.prepare(`SELECT COUNT(*) AS n FROM chat_settings WHERE persona_id IS NOT NULL`).get().n,
    messages_total: db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n,
    messages_24h: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE timestamp >= ?`).get(dayAgo).n,
    auto_replies_total: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_auto = 1`).get().n,
    auto_replies_24h: db.prepare(`SELECT COUNT(*) AS n FROM messages WHERE is_auto = 1 AND timestamp >= ?`).get(dayAgo).n,
    pending_queue: db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status = 'pending'`).get().n,
    media_total: db.prepare(`SELECT COUNT(*) AS n FROM media`).get().n,
    analyses_total: db.prepare(`SELECT COUNT(*) AS n FROM analyses`).get().n,
  };
}

// ---------- charts ----------
// Returns last `hours` 1-hour buckets, oldest first, each
// { hour: 'HH', n: <count> } where HH is the bucket's end-hour
// (24h clock, UTC). Counts messages by their stored timestamp (ms).
export function messagesPerHour(hours = 24) {
  const db = getDb();
  const cur = Date.now();
  const buckets = [];
  for (let i = hours - 1; i >= 0; i--) {
    const start = cur - (i + 1) * 3600_000;
    const end = cur - i * 3600_000;
    const n = db.prepare(
      `SELECT COUNT(*) AS n FROM messages WHERE timestamp >= ? AND timestamp < ?`
    ).get(start, end).n;
    buckets.push({
      hour: new Date(end - 1).toISOString().slice(11, 13),
      n,
    });
  }
  return buckets;
}

// Number of chats currently mapped to each persona, ordered by usage desc.
export function personaUsageStats() {
  const db = getDb();
  return db.prepare(`
    SELECT p.id, p.name, p.is_builtin, COUNT(cs.chat_id) AS chats
    FROM personas p
    LEFT JOIN chat_settings cs ON cs.persona_id = p.id
    GROUP BY p.id ORDER BY chats DESC, p.name COLLATE NOCASE ASC
  `).all();
}

// Aggregate counts over reply_queue used to render the success-ratio donut.
export function autoReplySuccessRatio() {
  const db = getDb();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue`).get().n;
  const sent = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='sent'`).get().n;
  const failed = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='failed'`).get().n;
  const cancelled = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='cancelled'`).get().n;
  return { total, sent, failed, cancelled };
}

// Average response time (ms) between a reply_queue row's created_at and
// updated_at, restricted to 'sent' rows in the last N hours. Returns 0
// when no rows match.
export function avgResponseTimeMs({ hours = 24 } = {}) {
  const db = getDb();
  const since = Date.now() - hours * 3600_000;
  const row = db.prepare(`
    SELECT AVG(updated_at - created_at) AS avg_ms FROM reply_queue
    WHERE status='sent' AND updated_at >= ?
  `).get(since);
  return Math.round(row?.avg_ms || 0);
}

// Top chats by message count in the last N days, joined with the chat name.
export function topChatsByActivity({ days = 7, limit = 5 } = {}) {
  const db = getDb();
  const since = Date.now() - days * 86400_000;
  return db.prepare(`
    SELECT m.chat_id   AS chat_id,
           COALESCE(c.name, m.chat_id) AS name,
           c.is_group  AS is_group,
           COUNT(*)    AS n
    FROM messages m
    LEFT JOIN chats c ON c.id = m.chat_id
    WHERE m.timestamp >= ?
      AND m.chat_id <> 'status@broadcast'
    GROUP BY m.chat_id
    ORDER BY n DESC
    LIMIT ?
  `).all(since, limit);
}

// Auto-reply funnel metrics + average response time for the last N hours.
export function autoReplyMetrics({ hours = 24 } = {}) {
  const db = getDb();
  const since = Date.now() - hours * 3600_000;
  const triggered = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE created_at >= ?`).get(since).n;
  const sent      = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='sent'      AND updated_at >= ?`).get(since).n;
  const failed    = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='failed'    AND updated_at >= ?`).get(since).n;
  const cancelled = db.prepare(`SELECT COUNT(*) AS n FROM reply_queue WHERE status='cancelled' AND updated_at >= ?`).get(since).n;
  const response_rate = triggered ? sent / triggered : 0;
  // Avg duration ms (created -> updated) for sent rows
  const avg = db.prepare(`
    SELECT AVG(updated_at - created_at) AS avg_ms FROM reply_queue
    WHERE status='sent' AND updated_at >= ?
  `).get(since).avg_ms;
  return { triggered, sent, failed, cancelled, response_rate, avg_response_ms: Math.round(avg || 0) };
}

// Rough estimate of time the user saved by letting the AI reply.
// Counts auto-sent messages in the last N hours and multiplies by an
// assumed 30 seconds typical reply-effort per message.
export function timeSavedEstimate({ hours = 24 } = {}) {
  const db = getDb();
  const since = Date.now() - hours * 3600_000;
  const row = db.prepare(`
    SELECT COUNT(*) AS n FROM messages
    WHERE is_auto = 1 AND timestamp >= ?
  `).get(since);
  const count = row?.n || 0;
  return { count, seconds_saved: count * 30 };
}

// Compact "contact profile" payload for the right-sidebar card.
// Combines: chat row, message stats, pinned + recent memory notes, latest analysis.
export function getContactProfile(chatId) {
  const chat = getChat(chatId);
  if (!chat) return null;
  const db = getDb();
  const stats = db.prepare(`
    SELECT COUNT(*) AS messages_total,
           MAX(timestamp) AS last_message_at,
           SUM(CASE WHEN from_me = 0 THEN 1 ELSE 0 END) AS messages_from_them,
           SUM(CASE WHEN from_me = 1 THEN 1 ELSE 0 END) AS messages_from_me
    FROM messages WHERE chat_id = ?
  `).get(chatId);
  const memory = listMemoryForChat(chatId);
  return {
    chat,
    stats,
    memory_pinned: memory.filter((m) => m.pinned).slice(0, 3),
    memory_other: memory.filter((m) => !m.pinned).slice(0, 5),
    analysis: latestAnalysis(chatId) || null,
  };
}
