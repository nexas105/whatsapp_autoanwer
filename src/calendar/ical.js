// Tiny dependency-free .ics parser sufficient for our needs.
//
// Supports:
// - VEVENT blocks with SUMMARY / DTSTART / DTEND / UID / EXDATE / RRULE
// - DTSTART formats:
//     DTSTART:20260526T180000Z         (UTC)
//     DTSTART:20260526T180000          (floating → treated as local wall-clock)
//     DTSTART;VALUE=DATE:20260526      (all-day)
//     DTSTART;TZID=Europe/Berlin:20260526T180000  (TZID → resolved via Intl)
// - DTEND missing for non-all-day → +1h default
// - RRULE (minimal):
//     FREQ=WEEKLY[;BYDAY=MO,TU,WE,TH,FR,SA,SU][;INTERVAL=n][;COUNT=n][;UNTIL=...]
//     FREQ=DAILY[;INTERVAL=n][;COUNT=n][;UNTIL=...]
//   We expand only up to 90 days from now.
// - EXDATE — skips those occurrence start dates (compared as DATE if all-day,
//   else as exact ms timestamp).
//
// NOT supported (intentionally — out of scope for our 90-day window):
// - FREQ=MONTHLY, YEARLY, HOURLY, MINUTELY
// - BYMONTH, BYMONTHDAY, BYYEARDAY, BYSETPOS, BYHOUR, BYMINUTE
// - WKST (we assume Monday for BYDAY anchoring; week start doesn't affect
//   WEEKLY+BYDAY semantics in practice)
// - RDATE additions (only EXDATE for skips)
// - RECURRENCE-ID / overrides on instances
// - VTIMEZONE blocks — we trust Intl.DateTimeFormat for the named tz
//
// Public API:
//   fetchAndParse(icalUrl, opts) -> Promise<Array<{uid, summary, start_ts, end_ts, all_day}>>
//   parseIcs(text)               -> same (no network)

const HORIZON_DAYS_PAST = 1;
const HORIZON_DAYS_FUTURE = 90;
const WEEKDAY_BYDAY = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const WEEKDAY_BYDAY_TO_NUM = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Unfold lines that are continuation (start with space or tab after a newline).
function unfoldLines(text) {
  // ICS folding: a CRLF followed by space/tab continues the previous line.
  const normalized = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = [];
  for (const raw of normalized.split('\n')) {
    if (raw.length === 0) continue;
    if ((raw[0] === ' ' || raw[0] === '\t') && lines.length) {
      lines[lines.length - 1] += raw.slice(1);
    } else {
      lines.push(raw);
    }
  }
  return lines;
}

// Parse a key (with params) and value off a single content line.
function parsePropLine(line) {
  const colon = line.indexOf(':');
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = head.split(';');
  const name = parts.shift().toUpperCase();
  const params = {};
  for (const p of parts) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  return { name, params, value };
}

// Unescape iCal-encoded text fields (mainly SUMMARY).
function unescapeIcsText(s) {
  return String(s || '')
    .replace(/\\n/gi, '\n')
    .replace(/\\,/g, ',')
    .replace(/\\;/g, ';')
    .replace(/\\\\/g, '\\');
}

// Parse a YYYYMMDD or YYYYMMDDTHHmmss(Z) string into {y,m,d,hh,mm,ss,utc,dateOnly}.
function parseDateParts(value) {
  const v = String(value || '').trim();
  // DATE-only: YYYYMMDD
  if (/^\d{8}$/.test(v)) {
    return {
      y: Number(v.slice(0, 4)),
      m: Number(v.slice(4, 6)),
      d: Number(v.slice(6, 8)),
      hh: 0, mm: 0, ss: 0,
      utc: false,
      dateOnly: true,
    };
  }
  // DATETIME: YYYYMMDDTHHmmss[Z]
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return null;
  return {
    y: Number(m[1]), m: Number(m[2]), d: Number(m[3]),
    hh: Number(m[4]), mm: Number(m[5]), ss: Number(m[6]),
    utc: m[7] === 'Z',
    dateOnly: false,
  };
}

// Get the UTC ms offset for `wallTimeMs` interpreted as wall-clock in `tzid`.
// Uses Intl.DateTimeFormat to derive the timezone offset for that instant.
function tzOffsetMs(tzid, y, m, d, hh, mm, ss) {
  // Iterate: start by treating walls as UTC, compute the tz offset for that
  // instant, then subtract to get the actual UTC ms. One pass is enough for
  // mainstream tz behavior near transitions in our 90-day horizon.
  const utcGuess = Date.UTC(y, m - 1, d, hh, mm, ss);
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tzid,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const parts = fmt.formatToParts(new Date(utcGuess));
    const map = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    const asUtc = Date.UTC(
      Number(map.year),
      Number(map.month) - 1,
      Number(map.day),
      Number(map.hour) === 24 ? 0 : Number(map.hour),
      Number(map.minute),
      Number(map.second),
    );
    return asUtc - utcGuess;
  } catch {
    return 0; // unknown tz → fall back to UTC
  }
}

