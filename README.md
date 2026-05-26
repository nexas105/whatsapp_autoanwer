# WhatsApp AutoAnswer

Lokales Dashboard, das deine WhatsApp-Web-Session mit einem CLI-gesteuerten Sprachmodell verheiratet — Auto-Antworten, Vorschläge, Stimmen-Mimicry, Voice-Replies, Vision-Beschreibungen, Kalender-bewusste Persona, geplante Nachrichten und ein bisschen Roadmap-Planung obendrauf. Läuft komplett lokal: SQLite + `node:sqlite`, kein externer API-Key (die KI sitzt in deinem `claude`-CLI).

> Privates Projekt für nexas. Keine Lizenz, kein Support. Wenn du es klonst, klonst du auf eigene Verantwortung.

---

## Was es kann

### Kern
- WhatsApp-Web-Anbindung via `whatsapp-web.js` (Puppeteer, headless).
- Persistenz in SQLite (Datei `data/app.db`, WAL-Mode, `node:sqlite` builtin — keine native Compile-Stufe).
- KI über ein lokales CLI (`claude` empfohlen, alternativ `codex` oder eingebauter `mock`-Modus). Kein API-Key in der App, kein API-Traffic an Dritte außer dem, was dein CLI macht.

### Antwort-Pipeline
- **Auto-Reply** pro Chat mit konfigurierbarem Delay; manueller Self-Reply cancelt den Job automatisch (Bus-Event `user_self_reply`).
- **Suggestion-Mode**: 1–3 Varianten in die Approval-Inbox statt direkt senden.
- **Trigger pro Chat**: Pattern (substring/word/exact/regex) → fixer Reply / Custom-Prompt-Override / Skip.
- **Auto-Complete (Smart-Compose)**: schlägt eine Vervollständigung vor, wenn du eine Nachricht halb getippt liegen lässt. Heuristik aus `src/engine/autocomplete.js`, Trigger nach `autocomplete_delay_ms`.
- **Loop-Detect**: Jaccard-Similarity > 0.55 gegen letzte Auto-Replies → AI-Retry mit Variations-Hinweis (siehe `src/engine/reply-queue.js`).
- **Quality-Check**: AI rated jede Reply (`too_long`, `too_formal`, `hallucination`, `needless_question`, Score 0–100). Score < 40 → Retry. Score < 25 nach Retry → Reply wird verworfen (`src/cli/quality.js`).

### Personalisierung
- 6 Built-in Personas (`casual_short`, `friendly_warm`, `professional`, `flirty_playful`, `dry_sarcastic`, `avoidant_brief`) plus beliebig viele Custom-Personas.
- **Style-Mimic-Slider** 0–100 %: nimmt 0/5/10/15/20 deiner echten Nachrichten als Stilvorlage in den Prompt (`styleConfigFor()` in `src/cli/analysis.js`).
- **Memory-Notes** pro Chat (manuell oder vom Analyse-Run extrahiert, pinnbar).
- **Strukturiertes Contact-Profil**: Beziehung, wie kennengelernt, Tonalität, Themen, No-Gos (`chat_settings.contact_bio_json`).
- **Self-Profile**: bio_short + bio_full, Tages-Mood/Energy/Focus, persönlicher Kalender (cron-/once-/recurring-Einträge). Stale-Mood wird automatisch zurückgesetzt.

### Multimodal
- **Voice-Transkription** für eingehende Audios via `whisper.cpp` + `ffmpeg`, automatisch wenn `TRANSCRIBE_AUTO=true`. Transkript liegt auf der Nachricht und ist für FTS und AI-Kontext sichtbar.
- **Voice-Replies** (TTS): macOS `say` → `aiff` → `ffmpeg libopus` → `.ogg`. Modi pro Chat: `off | always | mirror` (mirror = nur wenn der andere gerade ein Voice geschickt hat).
- **Bild-Analyse (Vision)**: Claude CLI mit `--tools Read --permission-mode bypassPermissions` beschreibt jedes eingehende Bild in 1–2 deutschen Sätzen. Beschreibung landet im `transcript`-Feld (gleiche Spalte wie Voice).

