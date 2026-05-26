// AI-driven quality check for generated replies.
//
// Contract:
//   rateReply(text, { context?, timeoutMs? }) -> Promise<null | {
//     too_long: boolean,
//     too_formal: boolean,
//     hallucination: boolean,
//     needless_question: boolean,
//     overall_score: 0..100,
//     notes: string | null,
//   }>
//
// The AI is asked to return strict JSON. We attempt to parse it directly,
// fall back to extracting the first {...} block, and return null on any
// failure so callers can keep going without a score.

import { runAi } from './wrapper.js';
import { log } from '../events.js';

// Build a tight rating prompt and ask the AI to return JSON.
function buildRatingPrompt(text, context = '') {
  return [
    'Du bewertest eine soeben generierte WhatsApp-Antwort.',
    'Gib AUSSCHLIESSLICH ein JSON-Objekt mit diesen Feldern zurück (kein Markdown, keine Kommentare):',
    '{',
    '  "too_long": true|false,',
    '  "too_formal": true|false,',
    '  "hallucination": true|false,',
    '  "needless_question": true|false,',
    '  "overall_score": 0-100,',
    '  "notes": "ein kurzer Satz, was du auffällig findest, oder \\"ok\\""',
    '}',
    '',
    'Bewertungs-Hinweise:',
    '- too_long: > 3 Sätze ohne Grund.',
    '- too_formal: steif, Sie-Form ohne Anlass, übertrieben.',
    '- hallucination: behauptet Fakten die nicht aus dem Kontext kommen.',
    '- needless_question: stellt eine Rückfrage die nichts bringt.',
    '- overall_score: 100 = perfekt, 0 = unbrauchbar.',
    '',
    context ? '--- Kontext ---\n' + context + '\n--- /Kontext ---\n' : '',
    '--- Antwort ---',
    text,
    '--- /Antwort ---',
    '',
    'Dein JSON:',
  ].join('\n');
}

function safeJson(raw) {
  try { return JSON.parse(raw); } catch { /* fallthrough */ }
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (m) {
    try { return JSON.parse(m[0]); } catch { /* ignore */ }
  }
  return null;
}

export async function rateReply(text, { context = '', timeoutMs = 30000 } = {}) {
  if (!text || !String(text).trim()) return null;
  try {
    const raw = await runAi(buildRatingPrompt(text, context), { timeoutMs });
    const parsed = safeJson(raw);
    if (!parsed) return null;
    return {
      too_long: !!parsed.too_long,
      too_formal: !!parsed.too_formal,
      hallucination: !!parsed.hallucination,
      needless_question: !!parsed.needless_question,
      overall_score: Math.max(0, Math.min(100, Math.floor(Number(parsed.overall_score) || 0))),
      notes: typeof parsed.notes === 'string' ? parsed.notes.slice(0, 240) : null,
    };
  } catch (err) {
    log('warn', 'quality rating failed', { error: String(err) });
    return null;
  }
}
