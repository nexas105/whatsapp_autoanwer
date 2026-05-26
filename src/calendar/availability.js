// Combines busy events from enabled calendar_sources + user_schedule (busy=1).
//
// Exports:
//   computeBusyBlocks({ from, to })
//   computeFreeSlots({ from, to, dayStart, dayEnd, slotMin })
//   availabilitySummary({ days, dayStart, dayEnd })

import * as repo from '../db/repo.js';

const HHMM_RE = /^(\d{1,2}):(\d{2})$/;
const WEEKDAY_NUM = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseHHMM(s, fallback = 0) {
  const m = HHMM_RE.exec(String(s || ''));
  if (!m) return fallback;
  const h = Math.max(0, Math.min(23, Number(m[1])));
  const mn = Math.max(0, Math.min(59, Number(m[2])));
  return h * 60 + mn;
}

function startOfLocalDay(ts) {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function mergeIntervals(intervals) {
  if (!intervals.length) return [];
  const sorted = [...intervals].sort((a, b) => a.start_ts - b.start_ts);
  const out = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    const last = out[out.length - 1];
    if (cur.start_ts <= last.end_ts) {
      if (cur.end_ts > last.end_ts) last.end_ts = cur.end_ts;
      // Keep first source label when merging.
    } else {
      out.push({ ...cur });
    }
  }
  return out;
}

// Compute busy blocks from calendar_sources (cached events_json) and
// user_schedule entries with busy=1 in the window [from, to].
export function computeBusyBlocks({ from, to } = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const blocks = [];

  // ── Calendar sources ─────────────────────────────────────────────
  let sources = [];
  try { sources = repo.listCalendarSources({ enabledOnly: true }) || []; } catch { sources = []; }
  for (const s of sources) {
    let events;
    try { events = repo.getCalendarSourceEvents(s.id); } catch { events = []; }
    for (const ev of events) {
      if (!Number.isFinite(ev.start_ts) || !Number.isFinite(ev.end_ts)) continue;
      if (ev.end_ts <= from || ev.start_ts >= to) continue;
      blocks.push({
        start_ts: Math.max(ev.start_ts, from),
        end_ts: Math.min(ev.end_ts, to),
        source: s.name || `cal#${s.id}`,
      });
    }
  }

  // ── user_schedule busy entries ────────────────────────────────────
  let entries = [];
  try { entries = repo.listSchedule({ enabledOnly: true }) || []; } catch { entries = []; }
  for (const e of entries) {
    if (!e.busy) continue;
    if (e.kind === 'once') {
      if (!Number.isFinite(e.start_ts)) continue;
      const end = Number.isFinite(e.end_ts) ? e.end_ts : (e.start_ts + 3600 * 1000);
      if (end <= from || e.start_ts >= to) continue;
      blocks.push({
        start_ts: Math.max(e.start_ts, from),
        end_ts: Math.min(end, to),
        source: e.title || 'schedule',
      });
    } else if (e.kind === 'recurring') {
      const tokens = String(e.recurrence || '')
        .split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      if (!tokens.length) continue;
      const startMin = parseHHMM(e.start_time, -1);
      const endMin = parseHHMM(e.end_time, -1);
      if (startMin < 0 || endMin < 0 || endMin <= startMin) continue;
      // Walk every day from `from` until `to`; check if today matches.
      let cursor = startOfLocalDay(from);
      while (cursor < to) {
        const d = new Date(cursor);
        const dow = WEEKDAY_NUM[d.getDay()];
        if (tokens.includes('DAILY') || tokens.includes(dow)) {
          const dayStart = cursor + startMin * 60 * 1000;
          const dayEnd = cursor + endMin * 60 * 1000;
          if (dayEnd > from && dayStart < to) {
            blocks.push({
              start_ts: Math.max(dayStart, from),
              end_ts: Math.min(dayEnd, to),
              source: e.title || 'schedule',
            });
          }
        }
        cursor += 24 * 3600 * 1000;
      }
    }
  }

  return mergeIntervals(blocks);
}

