// Chat analysis service + reply-prompt composer.
//
// Exports:
//   analyzeChat(chatId) -> { summary, tips }
//   buildReplyPrompt(chat, messages, settings?) -> string

import * as repo from '../db/repo.js';
import { runAi } from './wrapper.js';
import { bus, log } from '../events.js';
import { redactPII } from '../privacy/redact.js';

function formatTranscript(chat, messages) {
  const isGroup = !!(chat && chat.is_group);
  const lines = [];
  // PII redaction toggle — read once per call.
  let redactionEnabled = false;
  try {
    const cfg = repo.getGlobalConfig();
    redactionEnabled = !!cfg.pii_redaction_enabled;
  } catch { /* ignore */ }
  for (const m of messages) {
    // If the original body is missing but we have a whisper / vision transcript,
    // use that — prefix with 🎤 for audio, 🖼 for image, so the AI knows the source.
    let body = m && m.body != null ? String(m.body).trim() : '';
    if (!body && m && m.transcript) {
      const t = String(m.transcript).trim();
      const isImage = m.type === 'image' || m.type === 'sticker';
      body = `${isImage ? '🖼' : '🎤'} ${t}`;
    }
    if (!body) continue;
    const cleaned = redactPII(body, redactionEnabled);
    if (m.from_me === 1 || m.from_me === true) {
      lines.push(`Me: ${cleaned}`);
    } else if (isGroup && m.author) {
      lines.push(`Them (${m.author}): ${cleaned}`);
    } else {
      lines.push(`Them: ${cleaned}`);
    }
  }
  return lines.join('\n');
}

// Map style-mimic strength (0..100) to a sample size + instruction strength.
function styleConfigFor(strength) {
  const s = Math.max(0, Math.min(100, Number(strength) || 0));
  if (s === 0) return { sampleSize: 0, instruction: null };
  if (s < 25) {
    return {
      sampleSize: 5,
      instruction: 'Du kannst dich locker an meinem üblichen Schreibstil orientieren — der Persona-Ton bleibt aber führend.',
    };
  }
  if (s < 50) {
    return {
      sampleSize: 10,
      instruction: 'Schreib in einem Stil, der zu meinen sonstigen Nachrichten passt (Länge, Wortwahl, Groß-/Kleinschreibung).',
    };
  }
  if (s < 75) {
    return {
      sampleSize: 15,
      instruction: 'Halte dich klar an meinen üblichen Schreibstil: Länge, Wortwahl, Satzbau, Emoji-Häufigkeit, Groß-/Kleinschreibung. Die Persona definiert nur den Ton.',
    };
  }
  return {
    sampleSize: 20,
    instruction: 'Kopiere meinen Schreibstil so genau wie möglich: Länge, Wortwahl, typische Phrasen, Satzbau, Groß-/Kleinschreibung, Emoji-Häufigkeit, typische Tippfehler. Die Persona gibt nur die Tonrichtung vor — der Stil ist meiner.',
  };
}

function relatedContextBlock(chat, messages) {
  // Find the latest *incoming* (them) message to use as the search query.
  let queryMsg = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.from_me === 0 || m.from_me === false) {
      queryMsg = m;
      break;
    }
  }
  const queryText =
    (queryMsg && queryMsg.body && queryMsg.body.trim()) ||
    (queryMsg && queryMsg.transcript && queryMsg.transcript.trim()) ||
    '';
  if (!queryText) return null;

  const hits = repo.searchMessages(queryText, { limit: 8 })
    // Exclude messages from THIS chat — UI shows them anyway; cross-chat is the new signal.
    .filter((h) => h.chat_id !== chat?.id)
    .slice(0, 3);
  if (!hits.length) return null;

  const lines = ['--- Verwandter Kontext aus anderen Chats ---'];
  for (const h of hits) {
    const who = h.from_me === 1 ? 'Ich' : (h.chat_name || h.chat_id || 'Unbekannt');
    const when = new Date(h.timestamp).toISOString().slice(0, 10);
    const text = String(h.snippet || '').replace(/\s+/g, ' ').trim();
    lines.push(`- [${when}] ${who}: ${text}`);
  }
  lines.push('--- /Verwandter Kontext ---');
  lines.push('');
  lines.push('Wenn der Kontext zur aktuellen Frage passt, nutze ihn — sonst ignoriere ihn.');
  return lines.join('\n');
}

