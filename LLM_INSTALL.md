# LLM Install Prompt

Fertige Prompts, die du einem Coding-Agent (Claude Code, Codex, Cursor, etc.) gibst,
damit er **WhatsApp AutoAnswer** auf einem neuen Mac installiert, prüft und startklar
macht. Funktioniert headless — der Agent liest selbst nach was er braucht.

Für Menschen, die das selbst Schritt-für-Schritt machen: siehe **INSTALL.md**.

---

## Vollständiger Prompt (empfohlen)

```text
Du bist ein Senior Coding-Agent und sollst dieses Projekt lokal installieren und startklar machen.

Projekt: WhatsApp AutoAnswer
Stack: Node.js 22+, whatsapp-web.js (Puppeteer/Chromium), node:sqlite mit FTS5,
       Express + WebSocket, Vanilla HTML + Alpine.js + Tailwind (CDN),
       externes AI-CLI (Claude Code empfohlen) für alle KI-Aufrufe,
       whisper.cpp (Metal-beschleunigt) für Voice-Transkription,
       Claude Vision (--tools Read) für Bild-Analyse,
       macOS `say` + ffmpeg + opus für Voice-Replies,
       Puppeteer headless für PDF-Rendering der Summary-Exports.

Arbeite im bestehenden Projektordner. Lies vor jeder Änderung: README.md, INSTALL.md,
package.json, .env.example, src/config.js und src/server.js. Ändere keine privaten
Daten in .env, außer es ist für die Installation notwendig und du erklärst die Änderung.

Ziele in dieser Reihenfolge:

1. Voraussetzungen prüfen
   - Node.js 22+ (das Projekt nutzt `node:sqlite` DatabaseSync).
   - Homebrew installiert.
   - Ausreichend Plattenplatz: ~3 GB (whisper-Modell + node_modules + Chromium).

2. Repo + .env
   - pwd / ls -la
   - .env aus .env.example anlegen, falls sie fehlt: `cp .env.example .env`
   - .env NICHT überschreiben falls bereits vorhanden.

3. Node-Abhängigkeiten
   - `npm install` (zieht Puppeteer + Chromium ~150 MB, dauert 1-3 Min).
   - Bei Fehler: `npx puppeteer browsers install chrome`.

4. System-Tools via Homebrew
   - `brew install whisper-cpp ffmpeg`
   - Prüfen: `which whisper-cli`, `which ffmpeg`, `ffmpeg -version`.

5. Whisper-Modell (für Voice-Transkription)
   - Pfad aus .env: WHISPER_MODEL (default `./data/models/ggml-large-v3-turbo.bin`).
   - Falls fehlt:
     mkdir -p data/models
     curl -L -o data/models/ggml-large-v3-turbo.bin \
       https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
     # ~1.5 GB, dauert 2-5 Min.
   - Kleinere Alternative falls Platz knapp: `ggml-small.bin` (~500 MB) — dann
     WHISPER_MODEL in .env anpassen.

6. AI-CLI (Claude Code)
   - Prüfen: `which claude && claude --version`.
   - Falls fehlt: Installation laut https://docs.claude.com/ (üblich:
     `npm install -g @anthropic-ai/claude-code` oder vergleichbar — der Befehl
     ändert sich; nutze die aktuelle offizielle Anleitung).
   - Login: `claude /login` (öffnet Browser, einmalig).
   - Testen: `echo "Sage Hallo auf Deutsch." | claude -p --tools "" --no-session-persistence --model sonnet`
     → muss eine kurze deutsche Antwort liefern.
   - Falls Claude nicht eingerichtet werden kann oder soll: AI_CLI_CMD=mock in .env
     setzen — die App läuft dann mit Mock-Antworten (kein echtes KI-Verhalten, aber
     UI/Pipeline ist testbar).

7. TTS (Voice-Replies)
   - macOS `say` ist eingebaut, kein Install.
   - Stimme prüfen: `say -v ? | grep -i de` listet deutsche Stimmen.
     Default `TTS_VOICE=Anna`. Andere: Markus, Petra.

8. Optional: Dashboard-Token
   - Falls die App über LAN/Netzwerk erreichbar sein soll, DASHBOARD_TOKEN in
     .env auf einen langen Zufallswert setzen, z.B.:
       openssl rand -hex 32

9. Erste Smoke-Tests vor Start
   - `node --check src/server.js` → muss sauber sein.
   - `node -e "Promise.all([import('./src/db/index.js'), import('./src/api/rest.js'), import('./src/cli/summaries.js')]).then(a => console.log('ok', a.length))"`

10. Server starten
    - `npm start` (oder `npm run dev` für Auto-Reload).
    - Konsole zeigt QR-Code als ASCII. WhatsApp am Handy: Einstellungen → Verknüpfte
      Geräte → Gerät verknüpfen → QR scannen.
    - Dashboard: http://127.0.0.1:3000 (oder dem konfigurierten Port).
    - Nach erfolgreicher Verbindung läuft der initial chat-sync — Chats erscheinen
      innerhalb von 5-30 Sekunden.

11. Featue-spezifische Funktionschecks (optional, nach Anmeldung)
    - GET /api/health → alle Subsysteme "ok" (wa, ai_cli, whisper, tts, db, scheduler).
    - GET /api/summaries/templates → 5+ Templates inkl. general/project_plan/software_project/meeting_notes/custom.

Regeln:
- Lies bestehende Dateien VOR Änderungen.
- Überschreibe NIEMALS eine bereits existierende .env ohne Rückfrage.
- Lösche NIEMALS data/, data/.wwebjs_auth/, data/.wwebjs_cache/, data/app.db*.
- Keine destruktiven Git-Kommandos (reset --hard, push --force, branch -D).
- Wenn ein Prozess hängt: nutze `pkill -f "node src/server.js"` statt brutaler Methoden.
- Bei Berechtigungsfragen oder fehlenden Tools: gib dem User die exakten Befehle aus,
  führe nichts „blind" mit sudo aus.
- Lange Hintergrundprozesse: starte sie mit `> /tmp/srv.log 2>&1 &` und gib dem User
  die PID + Log-Pfad.

Erfolgskriterien (am Ende prüfen):
- npm install ohne Fehler.
- Node.js >= 22.
- whisper-cli + ffmpeg im PATH.
- AI_CLI_CMD funktioniert (claude antwortet, ODER mock-Mode dokumentiert).
- Dashboard im Browser erreichbar.
- QR-Code erscheint oder bestehende Session connectet.
- /api/health zeigt grün.

Abschluss-Report an den User:
- Was installiert/geprüft wurde (Liste).
- Was noch fehlt oder vom User nachgepflegt werden muss (z.B. Claude-Login).
- URL des Dashboards.
- Nächster Schritt für den User (z.B. QR scannen).
```

