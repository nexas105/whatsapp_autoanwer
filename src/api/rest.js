// REST API router.
//
// Contract:
//   export function buildRestRouter({ wa, engine, scheduler }) -> express.Router

import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { spawn, spawnSync } from 'child_process';

import * as repo from '../db/repo.js';
import { getDb } from '../db/index.js';
import { config } from '../config.js';
import { analyzeChat, composeFromPrompt, buildReplyPrompt } from '../cli/analysis.js';
import { bus, log, recentErrors } from '../events.js';
import { transcribeFile, transcribeAvailable } from '../voice/transcribe.js';
import { runAi } from '../cli/wrapper.js';
import { generateSummary, TEMPLATES as SUMMARY_TEMPLATES } from '../cli/summaries.js';
import { renderPdf } from '../cli/pdf.js';

// Mirror of engine/reply-queue.js#splitVariants — keeps the regenerate endpoint
// in sync with how the engine itself splits multi-variant AI output.
function splitVariantsRaw(raw, expected) {
  const parts = String(raw || '')
    .split(/^===\s*$/m)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (parts.length === 0) return [];
  return parts.slice(0, expected);
}

function decodeId(raw) {
  try { return decodeURIComponent(raw); } catch { return raw; }
}

function isPositiveInt(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
}

function isBuiltinError(err) {
  const m = err && err.message ? String(err.message) : String(err);
  return /built-in/i.test(m);
}

