import * as repo from '../db/repo.js';
import { runAi } from '../cli/wrapper.js';
import { buildReplyPrompt } from '../cli/analysis.js';
import { bus, log } from '../events.js';
import { looksIncomplete } from './autocomplete.js';

export function startAutocomplete({ wa }) {
  // chatId -> { timer, triggerMsgId, originalText }
  const pending = new Map();

  function clear(chatId) {
    const e = pending.get(chatId);
    if (e) { try { clearTimeout(e.timer); } catch {} pending.delete(chatId); }
  }

  // Called for every from-me message (from bus 'message' or 'user_self_reply').
  function onOutgoing(message) {
    if (!message || !message.chat_id) return;
    if (message.from_me !== 1 && message.from_me !== true) return;
    if (message.is_auto === 1 || message.is_auto === true) return; // ignore bot-sent
    if (message.type && message.type !== 'chat') return;

    const chatId = message.chat_id;
    const settings = repo.getSettings(chatId);
    if (!settings.autocomplete_mode || settings.autocomplete_mode === 'off') {
      clear(chatId);
      return;
    }
    if (settings.never_to_ai === 1) {
      clear(chatId);
      try { bus.emit('safety', { chatId, action: 'never_to_ai' }); } catch { /* ignore */ }
      return;
    }

    // Burst de-dup: cancel any pending completion (the user just typed again).
    clear(chatId);

    if (!looksIncomplete(message.body)) return;

    const delay = Math.max(2000, Number(settings.autocomplete_delay_ms) || 8000);
    const timer = setTimeout(() => fire(chatId, message), delay);
    pending.set(chatId, { timer, triggerMsgId: message.id, originalText: message.body });
    bus.emit('autocomplete', { chatId, action: 'scheduled', delay });
  }

  async function fire(chatId, originalMsg) {
    pending.delete(chatId);
    try {
      const settings = repo.getSettings(chatId);
      if (!settings.autocomplete_mode || settings.autocomplete_mode === 'off') return;

      const chat = repo.getChat(chatId);
      const recent = repo.lastMessages(chatId, settings.context_messages || 12);

      // Build a tight completion prompt
      const base = buildReplyPrompt(chat, recent, settings);
      const promptCompletion = `${base}

Der letzte Satz des Nutzers ist UNVOLLSTÄNDIG abgeschickt worden:
"${originalMsg.body}"

Schreibe NUR den fehlenden Teil, der diesen Satz vervollständigt — KEINE Wiederholung des Anfangs.
Wenn keine sinnvolle Vervollständigung möglich ist, antworte mit dem Wort: NOOP.

Vervollständigung:`;

      const reply = await runAi(promptCompletion);
      const text = String(reply || '').trim();
      if (!text || /^noop$/i.test(text) || text.length > 240) {
        bus.emit('autocomplete', { chatId, action: 'skipped', reason: 'noop_or_too_long' });
        return;
      }

      if (settings.autocomplete_mode === 'auto') {
        await wa.sendMessage(chatId, text, { isAuto: true });
        bus.emit('autocomplete', { chatId, action: 'sent', body: text });
      } else { // suggest
        const suggestion = repo.insertSuggestion({
          chatId,
          triggerMsgId: originalMsg.id,
          variants: [text],
        });
        bus.emit('suggestion', { chatId, suggestion });
        bus.emit('autocomplete', { chatId, action: 'suggested', suggestionId: suggestion.id });
      }
    } catch (err) {
      log('error', 'autocomplete failed', { chatId, error: String(err) });
      bus.emit('autocomplete', { chatId, action: 'failed', error: String(err) });
    }
  }

  function onCancel(chatId) { clear(chatId); }

  return { onOutgoing, onCancel };
}
