import { getDb, now } from './index.js';
import { config } from '../config.js';

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

export function listChats({ limit = 100 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT c.*,
           COALESCE(cs.auto_reply, 0)                                    AS auto_reply,
           COALESCE(cs.reply_delay_ms, ?)                                AS reply_delay_ms,
           COALESCE(cs.context_messages, ?)                              AS context_messages,
           cs.persona_id                                                 AS persona_id,
           COALESCE(cs.style_mimic_strength, 50)                         AS style_mimic_strength,
           cs.persona_prompt                                             AS persona_prompt,
           (SELECT body FROM messages m WHERE m.chat_id = c.id
             ORDER BY m.timestamp DESC LIMIT 1)                          AS last_body,
           (SELECT from_me FROM messages m WHERE m.chat_id = c.id
             ORDER BY m.timestamp DESC LIMIT 1)                          AS last_from_me,
           (SELECT has_media FROM messages m WHERE m.chat_id = c.id
             ORDER BY m.timestamp DESC LIMIT 1)                          AS last_has_media,
           (SELECT COUNT(*) FROM media md WHERE md.chat_id = c.id)       AS media_count,
           (SELECT COUNT(*) FROM messages m WHERE m.chat_id = c.id
             AND m.timestamp >= ?)                                       AS messages_24h
    FROM chats c
    LEFT JOIN chat_settings cs ON cs.chat_id = c.id
    ORDER BY COALESCE(c.last_message_at, c.updated_at) DESC
    LIMIT ?
  `).all(
    config.defaults.replyDelayMs,
    config.defaults.contextMessages,
    Date.now() - 24 * 60 * 60 * 1000,
    limit,
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
  return db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, limit);
}

export function lastMessages(chatId, n) {
  const rows = listMessages(chatId, { limit: n });
  return rows.reverse();
}

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
    updated_at: null,
  };
}

// Helpers used across the app
export const STATUS_BROADCAST_ID = 'status@broadcast';
export function isStatusChat(chatId) {
  return chatId === STATUS_BROADCAST_ID;
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
    updated_at: now(),
  };
  db.prepare(`
    INSERT INTO chat_settings (chat_id, auto_reply, reply_delay_ms, context_messages, persona_id, style_mimic_strength, persona_prompt, context_search_enabled, suggestion_mode, suggestion_count, voice_reply_mode, autocomplete_mode, autocomplete_delay_ms, mentioned_only, safety_mode, never_to_ai, cooldown_after_manual_ms, last_manual_reply_at, updated_at)
    VALUES (@chat_id, @auto_reply, @reply_delay_ms, @context_messages, @persona_id, @style_mimic_strength, @persona_prompt, @context_search_enabled, @suggestion_mode, @suggestion_count, @voice_reply_mode, @autocomplete_mode, @autocomplete_delay_ms, @mentioned_only, @safety_mode, @never_to_ai, @cooldown_after_manual_ms, @last_manual_reply_at, @updated_at)
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
      updated_at = excluded.updated_at
  `).run(merged);
  return merged;
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

// ---------- personas ----------
export function listPersonas() {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM personas
    ORDER BY is_builtin DESC, name COLLATE NOCASE ASC
  `).all();
}