function memoryBlock(chat) {
  if (!chat?.id) return null;
  let notes;
  let structured;
  try {
    notes = repo.listMemoryForChat(chat.id);
    structured = repo.getContactBio(chat.id);
  } catch { return null; }

  const parts = [];
  if (structured) {
    const lines = [];
    if (structured.relationship) lines.push(`Beziehung: ${structured.relationship}`);
    if (structured.how_met) lines.push(`Kennengelernt: ${structured.how_met}`);
    if (structured.tone_pref) lines.push(`Tonalität: ${structured.tone_pref}`);
    if (Array.isArray(structured.topics) && structured.topics.length) lines.push(`Themen: ${structured.topics.join(', ')}`);
    if (Array.isArray(structured.no_gos) && structured.no_gos.length) lines.push(`NICHT ansprechen: ${structured.no_gos.join(', ')}`);
    if (lines.length) parts.push(...lines);
  }
  if (notes && notes.length) {
    for (const n of notes) parts.push(`- ${n.note}${n.pinned ? '  (wichtig)' : ''}`);
  }
  if (!parts.length) return null;
  return ['--- Was du über diese Person/Chat weißt ---', ...parts, '--- /Memory ---'].join('\n');
}

// Bundle M: persistent self-bio + daily mood + smart-injected schedule.
// bio_short is always included; mood/energy/focus when set; calendar only
// when the latest incoming message contains a date/time hint.
function selfBlock(messages) {
  let profile;
  try { profile = repo.getUserProfile(); } catch { return null; }
  if (!profile) return null;

  const parts = [];
  if (profile.bio_short && profile.bio_short.trim()) {
    parts.push(`Über mich (kurz): ${profile.bio_short.trim()}`);
  }
  // Status of the day
  const statusBits = [];
  if (profile.mood_today) statusBits.push(`Stimmung: ${profile.mood_today}`);
  if (profile.energy_today) statusBits.push(`Energie: ${profile.energy_today}`);
  if (profile.current_focus) statusBits.push(`Aktueller Fokus: ${profile.current_focus}`);
  if (statusBits.length) parts.push(`Mein Status heute: ${statusBits.join(' · ')}`);

  // Schedule: only inject when the latest incoming message hints at time/date.
  let queryText = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.from_me === 0 || m.from_me === false) {
      queryText = (m.body && m.body.trim()) || (m.transcript && m.transcript.trim()) || '';
      break;
    }
  }
  if (repo.hasDateTimeHint(queryText)) {
    try {
      const status = repo.currentScheduleStatus();
      if ((status.active && status.active.length) || (status.upcoming && status.upcoming.length)) {
        const lines = [];
        for (const e of (status.active || []).slice(0, 3)) {
          const range = e.kind === 'once'
            ? `bis ${new Date(e._end).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`
            : `${e.start_time}–${e.end_time}`;
          lines.push(`- gerade: ${e.title} (${range})${e.busy ? ' [busy]' : ''}`);
        }
        for (const e of (status.upcoming || []).slice(0, 3)) {
          const range = e.kind === 'once'
            ? new Date(e._start).toLocaleString('de-DE', { weekday: 'short', hour: '2-digit', minute: '2-digit' })
            : `${e._today ? 'heute' : 'morgen'} ${e.start_time}–${e.end_time}`;
          lines.push(`- später: ${e.title} (${range})`);
        }
        if (lines.length) parts.push('Mein Kalender:\n' + lines.join('\n'));
      }
    } catch { /* ignore */ }
  }

  if (!parts.length) return null;
  return ['--- Über mich / Mein Status ---', ...parts, '--- /Über mich ---'].join('\n');
}

function styleSampleBlock(strength) {
  const { sampleSize, instruction } = styleConfigFor(strength);
  if (sampleSize === 0) return null;
  const samples = repo.getUserStyleSample({ limit: sampleSize });
  if (!samples.length) return null;
  const lines = samples.map((s) => `- "${String(s.body).replace(/\n+/g, ' ').trim()}"`);
  return [
    '--- Mein Schreibstil (Beispielnachrichten aus früheren Chats) ---',
    ...lines,
    '--- /Mein Schreibstil ---',
    '',
    instruction,
  ].join('\n');
}

