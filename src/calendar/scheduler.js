// Periodic refresher for enabled calendar_sources.
//
// On startup + every 15 minutes, iterate enabled sources, call fetchAndParse(),
// persist via repo.setCalendarSourceFetched. Skips sources fetched in the last
// 5 minutes so a fresh manual refresh isn't undone by the periodic tick.
//
// Emits 'calendar_source' bus events:
//   { action: 'refreshed',      sourceId, count }
//   { action: 'refresh_failed', sourceId, error }

import * as repo from '../db/repo.js';
import { fetchAndParse } from './ical.js';
import { bus, log } from '../events.js';

const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const MIN_FETCH_GAP_MS = 5 * 60 * 1000;

export function startCalendarRefresher() {
  let stopped = false;
  let interval = null;

  async function refreshSource(s, { force = false } = {}) {
    if (stopped) return;
    if (!s || !s.enabled) return;
    if (!force && s.last_fetched_at && Date.now() - s.last_fetched_at < MIN_FETCH_GAP_MS) {
      return; // recently fetched
    }
    try {
      const events = await fetchAndParse(s.ical_url, { timeoutMs: 15000 });
      repo.setCalendarSourceFetched(s.id, { events, error: null });
      bus.emit('calendar_source', { action: 'refreshed', sourceId: s.id, count: events.length });
      log('info', 'calendar source refreshed', { id: s.id, name: s.name, count: events.length });
    } catch (err) {
      const msg = String(err && err.message ? err.message : err);
      try {
        repo.setCalendarSourceFetched(s.id, { events: null, error: msg });
      } catch { /* ignore — persistence shouldn't break the loop */ }
      bus.emit('calendar_source', { action: 'refresh_failed', sourceId: s.id, error: msg });
      log('warn', 'calendar source refresh failed', { id: s.id, name: s.name, error: msg });
    }
  }

  async function refreshAll({ force = false } = {}) {
    if (stopped) return;
    let sources = [];
    try {
      sources = repo.listCalendarSources({ enabledOnly: true }) || [];
    } catch (err) {
      log('error', 'calendar refresher list failed', { error: String(err) });
      return;
    }
    for (const s of sources) {
      await refreshSource(s, { force });
    }
  }

  async function refreshNow(sourceId) {
    if (sourceId == null) return refreshAll({ force: true });
    const s = repo.getCalendarSource(sourceId);
    if (!s) throw new Error('calendar source not found');
    return refreshSource(s, { force: true });
  }

  // Kick off the initial refresh after a tiny delay so the rest of server
  // startup isn't blocked by a possibly slow network round-trip.
  setTimeout(() => { refreshAll().catch(() => {}); }, 2000);
  interval = setInterval(() => { refreshAll().catch(() => {}); }, REFRESH_INTERVAL_MS);

  return {
    stop() {
      stopped = true;
      if (interval) { clearInterval(interval); interval = null; }
    },
    refreshNow,
  };
}
