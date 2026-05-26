import { runAi } from '../cli/wrapper.js';
import * as repo from '../db/repo.js';
import { bus, log } from '../events.js';

// Build a tight extraction prompt that returns JSON.
function buildExtractPrompt(target, name, transcript) {
  if (target === 'user') {
    return [
      'Lies den folgenden Chatverlauf und sammle PERSÖNLICHE FAKTEN über den Nutzer (der "Me" schreibt).',
      'Beispiele: "wohnt in Berlin", "arbeitet als Lehrer", "hat einen Bruder Max", "mag Klettern".',
      'Antworte als JSON-Array mit max. 5 Einträgen, ohne Markdown, ohne Kommentare:',
      '[{"note":"…","evidence":"<kurzes Zitat>"}, …]',
      'Wenn nichts neues drinsteht, gib [] zurück.',
      '',
      '--- Verlauf ---',
      transcript,
      '--- /Verlauf ---',
      '',
      'JSON:',
    ].join('\n');
  }
  return [
    `Lies den folgenden Chatverlauf mit ${name || 'Chat-Partner'} und sammle FAKTEN über die andere Person ("Them"-Zeilen).`,
    'Beispiele: "wohnt in Hamburg", "arbeitet im Krankenhaus", "Bruder Tim", "mag Reisen".',
    'Antworte als JSON-Array mit max. 5 Einträgen, ohne Markdown:',
    '[{"note":"…","evidence":"<kurzes Zitat>"}, …]',
    'Wenn nichts neues drinsteht, gib [] zurück.',
    '',
    '--- Verlauf ---',
    transcript,
    '--- /Verlauf ---',
    '',
    'JSON:',
  ].join('\n');
}

function safeJsonArray(raw) {
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : null; } catch {}
  const m = String(raw || '').match(/\[[\s\S]*\]/);
  if (m) { try { const v = JSON.parse(m[0]); return Array.isArray(v) ? v : null; } catch {} }
  return null;
}

function formatTranscriptFor(messages, isGroup = false) {
  const lines = [];
  for (const m of messages) {
    const body = (m.body && m.body.trim()) || (m.transcript && m.transcript.trim()) || '';
    if (!body) continue;
    if (m.from_me === 1 || m.from_me === true) lines.push(`Me: ${body}`);
    else if (isGroup && m.author) lines.push(`Them (${m.author}): ${body}`);
    else lines.push(`Them: ${body}`);
  }
  return lines.join('\n');
}

// Run on a single chat. Skips chats with never_to_ai = 1.
// Inserts pending bio_suggestions for any new facts (dedup against existing
// notes / user bio_full).
export async function extractForChat(chatId, { messageLimit = 80 } = {}) {
  const settings = repo.getSettings(chatId);
  if (settings.never_to_ai === 1) return { added: 0, skipped: true };
  const chat = repo.getChat(chatId);
  if (!chat) return { added: 0 };
  const recent = repo.listMessages(chatId, { limit: messageLimit }).reverse();
  if (recent.length < 4) return { added: 0 };
  const transcript = formatTranscriptFor(recent, !!chat.is_group);
  if (!transcript) return { added: 0 };

  // --- chat target ---
  let added = 0;
  try {
    const raw = await runAi(buildExtractPrompt('chat', chat.name, transcript), { timeoutMs: 60000 });
    const arr = safeJsonArray(raw) || [];
    const existingNotes = (repo.listMemoryForChat(chatId) || []).map((n) => n.note.toLowerCase());
    const existingSugs = (repo.listBioSuggestions({ status: 'pending', target: 'chat' }) || [])
      .filter((s) => s.chat_id === chatId).map((s) => s.note.toLowerCase());
    for (const e of arr.slice(0, 5)) {
      const note = String(e?.note || '').trim();
      if (!note) continue;
      const k = note.toLowerCase();
      if (existingNotes.includes(k)) continue;
      if (existingSugs.includes(k)) continue;
      repo.insertBioSuggestion({ target: 'chat', chatId, note, evidence: e?.evidence ?? null });
      added++;
    }
  } catch (err) {
    log('warn', 'bio extract chat failed', { chatId, error: String(err) });
  }

  // --- user target (only sometimes; reduces noise) ---
  // Run user-target extraction every 10th invocation across chats. We keep a kv counter.
  try {
    const cur = Number(repo.kvGet('bio_extract_counter') || 0) + 1;
    repo.kvSet('bio_extract_counter', String(cur));
    if (cur % 10 === 0) {
      const raw = await runAi(buildExtractPrompt('user', null, transcript), { timeoutMs: 60000 });
      const arr = safeJsonArray(raw) || [];
      const profile = repo.getUserProfile();
      const existingFull = (profile.bio_full || '').toLowerCase();
      const existingSugs = (repo.listBioSuggestions({ status: 'pending', target: 'user' }) || [])
        .map((s) => s.note.toLowerCase());
      for (const e of arr.slice(0, 3)) {
        const note = String(e?.note || '').trim();
        if (!note) continue;
        const k = note.toLowerCase();
        if (existingFull.includes(k)) continue;
        if (existingSugs.includes(k)) continue;
        repo.insertBioSuggestion({ target: 'user', chatId: null, note, evidence: e?.evidence ?? null });
        added++;
      }
    }
  } catch (err) {
    log('warn', 'bio extract user failed', { error: String(err) });
  }

  if (added > 0) bus.emit('bio_suggestion', { action: 'created', count: added, chatId });
  return { added };
}

// Top-level scheduler: run extraction across all active chats periodically.
export function startBioExtractor() {
  let timer = null;
  let inFlight = false;

  async function tick() {
    if (inFlight) return;
    inFlight = true;
    try {
      // Only chats with auto_reply or suggestion_mode on; sort by most recent activity
      const chats = repo.listChats({ limit: 200 })
        .filter((c) => (c.auto_reply === 1 || c.suggestion_mode === 1) && c.id !== 'status@broadcast')
        .slice(0, 10);
      for (const c of chats) {
        await extractForChat(c.id).catch(() => {});
      }
    } finally {
      inFlight = false;
    }
  }

  // First run after 2 min, then every hour.
  timer = setTimeout(() => { tick(); timer = setInterval(tick, 60 * 60 * 1000); }, 2 * 60 * 1000);
  return { stop() { if (timer) { clearInterval(timer); clearTimeout(timer); } } };
}