### Workflow
- **Approval-Inbox** für Suggestions (senden / regenerieren / verwerfen / editieren).
- **AI-Compose** mit Custom-Prompt: „Sag dem Chatpartner, dass ich morgen später komme" → fertig formulierte Nachricht im Chat-Ton.
- **Quick-Reply**: einklappbarer Schnellantwort-Generator pro Chat.
- **AI-Session**: goal-driven Dialog. Du gibst ein Ziel vor (`initial_prompt`), max_turns, Stop-Keywords; die AI führt den Chat autonom bis Ziel erreicht (`DONE`) oder beendet wird.
- **Bio-Vorschläge**: periodischer Extractor (`src/bio/extract.js`) scant Chats, schlägt Fakten für User-Bio bzw. Chat-Memory vor — Accept/Dismiss-Queue.

### Such & Kontext
- **FTS5** über `body` + `transcript` (unicode61, diacritics-strip).
- **AI-Themen-Suche**: natürlichsprachige Query → KI generiert FTS-Pattern → Treffer.
- **Cross-Chat Kontext-Injection**: bei jedem Auto-Reply werden bis zu 3 verwandte Nachrichten aus *anderen* Chats in den Prompt gemischt (`relatedContextBlock` in `src/cli/analysis.js`), wenn `context_search_enabled` an ist.

### Safety
- **Risk-Detection** (`src/engine/safety.js`): Patterns für `money`, `date`, `conflict`, `sensitive`, plus `unknown_media`.
- **Safety-Mode pro Chat**: `off | risk_aware | always_suggest | never_send`. Downgrade zu Suggestion oder Block je nach Treffer.
- **Quiet-Hours**: globale Sperrzeit (HH:MM–HH:MM, kann Mitternacht überschreiten), optional als Suggestion erlauben.
- **Cooldown** nach manueller Antwort: konfigurierbar (`cooldown_after_manual_ms`, default 30 min). Neue Auto-Replies in dem Fenster werden zu Suggestions downgraded.
- **`never_to_ai`** Opt-out pro Chat — Chat geht nie zur KI, weder für Reply noch für Analyse, Memory-Extract oder Bio-Extract.
- **PII-Redaction**: `<TEL>`, `<EMAIL>`, `<IBAN>`, `<ADDR>` (deutsche Straßennamen) werden vor jedem AI-Call ersetzt, wenn global aktiviert.

### Automation
- **Scheduled Messages**: `cron` (5-Felder), `once` (ISO-Timestamp), `after_silence` (Sekunden Schweigen). Mode `ai` (Prompt) oder `fixed` (Text). Pro Chat oder global mit `target_filter`.
- **Periodischer Bio-Extractor** läuft im Hintergrund (`startBioExtractor()`).
- **Cron-Rescan** alle 60s — manuell editierte Schedules werden aufgegriffen.

### Plan & Doku
- **Summary-Feature**: aus Chat-Verlauf eine Markdown-Zusammenfassung generieren, mit Templates (Allgemein / Projektplan / Software-Projekt / Meeting-Notiz / Custom). Download als `.md` oder `.pdf`. Organisation in Folders (Roadmap-Sammlung).

### UI
- Multi-View Dashboard (Chats / Dashboard / Inbox / Sessions / Plan / Settings).
- Live über WebSocket — neue Nachrichten, Queue-Status, Suggestions, Schedule-Pings, Analysen kommen ohne Reload an.
- Stories-View (`status@broadcast`) — read-only, keine Auto-Replies dort.
- Charts (Aktivität pro Tag, Verteilung, Quality-Scores …).
- Bearer-Token-Auth (optional, über `DASHBOARD_TOKEN`).
- macOS-Desktop-Notifications für Disconnects, neue Suggestions, Auth-Fehler.
- Mobile-responsive (Tailwind via CDN, Alpine.js).

---

## Architektur

