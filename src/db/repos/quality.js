import { getDb, now } from '../index.js';

// ---------- quality scores ----------
export function insertQualityScore(score) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO quality_scores
      (message_id, chat_id, too_long, too_formal, hallucination, needless_question, overall_score, notes, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    score.message_id ?? null,
    score.chat_id,
    score.too_long ? 1 : 0,
    score.too_formal ? 1 : 0,
    score.hallucination ? 1 : 0,
    score.needless_question ? 1 : 0,
    Math.max(0, Math.min(100, Number(score.overall_score) || 0)),
    score.notes ?? null,
    now(),
  );
  return Number(info.lastInsertRowid);
}

export function listQualityScores({ chatId = null, limit = 100 } = {}) {
  const db = getDb();
  if (chatId) {
    return db.prepare(`SELECT * FROM quality_scores WHERE chat_id=? ORDER BY created_at DESC LIMIT ?`).all(chatId, limit);
  }
  return db.prepare(`SELECT * FROM quality_scores ORDER BY created_at DESC LIMIT ?`).all(limit);
}
