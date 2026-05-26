# INSTALL — WhatsApp AutoAnswer

Schritt-für-Schritt-Setup für eine frische macOS-Maschine. Wenn du auf Linux bist, passt das meiste — `say` (TTS) fällt weg, der Rest ist analog.

---

## Voraussetzungen

- **macOS 13+** (Apple Silicon empfohlen — whisper.cpp nutzt Metal automatisch und ist um Faktor 5–10 schneller).
- **Homebrew** installiert: `brew --version`. Falls nein: `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`.
- **Node.js 22 oder neuer** (wir nutzen `node:sqlite` — das gibt's erst ab v22):
  ```bash
  node --version   # erwartet v22.x oder höher
  ```
  Falls zu alt: `brew install node` oder mit nvm: `nvm install 22 && nvm use 22`.
- **Festplatte**: ~3 GB Puffer. node_modules ~250 MB, Chromium ~150 MB, whisper-Modell (large-v3-turbo) ~1.5 GB, Daten wachsen mit Chat-Volumen.

---

## 1. Repo-Setup

```bash
git clone <repo-url>           # oder einfach den Ordner kopieren
cd whatsapp_autoanwer
npm install
cp .env.example .env
```

`npm install` zieht u.a. `whatsapp-web.js`, das beim ersten Start ein Chromium herunterlädt (~150 MB). Dauert beim ersten Mal also etwas.

---

## 2. Claude Code CLI installieren (AI-Backend)

Die App ruft kein Anthropic-API direkt auf — sie spawnt das `claude`-CLI als Subprozess. Du brauchst also das CLI lokal eingeloggt.

**Installation** (Standardweg laut Anthropic-Docs zum Zeitpunkt der Einrichtung — wenn sich was ändert, siehe https://docs.claude.com/):

```bash
# Beispiel — die exakte Zeile ändert sich, prüfe die offizielle Anleitung:
npm install -g @anthropic-ai/claude-code
```

**Login** (öffnet Browser):

```bash
claude /login
```

**Funktionstest** — muss eine echte Antwort liefern (nicht nur einen Help-Text):

```bash
claude -p "Sag Hallo auf Deutsch." --model sonnet --no-session-persistence
```

**`.env` konfigurieren** — die Defaults aus `.env.example` sind schon richtig, du musst nichts ändern:

```env
AI_CLI_CMD=claude
AI_CLI_ARGS=["-p","--tools","","--no-session-persistence","--model","sonnet"]
AI_CLI_PROMPT_MODE=stdin
AI_CLI_TIMEOUT_MS=120000
```

Erklärung der Args:

- `-p` — Print-Mode (one-shot, kein TUI).
- `--tools ""` — alle Tools aus. Die Reply-Pipeline braucht keine Tools und ohne sie ist es schneller / billiger.
- `--no-session-persistence` — jeder Call ist isoliert. Wichtig, damit Persona-Wechsel sauber durchgreifen.
- `--model sonnet` — guter Kompromiss aus Qualität und Latenz. Für höhere Qualität `opus`, für niedrigere Kosten `haiku`.

**Vision (Bild-Analyse)** ignoriert `AI_CLI_ARGS` und ruft Claude eigenständig mit `--tools Read --permission-mode bypassPermissions` auf — siehe `src/vision/analyze.js`. Wenn du auf ein anderes CLI wechselst (z.B. `codex`), bleibt Vision an Claude gebunden bzw. müsste angepasst werden.

**Alternative CLIs** sind grundsätzlich austauschbar:

```env
# codex (Aktivierung der Reply-Pipeline ok; Vision funktioniert dann nicht):
AI_CLI_CMD=codex
AI_CLI_ARGS=["exec","--quiet"]
AI_CLI_PROMPT_MODE=arg

# mock — antwortet mit Echo-Stub, gut für lokales Debuggen ohne API-Kosten:
AI_CLI_CMD=mock
AI_CLI_ARGS=[]
AI_CLI_PROMPT_MODE=stdin
```

---

## 3. whisper.cpp + Modell (Voice-Transkription)

```bash
brew install whisper-cpp ffmpeg
```

Modell herunterladen (~1.5 GB, dauert je nach Verbindung 2–5 min):

```bash
mkdir -p data/models
curl -L -o data/models/ggml-large-v3-turbo.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin
```

**Kleinere Alternativen** falls Speicher knapp ist:

```bash
# ~500 MB, schnell, etwas weniger genau auf Deutsch:
curl -L -o data/models/ggml-small.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin
```

Dann in `.env`:

```env
WHISPER_MODEL=./data/models/ggml-small.bin
```

**Metal/M-Series**: wird automatisch genutzt, kein Setup nötig.

**Verifizieren** (erzeugt eine Test-Sprachdatei und transkribiert sie):

```bash
say -v Anna -o /tmp/t.aiff "Das ist ein Test der Transkription."
ffmpeg -y -i /tmp/t.aiff -ar 16000 -ac 1 /tmp/t.wav 2>/dev/null
whisper-cli -m data/models/ggml-large-v3-turbo.bin -f /tmp/t.wav -nt -np
```

Erwartete Ausgabe: ungefähr „Das ist ein Test der Transkription." (Whisper macht gelegentlich Tippfehler, das ist normal.)

Falls du Voice-Transkription gar nicht brauchst:

```env
TRANSCRIBE_AUTO=false
```

---

## 4. TTS (Voice-Replies)

`say` ist Teil von macOS — kein Install nötig.

**Verfügbare Stimmen prüfen:**

```bash
say -v ?
```

Default in `.env`: `TTS_VOICE=Anna`. Andere deutsche Stimmen, die du wahrscheinlich hast:

- **Anna** (de_DE, weiblich) — Standard
- **Markus** (de_DE, männlich)
- **Petra** (de_DE, weiblich, premium)
- **Yannick** (de_FR, akzentuiert — falls bilingual)

Setzen z.B.:

```env
TTS_VOICE=Markus
TTS_BITRATE=32k
```

Voice-Replies sind pro Chat aktivierbar (`voice_reply_mode`: `off | always | mirror`). „mirror" sendet nur dann eine Sprachnachricht zurück, wenn das letzte Eingehende selbst eine war.

---

## 5. Puppeteer / Chromium

Wird durch `npm install` mitgezogen. Beim ersten `npm start` lädt `whatsapp-web.js` das Chromium-Bundle nach (~150 MB).

Wenn der QR-Login nie startet oder du Fehler wie „Failed to launch the browser process" siehst:

```bash
npx puppeteer browsers install chrome
```

---

## 6. (Optional) Dashboard-Token

Wenn du nicht nur auf `127.0.0.1` lauschen willst (z.B. weil du das Dashboard im LAN nutzen möchtest), unbedingt einen Token setzen:

```bash
# zufälligen Token generieren
echo "DASHBOARD_TOKEN=$(openssl rand -hex 32)" >> .env
```

Und `HOST=0.0.0.0` setzen. Ohne Token wäre dein WhatsApp dann offen im LAN — nicht witzig.

Die UI fragt beim ersten Laden nach dem Token und speichert ihn in `localStorage`. WebSocket-Verbindungen werden ebenfalls geprüft (Query-Param `?token=...` oder `Authorization: Bearer ...`).

---

## 7. Erster Start

```bash
npm start
```

oder mit Auto-Restart bei Code-Änderungen:

```bash
npm run dev
```

Erwartete Konsolen-Ausgabe:

1. `db ready` mit Pfad zur SQLite-Datei.
2. WhatsApp-Status `qr` und ein ASCII-QR-Code direkt in der Konsole.
3. `server listening on http://127.0.0.1:3000`.

Browser öffnen: http://127.0.0.1:3000

- QR-Code mit WhatsApp scannen (`Einstellungen → Verknüpfte Geräte → Gerät verknüpfen`).
- Sobald der Status grün ist, lädt die App alle vorhandenen Chats. Initial-Sync braucht je nach Anzahl 5–30 s.
- Die Session ist persistent unter `data/.wwebjs_auth/`. Beim nächsten Start ist kein erneutes Scannen nötig.

---

## Troubleshooting

**`better-sqlite3 fails` / native build errors**
Sollte nicht passieren — wir nutzen `node:sqlite` (builtin ab Node 22). Falls du `better-sqlite3` als transitive Dep siehst und es bricht: `npm install` neu, falls nicht weg → Issue.

**`EADDRINUSE` auf Port 3000**
Alter Server-Prozess läuft noch:
```bash
pkill -f "node src/server.js"
# oder gezielt:
lsof -i:3000
kill <PID>
```

**`CORB blocked qrcode.min.js`**
Harmless. Der QR wird trotzdem gerendert (via WS-Event), und der CDN-Block betrifft nur den initialen Fallback.

**Whisper läuft endlos / extrem langsam**
- Modell zu groß? `ggml-large-v3-turbo.bin` braucht auf älteren Macs einige Sekunden pro Minute Audio. Auf `ggml-small.bin` wechseln.
- Metal nicht aktiv? Bei Apple Silicon wird Metal automatisch genutzt — auf Intel-Macs läuft Whisper auf CPU, das ist deutlich langsamer.

**`claude` antwortet mit 401 / „Please log in"**
```bash
claude /login
```

**Dashboard leer, aber `/api/state` gibt 401**
`DASHBOARD_TOKEN` ist gesetzt, der Browser-Token fehlt. Token-Button im Dashboard klicken (oben rechts), Token aus `.env` reinkopieren. Wird in `localStorage` gespeichert.

**Kein Sound bei macOS-Notifications**
Notifications kommen über `osascript display notification`. Falls nichts erscheint: System-Einstellungen → Mitteilungen → „Skript-Editor" / „Terminal" auf „Erlauben". Sound ist im Code nur bei expliziten Aufrufen aktiviert.

**Suggestion-Inbox zeigt nichts an, aber Auto-Reply würde gerade feuern**
Stimmt der Chat-Mode? `suggestion_mode=1` ODER (`safety_mode=always_suggest`/`risk_aware` mit Trigger). Sonst geht die Nachricht direkt raus, ohne Inbox-Eintrag.

**Schedule feuert nicht**
- `enabled=1`? Cron-Spec valide? (5 Felder)
- Im Log nach `next_run_at` suchen — der Wert sollte in der Zukunft, aber nicht zu fern liegen.
- `POST /api/schedules/:id/run` triggert sofort — gut zum Testen.

---

## Update-Prozedur

```bash
git pull
npm install              # falls package.json sich änderte
npm start
```

Schema-Migrationen laufen automatisch beim Start (`migrate()` in `src/db/index.js`). Die App fügt nur fehlende Spalten/Tables hinzu — bestehende Daten bleiben unangetastet.

Wenn du komplett neu anfangen willst (ALLE Daten weg, inkl. WA-Session):

```bash
# erst Server stoppen!
rm -rf data .wwebjs_cache
```

Beim nächsten Start gibt's einen neuen QR-Code und eine frische DB.