export function buildReplyPrompt(chat, messages, settingsOrPersonaPrompt) {
  // Bundle M: opportunistically expire stale mood/focus so prompts never carry
  // yesterday's "fit" into today. Silent; failures are ignored.
  try { repo.resetStaleMood(); } catch { /* ignore */ }

  // Back-compat: if a string was passed, treat it as the legacy persona_prompt freeform.
  let settings;
  if (typeof settingsOrPersonaPrompt === 'string' || settingsOrPersonaPrompt == null) {
    settings = {
      persona_prompt: settingsOrPersonaPrompt ?? null,
      persona_id: null,
      style_mimic_strength: 0,
    };
  } else {
    settings = settingsOrPersonaPrompt;
  }

  const userLabel = chat && chat.name ? chat.name : 'der Nutzer';
  const transcript = formatTranscript(chat, messages);

  // Persona base prompt
  let personaPrompt = '';
  if (settings.persona_id) {
    const p = repo.getPersona(settings.persona_id);
    if (p) personaPrompt = p.prompt;
  }

  // Custom additional instruction (free-form)
  const extra = settings.persona_prompt && String(settings.persona_prompt).trim().length > 0
    ? String(settings.persona_prompt).trim()
    : '';

  const styleBlock = styleSampleBlock(settings.style_mimic_strength);
  const contextSearchEnabled = settings.context_search_enabled !== 0;
  const relatedBlock = contextSearchEnabled ? relatedContextBlock(chat, messages) : null;
  const memBlock = memoryBlock(chat);

  const selfPart = selfBlock(messages);

  const parts = [];
  if (personaPrompt) {
    parts.push('--- Persona ---');
    parts.push(personaPrompt);
    parts.push('--- /Persona ---');
    parts.push('');
  }
  if (selfPart) { parts.push(selfPart); parts.push(''); }
  if (memBlock) {
    parts.push(memBlock);
    parts.push('');
  }
  if (styleBlock) {
    parts.push(styleBlock);
    parts.push('');
  }
  if (relatedBlock) {
    parts.push(relatedBlock);
    parts.push('');
  }
  if (extra) {
    parts.push('--- Zusätzliche Anweisung für diesen Chat ---');
    parts.push(extra);
    parts.push('--- /Zusätzliche Anweisung ---');
    parts.push('');
  }

  parts.push(`Du bist ${userLabel}. Antworte als Nutzer auf den letzten Chatverlauf.`);
  parts.push('Schreibe NUR die nächste Nachricht — kein Zitat, kein Vorwort, keine Erklärungen, keine Anführungszeichen.');
  parts.push('Behalte Sprache, Ton und Länge des Verlaufs bei.');
  parts.push('');
  parts.push('--- Verlauf ---');
  parts.push(transcript);
  parts.push('--- /Verlauf ---');
  parts.push('');
  parts.push('Deine Antwort:');
  return parts.join('\n');
}

