// Scheduler for scheduled_messages: cron, once, after_silence.
//
// Contract:
//   export function startScheduler({ wa }) -> { stop, runNow(id), rescanSchedules }
//
// On startup, loads all enabled schedules from the DB, computes their next
// run-time and arms an in-memory timer. A rescan tick every 60s catches new /
// edited / disabled schedules that bypassed the REST layer's emit.

import * as repo from '../db/repo.js';
import { getDb } from '../db/index.js';
import { runAi } from '../cli/wrapper.js';
import { config } from '../config.js';
import { bus, log } from '../events.js';

// ─── cron parser (5-field: minute hour day-of-month month day-of-week) ─────
// Field bounds: minute 0-59, hour 0-23, dom 1-31, month 1-12, dow 0-6 (Sun=0).
const FIELDS = [
  ['minute', 0, 59],
  ['hour', 0, 23],
  ['dom', 1, 31],
  ['month', 1, 12],
  ['dow', 0, 6],
];

// Parses one field of a cron expression. Returns either a Set<number> of
// matching values OR null (meaning "*" — every value matches).
export function parseCronField(field, range) {
  const [min, max] = range;
  if (field == null) throw new Error('cron field missing');
  const raw = String(field).trim();
  if (!raw) throw new Error('cron field empty');
  if (raw === '*') return null;

  const out = new Set();
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error('empty cron piece');
    // step like */15, 0-30/5 or *
    let stepStr = null;
    let body = piece;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      body = piece.slice(0, slash).trim();
      stepStr = piece.slice(slash + 1).trim();
    }
    const step = stepStr != null ? Number(stepStr) : 1;
    if (!Number.isFinite(step) || step <= 0) throw new Error(`bad cron step: ${piece}`);

    let lo, hi;
    if (body === '*' || body === '') {
      lo = min; hi = max;
    } else if (body.includes('-')) {
      const [a, b] = body.split('-').map((s) => s.trim());
      lo = Number(a); hi = Number(b);
      if (!Number.isFinite(lo) || !Number.isFinite(hi)) throw new Error(`bad cron range: ${piece}`);
    } else {
      const n = Number(body);
      if (!Number.isFinite(n)) throw new Error(`bad cron value: ${piece}`);
      lo = n; hi = stepStr != null ? max : n;
    }

    if (lo < min || hi > max || lo > hi) {
      throw new Error(`cron value out of range [${min}-${max}]: ${piece}`);
    }

    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr) {
  const parts = String(expr || '').trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error(`cron must have 5 fields, got ${parts.length}`);
  }
  return {
    minute: parseCronField(parts[0], [0, 59]),
    hour: parseCronField(parts[1], [0, 23]),
    dom: parseCronField(parts[2], [1, 31]),
    month: parseCronField(parts[3], [1, 12]),
    dow: parseCronField(parts[4], [0, 6]),
  };
}

function matches(set, val) {
  return set === null || set.has(val);
}

// Walk minutes forward from `fromMs` (exclusive) until a match. Caps at 366d.
export function nextCronMatch(parsed, fromMs) {
  const start = new Date(fromMs);
  // Round down to the minute, then add 1m (so we always look at future minutes).
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);
  const limit = fromMs + 366 * 24 * 60 * 60 * 1000;
  const cur = new Date(start);
  while (cur.getTime() <= limit) {
    const m = cur.getMinutes();
    const h = cur.getHours();
    const dom = cur.getDate();
    const month = cur.getMonth() + 1;
    const dow = cur.getDay();
    if (
      matches(parsed.minute, m) &&
      matches(parsed.hour, h) &&
      matches(parsed.month, month) &&
      // Posix cron: if BOTH dom and dow are restricted, match either.
      // If one is "*", the other must match. We keep this simple by requiring both unless one is "*".
      ((parsed.dom === null && parsed.dow === null) ||
       (parsed.dom !== null && parsed.dow !== null && (parsed.dom.has(dom) || parsed.dow.has(dow))) ||
       (parsed.dom === null && parsed.dow.has(dow)) ||
       (parsed.dow === null && parsed.dom.has(dom)))
    ) {
      return cur.getTime();
    }
    cur.setMinutes(cur.getMinutes() + 1);
  }
  return null;
}

