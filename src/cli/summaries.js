// Summary generation: template registry + AI call that turns a slice of chat
// history into a Markdown document. Pure logic (no HTTP), used by REST handlers.
//
// Contract:
//   export const TEMPLATES: { [id]: { name, system } }
//   export async function generateSummary({
//     chatId, template?, system_prompt?, range_kind?, range_value?, title?
//   }) -> { title, template, range_kind, range_value, system_prompt, content_md,
//           message_count, chat_id }

import { runAi } from './wrapper.js';
import * as repo from '../db/repo.js';

export const TEMPLATES = {
  general: {
    name: 'Allgemeine Zusammenfassung',
    system:
      'Du fasst einen WhatsApp-Chat-Verlauf strukturiert in Markdown zusammen. '
      + 'Verwende klare Sektionen wie # Übersicht, # Wichtige Themen, # Vereinbarungen, # Offene Punkte. '
      + 'Schreib auf Deutsch.',
  },
  project_plan: {
    name: 'Projektplan',
    system:
      'Du destillierst einen Chat-Verlauf in einen klaren Projektplan in Markdown. '
      + 'Sektionen: # Projektziele, # Aufgaben (mit verantwortlichen Personen + Deadlines wenn erwähnt), '
      + '# Meilensteine, # Risiken, # Offene Fragen. Schreib auf Deutsch, präzise, ohne Floskeln.',
  },
  // Frontend uses id `software_project`; keep `software` as alias for back-compat.
  software_project: {
    name: 'Software-Projekt',
    system:
      'Du fasst einen Chat-Verlauf als technisches Software-Projekt-Dokument zusammen. '
      + 'Sektionen: # Features, # Architektur, # API/Endpoints, # Datenmodell, '
      + '# Offene technische Fragen, # Nächste Schritte. Wenn Code-Snippets im Chat sind, '
      + 'übernimm sie als Code-Blocks. Schreib auf Deutsch.',
  },
  software: {
    name: 'Software-Projekt',
    system:
      'Du fasst einen Chat-Verlauf als technisches Software-Projekt-Dokument zusammen. '
      + 'Sektionen: # Features, # Architektur, # API/Endpoints, # Datenmodell, '
      + '# Offene technische Fragen, # Nächste Schritte. Wenn Code-Snippets im Chat sind, '
      + 'übernimm sie als Code-Blocks. Schreib auf Deutsch.',
  },
  // Frontend uses id `meeting_notes`; keep `meeting` as alias for back-compat.
  meeting_notes: {
    name: 'Meeting-Notiz',
    system:
      'Du schreibst aus dem Chat-Verlauf ein Meeting-Protokoll in Markdown. '
      + 'Sektionen: # Teilnehmer, # Entscheidungen, # Action Items (wer, was, bis wann), '
      + '# Termine, # Nächstes Meeting. Schreib auf Deutsch, knapp.',
  },
  meeting: {
    name: 'Meeting-Notiz',
    system:
      'Du schreibst aus dem Chat-Verlauf ein Meeting-Protokoll in Markdown. '
      + 'Sektionen: # Teilnehmer, # Entscheidungen, # Action Items (wer, was, bis wann), '
      + '# Termine, # Nächstes Meeting. Schreib auf Deutsch, knapp.',
  },
  custom: {
    name: 'Eigener Prompt',
    system: null, // caller must pass a non-empty system_prompt.
  },
};

function fmtMessages(msgs, isGroup) {
  const lines = [];
  for (const m of msgs) {
    const body = (m.body && m.body.trim())
      || (m.transcript && `🎤 ${m.transcript}`.trim())
      || '';
    if (!body) continue;
    const t = new Date(m.timestamp).toLocaleString('de-DE', {
      dateStyle: 'short',
      timeStyle: 'short',
    });
    if (m.from_me === 1 || m.from_me === true) {
      lines.push(`[${t}] Me: ${body}`);
    } else if (isGroup && m.author) {
      lines.push(`[${t}] ${m.author}: ${body}`);
    } else {
      lines.push(`[${t}] Them: ${body}`);
    }
  }
  return lines.join('\n');
}

// Selects messages for the requested range and returns them oldest-first
// (so the AI sees the conversation in chronological order).
function selectMessages(chatId, rangeKind, rangeValue) {
  if (rangeKind === 'last_n') {
    const n = Math.max(1, Math.min(2000, Number(rangeValue) || 200));
    return repo.lastMessages(chatId, n);
  }
  // 'range' format: "<from_ms>,<to_ms>" (epoch ms) or two ISO strings.
  const [fromRaw, toRaw] = String(rangeValue || '').split(',').map((s) => (s || '').trim());
  const parse = (s) => {
    if (!s) return null;
    if (/^\d+$/.test(s)) return Number(s);
    const t = Date.parse(s);
    return Number.isFinite(t) ? t : null;
  };
  const from = parse(fromRaw) ?? 0;
  const to = parse(toRaw) ?? Date.now();
  return repo.listMessagesInRange(chatId, from, to, { limit: 5000 });
}

