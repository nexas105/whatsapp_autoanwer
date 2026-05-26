import { getDb, now } from '../index.js';

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