export function getPersona(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM personas WHERE id = ?`).get(id);
}

function slugify(name) {
  return String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40) || `persona_${Date.now()}`;
}

export function createPersona({ name, description, prompt }) {
  const db = getDb();
  if (!name || !prompt) throw new Error('name and prompt are required');
  let id = `user_${slugify(name)}`;
  // Disambiguate collisions
  let suffix = 1;
  while (db.prepare(`SELECT 1 FROM personas WHERE id = ?`).get(id)) {
    id = `user_${slugify(name)}_${++suffix}`;
  }
  const t = now();
  db.prepare(`
    INSERT INTO personas (id, name, description, prompt, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, 0, ?, ?)
  `).run(id, name, description ?? null, prompt, t, t);
  return getPersona(id);
}

export function updatePersona(id, patch) {
  const db = getDb();
  const current = getPersona(id);
  if (!current) throw new Error('persona not found');
  if (current.is_builtin) throw new Error('built-in personas cannot be edited');
  const next = {
    name: patch.name ?? current.name,
    description: patch.description !== undefined ? patch.description : current.description,
    prompt: patch.prompt ?? current.prompt,
    updated_at: now(),
  };
  db.prepare(`
    UPDATE personas SET name = ?, description = ?, prompt = ?, updated_at = ?
    WHERE id = ?
  `).run(next.name, next.description, next.prompt, next.updated_at, id);
  return getPersona(id);
}

export function deletePersona(id) {
  const db = getDb();
  const current = getPersona(id);
  if (!current) return false;
  if (current.is_builtin) throw new Error('built-in personas cannot be deleted');
  db.prepare(`DELETE FROM personas WHERE id = ?`).run(id);
  return true;
}

// Sample of the user's own writing across all chats — used for style-mimic.
export function getUserStyleSample({ limit = 30, minLen = 3, maxLen = 240 } = {}) {
  const db = getDb();
  return db.prepare(`
    SELECT body, chat_id, timestamp FROM messages
    WHERE from_me = 1
      AND is_auto = 0
      AND body IS NOT NULL
      AND length(body) BETWEEN ? AND ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(minLen, maxLen, limit);
}

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

// ---------- triggers ----------
const ALLOWED_MATCH_MODES = new Set(['substring', 'word', 'exact', 'regex']);
const ALLOWED_ACTION_TYPES = new Set(['reply', 'prompt', 'skip']);

function normaliseTriggerPatch(patch, current) {
  const next = {
    name: patch.name !== undefined ? patch.name : (current?.name ?? null),
    pattern: patch.pattern !== undefined ? patch.pattern : current?.pattern,
    match_mode: patch.match_mode ?? current?.match_mode ?? 'substring',
    case_sensitive: patch.case_sensitive != null
      ? (patch.case_sensitive ? 1 : 0)
      : (current?.case_sensitive ?? 0),
    action_type: patch.action_type ?? current?.action_type ?? 'reply',
    action_value: patch.action_value !== undefined ? patch.action_value : (current?.action_value ?? null),
    delay_override_ms: patch.delay_override_ms !== undefined
      ? (patch.delay_override_ms == null ? null : Math.max(0, Number(patch.delay_override_ms)))
      : (current?.delay_override_ms ?? null),
    priority: patch.priority != null
      ? Math.floor(Number(patch.priority))
      : (current?.priority ?? 0),
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : (current?.enabled ?? 1),
  };
  if (!next.pattern) throw new Error('pattern is required');
  if (!ALLOWED_MATCH_MODES.has(next.match_mode)) throw new Error('invalid match_mode');
  if (!ALLOWED_ACTION_TYPES.has(next.action_type)) throw new Error('invalid action_type');
  if (next.action_type === 'reply' && !next.action_value) {
    throw new Error('action_value required for reply action');
  }
  if (next.match_mode === 'regex') {
    try { new RegExp(next.pattern, next.case_sensitive ? '' : 'i'); }
    catch { throw new Error('invalid regex pattern'); }
  }
  return next;
}

export function listTriggers(chatId) {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM triggers WHERE chat_id = ?
    ORDER BY priority DESC, id ASC
  `).all(chatId);
}

export function getTrigger(chatId, id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM triggers WHERE chat_id = ? AND id = ?`).get(chatId, Number(id));
}

