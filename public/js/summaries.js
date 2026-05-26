/* Summaries / Roadmap planning — UI for generating Markdown summaries from
 * chat history, organizing them into folders, and downloading as MD or PDF.
 *
 * Backend endpoints expected (to be added in src/api/rest.js — UI fails
 * gracefully with a toast if missing):
 *   GET    /api/summaries?folder_id=<id>      → { summaries: [...] }
 *   POST   /api/summaries                     → { summary: { id, ..., content_md } }
 *     body: { chat_id, range_kind, last_n?, from_ts?, to_ts?, template,
 *             system_prompt, title, folder_id? }
 *   GET    /api/summaries/:id                 → { summary: {...} }
 *   PUT    /api/summaries/:id                 → { summary }
 *   DELETE /api/summaries/:id
 *   GET    /api/summaries/:id/download.md     → raw markdown
 *   GET    /api/summaries/:id/download.pdf    → application/pdf
 *
 *   GET    /api/summary-folders               → { folders: [...] }
 *   POST   /api/summary-folders               → { folder }
 *   DELETE /api/summary-folders/:id
 */
(function () {
  window.AppSummaries = {
    // ───── load ─────
    async loadSummaries() {
      this.summariesLoading = true;
      try {
        const url = this.activeSummaryFolder
          ? `/api/summaries?folder_id=${encodeURIComponent(this.activeSummaryFolder)}`
          : '/api/summaries';
        const data = await this.api(url);
        this.summaries = Array.isArray(data?.summaries) ? data.summaries : [];
      } catch (e) {
        // Endpoint may not exist yet — keep silent on the empty list.
        this.summaries = [];
      } finally {
        this.summariesLoading = false;
      }
    },
    async loadSummaryFolders() {
      try {
        const data = await this.api('/api/summary-folders');
        this.summaryFolders = Array.isArray(data?.folders) ? data.folders : [];
      } catch (e) {
        this.summaryFolders = [];
      }
    },

    // ───── draft helpers ─────
    onSummaryTemplateChange(id) {
      const tpl = (this.summaryTemplates || []).find((t) => t.id === id);
      this.summaryDraft.template = id;
      if (tpl && id !== 'custom') {
        this.summaryDraft.system_prompt = tpl.prompt;
      }
    },
    resetSummaryDraft() {
      this.summaryDraft = {
        chat_id: this.selectedChatId || '',
        range_kind: 'last_n',
        last_n: 200,
        from_date: '',
        to_date: '',
        template: 'general',
        system_prompt: (this.summaryTemplates.find((t) => t.id === 'general') || {}).prompt || '',
        title: '',
        folder_id: this.activeSummaryFolder,
      };
    },

    // ───── generate ─────
    async generateSummary() {
      const d = this.summaryDraft;
      if (!d.chat_id) { this.toast('Bitte Chat auswählen', 'error'); return; }
      if (!d.system_prompt || !d.system_prompt.trim()) {
        this.toast('System-Prompt darf nicht leer sein', 'error');
        return;
      }
      this.summaryGenerating = true;
      try {
        const body = {
          chat_id: d.chat_id,
          range_kind: d.range_kind,
          template: d.template,
          system_prompt: d.system_prompt,
          title: (d.title || '').trim() || null,
          folder_id: d.folder_id || null,
        };
        if (d.range_kind === 'last_n') {
          body.last_n = Math.max(1, Math.min(2000, Number(d.last_n) || 200));
        } else {
          // Convert local datetime-local strings to epoch ms
          const fromTs = d.from_date ? Date.parse(d.from_date) : null;
          const toTs = d.to_date ? Date.parse(d.to_date) : null;
          if (!fromTs || !toTs) { this.toast('Zeitraum unvollständig', 'error'); return; }
          body.from_ts = fromTs;
          body.to_ts = toTs;
        }
        const data = await this.api('/api/summaries', {
          method: 'POST',
          body: JSON.stringify(body),
        });
        if (data && data.summary) {
          this.summaries.unshift(data.summary);
          this.summaryViewing = data.summary;
          this.toast('Zusammenfassung erstellt');
        } else {
          this.toast('Keine Antwort vom Server', 'error');
        }
      } catch (e) {
        this.toast('Generieren fehlgeschlagen: ' + e.message, 'error');
      } finally {
        this.summaryGenerating = false;
      }
    },

    // ───── view / download / delete ─────
    async viewSummary(s) {
      if (!s || !s.id) return;
      // If we already have the content cached, show immediately.
      if (s.content_md) { this.summaryViewing = s; return; }
      try {
        const data = await this.api(`/api/summaries/${encodeURIComponent(s.id)}`);
        this.summaryViewing = data?.summary || s;
      } catch (e) {
        this.toast('Laden fehlgeschlagen: ' + e.message, 'error');
      }
    },
    downloadSummaryMd(s) {
      if (!s || !s.id) return;
      // Server endpoint returns raw markdown. Trigger browser download.
      const url = `/api/summaries/${encodeURIComponent(s.id)}/download.md`
        + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
      window.open(url, '_blank');
    },
    downloadSummaryPdf(s) {
      if (!s || !s.id) return;
      const url = `/api/summaries/${encodeURIComponent(s.id)}/download.pdf`
        + (this.token ? `?token=${encodeURIComponent(this.token)}` : '');
      window.open(url, '_blank');
    },
    async deleteSummary(s) {
      if (!s || !s.id) return;
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Zusammenfassung "${s.title || s.id}" wirklich löschen?`)) return;
      try {
        await this.api(`/api/summaries/${encodeURIComponent(s.id)}`, { method: 'DELETE' });
        this.summaries = this.summaries.filter((x) => x.id !== s.id);
        if (this.summaryViewing && this.summaryViewing.id === s.id) this.summaryViewing = null;
        this.toast('Gelöscht');
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },

    // ───── folders ─────
    async createSummaryFolder(name) {
      const n = String(name || '').trim();
      if (!n) return;
      try {
        const data = await this.api('/api/summary-folders', {
          method: 'POST',
          body: JSON.stringify({ name: n }),
        });
        if (data?.folder) this.summaryFolders.push(data.folder);
        this.toast('Ordner erstellt');
      } catch (e) {
        this.toast('Erstellen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    async deleteSummaryFolder(folder) {
      if (!folder || !folder.id) return;
      // eslint-disable-next-line no-alert
      if (!window.confirm(`Ordner "${folder.name}" wirklich löschen?`)) return;
      try {
        await this.api(`/api/summary-folders/${encodeURIComponent(folder.id)}`, { method: 'DELETE' });
        this.summaryFolders = this.summaryFolders.filter((f) => f.id !== folder.id);
        if (this.activeSummaryFolder === folder.id) this.activeSummaryFolder = null;
        this.toast('Ordner gelöscht');
      } catch (e) {
        this.toast('Löschen fehlgeschlagen: ' + e.message, 'error');
      }
    },
    selectSummaryFolder(id) {
      this.activeSummaryFolder = id;
      this.loadSummaries();
    },
  };
})();
