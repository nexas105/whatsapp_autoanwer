import { getDb } from '../index.js';

// ---------- user_profile ----------
export function getUserProfile() {
  const db = getDb();
  return db.prepare(`SELECT * FROM user_profile WHERE id = 1`).get() || {
    id: 1, name: null, bio_short: null, bio_full: null,
    mood_today: null, energy_today: null, current_focus: null,
    mood_set_at: null, updated_at: null,
  };
}

export function updateUserProfile(patch) {
  const db = getDb();
  const cur = getUserProfile();
  const moodFieldChanged = patch.mood_today !== undefined
    || patch.energy_today !== undefined
    || patch.current_focus !== undefined;
  const next = {
    name: patch.name !== undefined ? patch.name : cur.name,
    bio_short: patch.bio_short !== undefined ? patch.bio_short : cur.bio_short,
    bio_full: patch.bio_full !== undefined ? patch.bio_full : cur.bio_full,
    mood_today: patch.mood_today !== undefined ? patch.mood_today : cur.mood_today,
    energy_today: patch.energy_today !== undefined ? patch.energy_today : cur.energy_today,
    current_focus: patch.current_focus !== undefined ? patch.current_focus : cur.current_focus,
    mood_set_at: moodFieldChanged ? Date.now() : cur.mood_set_at,
    updated_at: Date.now(),
  };
  db.prepare(`
    UPDATE user_profile SET name=?, bio_short=?, bio_full=?, mood_today=?, energy_today=?,
      current_focus=?, mood_set_at=?, updated_at=?
    WHERE id = 1
  `).run(next.name, next.bio_short, next.bio_full, next.mood_today, next.energy_today,
         next.current_focus, next.mood_set_at, next.updated_at);
  return getUserProfile();
}

// Reset stale mood/energy/focus after >18h.
export function resetStaleMood({ maxAgeMs = 18 * 3600 * 1000 } = {}) {
  const db = getDb();
  const p = getUserProfile();
  if (!p.mood_set_at) return false;
  if (Date.now() - p.mood_set_at < maxAgeMs) return false;
  db.prepare(`UPDATE user_profile SET mood_today=NULL, energy_today=NULL, current_focus=NULL, mood_set_at=NULL, updated_at=? WHERE id=1`)
    .run(Date.now());
  return true;
}

// ---------- user_schedule ----------
const VALID_SCHEDULE_KIND = new Set(['once', 'recurring']);
const VALID_RECURRENCE_TOKENS = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN', 'DAILY']);

function validateScheduleEntry(p) {
  if (!p.title || !String(p.title).trim()) throw new Error('title required');
  const kind = p.kind || 'once';
  if (!VALID_SCHEDULE_KIND.has(kind)) throw new Error('invalid kind');
  if (kind === 'once') {
    if (!p.start_ts) throw new Error('start_ts required for once');
  } else {
    if (!p.start_time || !/^\d{1,2}:\d{2}$/.test(p.start_time)) throw new Error('start_time HH:MM required');
    if (!p.end_time || !/^\d{1,2}:\d{2}$/.test(p.end_time)) throw new Error('end_time HH:MM required');
    if (!p.recurrence) throw new Error('recurrence required');
    const tokens = String(p.recurrence).split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
    if (!tokens.length || !tokens.every((t) => VALID_RECURRENCE_TOKENS.has(t))) {
      throw new Error('recurrence must be comma list of MON,TUE,...,SUN or DAILY');
    }
  }
}

export function listSchedule({ enabledOnly = false } = {}) {
  const db = getDb();
  const sql = enabledOnly
    ? `SELECT * FROM user_schedule WHERE enabled = 1 ORDER BY kind ASC, id ASC`
    : `SELECT * FROM user_schedule ORDER BY id ASC`;
  return db.prepare(sql).all();
}

export function getScheduleEntry(id) {
  const db = getDb();
  return db.prepare(`SELECT * FROM user_schedule WHERE id = ?`).get(Number(id));
}