export function createTrigger(chatId, patch) {
  const db = getDb();
  const n = normaliseTriggerPatch(patch, null);
  const t = now();
  const info = db.prepare(`
    INSERT INTO triggers
      (chat_id, name, pattern, match_mode, case_sensitive, action_type, action_value, delay_override_ms, priority, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    chatId, n.name, n.pattern, n.match_mode, n.case_sensitive,
    n.action_type, n.action_value, n.delay_override_ms, n.priority, n.enabled, t, t,
  );
  return getTrigger(chatId, Number(info.lastInsertRowid));
}

export function updateTrigger(chatId, id, patch) {
  const db = getDb();
  const current = getTrigger(chatId, id);
  if (!current) throw new Error('trigger not found');
  const n = normaliseTriggerPatch(patch, current);
  db.prepare(`
    UPDATE triggers SET
      name = ?, pattern = ?, match_mode = ?, case_sensitive = ?,
      action_type = ?, action_value = ?, delay_override_ms = ?,
      priority = ?, enabled = ?, updated_at = ?
    WHERE chat_id = ? AND id = ?
  `).run(
    n.name, n.pattern, n.match_mode, n.case_sensitive,
    n.action_type, n.action_value, n.delay_override_ms,
    n.priority, n.enabled, now(),
    chatId, Number(id),
  );
  return getTrigger(chatId, id);
}

export function deleteTrigger(chatId, id) {
  const db = getDb();
  const info = db.prepare(`DELETE FROM triggers WHERE chat_id = ? AND id = ?`)
    .run(chatId, Number(id));
  return info.changes > 0;
}

// ---------- suggestions ----------
export function insertSuggestion({ chatId, triggerMsgId, variants }) {
  const db = getDb();
  const t = now();
  const info = db.prepare(`
    INSERT INTO suggestions (chat_id, trigger_msg_id, variants, status, created_at, updated_at)
    VALUES (?, ?, ?, 'pending', ?, ?)
  `).run(chatId, triggerMsgId ?? null, JSON.stringify(variants || []), t, t);
  return getSuggestion(Number(info.lastInsertRowid));
}

export function getSuggestion(id) {
  const db = getDb();
  const r = db.prepare(`SELECT * FROM suggestions WHERE id = ?`).get(Number(id));
  if (!r) return null;
  try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  return r;
}

export function listSuggestionsForChat(chatId, { status = 'pending', limit = 20 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT * FROM suggestions WHERE chat_id = ? AND status = ?
    ORDER BY created_at DESC LIMIT ?
  `).all(chatId, status, limit);
  for (const r of rows) {
    try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  }
  return rows;
}

export function updateSuggestionStatus(id, { status, pickedIndex = null, sentBody = null }) {
  const db = getDb();
  db.prepare(`
    UPDATE suggestions SET status = ?, picked_index = ?, sent_body = ?, updated_at = ?
    WHERE id = ?
  `).run(status, pickedIndex, sentBody, now(), Number(id));
  return getSuggestion(id);
}

export function updateSuggestionVariants(id, variants) {
  const db = getDb();
  db.prepare(`UPDATE suggestions SET variants = ?, updated_at = ? WHERE id = ?`)
    .run(JSON.stringify(variants || []), now(), Number(id));
  return getSuggestion(id);
}

// Cross-chat list of all pending suggestions for the global approval-inbox.
// Joins chat name + group flag so the UI can show context per row.
export function listAllPendingSuggestions({ limit = 100 } = {}) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT s.*, c.name AS chat_name, c.is_group
    FROM suggestions s
    LEFT JOIN chats c ON c.id = s.chat_id
    WHERE s.status = 'pending'
    ORDER BY s.created_at DESC
    LIMIT ?
  `).all(limit);
  for (const r of rows) {
    try { r.variants = JSON.parse(r.variants || '[]'); } catch { r.variants = []; }
  }
  return rows;
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

// ---------- scheduled messages ----------
export function listScheduledMessages({ enabledOnly = false } = {}) {
  const db = getDb();
  const sql = enabledOnly
    ? `SELECT * FROM scheduled_messages WHERE enabled = 1 ORDER BY id ASC`
    : `SELECT * FROM scheduled_messages ORDER BY id ASC`;
  return db.prepare(sql).all();
}

export function getScheduledMessage(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM scheduled_messages WHERE id = ?`).get(Number(id));
}