// Build a "compose" prompt: user types an instruction (what they want to say in
// rough terms), AI produces the full message using the same persona/memory/style
// context as for auto-replies — but ANCHORED on the user's intent, not the last
// incoming message.
export function buildComposePrompt(chat, messages, settings, instruction, count = 1) {
  const userLabel = chat && chat.name ? chat.name : 'der Nutzer';
  const transcript = formatTranscript(chat, messages);
  const inst = String(instruction || '').trim();

  let personaPrompt = '';
  if (settings?.persona_id) {
    const p = repo.getPersona(settings.persona_id);
    if (p) personaPrompt = p.prompt;
  }
  const extra = settings?.persona_prompt && String(settings.persona_prompt).trim().length > 0
    ? String(settings.persona_prompt).trim()
    : '';
  const styleBlock = styleSampleBlock(settings?.style_mimic_strength);
  const memBlock = memoryBlock(chat);
  const selfPart = selfBlock(messages);

  const parts = [];
  if (personaPrompt) {
    parts.push('--- Persona ---');
    parts.push(personaPrompt);
    parts.push('--- /Persona ---');
    parts.push('');
  }
  if (selfPart) { parts.push(selfPart); parts.push(''); }
  if (memBlock) { parts.push(memBlock); parts.push(''); }
  if (styleBlock) { parts.push(styleBlock); parts.push(''); }
  if (extra) {
    parts.push('--- Zusätzliche Anweisung für diesen Chat ---');
    parts.push(extra);
    parts.push('--- /Zusätzliche Anweisung ---');
    parts.push('');
  }

  parts.push(`Du bist ${userLabel}. Du schreibst gerade eine Nachricht an den unten gezeigten Chatpartner.`);
  parts.push('');
  parts.push('--- Bisheriger Verlauf (nur als Kontext) ---');
  parts.push(transcript || '(noch keine Nachrichten)');
  parts.push('--- /Verlauf ---');
  parts.push('');
  parts.push('--- Was du sagen willst (deine Anweisung) ---');
  parts.push(inst);
  parts.push('--- /Anweisung ---');
  parts.push('');
  parts.push('Formuliere daraus eine vollständige WhatsApp-Nachricht.');
  parts.push('Schreibe NUR die Nachricht — kein Zitat, kein Vorwort, keine Erklärungen, keine Anführungszeichen.');
  parts.push('Behalte Sprache, Ton und übliche Länge dieses Chats bei.');
  if (count > 1) {
    parts.push('');
    parts.push(`Gib genau ${count} alternative Formulierungen zurück, getrennt durch eine Zeile mit ===.`);
  }
  parts.push('');
  parts.push('Deine Nachricht:');
  return parts.join('\n');
}

export async function composeFromPrompt(chatId, instruction, { count = 1 } = {}) {
  const chat = repo.getChat(chatId);
  if (!chat) throw new Error('chat not found');
  if (!instruction || !String(instruction).trim()) throw new Error('instruction required');
  const settings = repo.getSettings(chatId);
  if (settings && settings.never_to_ai === 1) {
    try { bus.emit('safety', { chatId, action: 'never_to_ai' }); } catch { /* ignore */ }
    throw new Error('chat is opted out of AI processing');
  }
  const messages = repo.lastMessages(chatId, settings.context_messages || 20);
  const n = Math.max(1, Math.min(3, Number(count) || 1));
  const prompt = buildComposePrompt(chat, messages, settings, instruction, n);
  const raw = await runAi(prompt, { timeoutMs: 90000 });
  const text = String(raw || '').trim();
  if (!text) return [];
  if (n === 1) return [text];
  // Split on lines that are exactly "==="
  const parts = text.split(/^===\s*$/m).map((s) => s.trim()).filter(Boolean);
  return (parts.length > 0 ? parts : [text]).slice(0, n);
}

function buildAnalysisPrompt(chat, messages) {
  const transcript = formatTranscript(chat, messages);
  const who = chat && chat.name ? chat.name : 'der Chat';
  const isGroup = !!(chat && chat.is_group);
  return [
    `Du bist ein hilfreicher Assistent. Analysiere den folgenden ${isGroup ? 'Gruppenchat' : 'Chat'} mit ${who}.`,
    'Antworte auf Deutsch in genau diesem Format:',
    '',
    'Zusammenfassung:',
    '<1-3 Sätze zu Stimmung, Beziehung und wiederkehrenden Themen>',
    '',
    'Tipps:',
    '- <konkreter Tipp 1>',
    '- <konkreter Tipp 2>',
    '- <... max. 5 Bullet Points>',
    '',
    "Die Tipps sollen erklären, wie man weiter antworten sollte, welche Tonalität passt, und Do's & Don'ts. Maximal 5 Bullet Points.",
    '',
    '--- Verlauf ---',
    transcript,
    '--- /Verlauf ---',
  ].join('\n');
}

function parseAnalysisResponse(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return { summary: '', tips: null };
  const re = /^[ \t]*(?:Tipps|Tips|Empfehlungen)[ \t]*:?[ \t]*$/im;
  const match = raw.match(re);
  if (!match) return { summary: raw, tips: null };
  const idx = match.index ?? 0;
  let summary = raw.slice(0, idx).trim();
  let tips = raw.slice(idx + match[0].length).trim();
  summary = summary.replace(/^[ \t]*Zusammenfassung[ \t]*:?[ \t]*\n?/i, '').trim();
  if (!tips) tips = null;
  return { summary, tips };
}