---

## Kurzprompt (Express)

Wenn du es schnell willst, ohne den langen Plan:

```text
Installiere das WhatsApp AutoAnswer Projekt im aktuellen Ordner. Lies README.md,
INSTALL.md, package.json, .env.example. Prüfe Node.js 22+. Führe `npm install` aus.
Lege .env nur an falls sie fehlt (`cp .env.example .env`). Prüfe via Homebrew:
ffmpeg + whisper-cpp. Lade ggml-large-v3-turbo.bin nach data/models falls fehlt.
Prüfe `claude --version` und `say -v ? | grep -i de`. Starte `npm start`, gib mir
die Dashboard-URL und sag mir was der User noch tun muss (QR scannen, Claude-Login,
DASHBOARD_TOKEN setzen). Überschreibe keine .env, lösche keine data/-Inhalte.
```

---

## Produktionsnahes Setup (für externen Zugriff)

```text
Richte das WhatsApp AutoAnswer Projekt produktionsnah ein. Standard-Setup wie im
Vollprompt. Zusätzlich:

- DASHBOARD_TOKEN in .env auf langen Zufall (openssl rand -hex 32).
- Auto-Reply per Default deaktiviert lassen (DEFAULT_AUTO_REPLY=false).
- Sensible Chats opt-out: chat_settings.never_to_ai=1 vorschlagen für VIPs.
- Quiet-Hours sinnvoll setzen (z.B. 22:00-08:00 default).
- Empfehle dem User: Reverse Proxy (nginx/Caddy) vor 127.0.0.1:3000 mit zusätzlichem
  HTTP-Basic-Auth ODER lokal-only via `HOST=127.0.0.1` plus SSH-Tunnel.
- Backups: data/app.db (SQLite + WAL), data/media/, data/.wwebjs_auth/ regelmäßig
  sichern (rsync auf externes Volume).
- Process-Manager: `pm2 start npm --name wa -- start` oder via systemd-User-Unit,
  damit der Bot nach Reboot wieder hochfährt.
- Logrotation für /tmp/srv-*.log oder konfigurierten Log-Pfad.

Erstelle am Ende eine kurze Betriebs-Doku in OPS.md mit den genannten Punkten,
plus Backup-Skript, plus „Wie restarte ich den Bot" Anleitung.

Keine privaten Daten löschen oder überschreiben.
```

---

## Was der Agent NICHT machen darf

- WhatsApp-Session (`data/.wwebjs_auth/`) löschen → user muss QR neu scannen.
- DB-Datei (`data/app.db*`) löschen → ALLE Chats, Memory, Sessions, Summaries weg.
- `.env` überschreiben ohne Rückfrage.
- npm packages global ohne User-Erlaubnis (außer den explizit empfohlenen Claude-CLI).
- Force-Push, hard-Reset, --no-verify Commits.
- Lange Background-Prozesse starten ohne dem User PID + Log-Pfad mitzuteilen.