export function insertScheduledMessage(patch) {
  const db = getDb();
  if (!patch.name || !patch.schedule_spec || !patch.prompt) {
    throw new Error('name, schedule_spec, prompt required');
  }
  const t = now();
  const info = db.prepare(`
    INSERT INTO scheduled_messages
      (chat_id, name, schedule_kind, schedule_spec, prompt, mode, target_filter, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    patch.chat_id ?? null,
    patch.name,
    patch.schedule_kind || 'cron',
    patch.schedule_spec,
    patch.prompt,
    patch.mode || 'ai',
    patch.target_filter ? JSON.stringify(patch.target_filter) : null,
    patch.enabled === false ? 0 : 1,
    t, t,
  );
  return getScheduledMessage(Number(info.lastInsertRowid));
}

export function updateScheduledMessage(id, patch) {
  const db = getDb();
  const c = getScheduledMessage(id);
  if (!c) throw new Error('schedule not found');
  const next = {
    chat_id: patch.chat_id !== undefined ? patch.chat_id : c.chat_id,
    name: patch.name ?? c.name,
    schedule_kind: patch.schedule_kind ?? c.schedule_kind,
    schedule_spec: patch.schedule_spec ?? c.schedule_spec,
    prompt: patch.prompt ?? c.prompt,
    mode: patch.mode ?? c.mode,
    target_filter: patch.target_filter !== undefined
      ? (patch.target_filter ? JSON.stringify(patch.target_filter) : null)
      : c.target_filter,
    enabled: patch.enabled != null ? (patch.enabled ? 1 : 0) : c.enabled,
    next_run_at: patch.next_run_at !== undefined ? patch.next_run_at : c.next_run_at,
    last_run_at: patch.last_run_at !== undefined ? patch.last_run_at : c.last_run_at,
    last_result: patch.last_result !== undefined ? patch.last_result : c.last_result,
  };
  db.prepare(`
    UPDATE scheduled_messages SET
      chat_id=?, name=?, schedule_kind=?, schedule_spec=?, prompt=?, mode=?,
      target_filter=?, enabled=?, next_run_at=?, last_run_at=?, last_result=?, updated_at=?
    WHERE id=?
  `).run(
    next.chat_id, next.name, next.schedule_kind, next.schedule_spec, next.prompt, next.mode,
    next.target_filter, next.enabled, next.next_run_at, next.last_run_at, next.last_result,
    now(), Number(id),
  );
  return getScheduledMessage(id);
}

export function deleteScheduledMessage(id) {
  const db = getDb();
  const info = db.prepare(`DELETE FROM scheduled_messages WHERE id = ?`).run(Number(id));
  return info.changes > 0;
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

// Returns the highest-priority enabled trigger matching `text`, or null.
export function findMatchingTrigger(chatId, text) {
  if (!text) return null;
  const triggers = listTriggers(chatId).filter((t) => t.enabled);
  const subj = String(text);
  for (const t of triggers) {
    const flags = t.case_sensitive ? '' : 'i';
    const subjCmp = t.case_sensitive ? subj : subj.toLowerCase();
    const patCmp = t.case_sensitive ? t.pattern : String(t.pattern).toLowerCase();
    let hit = false;
    if (t.match_mode === 'substring') {
      hit = subjCmp.includes(patCmp);
    } else if (t.match_mode === 'exact') {
      hit = subjCmp.trim() === patCmp.trim();
    } else if (t.match_mode === 'word') {
      try {
        const re = new RegExp(`\\b${patCmp.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, flags);
        hit = re.test(subj);
      } catch { hit = false; }
    } else if (t.match_mode === 'regex') {
      try { hit = new RegExp(t.pattern, flags).test(subj); } catch { hit = false; }
    }
    if (hit) return t;
  }
  return null;
}

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

// ---------- user_profile ----------
export function getUserProfile() {
  const db = getDb();
  return db.prepare(`SELECT * FROM user_profile WHERE id = 1`).get() || {
    id: 1, name: null, bio_short: null, bio_full: null,
    mood_today: null, energy_today: null, current_focus: null,
    mood_set_at: null, updated_at: null,
  };
}

