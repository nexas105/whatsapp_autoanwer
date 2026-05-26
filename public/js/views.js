/* View routing + accordion helpers for the multi-view UI.
 * Methods are mixed into the Alpine component via Object.assign in app.js.
 */
(function () {
  window.AppViews = {
    goView(v) {
      const allowed = ['chats', 'dashboard', 'inbox', 'sessions', 'summaries', 'settings'];
      if (!allowed.includes(v)) return;
      this.currentView = v;
    },
    toggleSettingsSection(key) {
      // Accordion: one open at a time. Clicking the open one collapses it.
      this.openSettingsSection = (this.openSettingsSection === key) ? '' : key;
    },
    inboxTotalCount() {
      return (this.inbox?.length || 0) + (this.bioSuggestions?.length || 0);
    },
  };
})();
