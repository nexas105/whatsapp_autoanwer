import { getDb } from '../index.js';

// ---------- AI sessions (goal-driven autonomous dialog) ----------
const VALID_SESSION_STATUS = new Set(['active', 'paused', 'completed', 'stopped', 'failed']);

function ensureSessionEndsBeforeNewActive(chatId) {
  // Cancel any other active sessions for this chat so we never have two.
  getDb().prepare(
    `UPDATE ai_sessions SET status='stopped', ended_at=?, ended_reason='replaced' WHERE chat_id=? AND status='active'`,
  ).run(Date.now(), chatId);
}

export function startAiSession({ chatId, initialPrompt, maxTurns = 20, stopKeywords = null }) {
  if (!initialPrompt || !String(initialPrompt).trim()) throw new Error('initial_prompt required');
  const db = getDb();
  ensureSessionEndsBeforeNewActive(chatId);
  const info = db.prepare(`
    INSERT INTO ai_sessions (chat_id, initial_prompt, status, turns_count, max_turns, stop_keywords, started_at)
    VALUES (?, ?, 'active', 0, ?, ?, ?)
  `).run(
    chatId,
    String(initialPrompt).trim(),
    Math.max(1, Math.min(100, Number(maxTurns) || 20)),
    stopKeywords ?? null,
    Date.now(),
  );
  return getAiSession(Number(info.lastInsertRowid));
}

export function getAiSession(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM ai_sessions WHERE id = ?`).get(Number(id));
}

export function getActiveSessionForChat(chatId) {
  const db = getDb();
  return db.prepare(
    `SELECT * FROM ai_sessions WHERE chat_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1`,
  ).get(chatId);
}

export function listAiSessions({ chatId = null, limit = 50 } = {}) {
  const db = getDb();
  if (chatId) {
    return db.prepare(`SELECT * FROM ai_sessions WHERE chat_id=? ORDER BY id DESC LIMIT ?`).all(chatId, limit);
  }
  return db.prepare(`SELECT * FROM ai_sessions ORDER BY id DESC LIMIT ?`).all(limit);
}

export function bumpSessionTurns(id) {
  const db = getDb();
  db.prepare(`UPDATE ai_sessions SET turns_count = turns_count + 1, last_run_at = ? WHERE id = ?`)
    .run(Date.now(), Number(id));
  return getAiSession(id);
}

export function endAiSession(id, reason) {
  const status = reason === 'manual_pause' ? 'paused'
    : reason === 'manual_stop' ? 'stopped'
    : reason === 'max_turns' ? 'completed'
    : reason === 'stop_keyword' ? 'completed'
    : reason === 'ai_completed' ? 'completed'
    : reason === 'user_replied' ? 'stopped'
    : 'stopped';
  if (!VALID_SESSION_STATUS.has(status)) {/* noop — defensive */}
  const db = getDb();
  db.prepare(`UPDATE ai_sessions SET status=?, ended_at=?, ended_reason=? WHERE id=?`)
    .run(status, Date.now(), reason, Number(id));
  return getAiSession(id);
}

export function resumeAiSession(id) {
  const db = getDb();
  const s = getAiSession(id);
  if (!s) throw new Error('session not found');
  // Ensure no OTHER active session for that chat
  ensureSessionEndsBeforeNewActive(s.chat_id);
  db.prepare(`UPDATE ai_sessions SET status='active', ended_at=NULL, ended_reason=NULL WHERE id=?`)
    .run(Number(id));
  return getAiSession(id);
}