export function updateUserProfile(patch) {
  const db = getDb();
  const cur = getUserProfile();
  const moodFieldChanged = patch.mood_today !== undefined
    || patch.energy_today !== undefined
    || patch.current_focus !== undefined;
  const next = {
    name: patch.name !== undefined ? patch.name : cur.name,
    bio_short: patch.bio_short !== undefined ? patch.bio_short : cur.bio_short,
    bio_full: patch.bio_full !== undefined ? patch.bio_full : cur.bio_full,
    mood_today: patch.mood_today !== undefined ? patch.mood_today : cur.mood_today,
    energy_today: patch.energy_today !== undefined ? patch.energy_today : cur.energy_today,
    current_focus: patch.current_focus !== undefined ? patch.current_focus : cur.current_focus,
    mood_set_at: moodFieldChanged ? Date.now() : cur.mood_set_at,
    updated_at: Date.now(),
  };
  db.prepare(`
    UPDATE user_profile SET name=?, bio_short=?, bio_full=?, mood_today=?, energy_today=?,
      current_focus=?, mood_set_at=?, updated_at=?
    WHERE id = 1
  `).run(next.name, next.bio_short, next.bio_full, next.mood_today, next.energy_today,
         next.current_focus, next.mood_set_at, next.updated_at);
  return getUserProfile();
}

// Reset stale mood/energy/focus after >18h.
export function resetStaleMood({ maxAgeMs = 18 * 3600 * 1000 } = {}) {
  const db = getDb();
  const p = getUserProfile();
  if (!p.mood_set_at) return false;
  if (Date.now() - p.mood_set_at < maxAgeMs) return false;
  db.prepare(`UPDATE user_profile SET mood_today=NULL, energy_today=NULL, current_focus=NULL, mood_set_at=NULL, updated_at=? WHERE id=1`)
    .run(Date.now());
  return true;
}

// ---------- user_schedule ----------
const VALID_SCHEDULE_KIND = new Set(['once', 'recurring']);
const VALID_RECURRENCE_TOKENS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'DAILY']);

function validateScheduleEntry(p) {
  if (!p.title || !String(p.title).trim()) throw new Error('title required');
  const kind = p.kind || 'once';
  if (!VALID_SCHEDULE_KIND.has(kind)) throw new Error('invalid kind');
  if (kind === 'once') {
    if (!p.start_ts) throw new Error('start_ts required for once');
  } else {
    if (!p.start_time || !/^\d{1,2}:\d{2}$/.test(p.start_time)) throw new Error('start_time HH:MM required');
    if (!p.end_time || !/^\d{1,2}:\d{2}$/.test(p.end_time)) throw new Error('end_time HH:MM required');
    if (!p.recurrence) throw new Error('recurrence required');
    const tokens = String(p.recurrence).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tokens.length || !tokens.every((t) => VALID_RECURRENCE_TOKENS.has(t))) {
      throw new Error('recurrence must be comma list of MON,TUE,...,SUN or DAILY');
    }
  }
}

export function listSchedule({ enabledOnly = false } = {}) {
  const db = getDb();
  const sql = enabledOnly
    ? `SELECT * FROM user_schedule WHERE enabled = 1 ORDER BY kind ASC, id ASC`
    : `SELECT * FROM user_schedule ORDER BY id ASC`;
  return db.prepare(sql).all();
}

export function getScheduleEntry(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM user_schedule WHERE id = ?`).get(Number(id));
}

export function insertScheduleEntry(p) {
  validateScheduleEntry(p);
  const db = getDb();
  const t = Date.now();
  const info = db.prepare(`
    INSERT INTO user_schedule (kind, title, notes, start_ts, end_ts, start_time, end_time, recurrence, busy, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.kind || 'once',
    p.title.trim(),
    p.notes ?? null,
    p.start_ts ?? null,
    p.end_ts ?? null,
    p.start_time ?? null,
    p.end_time ?? null,
    p.recurrence ?? null,
    p.busy === false ? 0 : 1,
    p.enabled === false ? 0 : 1,
    t, t,
  );
  return getScheduleEntry(Number(info.lastInsertRowid));
}