export async function generateSummary({
  chatId,
  template = 'general',
  system_prompt = null,
  range_kind = 'last_n',
  range_value = '200',
  title = null,
  model = 'opus',           // Summaries get the strong model — deep planning > speed.
}) {
  const chat = repo.getChat(chatId);
  if (!chat) throw new Error('chat not found');

  const tpl = TEMPLATES[template] || TEMPLATES.general;
  // For 'custom', the caller MUST supply a prompt. For other templates, prefer
  // an explicitly-passed system_prompt (the UI sends the one it has) and fall
  // back to the bundled template prompt only when nothing was provided.
  const sys = template === 'custom'
    ? (system_prompt || '').trim()
    : ((system_prompt && system_prompt.trim()) || tpl.system || '');

  if (!sys || !sys.trim()) {
    throw new Error('system_prompt required');
  }

  const messages = selectMessages(chatId, range_kind, range_value);
  if (!messages.length) throw new Error('keine Nachrichten im gewählten Bereich');
  const transcript = fmtMessages(messages, !!chat.is_group);
  if (!transcript.trim()) throw new Error('keine textbasierten Nachrichten im Bereich');

  const prompt = [
    sys.trim(),
    '',
    `Chat-Partner: ${chat.name || chat.id}${chat.is_group ? ' (Gruppe)' : ''}`,
    `Anzahl Nachrichten: ${messages.length}`,
    '',
    '--- Chatverlauf ---',
    transcript,
    '--- /Chatverlauf ---',
    '',
    'Erstelle jetzt die Markdown-Ausgabe. Antworte NUR mit dem Markdown, '
    + 'kein Vorwort, keine Code-Fences um das gesamte Dokument.',
  ].join('\n');

  const md = String(await runAi(prompt, { timeoutMs: 180000, model })).trim();
  if (!md) throw new Error('AI gab leere Antwort');

  const fallbackTitle = `${tpl.name || 'Zusammenfassung'} — ${chat.name || chat.id} — `
    + new Date().toLocaleDateString('de-DE');

  return {
    title: (title && title.trim()) || fallbackTitle,
    template,
    range_kind,
    range_value: String(range_value),
    system_prompt: sys,
    content_md: md,
    message_count: messages.length,
    chat_id: chatId,
  };
}

// Refresh OR refactor an existing summary.
// - mode 'refresh': re-generate from scratch using the SAME settings (template,
//   system_prompt, range). Replaces content_md. Use this when the chat has new
//   messages and you want a fresh take.
// - mode 'refactor': feed the existing content_md back to the AI as a base and
//   ask it to UPDATE/REFINE in place, integrating new messages but preserving
//   structure. Use this when you've already edited the summary and want to
//   keep your edits while folding in new info.
export async function regenerateSummary(summaryId, { mode = 'refresh', model = 'opus' } = {}) {
  const existing = repo.getSummary(summaryId);
  if (!existing) throw new Error('summary not found');

  if (mode === 'refresh') {
    const draft = await generateSummary({
      chatId: existing.chat_id,
      template: existing.template,
      system_prompt: existing.system_prompt,
      range_kind: existing.range_kind,
      range_value: existing.range_value,
      title: existing.title,
      model,
    });
    return repo.updateSummary(summaryId, {
      title: draft.title,
      content_md: draft.content_md,
    });
  }

  if (mode === 'refactor') {
    const chat = repo.getChat(existing.chat_id);
    if (!chat) throw new Error('chat not found');
    const messages = selectMessages(existing.chat_id, existing.range_kind, existing.range_value);
    if (!messages.length) throw new Error('keine Nachrichten im Bereich');
    const transcript = fmtMessages(messages, !!chat.is_group);

    const prompt = [
      (existing.system_prompt || '').trim(),
      '',
      `Chat-Partner: ${chat.name || chat.id}${chat.is_group ? ' (Gruppe)' : ''}`,
      `Anzahl Nachrichten: ${messages.length}`,
      '',
      'Du bekommst BESTEHENDES Markdown-Dokument und einen aktualisierten Chatverlauf.',
      'Aufgabe: das Dokument INKREMENTELL verbessern — vorhandene Struktur, Sektionen',
      'und gepflegte Inhalte respektieren, neue Erkenntnisse aus dem Verlauf integrieren,',
      'überholte Informationen aktualisieren, fehlende Punkte ergänzen.',
      'Schreibe das KOMPLETTE überarbeitete Markdown-Dokument zurück.',
      '',
      '--- Bestehendes Dokument ---',
      String(existing.content_md || ''),
      '--- /Bestehendes Dokument ---',
      '',
      '--- Aktualisierter Chatverlauf ---',
      transcript,
      '--- /Chatverlauf ---',
      '',
      'Antworte NUR mit dem überarbeiteten Markdown, kein Vorwort, keine Code-Fences ums gesamte Dokument.',
    ].join('\n');

    const md = String(await runAi(prompt, { timeoutMs: 180000, model })).trim();
    if (!md) throw new Error('AI gab leere Antwort');

    return repo.updateSummary(summaryId, { content_md: md });
  }

  throw new Error('mode must be refresh|refactor');
}
