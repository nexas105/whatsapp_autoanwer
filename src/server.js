import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config } from './config.js';
import { getDb } from './db/index.js';
import { bus, log } from './events.js';
import { startWhatsApp } from './whatsapp/client.js';
import { startEngine } from './engine/reply-queue.js';
import { startAutocomplete } from './engine/autocomplete-controller.js';
import { startScheduler } from './scheduler/index.js';
import { buildRestRouter } from './api/rest.js';
import { attachWs } from './api/ws.js';
import { installNotifBridge } from './notifs.js';
import { startBioExtractor } from './bio/extract.js';
import { startCalendarRefresher } from './calendar/scheduler.js';
import * as repo from './db/repo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '../public');

async function main() {
  getDb(); // initialise schema
  log('info', 'db ready', { path: config.dbPath });

  const wa = await startWhatsApp();
  const engine = startEngine({ wa });
  const autocomplete = startAutocomplete({ wa });

  // Bridge bus events to engine without circular imports
  bus.on('message', ({ message }) => {
    if (!message) return;
    // Never engage the auto-reply engine on status@broadcast (Stories).
    if (repo.isStatusChat(message.chat_id)) return;
    if (message.from_me === 0) engine.onIncoming(message);
    if (message.from_me === 1 || message.from_me === true) {
      autocomplete.onOutgoing(message);
    }
  });
  bus.on('user_self_reply', ({ chatId }) => engine.onUserSelfReply(chatId));

  const scheduler = startScheduler({ wa });
  startBioExtractor();
  const calendarRefresher = startCalendarRefresher();

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  // Bearer-token gate for /api/* — only active when DASHBOARD_TOKEN is set.
  app.use('/api', (req, res, next) => {
    if (!config.auth.token) return next(); // disabled
    const h = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(h);
    if (m && m[1] === config.auth.token) return next();
    return res.status(401).json({ error: 'unauthorized' });
  });
  app.use('/api', buildRestRouter({ wa, engine, scheduler, calendarRefresher }));
  app.use(express.static(publicDir));
  app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  const server = http.createServer(app);
  attachWs(server);

  // macOS desktop notifications for WA disconnects, suggestions, auth-failures.
  installNotifBridge();

  server.listen(config.port, config.host, () => {
    log('info', `server listening on http://${config.host}:${config.port}`);
  });
}

main().catch((err) => {
  console.error('fatal', err);
  process.exit(1);
});