export function updateScheduleEntry(id, p) {
  const db = getDb();
  const cur = getScheduleEntry(id);
  if (!cur) throw new Error('schedule entry not found');
  const merged = {
    kind: p.kind ?? cur.kind,
    title: p.title !== undefined ? p.title : cur.title,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    start_ts: p.start_ts !== undefined ? p.start_ts : cur.start_ts,
    end_ts: p.end_ts !== undefined ? p.end_ts : cur.end_ts,
    start_time: p.start_time !== undefined ? p.start_time : cur.start_time,
    end_time: p.end_time !== undefined ? p.end_time : cur.end_time,
    recurrence: p.recurrence !== undefined ? p.recurrence : cur.recurrence,
    busy: p.busy != null ? (p.busy ? 1 : 0) : cur.busy,
    enabled: p.enabled != null ? (p.enabled ? 1 : 0) : cur.enabled,
  };
  validateScheduleEntry(merged);
  db.prepare(`
    UPDATE user_schedule SET kind=?, title=?, notes=?, start_ts=?, end_ts=?, start_time=?, end_time=?, recurrence=?, busy=?, enabled=?, updated_at=?
    WHERE id=?
  `).run(
    merged.kind, merged.title, merged.notes, merged.start_ts, merged.end_ts,
    merged.start_time, merged.end_time, merged.recurrence, merged.busy, merged.enabled,
    Date.now(), Number(id),
  );
  return getScheduleEntry(id);
}

export function deleteScheduleEntry(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM user_schedule WHERE id = ?`).run(Number(id)).changes > 0;
}

const WEEKDAY_NUM = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Returns currently active + upcoming-within-window schedule entries.
export function currentScheduleStatus({ now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const all = listSchedule({ enabledOnly: true });
  const d = new Date(now);
  const todayDow = WEEKDAY_NUM[d.getDay()];
  const tomorrowDow = WEEKDAY_NUM[(d.getDay() + 1) % 7];
  const minutesNow = d.getHours() * 60 + d.getMinutes();
  function parseHHMM(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  const active = [];
  const upcoming = [];
  for (const e of all) {
    if (e.kind === 'once') {
      if (!e.start_ts) continue;
      const start = e.start_ts;
      const end = e.end_ts || (start + 3600 * 1000);
      if (now >= start && now < end) active.push({ ...e, _start: start, _end: end });
      else if (start > now && start - now <= windowMs) upcoming.push({ ...e, _start: start, _end: end });
    } else {
      const tokens = String(e.recurrence || '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      const startMin = parseHHMM(e.start_time);
      const endMin = parseHHMM(e.end_time);
      if (startMin == null || endMin == null) continue;
      const todayMatches = tokens.includes('DAILY') || tokens.includes(todayDow);
      const tomorrowMatches = tokens.includes('DAILY') || tokens.includes(tomorrowDow);
      if (todayMatches) {
        if (minutesNow >= startMin && minutesNow < endMin) {
          active.push({ ...e, _today: true, _startMin: startMin, _endMin: endMin });
        } else if (startMin > minutesNow) {
          upcoming.push({ ...e, _today: true, _startMin: startMin, _endMin: endMin });
        }
      }
      if (!todayMatches && tomorrowMatches) {
        const tomorrowStart = new Date(d);
        tomorrowStart.setDate(d.getDate() + 1);
        tomorrowStart.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
        if (tomorrowStart.getTime() - now <= windowMs) {
          upcoming.push({ ...e, _today: false, _startMin: startMin, _endMin: endMin });
        }
      }
    }
  }
  return { active, upcoming, now, todayDow };
}

// Date/time keyword detector — used to decide whether to inject schedule context.
const DATE_TIME_HINTS = /\b(wann|treffen|treff|datum|termin|morgen|übermorgen|heute|jetzt|später|gleich|abend|nachmittag|vormittag|woche|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|\d{1,2}\s*uhr|\d{1,2}:\d{2}|\d{1,2}\.\s*\d{1,2})\b/i;
export function hasDateTimeHint(text) {
  if (!text) return false;
  return DATE_TIME_HINTS.test(String(text));
}

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

// ---------- kv ----------
export function kvGet(key) {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM kv WHERE key=?`).get(key);
  return row?.value ?? null;
}

export function kvSet(key, value) {
  const db = getDb();
  db.prepare(`
    INSERT INTO kv (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value
  `).run(key, value);
}