function buildMemoryExtractPrompt(chat, messages) {
  const transcript = formatTranscript(chat, messages);
  const who = chat && chat.name ? chat.name : 'der Chat';
  const isGroup = !!(chat && chat.is_group);
  return [
    `Extrahiere aus dem folgenden ${isGroup ? 'Gruppenchat' : 'Chat'} mit ${who} bis zu 5 dauerhafte Fakten`,
    'über die Person bzw. den Chat (z.B. "Wohnt in Berlin", "mag Klettern", "arbeitet als Lehrerin",',
    '"hat einen Hund namens Bello"). Nur Fakten, die längerfristig relevant bleiben — keine Stimmungen,',
    'keine Tagesereignisse, keine Vermutungen.',
    '',
    'Antworte ausschließlich als Liste, ein Fakt pro Zeile, jeweils mit "- " als Präfix.',
    'Wenn nichts Verwertbares im Chat steht, gib eine leere Antwort.',
    '',
    '--- Verlauf ---',
    transcript,
    '--- /Verlauf ---',
  ].join('\n');
}

function parseMemoryFacts(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  const out = [];
  for (const lineRaw of lines) {
    let line = String(lineRaw).trim();
    if (!line) continue;
    // Strip common bullet prefixes
    line = line.replace(/^[-•*]\s+/, '').trim();
    // Strip leading numbering like "1." or "1)"
    line = line.replace(/^\d+[.)]\s+/, '').trim();
    if (!line) continue;
    // Reject obvious section headers
    if (/^(zusammenfassung|tipps?|fakten|memory)[:\s]/i.test(line)) continue;
    if (line.length < 4) continue;
    out.push(line);
  }
  return out;
}

async function extractAndStoreMemoryFacts(chat, messages) {
  try {
    const prompt = buildMemoryExtractPrompt(chat, messages);
    const raw = await runAi(prompt, { timeoutMs: 90000 });
    const facts = parseMemoryFacts(raw);
    if (!facts.length) return 0;

    const existing = (repo.listMemoryForChat(chat.id) || []).map((n) => String(n.note || '').toLowerCase().trim());
    const seen = new Set(existing);
    let added = 0;
    for (const fact of facts) {
      if (added >= 5) break;
      const key = fact.toLowerCase().trim();
      if (!key || seen.has(key)) continue;
      seen.add(key);
      try {
        repo.addMemory(chat.id, { note: fact, source: 'analysis', pinned: false });
        added++;
      } catch (err) {
        log('warn', 'addMemory failed', { chatId: chat.id, error: String(err) });
      }
    }
    if (added > 0) {
      bus.emit('memory_added', { chatId: chat.id, count: added });
    }
    return added;
  } catch (err) {
    log('warn', 'memory extraction failed', { chatId: chat?.id, error: String(err) });
    return 0;
  }
}

export async function analyzeChat(chatId) {
  const chat = repo.getChat(chatId);
  if (!chat) throw new Error('chat not found');
  const settings = repo.getSettings(chatId);
  if (settings && settings.never_to_ai === 1) {
    try { bus.emit('safety', { chatId, action: 'never_to_ai' }); } catch { /* ignore */ }
    throw new Error('chat is opted out of AI processing');
  }
  const recent = repo.listMessages(chatId, { limit: 200 });
  const messages = recent.slice().reverse();
  const prompt = buildAnalysisPrompt(chat, messages);
  let raw;
  try {
    raw = await runAi(prompt, { timeoutMs: 120000 });
  } catch (err) {
    log('error', 'analyzeChat ai call failed', { chatId, error: String(err) });
    throw err;
  }
  const { summary, tips } = parseAnalysisResponse(raw);
  repo.insertAnalysis({ chatId, summary, tips });
  const analysis = { summary, tips };
  bus.emit('analysis', { chatId, analysis });

  // Best-effort: extract durable facts about the person/chat. Never block.
  extractAndStoreMemoryFacts(chat, messages).catch((err) => {
    log('warn', 'memory extraction errored', { chatId, error: String(err) });
  });

  return analysis;
}
