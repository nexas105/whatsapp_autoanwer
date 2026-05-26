/* WhatsApp AutoAnswer — Alpine.js front-end.
 * Talks to /api/* (REST) and /ws (WebSocket).
 *
 * Cleaned-up structure: initial state lives in ./js/state.js, methods stay here
 * for now (will be split into per-domain files iteratively).
 * The state module attaches `window.AppState` which we spread into the returned
 * component below. Alpine still sees a single object via `app()`.
 */

function app() {
  // Compose state + per-domain method modules. Each module attaches a plain
  // object to window.AppXxx and is mixed into the Alpine component below.
  const initialState = (window.AppState && window.AppState()) || {};
  const utils = window.AppUtils || {};
  const views = window.AppViews || {};
  const summaries = window.AppSummaries || {};
  const shortcuts = window.AppShortcuts || {};
  return Object.assign(initialState, utils, views, summaries, shortcuts, {
    // ────────────────────────────────────────────
    async init() {
      // Load stored dashboard token (Bundle L). Empty string when unset.
      try { this.token = localStorage.getItem('dashboard_token') || ''; } catch { this.token = ''; }
      // Restore last active view (UI restructure).
      try {
        const v = localStorage.getItem('current_view') || '';
        if (['chats', 'dashboard', 'inbox', 'sessions', 'summaries', 'settings'].includes(v)) {
          this.currentView = v;
        }
        const sub = localStorage.getItem('settings_sub_tab') || '';
        if (['profile', 'personas', 'schedules', 'calendar', 'global', 'health', 'playground', 'token'].includes(sub)) {
          this.settingsSubTab = sub;
        }
      } catch { /* ignore */ }
      // Re-fetch dynamic lists when switching into views that need them.
      this.$watch && this.$watch('currentView', (v) => {
        try { localStorage.setItem('current_view', v); } catch { /* ignore */ }
        if (v === 'sessions') this.loadSessions();
        if (v === 'summaries') {
          this.loadSummaryFolders && this.loadSummaryFolders();
          this.loadSummaries && this.loadSummaries();
          if (this.resetSummaryDraft) this.resetSummaryDraft();
        }
        if (v === 'settings' && this.settingsSubTab === 'health') {
          this.loadHealth();
          if (this.healthTimer) clearInterval(this.healthTimer);
          this.healthTimer = setInterval(() => this.loadHealth(), 10000);
        } else if (this.healthTimer && (v !== 'settings' || this.settingsSubTab !== 'health')) {
          clearInterval(this.healthTimer); this.healthTimer = null;
        }
      });
      this.$watch && this.$watch('settingsSubTab', (v) => {
        try { localStorage.setItem('settings_sub_tab', v); } catch { /* ignore */ }
        if (this.currentView === 'settings' && v === 'health') {
          this.loadHealth();
          if (this.healthTimer) clearInterval(this.healthTimer);
          this.healthTimer = setInterval(() => this.loadHealth(), 10000);
        } else if (this.healthTimer) {
          clearInterval(this.healthTimer); this.healthTimer = null;
        }
      });
      await this.refreshState();
      await Promise.all([
        this.loadChats(),
        this.loadStats(),
        this.loadCharts(),
        this.loadPersonas(),
        this.loadSchedules(),
        this.loadInbox(),
        this.loadBioSuggestions(),
        this.loadGlobalConfig(),
        this.loadUserProfile(),
        this.loadScheduleStatus()
      ]);
      this.connectWs();
      // tick for countdown
      this.pendingTimer = setInterval(() => this.tickPending(), 500);
      // refresh stats every 30s
      this.statsTimer = setInterval(() => this.loadStats(), 30000);
      // refresh charts every 60s
      this.chartsTimer = setInterval(() => this.loadCharts(), 60000);
      // Global keyboard shortcuts (Cmd/Ctrl+K, g+c, ? etc.)
      if (typeof this.installShortcuts === 'function') this.installShortcuts();
    },

    // ───── API helpers ─────
    _fetchWithToken(path, opts = {}) {
      const headers = Object.assign(
        { 'Content-Type': 'application/json' },
        opts.headers || {},
      );
      if (this.token) headers.Authorization = `Bearer ${this.token}`;
      return fetch(path, { ...opts, headers });
    },
    async ensureToken() {
      if (this.token) return true;
      let t = '';
      try { t = window.prompt('Dashboard-Token (DASHBOARD_TOKEN aus .env):') || ''; } catch { t = ''; }
      t = String(t || '').trim();
      if (!t) return false;
      this.token = t;
      try { localStorage.setItem('dashboard_token', t); } catch { /* ignore */ }
      return true;
    },
    resetToken() {
      this.token = '';
      try { localStorage.removeItem('dashboard_token'); } catch { /* ignore */ }
      // Re-prompt right away so the user can paste a fresh token.
      this.ensureToken().then((ok) => {
        if (ok) {
          this.toast('Token aktualisiert');
          // Reconnect the WS so the new token is used on the handshake.
          try { if (this.ws && this.ws.readyState <= 1) this.ws.close(); } catch { /* ignore */ }
        }
      });
    },
    async api(path, opts = {}) {
      let res = await this._fetchWithToken(path, opts);
      if (res.status === 401) {
        // Prompt once and retry.
        const got = await this.ensureToken();
        if (got) res = await this._fetchWithToken(path, opts);
      }
      if (!res.ok) {
        let msg = `HTTP ${res.status}`;
        try { const j = await res.json(); if (j.error) msg = j.error; } catch (_) { /* ignore */ }
        throw new Error(msg);
      }
      const ct = res.headers.get('content-type') || '';
      return ct.includes('application/json') ? res.json() : res.text();
    },
    chatPath(id, suffix = '') {
      return `/api/chats/${encodeURIComponent(id)}${suffix}`;
    },
    mediaUrl(id) {
      return `/api/media/${encodeURIComponent(id)}/file`;
    },

    // ───── state + stats + chats ─────
    async refreshState() {
      try {
        const data = await this.api('/api/state');
        if (data.wa) {
          this.waStatus = data.wa.status;
          if (data.wa.qr) {
            this.qrString = data.wa.qr;
            this.$nextTick(() => this.renderQr());
          }
        }
        if (data.engine) this.engine = data.engine;
      } catch (e) {
        console.warn('state fetch failed', e);
      }
    },
    async loadStats() {
      try {
        const data = await this.api('/api/stats');
        this.stats = data.stats || null;
      } catch (e) {
        console.warn('stats fetch failed', e);
      }
    },
    async loadCharts() {
      try {
        const data = await this.api('/api/charts');
        // Server returns { activity, personas, reply_ratio, metrics_24h, top_chats_7d, time_saved_24h }
        this.charts = {
          activity: data.activity || [],
          personas: data.personas || [],
          reply_ratio: data.reply_ratio || { total: 0, sent: 0, failed: 0, cancelled: 0 },
          metrics_24h: data.metrics_24h || { triggered: 0, sent: 0, failed: 0, cancelled: 0, response_rate: 0, avg_response_ms: 0 },
          top_chats_7d: data.top_chats_7d || [],
          time_saved_24h: data.time_saved_24h || { count: 0, seconds_saved: 0 },
        };
      } catch (_) {
        // keep previous value on failure
      }
    },
    _chartsRefreshTimer: null,
    // Coalesce bursty WS events (many messages in a row) into a single GET.
    scheduleChartsRefresh() {
      if (this._chartsRefreshTimer) return;
      this._chartsRefreshTimer = setTimeout(() => {
        this._chartsRefreshTimer = null;
        this.loadCharts();
      }, 1500);
    },
    _statsRefreshTimer: null,
    // Stats are also hammered by WS events (every incoming message). Coalesce
    // a burst into one GET on the same 1.5s window as charts.
    scheduleStatsRefresh() {
      if (this._statsRefreshTimer) return;
      this._statsRefreshTimer = setTimeout(() => {
        this._statsRefreshTimer = null;
        this.loadStats();
      }, 1500);
    },
    chartsActivityTotal() {
      if (!this.charts || !this.charts.activity) return 0;
      return this.charts.activity.reduce((acc, d) => acc + (d.n || 0), 0);
    },
    // Returns the line path "M x0 y0 L x1 y1 ..." for the 24h sparkline.
    sparklinePath(data, w = 240, h = 60) {
      if (!data || !data.length) return '';
      const max = Math.max(1, ...data.map((d) => d.n || 0));
      const stepX = data.length === 1 ? 0 : w / (data.length - 1);
      return data.map((d, i) => {
        const x = i * stepX;
        const y = h - ((d.n || 0) / max) * (h - 4) - 2;
        return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
      }).join(' ');
    },
    // Same path closed at the bottom for the gradient fill.
    sparklineArea(data, w = 240, h = 60) {
      const line = this.sparklinePath(data, w, h);
      if (!line) return '';
      return `${line} L ${w} ${h} L 0 ${h} Z`;
    },
    topPersonas() {
      if (!this.charts || !this.charts.personas) return [];
      return this.charts.personas
        .filter((p) => (p.chats || 0) > 0)
        .slice(0, 5);
    },
    personaPct(p) {
      const top = this.topPersonas();
      const max = top.length ? Math.max(1, ...top.map((x) => x.chats || 0)) : 1;
      return Math.round(((p.chats || 0) / max) * 100);
    },
    donutPct(rr) {
      if (!rr || !rr.total) return 0;
      return Math.round(((rr.sent || 0) / rr.total) * 100);
    },
    donutOffset(rr) {
      // 2*PI*24 ~= 150.8
      const C = 150.8;
      const pct = this.donutPct(rr) / 100;
      return (C * (1 - pct)).toFixed(2);
    },

    // ───── Dashboard v2 / charts helpers (Bundle K) ─────
    metricsResponseRatePct() {
      const m = this.charts?.metrics_24h;
      if (!m || !m.triggered) return 0;
      return Math.round(((m.sent || 0) / m.triggered) * 100);
    },
    metricsAvgResponseSec() {
      return Math.round((this.charts?.metrics_24h?.avg_response_ms || 0) / 1000);
    },
    timeSavedSec() {
      return Number(this.charts?.time_saved_24h?.seconds_saved || 0);
    },
    // formatDurationShort() moved to js/utils.js
    topChatsTotal() {
      return (this.charts?.top_chats_7d || []).reduce((a, b) => a + (b.n || 0), 0);
    },
    topChatPct(tc) {
      const list = this.charts?.top_chats_7d || [];
      if (!list.length) return 0;
      const max = Math.max(1, ...list.map((x) => x.n || 0));
      return Math.round(((tc.n || 0) / max) * 100);
    },

    // ───── Health modal (Bundle K) ─────
    async loadHealth() {
      try {
        const d = await this.api('/api/health');
        this.health = d;
      } catch (_) { /* keep previous on failure */ }
    },
    openHealth() {
      this.healthOpen = true;
      this.loadHealth();
      if (this.healthTimer) clearInterval(this.healthTimer);
      this.healthTimer = setInterval(() => this.loadHealth(), 10000);
    },
    closeHealth() {
      this.healthOpen = false;
      if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    },
    _healthDot(statusStr) {
      const s = String(statusStr || '').toLowerCase();
      if (['ok', 'ready', 'running'].includes(s)) return 'green';
      if (['mock', 'partial', 'no_model', 'authenticating', 'qr'].includes(s)) return 'amber';
      if (['error', 'disconnected', 'missing', 'unimplemented', 'failed'].includes(s)) return 'red';
      return 'slate';
    },
    healthRows() {
      const h = this.health;
      if (!h) return [];
      return [
        { key: 'wa', label: 'WhatsApp',
          status: h.wa?.status || 'unknown',
          details: h.wa?.details ? (typeof h.wa.details === 'string' ? h.wa.details : JSON.stringify(h.wa.details)) : null,
          dot: this._healthDot(h.wa?.status) },
        { key: 'ai_cli', label: `AI CLI (${h.ai_cli?.cmd || '—'})`,
          status: h.ai_cli?.status || 'unknown',
          details: h.ai_cli?.details || null,
          dot: this._healthDot(h.ai_cli?.status) },
        { key: 'whisper', label: `Whisper (${h.whisper?.bin || '—'})`,
          status: h.whisper?.status || 'unknown',
          details: h.whisper?.details || null,
          dot: this._healthDot(h.whisper?.status) },
        { key: 'tts', label: 'TTS (say + ffmpeg)',
          status: h.tts?.status || 'unknown',
          details: h.tts?.details || null,
          dot: this._healthDot(h.tts?.status) },
        { key: 'db', label: 'Datenbank',
          status: h.db?.status || 'unknown',
          details: h.db?.details || null,
          dot: this._healthDot(h.db?.status) },
        { key: 'scheduler', label: 'Scheduler',
          status: h.scheduler?.status || 'unknown',
          details: h.scheduler?.details || null,
          dot: this._healthDot(h.scheduler?.status) },
      ];
    },

    // Pagination state for the chat sidebar (first page 50, scroll for more).
    _chatsLoading: false,
    _chatsHasMore: true,
    _chatsPageSize: 50,
    async loadChats() {
      // Only show the skeleton when there are no chats yet — refreshes shouldn't
      // wipe the list back to a placeholder.
      if (!this.chats || this.chats.length === 0) this.chatsLoading = true;
      this._chatsLoading = true;
      try {
        const data = await this.api(`/api/chats?limit=${this._chatsPageSize}&offset=0`);
        this.chats = data.chats || [];
        this._chatsHasMore = (data.chats || []).length >= this._chatsPageSize;
      } catch (e) {
        this.toast('Chats laden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.chatsLoading = false;
        this._chatsLoading = false;
      }
    },
    async loadMoreChats() {
      if (this._chatsLoading || !this._chatsHasMore) return;
      this._chatsLoading = true;
      try {
        const offset = this.chats.length;
        const data = await this.api(`/api/chats?limit=${this._chatsPageSize}&offset=${offset}`);
        const more = data.chats || [];
        // De-dup by id (WS may have inserted a chat into the list meanwhile).
        const seen = new Set(this.chats.map((c) => c.id));
        for (const c of more) {
          if (!seen.has(c.id)) this.chats.push(c);
        }
        this._chatsHasMore = more.length >= this._chatsPageSize;
      } catch (e) {
        // Silent on infinite-scroll failures — user can retry by scrolling.
        console.warn('loadMoreChats failed', e);
      } finally {
        this._chatsLoading = false;
      }
    },
    // Vanilla scroll handler for the chat sidebar — triggers paging when
    // the user is within 120px of the bottom of the list. Wired to the
    // `.scroll-pane` div via @scroll in index.html.
    onChatsScroll(evt) {
      const el = evt && evt.target;
      if (!el || typeof el.scrollTop !== 'number') return;
      if (el.scrollTop + el.clientHeight >= el.scrollHeight - 120) {
        this.loadMoreChats();
      }
    },
    sortedChats() {
      // Hide status@broadcast (Stories) from the regular chat list; it has its
      // own modal accessible via the header button.
      return [...this.chats]
        .filter((c) => c.id !== 'status@broadcast')
        .sort((a, b) => (b.last_message_at || 0) - (a.last_message_at || 0));
    },
    filteredChats() {
      const sorted = this.sortedChats();
      switch (this.chatFilter) {
        case 'Auto-Reply': return sorted.filter((c) => !!c.auto_reply);
        case 'Mit Persona': return sorted.filter((c) => !!c.persona_id);
        case 'Mit Medien': return sorted.filter((c) => (c.media_count || 0) > 0);
        default: return sorted;
      }
    },
    selectedChat() {
      return this.chats.find((c) => c.id === this.selectedChatId);
    },
    async selectChat(id) {
      if (this.selectedChatId === id) return;
      this.selectedChatId = id;
      this.messages = [];
      this.analysis = null;
      this.pendingReply = null;
      this.composeText = '';
      this.activeTab = 'messages';
      this.mediaList = [];
      this.mediaByMsg = {};
      this.mediaFilter = 'Alle';
      this.pendingSuggestion = null;
      this.editingVariantIdx = null;
      this.editingVariantText = '';
      this.memory = [];
      this.newMemoryNote = '';
      this.profile = null;
      this.contactBio = null;
      this.contactBioEditing = false;
      this.activeSession = null;
      await Promise.all([
        this.loadMessages(),
        this.loadSettings(),
        this.loadAnalysis(),
        this.loadChatMedia(),
        this.loadTriggers(),
        this.loadPendingSuggestion(),
        this.loadMemory(),
        this.loadProfile(),
        this.loadContactBio(),
        this.loadActiveSession()
      ]);
      this.$nextTick(() => this.scrollMessagesToBottom());
    },

    async loadMessages() {
      this.messagesLoading = true;
      this._olderMessagesExhausted = false;
      this._olderMessagesLoading = false;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/messages?limit=100'));
        // server returns newest first; reverse for chronological display
        this.messages = (data.messages || []).slice().reverse();
        // Fewer than the requested page → we've already hit the start.
        if ((data.messages || []).length < 100) this._olderMessagesExhausted = true;
      } catch (e) {
        this.messages = [];
      } finally {
        this.messagesLoading = false;
      }
    },
    // Cursor-based "load older" — uses ?before_ts=<oldest current ts>.
    // Returns prepended rows so the on-screen list grows upward.
    _olderMessagesLoading: false,
    _olderMessagesExhausted: false,
    async loadOlderMessages() {
      if (!this.selectedChatId) return;
      if (this._olderMessagesLoading || this._olderMessagesExhausted) return;
      if (!this.messages || this.messages.length === 0) return;
      const oldestTs = this.messages[0]?.timestamp;
      if (!oldestTs) return;
      this._olderMessagesLoading = true;
      // Preserve scroll position: remember height now, restore delta after prepend.
      const list = this.$refs && this.$refs.messageList ? this.$refs.messageList : null;
      const prevHeight = list ? list.scrollHeight : 0;
      const prevTop = list ? list.scrollTop : 0;
      try {
        const PAGE = 50;
        const data = await this.api(
          this.chatPath(this.selectedChatId, `/messages?limit=${PAGE}&before_ts=${oldestTs}`)
        );
        const older = (data.messages || []).slice().reverse(); // chronological
        if (older.length < PAGE) this._olderMessagesExhausted = true;
        if (older.length) {
          // De-dup against current list head.
          const have = new Set(this.messages.map((m) => m.id));
          const fresh = older.filter((m) => !have.has(m.id));
          this.messages = fresh.concat(this.messages);
          this.$nextTick(() => {
            if (!list) return;
            const delta = list.scrollHeight - prevHeight;
            list.scrollTop = prevTop + delta;
          });
        }
      } catch (e) {
        console.warn('loadOlderMessages failed', e);
      } finally {
        this._olderMessagesLoading = false;
      }
    },
    // When user scrolls within ~40px of the top of the messages pane, load
    // an older page. Throttled by the `_olderMessagesLoading` guard.
    onMessagesScroll(evt) {
      const el = evt && evt.target;
      if (!el) return;
      if (el.scrollTop <= 40) this.loadOlderMessages();
    },
    async loadSettings() {
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'));
        this.settings = Object.assign({
          auto_reply: 0,
          reply_delay_ms: 0,
          context_messages: 0,
          persona_prompt: '',
          persona_id: null,
          style_mimic_strength: 0,
          suggestion_mode: 0,
          suggestion_count: 1,
          voice_reply_mode: 'off',
          mentioned_only: 0,
          safety_mode: 'off',
          never_to_ai: 0,
          cooldown_after_manual_ms: 1800000,
          last_manual_reply_at: null
        }, data.settings || {});
      } catch (e) {
        // keep default
      }
    },
    async loadAnalysis() {
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/analysis'));
        this.analysis = data.analysis || null;
      } catch (e) {
        this.analysis = null;
      }
    },
    async loadChatMedia() {
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/media?limit=200'));
        this.mediaList = data.media || [];
        this.rebuildMediaByMsg();
      } catch (e) {
        console.warn('media fetch failed', e);
        this.mediaList = [];
        this.mediaByMsg = {};
      }
    },
    rebuildMediaByMsg() {
      const map = {};
      for (const md of this.mediaList) {
        if (md.message_id) map[md.message_id] = md;
      }
      this.mediaByMsg = map;
    },
    filteredMedia() {
      const list = this.mediaList;
      switch (this.mediaFilter) {
        case 'Bilder': return list.filter((m) => m.kind === 'image' || m.kind === 'sticker');
        case 'Audio': return list.filter((m) => m.kind === 'audio');
        case 'Video': return list.filter((m) => m.kind === 'video');
        case 'Dateien': return list.filter((m) => m.kind === 'document' || m.kind === 'file');
        default: return list;
      }
    },

    async saveSettings() {
      if (!this.selectedChatId) return;
      this.savingSettings = true;
      try {
        const body = {
          auto_reply: this.settings.auto_reply ? 1 : 0,
          reply_delay_ms: Number(this.settings.reply_delay_ms) || 0,
          context_messages: Number(this.settings.context_messages) || 0,
          persona_prompt: this.settings.persona_prompt || '',
          persona_id: this.settings.persona_id || null,
          style_mimic_strength: Number(this.settings.style_mimic_strength) || 0,
          suggestion_mode: this.settings.suggestion_mode ? 1 : 0,
          suggestion_count: Math.max(1, Math.min(3, Number(this.settings.suggestion_count) || 1)),
          mentioned_only: !!this.settings.mentioned_only,
          never_to_ai: !!this.settings.never_to_ai
        };
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        // also update chat list row
        const c = this.chats.find((x) => x.id === this.selectedChatId);
        if (c) {
          c.auto_reply = body.auto_reply;
          c.reply_delay_ms = body.reply_delay_ms;
          c.context_messages = body.context_messages;
          c.persona_prompt = body.persona_prompt;
          c.persona_id = body.persona_id;
          c.style_mimic_strength = body.style_mimic_strength;
        }
        this.toast('gespeichert');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      } finally {
        this.savingSettings = false;
      }
    },

    async onPersonaChange(value) {
      // Apply locally
      this.settings.persona_id = value || null;
      // Immediate PUT
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ persona_id: this.settings.persona_id })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        const c = this.chats.find((x) => x.id === this.selectedChatId);
        if (c) c.persona_id = this.settings.persona_id;
        this.toast(this.settings.persona_id ? 'Persona gesetzt' : 'Persona entfernt');
      } catch (e) {
        this.toast('Persona-Fehler: ' + e.message, 'error');
      }
    },

    // simple debounce for style slider
    _styleSaveTimer: null,
    onStyleChange() {
      if (this._styleSaveTimer) clearTimeout(this._styleSaveTimer);
      this._styleSaveTimer = setTimeout(async () => {
        if (!this.selectedChatId) return;
        try {
          const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
            method: 'PUT',
            body: JSON.stringify({ style_mimic_strength: Number(this.settings.style_mimic_strength) || 0 })
          });
          if (data.settings) this.settings = Object.assign(this.settings, data.settings);
          const c = this.chats.find((x) => x.id === this.selectedChatId);
          if (c) c.style_mimic_strength = this.settings.style_mimic_strength;
        } catch (e) {
          this.toast('Stil-Update fehlgeschlagen: ' + e.message, 'error');
        }
      }, 400);
    },

    styleLabel(v) {
      const n = Number(v) || 0;
      if (n === 0) return 'Stil ignorieren';
      if (n <= 24) return 'leichter Hinweis';
      if (n <= 49) return 'passender Stil';
      if (n <= 74) return 'deutliche Übernahme';
      return 'Stil exakt kopieren';
    },

    async toggleAutoReply(chat, on) {
      try {
        const data = await this.api(this.chatPath(chat.id, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ auto_reply: on ? 1 : 0 })
        });
        chat.auto_reply = on ? 1 : 0;
        if (this.selectedChatId === chat.id && data.settings) {
          this.settings.auto_reply = data.settings.auto_reply;
        }
        this.toast(on ? 'Auto-Reply aktiviert' : 'Auto-Reply deaktiviert');
        this.loadStats();
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    async sendMessage() {
      const text = this.composeText.trim();
      if (!text || !this.selectedChatId || this.sending) return;
      this.sending = true;
      try {
        await this.api(this.chatPath(this.selectedChatId, '/send'), {
          method: 'POST',
          body: JSON.stringify({ body: text })
        });
        this.composeText = '';
        // message will arrive via WS
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.sending = false;
      }
    },

    // ───── File upload ─────
    handleFilePick(ev) {
      const file = ev.target.files && ev.target.files[0];
      if (file) this.uploadFile(file);
      // reset input so picking same file again still fires change
      ev.target.value = '';
    },
    handleDrop(ev) {
      this.dragHover = false;
      const file = ev.dataTransfer && ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) this.uploadFile(file);
    },
    async uploadFile(file) {
      if (!this.selectedChatId || this.uploading) return;
      this.uploading = true;
      try {
        const data_base64 = await new Promise((resolve, reject) => {
          const fr = new FileReader();
          fr.onerror = () => reject(new Error('FileReader-Fehler'));
          fr.onload = () => {
            const s = String(fr.result || '');
            const idx = s.indexOf(',');
            resolve(idx >= 0 ? s.slice(idx + 1) : s);
          };
          fr.readAsDataURL(file);
        });
        await this.api(this.chatPath(this.selectedChatId, '/upload-send'), {
          method: 'POST',
          body: JSON.stringify({
            filename: file.name,
            mime_type: file.type || 'application/octet-stream',
            data_base64,
            caption: this.composeText || ''
          })
        });
        this.composeText = '';
        this.toast('Datei gesendet');
      } catch (e) {
        this.toast('Upload fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.uploading = false;
      }
    },

    async runAnalysis() {
      if (!this.selectedChatId || this.analysisLoading) return;
      this.analysisLoading = true;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/analysis'), {
          method: 'POST'
        });
        this.analysis = data.analysis || null;
        this.toast('Analyse aktualisiert');
      } catch (e) {
        this.toast('Analyse fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.analysisLoading = false;
      }
    },

    async loadHistory(limit = 250) {
      if (!this.selectedChatId || this.historyLoading) return;
      this.historyLoading = true;
      try {
        await this.api(`${this.chatPath(this.selectedChatId, '/sync')}?limit=${limit}`, { method: 'POST' });
        await this.loadMessages();
        this.toast('Verlauf geladen', 'info');
      } catch (e) {
        this.toast('Verlauf fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.historyLoading = false;
      }
    },

    // ackGlyph() moved to js/utils.js

    onWsAck({ messageId, chatId, ack }) {
      if (chatId === this.selectedChatId) {
        const m = this.messages.find((x) => x.id === messageId);
        if (m) m.ack = ack;
      }
    },

    renderTips(tips) {
      if (!tips) return [];
      return String(tips).split(/\r?\n/).map((raw) => {
        const t = raw.trim();
        if (!t) return null;
        const isBullet = /^[-*•]\s+/.test(t);
        return { bullet: isBullet, text: isBullet ? t.replace(/^[-*•]\s+/, '') : t };
      }).filter(Boolean);
    },

    // ───── Personas ─────
    async loadPersonas() {
      try {
        const data = await this.api('/api/personas');
        this.personas = data.personas || [];
      } catch (e) {
        console.warn('personas fetch failed', e);
      }
    },
    personasSorted() {
      return [...this.personas].sort((a, b) => {
        if (!!b.is_builtin - !!a.is_builtin !== 0) return (b.is_builtin ? 1 : 0) - (a.is_builtin ? 1 : 0);
        return String(a.name || '').localeCompare(String(b.name || ''));
      });
    },
    personaNameById(id) {
      if (!id) return null;
      const p = this.personas.find((x) => x.id === id);
      return p ? p.name : null;
    },
    currentPersonaDescription() {
      const id = this.settings.persona_id;
      if (!id) return '';
      const p = this.personas.find((x) => x.id === id);
      return p ? (p.description || p.prompt || '') : '';
    },
    focusPersonaSelect() {
      this.$nextTick(() => {
        const el = this.$refs.personaSelect;
        if (el) {
          el.focus();
          el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    },
    openPersonaModal() {
      this.editingPersona = null;
      this.personaModalOpen = true;
    },
    newPersona() {
      this.editingPersona = { id: null, name: '', description: '', prompt: '' };
    },
    editPersona(p) {
      this.editingPersona = {
        id: p.id, name: p.name || '', description: p.description || '', prompt: p.prompt || ''
      };
    },
    duplicatePersona(p) {
      this.editingPersona = {
        id: null,
        name: (p.name || 'Persona') + ' (Kopie)',
        description: p.description || '',
        prompt: p.prompt || ''
      };
    },
    async savePersona() {
      const ep = this.editingPersona;
      if (!ep) return;
      if (!ep.name || !ep.name.trim()) {
        this.toast('Name erforderlich', 'error');
        return;
      }
      this.personaSaving = true;
      try {
        const body = {
          name: ep.name.trim(),
          description: ep.description || '',
          prompt: ep.prompt || ''
        };
        let saved;
        if (ep.id) {
          const data = await this.api(`/api/personas/${encodeURIComponent(ep.id)}`, {
            method: 'PUT', body: JSON.stringify(body)
          });
          saved = data.persona;
          const idx = this.personas.findIndex((p) => p.id === saved.id);
          if (idx >= 0) this.personas[idx] = saved; else this.personas.push(saved);
        } else {
          const data = await this.api('/api/personas', {
            method: 'POST', body: JSON.stringify(body)
          });
          saved = data.persona;
          this.personas.push(saved);
        }
        this.editingPersona = null;
        this.toast('Persona gespeichert');
      } catch (e) {
        this.toast('Persona-Fehler: ' + e.message, 'error');
      } finally {
        this.personaSaving = false;
      }
    },
    async deletePersona(p) {
      if (!p || !p.id) return;
      if (p.is_builtin) {
        this.toast('Built-in Personas können nicht gelöscht werden', 'error');
        return;
      }
      if (!confirm(`Persona "${p.name}" wirklich löschen?`)) return;
      try {
        await this.api(`/api/personas/${encodeURIComponent(p.id)}`, { method: 'DELETE' });
        this.personas = this.personas.filter((x) => x.id !== p.id);
        // If a chat used this persona, clear locally
        for (const c of this.chats) if (c.persona_id === p.id) c.persona_id = null;
        if (this.settings.persona_id === p.id) this.settings.persona_id = null;
        this.toast('Persona gelöscht');
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },

    // ───── WebSocket ─────
    connectWs() {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      let url = `${proto}://${location.host}/ws`;
      if (this.token) url += `?token=${encodeURIComponent(this.token)}`;
      let ws;
      try { ws = new WebSocket(url); } catch (e) { this.scheduleReconnect(); return; }
      this.ws = ws;
      ws.onopen = () => {
        this.wsConnected = true;
        this.wsRetry = 0;
      };
      ws.onclose = () => {
        this.wsConnected = false;
        this.scheduleReconnect();
      };
      ws.onerror = () => { /* close will fire */ };
      ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch (_) { return; }
        this.handleWs(msg);
      };
    },
    scheduleReconnect() {
      if (this.wsTimer) return;
      const delay = Math.min(30000, 1000 * Math.pow(2, this.wsRetry));
      this.wsRetry += 1;
      this.wsTimer = setTimeout(() => {
        this.wsTimer = null;
        this.connectWs();
      }, delay);
    },

    handleWs(msg) {
      switch (msg.type) {
        case 'state':
          if (msg.wa) {
            this.waStatus = msg.wa.status;
            if (msg.wa.qr) { this.qrString = msg.wa.qr; this.$nextTick(() => this.renderQr()); }
          }
          if (msg.engine) this.engine = msg.engine;
          break;
        case 'qr':
          this.waStatus = 'qr';
          this.qrString = msg.qr;
          this.$nextTick(() => this.renderQr());
          break;
        case 'ready':
          this.waStatus = 'ready';
          this.qrString = null;
          this.disconnectReason = '';
          this.loadChats();
          this.loadStats();
          break;
        case 'disconnected':
          this.waStatus = 'disconnected';
          this.disconnectReason = msg.reason || '';
          this.qrString = null;
          break;
        case 'message':
          this.onWsMessage(msg);
          // Coalesce bursts of incoming messages into a single stats/charts GET.
          this.scheduleStatsRefresh();
          this.scheduleChartsRefresh();
          break;
        case 'queue':
          this.onWsQueue(msg);
          break;
        case 'reply_sent':
          if (this.pendingReply && this.pendingReply.jobId === msg.jobId) {
            this.pendingReply = null;
          }
          this.scheduleStatsRefresh();
          this.scheduleChartsRefresh();
          break;
        case 'settings':
          if (msg.chatId === this.selectedChatId && msg.settings) {
            this.settings = Object.assign(this.settings, msg.settings);
          }
          {
            const c = this.chats.find((x) => x.id === msg.chatId);
            if (c && msg.settings) {
              if ('auto_reply' in msg.settings) c.auto_reply = msg.settings.auto_reply;
              if ('reply_delay_ms' in msg.settings) c.reply_delay_ms = msg.settings.reply_delay_ms;
              if ('persona_id' in msg.settings) c.persona_id = msg.settings.persona_id;
              if ('style_mimic_strength' in msg.settings) c.style_mimic_strength = msg.settings.style_mimic_strength;
            }
          }
          break;
        case 'analysis':
          if (msg.chatId === this.selectedChatId) this.analysis = msg.analysis;
          break;
        case 'media':
          this.onWsMedia(msg);
          break;
        case 'personas':
          this.onWsPersonas(msg);
          break;
        case 'transcript':
          this.onWsTranscript(msg);
          break;
        case 'trigger':
          this.onWsTrigger(msg);
          break;
        case 'suggestion':
          this.onWsSuggestion(msg);
          break;
        case 'suggestion_resolved':
          this.onWsSuggestionResolved(msg);
          break;
        case 'ack':
          this.onWsAck(msg);
          break;
        case 'autocomplete':
          this.onWsAutocomplete(msg);
          break;
        case 'memory_added':
          if (msg.chatId && msg.chatId === this.selectedChatId) {
            this.loadMemory();
            this.loadProfile();
          }
          break;
        case 'memory_removed':
          // Server doesn't include chatId for delete; just refresh if any chat is open.
          if (this.selectedChatId) {
            this.loadMemory();
            this.loadProfile();
          }
          break;
        case 'schedule':
          this.loadSchedules();
          break;
        case 'calendar_source':
          this.loadCalendarSources();
          if (this.settingsSubTab === 'calendar') this.loadCalendarAvailability();
          break;
        case 'appointment':
          this.loadAppointments();
          break;
        case 'safety':
          this.onWsSafety(msg);
          break;
        case 'quality':
          this.onWsQuality(msg);
          break;
        case 'profile':
          if (msg.profile) {
            this.userProfile = Object.assign({}, this.userProfile, this._normalizeUserProfile(msg.profile));
          } else {
            this.loadUserProfile();
          }
          break;
        case 'schedule_entry':
          this.loadSchedule();
          this.loadScheduleStatus();
          break;
        case 'contact_bio':
          if (msg.chatId && msg.chatId === this.selectedChatId) {
            this.contactBio = msg.bio || null;
          }
          break;
        case 'bio_suggestion':
          // Any change to suggestions → refresh the list so the header count is accurate.
          this.loadBioSuggestions();
          break;
        case 'ai_session':
          this.onWsAiSession(msg);
          break;
        case 'log':
          this.pushLog(msg);
          break;
        case 'log_batch':
          // Coalesced log messages from src/api/ws.js — unpack and forward.
          if (Array.isArray(msg.events)) {
            for (const ev of msg.events) this.pushLog(ev);
          }
          break;
        default:
          break;
      }
    },

    onWsMessage({ chatId, message }) {
      if (!message) return;
      if (chatId === this.selectedChatId) {
        if (!this.messages.find((m) => m.id === message.id)) {
          this.messages.push(message);
          this.$nextTick(() => this.scrollMessagesToBottom());
        }
      }
      const idx = this.chats.findIndex((c) => c.id === chatId);
      if (idx >= 0) {
        const c = this.chats[idx];
        c.last_message_at = message.timestamp;
        c.last_body = message.body || `[${message.type || 'media'}]`;
        c.last_from_me = message.from_me;
        c.last_has_media = message.has_media ? 1 : 0;
        c.messages_24h = (c.messages_24h || 0) + 1;
      } else {
        this.loadChats();
      }
    },

    // ───── Quick-Reply: AI antwortet auf letzte Nachricht ─────
    async quickReply(count = 1) {
      if (!this.selectedChatId) return;
      if (this.quickReplying) return;
      this.quickReplying = true;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/quick-reply'), {
          method: 'POST',
          body: JSON.stringify({ count: Math.max(1, Math.min(3, count || 1)) }),
        });
        const drafts = data.drafts || [];
        if (!drafts.length) {
          this.toast('Keine Antwort von KI', 'error');
          return;
        }
        // Reuse the compose-drafts UI to show the result with Send/Edit/Regen
        this.composeOpen = true;
        this.composeInstruction = '(auf letzte Nachricht)';
        this.composeCount = Math.max(1, Math.min(3, count || 1));
        this.composeDrafts = drafts;
        this.composeEditingIdx = null;
      } catch (e) {
        this.toast('Quick-Reply fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.quickReplying = false;
      }
    },

    // ───── AI compose ─────
    openCompose() {
      this.composeOpen = true;
      this.composeDrafts = [];
      this.composeEditingIdx = null;
      this.$nextTick(() => { if (this.$refs.composeInput) this.$refs.composeInput.focus(); });
    },
    closeCompose() {
      this.composeOpen = false;
      this.composeInstruction = '';
      this.composeDrafts = [];
      this.composeEditingIdx = null;
    },
    async generateDrafts() {
      if (!this.selectedChatId) return;
      const inst = (this.composeInstruction || '').trim();
      if (!inst) return;
      this.composeGenerating = true;
      this.composeEditingIdx = null;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/compose'), {
          method: 'POST',
          body: JSON.stringify({ prompt: inst, count: Number(this.composeCount) || 1 }),
        });
        this.composeDrafts = data.drafts || [];
        if (!this.composeDrafts.length) this.toast('KI hat keine Antwort geliefert', 'error');
      } catch (e) {
        this.toast('Generieren fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.composeGenerating = false;
      }
    },
    editDraft(idx) {
      this.composeEditingIdx = idx;
      this.composeDraftEditText = this.composeDrafts[idx] || '';
    },
    async sendDraft(idx) {
      const body = (this.composeDrafts[idx] || '').trim();
      if (!body) return;
      await this._sendComposedText(body);
    },
    async sendDraftEdited() {
      const body = (this.composeDraftEditText || '').trim();
      if (!body) return;
      await this._sendComposedText(body);
    },
    async _sendComposedText(text) {
      try {
        await this.api(this.chatPath(this.selectedChatId, '/send'), {
          method: 'POST',
          body: JSON.stringify({ body: text }),
        });
        this.toast('Gesendet', 'info');
        this.closeCompose();
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      }
    },

    // ───── search ─────
    openSearchModal() {
      this.searchModalOpen = true;
      this.$nextTick(() => {
        if (this.$refs.searchInput) this.$refs.searchInput.focus();
      });
    },
    onSearchInput() {
      // Live-debounce for keyword mode only; AI mode waits for Enter.
      if (this.searchMode !== 'keyword') return;
      clearTimeout(this._searchDebounce);
      this._searchDebounce = setTimeout(() => this.runSearch(), 200);
    },
    runSearch() {
      const q = (this.searchQuery || '').trim();
      if (!q) { this.searchResults = []; this.searchAnswer = ''; return; }
      this.searchLoading = true;
      this.searchAnswer = '';
      if (this.searchMode === 'keyword') {
        this.api(`/api/search?q=${encodeURIComponent(q)}&limit=50`)
          .then((d) => { this.searchResults = d.hits || []; })
          .catch((e) => this.toast('Suche fehlgeschlagen: ' + e.message, 'error'))
          .finally(() => { this.searchLoading = false; });
      } else {
        this.api('/api/search/ai', {
          method: 'POST',
          body: JSON.stringify({ q, limit: 12 }),
        })
          .then((d) => {
            this.searchAnswer = d.answer || '';
            this.searchResults = d.hits || [];
          })
          .catch((e) => this.toast('KI-Suche fehlgeschlagen: ' + e.message, 'error'))
          .finally(() => { this.searchLoading = false; });
      }
    },
    goToSearchResult(r) {
      this.searchModalOpen = false;
      this.selectChat(r.chat_id);
    },

    // ───── persona playground (Bundle J) ─────
    openPlayground() {
      this.playgroundOpen = true;
      // Default to whatever persona the currently selected chat uses (if any).
      if (!this.pgPersonaId && this.settings && this.settings.persona_id) {
        this.pgPersonaId = this.settings.persona_id;
      }
    },
    closePlayground() {
      this.playgroundOpen = false;
    },
    pgAddRow() {
      // Alternate sender for convenience.
      const last = this.pgMock[this.pgMock.length - 1];
      const next = last && last.from_me ? 0 : 1;
      this.pgMock.push({ from_me: next, body: '' });
    },
    pgRemoveRow(i) {
      if (this.pgMock.length <= 1) return;
      this.pgMock.splice(i, 1);
    },
    async pgGenerate() {
      const mock = (this.pgMock || [])
        .map((r) => ({ from_me: r.from_me ? 1 : 0, body: String(r.body || '').trim() }))
        .filter((r) => r.body.length > 0);
      if (!mock.length) {
        this.toast('Mindestens eine Nachricht erforderlich', 'error');
        return;
      }
      this.pgGenerating = true;
      this.pgVariants = [];
      try {
        const data = await this.api('/api/playground/generate', {
          method: 'POST',
          body: JSON.stringify({
            persona_id: this.pgPersonaId || null,
            persona_prompt: (this.pgPrompt || '').trim() || null,
            style_mimic_strength: Number(this.pgStyle) || 0,
            mock_history: mock,
            count: Math.max(1, Math.min(3, Number(this.pgCount) || 1)),
          }),
        });
        this.pgVariants = Array.isArray(data.variants) ? data.variants : [];
        if (!this.pgVariants.length) this.toast('Keine Varianten generiert', 'error');
      } catch (e) {
        this.toast('Playground-Fehler: ' + e.message, 'error');
      } finally {
        this.pgGenerating = false;
      }
    },

    // ───── stories (status@broadcast) ─────
    async loadStories() {
      this.storiesLoading = true;
      try {
        const data = await this.api('/api/stories?limit=60');
        this.stories = data.stories || [];
      } catch (e) {
        this.toast('Stories laden fehlgeschlagen: ' + e.message, 'error');
        this.stories = [];
      } finally {
        this.storiesLoading = false;
      }
    },
    openStoriesModal() {
      this.storiesOpen = true;
      this.loadStories();
    },

    // ───── schedules ─────
    async loadSchedules() {
      try {
        const data = await this.api('/api/schedules');
        this.schedules = data.schedules || [];
      } catch (e) {
        console.warn('schedules fetch failed', e);
      }
    },
    scheduleTargetLabel(s) {
      if (!s) return '';
      if (s.chat_id) {
        const c = this.chats.find((x) => x.id === s.chat_id);
        return c ? this.displayName(c) : s.chat_id;
      }
      let filter = null;
      try { filter = s.target_filter ? JSON.parse(s.target_filter) : null; } catch { /* ignore */ }
      const parts = ['Global'];
      if (filter) {
        const kv = [];
        if (filter.auto_reply != null) kv.push(`auto_reply=${filter.auto_reply ? '1' : '0'}`);
        if (filter.persona_id) kv.push(`persona=${filter.persona_id}`);
        if (filter.has_persona != null) kv.push(`has_persona=${filter.has_persona ? '1' : '0'}`);
        if (kv.length) parts.push(`[${kv.join(', ')}]`);
      }
      return parts.join(' ');
    },
    scheduleSpecLabel(kind) {
      if (kind === 'cron') return 'Cron-Ausdruck';
      if (kind === 'once') return 'Zeitpunkt (ISO)';
      if (kind === 'after_silence') return 'Stille-Dauer (Sekunden)';
      return 'Spec';
    },
    scheduleSpecPlaceholder(kind) {
      if (kind === 'cron') return '0 9 * * *';
      if (kind === 'once') return new Date(Date.now() + 3600_000).toISOString();
      if (kind === 'after_silence') return '3600';
      return '';
    },
    scheduleSpecHelp(kind) {
      if (kind === 'cron') {
        return 'Format: <span class="font-mono">minute hour day-of-month month day-of-week</span>. '
          + 'Beispiele: <span class="font-mono">0 9 * * *</span> (täglich 9:00), '
          + '<span class="font-mono">*/15 * * * *</span> (alle 15 Min), '
          + '<span class="font-mono">0 18 * * 1-5</span> (Mo–Fr 18:00).';
      }
      if (kind === 'once') {
        return 'ISO 8601 Datum/Zeit, z.B. <span class="font-mono">2026-05-27T09:00:00Z</span>.';
      }
      if (kind === 'after_silence') {
        return 'Anzahl Sekunden Stille im Zielchat, bevor gefeuert wird. Erfordert Zielchat. '
          + 'Beispiele: <span class="font-mono">3600</span> (1 Std), <span class="font-mono">86400</span> (1 Tag).';
      }
      return '';
    },
    _blankSchedule() {
      return {
        id: null,
        chat_id: null,
        name: '',
        schedule_kind: 'cron',
        schedule_spec: '0 9 * * *',
        prompt: '',
        mode: 'ai',
        enabled: true,
        _filter_auto_reply: false,
        _filter_has_persona: false,
        _filter_persona_id: '',
      };
    },
    newSchedule() {
      this.editingSchedule = this._blankSchedule();
      this.schedulesOpen = true;
    },
    editSchedule(s) {
      let filter = null;
      try { filter = s.target_filter ? JSON.parse(s.target_filter) : null; } catch { /* ignore */ }
      this.editingSchedule = {
        id: s.id,
        chat_id: s.chat_id || null,
        name: s.name || '',
        schedule_kind: s.schedule_kind || 'cron',
        schedule_spec: s.schedule_spec || '',
        prompt: s.prompt || '',
        mode: s.mode || 'ai',
        enabled: !!s.enabled,
        _filter_auto_reply: !!(filter && filter.auto_reply),
        _filter_has_persona: !!(filter && filter.has_persona),
        _filter_persona_id: (filter && filter.persona_id) || '',
      };
      this.schedulesOpen = true;
    },
    _scheduleFormToPatch(es) {
      const patch = {
        name: (es.name || '').trim(),
        schedule_kind: es.schedule_kind || 'cron',
        schedule_spec: (es.schedule_spec || '').trim(),
        prompt: es.prompt || '',
        mode: es.mode || 'ai',
        enabled: !!es.enabled,
        chat_id: es.chat_id || null,
      };
      if (!patch.chat_id) {
        const f = {};
        if (es._filter_auto_reply) f.auto_reply = true;
        if (es._filter_has_persona) f.has_persona = true;
        if (es._filter_persona_id) f.persona_id = es._filter_persona_id;
        patch.target_filter = Object.keys(f).length ? f : null;
      } else {
        patch.target_filter = null;
      }
      return patch;
    },
    async saveSchedule() {
      if (!this.editingSchedule) return;
      const es = this.editingSchedule;
      if (!es.name || !es.name.trim()) { this.toast('Name erforderlich', 'error'); return; }
      if (!es.schedule_spec || !es.schedule_spec.trim()) { this.toast('Spec erforderlich', 'error'); return; }
      if (!es.prompt || !es.prompt.trim()) { this.toast('Prompt/Text erforderlich', 'error'); return; }
      if (es.schedule_kind === 'after_silence' && !es.chat_id) {
        this.toast('after_silence benötigt einen Zielchat', 'error');
        return;
      }
      this.scheduleSaving = true;
      try {
        const patch = this._scheduleFormToPatch(es);
        if (es.id) {
          await this.api(`/api/schedules/${encodeURIComponent(es.id)}`, {
            method: 'PUT', body: JSON.stringify(patch),
          });
        } else {
          await this.api('/api/schedules', {
            method: 'POST', body: JSON.stringify(patch),
          });
        }
        this.editingSchedule = null;
        await this.loadSchedules();
        this.toast('Zeitplan gespeichert');
      } catch (e) {
        this.toast('Speichern fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.scheduleSaving = false;
      }
    },
    async deleteSchedule(s) {
      if (!s || !s.id) return;
      if (!confirm(`Zeitplan "${s.name}" wirklich löschen?`)) return;
      try {
        await this.api(`/api/schedules/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        await this.loadSchedules();
        this.toast('Zeitplan gelöscht');
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async runSchedule(s) {
      if (!s || !s.id) return;
      try {
        await this.api(`/api/schedules/${encodeURIComponent(s.id)}/run`, { method: 'POST' });
        this.toast('Zeitplan läuft…');
      } catch (e) {
        this.toast('Ausführen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async toggleScheduleEnabled(s) {
      if (!s || !s.id) return;
      try {
        await this.api(`/api/schedules/${encodeURIComponent(s.id)}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: !s.enabled }),
        });
        await this.loadSchedules();
      } catch (e) {
        this.toast('Toggle fehlgeschlagen: ' + e.message, 'error');
      }
    },

    // ───── triggers ─────
    async loadTriggers() {
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/triggers'));
        this.triggers = data.triggers || [];
      } catch (e) {
        this.triggers = [];
      }
    },
    newTrigger() {
      this.editingTrigger = {
        id: null,
        name: '',
        pattern: '',
        match_mode: 'substring',
        case_sensitive: false,
        action_type: 'reply',
        action_value: '',
        delay_override_ms: null,
        priority: 0,
        enabled: true,
      };
    },
    editTrigger(t) {
      this.editingTrigger = {
        ...t,
        case_sensitive: !!t.case_sensitive,
        enabled: !!t.enabled,
      };
    },
    async saveTrigger() {
      if (!this.editingTrigger || !this.selectedChatId) return;
      const t = this.editingTrigger;
      if (!t.pattern || !t.pattern.trim()) { this.toast('Pattern fehlt', 'error'); return; }
      if (t.action_type === 'reply' && !t.action_value) { this.toast('Antworttext fehlt', 'error'); return; }
      this.triggerSaving = true;
      try {
        const body = {
          name: t.name || null,
          pattern: t.pattern,
          match_mode: t.match_mode,
          case_sensitive: !!t.case_sensitive,
          action_type: t.action_type,
          action_value: t.action_value || null,
          delay_override_ms: t.delay_override_ms === '' || t.delay_override_ms == null ? null : Number(t.delay_override_ms),
          priority: Number(t.priority) || 0,
          enabled: !!t.enabled,
        };
        if (t.id) {
          await this.api(`${this.chatPath(this.selectedChatId, '/triggers')}/${t.id}`, {
            method: 'PUT', body: JSON.stringify(body),
          });
        } else {
          await this.api(this.chatPath(this.selectedChatId, '/triggers'), {
            method: 'POST', body: JSON.stringify(body),
          });
        }
        this.editingTrigger = null;
        await this.loadTriggers();
        this.toast('Trigger gespeichert', 'info');
      } catch (e) {
        this.toast('Speichern fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.triggerSaving = false;
      }
    },
    async deleteTrigger(t) {
      if (!confirm(`Trigger "${t.name || t.pattern}" löschen?`)) return;
      try {
        await this.api(`${this.chatPath(this.selectedChatId, '/triggers')}/${t.id}`, { method: 'DELETE' });
        await this.loadTriggers();
        this.toast('Trigger gelöscht', 'info');
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async toggleTriggerEnabled(t) {
      try {
        await this.api(`${this.chatPath(this.selectedChatId, '/triggers')}/${t.id}`, {
          method: 'PUT',
          body: JSON.stringify({ enabled: !t.enabled }),
        });
        await this.loadTriggers();
      } catch (e) {
        this.toast('Toggle fehlgeschlagen: ' + e.message, 'error');
      }
    },
    onWsTrigger(payload) {
      if (payload.chatId !== this.selectedChatId) return;
      if (['created', 'updated', 'deleted'].includes(payload.action)) {
        this.loadTriggers();
      }
      // match/skip/reply/prompt actions get logged via the log stream automatically
    },

    // ───── voice reply mode ─────
    async onVoiceModeChange() {
      if (!this.selectedChatId) return;
      const mode = String(this.settings.voice_reply_mode || 'off');
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ voice_reply_mode: mode })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        const labels = { off: 'Voice-Antworten aus', always: 'Voice-Antworten: immer', mirror: 'Voice-Antworten: spiegeln' };
        this.toast(labels[mode] || 'gespeichert');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    // ───── chat memory ─────
    async loadMemory() {
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/memory'));
        this.memory = data.memory || [];
      } catch (e) {
        this.memory = [];
      }
    },
    async addMemoryNote() {
      const note = String(this.newMemoryNote || '').trim();
      if (!note || !this.selectedChatId) return;
      try {
        await this.api(this.chatPath(this.selectedChatId, '/memory'), {
          method: 'POST',
          body: JSON.stringify({ note })
        });
        this.newMemoryNote = '';
        await this.loadMemory();
        this.toast('Notiz hinzugefügt');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },
    async removeMemoryNote(id) {
      if (!id) return;
      try {
        await this.api(`/api/memory/${encodeURIComponent(id)}`, { method: 'DELETE' });
        this.memory = (this.memory || []).filter((m) => m.id !== id);
        this.toast('Notiz gelöscht', 'info');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },
    async togglePin(m) {
      if (!m || !m.id) return;
      const next = m.pinned ? 0 : 1;
      try {
        await this.api(`/api/memory/${encodeURIComponent(m.id)}/pinned`, {
          method: 'PUT',
          body: JSON.stringify({ pinned: !!next })
        });
        // Optimistic update; the canonical order is enforced by server on next load.
        m.pinned = next;
        // Re-sort: pinned first, then most-recent.
        this.memory = [...this.memory].sort((a, b) => {
          if ((b.pinned || 0) - (a.pinned || 0) !== 0) return (b.pinned || 0) - (a.pinned || 0);
          return (b.created_at || 0) - (a.created_at || 0);
        });
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    // ───── suggestions ─────
    async loadPendingSuggestion() {
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/suggestions?status=pending'));
        const list = data.suggestions || [];
        this.pendingSuggestion = list.length ? list[0] : null;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
      } catch (e) {
        this.pendingSuggestion = null;
      }
    },

    async onSuggestionModeChange(on) {
      this.settings.suggestion_mode = on ? 1 : 0;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ suggestion_mode: on ? 1 : 0 })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        this.toast(on ? 'Vorschlags-Modus aktiviert' : 'Vorschlags-Modus aus');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    async onSuggestionCountChange(n) {
      const v = Math.max(1, Math.min(3, Number(n) || 1));
      this.settings.suggestion_count = v;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ suggestion_count: v })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    async onAutocompleteModeChange(mode) {
      const v = ['off', 'suggest', 'auto'].includes(mode) ? mode : 'off';
      this.settings.autocomplete_mode = v;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ autocomplete_mode: v })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        this.toast(v === 'off' ? 'Auto-Complete aus' : (v === 'auto' ? 'Auto-Complete: senden' : 'Auto-Complete: vorschlagen'));
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    async onAutocompleteDelayChange(n) {
      const v = Math.max(1000, Math.min(60000, Math.floor(Number(n) || 8000)));
      this.settings.autocomplete_delay_ms = v;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ autocomplete_delay_ms: v })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    onWsAutocomplete(payload) {
      if (!payload) return;
      const { action, chatId } = payload;
      this.pushLog({
        level: action === 'failed' ? 'error' : 'info',
        msg: `autocomplete ${action || ''}`.trim(),
        meta: payload,
        t: Date.now(),
      });
      if (chatId && chatId !== this.selectedChatId) return;
      if (action === 'scheduled') {
        this.toast(`Auto-Complete in ${Math.round((payload.delay || 0) / 1000)}s`, 'info');
      } else if (action === 'sent') {
        this.toast('Auto-Complete gesendet', 'info');
      } else if (action === 'failed') {
        this.toast('Auto-Complete fehlgeschlagen', 'error');
      }
    },

    // ───── Safety + Cooldown + Global config (Bundle H) ─────
    async onSafetyModeChange(mode) {
      const v = ['off', 'risk_aware', 'always_suggest', 'never_send'].includes(mode) ? mode : 'off';
      this.settings.safety_mode = v;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ safety_mode: v })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        const labels = {
          off: 'Safety aus',
          risk_aware: 'Safety: risiko-bewusst',
          always_suggest: 'Safety: immer Vorschlag',
          never_send: 'Safety: nie senden',
        };
        this.toast(labels[v] || 'Safety geändert');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    async onCooldownMinutesChange(minutes) {
      const m = Math.max(0, Math.min(1440, Math.floor(Number(minutes) || 0)));
      const ms = m * 60000;
      this.settings.cooldown_after_manual_ms = ms;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ cooldown_after_manual_ms: ms })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    // Bundle L — Privacy: per-chat opt-out from any AI processing.
    async onNeverToAiChange(value) {
      const on = !!value;
      this.settings.never_to_ai = on ? 1 : 0;
      if (!this.selectedChatId) return;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/settings'), {
          method: 'PUT',
          body: JSON.stringify({ never_to_ai: on })
        });
        if (data.settings) this.settings = Object.assign(this.settings, data.settings);
        this.toast(on ? 'Chat ist jetzt KI-frei' : 'KI-Verarbeitung wieder erlaubt');
      } catch (e) {
        this.toast('Fehler: ' + e.message, 'error');
      }
    },

    safetyModeHelp() {
      const mode = this.settings && this.settings.safety_mode ? this.settings.safety_mode : 'off';
      switch (mode) {
        case 'risk_aware':
          return 'Bei riskanten Inhalten (Geld, Termine, Konflikte, sensible Themen, unbekannte Medien) wird die Antwort als Vorschlag vorgelegt statt automatisch gesendet.';
        case 'always_suggest':
          return 'Jede KI-Antwort wird als Vorschlag vorgelegt — unabhängig vom Vorschlags-Modus.';
        case 'never_send':
          return 'Es wird gar nichts gesendet und kein Vorschlag erzeugt.';
        default:
          return 'Normales Verhalten gemäß Auto-/Vorschlags-Modus.';
      }
    },

    // formatRelative() moved to js/utils.js

    async loadGlobalConfig() {
      try {
        const data = await this.api('/api/config');
        if (data && data.config) {
          this.globalConfig = Object.assign({}, this.globalConfig, data.config);
        }
      } catch (e) {
        console.warn('config fetch failed', e);
      }
    },

    async openGlobalSettings() {
      await this.loadGlobalConfig();
      this.globalSettingsOpen = true;
    },

    async saveGlobalConfig() {
      try {
        const body = {
          quiet_hours_enabled: !!this.globalConfig.quiet_hours_enabled,
          quiet_hours_start: this.globalConfig.quiet_hours_start || '22:00',
          quiet_hours_end: this.globalConfig.quiet_hours_end || '08:00',
          quiet_hours_allow_suggestions: !!this.globalConfig.quiet_hours_allow_suggestions,
        };
        const data = await this.api('/api/config', {
          method: 'PUT',
          body: JSON.stringify(body)
        });
        if (data && data.config) {
          this.globalConfig = Object.assign({}, this.globalConfig, data.config);
        }
        this.toast('Globale Einstellungen gespeichert');
        this.globalSettingsOpen = false;
      } catch (e) {
        this.toast('Speichern fehlgeschlagen: ' + e.message, 'error');
      }
    },

    // ───── user profile + personal schedule (Bundle M) ─────
    _normalizeUserProfile(p) {
      return {
        name: p?.name ?? '',
        bio_short: p?.bio_short ?? '',
        bio_full: p?.bio_full ?? '',
        mood_today: p?.mood_today ?? '',
        energy_today: p?.energy_today ?? '',
        current_focus: p?.current_focus ?? '',
      };
    },

    async openProfileModal() {
      this.profileOpen = true;
      this.editingScheduleEntry = null;
      await Promise.all([
        this.loadUserProfile(),
        this.loadSchedule(),
        this.loadScheduleStatus(),
      ]);
    },

    async loadUserProfile() {
      try {
        const data = await this.api('/api/profile');
        this.userProfile = this._normalizeUserProfile(data?.profile || {});
      } catch (e) {
        console.warn('profile fetch failed', e);
      }
    },

    async saveUserProfile() {
      this.profileSaving = true;
      try {
        const body = {
          name: this.userProfile.name || null,
          bio_short: this.userProfile.bio_short || null,
          bio_full: this.userProfile.bio_full || null,
          mood_today: this.userProfile.mood_today || null,
          energy_today: this.userProfile.energy_today || null,
          current_focus: this.userProfile.current_focus || null,
        };
        const data = await this.api('/api/profile', {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        if (data && data.profile) {
          this.userProfile = this._normalizeUserProfile(data.profile);
        }
        this.toast('Profil gespeichert');
      } catch (e) {
        this.toast('Speichern fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.profileSaving = false;
      }
    },

    async loadSchedule() {
      try {
        const data = await this.api('/api/schedule');
        this.schedule = Array.isArray(data?.entries) ? data.entries : [];
      } catch (e) {
        console.warn('schedule fetch failed', e);
        this.schedule = [];
      }
    },

    async loadScheduleStatus() {
      try {
        const data = await this.api('/api/schedule/status');
        this.scheduleStatus = data?.status || { active: [], upcoming: [] };
      } catch (e) {
        this.scheduleStatus = { active: [], upcoming: [] };
      }
    },

    _tsToLocalInput(ts) {
      if (!ts) return '';
      const d = new Date(Number(ts));
      if (Number.isNaN(d.getTime())) return '';
      // datetime-local needs YYYY-MM-DDTHH:MM in *local* time.
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
    },
    _localInputToTs(s) {
      if (!s) return null;
      const t = Date.parse(s);
      return Number.isFinite(t) ? t : null;
    },

    newScheduleEntry() {
      this.editingScheduleEntry = {
        id: null,
        kind: 'once',
        title: '',
        notes: '',
        start_local: '',
        end_local: '',
        start_time: '09:00',
        end_time: '10:00',
        recurrence_set: [],
        busy: true,
        enabled: true,
      };
    },

    editScheduleEntry(e) {
      const recurrence_set = String(e.recurrence || '')
        .split(',').map((t) => t.trim().toUpperCase()).filter(Boolean);
      this.editingScheduleEntry = {
        id: e.id,
        kind: e.kind || 'once',
        title: e.title || '',
        notes: e.notes || '',
        start_local: this._tsToLocalInput(e.start_ts),
        end_local: this._tsToLocalInput(e.end_ts),
        start_time: e.start_time || '09:00',
        end_time: e.end_time || '10:00',
        recurrence_set,
        busy: e.busy !== 0 && e.busy !== false,
        enabled: e.enabled !== 0 && e.enabled !== false,
      };
    },

    toggleRecurrenceDay(d) {
      if (!this.editingScheduleEntry) return;
      const set = Array.isArray(this.editingScheduleEntry.recurrence_set)
        ? [...this.editingScheduleEntry.recurrence_set] : [];
      // DAILY is mutually exclusive with weekday tokens.
      if (d === 'DAILY') {
        if (set.includes('DAILY')) {
          this.editingScheduleEntry.recurrence_set = [];
        } else {
          this.editingScheduleEntry.recurrence_set = ['DAILY'];
        }
        return;
      }
      const filtered = set.filter((x) => x !== 'DAILY');
      const idx = filtered.indexOf(d);
      if (idx >= 0) filtered.splice(idx, 1);
      else filtered.push(d);
      this.editingScheduleEntry.recurrence_set = filtered;
    },

    async saveScheduleEntry() {
      if (!this.editingScheduleEntry) return;
      const e = this.editingScheduleEntry;
      const title = String(e.title || '').trim();
      if (!title) { this.toast('Titel ist Pflicht', 'error'); return; }

      const body = {
        kind: e.kind,
        title,
        notes: e.notes || null,
        busy: !!e.busy,
        enabled: !!e.enabled,
      };

      if (e.kind === 'once') {
        const startTs = this._localInputToTs(e.start_local);
        if (!startTs) { this.toast('Startzeit ist Pflicht', 'error'); return; }
        body.start_ts = startTs;
        const endTs = this._localInputToTs(e.end_local);
        body.end_ts = endTs || (startTs + 3600 * 1000);
      } else {
        if (!e.start_time || !e.end_time) { this.toast('Von/Bis sind Pflicht', 'error'); return; }
        const rec = Array.isArray(e.recurrence_set) ? e.recurrence_set : [];
        if (!rec.length) { this.toast('Mindestens einen Tag wählen', 'error'); return; }
        body.start_time = e.start_time;
        body.end_time = e.end_time;
        body.recurrence = rec.join(',');
      }

      this.scheduleEntrySaving = true;
      try {
        if (e.id) {
          await this.api('/api/schedule/' + encodeURIComponent(e.id), {
            method: 'PUT',
            body: JSON.stringify(body),
          });
          this.toast('Eintrag aktualisiert');
        } else {
          await this.api('/api/schedule', {
            method: 'POST',
            body: JSON.stringify(body),
          });
          this.toast('Eintrag erstellt');
        }
        this.editingScheduleEntry = null;
        await Promise.all([this.loadSchedule(), this.loadScheduleStatus()]);
      } catch (err) {
        this.toast('Speichern fehlgeschlagen: ' + err.message, 'error');
      } finally {
        this.scheduleEntrySaving = false;
      }
    },

    async deleteScheduleEntryClick(e) {
      if (!e || !e.id) return;
      if (!window.confirm(`"${e.title}" löschen?`)) return;
      try {
        await this.api('/api/schedule/' + encodeURIComponent(e.id), { method: 'DELETE' });
        this.toast('Eintrag gelöscht');
        await Promise.all([this.loadSchedule(), this.loadScheduleStatus()]);
      } catch (err) {
        this.toast('Löschen fehlgeschlagen: ' + err.message, 'error');
      }
    },

    async toggleScheduleEntryEnabled(e) {
      if (!e || !e.id) return;
      try {
        await this.api('/api/schedule/' + encodeURIComponent(e.id), {
          method: 'PUT',
          body: JSON.stringify({ enabled: !e.enabled }),
        });
        await Promise.all([this.loadSchedule(), this.loadScheduleStatus()]);
      } catch (err) {
        this.toast('Umschalten fehlgeschlagen: ' + err.message, 'error');
      }
    },

    formatScheduleSpec(e) {
      if (!e) return '';
      if (e.kind === 'once') {
        const start = e.start_ts ? new Date(Number(e.start_ts)) : null;
        const end = e.end_ts ? new Date(Number(e.end_ts)) : null;
        if (!start) return 'einmalig';
        const fmtDate = start.toLocaleString('de-DE', {
          weekday: 'short', day: '2-digit', month: '2-digit',
          hour: '2-digit', minute: '2-digit',
        });
        if (end) {
          const fmtEnd = end.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
          return `${fmtDate}–${fmtEnd}`;
        }
        return fmtDate;
      }
      const rec = String(e.recurrence || '').split(',').map((t) => t.trim()).filter(Boolean);
      const days = rec.includes('DAILY') ? 'Täglich' : rec.join(',');
      return `${days} ${e.start_time || ''}–${e.end_time || ''}`.trim();
    },

    onWsSafety(payload) {
      if (!payload) return;
      this.pushLog({
        level: 'info',
        msg: `safety ${payload.action || ''}`.trim(),
        meta: payload,
        t: Date.now(),
      });
      if (payload.chatId && payload.chatId !== this.selectedChatId) return;
      const cats = Array.isArray(payload.categories) && payload.categories.length
        ? ' (' + payload.categories.join(', ') + ')'
        : '';
      if (payload.action === 'blocked') {
        this.toast('Safety hat geblockt' + cats, 'info');
      } else if (payload.action === 'downgraded_to_suggest') {
        this.toast('Safety: als Vorschlag' + cats, 'info');
      }
    },

    onWsQuality(payload) {
      if (!payload) return;
      const sc = payload.score || {};
      const flags = [];
      if (sc.too_long) flags.push('zu lang');
      if (sc.too_formal) flags.push('zu formell');
      if (sc.hallucination) flags.push('halluziniert');
      if (sc.needless_question) flags.push('unnötige Rückfrage');
      const action = payload.action || 'rated';
      const score = typeof sc.overall_score === 'number' ? sc.overall_score : '?';
      const tag = action === 'rejected' ? 'verworfen' :
                  action === 'regenerating' ? 'wird neu generiert' :
                  'bewertet';
      const flagsTxt = flags.length ? ` — ${flags.join(', ')}` : '';
      const level = action === 'rejected' ? 'warn' : 'info';
      this.pushLog({
        level,
        msg: `Qualität: ${score} (${tag})${flagsTxt}`,
        meta: payload,
        t: Date.now(),
      });
      if (action === 'rejected') {
        this.toast(`Antwort verworfen (Qualität ${score})`, 'error');
      }
    },

    async sendVariant(idx) {
      if (!this.pendingSuggestion || this.suggestionSending) return;
      this.suggestionSending = true;
      try {
        await this.api(`/api/suggestions/${this.pendingSuggestion.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ index: idx })
        });
        // WS will clear pendingSuggestion via suggestion_resolved
        this.pendingSuggestion = null;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
        this.toast('Vorschlag gesendet');
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.suggestionSending = false;
      }
    },

    async discardSuggestion() {
      if (!this.pendingSuggestion) return;
      try {
        await this.api(`/api/suggestions/${this.pendingSuggestion.id}/discard`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        this.pendingSuggestion = null;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
        this.toast('Vorschlag verworfen');
      } catch (e) {
        this.toast('Verwerfen fehlgeschlagen: ' + e.message, 'error');
      }
    },

    editVariant(idx) {
      if (!this.pendingSuggestion) return;
      this.editingVariantIdx = idx;
      this.editingVariantText = String(this.pendingSuggestion.variants[idx] || '');
    },

    cancelEditVariant() {
      this.editingVariantIdx = null;
      this.editingVariantText = '';
    },

    async confirmEditedSend() {
      if (!this.pendingSuggestion || this.suggestionSending) return;
      const text = (this.editingVariantText || '').trim();
      if (!text) return;
      this.suggestionSending = true;
      try {
        await this.api(`/api/suggestions/${this.pendingSuggestion.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ index: this.editingVariantIdx ?? 0, body: text })
        });
        this.pendingSuggestion = null;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
        this.toast('Bearbeiteter Vorschlag gesendet');
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.suggestionSending = false;
      }
    },

    onWsSuggestion({ chatId, suggestion }) {
      if (!suggestion) return;
      if (chatId === this.selectedChatId) {
        this.pendingSuggestion = suggestion;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
      }
      // Keep the cross-chat inbox in sync — both for new suggestions and for
      // regenerate-overwrites of an existing one.
      if (this.inboxOpen) this.loadInbox();
      else this.refreshInboxCount();
    },

    onWsSuggestionResolved({ chatId, suggestionId }) {
      if (chatId === this.selectedChatId
          && this.pendingSuggestion
          && this.pendingSuggestion.id === suggestionId) {
        this.pendingSuggestion = null;
        this.editingVariantIdx = null;
        this.editingVariantText = '';
      }
      if (this.inboxOpen) this.loadInbox();
      else this.refreshInboxCount();
    },

    // ───── approval inbox (Bundle I) ─────
    async loadInbox() {
      try {
        const data = await this.api('/api/inbox');
        this.inbox = data.suggestions || [];
      } catch (e) {
        // keep previous; only toast when the inbox is open
        if (this.inboxOpen) this.toast('Inbox laden fehlgeschlagen: ' + e.message, 'error');
      }
    },
    // Background-friendly: never toasts on failure.
    refreshInboxCount() {
      this.loadInbox().catch(() => { /* ignore */ });
    },
    async openInbox() {
      this.inboxOpen = true;
      await this.loadInbox();
    },
    goToInboxChat(chatId) {
      if (!chatId) return;
      this.inboxOpen = false;
      this.selectChat(chatId);
    },
    _setInboxBusy(id, busy) {
      const next = { ...this.inboxBusy };
      if (busy) next[id] = true; else delete next[id];
      this.inboxBusy = next;
    },
    async inboxSend(s, idx) {
      if (!s || this.inboxBusy[s.id]) return;
      this._setInboxBusy(s.id, true);
      try {
        await this.api(`/api/suggestions/${s.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ index: idx })
        });
        // suggestion_resolved WS event will reload; remove optimistically.
        this.inbox = this.inbox.filter((x) => x.id !== s.id);
        this.toast('Vorschlag gesendet');
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this._setInboxBusy(s.id, false);
      }
    },
    async inboxEdit(s, idx) {
      if (!s || this.inboxBusy[s.id]) return;
      const current = String((s.variants && s.variants[idx]) || '');
      // eslint-disable-next-line no-alert
      const next = window.prompt('Bearbeiten und senden:', current);
      if (next == null) return; // user cancelled
      const text = String(next).trim();
      if (!text) return;
      this._setInboxBusy(s.id, true);
      try {
        await this.api(`/api/suggestions/${s.id}/send`, {
          method: 'POST',
          body: JSON.stringify({ index: idx, body: text })
        });
        this.inbox = this.inbox.filter((x) => x.id !== s.id);
        this.toast('Bearbeiteter Vorschlag gesendet');
      } catch (e) {
        this.toast('Senden fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this._setInboxBusy(s.id, false);
      }
    },
    async inboxDiscard(s) {
      if (!s || this.inboxBusy[s.id]) return;
      this._setInboxBusy(s.id, true);
      try {
        await this.api(`/api/suggestions/${s.id}/discard`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        this.inbox = this.inbox.filter((x) => x.id !== s.id);
        this.toast('Vorschlag verworfen');
      } catch (e) {
        this.toast('Verwerfen fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this._setInboxBusy(s.id, false);
      }
    },
    async inboxRegenerate(s) {
      if (!s || this.inboxBusy[s.id]) return;
      this._setInboxBusy(s.id, true);
      try {
        const data = await this.api(`/api/suggestions/${s.id}/regenerate`, {
          method: 'POST',
          body: JSON.stringify({})
        });
        // Update in place; WS will also broadcast.
        if (data.suggestion) {
          const idx = this.inbox.findIndex((x) => x.id === s.id);
          if (idx >= 0) this.inbox[idx] = data.suggestion;
        }
        this.toast('Neu generiert');
      } catch (e) {
        this.toast('Generieren fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this._setInboxBusy(s.id, false);
      }
    },

    // ───── contact profile card (Bundle I) ─────
    async loadProfile() {
      if (!this.selectedChatId) {
        this.profile = null;
        return;
      }
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/profile'));
        this.profile = data.profile || null;
      } catch (e) {
        this.profile = null;
      }
    },

    // ───── bio suggestions + structured contact bio (Bundle N) ─────
    async loadBioSuggestions() {
      try {
        const data = await this.api('/api/bio-suggestions?status=pending');
        this.bioSuggestions = data.suggestions || [];
      } catch (e) {
        // keep previous on failure
      }
    },
    async openBioSuggestions() {
      this.bioSuggestionsOpen = true;
      await this.loadBioSuggestions();
    },
    async acceptBioSuggestion(s) {
      if (!s) return;
      try {
        await this.api(`/api/bio-suggestions/${s.id}/accept`, { method: 'POST' });
        this.bioSuggestions = this.bioSuggestions.filter((x) => x.id !== s.id);
        this.toast('Übernommen');
        // If the accepted bio belongs to the currently open chat, refresh memory + profile.
        if (s.target === 'chat' && s.chat_id === this.selectedChatId) {
          this.loadMemory();
          this.loadProfile();
        }
      } catch (e) {
        this.toast('Übernehmen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async dismissBioSuggestion(s) {
      if (!s) return;
      try {
        await this.api(`/api/bio-suggestions/${s.id}/dismiss`, { method: 'POST' });
        this.bioSuggestions = this.bioSuggestions.filter((x) => x.id !== s.id);
        this.toast('Verworfen');
      } catch (e) {
        this.toast('Verwerfen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    goToBioChat(chatId) {
      if (!chatId) return;
      this.bioSuggestionsOpen = false;
      this.selectChat(chatId);
    },
    async loadContactBio() {
      if (!this.selectedChatId) {
        this.contactBio = null;
        return;
      }
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/bio'));
        this.contactBio = data.bio || null;
      } catch (e) {
        this.contactBio = null;
      }
    },
    editContactBio() {
      const b = this.contactBio || {};
      this.contactBioDraft = {
        relationship: b.relationship || '',
        how_met: b.how_met || '',
        tone_pref: b.tone_pref || '',
        topics: Array.isArray(b.topics) ? b.topics.join(', ') : '',
        no_gos: Array.isArray(b.no_gos) ? b.no_gos.join(', ') : '',
      };
      this.contactBioEditing = true;
    },
    async saveContactBio() {
      if (!this.selectedChatId || this.contactBioSaving) return;
      this.contactBioSaving = true;
      const d = this.contactBioDraft;
      const splitList = (s) => String(s || '')
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
      const body = {
        relationship: String(d.relationship || '').trim() || null,
        how_met: String(d.how_met || '').trim() || null,
        tone_pref: String(d.tone_pref || '').trim() || null,
        topics: splitList(d.topics),
        no_gos: splitList(d.no_gos),
      };
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/bio'), {
          method: 'PUT',
          body: JSON.stringify(body),
        });
        this.contactBio = data.bio || null;
        this.contactBioEditing = false;
        this.toast('Bio gespeichert');
        // Re-pull the contact-profile card so any combined view stays consistent.
        this.loadProfile();
      } catch (e) {
        this.toast('Bio speichern fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.contactBioSaving = false;
      }
    },
    async clearContactBio() {
      if (!this.selectedChatId) return;
      // eslint-disable-next-line no-alert
      if (!window.confirm('Strukturierte Bio dieses Chats wirklich löschen?')) return;
      try {
        await this.api(this.chatPath(this.selectedChatId, '/bio'), { method: 'DELETE' });
        this.contactBio = null;
        this.contactBioEditing = false;
        this.toast('Bio gelöscht');
        this.loadProfile();
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },

    onWsTranscript({ chatId, messageId, transcript }) {
      if (chatId !== this.selectedChatId) return;
      const m = this.messages.find((x) => x.id === messageId);
      if (m) m.transcript = transcript;
    },

    async retranscribe(mediaId) {
      try {
        const data = await this.api(`/api/media/${encodeURIComponent(mediaId)}/transcribe`, { method: 'POST' });
        this.toast('Transkription erneuert', 'info');
        return data;
      } catch (e) {
        this.toast('Transkription fehlgeschlagen: ' + e.message, 'error');
      }
    },

    onWsMedia({ chatId, media }) {
      if (!media) return;
      // Update chat list count
      const c = this.chats.find((x) => x.id === chatId);
      if (c) c.media_count = (c.media_count || 0) + 1;
      // If matching open chat, merge into local store
      if (chatId === this.selectedChatId) {
        const exists = this.mediaList.find((m) => m.id === media.id);
        if (!exists) {
          this.mediaList = [media, ...this.mediaList];
          if (media.message_id) this.mediaByMsg[media.message_id] = media;
        }
      }
      this.loadStats();
    },

    onWsPersonas({ action, persona, id }) {
      if (action === 'created' && persona) {
        if (!this.personas.find((p) => p.id === persona.id)) this.personas.push(persona);
      } else if (action === 'updated' && persona) {
        const idx = this.personas.findIndex((p) => p.id === persona.id);
        if (idx >= 0) this.personas[idx] = persona; else this.personas.push(persona);
      } else if (action === 'deleted' && id) {
        this.personas = this.personas.filter((p) => p.id !== id);
        for (const c of this.chats) if (c.persona_id === id) c.persona_id = null;
        if (this.settings.persona_id === id) this.settings.persona_id = null;
      } else {
        // unknown: just refresh
        this.loadPersonas();
      }
    },

    onWsQueue({ chatId, jobId, status, fireAt }) {
      if (chatId !== this.selectedChatId) return;
      if (status === 'pending') {
        this.pendingReply = { jobId, fireAt: fireAt || (Date.now() + 5000) };
        this.tickPending();
      } else if (status === 'sent' || status === 'cancelled') {
        if (this.pendingReply && this.pendingReply.jobId === jobId) {
          this.pendingReply = null;
        }
      }
    },

    tickPending() {
      if (!this.pendingReply) { this.pendingCountdown = 0; return; }
      const remaining = Math.max(0, (this.pendingReply.fireAt || 0) - Date.now());
      this.pendingCountdown = remaining;
    },

    // pushLog(), statusLabel(), displayName(), initials(), truncate(),
    // formatTime(), formatDateTime(), formatCountdown(), formatBytes(),
    // scrollMessagesToBottom() — moved to js/utils.js

    // ───── QR rendering ─────
    renderQr() {
      const canvas = this.$refs.qrCanvas;
      if (!canvas || !this.qrString || typeof QRCode === 'undefined') return;
      QRCode.toCanvas(canvas, this.qrString, { width: 296, margin: 1 }, (err) => {
        if (err) console.error('qr render failed', err);
      });
    },

    // ───── AI session (goal-driven autonomous dialog) ─────
    openSessionDialog() {
      this.sessionDraft = { initial_prompt: '', max_turns: 20, stop_keywords: '' };
      this.sessionDialogOpen = true;
      this.$nextTick(() => {
        if (this.$refs.sessionPromptInput) this.$refs.sessionPromptInput.focus();
      });
    },
    closeSessionDialog() {
      this.sessionDialogOpen = false;
    },
    async loadActiveSession() {
      if (!this.selectedChatId) { this.activeSession = null; return; }
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/session'));
        this.activeSession = data.session || null;
      } catch (_) {
        this.activeSession = null;
      }
    },
    async startSession() {
      if (!this.selectedChatId) return;
      const prompt = (this.sessionDraft.initial_prompt || '').trim();
      if (!prompt) { this.toast('Ziel-Prompt ist leer', 'error'); return; }
      const maxTurns = Math.max(1, Math.min(100, Number(this.sessionDraft.max_turns) || 20));
      const stopKw = (this.sessionDraft.stop_keywords || '').trim() || null;
      this.sessionStarting = true;
      try {
        const data = await this.api(this.chatPath(this.selectedChatId, '/session'), {
          method: 'POST',
          body: JSON.stringify({
            initial_prompt: prompt,
            max_turns: maxTurns,
            stop_keywords: stopKw,
          }),
        });
        this.activeSession = data.session || null;
        this.sessionDialogOpen = false;
        this.toast('AI-Session gestartet', 'info');
      } catch (e) {
        this.toast('Konnte Session nicht starten: ' + e.message, 'error');
      } finally {
        this.sessionStarting = false;
      }
    },
    async pauseSession() {
      const s = this.activeSession;
      if (!s) return;
      try {
        await this.api(`/api/sessions/${encodeURIComponent(s.id)}/pause`, { method: 'POST' });
        this.activeSession = null;
        this.toast('Session pausiert', 'info');
      } catch (e) {
        this.toast('Pause fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async stopSession() {
      const s = this.activeSession;
      if (!s) return;
      try {
        await this.api(`/api/sessions/${encodeURIComponent(s.id)}/stop`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'manual_stop' }),
        });
        this.activeSession = null;
        this.toast('Session gestoppt', 'info');
      } catch (e) {
        this.toast('Stop fehlgeschlagen: ' + e.message, 'error');
      }
    },
    onWsAiSession(msg) {
      if (!msg) return;
      // If Sessions view is open, keep the list fresh.
      if (this.currentView === 'sessions') this.loadSessions();
      if (!msg.chatId) return;
      if (msg.chatId !== this.selectedChatId) return;
      const sess = msg.session || null;
      const action = String(msg.action || '');
      if (action === 'ended' || action === 'paused') {
        this.activeSession = null;
      } else if (sess && (sess.status === 'active')) {
        this.activeSession = sess;
      } else {
        // started/turn/resumed → update if active
        if (sess && sess.status === 'active') this.activeSession = sess;
        else this.activeSession = null;
      }
    },

    // goView(), toggleSettingsSection(), inboxTotalCount() — moved to js/views.js

    // ───── AI sessions list (Sessions view) ─────
    async loadSessions() {
      this.sessionsLoading = true;
      try {
        const data = await this.api('/api/sessions');
        this.sessions = Array.isArray(data?.sessions) ? data.sessions : [];
      } catch (e) {
        this.sessions = [];
        // Quiet failure — endpoint may not always be available.
      } finally {
        this.sessionsLoading = false;
      }
    },
    sessionChatName(s) {
      if (!s) return '';
      const c = this.chats.find((x) => x.id === s.chat_id);
      return c ? this.displayName(c) : (s.chat_id || '—');
    },
    async resumeSessionRow(s) {
      if (!s || !s.id) return;
      try {
        await this.api(`/api/sessions/${encodeURIComponent(s.id)}/resume`, { method: 'POST' });
        await this.loadSessions();
        this.toast('Session fortgesetzt', 'info');
      } catch (e) {
        this.toast('Fortsetzen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async pauseSessionRow(s) {
      if (!s || !s.id) return;
      try {
        await this.api(`/api/sessions/${encodeURIComponent(s.id)}/pause`, { method: 'POST' });
        await this.loadSessions();
        if (this.activeSession && this.activeSession.id === s.id) this.activeSession = null;
        this.toast('Session pausiert', 'info');
      } catch (e) {
        this.toast('Pause fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async stopSessionRow(s) {
      if (!s || !s.id) return;
      try {
        await this.api(`/api/sessions/${encodeURIComponent(s.id)}/stop`, {
          method: 'POST',
          body: JSON.stringify({ reason: 'manual_stop' }),
        });
        await this.loadSessions();
        if (this.activeSession && this.activeSession.id === s.id) this.activeSession = null;
        this.toast('Session gestoppt', 'info');
      } catch (e) {
        this.toast('Stop fehlgeschlagen: ' + e.message, 'error');
      }
    },
    openChatFromSession(s) {
      if (!s || !s.chat_id) return;
      this.currentView = 'chats';
      this.selectChat(s.chat_id);
    },

    // ───── log helpers (filter + expand) ─────
    // Returns the log entries matching the current `logFilter`. We tag each
    // with its original index so the template can toggle expansion correctly.
    filteredLogs() {
      const f = this.logFilter || 'all';
      const out = [];
      for (let i = 0; i < this.logs.length; i += 1) {
        const l = this.logs[i];
        const lvl = l.level || 'info';
        if (f === 'all' || lvl === f) out.push({ idx: i, l });
      }
      return out;
    },
    logLevelCount(level) {
      if (level === 'all') return this.logs.length;
      return this.logs.filter((l) => (l.level || 'info') === level).length;
    },
    toggleLogExpanded(idx) {
      this.expandedLogIdx = (this.expandedLogIdx === idx) ? -1 : idx;
    },
    prettyMeta(meta) {
      if (meta === null || meta === undefined) return '';
      try {
        if (typeof meta === 'string') {
          // Try to parse — if it's a JSON string, format it; else show as-is.
          try { return JSON.stringify(JSON.parse(meta), null, 2); }
          catch (_) { return meta; }
        }
        return JSON.stringify(meta, null, 2);
      } catch (_) { return String(meta); }
    },

    // toast(), showToast() — moved to js/utils.js

    // ═════════════════════════════════════════════════════════════
    // ───── 📅 Calendar sources + appointments ─────
    // ═════════════════════════════════════════════════════════════
    async loadCalendarSources() {
      try {
        const data = await this.api('/api/calendar/sources');
        this.calendarSources = Array.isArray(data?.sources) ? data.sources : [];
      } catch (e) {
        console.warn('calendar sources fetch failed', e);
        this.calendarSources = [];
      }
    },

    newCalendarSource() {
      this.editingCalendarSource = {
        id: null,
        name: '',
        ical_url: '',
        color: '#10b981',
        enabled: true,
      };
    },

    editCalendarSource(s) {
      this.editingCalendarSource = {
        id: s.id,
        name: s.name || '',
        ical_url: s.ical_url || '',
        color: s.color || '#10b981',
        enabled: !!s.enabled,
      };
    },

    async saveCalendarSource() {
      if (!this.editingCalendarSource) return;
      const s = this.editingCalendarSource;
      const name = String(s.name || '').trim();
      if (!name) { this.toast('Name fehlt', 'error'); return; }
      const url = String(s.ical_url || '').trim();
      if (!url) { this.toast('iCal-URL fehlt', 'error'); return; }
      const body = { name, ical_url: url, color: s.color || null, enabled: !!s.enabled };
      this.calendarSourceSaving = true;
      try {
        if (s.id) {
          await this.api('/api/calendar/sources/' + encodeURIComponent(s.id), {
            method: 'PUT', body: JSON.stringify(body),
          });
          this.toast('Kalender aktualisiert');
        } else {
          await this.api('/api/calendar/sources', {
            method: 'POST', body: JSON.stringify(body),
          });
          this.toast('Kalender hinzugefügt — wird im Hintergrund geladen');
        }
        this.editingCalendarSource = null;
        await this.loadCalendarSources();
      } catch (err) {
        this.toast('Speichern fehlgeschlagen: ' + err.message, 'error');
      } finally {
        this.calendarSourceSaving = false;
      }
    },

    async toggleCalendarSourceEnabled(s) {
      if (!s || !s.id) return;
      try {
        await this.api('/api/calendar/sources/' + encodeURIComponent(s.id), {
          method: 'PUT',
          body: JSON.stringify({ enabled: !s.enabled }),
        });
        await this.loadCalendarSources();
      } catch (err) {
        this.toast('Update fehlgeschlagen: ' + err.message, 'error');
      }
    },

    async refreshCalendarSource(s) {
      if (!s || !s.id) return;
      this.calendarRefreshing = { ...this.calendarRefreshing, [s.id]: true };
      try {
        await this.api('/api/calendar/sources/' + encodeURIComponent(s.id) + '/refresh', {
          method: 'POST',
        });
        await this.loadCalendarSources();
        await this.loadCalendarAvailability();
      } catch (err) {
        this.toast('Refresh fehlgeschlagen: ' + err.message, 'error');
      } finally {
        const next = { ...this.calendarRefreshing };
        delete next[s.id];
        this.calendarRefreshing = next;
      }
    },

    async deleteCalendarSourceClick(s) {
      if (!s || !s.id) return;
      if (!window.confirm(`Kalender "${s.name}" löschen?`)) return;
      try {
        await this.api('/api/calendar/sources/' + encodeURIComponent(s.id), { method: 'DELETE' });
        this.toast('Kalender gelöscht');
        await this.loadCalendarSources();
        await this.loadCalendarAvailability();
      } catch (err) {
        this.toast('Löschen fehlgeschlagen: ' + err.message, 'error');
      }
    },

    maskUrl(url) {
      if (!url) return '';
      const s = String(url);
      if (s.length <= 60) return s;
      return s.slice(0, 32) + '…' + s.slice(-20);
    },

    async loadCalendarAvailability() {
      try {
        const data = await this.api('/api/calendar/availability?days=14&dayStart=09:00&dayEnd=21:00');
        this.calendarAvailability = data || { busy: [], free: [], summary: '', from: 0, to: 0 };
        this._buildCalendarHeatmap();
      } catch (e) {
        console.warn('availability fetch failed', e);
        this.calendarAvailability = { busy: [], free: [], summary: '', from: 0, to: 0 };
        this.calendarHeatmap = [];
      }
    },

    _buildCalendarHeatmap() {
      const a = this.calendarAvailability || {};
      const from = Number(a.from) || 0;
      const days = 14;
      if (!from) { this.calendarHeatmap = []; return; }
      // Business hours: 9-21
      const bh = (h) => h >= 9 && h < 21;
      const dayMs = 24 * 3600 * 1000;
      const hourMs = 3600 * 1000;
      const SHORT_DOW = ['So', 'Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa'];
      const rows = [];
      for (let d = 0; d < days; d++) {
        const dayStart = from + d * dayMs;
        const dayEnd = dayStart + dayMs;
        const dt = new Date(dayStart);
        const cells = [];
        for (let h = 0; h < 24; h++) {
          const cellStart = dayStart + h * hourMs;
          const cellEnd = cellStart + hourMs;
          // Determine busy?
          let isBusy = false;
          for (const b of (a.busy || [])) {
            if (b.end_ts > cellStart && b.start_ts < cellEnd) { isBusy = true; break; }
          }
          let kind = isBusy ? 'busy' : (bh(h) ? 'free' : 'off');
          const startLabel = `${String(h).padStart(2, '0')}:00`;
          const endLabel = `${String((h + 1) % 24).padStart(2, '0')}:00`;
          cells.push({ kind, label: `${startLabel}–${endLabel} (${kind})` });
        }
        rows.push({
          label: `${SHORT_DOW[dt.getDay()]} ${dt.getDate()}.${dt.getMonth() + 1}.`,
          cells,
        });
        void dayEnd;
      }
      this.calendarHeatmap = rows;
    },

    chatNameById(chatId) {
      if (!chatId) return '';
      const c = (this.chats || []).find((x) => x.id === chatId);
      return c ? (c.name || chatId) : chatId;
    },

    async loadAppointments() {
      try {
        const since = Date.now() - 24 * 3600 * 1000;
        const data = await this.api('/api/appointments?since=' + since + '&limit=100');
        this.appointments = Array.isArray(data?.appointments) ? data.appointments : [];
      } catch (e) {
        console.warn('appointments fetch failed', e);
        this.appointments = [];
      }
    },

    appointmentsFeedUrl() {
      // Direct download — needs no JS auth header (the server gates /api on
      // bearer token, but the link still works for unauthed dev/local setups).
      // For token-gated setups the user copies the URL into a calendar client
      // that supports Bearer headers.
      const since = 'now';
      let url = '/api/appointments.ics?since=' + since;
      if (this.token) url += '&token=' + encodeURIComponent(this.token);
      return url;
    },

    async deleteAppointmentClick(a) {
      if (!a || !a.id) return;
      if (!window.confirm(`Termin "${a.title}" löschen?`)) return;
      try {
        await this.api('/api/appointments/' + encodeURIComponent(a.id), { method: 'DELETE' });
        this.toast('Termin gelöscht');
        await this.loadAppointments();
      } catch (err) {
        this.toast('Löschen fehlgeschlagen: ' + err.message, 'error');
      }
    },
  });
}

// Belt-and-suspenders: ensure Alpine can resolve `app()` regardless of script
// loading order or browser quirks around hoisting deferred-script declarations.
if (typeof window !== 'undefined') {
  window.app = app;
}