// ---------- global config ----------
export function getGlobalConfig() {
  const raw = kvGet('global_config');
  const defaults = {
    quiet_hours_enabled: true,
    quiet_hours_start: '22:00',
    quiet_hours_end: '08:00',
    quiet_hours_allow_suggestions: true,
    pii_redaction_enabled: true,
  };
  if (!raw) return defaults;
  try { return { ...defaults, ...JSON.parse(raw) }; } catch { return defaults; }
}

export function setGlobalConfig(patch) {
  const cur = getGlobalConfig();
  const next = { ...cur, ...(patch || {}) };
  kvSet('global_config', JSON.stringify(next));
  return next;
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

// ---------- summary folders ----------
export function listSummaryFolders() {
  const db = getDb();
  return db.prepare(`SELECT * FROM summary_folders ORDER BY created_at DESC`).all();
}

export function createSummaryFolder(name) {
  if (!name || !String(name).trim()) throw new Error('name required');
  const db = getDb();
  const info = db.prepare(`INSERT INTO summary_folders (name, created_at) VALUES (?, ?)`)
    .run(String(name).trim(), Date.now());
  return db.prepare(`SELECT * FROM summary_folders WHERE id = ?`).get(Number(info.lastInsertRowid));
}

export function deleteSummaryFolder(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM summary_folders WHERE id = ?`).run(Number(id)).changes > 0;
}

// ---------- summaries ----------
export function listSummaries({ folderId = null, limit = 200 } = {}) {
  const db = getDb();
  if (
    folderId === null
    || folderId === undefined
    || folderId === ''
    || folderId === 'null'
  ) {
    return db.prepare(`SELECT * FROM summaries ORDER BY created_at DESC LIMIT ?`).all(Number(limit) || 200);
  }
  return db.prepare(`SELECT * FROM summaries WHERE folder_id = ? ORDER BY created_at DESC LIMIT ?`)
    .all(Number(folderId), Number(limit) || 200);
}

export function getSummary(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM summaries WHERE id = ?`).get(Number(id));
}

export function insertSummary(s) {
  const db = getDb();
  const t = Date.now();
  const info = db.prepare(`
    INSERT INTO summaries (
      folder_id, chat_id, title, template, range_kind, range_value,
      system_prompt, content_md, message_count, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    s.folder_id ?? null,
    s.chat_id ?? null,
    s.title,
    s.template || 'general',
    s.range_kind || 'last_n',
    String(s.range_value || ''),
    s.system_prompt ?? null,
    s.content_md,
    Number(s.message_count) || 0,
    t,
    t,
  );
  return getSummary(Number(info.lastInsertRowid));
}

export function updateSummary(id, patch) {
  const db = getDb();
  const cur = getSummary(id);
  if (!cur) throw new Error('summary not found');
  const next = {
    folder_id: patch.folder_id !== undefined ? patch.folder_id : cur.folder_id,
    title: patch.title !== undefined ? patch.title : cur.title,
    content_md: patch.content_md !== undefined ? patch.content_md : cur.content_md,
  };
  db.prepare(`UPDATE summaries SET folder_id = ?, title = ?, content_md = ?, updated_at = ? WHERE id = ?`)
    .run(next.folder_id, next.title, next.content_md, Date.now(), Number(id));
  return getSummary(id);
}

export function deleteSummary(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM summaries WHERE id = ?`).run(Number(id)).changes > 0;
}

// All messages for a chat within an inclusive timestamp window (ms).
// Returns chronological (oldest first). Capped at `limit` (newest by default).
export function listMessagesInRange(chatId, fromMs, toMs, { limit = 5000 } = {}) {
  const db = getDb();
  const from = Number(fromMs) || 0;
  const to = Number.isFinite(Number(toMs)) ? Number(toMs) : Date.now();
  const rows = db.prepare(`
    SELECT * FROM messages
    WHERE chat_id = ? AND timestamp >= ? AND timestamp <= ?
    ORDER BY timestamp DESC
    LIMIT ?
  `).all(chatId, from, to, Number(limit) || 5000);
  return rows.reverse();
}
