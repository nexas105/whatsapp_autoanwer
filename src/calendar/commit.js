// Lightweight commitment detector.
//
// After the bot sends a reply involving a date/time AND the other side replies
// with what sounds like a confirmation, this asks the AI to extract:
//
//   { is_confirmed, title, start_ts, end_ts }
//
// On success the structured object is returned (or null if not confirmed /
// extraction failed). Callers persist via repo.insertAppointment + emit the
// `appointment` bus event.

import * as repo from '../db/repo.js';
import { runAi } from '../cli/wrapper.js';
import { config } from '../config.js';
import { bus, log } from '../events.js';

// True when an AI CLI is configured (not "mock"). Skip work in mock mode.
export function aiAvailable() {
  return config.ai && config.ai.cmd && config.ai.cmd !== 'mock';
}

const CONFIRM_HINTS_RE = /\b(ja|jo|joa|jep|jepp|yes|yep|yup|ok|okay|okey|okido|alles\s+klar|passt|past|deal|gerne|gerne!|abgemacht|abmach|cool|sicher|sure|sounds\s+good|klingt\s+gut|geht\s+klar|lass\s+uns|let'?s|mach\s+ma|machen\s+wir|treffen|sehen\s+wir\s+uns)\b/i;
const DATE_TIME_HINTS_RE = /\b(uhr|am\s+\w+|um\s+\d{1,2}|\d{1,2}:\d{2}|\d{1,2}\s*uhr|morgen|übermorgen|heute|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|nächste\s+woche|kw\s*\d+|\d{1,2}\.\s*\d{1,2})\b/i;

export function looksLikeConfirmation(text) {
  if (!text) return false;
  return CONFIRM_HINTS_RE.test(String(text));
}

export function offerHasDateTime(text) {
  if (!text) return false;
  return DATE_TIME_HINTS_RE.test(String(text));
}

// Extract the first JSON object from a possibly-noisy AI response.
function extractJson(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  // Strip markdown fences.
  let stripped = s
    .replace(/^```(?:json|JSON)?\s*/, '')
    .replace(/```\s*$/, '')
    .trim();
  // Find the first balanced {...} block.
  const first = stripped.indexOf('{');
  if (first < 0) return null;
  // Greedy balanced-brace scan.
  let depth = 0;
  for (let i = first; i < stripped.length; i++) {
    const ch = stripped[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const blob = stripped.slice(first, i + 1);
        try { return JSON.parse(blob); } catch { return null; }
      }
    }
  }
  return null;
}

// Build the classification prompt. We give the AI the bot's offer + the
// contact's reply + "today" as a reference date so it can resolve relative
// expressions like "morgen" or "Freitag 18 Uhr".
function buildPrompt({ lastBotReply, lastIncoming, nowIso }) {
  return [
    'Du bist ein Termin-Extraktor. Analysiere die letzten beiden Nachrichten eines',
    'WhatsApp-Chats. Die erste ist von MIR (dem Nutzer / der KI), die zweite ist die',
    'Antwort des Gegenübers. Entscheide, ob das Gegenüber EINEN konkreten Termin',
    'bestätigt hat. Wenn ja, extrahiere Datum/Uhrzeit, Dauer und einen kurzen Titel.',
    '',
    `Aktuelles Datum/Uhrzeit (ISO, lokale Zeit Berlin/Europa): ${nowIso}`,
    '',
    '--- Meine letzte Nachricht ---',
    String(lastBotReply || '').slice(0, 1000),
    '--- /Meine ---',
    '',
    '--- Antwort des Gegenübers ---',
    String(lastIncoming || '').slice(0, 1000),
    '--- /Antwort ---',
    '',
    'Antworte AUSSCHLIESSLICH mit einem JSON-Objekt mit folgenden Feldern:',
    '{',
    '  "is_confirmed": true|false,',
    '  "title": "<kurze Beschreibung, z.B. \'Kaffee mit X\'>",',
    '  "start_ts": <unix-ms UTC>,',
    '  "end_ts":   <unix-ms UTC>',
    '}',
    'Wenn KEIN konkreter Termin bestätigt wurde (z.B. nur "ja, irgendwann mal"),',
    'gib is_confirmed:false zurück und lass start_ts/end_ts auf 0. Wenn keine',
    'Endzeit explizit erwähnt wurde, nimm Startzeit + 1 Stunde. Keine Markdown-Code-Fences,',
    'kein erklärender Text — nur das JSON-Objekt.',
  ].join('\n');
}

// Main entry. Returns the structured object on success, else null.
export async function detectCommitment({ chatId, lastBotReply, lastIncoming } = {}) {
  if (!aiAvailable()) return null;
  if (!lastBotReply || !lastIncoming) return null;

  const nowIso = new Date().toISOString();
  const prompt = buildPrompt({ lastBotReply, lastIncoming, nowIso });

  let raw;
  try {
    raw = await runAi(prompt, { model: 'haiku', timeoutMs: 30000 });
  } catch (err) {
    log('warn', 'commit detect AI call failed', { chatId, error: String(err) });
    return null;
  }

  const obj = extractJson(raw);
  if (!obj) {
    log('info', 'commit detect: AI returned no JSON', { chatId, raw: String(raw).slice(0, 200) });
    return null;
  }
  const isConfirmed = obj.is_confirmed === true;
  const startTs = Number(obj.start_ts);
  const endTs = Number(obj.end_ts);
  if (!isConfirmed) return { is_confirmed: false, title: null, start_ts: 0, end_ts: 0 };
  if (!Number.isFinite(startTs) || startTs <= 0) return null;
  const safeEnd = Number.isFinite(endTs) && endTs > startTs ? endTs : startTs + 3600 * 1000;
  const title = String(obj.title || 'Termin').trim().slice(0, 120) || 'Termin';
  return { is_confirmed: true, title, start_ts: startTs, end_ts: safeEnd };
}

// Convenience: run detectCommitment and persist if confirmed.
export async function detectAndPersist({ chatId, lastBotReply, lastIncoming, messageId = null } = {}) {
  if (!chatId) return null;
  const result = await detectCommitment({ chatId, lastBotReply, lastIncoming });
  if (!result || !result.is_confirmed) return null;
  try {
    const appointment = repo.insertAppointment({
      chatId,
      messageId,
      title: result.title,
      start_ts: result.start_ts,
      end_ts: result.end_ts,
      status: 'tentative',
    });
    bus.emit('appointment', { action: 'booked', appointment });
    log('info', 'commitment detected and booked', {
      chatId, appointmentId: appointment.id, title: result.title,
    });
    return appointment;
  } catch (err) {
    log('warn', 'failed to persist detected appointment', { chatId, error: String(err) });
    return null;
  }
}
