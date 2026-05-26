// Auto-reply engine.
//
// Contract:
//   export function startEngine({ wa }) -> { onIncoming, onUserSelfReply, status }

import fs from 'node:fs';
import path from 'node:path';

import * as repo from '../db/repo.js';
import { getDb } from '../db/index.js';
import { runAi } from '../cli/wrapper.js';
import { buildReplyPrompt } from '../cli/analysis.js';
import { rateReply } from '../cli/quality.js';
import { synthesizeOpus } from '../voice/tts.js';
import { config } from '../config.js';
import { bus, log } from '../events.js';
import { classifyRisk, decideSafety } from './safety.js';

// Decide whether the auto-reply for this chat should be sent as a voice note.
function decideVoiceMode(chatId, settings) {
  const mode = String(settings?.voice_reply_mode ?? 'off');
  if (mode === 'off') return false;
  if (mode === 'always') return true;
  if (mode === 'mirror') {
    try {
      const recent = repo.lastMessages(chatId, 5) || [];
      for (let i = recent.length - 1; i >= 0; i--) {
        const m = recent[i];
        if (m.from_me === 1 || m.from_me === true) continue;
        // Direct hint via WhatsApp message type
        if (m.type === 'ptt' || m.type === 'audio') return true;
        // Fallback: inspect media kind for this message
        if (m.has_media) {
          try {
            const mediaRows = repo.listMediaForMessage(m.id) || [];
            for (const md of mediaRows) {
              if (md.kind === 'audio') return true;
            }
          } catch { /* ignore */ }
        }
        // We only inspect the most recent incoming message.
        return false;
      }
    } catch (err) {
      log('warn', 'voice mirror check failed', { chatId, error: String(err) });
    }
    return false;
  }
  return false;
}

async function sendReplyMaybeVoice(wa, chatId, text, { isAuto = true } = {}) {
  const settings = repo.getSettings(chatId);
  const wantsVoice = decideVoiceMode(chatId, settings);
  if (!wantsVoice) {
    return wa.sendMessage(chatId, text, { isAuto });
  }
  try {
    const out = path.join(config.root, 'data', 'media', 'tts', `reply-${Date.now()}.ogg`);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    await synthesizeOpus(text, out);
    return await wa.sendMessage(chatId, text, { isAuto, mediaPath: out, mediaCaption: '' });
  } catch (err) {
    log('error', 'voice reply synth failed — falling back to text', { chatId, error: String(err) });
    return wa.sendMessage(chatId, text, { isAuto });
  }
}