| Modul | Aufgabe |
| --- | --- |
| `src/server.js` | Bootstrap: DB, WA-Client, Engine, Autocomplete, Scheduler, REST, WS, Notif-Bridge |
| `src/whatsapp/client.js` | `whatsapp-web.js` Client, Media-Download, Vision/Transcript-Trigger |
| `src/engine/reply-queue.js` | Auto-Reply-Pipeline: Trigger / Session / Suggestion / Auto-Send |
| `src/engine/autocomplete*.js` | Smart-Compose für angefangene eigene Nachrichten |
| `src/engine/safety.js` | Risk-Patterns, Quiet-Hours, Decision-Routing |
| `src/cli/wrapper.js` | Spawnt das AI-CLI (stdin oder arg), Timeout, Logging |
| `src/cli/analysis.js` | Prompt-Komposition (Persona + Self-Bio + Memory + Style + Related + Verlauf), Chat-Analyse, Memory-Extract |
| `src/cli/quality.js` | AI-driven Reply-Rating |
| `src/voice/transcribe.js` | whisper.cpp Wrapper |
| `src/voice/tts.js` | macOS `say` + libopus → `.ogg` |
| `src/vision/analyze.js` | Claude CLI mit `Read`-Tool → Bildbeschreibung |
| `src/scheduler/index.js` | Eigener cron-Parser + `once`/`after_silence` |
| `src/bio/extract.js` | Periodischer Fakten-Extractor → bio_suggestions |
| `src/privacy/redact.js` | PII-Maskierung |
| `src/notifs.js` | macOS `osascript display notification` |
| `src/api/rest.js` | Express-Router, alle `/api/*` Endpoints |
| `src/api/ws.js` | WebSocket-Bridge für Bus-Events |
| `src/db/{index,schema,repo}.js` | `node:sqlite` Setup, Schema, Migrations, Repo-Funktionen |
| `public/` | Tailwind + Alpine.js Single-Page-Dashboard |

---

## Setup (Kurzversion)

Details für eine frische macOS-Maschine in [INSTALL.md](./INSTALL.md).
Für Agenten-Setups gibt es zusätzlich einen Copy/Paste-Prompt in [LLM_INSTALL.md](./LLM_INSTALL.md).

```bash
npm install
cp .env.example .env
# claude CLI, whisper.cpp + Modell, ffmpeg installieren — siehe INSTALL.md
npm start
# → http://127.0.0.1:3000
```

Beim ersten Start erscheint in der Konsole ein QR-Code (und im Dashboard ebenfalls). In WhatsApp:
`Einstellungen → Verknüpfte Geräte → Gerät verknüpfen` → scannen.

---

## Erste Schritte

