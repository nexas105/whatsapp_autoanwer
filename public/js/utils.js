/* UI helpers and formatters — pure functions, no Alpine state mutations.
 * Methods are mixed into the Alpine component via Object.assign in app.js.
 */
(function () {
  window.AppUtils = {
    // ───── formatters ─────
    statusLabel() {
      const map = {
        ready: 'verbunden',
        qr: 'QR-Code scannen',
        authenticating: 'authentifiziere…',
        disconnected: 'getrennt',
        unimplemented: 'nicht initialisiert',
      };
      return map[this.waStatus] || 'unbekannt';
    },
    displayName(c) {
      if (!c) return '';
      return c.name || c.id || 'Unbekannt';
    },
    initials(c) {
      const n = this.displayName(c);
      if (!n) return '?';
      const parts = n.replace(/@.*/, '').split(/[\s_-]+/).filter(Boolean);
      const a = parts[0]?.[0] || n[0] || '?';
      const b = parts[1]?.[0] || '';
      return (a + b).toUpperCase().slice(0, 2);
    },
    truncate(s, n) {
      if (!s) return '';
      const str = String(s);
      return str.length > n ? str.slice(0, n - 1) + '…' : str;
    },
    formatTime(ts) {
      if (!ts) return '';
      const ms = ts < 1e12 ? ts * 1000 : ts;
      try {
        return new Date(ms).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
      } catch (_) { return ''; }
    },
    formatDateTime(ts) {
      if (!ts) return '';
      const ms = ts < 1e12 ? ts * 1000 : ts;
      try {
        return new Date(ms).toLocaleString('de-DE');
      } catch (_) { return ''; }
    },
    formatCountdown(ms) {
      const total = Math.ceil(Math.max(0, ms) / 1000);
      const m = Math.floor(total / 60);
      const s = total % 60;
      return `${m}:${String(s).padStart(2, '0')}`;
    },
    formatBytes(n) {
      const x = Number(n) || 0;
      if (x < 1024) return `${x} B`;
      if (x < 1024 * 1024) return `${(x / 1024).toFixed(1)} KB`;
      if (x < 1024 * 1024 * 1024) return `${(x / (1024 * 1024)).toFixed(1)} MB`;
      return `${(x / (1024 * 1024 * 1024)).toFixed(2)} GB`;
    },
    formatRelative(ts) {
      if (!ts) return '—';
      const ms = ts < 1e12 ? ts * 1000 : ts;
      const diff = Date.now() - ms;
      if (!Number.isFinite(diff) || diff < 0) return this.formatDateTime(ts);
      const s = Math.floor(diff / 1000);
      if (s < 60) return `vor ${s}s`;
      const m = Math.floor(s / 60);
      if (m < 60) return `vor ${m} min`;
      const h = Math.floor(m / 60);
      if (h < 24) return `vor ${h} h`;
      const d = Math.floor(h / 24);
      if (d < 7) return `vor ${d} d`;
      return this.formatDateTime(ts);
    },
    formatDurationShort(seconds) {
      const s = Math.max(0, Math.floor(Number(seconds) || 0));
      if (s === 0) return '0s';
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const sec = s % 60;
      if (h > 0) return `${h}h ${m}m`;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    },
    ackGlyph(ack) {
      const n = Number(ack);
      if (!Number.isFinite(n) || n <= 0) return '⏱';
      if (n === 1) return '✓';
      return '✓✓';
    },
    scrollMessagesToBottom() {
      const el = this.$refs.messageList;
      if (el) el.scrollTop = el.scrollHeight;
    },

    // ───── toast + log ─────
    toast(msg, kind = 'info') {
      const id = ++this._toastId;
      this.toasts.push({ id, msg, kind });
      setTimeout(() => {
        this.toasts = this.toasts.filter((t) => t.id !== id);
      }, 2500);
    },
    showToast(msg, kind = 'info') { return this.toast(msg, kind); },
    pushLog(entry) {
      this.logs.push({
        level: entry.level || 'info',
        msg: entry.msg || '',
        meta: entry.meta,
        t: entry.t || Date.now(),
      });
      if (this.logs.length > 100) this.logs.splice(0, this.logs.length - 100);
    },
  };
})();
