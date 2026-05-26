import { getDb, now } from '../index.js';
import { config } from '../../config.js';

// ---------- chat_settings ----------
function clampInt(v, min, max) {
  v = Number(v);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.floor(v)));
}

export function getSettings(chatId) {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM chat_settings WHERE chat_id = ?`).get(chatId);
  if (row) return row;
  return {
    chat_id: chatId,
    auto_reply: config.defaults.autoReply ? 1 : 0,
    reply_delay_ms: config.defaults.replyDelayMs,
    context_messages: config.defaults.contextMessages,
    persona_id: null,
    style_mimic_strength: 50,
    persona_prompt: null,
    context_search_enabled: 1,
    suggestion_mode: 0,
    suggestion_count: 1,
    voice_reply_mode: 'off',
    autocomplete_mode: 'off',
    autocomplete_delay_ms: 8000,
    safety_mode: 'off',
    never_to_ai: 0,
    mentioned_only: 0,
    cooldown_after_manual_ms: 1800000,
    last_manual_reply_at: null,
    schedule_assist_enabled: 0,
    schedule_assist_prompt: null,
    schedule_assist_template: 'free',
    updated_at: null,
  };
}

const VALID_VOICE_REPLY_MODES = new Set(['off', 'always', 'mirror']);
const VALID_SAFETY_MODES = new Set(['off', 'risk_aware', 'always_suggest', 'never_send']);

export function updateSettings(chatId, patch) {
  const db = getDb();
  const current = getSettings(chatId);
  const merged = {
    chat_id: chatId,
    auto_reply: patch.auto_reply != null ? (patch.auto_reply ? 1 : 0) : current.auto_reply,
    reply_delay_ms: patch.reply_delay_ms ?? current.reply_delay_ms,
    context_messages: patch.context_messages ?? current.context_messages,
    persona_id: patch.persona_id !== undefined ? patch.persona_id : current.persona_id,
    style_mimic_strength: patch.style_mimic_strength !== undefined
      ? clampInt(patch.style_mimic_strength, 0, 100)
      : current.style_mimic_strength,
    persona_prompt: patch.persona_prompt !== undefined ? patch.persona_prompt : current.persona_prompt,
    context_search_enabled: patch.context_search_enabled != null
      ? (patch.context_search_enabled ? 1 : 0)
      : (current.context_search_enabled ?? 1),
    suggestion_mode: patch.suggestion_mode != null
      ? (patch.suggestion_mode ? 1 : 0)
      : (current.suggestion_mode ?? 0),
    suggestion_count: patch.suggestion_count !== undefined
      ? clampInt(patch.suggestion_count, 1, 3)
      : (current.suggestion_count ?? 1),
    voice_reply_mode: patch.voice_reply_mode !== undefined
      ? (VALID_VOICE_REPLY_MODES.has(String(patch.voice_reply_mode))
          ? String(patch.voice_reply_mode)
          : (current.voice_reply_mode ?? 'off'))
      : (current.voice_reply_mode ?? 'off'),
    autocomplete_mode: patch.autocomplete_mode !== undefined
      ? patch.autocomplete_mode
      : (current.autocomplete_mode ?? 'off'),
    autocomplete_delay_ms: patch.autocomplete_delay_ms !== undefined
      ? Math.max(1000, Math.min(60000, Math.floor(Number(patch.autocomplete_delay_ms))))
      : (current.autocomplete_delay_ms ?? 8000),
    mentioned_only: patch.mentioned_only != null
      ? (patch.mentioned_only ? 1 : 0)
      : (current.mentioned_only ?? 0),
    safety_mode: patch.safety_mode !== undefined
      ? (VALID_SAFETY_MODES.has(String(patch.safety_mode))
          ? String(patch.safety_mode)
          : (current.safety_mode ?? 'off'))
      : (current.safety_mode ?? 'off'),
    never_to_ai: patch.never_to_ai != null
      ? (patch.never_to_ai ? 1 : 0)
      : (current.never_to_ai ?? 0),
    cooldown_after_manual_ms: patch.cooldown_after_manual_ms !== undefined
      ? Math.max(0, Math.min(86400000, Math.floor(Number(patch.cooldown_after_manual_ms))))
      : (current.cooldown_after_manual_ms ?? 1800000),
    last_manual_reply_at: current.last_manual_reply_at ?? null,
    schedule_assist_enabled: patch.schedule_assist_enabled != null
      ? (patch.schedule_assist_enabled ? 1 : 0)
      : (current.schedule_assist_enabled ?? 0),
    schedule_assist_prompt: patch.schedule_assist_prompt !== undefined
      ? patch.schedule_assist_prompt
      : (current.schedule_assist_prompt ?? null),
    schedule_assist_template: patch.schedule_assist_template !== undefined
      ? String(patch.schedule_assist_template)
      : (current.schedule_assist_template ?? 'free'),
    updated_at: now(),
  };
  db.prepare(`
    INSERT INTO chat_settings (chat_id, auto_reply, reply_delay_ms, context_messages, persona_id, style_mimic_strength, persona_prompt, context_search_enabled, suggestion_mode, suggestion_count, voice_reply_mode, autocomplete_mode, autocomplete_delay_ms, mentioned_only, safety_mode, never_to_ai, cooldown_after_manual_ms, last_manual_reply_at, schedule_assist_enabled, schedule_assist_prompt, schedule_assist_template, updated_at)
    VALUES (@chat_id, @auto_reply, @reply_delay_ms, @context_messages, @persona_id, @style_mimic_strength, @persona_prompt, @context_search_enabled, @suggestion_mode, @suggestion_count, @voice_reply_mode, @autocomplete_mode, @autocomplete_delay_ms, @mentioned_only, @safety_mode, @never_to_ai, @cooldown_after_manual_ms, @last_manual_reply_at, @schedule_assist_enabled, @schedule_assist_prompt, @schedule_assist_template, @updated_at)
    ON CONFLICT(chat_id) DO UPDATE SET
      auto_reply = excluded.auto_reply,
      reply_delay_ms = excluded.reply_delay_ms,
      context_messages = excluded.context_messages,
      persona_id = excluded.persona_id,
      style_mimic_strength = excluded.style_mimic_strength,
      persona_prompt = excluded.persona_prompt,
      context_search_enabled = excluded.context_search_enabled,
      suggestion_mode = excluded.suggestion_mode,
      suggestion_count = excluded.suggestion_count,
      voice_reply_mode = excluded.voice_reply_mode,
      autocomplete_mode = excluded.autocomplete_mode,
      autocomplete_delay_ms = excluded.autocomplete_delay_ms,
      mentioned_only = excluded.mentioned_only,
      safety_mode = excluded.safety_mode,
      never_to_ai = excluded.never_to_ai,
      cooldown_after_manual_ms = excluded.cooldown_after_manual_ms,
      schedule_assist_enabled = excluded.schedule_assist_enabled,
      schedule_assist_prompt = excluded.schedule_assist_prompt,
      schedule_assist_template = excluded.schedule_assist_template,
      updated_at = excluded.updated_at
  `).run(merged);
  return merged;
}

export function recordManualReply(chatId) {
  const db = getDb();
  const t = Date.now();
  const existing = db.prepare(`SELECT 1 FROM chat_settings WHERE chat_id=?`).get(chatId);
  if (!existing) {
    db.prepare(`INSERT INTO chat_settings (chat_id, last_manual_reply_at, updated_at) VALUES (?, ?, ?)`)
      .run(chatId, t, t);
  } else {
    db.prepare(`UPDATE chat_settings SET last_manual_reply_at = ?, updated_at = ? WHERE chat_id=?`)
      .run(t, t, chatId);
  }
}

// ---------- reply_queue ----------
export function enqueueReply({ chatId, triggerMsgId, fireAt }) {
  const db = getDb();
  const t = now();
  // Cancel any existing pending job for this chat
  db.prepare(`UPDATE reply_queue SET status='cancelled', updated_at=? WHERE chat_id=? AND status='pending'`)
    .run(t, chatId);
  const info = db.prepare(`
    INSERT INTO reply_queue (chat_id, trigger_msg_id, fire_at, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(chatId, triggerMsgId, fireAt, t, t);
  return Number(info.lastInsertRowid);
}

export function cancelPendingFor(chatId) {
  const db = getDb();
  const info = db.prepare(`
    UPDATE reply_queue SET status='cancelled', updated_at=?
    WHERE chat_id = ? AND status = 'pending'
  `).run(now(), chatId);
  return info.changes;
}

export function markJobSent(jobId, body) {
  const db = getDb();
  db.prepare(`UPDATE reply_queue SET status='sent', result=?, updated_at=? WHERE id=?`)
    .run(body, now(), jobId);
}

export function markJobFailed(jobId, error) {
  const db = getDb();
  db.prepare(`UPDATE reply_queue SET status='failed', result=?, updated_at=? WHERE id=?`)
    .run(String(error), now(), jobId);
}

export function getPendingJobs() {
  const db = getDb();
  return db.prepare(`SELECT * FROM reply_queue WHERE status='pending' ORDER BY fire_at ASC`).all();
}

export function listQueueForChat(chatId, { limit = 20 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM reply_queue
    WHERE chat_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(chatId, limit);
}

// ---------- analyses ----------
export function insertAnalysis({ chatId, summary, tips }) {
  const db = getDb();
  const info = db.prepare(`
    INSERT INTO analyses (chat_id, summary, tips, created_at)
    VALUES (?, ?, ?, ?)
  `).run(chatId, summary, tips ?? null, now());
  return Number(info.lastInsertRowid);
}

export function latestAnalysis(chatId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM analyses WHERE chat_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(chatId);
}