1. QR-Code scannen — die Session bleibt unter `data/.wwebjs_auth/` gespeichert.
2. Im Dashboard einen Chat öffnen.
3. Rechts oben in der Chat-Sidebar:
   - **Persona** wählen (z.B. „Locker & kurz").
   - **Style-Mimic** auf 50 % stellen (Empfehlung).
   - **Auto-Reply** anschalten — Delay default 15 s, gibt dir Zeit, manuell zu intervenieren.
4. Zum Testen erstmal mit **Suggestion-Mode** statt Auto-Reply spielen — die KI füllt deine Inbox mit Vorschlägen, nichts geht raus, bis du auf „Senden" klickst.
5. Eigene Persona, Trigger, Memory-Notes nach Bedarf hinzufügen.

---

## Konfiguration

Alle Einstellungen in `.env`. Defaults sind die in `src/config.js`.

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Webserver-Port |
| `HOST` | `127.0.0.1` | Bind-Adresse (auf `0.0.0.0` setzen für LAN-Zugriff — dann unbedingt `DASHBOARD_TOKEN` setzen) |
| `DB_PATH` | `./data/app.db` | SQLite-Datei |
| `WWEBJS_AUTH_DIR` | `./data/.wwebjs_auth` | wo `whatsapp-web.js` die Session ablegt |
| `AI_CLI_CMD` | `mock` | Befehl, der die KI startet (`claude`, `codex`, `mock`) |
| `AI_CLI_ARGS` | `[]` | JSON-Array mit CLI-Argumenten |
| `AI_CLI_PROMPT_MODE` | `stdin` | `stdin` oder `arg` — wie der Prompt ans CLI geliefert wird |
| `AI_CLI_TIMEOUT_MS` | `60000` | Timeout pro AI-Call |
| `DEFAULT_AUTO_REPLY` | `false` | Auto-Reply für neue Chats vorbelegt |
| `DEFAULT_REPLY_DELAY_MS` | `15000` | Standard-Delay vor Auto-Reply |
| `DEFAULT_CONTEXT_MESSAGES` | `20` | Anzahl Nachrichten im Reply-Prompt |
| `WHISPER_BIN` | `whisper-cli` | Binary für Transkription |
| `FFMPEG_BIN` | `ffmpeg` | Binary für Audio-Konvertierung |
| `WHISPER_MODEL` | `./data/models/ggml-large-v3-turbo.bin` | Pfad zum ggml-Modell |
| `WHISPER_LANG` | `auto` | `de`, `en`, `auto`, … |
| `WHISPER_THREADS` | `8` | CPU-Threads |
| `TRANSCRIBE_AUTO` | `true` | eingehende Voice-Notes automatisch transkribieren |
| `TRANSCRIBE_TIMEOUT_MS` | `180000` | Timeout für Transkription |
| `VISION_AUTO` | `true` | eingehende Bilder automatisch analysieren |
| `VISION_TIMEOUT_MS` | `90000` | Timeout für Bild-Analyse |
| `TTS_VOICE` | `Anna` | macOS-Stimmenname für Voice-Replies |
| `TTS_BITRATE` | `32k` | Opus-Bitrate |
| `DASHBOARD_TOKEN` | leer | Bearer-Token für `/api/*` und `/ws`. Leer = keine Auth (nur localhost!) |

---

## Daten & Privacy

Alles bleibt lokal im Projektordner:

- `data/app.db` (+ `-wal`, `-shm`) — Chats, Messages, Settings, Personas, Suggestions, Schedules, Memory, Quality-Scores, FTS-Index.
- `data/media/<hash-prefix>/...` — heruntergeladene Bilder, Audios, Videos, Dokumente.
- `data/media/tts/...` — generierte Voice-Replies (`.ogg`).
- `data/models/` — whisper-ggml-Modelle.
- `data/.wwebjs_auth/` — WhatsApp-Session (NICHT löschen, sonst neuer QR).
- `.wwebjs_cache/` — Puppeteer/wweb Cache, wird automatisch regeneriert.

Schutzschienen im Code:

- **`never_to_ai`** pro Chat — Chat geht nie durch die KI (Reply-Pipeline, Analyse, Memory-Extract, Bio-Extract).
- **PII-Redaction** vor jedem AI-Call (Telefonnummern, E-Mails, IBANs, deutsche Adressen).
- **Bearer-Token** (`DASHBOARD_TOKEN`) gilt für REST + WS gemeinsam. UI fragt einmal nach und speichert in `localStorage`.
- Alle Logs nur lokal — keine Telemetrie, kein Phone-Home.

Wenn die Daten weg sollen: Server stoppen, `data/` löschen. Fertig.

## GitHub-Hinweise

Dieses Repository ist so vorbereitet, dass private Runtime-Daten nicht committed werden:

- `.env` und lokale `.env.*` bleiben privat; nur `.env.example` gehört ins Repo.
- `data/` ist ignoriert, inklusive Datenbank, Medien, Whisper-Modelle und WhatsApp-Session. Nur `data/.gitkeep` darf als Platzhalter ins Repo.
- `.wwebjs_cache/`, Logs, `node_modules/`, Build-Ausgaben und lokale Editor-Dateien sind ignoriert.
- Vor jedem Push kurz prüfen:

```bash
git status --short
git status --ignored --short
```

---

## API-Referenz (REST)

Alle Endpoints unter `/api/*`. Bei gesetztem `DASHBOARD_TOKEN`: `Authorization: Bearer <token>`.

### Status & Health
- `GET  /state` — WhatsApp-Verbindungszustand + Engine-Queue-Größe
- `GET  /health` — System-Health (Tools, Modelle, DB-Stand)
- `GET  /stats` — Aggregat-Zahlen (Chats, Messages, Auto-Replies, …)
- `GET  /charts` — Zeitreihen für die Dashboard-Charts

### Chats
- `GET    /chats` — Chatliste (200 neueste)
- `GET    /chats/:id` — Einzelchat-Metadaten
- `GET    /chats/:id/messages?limit=` — Nachrichten
- `GET    /chats/:id/profile` — kombiniertes Profil (Settings + Memory + Bio + Quality)
- `GET    /chats/:id/settings` / `PUT /chats/:id/settings`
- `POST   /chats/:id/send` — manuell senden
- `POST   /chats/:id/compose` — AI-Compose mit Custom-Prompt
- `POST   /chats/:id/quick-reply` — kurzer Reply-Vorschlag
- `POST   /sync` / `POST /chats/:id/sync` — Verlauf nachladen

### Analyse & Memory
- `GET    /chats/:id/analysis` / `POST /chats/:id/analysis` — Chat-Analyse (Summary + Tipps + Memory-Extract)
- `GET    /chats/:id/memory` / `POST /chats/:id/memory`
- `DELETE /memory/:mid` / `PUT /memory/:mid/pinned`

### Contact-Bio (strukturiertes Profil)
- `GET    /chats/:id/bio` / `PUT /chats/:id/bio` / `DELETE /chats/:id/bio`
- `GET    /bio-suggestions`
- `POST   /bio-suggestions/:id/accept` / `POST /bio-suggestions/:id/dismiss`

### Personas
- `GET    /personas` / `GET /personas/:id`
- `POST   /personas` / `PUT /personas/:id` / `DELETE /personas/:id` (Built-ins sind read-only)

### Trigger
- `GET    /chats/:id/triggers`
- `POST   /chats/:id/triggers` / `PUT /chats/:id/triggers/:tid` / `DELETE /chats/:id/triggers/:tid`

### Suggestions / Inbox
- `GET    /inbox` — alle pending Suggestions
- `GET    /chats/:id/suggestions`
- `POST   /suggestions/:sid/send` — Variante senden (optional editiert)
- `POST   /suggestions/:sid/regenerate` — neue Varianten
- `POST   /suggestions/:sid/discard`

### AI-Sessions
- `GET    /sessions` — aktive Sessions
- `GET    /chats/:id/session` / `POST /chats/:id/session` — Session starten
- `POST   /sessions/:sid/stop` / `pause` / `resume`

### Scheduled Messages
- `GET    /schedules` / `GET /schedules/:id`
- `POST   /schedules` / `PUT /schedules/:id` / `DELETE /schedules/:id`
- `POST   /schedules/:id/run` — sofort feuern (manueller Test)

### User-Profile + Personal Schedule
- `GET    /profile` / `PUT /profile`
- `GET    /schedule` / `GET /schedule/status` (jetzt aktive + nächste Einträge)
- `POST   /schedule` / `PUT /schedule/:id` / `DELETE /schedule/:id`

### Such & Playground
- `GET    /search?q=` — FTS5-Volltext
- `POST   /search/ai` — natürlichsprachige Such-Anfrage
- `POST   /playground/generate` — Persona-/Prompt-Spielwiese

### Media & Voice
- `GET    /chats/:id/media` / `GET /media/:id` / `GET /media/:id/file` (binary)
- `POST   /chats/:id/upload-send` — Datei oder Image hochladen + senden
- `POST   /media/:id/transcribe` — manuell ein Audio nachtranskribieren

### Stories
- `GET    /stories` — read-only Status-Broadcasts

### Summaries / Roadmap
- `GET    /summaries?folder_id=` / `GET /summaries/:id`
- `GET    /summaries/templates` — Built-in Prompt-Templates
- `POST   /summaries` — generieren (chat_id + range + template + system_prompt)
- `PUT    /summaries/:id` / `DELETE /summaries/:id`
- `GET    /summaries/:id/download.md` / `download.pdf` — Export
- `GET    /summary-folders` / `POST /summary-folders` / `DELETE /summary-folders/:id`

### Global-Config & Quality
- `GET    /config` / `PUT /config` — Quiet-Hours, PII-Redaction, etc.
- `GET    /quality` — Quality-Scores (gefiltert nach Chat / Zeitraum)

---

## WebSocket-Events

Verbindung auf `ws://<host>:<port>/ws` (Token entweder als Query `?token=...` oder `Authorization: Bearer ...`). Server pusht JSON-Objekte mit `type`-Feld:

`hello`, `pong`, `qr`, `ready`, `disconnected`, `message`, `queue`, `reply_sent`, `settings`, `analysis`, `log`, `media`, `personas`, `sync`, `transcript`, `trigger`, `suggestion`, `suggestion_resolved`, `ack`, `schedule`, `autocomplete`, `memory_added`, `memory_removed`, `safety`, `quality`, `profile`, `schedule_entry`, `contact_bio`, `bio_suggestion`, `ai_session`.

Client → Server: nur `{"type":"ping"}` (Server antwortet mit `pong`).

---

## Datenmodell

Vollständig in [`src/db/schema.sql`](./src/db/schema.sql). Tabellen-Überblick:

| Tabelle | Inhalt |
| --- | --- |
| `chats` | Chat-Metadaten, last_message_at, unread_count |
| `messages` | Nachrichten + `transcript` (Whisper/Vision), `has_media`, `ack`, `mentioned` |
| `media` | Heruntergeladene Anhänge (Pfade relativ zum Projekt-Root) |
| `chat_settings` | Per-Chat: auto_reply, delay, persona_id, style_mimic, suggestion_mode, voice_reply_mode, autocomplete_mode, safety_mode, never_to_ai, mentioned_only, cooldown, contact_bio_json |
| `personas` | Built-in + Custom |
| `triggers` | Pattern → reply / prompt / skip pro Chat |
| `reply_queue` | Pending/sent/cancelled/failed Auto-Reply-Jobs |
| `suggestions` | Pending Approval-Inbox, JSON-Array Varianten |
| `analyses` | Historie der Chat-Analysen (Summary + Tipps) |
| `chat_memory` | Persistent Memory-Notes pro Chat (manuell + auto) |
| `user_profile` | Single-Row (id=1): bio_short, bio_full, mood_today, energy_today, current_focus |
| `user_schedule` | Persönlicher Kalender (once + recurring) |
| `bio_suggestions` | Pending vom Extractor — accept/dismiss |
| `quality_scores` | AI-Rating pro versendetem Reply |
| `scheduled_messages` | Cron-/once-/after_silence-Nachrichten |
| `ai_sessions` | Goal-Driven Dialog-Runs |
| `messages_fts` | FTS5 Virtual Table (body + transcript) |
| `kv` | Global config + Misc-Key-Value |

---

## Troubleshooting

**Puppeteer launch failed / no Chromium**
`npx puppeteer browsers install chrome`. `whatsapp-web.js` zieht Chromium normalerweise mit `npm install`, der Re-Install-Befehl hilft, wenn der Browser-Bundle fehlt oder kaputt ist.

**`claude not found` / `spawn claude ENOENT`**
`AI_CLI_CMD` muss im `PATH` der Shell sein, mit der `npm start` startet. `which claude` testen. Falls Claude in einer anderen Shell installiert ist, vollen Pfad in `.env` setzen (`AI_CLI_CMD=/Users/du/.local/bin/claude`).

**`whisper model missing at …`**
`data/models/ggml-large-v3-turbo.bin` herunterladen — siehe INSTALL.md. Oder `WHISPER_MODEL` auf ein kleineres Modell ändern. Ohne Modell läuft die App, nur Voice-Transkription ist aus.

**Port 3000 belegt**
`lsof -i:3000` schauen wer drauf liegt. Alter Server: `pkill -f "node src/server.js"`. Oder `PORT=3001` in `.env`.

**Dashboard zeigt 401 / nichts**
`DASHBOARD_TOKEN` ist gesetzt, der Browser kennt ihn aber nicht. Im Dashboard auf den Token-Button klicken und Token eingeben (wird in `localStorage` gespeichert) — oder Token temporär entfernen und neu starten.

**KI antwortet auf einmal mit englischen Floskeln statt deutsch**
Persona-Prompt prüft das Modell — bei `claude` ist `--model sonnet` empfohlen. Beim Wechsel auf ein anderes Modell (haiku, opus) kann sich der Tonfall deutlich ändern.

**`Cannot find module node:sqlite`**
Node ist zu alt. Mindestens Node 22. Vorher gab es kein `node:sqlite` builtin. Wir nutzen es bewusst statt `better-sqlite3`, um den nativen Build-Step zu vermeiden.

**CORB-Block für `qrcode.min.js` in der Konsole**
Harmless. Tritt manchmal beim CDN-Load auf, hat keinen Einfluss auf den Login.

**Voice-Reply kommt als Text**
Synthese ist fehlgeschlagen, wird transparent gelogged und fällt auf Text zurück. Details siehe `src/engine/reply-queue.js` (`sendReplyMaybeVoice`) und Server-Log.

---

## Lizenz

Keine. Privates Projekt für nexas — wenn du das hier liest und es nicht dein eigener Klon ist, behandle es bitte entsprechend.
