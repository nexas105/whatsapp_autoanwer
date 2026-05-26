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
    // Formats a number with locale separators. Returns '0' for nullish.
    formatNumber(n) {
      const x = Number(n);
      if (!Number.isFinite(x)) return '0';
      try { return new Intl.NumberFormat('de-DE').format(x); }
      catch (_) { return String(x); }
    },
    // Deterministic palette pick from a chat/contact id. Used for avatar tints.
    avatarColor(id) {
      const palette = [
        '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6',
        '#ec4899', '#06b6d4', '#84cc16', '#f97316', '#a855f7',
      ];
      let h = 0;
      const s = String(id || '');
      for (let i = 0; i < s.length; i += 1) {
        h = (h * 31 + s.charCodeAt(i)) | 0;
      }
      return palette[Math.abs(h) % palette.length];
    },
    // Convenience for the inline avatar tile style.
    avatarStyle(id) {
      const c = this.avatarColor(id);
      // base hex + alpha suffix (~20%) for a subtle tinted background.
      return `background-color: ${c}33; color: ${c};`;
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
      // Per-kind colors are applied via toastClasses() in the template.
      this.toasts.push({ id, msg, kind });
      // Cap visible toasts to 4 — drop the oldest if we go over.
      while (this.toasts.length > 4) this.toasts.shift();
      // Errors stay a bit longer than info/success messages.
      const ttl = (kind === 'error') ? 4500 : (kind === 'warn' ? 3500 : 2500);
      setTimeout(() => { this.dismissToast(id); }, ttl);
    },
    showToast(msg, kind = 'info') { return this.toast(msg, kind); },
    dismissToast(id) {
      this.toasts = this.toasts.filter((t) => t.id !== id);
    },
    toastClasses(kind) {
      // Returns the per-kind Tailwind classes for the toast bubble.
      switch (kind) {
        case 'success':
          return 'bg-emerald-900/90 border-emerald-600/60 text-emerald-50';
        case 'warn':
        case 'warning':
          return 'bg-amber-900/90 border-amber-600/60 text-amber-50';
        case 'error':
          return 'bg-red-900/90 border-red-600/60 text-red-50';
        case 'info':
        default:
          return 'bg-slate-800/95 border-slate-600/70 text-slate-100';
      }
    },
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