// ─── after_silence helper ────────────────────────────────────────────
function lastIncomingTimestamp(chatId) {
  if (!chatId) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT MAX(timestamp) AS ts FROM messages
    WHERE chat_id = ? AND from_me = 0
  `).get(chatId);
  return row && row.ts ? Number(row.ts) : null;
}

// ─── public computeNextRun ───────────────────────────────────────────
export function computeNextRun(schedule, now = Date.now()) {
  if (!schedule || !schedule.enabled) return null;
  const kind = schedule.schedule_kind || 'cron';
  const spec = String(schedule.schedule_spec || '').trim();
  try {
    if (kind === 'cron') {
      const parsed = parseCron(spec);
      return nextCronMatch(parsed, now);
    }
    if (kind === 'once') {
      const t = Date.parse(spec);
      if (!Number.isFinite(t)) return null;
      if (t <= now) return null;
      return t;
    }
    if (kind === 'after_silence') {
      const seconds = Number(spec);
      if (!Number.isFinite(seconds) || seconds <= 0) return null;
      if (!schedule.chat_id) return null; // global silence unsupported per spec
      const last = lastIncomingTimestamp(schedule.chat_id);
      if (!last) {
        // No incoming yet — fire soon (30s).
        return now + 30_000;
      }
      const fireAt = last + seconds * 1000;
      if (fireAt <= now) return now + 30_000;
      return fireAt;
    }
  } catch (err) {
    log('warn', 'computeNextRun failed', { id: schedule.id, kind, error: String(err) });
    return null;
  }
  return null;
}

// ─── target resolution ──────────────────────────────────────────────
function matchesFilter(chat, filter) {
  if (!filter) return true;
  if (filter.auto_reply != null) {
    const want = filter.auto_reply ? 1 : 0;
    if ((chat.auto_reply ? 1 : 0) !== want) return false;
  }
  if (filter.persona_id != null) {
    if (String(chat.persona_id || '') !== String(filter.persona_id)) return false;
  }
  if (filter.has_persona != null) {
    const has = !!chat.persona_id;
    if (has !== !!filter.has_persona) return false;
  }
  return true;
}

function resolveTargets(schedule) {
  if (schedule.chat_id) {
    const c = repo.getChat(schedule.chat_id);
    return c ? [c] : [];
  }
  let filter = null;
  if (schedule.target_filter) {
    try { filter = JSON.parse(schedule.target_filter); } catch { filter = null; }
  }
  const all = repo.listChats({ limit: 1000 });
  return all.filter((c) => matchesFilter(c, filter));
}

// ─── scheduler ──────────────────────────────────────────────────────
export function startScheduler({ wa }) {
  const timers = new Map(); // id -> NodeJS.Timeout
  let rescanInterval = null;
  let stopped = false;

  function clearTimer(id) {
    const t = timers.get(id);
    if (t) {
      try { clearTimeout(t); } catch { /* ignore */ }
      timers.delete(id);
    }
  }

  function armTimer(id, delayMs) {
    clearTimer(id);
    const d = Math.max(0, Math.min(0x7fffffff, Number(delayMs) || 0));
    const handle = setTimeout(() => {
      timers.delete(id);
      fire(id).catch((err) => log('error', 'scheduler.fire crashed', { id, error: String(err) }));
    }, d);
    timers.set(id, handle);
  }

  function schedule(s) {
    if (stopped) return;
    if (!s || !s.enabled) {
      clearTimer(s?.id);
      return;
    }
    const next = computeNextRun(s);
    if (!next) {
      clearTimer(s.id);
      // Persist cached value as null for the UI.
      try { repo.updateScheduledMessage(s.id, { next_run_at: null }); } catch { /* ignore */ }
      return;
    }
    try { repo.updateScheduledMessage(s.id, { next_run_at: next }); } catch { /* ignore */ }
    armTimer(s.id, next - Date.now());
  }

  async function fire(id) {
    if (stopped) return;
    const s = repo.getScheduledMessage(id);
    if (!s) return;
    if (!s.enabled) { clearTimer(id); return; }

    const targets = resolveTargets(s);
    if (!targets.length) {
      const result = 'no targets';
      try {
        repo.updateScheduledMessage(id, {
          last_run_at: Date.now(),
          last_result: result,
          next_run_at: computeNextRun({ ...s, last_run_at: Date.now() }),
        });
      } catch { /* ignore */ }
      bus.emit('schedule', { action: 'fired', scheduleId: id, count: 0, result });
      // Re-arm for cron / after_silence
      const fresh = repo.getScheduledMessage(id);
      schedule(fresh);
      return;
    }

    const ready = wa && typeof wa.getState === 'function' && wa.getState().status === 'ready';
    let sentCount = 0;
    let firstErr = null;

    for (const chat of targets) {
      try {
        let text;
        if (s.mode === 'fixed') {
          text = String(s.prompt || '').trim();
        } else {
          // ai mode: build a prompt with chat context.
          const settings = repo.getSettings(chat.id);
          const ctxN = Number(settings.context_messages || config.defaults.contextMessages || 20);
          const recent = repo.lastMessages(chat.id, ctxN);

          // Persona block
          let personaPrompt = '';
          if (settings.persona_id) {
            const p = repo.getPersona(settings.persona_id);
            if (p) personaPrompt = p.prompt;
          }

          const lines = [];
          if (personaPrompt) {
            lines.push('--- Persona ---');
            lines.push(personaPrompt);
            lines.push('--- /Persona ---');
            lines.push('');
          }
          lines.push(String(s.prompt || '').trim());
          lines.push('');
          lines.push('Verlauf:');
          for (const m of recent) {
            const body = (m.body && String(m.body).trim())
              || (m.transcript ? `🎤 ${String(m.transcript).trim()}` : '');
            if (!body) continue;
            if (m.from_me === 1 || m.from_me === true) lines.push(`Me: ${body}`);
            else if (chat.is_group && m.author) lines.push(`Them (${m.author}): ${body}`);
            else lines.push(`Them: ${body}`);
          }
          lines.push('');
          lines.push('Antwort:');
          const prompt = lines.join('\n');

          const raw = await runAi(prompt);
          text = String(raw || '').trim();
        }

        if (!text) {
          log('warn', 'schedule produced empty text', { id, chatId: chat.id });
          continue;
        }

        if (!ready) {
          log('info', 'schedule skipped — wa not ready', { id, chatId: chat.id });
          continue;
        }

        try { await wa.sendTyping(chat.id, Math.min(3000, Math.max(800, text.length * 30))); } catch { /* ignore */ }
        await wa.sendMessage(chat.id, text, { isAuto: true });
        sentCount++;
      } catch (err) {
        firstErr = firstErr || err;
        log('error', 'schedule send failed', { id, chatId: chat.id, error: String(err) });
      }
    }

    const result = firstErr
      ? `error: ${String(firstErr.message || firstErr).slice(0, 120)} (sent ${sentCount}/${targets.length})`
      : `sent to ${sentCount} chat(s)`;

    try {
      repo.updateScheduledMessage(id, {
        last_run_at: Date.now(),
        last_result: result,
        next_run_at: null, // will be set by schedule() below
      });
    } catch { /* ignore */ }

    bus.emit('schedule', {
      action: 'fired',
      scheduleId: id,
      count: sentCount,
      error: firstErr ? String(firstErr) : undefined,
    });

    // Re-arm: cron + after_silence loop; once is one-shot and computeNextRun returns null.
    const fresh = repo.getScheduledMessage(id);
    schedule(fresh);
  }

  function rescanSchedules() {
    if (stopped) return;
    let rows;
    try {
      rows = repo.listScheduledMessages({ enabledOnly: true });
    } catch (err) {
      log('error', 'scheduler rescan failed to list', { error: String(err) });
      return;
    }
    const enabledIds = new Set(rows.map((r) => r.id));
    // Clear timers for schedules no longer enabled / present.
    for (const id of [...timers.keys()]) {
      if (!enabledIds.has(id)) clearTimer(id);
    }
    // Arm timers for any missing.
    for (const s of rows) {
      if (!timers.has(s.id)) schedule(s);
    }
  }

  // initial pass
  rescanSchedules();
  rescanInterval = setInterval(rescanSchedules, 60_000);

  function runNow(id) {
    return fire(Number(id));
  }

  function stop() {
    stopped = true;
    if (rescanInterval) { clearInterval(rescanInterval); rescanInterval = null; }
    for (const id of [...timers.keys()]) clearTimer(id);
  }

  return { stop, runNow, rescanSchedules };
}
