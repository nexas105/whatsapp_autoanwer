import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let _db = null;

export function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  _db = new DatabaseSync(config.dbPath);
  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  _db.exec(schema);
  migrate(_db);
  seedDefaultPersonas(_db);
  return _db;
}

function tableInfo(db, table) {
  return db.prepare(`PRAGMA table_info(${table})`).all();
}

function hasColumn(db, table, column) {
  return tableInfo(db, table).some((c) => c.name === column);
}

function migrate(db) {
  // Add columns introduced after v1.
  if (!hasColumn(db, 'messages', 'has_media')) {
    db.exec(`ALTER TABLE messages ADD COLUMN has_media INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'chat_settings', 'persona_id')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN persona_id TEXT`);
  }
  if (!hasColumn(db, 'chat_settings', 'style_mimic_strength')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN style_mimic_strength INTEGER NOT NULL DEFAULT 50`);
  }
  if (!hasColumn(db, 'messages', 'transcript')) {
    db.exec(`ALTER TABLE messages ADD COLUMN transcript TEXT`);
  }
  if (!hasColumn(db, 'chat_settings', 'context_search_enabled')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN context_search_enabled INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn(db, 'chat_settings', 'suggestion_mode')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN suggestion_mode INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'chat_settings', 'suggestion_count')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN suggestion_count INTEGER NOT NULL DEFAULT 1`);
  }
  if (!hasColumn(db, 'chat_settings', 'voice_reply_mode')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN voice_reply_mode TEXT NOT NULL DEFAULT 'off'`); // off|always|mirror
  }
  if (!hasColumn(db, 'messages', 'ack')) {
    db.exec(`ALTER TABLE messages ADD COLUMN ack INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'chat_settings', 'autocomplete_mode')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN autocomplete_mode TEXT NOT NULL DEFAULT 'off'`); // off|suggest|auto
  }
  if (!hasColumn(db, 'chat_settings', 'autocomplete_delay_ms')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN autocomplete_delay_ms INTEGER NOT NULL DEFAULT 8000`);
  }
  // v4
  if (!hasColumn(db, 'chat_settings', 'safety_mode')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN safety_mode TEXT NOT NULL DEFAULT 'off'`); // off|risk_aware|always_suggest|never_send
  }
  if (!hasColumn(db, 'chat_settings', 'never_to_ai')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN never_to_ai INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'chat_settings', 'mentioned_only')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN mentioned_only INTEGER NOT NULL DEFAULT 0`);
  }
  if (!hasColumn(db, 'chat_settings', 'cooldown_after_manual_ms')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN cooldown_after_manual_ms INTEGER NOT NULL DEFAULT 1800000`); // 30 min
  }
  if (!hasColumn(db, 'chat_settings', 'last_manual_reply_at')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN last_manual_reply_at INTEGER`);
  }
  if (!hasColumn(db, 'messages', 'mentioned')) {
    db.exec(`ALTER TABLE messages ADD COLUMN mentioned INTEGER NOT NULL DEFAULT 0`);
  }
  // v5: structured contact bio JSON
  if (!hasColumn(db, 'chat_settings', 'contact_bio_json')) {
    db.exec(`ALTER TABLE chat_settings ADD COLUMN contact_bio_json TEXT`);
  }
  // Seed empty user_profile row if missing
  const hasProfile = db.prepare(`SELECT 1 FROM user_profile WHERE id = 1`).get();
  if (!hasProfile) {
    db.prepare(`INSERT INTO user_profile (id, updated_at) VALUES (1, ?)`).run(Date.now());
  }
  // Backfill FTS index if it was just created (empty) but messages already exist.
  const ftsCount = db.prepare(`SELECT COUNT(*) AS n FROM messages_fts`).get().n;
  const msgCount = db.prepare(`SELECT COUNT(*) AS n FROM messages`).get().n;
  if (ftsCount === 0 && msgCount > 0) {
    db.exec(`
      INSERT INTO messages_fts(message_id, chat_id, from_me, timestamp, body, transcript)
      SELECT id, chat_id, from_me, timestamp, COALESCE(body, ''), COALESCE(transcript, '')
      FROM messages
    `);
  }
}

const BUILTIN_PERSONAS = [
  {
    id: 'casual_short',
    name: 'Locker & kurz',
    description: 'Knappe, lockere Antworten. Lower-case ok, kein Smalltalk.',
    prompt:
      'Du antwortest sehr locker und kurz. Bevorzugt Kleinschreibung. Maximal 1-2 Sätze. Keine Floskeln, kein übertriebener Smalltalk. Sprich genau so, wie ein guter Freund per WhatsApp schreiben würde.',
  },
  {
    id: 'friendly_warm',
    name: 'Freundlich & warm',
    description: 'Aufmerksam, etwas länger, emotional unterstützend.',
    prompt:
      'Du antwortest freundlich und warm. Zeige Interesse am Gegenüber, stelle gerne kurze Rückfragen. Etwas längere Antworten (2-4 Sätze) sind ok. Sprache: natürlich, herzlich, ohne übertrieben zu wirken.',
  },
  {
    id: 'professional',
    name: 'Sachlich & professionell',
    description: 'Höflich, vollständige Sätze, kein Slang.',
    prompt:
      'Du antwortest sachlich und professionell. Vollständige Sätze, korrekte Grammatik und Rechtschreibung. Höflicher Ton, aber nicht steif. Kein Slang, keine Emojis außer einem dezenten Lächeln wenn passend.',
  },
  {
    id: 'flirty_playful',
    name: 'Flirty & verspielt',
    description: 'Lockerer Flirt-Ton mit Humor und Emojis.',
    prompt:
      'Du antwortest mit einem lockeren, leicht flirty und verspielten Ton. Selbstbewusst, etwas Humor, gerne kleine Anspielungen. Emojis sind willkommen, aber sparsam. Nie aufdringlich, immer respektvoll.',
  },
  {
    id: 'dry_sarcastic',
    name: 'Trocken & sarkastisch',
    description: 'Trockener Humor, kurze pointierte Sprüche.',
    prompt:
      'Du antwortest mit trockenem Humor und einer Prise Sarkasmus. Kurz und pointiert. Nie verletzend, aber auch nicht zu nett. Gute Punchlines sind willkommen, aber bleib authentisch.',
  },
  {
    id: 'avoidant_brief',
    name: 'Vermeidend & knapp',
    description: 'Höflich aber knapp; signalisiert wenig Interesse an Vertiefung.',
    prompt:
      'Du antwortest höflich, aber sehr knapp. Maximal 1 kurzer Satz. Keine Rückfragen, kein vertiefendes Interesse zeigen. Bleibe immer freundlich, aber halte das Gespräch nicht aktiv am Laufen.',
  },
];

function seedDefaultPersonas(db) {
  const existing = db.prepare(`SELECT COUNT(*) AS n FROM personas WHERE is_builtin = 1`).get();
  if (existing && existing.n >= BUILTIN_PERSONAS.length) return;
  const now = Date.now();
  const stmt = db.prepare(`
    INSERT INTO personas (id, name, description, prompt, is_builtin, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      prompt = excluded.prompt,
      updated_at = excluded.updated_at
  `);
  for (const p of BUILTIN_PERSONAS) {
    stmt.run(p.id, p.name, p.description, p.prompt, now, now);
  }
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function now() {
  return Date.now();
}