export function insertScheduleEntry(p) {
  validateScheduleEntry(p);
  const db = getDb();
  const t = Date.now();
  const info = db.prepare(`
    INSERT INTO user_schedule (kind, title, notes, start_ts, end_ts, start_time, end_time, recurrence, busy, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    p.kind || 'once',
    p.title.trim(),
    p.notes ?? null,
    p.start_ts ?? null,
    p.end_ts ?? null,
    p.start_time ?? null,
    p.end_time ?? null,
    p.recurrence ?? null,
    p.busy === false ? 0 : 1,
    p.enabled === false ? 0 : 1,
    t, t,
  );
  return getScheduleEntry(Number(info.lastInsertRowid));
}

export function updateScheduleEntry(id, p) {
  const db = getDb();
  const cur = getScheduleEntry(id);
  if (!cur) throw new Error('schedule entry not found');
  const merged = {
    kind: p.kind ?? cur.kind,
    title: p.title !== undefined ? p.title : cur.title,
    notes: p.notes !== undefined ? p.notes : cur.notes,
    start_ts: p.start_ts !== undefined ? p.start_ts : cur.start_ts,
    end_ts: p.end_ts !== undefined ? p.end_ts : cur.end_ts,
    start_time: p.start_time !== undefined ? p.start_time : cur.start_time,
    end_time: p.end_time !== undefined ? p.end_time : cur.end_time,
    recurrence: p.recurrence !== undefined ? p.recurrence : cur.recurrence,
    busy: p.busy != null ? (p.busy ? 1 : 0) : cur.busy,
    enabled: p.enabled != null ? (p.enabled ? 1 : 0) : cur.enabled,
  };
  validateScheduleEntry(merged);
  db.prepare(`
    UPDATE user_schedule SET kind=?, title=?, notes=?, start_ts=?, end_ts=?, start_time=?, end_time=?, recurrence=?, busy=?, enabled=?, updated_at=?
    WHERE id=?
  `).run(
    merged.kind, merged.title, merged.notes, merged.start_ts, merged.end_ts,
    merged.start_time, merged.end_time, merged.recurrence, merged.busy, merged.enabled,
    Date.now(), Number(id),
  );
  return getScheduleEntry(id);
}

export function deleteScheduleEntry(id) {
  const db = getDb();
  return db.prepare(`DELETE FROM user_schedule WHERE id = ?`).run(Number(id)).changes > 0;
}

const WEEKDAY_NUM = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

// Returns currently active + upcoming-within-window schedule entries.
export function currentScheduleStatus({ now = Date.now(), windowMs = 24 * 3600 * 1000 } = {}) {
  const all = listSchedule({ enabledOnly: true });
  const d = new Date(now);
  const todayDow = WEEKDAY_NUM[d.getDay()];
  const tomorrowDow = WEEKDAY_NUM[(d.getDay() + 1) % 7];
  const minutesNow = d.getHours() * 60 + d.getMinutes();
  function parseHHMM(s) {
    const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  }
  const active = [];
  const upcoming = [];
  for (const e of all) {
    if (e.kind === 'once') {
      if (!e.start_ts) continue;
      const start = e.start_ts;
      const end = e.end_ts || (start + 3600 * 1000);
      if (now >= start && now < end) active.push({ ...e, _start: start, _end: end });
      else if (start > now && start - now <= windowMs) upcoming.push({ ...e, _start: start, _end: end });
    } else {
      const tokens = String(e.recurrence || '').split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      const startMin = parseHHMM(e.start_time);
      const endMin = parseHHMM(e.end_time);
      if (startMin == null || endMin == null) continue;
      const todayMatches = tokens.includes('DAILY') || tokens.includes(todayDow);
      const tomorrowMatches = tokens.includes('DAILY') || tokens.includes(tomorrowDow);
      if (todayMatches) {
        if (minutesNow >= startMin && minutesNow < endMin) {
          active.push({ ...e, _today: true, _startMin: startMin, _endMin: endMin });
        } else if (startMin > minutesNow) {
          upcoming.push({ ...e, _today: true, _startMin: startMin, _endMin: endMin });
        }
      }
      if (!todayMatches && tomorrowMatches) {
        const tomorrowStart = new Date(d);
        tomorrowStart.setDate(d.getDate() + 1);
        tomorrowStart.setHours(Math.floor(startMin / 60), startMin % 60, 0, 0);
        if (tomorrowStart.getTime() - now <= windowMs) {
          upcoming.push({ ...e, _today: false, _startMin: startMin, _endMin: endMin });
        }
      }
    }
  }
  return { active, upcoming, now, todayDow };
}

// Date/time keyword detector — used to decide whether to inject schedule context.
const DATE_TIME_HINTS = /\b(wann|treffen|treff|datum|termin|morgen|übermorgen|heute|jetzt|später|gleich|abend|nachmittag|vormittag|woche|wochenende|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|\d{1,2}\s*uhr|\d{1,2}:\d{2}|\d{1,2}\.\s*\d{1,2})\b/i;
export function hasDateTimeHint(text) {
  if (!text) return false;
  return DATE_TIME_HINTS.test(String(text));
}