// Resolve a parsed datetime + TZID to a ms timestamp.
//   utc=true            -> Date.UTC()
//   tzid set            -> wall-clock in tzid → ms via Intl offset
//   floating (no tzid)  -> treat as local wall-clock
//   dateOnly            -> midnight UTC of that day
function toMs(parts, tzid) {
  if (!parts) return null;
  if (parts.dateOnly) return Date.UTC(parts.y, parts.m - 1, parts.d, 0, 0, 0);
  if (parts.utc) return Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
  if (tzid) {
    const utcAsIfWall = Date.UTC(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss);
    const offset = tzOffsetMs(tzid, parts.y, parts.m, parts.d, parts.hh, parts.mm, parts.ss);
    return utcAsIfWall - offset;
  }
  // floating: interpret as local wall-clock
  return new Date(parts.y, parts.m - 1, parts.d, parts.hh, parts.mm, parts.ss).getTime();
}

// Parse an RRULE value string into a plain object.
function parseRrule(value) {
  const out = {};
  for (const p of String(value || '').split(';')) {
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    out[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1);
  }
  if (out.BYDAY) {
    out.BYDAY = out.BYDAY.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  }
  if (out.INTERVAL) out.INTERVAL = Math.max(1, Number(out.INTERVAL) || 1);
  if (out.COUNT) out.COUNT = Math.max(0, Number(out.COUNT) || 0);
  return out;
}

// Expand a single VEVENT into [{uid, summary, start_ts, end_ts, all_day}, ...]
// Limited to [windowStartMs, windowEndMs).
function expandEvent(ev, windowStartMs, windowEndMs) {
  const out = [];
  if (!ev.startParts) return out;
  const tzid = ev.tzid || null;
  const startMs = toMs(ev.startParts, tzid);
  if (!Number.isFinite(startMs)) return out;
  let endMs;
  if (ev.endParts) {
    endMs = toMs(ev.endParts, ev.endTzid || tzid);
  } else if (ev.startParts.dateOnly) {
    // VALUE=DATE with no DTEND → single full day.
    endMs = startMs + 24 * 3600 * 1000;
  } else {
    endMs = startMs + 3600 * 1000;
  }
  const durationMs = Math.max(0, endMs - startMs);

  // Build EXDATE set as a Set of ms timestamps (or YYYY-MM-DD strings for all-day).
  const exdateSet = new Set();
  for (const ex of ev.exdates || []) {
    const exParts = parseDateParts(ex.value);
    if (!exParts) continue;
    if (exParts.dateOnly) {
      exdateSet.add(`${exParts.y}-${exParts.m}-${exParts.d}`);
    } else {
      const exMs = toMs(exParts, ex.params.TZID || tzid);
      if (Number.isFinite(exMs)) exdateSet.add(`ms:${exMs}`);
    }
  }

  function exdateKey(ms, dateOnly) {
    if (dateOnly) {
      const d = new Date(ms);
      // Use UTC components because all-day dates are stored as UTC midnight.
      return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
    }
    return `ms:${ms}`;
  }

  function pushIfInWindow(occStartMs) {
    if (occStartMs >= windowEndMs) return false;
    const occEnd = occStartMs + durationMs;
    if (occEnd < windowStartMs) return true; // before window — keep iterating
    if (exdateSet.has(exdateKey(occStartMs, ev.startParts.dateOnly))) return true;
    out.push({
      uid: ev.uid || null,
      summary: ev.summary || '',
      start_ts: occStartMs,
      end_ts: occEnd,
      all_day: !!ev.startParts.dateOnly,
    });
    return true;
  }

  if (!ev.rrule) {
    pushIfInWindow(startMs);
    return out;
  }

  // ─── RRULE expansion ─────────────────────────────────────────────
  const rule = ev.rrule;
  const freq = String(rule.FREQ || '').toUpperCase();
  const interval = rule.INTERVAL || 1;
  const count = rule.COUNT != null ? rule.COUNT : null;
  let untilMs = Infinity;
  if (rule.UNTIL) {
    const uParts = parseDateParts(rule.UNTIL);
    if (uParts) untilMs = toMs(uParts, uParts.utc ? null : tzid);
  }

  const hardCap = Math.min(windowEndMs, untilMs);

  if (freq === 'DAILY') {
    let emitted = 0;
    for (let i = 0; i < 400; i++) { // safety cap; 90d / 1d * a bit
      if (count != null && emitted >= count) break;
      const occ = startMs + i * interval * 24 * 3600 * 1000;
      if (occ > hardCap) break;
      const keep = pushIfInWindow(occ);
      // pushIfInWindow returns false only if past window end (so we can stop).
      if (!keep) break;
      emitted++;
    }
    return out;
  }

  if (freq === 'WEEKLY') {
    const byday = Array.isArray(rule.BYDAY) && rule.BYDAY.length
      ? rule.BYDAY
      : [WEEKDAY_BYDAY[new Date(startMs).getUTCDay()]];
    const targetDow = new Set(byday.map((d) => WEEKDAY_BYDAY_TO_NUM[d]).filter((n) => n != null));
    if (!targetDow.size) {
      pushIfInWindow(startMs);
      return out;
    }
    // Walk week by week starting at the week containing startMs.
    // For each matching weekday within the week, emit (if at/after startMs).
    let emitted = 0;
    // Find the Monday-anchored week start (UTC) of startMs.
    const start = new Date(startMs);
    // Use UTC day-of-week for stability.
    const dowStart = start.getUTCDay();
    // Anchor to the day-of-week of the start instance — we walk weeks from there.
    for (let w = 0; w < 100; w++) { // 90d/7d ≈ 13 weeks; cap generous
      const weekOffsetMs = w * interval * 7 * 24 * 3600 * 1000;
      // For each day in the week relative to startMs's dow.
      for (let off = 0; off < 7; off++) {
        const dow = (dowStart + off) % 7;
        if (!targetDow.has(dow)) continue;
        const occ = startMs + weekOffsetMs + off * 24 * 3600 * 1000;
        if (occ < startMs) continue;
        if (count != null && emitted >= count) return out;
        if (occ > hardCap) return out;
        const keep = pushIfInWindow(occ);
        if (!keep) return out;
        emitted++;
      }
    }
    return out;
  }

  // Unsupported FREQ — fall back to first occurrence only.
  pushIfInWindow(startMs);
  return out;
}

