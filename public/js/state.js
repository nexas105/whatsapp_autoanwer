/* Initial state for the Alpine component.
 * Kept separate from method modules for readability.
 * Returned object is merged into the app() composition root.
 */
(function () {
  window.AppState = function appState() {
    return {
      // ───── connection / global state ─────
      waStatus: null,
      qrString: null,
      disconnectReason: '',
      engine: { pending: 0, chats: 0 },
      wsConnected: false,
      ws: null,
      wsRetry: 0,
      wsTimer: null,

      // ───── dashboard stats ─────
      stats: null,
      statsTimer: null,
      charts: null,
      chartsTimer: null,
      _chartsRefreshTimer: null,

      // ───── personas ─────
      personas: [],
      personaModalOpen: false,
      editingPersona: null,
      personaSaving: false,

      // ───── chats ─────
      chats: [],
      chatFilter: 'Alle',
      selectedChatId: null,
      messages: [],
      settings: {
        auto_reply: 0,
        reply_delay_ms: 0,
        context_messages: 0,
        persona_prompt: '',
        persona_id: null,
        style_mimic_strength: 0,
        suggestion_mode: 0,
        suggestion_count: 1,
        autocomplete_mode: 'off',
        autocomplete_delay_ms: 8000,
        voice_reply_mode: 'off',
        mentioned_only: 0,
        safety_mode: 'off',
        never_to_ai: 0,
        cooldown_after_manual_ms: 1800000,
        last_manual_reply_at: null,
      },
      analysis: null,
      analysisLoading: false,
      savingSettings: false,
      composeText: '',
      sending: false,
      uploading: false,
      historyLoading: false,

      // ───── media ─────
      activeTab: 'messages',
      mediaList: [],
      mediaByMsg: {},
      mediaFilter: 'Alle',
      lightbox: null,
      dragHover: false,

      // ───── pending reply ─────
      pendingReply: null,
      pendingCountdown: 0,
      pendingTimer: null,

      // ───── triggers ─────
      triggers: [],
      editingTrigger: null,
      triggerSaving: false,

      // ───── chat memory ─────
      memory: [],
      newMemoryNote: '',

      // ───── suggestions ─────
      pendingSuggestion: null,
      editingVariantIdx: null,
      editingVariantText: '',
      suggestionSending: false,

      // ───── approval inbox (Bundle I) ─────
      inboxOpen: false,
      inbox: [],
      inboxBusy: {},
      profile: null,

      // ───── schedules ─────
      schedules: [],
      schedulesOpen: false,
      editingSchedule: null,
      scheduleSaving: false,

      // ───── stories (status@broadcast) ─────
      storiesOpen: false,
      stories: [],
      storiesLoading: false,

      // ───── AI compose ─────
      composeOpen: false,
      composeInstruction: '',
      composeCount: 1,
      composeGenerating: false,
      composeDrafts: [],
      composeEditingIdx: null,
      composeDraftEditText: '',
      quickReplying: false,

      // ───── search ─────
      searchModalOpen: false,
      searchMode: 'keyword',
      searchQuery: '',
      searchResults: [],
      searchAnswer: '',
      searchLoading: false,
      _searchDebounce: null,

      // ───── health (Bundle K) ─────
      healthOpen: false,
      health: null,
      healthTimer: null,

      // ───── persona playground (Bundle J) ─────
      playgroundOpen: false,
      pgPersonaId: null,
      pgStyle: 50,
      pgPrompt: '',
      pgMock: [{ from_me: 0, body: 'hey wie gehts?' }],
      pgCount: 1,
      pgVariants: [],
      pgGenerating: false,

      // ───── log + ui ─────
      logs: [],
      logOpen: false,
      toasts: [],
      _toastId: 0,

      // ───── view routing (UI restructure) ─────
      currentView: 'chats',
      settingsSubTab: 'profile',
      inboxFilter: 'all',
      openSettingsSection: 'reply',

      // ───── AI sessions list ─────
      sessions: [],
      sessionsLoading: false,

      // ───── Summaries / Roadmap planning (Bundle SUMMARY) ─────
      summaries: [],
      summariesLoading: false,
      summaryFolders: [],
      activeSummaryFolder: null,
      summaryDraft: {
        chat_id: '',
        range_kind: 'last_n',   // 'last_n' | 'time_range'
        last_n: 200,
        from_date: '',
        to_date: '',
        template: 'general',    // 'general' | 'project_plan' | 'software_project' | 'meeting_notes' | 'custom'
        system_prompt: '',
        title: '',
        folder_id: null,
      },
      summaryGenerating: false,
      summaryViewing: null,     // currently displayed summary object
      // Built-in templates (system prompts the AI uses to shape the markdown output).
      summaryTemplates: [
        { id: 'general',
          label: 'Allgemeine Zusammenfassung',
          prompt: 'Erstelle eine prägnante Markdown-Zusammenfassung dieser Chat-Konversation. Strukturiere sie mit Überschriften: ## Kernthemen, ## Wichtige Aussagen, ## Offene Punkte, ## Nächste Schritte. Sei sachlich und vollständig, aber knapp.' },
        { id: 'project_plan',
          label: 'Projektplan',
          prompt: 'Lies die Konversation und erstelle einen Markdown-Projektplan. Verwende: # Projektname (aus Kontext ableiten), ## Ziele (bulleted), ## Meilensteine (Tabelle mit Datum/Ziel/Status), ## Aufgaben (bulleted mit Verantwortlichem), ## Risiken & Annahmen, ## Offene Fragen. Wo Daten/Termine genannt werden, übernimm sie. Bei fehlenden Informationen, markiere mit *TBD*.' },
        { id: 'software_project',
          label: 'Software-Projekt',
          prompt: 'Erstelle aus der Konversation eine Markdown-Spezifikation für ein Software-Projekt. Sektionen: # Projektname, ## Problem & Motivation, ## Zielgruppe, ## Funktionsumfang (MVP / Erweitert), ## Tech-Stack (falls genannt), ## Architektur-Skizze (Mermaid wenn sinnvoll), ## Roadmap (Phasen), ## Risiken, ## Offene technische Fragen. Sei präzise und entwicklungsfertig.' },
        { id: 'meeting_notes',
          label: 'Meeting-Notiz',
          prompt: 'Erstelle eine Markdown-Meeting-Notiz aus dem Chat-Verlauf. Format: # Meeting-Notiz – {Thema}, ## Teilnehmer, ## Agenda, ## Diskussion (chronologisch, kompakt), ## Beschlüsse, ## Action Items (Tabelle: Wer / Was / Bis wann), ## Nächstes Treffen.' },
        { id: 'custom',
          label: 'Eigener Prompt',
          prompt: '' },
      ],

      // ───── responsive: chat right-sidebar drawer state ─────
      chatSidebarOpen: false,

      // ───── global config ─────
      globalConfig: {
        quiet_hours_enabled: true,
        quiet_hours_start: '22:00',
        quiet_hours_end: '08:00',
        quiet_hours_allow_suggestions: true,
        pii_redaction_enabled: true,
      },
      globalSettingsOpen: false,

      // ───── user profile + personal schedule ─────
      profileOpen: false,
      profileTab: 'profile',
      userProfile: {
        name: '', bio_short: '', bio_full: '',
        mood_today: '', energy_today: '', current_focus: '',
      },
      profileSaving: false,
      schedule: [],
      scheduleStatus: { active: [], upcoming: [] },
      editingScheduleEntry: null,
      scheduleEntrySaving: false,

      // ───── auth (Bundle L) ─────
      token: '',

      // ───── bio suggestions + structured contact bio ─────
      bioSuggestionsOpen: false,
      bioSuggestions: [],
      contactBio: null,
      contactBioEditing: false,
      contactBioDraft: { relationship: '', how_met: '', tone_pref: '', topics: '', no_gos: '' },
      contactBioSaving: false,

      // ───── AI session (goal-driven autonomous dialog) ─────
      sessionDialogOpen: false,
      sessionDraft: { initial_prompt: '', max_turns: 20, stop_keywords: '' },
      activeSession: null,
      sessionStarting: false,

      // simple debounce holders
      _styleSaveTimer: null,
    };
  };
})();