// ─── Loop detection helpers ─────────────────────────────────────────
function jaccard(a, b) {
  const tok = (s) => new Set(String(s || '').toLowerCase().match(/[a-zäöüß]{3,}/gi) || []);
  const A = tok(a);
  const B = tok(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

function isLooped(text, recent) {
  for (const r of recent || []) {
    if (jaccard(text, r.body) > 0.55) return true;
  }
  return false;
}

// Split multi-variant AI output on lines that contain exactly "===".
function splitVariants(raw, expected) {
  const parts = String(raw || '')
    .split(/^===\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  // If the AI didn't honor the separator, fall back to one variant.
  return parts.slice(0, expected);
}

export function startEngine({ wa }) {
  // chatId -> { timer, jobId }
  const pending = new Map();

  // On startup, clear any leftover pending jobs in the DB — their timers were lost.
  try {
    getDb()
      .prepare("UPDATE reply_queue SET status='cancelled', updated_at=? WHERE status='pending'")
      .run(Date.now());
  } catch (err) {
    log('warn', 'failed to clear leftover pending jobs at startup', { error: String(err) });
  }

  function clearTimerFor(chatId) {
    const existing = pending.get(chatId);
    if (existing) {
      try { clearTimeout(existing.timer); } catch { /* ignore */ }
      pending.delete(chatId);
    }
  }

  async function fire(chatId, jobId, jobMeta = null) {
    try {
      // ─── Trigger path: fixed reply, no AI ─────────────────────────────
      if (jobMeta?.kind === 'trigger_reply') {
        const text = String(jobMeta.text || '').trim();
        if (!text) {
          repo.markJobFailed(jobId, 'trigger reply empty');
          bus.emit('queue', { chatId, jobId, status: 'failed', error: 'trigger reply empty' });
          return;
        }
        try { await wa.sendTyping(chatId, Math.min(3000, Math.max(800, text.length * 30))); } catch { /* ignore */ }
        await sendReplyMaybeVoice(wa, chatId, text, { isAuto: true });
        repo.markJobSent(jobId, text);
        bus.emit('reply_sent', { chatId, jobId, body: text, via: 'trigger' });
        bus.emit('queue', { chatId, jobId, status: 'sent', via: 'trigger' });
        bus.emit('trigger', { chatId, triggerId: jobMeta.triggerId, action: 'reply', body: text });
        return;
      }

      // ─── Trigger path: AI with prompt override ────────────────────────
      if (jobMeta?.kind === 'trigger_prompt') {
        const chat = repo.getChat(chatId);
        const settings = repo.getSettings(chatId);
        const messages = repo.lastMessages(chatId, settings.context_messages || 20);
        // The trigger's prompt overrides the chat persona_prompt field for this run.
        const overlay = { ...settings, persona_prompt: jobMeta.prompt };
        const prompt = buildReplyPrompt(chat, messages, overlay);
        const reply = await runAi(prompt);
        if (!reply || !String(reply).trim()) {
          repo.markJobFailed(jobId, 'empty reply');
          bus.emit('queue', { chatId, jobId, status: 'failed', error: 'empty reply' });
          return;
        }
        const text = String(reply).trim();
        try { await wa.sendTyping(chatId, Math.min(3000, Math.max(800, text.length * 30))); } catch { /* ignore */ }
        await sendReplyMaybeVoice(wa, chatId, text, { isAuto: true });
        repo.markJobSent(jobId, text);
        bus.emit('reply_sent', { chatId, jobId, body: text, via: 'trigger_prompt' });
        bus.emit('queue', { chatId, jobId, status: 'sent', via: 'trigger_prompt' });
        bus.emit('trigger', { chatId, triggerId: jobMeta.triggerId, action: 'prompt', body: text });
        return;
      }

      // ─── AI-Session path: goal-driven autonomous dialog ──────────────
      if (jobMeta?.kind === 'ai_session') {
        const session = repo.getAiSession(jobMeta.sessionId);
        if (!session || session.status !== 'active') {
          repo.markJobSent(jobId, '[session inactive]');
          bus.emit('queue', { chatId, jobId, status: 'sent', via: 'session' });
          return;
        }
        const sessChat = repo.getChat(chatId);
        const sessSettings = repo.getSettings(chatId);
        const sessMessages = repo.lastMessages(chatId, sessSettings.context_messages || 20);
        // Build the normal prompt and append the session goal at the end.
        const base = buildReplyPrompt(sessChat, sessMessages, sessSettings);
        const goalBlock = [
          '',
          '--- Ziel dieser AI-Session ---',
          String(session.initial_prompt || '').trim(),
          `(Versuch ${session.turns_count + 1} von ${session.max_turns}.)`,
          '--- /Ziel ---',
          '',
          'Wenn das Ziel offensichtlich erreicht ist (z.B. eine Zusage, ein konkreter Termin), beende mit dem Wort: DONE',
          'Sonst antworte ganz normal weiter Richtung Ziel.',
          '',
          'Deine Nachricht:',
        ].join('\n');
        // Strip the original "Deine Antwort:" footer and append our own.
        const sessPrompt = base.replace(/Deine Antwort:\s*$/m, '').trimEnd() + '\n' + goalBlock;

        let sessReply = '';
        try {
          sessReply = String(await runAi(sessPrompt)).trim();
        } catch (err) {
          repo.markJobFailed(jobId, String(err));
          bus.emit('queue', { chatId, jobId, status: 'failed', error: String(err), via: 'session' });
          log('error', 'ai-session AI call failed', { chatId, sessionId: session.id, err: String(err) });
          return;
        }

        if (/^DONE$/i.test(sessReply.trim())) {
          repo.endAiSession(session.id, 'ai_completed');
          bus.emit('ai_session', { chatId, action: 'ended', session: repo.getAiSession(session.id) });
          repo.markJobSent(jobId, '[session done]');
          bus.emit('queue', { chatId, jobId, status: 'sent', via: 'session' });
          log('info', 'ai-session completed (AI signalled DONE)', { chatId, sessionId: session.id });
          return;
        }
        if (!sessReply) {
          repo.markJobFailed(jobId, 'empty session reply');
          bus.emit('queue', { chatId, jobId, status: 'failed', via: 'session' });
          return;
        }

        try { await wa.sendTyping?.(chatId, Math.min(3000, Math.max(800, sessReply.length * 30))); } catch { /* ignore */ }
        await wa.sendMessage(chatId, sessReply, { isAuto: true });
        repo.markJobSent(jobId, sessReply);
        repo.bumpSessionTurns(session.id);
        const updatedSess = repo.getAiSession(session.id);
        bus.emit('reply_sent', { chatId, jobId, body: sessReply, via: 'session' });
        bus.emit('queue', { chatId, jobId, status: 'sent', via: 'session' });
        bus.emit('ai_session', { chatId, action: 'turn', session: updatedSess });

        // Auto-end if max turns hit AFTER this send.
        if (updatedSess && updatedSess.turns_count >= updatedSess.max_turns) {
          repo.endAiSession(session.id, 'max_turns');
          bus.emit('ai_session', { chatId, action: 'ended', session: repo.getAiSession(session.id) });
          log('info', 'ai-session ended by max_turns after send', { chatId, sessionId: session.id });
        }
        return;
      }

      // ─── Normal auto-reply path ───────────────────────────────────────
      const settings = repo.getSettings(chatId);
      const forcedSuggest = jobMeta?.forced_suggest === true;
      if (!forcedSuggest && settings.auto_reply !== 1 && settings.suggestion_mode !== 1) {
        repo.cancelPendingFor(chatId);
        bus.emit('queue', { chatId, jobId, status: 'cancelled', reason: 'auto_reply_off' });
        return;
      }

      const chat = repo.getChat(chatId);
      const messages = repo.lastMessages(chatId, settings.context_messages);
      const prompt = buildReplyPrompt(chat, messages, settings);
      const recent = repo.lastAutoReplies(chatId, 3);

      // ─── Suggestion-Mode branch ──────────────────────────────────────
      // Also entered when safety downgrades a normal send to a suggestion.
      if (settings.suggestion_mode === 1 || forcedSuggest) {
        const count = Math.max(1, Math.min(3, Number(settings.suggestion_count) || 1));
        let variants = [];

        async function generateVariants(extra = '') {
          const fullPrompt = count > 1
            ? `${prompt}${extra}\n\nGib genau ${count} alternative Antwortvarianten zurück. Trenne sie mit der Zeile ===.`
            : `${prompt}${extra}`;
          const raw = await runAi(fullPrompt);
          if (!raw || !String(raw).trim()) return [];
          if (count === 1) return [String(raw).trim()];
          const parts = splitVariants(raw, count);
          // Fallback: if AI didn't honor separator, treat whole reply as 1 variant.
          return parts.length > 0 ? parts : [String(raw).trim()];
        }

        try {
          variants = await generateVariants();
        } catch (err) {
          repo.markJobFailed(jobId, String(err));
          bus.emit('queue', { chatId, jobId, status: 'failed', error: String(err) });
          log('error', 'suggestion generation failed', { chatId, err: String(err) });
          return;
        }

        // Loop-detect: if any variant looks like a recent auto-reply, retry once with variation hint.
        if (variants.length && recent.length) {
          const looped = variants.some((v) => isLooped(v, recent));
          if (looped) {
            try {
              const retry = await generateVariants(
                '\n\nWICHTIG: Wiederhole dich nicht. Schlage etwas Neues vor oder wechsle das Thema.',
              );
              if (retry.length) {
                variants = retry;
                // If retry variants STILL look looped, append a topic-change hint as an extra variant.
                const stillLooped = variants.some((v) => isLooped(v, recent));
                if (stillLooped && variants.length < 3) {
                  variants.push('Vielleicht Themenwechsel: Was machst du heute Abend so?');
                }
              }
            } catch (err) {
              log('warn', 'suggestion retry failed', { chatId, err: String(err) });
            }
          }
        }

        variants = variants.map((v) => String(v).trim()).filter(Boolean);
        if (!variants.length) {
          repo.markJobFailed(jobId, 'empty suggestion');
          bus.emit('queue', { chatId, jobId, status: 'failed', error: 'empty suggestion' });
          log('error', 'auto-reply suggestion produced no variants', { chatId, jobId });
          return;
        }

        const suggestion = repo.insertSuggestion({
          chatId,
          triggerMsgId: jobMeta?.triggerMsgId ?? null,
          variants,
        });
        bus.emit('suggestion', { chatId, suggestion });
        repo.markJobSent(jobId, '[suggestion-queued]');
        bus.emit('queue', { chatId, jobId, status: 'sent', via: 'suggestion' });
        log('info', 'suggestion queued', { chatId, suggestionId: suggestion.id, count: variants.length });
        return;
      }

      // ─── Auto-send path (suggestion_mode = 0) ───────────────────────
      let reply = await runAi(prompt);
      if (!reply || !String(reply).trim()) {
        repo.markJobFailed(jobId, 'empty reply');
        bus.emit('queue', { chatId, jobId, status: 'failed', error: 'empty reply' });
        log('error', 'auto-reply produced empty reply', { chatId, jobId });
        return;
      }

      // Loop-detect: retry once with variation hint if the reply looks looped.
      if (isLooped(reply, recent)) {
        log('info', 'auto-reply looped — retrying with variation hint', { chatId, jobId });
        try {
          const retry = await runAi(
            `${prompt}\n\nWICHTIG: Wiederhole dich nicht. Schlage etwas Neues vor oder wechsle das Thema.`,
          );
          if (retry && String(retry).trim()) reply = retry;
        } catch (err) {
          log('warn', 'auto-reply variation retry failed', { chatId, err: String(err) });
        }
      }

      const text = String(reply).trim();

      // ─── Quality check (Subagent J) ───────────────────────────────
      let qualityScore = null;
      try {
        qualityScore = await rateReply(text, {
          context: 'Antwort an Chat ' + (chat?.name || chatId),
        });
      } catch { /* ignore — quality is best-effort */ }
      let finalText = text;
      if (qualityScore && qualityScore.overall_score < 40) {
        log('info', 'quality below threshold, regenerating', { chatId, score: qualityScore.overall_score });
        bus.emit('quality', { chatId, action: 'regenerating', score: qualityScore });
        const hint = '\n\nDeine vorherige Antwort wurde als unpassend eingestuft'
          + (qualityScore.notes ? ` ("${qualityScore.notes}")` : '')
          + '. Versuche es nochmal — kürzer, lockerer, und ohne unnötige Rückfragen.';
        try {
          const retry = await runAi(prompt + hint);
          const retryText = String(retry || '').trim();
          if (retryText) {
            finalText = retryText;
            qualityScore = await rateReply(finalText, { context: 'Retry' });
          }
        } catch (err) {
          log('warn', 'quality retry failed', { chatId, err: String(err) });
        }
      }
      if (qualityScore && qualityScore.overall_score < 25) {
        bus.emit('quality', { chatId, action: 'rejected', score: qualityScore });
        try { repo.markJobFailed(jobId, 'quality too low after retry'); } catch { /* ignore */ }
        log('warn', 'auto-reply rejected by quality check', { chatId, jobId, score: qualityScore.overall_score });
        return;
      }
      if (qualityScore) {
        try { repo.insertQualityScore({ chat_id: chatId, ...qualityScore }); } catch { /* ignore */ }
        bus.emit('quality', { chatId, action: 'rated', score: qualityScore });
      }

      try { await wa.sendTyping(chatId, Math.min(3000, Math.max(800, finalText.length * 30))); } catch { /* ignore */ }
      await sendReplyMaybeVoice(wa, chatId, finalText, { isAuto: true });
      repo.markJobSent(jobId, finalText);
      bus.emit('reply_sent', { chatId, jobId, body: finalText });
      bus.emit('queue', { chatId, jobId, status: 'sent' });
    } catch (err) {
      try { repo.markJobFailed(jobId, String(err)); } catch { /* ignore */ }
      bus.emit('queue', { chatId, jobId, status: 'failed', error: String(err) });
      log('error', 'auto-reply failed', { chatId, err: String(err) });
    } finally {
      pending.delete(chatId);
    }
  }

  function onIncoming(message) {
    if (!message) return;
    if (message.from_me === 1 || message.from_me === true) return;
    if (message.type && message.type !== 'chat') return;
    const text = (message.body && String(message.body).trim())
      || (message.transcript && String(message.transcript).trim())
      || '';
    if (!text) return;

    const chatId = message.chat_id;
    if (!chatId) return;

    // Stories (status@broadcast) must never trigger an auto-reply.
    if (repo.isStatusChat(chatId)) return;

    // ─── AI-Session gate: when a session is active for this chat, route the
    // ─── incoming message through the session path and skip the rest.
    {
      const session = repo.getActiveSessionForChat(chatId);
      if (session) {
        const incomingText = String(text || '').toLowerCase();
        const stopWords = String(session.stop_keywords || '')
          .toLowerCase()
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        if (stopWords.length && stopWords.some((w) => incomingText.includes(w))) {
          repo.endAiSession(session.id, 'stop_keyword');
          bus.emit('ai_session', { chatId, action: 'ended', session: repo.getAiSession(session.id) });
          log('info', 'ai-session ended by stop_keyword', { chatId, sessionId: session.id });
          return;
        }
        if (session.turns_count >= session.max_turns) {
          repo.endAiSession(session.id, 'max_turns');
          bus.emit('ai_session', { chatId, action: 'ended', session: repo.getAiSession(session.id) });
          log('info', 'ai-session ended by max_turns', { chatId, sessionId: session.id });
          return;
        }
        const sessSettings = repo.getSettings(chatId);
        if (sessSettings.never_to_ai === 1) {
          log('info', 'never_to_ai gate skipped session reply', { chatId, sessionId: session.id });
          return;
        }
        clearTimerFor(chatId);
        repo.cancelPendingFor(chatId);
        const delay = Number(sessSettings.reply_delay_ms) || 0;
        const fireAt = Date.now() + delay;
        const jobId = repo.enqueueReply({ chatId, triggerMsgId: message.id, fireAt });
        bus.emit('queue', { chatId, jobId, status: 'pending', fireAt, via: 'session' });
        const sessJobMeta = {
          kind: 'ai_session',
          sessionId: session.id,
          initialPrompt: session.initial_prompt,
          triggerMsgId: message.id,
        };
        const timer = setTimeout(() => fire(chatId, jobId, sessJobMeta), delay);
        pending.set(chatId, { timer, jobId });
        return;
      }
    }

    const settings = repo.getSettings(chatId);

    // ─── Privacy gate: chat is opted out of AI processing entirely. ────
    if (settings.never_to_ai === 1) {
      try { bus.emit('safety', { chatId, action: 'never_to_ai' }); } catch { /* ignore */ }
      log('info', 'never_to_ai gate skipped reply', { chatId });
      return;
    }

    // Group-mention gate: only engage if the user/we were @-mentioned.
    if (settings.mentioned_only === 1 && message.mentioned !== 1) {
      log('info', 'mentioned_only gate skipped reply', { chatId });
      return;
    }

    // ─── Trigger check (independent of auto_reply) ─────────────────────
    const trig = repo.findMatchingTrigger(chatId, text);
    if (trig) {
      if (trig.action_type === 'skip') {
        clearTimerFor(chatId);
        repo.cancelPendingFor(chatId);
        bus.emit('trigger', { chatId, triggerId: trig.id, action: 'skip' });
        log('info', 'trigger skip — no auto-reply will be sent', { chatId, triggerId: trig.id });
        return;
      }
      clearTimerFor(chatId);
      repo.cancelPendingFor(chatId);
      const delay = trig.delay_override_ms != null
        ? Number(trig.delay_override_ms)
        : (Number(settings.reply_delay_ms) || 0);
      const fireAt = Date.now() + delay;
      const jobId = repo.enqueueReply({ chatId, triggerMsgId: message.id, fireAt });
      const jobMeta = trig.action_type === 'reply'
        ? { kind: 'trigger_reply', text: trig.action_value, triggerId: trig.id }
        : { kind: 'trigger_prompt', prompt: trig.action_value || '', triggerId: trig.id };
      bus.emit('queue', { chatId, jobId, status: 'pending', fireAt, via: 'trigger', triggerId: trig.id });
      bus.emit('trigger', { chatId, triggerId: trig.id, action: 'matched', match_mode: trig.match_mode });
      const timer = setTimeout(() => fire(chatId, jobId, jobMeta), delay);
      pending.set(chatId, { timer, jobId });
      return;
    }

    // ─── No trigger — fall through to normal auto-reply / suggestion path ──
    // Engine runs the AI when either auto_reply is on OR suggestion_mode is on.
    if (settings.auto_reply !== 1 && settings.suggestion_mode !== 1) return;

    // ─── Safety pipeline ────────────────────────────────────────────────
    // Classify risk on the incoming message and decide whether to send,
    // downgrade to suggestion, or block entirely.
    const { matched, categories } = classifyRisk(text, message);
    const decision = decideSafety({ settings, message, riskMatched: matched });
    if (decision === 'block') {
      bus.emit('safety', { chatId, action: 'blocked', categories });
      log('info', 'safety blocked auto-reply', { chatId, categories });
      return;
    }
    let forcedSuggest = false;
    if (decision === 'suggest') {
      forcedSuggest = true;
      bus.emit('safety', { chatId, action: 'downgraded_to_suggest', categories });
      log('info', 'safety downgraded to suggestion', { chatId, categories });
    }

    clearTimerFor(chatId);
    repo.cancelPendingFor(chatId);

    const delay = Number(settings.reply_delay_ms) || 0;
    const fireAt = Date.now() + delay;
    const jobId = repo.enqueueReply({ chatId, triggerMsgId: message.id, fireAt });

    bus.emit('queue', { chatId, jobId, status: 'pending', fireAt });

    const jobMeta = { triggerMsgId: message.id };
    if (forcedSuggest) jobMeta.forced_suggest = true;
    const timer = setTimeout(() => fire(chatId, jobId, jobMeta), delay);
    pending.set(chatId, { timer, jobId });
  }

  function onUserSelfReply(chatId) {
    if (!chatId) return;
    clearTimerFor(chatId);
    const n = repo.cancelPendingFor(chatId);
    if (n > 0) {
      bus.emit('queue', { chatId, status: 'cancelled', reason: 'user_self_reply' });
    }
    // Record manual-reply timestamp so the cooldown window starts now.
    try { repo.recordManualReply(chatId); } catch (err) {
      log('warn', 'recordManualReply failed', { chatId, error: String(err) });
    }
    // If an AI-session is active for this chat, end it — user has taken over.
    try {
      const activeSess = repo.getActiveSessionForChat(chatId);
      if (activeSess) {
        repo.endAiSession(activeSess.id, 'user_replied');
        bus.emit('ai_session', { chatId, action: 'ended', session: repo.getAiSession(activeSess.id) });
        log('info', 'ai-session ended by user_replied', { chatId, sessionId: activeSess.id });
      }
    } catch (err) {
      log('warn', 'ai-session end-on-user-reply failed', { chatId, error: String(err) });
    }
    log('info', 'user self-reply cancelled auto-reply', { chatId });
  }

  function status() {
    return { pending: pending.size, chats: [...pending.keys()] };
  }

  return { onIncoming, onUserSelfReply, status };
}