// Parse an entire .ics text into a list of expanded occurrences.
export function parseIcs(text, { now = Date.now() } = {}) {
  const lines = unfoldLines(text);
  const events = [];
  let cur = null;

  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') {
      cur = { uid: null, summary: '', exdates: [], tzid: null, endTzid: null };
      continue;
    }
    if (line === 'END:VEVENT') {
      if (cur) events.push(cur);
      cur = null;
      continue;
    }
    if (!cur) continue;
    const prop = parsePropLine(line);
    if (!prop) continue;
    switch (prop.name) {
      case 'UID':
        cur.uid = prop.value;
        break;
      case 'SUMMARY':
        cur.summary = unescapeIcsText(prop.value);
        break;
      case 'DTSTART':
        cur.startParts = parseDateParts(prop.value);
        if (prop.params.TZID) cur.tzid = prop.params.TZID;
        break;
      case 'DTEND':
        cur.endParts = parseDateParts(prop.value);
        if (prop.params.TZID) cur.endTzid = prop.params.TZID;
        break;
      case 'RRULE':
        cur.rrule = parseRrule(prop.value);
        break;
      case 'EXDATE':
        // EXDATE can have multiple comma-separated values on one line.
        for (const v of String(prop.value || '').split(',')) {
          cur.exdates.push({ value: v.trim(), params: prop.params || {} });
        }
        break;
      default:
        break;
    }
  }

  const windowStart = now - HORIZON_DAYS_PAST * 24 * 3600 * 1000;
  const windowEnd = now + HORIZON_DAYS_FUTURE * 24 * 3600 * 1000;
  const out = [];
  for (const ev of events) {
    const occs = expandEvent(ev, windowStart, windowEnd);
    for (const o of occs) out.push(o);
  }
  // Sort by start time for deterministic UI/availability output.
  out.sort((a, b) => a.start_ts - b.start_ts);
  return out;
}

// Fetch + parse a remote iCal URL.
export async function fetchAndParse(icalUrl, { timeoutMs = 15000 } = {}) {
  if (!icalUrl || typeof icalUrl !== 'string') {
    throw new Error('icalUrl required');
  }
  // Some calendar providers expose webcal:// URLs — normalize to https.
  let url = icalUrl.trim();
  if (/^webcal:\/\//i.test(url)) url = url.replace(/^webcal:\/\//i, 'https://');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res;
  try {
    res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': 'whatsapp-autoanswer/1.0 ical-fetch' },
    });
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) {
    throw new Error(`iCal fetch ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  return parseIcs(text);
}
