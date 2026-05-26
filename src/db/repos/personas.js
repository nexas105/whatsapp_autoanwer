import { getDb, now } from '../index.js';

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
