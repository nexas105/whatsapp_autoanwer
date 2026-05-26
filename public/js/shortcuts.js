/* Keyboard shortcuts module.
 *
 * Exposes window.AppShortcuts which is mixed into the Alpine component via
 * Object.assign in app.js. Call `this.installShortcuts()` from `init()` to
 * activate the global keydown listener.
 *
 * Shortcuts (respects input/textarea focus — most are skipped while typing):
 *   Cmd/Ctrl + K        → openSearchModal()
 *   Cmd/Ctrl + /        → goView('inbox')
 *   Cmd/Ctrl + Enter    → sendMessage() (works even while typing in compose)
 *   Esc                 → close any open modal / drawer
 *   g + <letter>        → jump to a view (c=chats, d=dashboard, i=inbox,
 *                         s=sessions, e=einstellungen, p=plan/summaries)
 *   ?                   → toggle keyboard cheatsheet
 */
(function () {
  // The "go to" prefix state — only valid for ~1.2s after pressing `g`.
  let goPrefixUntil = 0;

  const isTypingTarget = (el) => {
    if (!el) return false;
    const tag = (el.tagName || '').toUpperCase();
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (el.isContentEditable) return true;
    return false;
  };

  const isModifier = (e) => e.metaKey || e.ctrlKey;

  window.AppShortcuts = {
    // ──────────────────────────────────────────────────────────────
    // public state
    shortcutsHelpOpen: false,

    // ──────────────────────────────────────────────────────────────
    installShortcuts() {
      if (this._shortcutsInstalled) return;
      this._shortcutsInstalled = true;
      const handler = (e) => this._onGlobalKeydown(e);
      window.addEventListener('keydown', handler);
      this._shortcutsHandler = handler;
    },

    uninstallShortcuts() {
      if (this._shortcutsHandler) {
        window.removeEventListener('keydown', this._shortcutsHandler);
        this._shortcutsHandler = null;
        this._shortcutsInstalled = false;
      }
    },

    _onGlobalKeydown(e) {
      const target = e.target;
      const typing = isTypingTarget(target);

      // ─── modifier-based shortcuts work everywhere ───
      if (isModifier(e)) {
        // Cmd/Ctrl+K — open search
        if ((e.key === 'k' || e.key === 'K') && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          if (typeof this.openSearchModal === 'function') this.openSearchModal();
          return;
        }
        // Cmd/Ctrl+/ — open inbox
        if (e.key === '/' && !e.shiftKey && !e.altKey) {
          e.preventDefault();
          if (typeof this.goView === 'function') this.goView('inbox');
          return;
        }
        // Cmd/Ctrl+Enter — send message (only when compose input has focus
        // OR a chat is selected and compose has content)
        if (e.key === 'Enter') {
          // If user is in the compose textarea/input or a chat is selected, send.
          const canSend = this.selectedChatId && (this.composeText || '').trim();
          if (canSend && typeof this.sendMessage === 'function') {
            e.preventDefault();
            this.sendMessage();
            return;
          }
        }
      }

      // ─── Esc closes anything open ───
      if (e.key === 'Escape') {
        if (this._closeTopmostOverlay()) {
          e.preventDefault();
          return;
        }
      }

      // ─── Single-key shortcuts: only when NOT typing ───
      if (typing) return;

      // ? — toggle cheatsheet (shift+/ on most layouts)
      if (e.key === '?' && !isModifier(e)) {
        e.preventDefault();
        this.shortcutsHelpOpen = !this.shortcutsHelpOpen;
        return;
      }

      // g + <letter> — "go to" prefix
      if (e.key === 'g' && !isModifier(e) && !e.shiftKey && !e.altKey) {
        goPrefixUntil = Date.now() + 1200;
        e.preventDefault();
        return;
      }
      if (goPrefixUntil && Date.now() < goPrefixUntil) {
        const map = {
          c: 'chats',
          d: 'dashboard',
          i: 'inbox',
          s: 'sessions',
          e: 'settings',
          p: 'summaries',
        };
        const v = map[e.key.toLowerCase()];
        if (v) {
          e.preventDefault();
          goPrefixUntil = 0;
          if (typeof this.goView === 'function') this.goView(v);
          return;
        }
        // any other key cancels the prefix
        goPrefixUntil = 0;
      }
    },

    // ─── helpers ────────────────────────────────────────────────
    _closeTopmostOverlay() {
      // Returns true if it closed something.
      if (this.shortcutsHelpOpen)   { this.shortcutsHelpOpen = false;   return true; }
      if (this.lightbox)            { this.lightbox = null;             return true; }
      if (this.searchModalOpen)     { this.searchModalOpen = false;     return true; }
      if (this.storiesOpen)         { this.storiesOpen = false;         return true; }
      if (this.personaModalOpen)    { this.personaModalOpen = false;    return true; }
      if (this.composeOpen)         { this.composeOpen = false;         return true; }
      if (this.sessionDialogOpen)   { this.sessionDialogOpen = false;   return true; }
      if (this.chatSidebarOpen)     { this.chatSidebarOpen = false;     return true; }
      return false;
    },

    // List used by the help modal — also a single source of truth.
    shortcutsList() {
      const cmd = (navigator.platform || '').toLowerCase().includes('mac') ? '⌘' : 'Ctrl';
      return [
        { keys: [cmd, 'K'],       label: 'Suche öffnen' },
        { keys: [cmd, '/'],       label: 'Inbox öffnen' },
        { keys: [cmd, 'Enter'],   label: 'Nachricht senden (im Chat)' },
        { keys: ['Esc'],          label: 'Aktives Modal / Drawer schließen' },
        { keys: ['?'],            label: 'Diese Hilfe ein-/ausblenden' },
        { keys: ['g', 'c'],       label: 'Zu Chats' },
        { keys: ['g', 'd'],       label: 'Zu Dashboard' },
        { keys: ['g', 'i'],       label: 'Zu Inbox' },
        { keys: ['g', 's'],       label: 'Zu Sessions' },
        { keys: ['g', 'p'],       label: 'Zu Plan / Zusammenfassungen' },
        { keys: ['g', 'e'],       label: 'Zu Einstellungen' },
      ];
    },
  };
})();