// Tiny mime guesser for streamed media when DB row lacks mime_type.
function guessMime(filename) {
  const ext = String(filename || '').toLowerCase().split('.').pop();
  switch (ext) {
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'mp4': return 'video/mp4';
    case 'mov': return 'video/quicktime';
    case 'webm': return 'video/webm';
    case 'mp3': return 'audio/mpeg';
    case 'ogg': return 'audio/ogg';
    case 'wav': return 'audio/wav';
    case 'pdf': return 'application/pdf';
    case 'txt': return 'text/plain';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

function safeFilename(name) {
  return String(name || 'file')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 120) || 'file';
}

export function buildRestRouter({ wa, engine, scheduler }) {
  const router = express.Router();
  // Bumped slightly to accommodate base64-encoded uploads (up to ~25 MB binary
  // -> ~34 MB JSON payload; cap at 40mb to leave a little headroom).
  router.use(express.json({ limit: '40mb' }));

  // ---------- state / chats / messages ----------

  router.get('/state', (_req, res) => {
    res.json({ wa: wa.getState(), engine: engine.status() });
  });

  router.get('/chats', (_req, res) => {
    res.json({ chats: repo.listChats({ limit: 200 }) });
  });

  router.get('/chats/:id', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'not found' });
    res.json({ chat });
  });

  router.get('/chats/:id/messages', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'not found' });
    const limit = Number(req.query.limit) || 50;
    res.json({ messages: repo.listMessages(id, { limit }) });
  });

  router.get('/chats/:id/settings', (req, res) => {
    const id = decodeId(req.params.id);
    res.json({ settings: repo.getSettings(id) });
  });

  router.put('/chats/:id/settings', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    const patch = {};

    if (body.auto_reply !== undefined) {
      patch.auto_reply = !!body.auto_reply;
    }
    if (body.reply_delay_ms !== undefined) {
      const n = Number(body.reply_delay_ms);
      if (!isPositiveInt(n)) {
        return res.status(400).json({ error: 'reply_delay_ms must be a non-negative integer' });
      }
      patch.reply_delay_ms = n;
    }
    if (body.context_messages !== undefined) {
      const n = Number(body.context_messages);
      if (!isPositiveInt(n) || n < 1) {
        return res.status(400).json({ error: 'context_messages must be a positive integer' });
      }
      patch.context_messages = n;
    }
    if (body.persona_prompt !== undefined) {
      if (body.persona_prompt !== null && typeof body.persona_prompt !== 'string') {
        return res.status(400).json({ error: 'persona_prompt must be a string or null' });
      }
      patch.persona_prompt = body.persona_prompt;
    }
    if (body.persona_id !== undefined) {
      if (body.persona_id !== null) {
        if (typeof body.persona_id !== 'string' || !body.persona_id.trim()) {
          return res.status(400).json({ error: 'persona_id must be a non-empty string or null' });
        }
        const persona = repo.getPersona(body.persona_id);
        if (!persona) {
          return res.status(400).json({ error: 'persona_id does not reference an existing persona' });
        }
      }
      patch.persona_id = body.persona_id;
    }
    if (body.style_mimic_strength !== undefined) {
      const n = Number(body.style_mimic_strength);
      if (!Number.isFinite(n) || Math.floor(n) !== n || n < 0 || n > 100) {
        return res.status(400).json({ error: 'style_mimic_strength must be an integer between 0 and 100' });
      }
      patch.style_mimic_strength = n;
    }
    if (body.suggestion_mode !== undefined) {
      patch.suggestion_mode = !!body.suggestion_mode;
    }
    if (body.suggestion_count !== undefined) {
      const n = Number(body.suggestion_count);
      if (!Number.isFinite(n) || Math.floor(n) !== n || n < 1 || n > 3) {
        return res.status(400).json({ error: 'suggestion_count must be an integer between 1 and 3' });
      }
      patch.suggestion_count = n;
    }
    if (body.voice_reply_mode !== undefined) {
      const v = String(body.voice_reply_mode);
      if (!['off', 'always', 'mirror'].includes(v)) {
        return res.status(400).json({ error: 'voice_reply_mode must be one of: off, always, mirror' });
      }
      patch.voice_reply_mode = v;
    }
    if (body.autocomplete_mode !== undefined) {
      if (!['off','suggest','auto'].includes(body.autocomplete_mode)) {
        return res.status(400).json({ error: 'autocomplete_mode must be off|suggest|auto' });
      }
      patch.autocomplete_mode = body.autocomplete_mode;
    }
    if (body.autocomplete_delay_ms !== undefined) {
      const n = Number(body.autocomplete_delay_ms);
      if (!Number.isFinite(n) || n < 1000 || n > 60000) {
        return res.status(400).json({ error: 'autocomplete_delay_ms must be 1000..60000' });
      }
      patch.autocomplete_delay_ms = Math.floor(n);
    }
    if (body.mentioned_only !== undefined) {
      if (typeof body.mentioned_only !== 'boolean'
          && body.mentioned_only !== 0
          && body.mentioned_only !== 1) {
        return res.status(400).json({ error: 'mentioned_only must be a boolean' });
      }
      patch.mentioned_only = !!body.mentioned_only;
    }
    if (body.safety_mode !== undefined) {
      const v = String(body.safety_mode);
      if (!['off', 'risk_aware', 'always_suggest', 'never_send'].includes(v)) {
        return res.status(400).json({ error: 'safety_mode must be one of: off, risk_aware, always_suggest, never_send' });
      }
      patch.safety_mode = v;
    }
    if (body.cooldown_after_manual_ms !== undefined) {
      const n = Number(body.cooldown_after_manual_ms);
      if (!Number.isFinite(n) || n < 0 || n > 86400000) {
        return res.status(400).json({ error: 'cooldown_after_manual_ms must be 0..86400000' });
      }
      patch.cooldown_after_manual_ms = Math.floor(n);
    }
    if (body.never_to_ai !== undefined) {
      if (typeof body.never_to_ai !== 'boolean'
          && body.never_to_ai !== 0
          && body.never_to_ai !== 1) {
        return res.status(400).json({ error: 'never_to_ai must be a boolean' });
      }
      patch.never_to_ai = !!body.never_to_ai;
    }

    let settings;
    try {
      settings = repo.updateSettings(id, patch);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }

    if (body.auto_reply === false) {
      try { engine.onUserSelfReply(id); } catch { /* ignore */ }
    }

    bus.emit('settings', { chatId: id, settings });
    res.json({ settings });
  });

  // Compact profile payload for the right-sidebar contact card.
  router.get('/chats/:id/profile', (req, res) => {
    const id = decodeId(req.params.id);
    try {
      const profile = repo.getContactProfile(id);
      if (!profile) return res.status(404).json({ error: 'chat not found' });
      res.json({ profile });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/chats/:id/analysis', (req, res) => {
    const id = decodeId(req.params.id);
    res.json({ analysis: repo.latestAnalysis(id) ?? null });
  });

  router.post('/chats/:id/analysis', async (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    try {
      const analysis = await analyzeChat(id);
      res.json({ analysis });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/chats/:id/send', async (req, res) => {
    const id = decodeId(req.params.id);
    const body = req.body || {};
    if (!body.body || typeof body.body !== 'string') {
      return res.status(400).json({ error: 'body must be a non-empty string' });
    }
    const state = wa.getState();
    if (state.status !== 'ready') {
      return res.status(503).json({ error: 'whatsapp not ready' });
    }
    try {
      const sent = await wa.sendMessage(id, body.body.trim(), { isAuto: false });
      // Manual send → start cooldown window for safety logic.
      try { repo.recordManualReply(id); } catch { /* ignore */ }
      res.json(sent);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- compose ----------

  router.post('/chats/:id/compose', async (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    const prompt = String(body.prompt || '').trim();
    if (!prompt) return res.status(400).json({ error: 'prompt required' });
    const count = Math.max(1, Math.min(3, Number(body.count) || 1));
    try {
      const drafts = await composeFromPrompt(id, prompt, { count });
      if (!drafts.length) return res.status(502).json({ error: 'AI returned empty' });
      res.json({ drafts });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // Quick-Reply: AI generates 1..3 drafts for the LAST incoming message
  // using current chat state (persona, style, memory, schedule, etc.).
  router.post('/chats/:id/quick-reply', async (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    const count = Math.max(1, Math.min(3, Number(body.count) || 1));
    try {
      const settings = repo.getSettings(id);
      if (settings.never_to_ai === 1) {
        return res.status(403).json({ error: 'chat is opted out of AI (never_to_ai)' });
      }
      const messages = repo.lastMessages(id, settings.context_messages || 20);
      let prompt = buildReplyPrompt(chat, messages, settings);
      if (count > 1) {
        prompt = `${prompt}\n\nGib genau ${count} alternative Antwortvarianten zurück. Trenne sie mit der Zeile ===.`;
      }
      const raw = await runAi(prompt, { timeoutMs: 90000 });
      const text = String(raw || '').trim();
      if (!text) return res.status(502).json({ error: 'AI returned empty' });
      let drafts;
      if (count === 1) {
        drafts = [text];
      } else {
        const parts = text.split(/^===\s*$/m).map((s) => s.trim()).filter(Boolean);
        drafts = (parts.length ? parts : [text]).slice(0, count);
      }
      res.json({ drafts });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---------- search ----------

  router.get('/search', (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ hits: [] });
    const chatId = req.query.chat_id ? decodeId(String(req.query.chat_id)) : null;
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    try {
      const hits = repo.searchMessages(q, { chatId, limit });
      res.json({ hits, query: q });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/search/ai', async (req, res) => {
    const body = req.body || {};
    const q = String(body.q || '').trim();
    if (!q) return res.status(400).json({ error: 'q required' });
    const limit = Math.min(20, Math.max(3, Number(body.limit) || 12));
    try {
      const hits = repo.searchMessages(q, { limit });
      if (!hits.length) {
        return res.json({ answer: 'Keine passenden Nachrichten in deinen Chats gefunden.', hits: [] });
      }
      // Build a prompt with the hits as evidence
      const evidence = hits.map((h, i) => {
        const who = h.from_me === 1 ? 'Ich' : (h.chat_name || h.chat_id);
        const when = new Date(h.timestamp).toISOString().slice(0, 16).replace('T', ' ');
        const text = String(h.snippet || '').replace(/\s+/g, ' ').trim();
        return `[#${i + 1} ${when} • ${who}] ${text}`;
      }).join('\n');
      const prompt = [
        'Du bekommst eine Frage und eine Liste von Treffern aus den WhatsApp-Chats des Nutzers (mit Datum, Absender und Textauszug).',
        'Beantworte die Frage präzise auf Deutsch. Beziehe dich auf konkrete Treffer mit [#N], damit der Nutzer nachvollziehen kann woher die Info kommt.',
        'Wenn die Treffer die Frage nicht beantworten, sag das klar.',
        'Halte die Antwort kurz (1-5 Sätze).',
        '',
        '--- Treffer ---',
        evidence,
        '--- /Treffer ---',
        '',
        `Frage: ${q}`,
        '',
        'Antwort:',
      ].join('\n');
      const answer = await runAi(prompt, { timeoutMs: 90000 });
      res.json({ answer: String(answer).trim(), hits });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- triggers ----------

  router.get('/chats/:id/triggers', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    res.json({ triggers: repo.listTriggers(id) });
  });

  router.post('/chats/:id/triggers', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    try {
      const trigger = repo.createTrigger(id, req.body || {});
      bus.emit('trigger', { chatId: id, action: 'created', trigger });
      res.json({ trigger });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.put('/chats/:id/triggers/:tid', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    try {
      const trigger = repo.updateTrigger(id, req.params.tid, req.body || {});
      bus.emit('trigger', { chatId: id, action: 'updated', trigger });
      res.json({ trigger });
    } catch (err) {
      const msg = String(err.message || err);
      res.status(msg.includes('not found') ? 404 : 400).json({ error: msg });
    }
  });

  router.delete('/chats/:id/triggers/:tid', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    const ok = repo.deleteTrigger(id, req.params.tid);
    if (!ok) return res.status(404).json({ error: 'trigger not found' });
    bus.emit('trigger', { chatId: id, action: 'deleted', triggerId: Number(req.params.tid) });
    res.json({ ok: true });
  });

  // ---------- suggestions ----------

  router.get('/chats/:id/suggestions', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    const status = req.query.status ? String(req.query.status) : 'pending';
    const limit = Math.min(50, Math.max(1, Number(req.query.limit) || 20));
    try {
      res.json({ suggestions: repo.listSuggestionsForChat(id, { status, limit }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/suggestions/:sid/send', async (req, res) => {
    const sid = Number(req.params.sid);
    if (!Number.isFinite(sid) || sid <= 0) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    let s;
    try {
      s = repo.getSuggestion(sid);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
    if (!s) return res.status(404).json({ error: 'suggestion not found' });
    if (s.status !== 'pending') return res.status(404).json({ error: 'suggestion not pending' });

    const idx = (body.index != null && Number.isFinite(Number(body.index)))
      ? Math.max(0, Math.min((s.variants?.length || 1) - 1, Math.floor(Number(body.index))))
      : 0;

    let text;
    let edited = false;
    if (typeof body.body === 'string' && body.body.trim()) {
      text = body.body.trim();
      edited = true;
    } else {
      text = String((s.variants && s.variants[idx]) || '').trim();
    }
    if (!text) return res.status(400).json({ error: 'no text to send' });

    if (wa.getState().status !== 'ready') {
      return res.status(503).json({ error: 'whatsapp not ready' });
    }

    try {
      try { await wa.sendTyping(s.chat_id, Math.min(3000, Math.max(800, text.length * 30))); } catch { /* ignore */ }
      await wa.sendMessage(s.chat_id, text, { isAuto: true });
      repo.updateSuggestionStatus(sid, {
        status: edited ? 'edited' : 'sent',
        pickedIndex: idx,
        sentBody: text,
      });
      bus.emit('suggestion_resolved', {
        chatId: s.chat_id,
        suggestionId: sid,
        action: edited ? 'edited' : 'sent',
        sentBody: text,
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Cross-chat approval inbox: every still-pending suggestion in one list.
  router.get('/inbox', (_req, res) => {
    try {
      res.json({ suggestions: repo.listAllPendingSuggestions({ limit: 100 }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Re-runs the AI for an existing pending suggestion and overwrites its variants.
  // Keeps the original variant count so the user gets a like-for-like refresh.
  router.post('/suggestions/:sid/regenerate', async (req, res) => {
    const sid = Number(req.params.sid);
    if (!Number.isFinite(sid) || sid <= 0) return res.status(400).json({ error: 'invalid id' });

    let s;
    try {
      s = repo.getSuggestion(sid);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
    if (!s) return res.status(404).json({ error: 'suggestion not found' });
    if (s.status !== 'pending') return res.status(404).json({ error: 'suggestion not pending' });

    const chat = repo.getChat(s.chat_id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });

    try {
      const settings = repo.getSettings(s.chat_id);
      const messages = repo.lastMessages(s.chat_id, settings.context_messages || 20);
      const basePrompt = buildReplyPrompt(chat, messages, settings);
      const count = Math.max(1, Math.min(3, (Array.isArray(s.variants) ? s.variants.length : 0) || 1));
      const fullPrompt = count > 1
        ? `${basePrompt}\n\nGib genau ${count} alternative Antwortvarianten zurück. Trenne sie mit der Zeile ===.`
        : basePrompt;
      const raw = await runAi(fullPrompt, { timeoutMs: 90000 });
      if (!raw || !String(raw).trim()) {
        return res.status(502).json({ error: 'AI returned empty' });
      }
      let variants;
      if (count === 1) {
        variants = [String(raw).trim()];
      } else {
        variants = splitVariantsRaw(raw, count);
        if (!variants.length) variants = [String(raw).trim()];
      }
      variants = variants.map((v) => String(v).trim()).filter(Boolean);
      if (!variants.length) {
        return res.status(502).json({ error: 'AI returned empty' });
      }

      const updated = repo.updateSuggestionVariants(sid, variants);
      bus.emit('suggestion', { chatId: s.chat_id, suggestion: updated });
      res.json({ suggestion: updated });
    } catch (err) {
      log('error', 'suggestion regenerate failed', { sid, error: String(err) });
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/suggestions/:sid/discard', (req, res) => {
    const sid = Number(req.params.sid);
    if (!Number.isFinite(sid) || sid <= 0) return res.status(400).json({ error: 'invalid id' });
    let s;
    try {
      s = repo.getSuggestion(sid);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
    if (!s) return res.status(404).json({ error: 'suggestion not found' });
    if (s.status !== 'pending') return res.status(404).json({ error: 'suggestion not pending' });
    try {
      repo.updateSuggestionStatus(sid, { status: 'discarded', pickedIndex: null, sentBody: null });
      bus.emit('suggestion_resolved', {
        chatId: s.chat_id,
        suggestionId: sid,
        action: 'discarded',
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- AI sessions ----------

  router.get('/chats/:id/session', (req, res) => {
    const id = decodeId(req.params.id);
    try {
      res.json({ session: repo.getActiveSessionForChat(id) || null });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/chats/:id/session', async (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    let session;
    try {
      session = repo.startAiSession({
        chatId: id,
        initialPrompt: body.initial_prompt,
        maxTurns: body.max_turns,
        stopKeywords: body.stop_keywords,
      });
      bus.emit('ai_session', { chatId: id, action: 'started', session });
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }

    // Kickoff: send the first message immediately (default true; opt-out via body.kickoff=false).
    const kickoff = body.kickoff !== false;
    if (!kickoff) return res.json({ session, kickoff: false });
    if (wa.getState().status !== 'ready') return res.json({ session, kickoff: false, error: 'wa not ready, kickoff skipped' });

    try {
      const settings = repo.getSettings(id);
      if (settings.never_to_ai === 1) return res.json({ session, kickoff: false, error: 'never_to_ai' });
      const messages = repo.lastMessages(id, settings.context_messages || 20);
      const base = buildReplyPrompt(chat, messages, settings);
      // Replace the "antworte auf den letzten Verlauf"-framing with the kickoff framing.
      const kickoffBlock = [
        '',
        '--- Ziel dieser AI-Session ---',
        String(session.initial_prompt || '').trim(),
        '--- /Ziel ---',
        '',
        'Du startest jetzt das Gespräch. Schreibe die ERSTE Nachricht passend zum Ziel.',
        'Natürlich, locker, knapp. Keine Floskeln, kein "Hallo, ich melde mich weil…".',
        'Schreib so, wie du sonst diesem Kontakt schreiben würdest.',
        '',
        'Deine Nachricht:',
      ].join('\n');
      const prompt = base.replace(/Deine Antwort:\s*$/m, '').trimEnd() + '\n' + kickoffBlock;
      const reply = String(await runAi(prompt)).trim();
      if (!reply) return res.json({ session, kickoff: false, error: 'AI returned empty' });

      try { await wa.sendTyping?.(id, Math.min(3000, Math.max(800, reply.length * 30))); } catch { /* ignore */ }
      await wa.sendMessage(id, reply, { isAuto: true });
      repo.bumpSessionTurns(session.id);
      const updated = repo.getAiSession(session.id);
      bus.emit('reply_sent', { chatId: id, body: reply, via: 'session_kickoff' });
      bus.emit('ai_session', { chatId: id, action: 'turn', session: updated });
      res.json({ session: updated, kickoff: true, kickoff_body: reply });
    } catch (err) {
      log('error', 'session kickoff failed', { id, error: String(err) });
      res.json({ session, kickoff: false, error: String(err.message || err) });
    }
  });

  router.post('/sessions/:sid/stop', (req, res) => {
    const sid = req.params.sid;
    const s = repo.getAiSession(sid);
    if (!s) return res.status(404).json({ error: 'not found' });
    const reason = (req.body && req.body.reason) || 'manual_stop';
    try {
      const updated = repo.endAiSession(sid, reason);
      bus.emit('ai_session', { chatId: s.chat_id, action: 'ended', session: updated });
      res.json({ session: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/sessions/:sid/pause', (req, res) => {
    const sid = req.params.sid;
    const s = repo.getAiSession(sid);
    if (!s) return res.status(404).json({ error: 'not found' });
    try {
      const updated = repo.endAiSession(sid, 'manual_pause');
      bus.emit('ai_session', { chatId: s.chat_id, action: 'paused', session: updated });
      res.json({ session: updated });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/sessions/:sid/resume', (req, res) => {
    const sid = req.params.sid;
    try {
      const updated = repo.resumeAiSession(sid);
      bus.emit('ai_session', { chatId: updated.chat_id, action: 'resumed', session: updated });
      res.json({ session: updated });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.get('/sessions', (req, res) => {
    const chatId = req.query.chat_id ? decodeId(String(req.query.chat_id)) : null;
    try {
      res.json({ sessions: repo.listAiSessions({ chatId, limit: 100 }) });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---------- transcribe ----------

  router.post('/media/:id/transcribe', async (req, res) => {
    if (!transcribeAvailable()) {
      return res.status(503).json({ error: 'whisper model not configured or missing' });
    }
    const m = repo.getMedia(Number(req.params.id));
    if (!m) return res.status(404).json({ error: 'media not found' });
    if (m.kind !== 'audio') return res.status(400).json({ error: 'only audio media can be transcribed' });
    const abs = path.resolve(process.cwd(), m.file_path);
    if (!fs.existsSync(abs)) return res.status(404).json({ error: 'file missing on disk' });
    try {
      const transcript = await transcribeFile(abs);
      repo.setMessageTranscript(m.message_id, transcript);
      bus.emit('transcript', { chatId: m.chat_id, messageId: m.message_id, mediaId: m.id, transcript });
      bus.emit('message', { chatId: m.chat_id, message: { id: m.message_id, chat_id: m.chat_id, transcript, has_media: 1 } });
      res.json({ transcript });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- sync ----------

  router.post('/sync', async (_req, res) => {
    if (typeof wa.syncChats !== 'function') {
      return res.status(501).json({ error: 'sync not supported by wa client' });
    }
    if (wa.getState().status !== 'ready') {
      return res.status(503).json({ error: 'whatsapp not ready' });
    }
    try {
      const result = await wa.syncChats();
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/chats/:id/sync', async (req, res) => {
    const id = decodeId(req.params.id);
    if (typeof wa.syncChatHistory !== 'function') {
      return res.status(501).json({ error: 'sync not supported by wa client' });
    }
    if (wa.getState().status !== 'ready') {
      return res.status(503).json({ error: 'whatsapp not ready' });
    }
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50));
    try {
      const result = await wa.syncChatHistory(id, limit);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- dashboard ----------

  router.get('/stats', (_req, res) => {
    try {
      res.json({ stats: repo.getDashboardStats() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- stories (status@broadcast) ----------
  router.get('/stories', (req, res) => {
    const n = Number(req.query.limit);
    const limit = Math.min(200, Math.max(1, Number.isFinite(n) && n > 0 ? Math.floor(n) : 60));
    try {
      res.json({ stories: repo.listStoryItems({ limit }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/charts', (_req, res) => {
    try {
      res.json({
        activity: repo.messagesPerHour(24),
        personas: repo.personaUsageStats(),
        reply_ratio: repo.autoReplySuccessRatio(),
        metrics_24h: repo.autoReplyMetrics({ hours: 24 }),
        top_chats_7d: repo.topChatsByActivity({ days: 7, limit: 5 }),
        time_saved_24h: repo.timeSavedEstimate({ hours: 24 }),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- health ----------

  // Spawns a process with a short timeout and reports whether the binary
  // is reachable. We treat any non-error exit (even non-zero, e.g. --help)
  // as evidence the binary is installed.
  function probeBinary(cmd, args, timeoutMs = 3000) {
    return new Promise((resolve) => {
      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let child;
      try {
        child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (err) {
        return resolve({ ok: false, error: String(err.message || err) });
      }
      const finish = (payload) => {
        if (settled) return;
        settled = true;
        try { child.kill('SIGKILL'); } catch { /* ignore */ }
        resolve(payload);
      };
      const timer = setTimeout(() => finish({ ok: false, error: 'timeout' }), timeoutMs);
      child.stdout.on('data', (d) => { stdoutBuf += d.toString(); if (stdoutBuf.length > 4096) stdoutBuf = stdoutBuf.slice(0, 4096); });
      child.stderr.on('data', (d) => { stderrBuf += d.toString(); if (stderrBuf.length > 4096) stderrBuf = stderrBuf.slice(0, 4096); });
      child.on('error', (err) => {
        clearTimeout(timer);
        finish({ ok: false, error: String(err.message || err) });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const out = (stdoutBuf || stderrBuf || '').split('\n')[0].trim().slice(0, 160);
        finish({ ok: true, code, version: out });
      });
    });
  }

  router.get('/health', async (_req, res) => {
    // WhatsApp client state.
    let waInfo;
    try { waInfo = wa?.getState ? wa.getState() : { status: 'unknown' }; }
    catch (err) { waInfo = { status: 'error', error: String(err.message || err) }; }
    const waOk = waInfo?.status === 'ready';

    // AI CLI probe. Skip the probe if the cmd is "mock" — there's no binary.
    let aiCli;
    if (!config.ai.cmd || config.ai.cmd === 'mock') {
      aiCli = { status: 'mock', cmd: config.ai.cmd || null, details: 'mock backend (no external CLI)' };
    } else {
      const probe = await probeBinary(config.ai.cmd, ['--version'], 3000);
      if (!probe.ok) {
        // Retry with --help in case --version is unsupported.
        const probe2 = await probeBinary(config.ai.cmd, ['--help'], 3000);
        if (probe2.ok) {
          aiCli = { status: 'ok', cmd: config.ai.cmd, details: probe2.version || 'help responded' };
        } else {
          aiCli = { status: 'error', cmd: config.ai.cmd, details: probe.error || probe2.error || 'unreachable' };
        }
      } else {
        aiCli = { status: 'ok', cmd: config.ai.cmd, details: probe.version || 'version responded' };
      }
    }

    // Whisper probe.
    let whisper;
    try {
      const modelExists = fs.existsSync(path.resolve(process.cwd(), config.voice.modelPath));
      const probe = await probeBinary(config.voice.whisperBin, ['--help'], 3000);
      whisper = {
        status: probe.ok ? (modelExists ? 'ok' : 'no_model') : 'error',
        bin: config.voice.whisperBin,
        model_path: config.voice.modelPath,
        model_present: modelExists,
        details: probe.ok ? (modelExists ? (probe.version || 'help responded') : 'model file missing') : (probe.error || 'unreachable'),
      };
    } catch (err) {
      whisper = { status: 'error', details: String(err.message || err) };
    }

    // TTS probe — macOS `say` plus ffmpeg.
    let tts;
    try {
      let sayOk = false;
      try {
        const r = spawnSync('which', ['say'], { timeout: 2000 });
        sayOk = r.status === 0;
      } catch { sayOk = false; }
      let ffmpegOk = false;
      try {
        const r = spawnSync('which', [config.voice.ffmpegBin || 'ffmpeg'], { timeout: 2000 });
        ffmpegOk = r.status === 0;
      } catch { ffmpegOk = false; }
      const okFlag = sayOk && ffmpegOk;
      tts = {
        status: okFlag ? 'ok' : (sayOk || ffmpegOk ? 'partial' : 'error'),
        say_available: sayOk,
        ffmpeg_available: ffmpegOk,
        ffmpeg_bin: config.voice.ffmpegBin,
        details: okFlag ? 'say + ffmpeg present' : `say=${sayOk ? 'ok' : 'missing'}, ffmpeg=${ffmpegOk ? 'ok' : 'missing'}`,
      };
    } catch (err) {
      tts = { status: 'error', details: String(err.message || err) };
    }

    // DB probe.
    let db;
    try {
      getDb().prepare('SELECT 1 AS ok').get();
      db = { status: 'ok', details: 'sqlite responsive' };
    } catch (err) {
      db = { status: 'error', details: String(err.message || err) };
    }

    // Scheduler.
    const schedulerInfo = scheduler
      ? { status: 'running', details: typeof scheduler.size === 'function' ? `jobs: ${scheduler.size()}` : 'scheduler instance present' }
      : { status: 'missing', details: 'no scheduler bound to REST router' };

    // Pull last 10 entries — newest first.
    const errs = recentErrors.slice(-10).slice().reverse();

    res.json({
      wa: { status: waInfo?.status || 'unknown', details: waInfo?.info || waInfo?.reason || null },
      ai_cli: aiCli,
      whisper,
      tts,
      db,
      scheduler: schedulerInfo,
      recent_errors: errs,
      t: Date.now(),
    });
  });

  // ---------- personas ----------

  router.get('/personas', (_req, res) => {
    try {
      res.json({ personas: repo.listPersonas() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/personas/:id', (req, res) => {
    const id = req.params.id;
    try {
      const persona = repo.getPersona(id);
      if (!persona) return res.status(404).json({ error: 'persona not found' });
      res.json({ persona });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/personas', (req, res) => {
    const body = req.body || {};
    if (!body.name || typeof body.name !== 'string' || !body.name.trim()) {
      return res.status(400).json({ error: 'name is required' });
    }
    if (!body.prompt || typeof body.prompt !== 'string' || !body.prompt.trim()) {
      return res.status(400).json({ error: 'prompt is required' });
    }
    if (body.description !== undefined && body.description !== null && typeof body.description !== 'string') {
      return res.status(400).json({ error: 'description must be a string or null' });
    }
    try {
      const persona = repo.createPersona({
        name: body.name.trim(),
        description: body.description ?? null,
        prompt: body.prompt,
      });
      bus.emit('personas', { action: 'created', persona });
      res.json({ persona });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.put('/personas/:id', (req, res) => {
    const id = req.params.id;
    const body = req.body || {};
    const patch = {};
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) {
        return res.status(400).json({ error: 'name must be a non-empty string' });
      }
      patch.name = body.name.trim();
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== 'string') {
        return res.status(400).json({ error: 'description must be a string or null' });
      }
      patch.description = body.description;
    }
    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
        return res.status(400).json({ error: 'prompt must be a non-empty string' });
      }
      patch.prompt = body.prompt;
    }
    try {
      const persona = repo.updatePersona(id, patch);
      bus.emit('personas', { action: 'updated', persona });
      res.json({ persona });
    } catch (err) {
      const msg = String(err.message || err);
      if (/not found/i.test(msg)) return res.status(404).json({ error: msg });
      return res.status(400).json({ error: msg });
    }
  });

  router.delete('/personas/:id', (req, res) => {
    const id = req.params.id;
    try {
      const existed = repo.deletePersona(id);
      if (!existed) return res.status(404).json({ error: 'persona not found' });
      bus.emit('personas', { action: 'deleted', id });
      res.json({ ok: true });
    } catch (err) {
      const msg = String(err.message || err);
      if (isBuiltinError(err)) return res.status(400).json({ error: msg });
      return res.status(500).json({ error: msg });
    }
  });

  // ---------- media ----------

  const MEDIA_ROOT = path.resolve(process.cwd(), 'data', 'media');

  router.get('/chats/:id/media', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const limit = Number(req.query.limit) || 100;
    try {
      res.json({ media: repo.listMediaForChat(id, { limit }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/media/:id', (req, res) => {
    try {
      const m = repo.getMedia(req.params.id);
      if (!m) return res.status(404).json({ error: 'media not found' });
      res.json({ media: m });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/media/:id/file', (req, res) => {
    let m;
    try {
      m = repo.getMedia(req.params.id);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }
    if (!m) return res.status(404).json({ error: 'media not found' });

    const absPath = path.resolve(process.cwd(), m.file_path);
    const mediaRootWithSep = MEDIA_ROOT.endsWith(path.sep) ? MEDIA_ROOT : MEDIA_ROOT + path.sep;
    if (!(absPath === MEDIA_ROOT || absPath.startsWith(mediaRootWithSep))) {
      return res.status(403).json({ error: 'forbidden' });
    }
    if (!fs.existsSync(absPath)) {
      return res.status(404).json({ error: 'file missing' });
    }
    const mime = m.mime_type || guessMime(m.file_name || absPath);
    res.set('Content-Type', mime || 'application/octet-stream');
    res.set('Content-Disposition', `inline; filename="${m.file_name || `media-${m.id}`}"`);
    const stream = fs.createReadStream(absPath);
    stream.on('error', (err) => {
      if (!res.headersSent) {
        res.status(500).json({ error: String(err) });
      } else {
        try { res.destroy(err); } catch { /* ignore */ }
      }
    });
    stream.pipe(res);
  });

  // Upload + send (base64 JSON body — keeps us free of multipart deps).
  router.post('/chats/:id/upload-send', async (req, res) => {
    const id = decodeId(req.params.id);
    const body = req.body || {};
    const filename = body.filename;
    const dataB64 = body.data_base64;
    const caption = typeof body.caption === 'string' ? body.caption : '';

    if (!filename || typeof filename !== 'string' || !filename.trim()) {
      return res.status(400).json({ error: 'filename is required' });
    }
    if (!dataB64 || typeof dataB64 !== 'string' || !dataB64.trim()) {
      return res.status(400).json({ error: 'data_base64 is required' });
    }
    if (body.mime_type !== undefined && body.mime_type !== null && typeof body.mime_type !== 'string') {
      return res.status(400).json({ error: 'mime_type must be a string' });
    }

    let buf;
    try {
      buf = Buffer.from(dataB64, 'base64');
    } catch (err) {
      return res.status(400).json({ error: 'data_base64 is not valid base64' });
    }
    if (!buf.length) {
      return res.status(400).json({ error: 'decoded data is empty' });
    }
    if (buf.length > 25 * 1024 * 1024) {
      return res.status(400).json({ error: 'file exceeds 25 MB limit' });
    }

    const state = wa.getState();
    if (state.status !== 'ready') {
      return res.status(503).json({ error: 'whatsapp not ready' });
    }

    // Write to data/media/<sha1(chatId).slice(0,12)>/upload_<ts>_<safeFilename>
    let absoluteFilePath;
    try {
      const bucket = crypto.createHash('sha1').update(String(id)).digest('hex').slice(0, 12);
      const dir = path.resolve(MEDIA_ROOT, bucket);
      fs.mkdirSync(dir, { recursive: true });
      const safe = safeFilename(filename);
      const outName = `upload_${Date.now()}_${safe}`;
      absoluteFilePath = path.resolve(dir, outName);
      // Guard against any weirdness in the safe name escaping the bucket dir.
      if (!absoluteFilePath.startsWith(dir + path.sep)) {
        return res.status(400).json({ error: 'invalid filename' });
      }
      fs.writeFileSync(absoluteFilePath, buf);
    } catch (err) {
      return res.status(500).json({ error: String(err) });
    }

    try {
      const sent = await wa.sendMessage(id, caption, {
        isAuto: false,
        mediaPath: absoluteFilePath,
        mediaCaption: caption,
      });
      res.json({ ok: true, message: sent });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- scheduled messages ----------

  const SCHEDULE_KINDS = new Set(['cron', 'once', 'after_silence']);
  const SCHEDULE_MODES = new Set(['ai', 'fixed']);

  function validateSchedulePatch(body, { isUpdate = false } = {}) {
    if (!body || typeof body !== 'object') throw new Error('body required');

    const patch = {};

    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || !body.name.trim()) throw new Error('name must be non-empty string');
      patch.name = body.name.trim();
    } else if (!isUpdate) {
      throw new Error('name is required');
    }

    if (body.schedule_kind !== undefined) {
      if (!SCHEDULE_KINDS.has(body.schedule_kind)) throw new Error('schedule_kind invalid');
      patch.schedule_kind = body.schedule_kind;
    } else if (!isUpdate) {
      patch.schedule_kind = 'cron';
    }

    const kind = patch.schedule_kind || 'cron';

    if (body.schedule_spec !== undefined) {
      if (typeof body.schedule_spec !== 'string' || !body.schedule_spec.trim()) {
        throw new Error('schedule_spec must be non-empty string');
      }
      patch.schedule_spec = body.schedule_spec.trim();
    } else if (!isUpdate) {
      throw new Error('schedule_spec is required');
    }

    const spec = patch.schedule_spec;
    if (spec) {
      if (kind === 'cron') {
        const parts = spec.split(/\s+/);
        if (parts.length !== 5) throw new Error('cron schedule_spec must have 5 fields');
      } else if (kind === 'once') {
        if (!Number.isFinite(Date.parse(spec))) throw new Error('once schedule_spec must be parseable ISO datetime');
      } else if (kind === 'after_silence') {
        if (!Number.isFinite(Number(spec)) || Number(spec) <= 0) throw new Error('after_silence schedule_spec must be a positive number of seconds');
      }
    }

    if (body.prompt !== undefined) {
      if (typeof body.prompt !== 'string' || !body.prompt.trim()) throw new Error('prompt must be non-empty string');
      patch.prompt = body.prompt;
    } else if (!isUpdate) {
      throw new Error('prompt is required');
    }

    if (body.mode !== undefined) {
      if (!SCHEDULE_MODES.has(body.mode)) throw new Error('mode must be ai or fixed');
      patch.mode = body.mode;
    } else if (!isUpdate) {
      patch.mode = 'ai';
    }

    if (body.chat_id !== undefined) {
      if (body.chat_id === null || body.chat_id === '') {
        patch.chat_id = null;
      } else {
        if (typeof body.chat_id !== 'string') throw new Error('chat_id must be string or null');
        if (!repo.getChat(body.chat_id)) throw new Error('chat_id does not match an existing chat');
        patch.chat_id = body.chat_id;
      }
    }

    if (body.target_filter !== undefined) {
      if (body.target_filter === null || body.target_filter === '') {
        patch.target_filter = null;
      } else if (typeof body.target_filter === 'string') {
        try {
          const parsed = JSON.parse(body.target_filter);
          patch.target_filter = parsed;
        } catch {
          throw new Error('target_filter must be valid JSON');
        }
      } else if (typeof body.target_filter === 'object') {
        patch.target_filter = body.target_filter;
      } else {
        throw new Error('target_filter must be an object, JSON string or null');
      }
    }

    if (body.enabled !== undefined) {
      patch.enabled = !!body.enabled;
    }

    return patch;
  }

  router.get('/schedules', (_req, res) => {
    try {
      res.json({ schedules: repo.listScheduledMessages() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/schedules/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const schedule = repo.getScheduledMessage(id);
    if (!schedule) return res.status(404).json({ error: 'not found' });
    res.json({ schedule });
  });

  router.post('/schedules', (req, res) => {
    let patch;
    try {
      patch = validateSchedulePatch(req.body || {}, { isUpdate: false });
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }
    try {
      const schedule = repo.insertScheduledMessage(patch);
      bus.emit('schedule', { action: 'created', schedule });
      try { scheduler?.rescanSchedules?.(); } catch { /* ignore */ }
      res.json({ schedule });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.put('/schedules/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const existing = repo.getScheduledMessage(id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    let patch;
    try {
      patch = validateSchedulePatch(req.body || {}, { isUpdate: true });
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }
    try {
      const schedule = repo.updateScheduledMessage(id, patch);
      bus.emit('schedule', { action: 'updated', schedule });
      try { scheduler?.rescanSchedules?.(); } catch { /* ignore */ }
      res.json({ schedule });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.delete('/schedules/:id', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    try {
      const existed = repo.deleteScheduledMessage(id);
      if (!existed) return res.status(404).json({ error: 'not found' });
      bus.emit('schedule', { action: 'deleted', id });
      try { scheduler?.rescanSchedules?.(); } catch { /* ignore */ }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/schedules/:id/run', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const schedule = repo.getScheduledMessage(id);
    if (!schedule) return res.status(404).json({ error: 'not found' });
    if (!scheduler || typeof scheduler.runNow !== 'function') {
      return res.status(503).json({ error: 'scheduler unavailable' });
    }
    try {
      // Don't await — fire-and-forget; client will see the bus event via WS.
      Promise.resolve().then(() => scheduler.runNow(id)).catch((err) => {
        log('error', 'manual runNow failed', { id, error: String(err) });
      });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---------- user profile + personal schedule (Bundle M) ----------

  router.get('/profile', (_req, res) => {
    try {
      res.json({ profile: repo.getUserProfile() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put('/profile', (req, res) => {
    const body = req.body || {};
    const patch = {};
    for (const k of ['name', 'bio_short', 'bio_full', 'mood_today', 'energy_today', 'current_focus']) {
      if (body[k] !== undefined) {
        if (body[k] !== null && typeof body[k] !== 'string') {
          return res.status(400).json({ error: `${k} must be string or null` });
        }
        patch[k] = body[k];
      }
    }
    try {
      const profile = repo.updateUserProfile(patch);
      bus.emit('profile', { profile });
      res.json({ profile });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.get('/schedule', (_req, res) => {
    try {
      res.json({ entries: repo.listSchedule() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get('/schedule/status', (_req, res) => {
    try {
      res.json({ status: repo.currentScheduleStatus() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/schedule', (req, res) => {
    try {
      const entry = repo.insertScheduleEntry(req.body || {});
      bus.emit('schedule_entry', { action: 'created', entry });
      res.json({ entry });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.put('/schedule/:id', (req, res) => {
    try {
      const entry = repo.updateScheduleEntry(req.params.id, req.body || {});
      bus.emit('schedule_entry', { action: 'updated', entry });
      res.json({ entry });
    } catch (err) {
      const msg = String(err.message || err);
      const code = /not found/i.test(msg) ? 404 : 400;
      res.status(code).json({ error: msg });
    }
  });

  router.delete('/schedule/:id', (req, res) => {
    try {
      const ok = repo.deleteScheduleEntry(req.params.id);
      if (!ok) return res.status(404).json({ error: 'not found' });
      bus.emit('schedule_entry', { action: 'deleted', id: Number(req.params.id) });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---------- chat memory ----------

  router.get('/chats/:id/memory', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    try {
      res.json({ memory: repo.listMemoryForChat(id) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/chats/:id/memory', (req, res) => {
    const id = decodeId(req.params.id);
    const chat = repo.getChat(id);
    if (!chat) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    if (!body.note || typeof body.note !== 'string' || !body.note.trim()) {
      return res.status(400).json({ error: 'note is required' });
    }
    try {
      const memory = repo.addMemory(id, {
        note: body.note,
        source: 'manual',
        pinned: !!body.pinned,
      });
      bus.emit('memory_added', { chatId: id });
      res.json({ memory });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.delete('/memory/:mid', (req, res) => {
    const mid = Number(req.params.mid);
    if (!Number.isFinite(mid)) return res.status(400).json({ error: 'invalid id' });
    try {
      const ok = repo.deleteMemory(mid);
      if (!ok) return res.status(404).json({ error: 'memory not found' });
      bus.emit('memory_removed', { id: mid });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put('/memory/:mid/pinned', (req, res) => {
    const mid = Number(req.params.mid);
    if (!Number.isFinite(mid)) return res.status(400).json({ error: 'invalid id' });
    const body = req.body || {};
    if (body.pinned === undefined) {
      return res.status(400).json({ error: 'pinned is required' });
    }
    try {
      repo.setMemoryPinned(mid, !!body.pinned);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- global config (quiet hours etc.) ----------

  // HH:MM (00:00..23:59)
  function isValidHHMM(s) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
    if (!m) return false;
    const h = Number(m[1]);
    const mn = Number(m[2]);
    return h >= 0 && h <= 23 && mn >= 0 && mn <= 59;
  }

  router.get('/config', (_req, res) => {
    try {
      res.json({ config: repo.getGlobalConfig() });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put('/config', (req, res) => {
    const body = req.body || {};
    const patch = {};
    if (body.quiet_hours_enabled !== undefined) {
      patch.quiet_hours_enabled = !!body.quiet_hours_enabled;
    }
    if (body.quiet_hours_start !== undefined) {
      if (!isValidHHMM(body.quiet_hours_start)) {
        return res.status(400).json({ error: 'quiet_hours_start must be HH:MM' });
      }
      patch.quiet_hours_start = String(body.quiet_hours_start);
    }
    if (body.quiet_hours_end !== undefined) {
      if (!isValidHHMM(body.quiet_hours_end)) {
        return res.status(400).json({ error: 'quiet_hours_end must be HH:MM' });
      }
      patch.quiet_hours_end = String(body.quiet_hours_end);
    }
    if (body.quiet_hours_allow_suggestions !== undefined) {
      patch.quiet_hours_allow_suggestions = !!body.quiet_hours_allow_suggestions;
    }
    if (body.pii_redaction_enabled !== undefined) {
      patch.pii_redaction_enabled = !!body.pii_redaction_enabled;
    }
    try {
      const cfg = repo.setGlobalConfig(patch);
      res.json({ config: cfg });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- persona playground (Subagent J) ----------

  router.post('/playground/generate', async (req, res) => {
    const body = req.body || {};

    // Validate persona refs (either by id or freeform prompt).
    if (body.persona_id !== undefined && body.persona_id !== null) {
      if (typeof body.persona_id !== 'string' || !body.persona_id.trim()) {
        return res.status(400).json({ error: 'persona_id must be a non-empty string or null' });
      }
      const persona = repo.getPersona(body.persona_id);
      if (!persona) {
        return res.status(400).json({ error: 'persona_id does not reference an existing persona' });
      }
    }
    if (body.persona_prompt !== undefined && body.persona_prompt !== null && typeof body.persona_prompt !== 'string') {
      return res.status(400).json({ error: 'persona_prompt must be a string or null' });
    }

    // style_mimic_strength 0..100
    let styleMimic = 0;
    if (body.style_mimic_strength !== undefined && body.style_mimic_strength !== null) {
      const n = Number(body.style_mimic_strength);
      if (!Number.isFinite(n) || n < 0 || n > 100) {
        return res.status(400).json({ error: 'style_mimic_strength must be 0..100' });
      }
      styleMimic = Math.floor(n);
    }

    // mock_history: required, ordered oldest-first
    if (!Array.isArray(body.mock_history) || body.mock_history.length === 0) {
      return res.status(400).json({ error: 'mock_history must be a non-empty array' });
    }
    const mock = [];
    for (let i = 0; i < body.mock_history.length; i++) {
      const row = body.mock_history[i];
      if (!row || typeof row !== 'object') {
        return res.status(400).json({ error: `mock_history[${i}] must be an object` });
      }
      const fromMe = (row.from_me === 1 || row.from_me === true) ? 1 : 0;
      const bodyText = String(row.body == null ? '' : row.body);
      if (!bodyText.trim()) {
        return res.status(400).json({ error: `mock_history[${i}].body must be a non-empty string` });
      }
      mock.push({ from_me: fromMe, body: bodyText });
    }

    const count = Math.max(1, Math.min(3, Number(body.count) || 1));

    // Build a synthetic chat + messages list compatible with buildReplyPrompt.
    const fakeChat = { id: 'playground', name: 'Playground', is_group: false };
    const baseTs = Date.now();
    const messages = mock.map((m, i) => ({
      id: `playground-${baseTs}-${i}`,
      chat_id: 'playground',
      from_me: m.from_me,
      body: m.body,
      timestamp: baseTs - (mock.length - i) * 60000,
      type: 'chat',
      has_media: 0,
    }));

    // Settings overlay for the playground — disable cross-chat context search.
    const settings = {
      persona_id: body.persona_id ?? null,
      persona_prompt: body.persona_prompt ?? null,
      style_mimic_strength: styleMimic,
      context_search_enabled: 0,
      context_messages: messages.length,
    };

    let prompt;
    try {
      prompt = buildReplyPrompt(fakeChat, messages, settings);
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }

    const fullPrompt = count > 1
      ? `${prompt}\n\nGib genau ${count} alternative Antworten zurück. Trenne mit ===.`
      : prompt;

    let raw;
    try {
      raw = await runAi(fullPrompt, { timeoutMs: 90000 });
    } catch (err) {
      return res.status(500).json({ error: String(err.message || err) });
    }
    const text = String(raw || '').trim();
    if (!text) return res.status(502).json({ error: 'AI returned empty' });

    let variants;
    if (count === 1) {
      variants = [text];
    } else {
      const parts = text.split(/^===\s*$/m).map((s) => s.trim()).filter(Boolean);
      variants = (parts.length > 0 ? parts : [text]).slice(0, count);
    }
    res.json({ variants });
  });

  // ---------- quality scores (Subagent J) ----------

  router.get('/quality', (req, res) => {
    const chatId = req.query.chat_id ? decodeId(String(req.query.chat_id)) : null;
    const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
    try {
      res.json({ scores: repo.listQualityScores({ chatId, limit }) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- structured contact bio (Bundle N) ----------

  function sanitizeBioStringArray(v) {
    if (v == null) return [];
    if (!Array.isArray(v)) throw new Error('must be an array of strings');
    const out = [];
    for (const item of v) {
      if (item == null) continue;
      if (typeof item !== 'string') throw new Error('must be an array of strings');
      const t = item.trim();
      if (t) out.push(t.slice(0, 200));
    }
    return out;
  }

  function sanitizeBioString(v) {
    if (v == null) return null;
    if (typeof v !== 'string') throw new Error('must be string or null');
    const t = v.trim();
    return t ? t.slice(0, 500) : null;
  }

  router.get('/chats/:id/bio', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    try {
      res.json({ bio: repo.getContactBio(id) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.put('/chats/:id/bio', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    const body = req.body || {};
    const bio = {};
    try {
      if (body.relationship !== undefined) bio.relationship = sanitizeBioString(body.relationship);
      if (body.how_met !== undefined) bio.how_met = sanitizeBioString(body.how_met);
      if (body.tone_pref !== undefined) bio.tone_pref = sanitizeBioString(body.tone_pref);
      if (body.no_gos !== undefined) bio.no_gos = sanitizeBioStringArray(body.no_gos);
      if (body.topics !== undefined) bio.topics = sanitizeBioStringArray(body.topics);
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }
    // Drop empty fields so the persisted JSON stays clean.
    const clean = {};
    for (const k of Object.keys(bio)) {
      const v = bio[k];
      if (v == null) continue;
      if (Array.isArray(v) && v.length === 0) continue;
      clean[k] = v;
    }
    const hasAny = Object.keys(clean).length > 0;
    try {
      const saved = hasAny ? repo.setContactBio(id, clean) : repo.setContactBio(id, null);
      bus.emit('contact_bio', { chatId: id, bio: saved });
      res.json({ bio: saved });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete('/chats/:id/bio', (req, res) => {
    const id = decodeId(req.params.id);
    if (!repo.getChat(id)) return res.status(404).json({ error: 'chat not found' });
    try {
      repo.setContactBio(id, null);
      bus.emit('contact_bio', { chatId: id, bio: null });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ---------- bio suggestions (Bundle N) ----------

  router.get('/bio-suggestions', (req, res) => {
    const status = req.query.status ? String(req.query.status) : 'pending';
    try {
      const list = repo.listBioSuggestions({ status, limit: 200 }) || [];
      // Enrich chat-target rows with chat name for the UI.
      const out = list.map((s) => {
        if (s.target === 'chat' && s.chat_id) {
          const c = repo.getChat(s.chat_id);
          return { ...s, chat_name: c ? c.name : null };
        }
        return s;
      });
      res.json({ suggestions: out });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post('/bio-suggestions/:id/accept', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const db = getDb();
    const s = db.prepare(`SELECT * FROM bio_suggestions WHERE id = ?`).get(id);
    if (!s) return res.status(404).json({ error: 'suggestion not found' });
    if (s.status !== 'pending') return res.status(400).json({ error: 'suggestion not pending' });
    try {
      if (s.target === 'chat') {
        if (!s.chat_id) return res.status(400).json({ error: 'suggestion missing chat_id' });
        repo.addMemory(s.chat_id, { note: s.note, source: 'auto', pinned: false });
      } else if (s.target === 'user') {
        const profile = repo.getUserProfile();
        const existing = profile.bio_full ? String(profile.bio_full) : '';
        const next = existing.trim().length
          ? `${existing.trimEnd()}\n- ${s.note}`
          : `- ${s.note}`;
        repo.updateUserProfile({ bio_full: next });
      } else {
        return res.status(400).json({ error: 'unknown target' });
      }
      repo.resolveBioSuggestion(id, 'accepted');
      bus.emit('bio_suggestion', { action: 'accepted', id, chatId: s.chat_id || null, target: s.target });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.post('/bio-suggestions/:id/dismiss', (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) return res.status(400).json({ error: 'invalid id' });
    const db = getDb();
    const s = db.prepare(`SELECT * FROM bio_suggestions WHERE id = ?`).get(id);
    if (!s) return res.status(404).json({ error: 'suggestion not found' });
    if (s.status !== 'pending') return res.status(400).json({ error: 'suggestion not pending' });
    try {
      repo.resolveBioSuggestion(id, 'dismissed');
      bus.emit('bio_suggestion', { action: 'dismissed', id, chatId: s.chat_id || null, target: s.target });
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  // ---------- summaries ----------
  //
  // Plan/Roadmap view: generate Markdown summaries from chat history, store
  // them in folders, and offer MD/PDF downloads. The frontend lives in
  // public/js/summaries.js and uses these endpoints exclusively.

  // Translate the frontend's body shape (`last_n` / `from_ts` / `to_ts` /
  // `range_kind: 'last_n'|'time_range'`) into the storage shape
  // (`range_kind: 'last_n'|'range'`, `range_value: string`).
  function normalizeSummaryRange(body) {
    const kind = body.range_kind === 'time_range' || body.range_kind === 'range'
      ? 'range'
      : 'last_n';
    if (kind === 'last_n') {
      const n = Math.max(1, Math.min(2000, Number(body.last_n ?? body.range_value) || 200));
      return { range_kind: 'last_n', range_value: String(n) };
    }
    const from = body.from_ts != null ? Number(body.from_ts) : null;
    const to = body.to_ts != null ? Number(body.to_ts) : null;
    if (Number.isFinite(from) && Number.isFinite(to)) {
      return { range_kind: 'range', range_value: `${from},${to}` };
    }
    // Fallback: caller may have passed a pre-formed "from,to" string.
    if (typeof body.range_value === 'string' && body.range_value.includes(',')) {
      return { range_kind: 'range', range_value: body.range_value };
    }
    throw new Error('Zeitraum unvollständig');
  }

  // Lists available templates (the UI hardcodes its own list, but this
  // endpoint is handy for diagnostics and future UI work).
  router.get('/summaries/templates', (_req, res) => {
    res.json({
      templates: Object.fromEntries(
        Object.entries(SUMMARY_TEMPLATES).map(([k, v]) => [k, { name: v.name, system: v.system }]),
      ),
    });
  });

  router.get('/summaries', (req, res) => {
    const folderId = req.query.folder_id;
    res.json({ summaries: repo.listSummaries({ folderId }) });
  });

  router.get('/summaries/:id', (req, res) => {
    const s = repo.getSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    res.json({ summary: s });
  });

  router.post('/summaries', async (req, res) => {
    const body = req.body || {};
    if (!body.chat_id) return res.status(400).json({ error: 'chat_id required' });
    let range;
    try {
      range = normalizeSummaryRange(body);
    } catch (err) {
      return res.status(400).json({ error: String(err.message || err) });
    }
    try {
      const draft = await generateSummary({
        chatId: body.chat_id,
        template: body.template,
        system_prompt: body.system_prompt,
        range_kind: range.range_kind,
        range_value: range.range_value,
        title: body.title,
      });
      const saved = repo.insertSummary({ ...draft, folder_id: body.folder_id ?? null });
      bus.emit('summary', { action: 'created', summary: saved });
      res.json({ summary: saved });
    } catch (err) {
      log('error', 'summary generation failed', { error: String(err.message || err) });
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.put('/summaries/:id', (req, res) => {
    try {
      const s = repo.updateSummary(req.params.id, req.body || {});
      bus.emit('summary', { action: 'updated', summary: s });
      res.json({ summary: s });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.delete('/summaries/:id', (req, res) => {
    const ok = repo.deleteSummary(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    bus.emit('summary', { action: 'deleted', id: Number(req.params.id) });
    res.json({ ok: true });
  });

  router.get('/summaries/:id/download.md', (req, res) => {
    const s = repo.getSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    const filename = safeFilename(s.title || `summary-${s.id}`) + '.md';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(s.content_md || '');
  });

  router.get('/summaries/:id/download.pdf', async (req, res) => {
    const s = repo.getSummary(req.params.id);
    if (!s) return res.status(404).json({ error: 'not found' });
    try {
      const meta = `${new Date(s.created_at).toLocaleString('de-DE')} · `
        + `${s.message_count} Nachrichten · Vorlage: ${s.template}`;
      const pdf = await renderPdf({ title: s.title, content_md: s.content_md, meta });
      const filename = safeFilename(s.title || `summary-${s.id}`) + '.pdf';
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.send(Buffer.from(pdf));
    } catch (err) {
      log('error', 'summary pdf render failed', { error: String(err.message || err) });
      res.status(500).json({ error: String(err.message || err) });
    }
  });

  router.get('/summary-folders', (_req, res) => {
    res.json({ folders: repo.listSummaryFolders() });
  });

  router.post('/summary-folders', (req, res) => {
    try {
      const f = repo.createSummaryFolder((req.body && req.body.name) || '');
      bus.emit('summary_folder', { action: 'created', folder: f });
      res.json({ folder: f });
    } catch (err) {
      res.status(400).json({ error: String(err.message || err) });
    }
  });

  router.delete('/summary-folders/:id', (req, res) => {
    const ok = repo.deleteSummaryFolder(req.params.id);
    if (!ok) return res.status(404).json({ error: 'not found' });
    bus.emit('summary_folder', { action: 'deleted', id: Number(req.params.id) });
    res.json({ ok: true });
  });

  return router;
}
