import { getDb } from '../index.js';

// ---------- bio_suggestions ----------
export function listBioSuggestions({ status = 'pending', target = null, limit = 100 } = {}) {
  const db = getDb();
  if (target) {
    return db.prepare(`SELECT * FROM bio_suggestions WHERE status=? AND target=? ORDER BY created_at DESC LIMIT ?`)
      .all(status, target, limit);
  }
  return db.prepare(`SELECT * FROM bio_suggestions WHERE status=? ORDER BY created_at DESC LIMIT ?`)
    .all(status, limit);
}

export function insertBioSuggestion({ target, chatId, note, evidence }) {
  if (!['user', 'chat'].includes(target)) throw new Error('target must be user|chat');
  if (!note || !String(note).trim()) throw new Error('note required');
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO bio_suggestions (target, chat_id, note, evidence, status, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?)
  `).run(target, chatId ?? null, String(note).trim(), evidence ?? null, Date.now());
  return db.prepare(`SELECT * FROM bio_suggestions WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function resolveBioSuggestion(id, status) {
  if (!['accepted', 'dismissed'].includes(status)) throw new Error('status must be accepted|dismissed');
  const db = getDb();
  db.prepare(`UPDATE bio_suggestions SET status=?, resolved_at=? WHERE id=?`).run(status, Date.now(), Number(id));
  return db.prepare(`SELECT * FROM bio_suggestions WHERE id=?`).get(Number(id));
}

// ---------- structured contact bio (JSON on chat_settings) ----------
export function getContactBio(chatId) {
  const db = getDb();
  const row = db.prepare(`SELECT contact_bio_json FROM chat_settings WHERE chat_id = ?`).get(chatId);
  if (!row || !row.contact_bio_json) return null;
  try { return JSON.parse(row.contact_bio_json); } catch { return null; }
}

export function setContactBio(chatId, bio) {
  const db = getDb();
  const json = bio ? JSON.stringify(bio) : null;
  const existing = db.prepare(`SELECT 1 FROM chat_settings WHERE chat_id=?`).get(chatId);
  if (!existing) {
    db.prepare(`INSERT INTO chat_settings (chat_id, contact_bio_json, updated_at) VALUES (?, ?, ?)`)
      .run(chatId, json, Date.now());
  } else {
    db.prepare(`UPDATE chat_settings SET contact_bio_json=?, updated_at=? WHERE chat_id=?`)
      .run(json, Date.now(), chatId);
  }
  return bio;
}