// Split [from, to] into per-day waking windows [dayStart, dayEnd], subtract
// busy blocks, and return remaining free slots ≥ slotMin minutes.
export function computeFreeSlots({
  from,
  to,
  dayStart = '09:00',
  dayEnd = '21:00',
  slotMin = 60,
} = {}) {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return [];
  const startMin = parseHHMM(dayStart, 9 * 60);
  const endMin = parseHHMM(dayEnd, 21 * 60);
  if (endMin <= startMin) return [];
  const slotMinMs = Math.max(1, Number(slotMin) || 60) * 60 * 1000;

  const busy = computeBusyBlocks({ from, to });
  const out = [];

  let cursor = startOfLocalDay(from);
  while (cursor < to) {
    const dayWStart = Math.max(from, cursor + startMin * 60 * 1000);
    const dayWEnd = Math.min(to, cursor + endMin * 60 * 1000);
    if (dayWEnd > dayWStart) {
      // Subtract busy intervals overlapping this day-window.
      const dayBusy = busy
        .filter((b) => b.end_ts > dayWStart && b.start_ts < dayWEnd)
        .map((b) => ({
          start_ts: Math.max(b.start_ts, dayWStart),
          end_ts: Math.min(b.end_ts, dayWEnd),
        }))
        .sort((a, b) => a.start_ts - b.start_ts);

      let cur = dayWStart;
      for (const b of dayBusy) {
        if (b.start_ts > cur) {
          if (b.start_ts - cur >= slotMinMs) {
            out.push({ start_ts: cur, end_ts: b.start_ts });
          }
        }
        if (b.end_ts > cur) cur = b.end_ts;
      }
      if (dayWEnd > cur && dayWEnd - cur >= slotMinMs) {
        out.push({ start_ts: cur, end_ts: dayWEnd });
      }
    }
    cursor += 24 * 3600 * 1000;
  }
  return out;
}

// Helpers used by availabilitySummary.
const SHORT_DOW_DE = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
function fmtDate(ts) {
  const d = new Date(ts);
  return `${SHORT_DOW_DE[d.getDay()]} ${d.getDate()}.${d.getMonth() + 1}.`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function sameLocalDay(a, b) {
  const da = new Date(a); const db = new Date(b);
  return da.getFullYear() === db.getFullYear()
    && da.getMonth() === db.getMonth()
    && da.getDate() === db.getDate();
}

// Markdown summary of the next N days. Skips fully-busy days from the output
// only to the degree that the underlying free/busy data is itself empty.
export function availabilitySummary({
  days = 14,
  dayStart = '09:00',
  dayEnd = '21:00',
} = {}) {
  const now = Date.now();
  const from = startOfLocalDay(now);
  const to = from + Math.max(1, Math.min(60, Number(days) || 14)) * 24 * 3600 * 1000;

  const busy = computeBusyBlocks({ from, to });
  const free = computeFreeSlots({ from, to, dayStart, dayEnd, slotMin: 30 });

  const lines = [];
  for (let d = 0; d < (days || 14); d++) {
    const dayStartMs = from + d * 24 * 3600 * 1000;
    const dayEndMs = dayStartMs + 24 * 3600 * 1000;
    const dayBusy = busy
      .filter((b) => b.end_ts > dayStartMs && b.start_ts < dayEndMs)
      .map((b) => ({
        start_ts: Math.max(b.start_ts, dayStartMs),
        end_ts: Math.min(b.end_ts, dayEndMs),
        source: b.source,
      }));
    const dayFree = free.filter((f) => f.start_ts < dayEndMs && f.end_ts > dayStartMs);

    if (!dayBusy.length && !dayFree.length) continue;

    const parts = [];
    for (const b of dayBusy) {
      const label = b.source ? ` (${b.source})` : '';
      parts.push(`belegt ${fmtTime(b.start_ts)}–${fmtTime(b.end_ts)}${label}`);
    }
    for (const f of dayFree) {
      parts.push(`frei ${fmtTime(f.start_ts)}–${fmtTime(f.end_ts)}`);
    }
    const prefix = sameLocalDay(dayStartMs, now) ? `Heute (${fmtDate(dayStartMs)})` : fmtDate(dayStartMs);
    lines.push(`${prefix}: ${parts.join(' · ')}`);
  }
  return lines.join('\n');
}
