// WhatsApp client module — real implementation using whatsapp-web.js.
//
// Exports:
//   startWhatsApp() -> { sendMessage, getState }
//
// See server.js, engine/reply-queue.js and api/ws.js for consumers of the
// bus events emitted here ('qr', 'ready', 'message', 'user_self_reply',
// 'disconnected', 'auth_failure', 'media').

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import pkg from 'whatsapp-web.js';
import qrcodeTerminal from 'qrcode-terminal';

import { config } from '../config.js';
import { bus, log } from '../events.js';
import { upsertChat, insertMessage, insertMedia, setMessageTranscript, setMessageAck, getSettings, updateSettings } from '../db/repo.js';
import { transcribeFile, transcribeAvailable } from '../voice/transcribe.js';
import { analyzeImage, visionAvailable } from '../vision/analyze.js';

const { Client, LocalAuth, MessageMedia } = pkg;

// ---------- media helpers (module-internal) ----------
function mimeToExt(mime) {
  if (!mime) return 'bin';
  const m = String(mime).toLowerCase().split(';')[0].trim();
  switch (m) {
    case 'image/jpeg':
    case 'image/jpg':
      return 'jpg';
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/bmp':
      return 'bmp';
    case 'image/heic':
      return 'heic';
    case 'audio/ogg':
    case 'audio/ogg; codecs=opus':
      return 'ogg';
    case 'audio/mpeg':
    case 'audio/mp3':
      return 'mp3';
    case 'audio/mp4':
    case 'audio/m4a':
    case 'audio/x-m4a':
      return 'm4a';
    case 'audio/aac':
      return 'aac';
    case 'audio/wav':
    case 'audio/x-wav':
      return 'wav';
    case 'video/mp4':
      return 'mp4';
    case 'video/3gpp':
      return '3gp';
    case 'video/quicktime':
      return 'mov';
    case 'video/webm':
      return 'webm';
    case 'application/pdf':
      return 'pdf';
    case 'application/zip':
      return 'zip';
    case 'application/msword':
      return 'doc';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'application/vnd.ms-excel':
      return 'xls';
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      return 'xlsx';
    case 'application/vnd.ms-powerpoint':
      return 'ppt';
    case 'application/vnd.openxmlformats-officedocument.presentationml.presentation':
      return 'pptx';
    case 'text/plain':
      return 'txt';
    case 'text/csv':
      return 'csv';
    default:
      // Last-ditch fallback: try the part after the slash if it looks sane.
      if (m.includes('/')) {
        const sub = m.split('/')[1].replace(/[^a-z0-9]/g, '');
        if (sub && sub.length <= 6) return sub;
      }
      return 'bin';
  }
}

function mimeToKind(mime, msgType) {
  const m = String(mime ?? '').toLowerCase().split(';')[0].trim();
  if (msgType === 'sticker' || (m === 'image/webp' && msgType === 'sticker')) {
    return 'sticker';
  }
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  if (m === 'application/pdf') return 'document';
  if (m.startsWith('application/')) return 'document';
  return 'file';
}

function storagePathFor(chatId, messageId, ext) {
  const hash = crypto.createHash('sha1').update(chatId).digest('hex').slice(0, 12);
  const safeMsg = String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join('data', 'media', hash, `${safeMsg}.${ext}`);
}

export async function startWhatsApp() {
  // Module-scope state visible via getState().
  const state = { status: 'qr' };

  // Track ids of messages we sent ourselves through sendMessage(), so the
  // matching 'message_create' event isn't mistaken for a user-on-phone reply.
  const selfSentIds = new Set();
  // Soft cap so the Set can't grow unbounded over very long sessions.
  function rememberSelfSent(id) {
    selfSentIds.add(id);
    if (selfSentIds.size > 500) {
      const iter = selfSentIds.values();
      for (let i = 0; i < 100; i++) {
        const v = iter.next();
        if (v.done) break;
        selfSentIds.delete(v.value);
      }
    }
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: config.wwebjsAuthDir }),
    puppeteer: {
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox'],
    },
  });

  // Download media for a message, persist to disk, insert media row and
  // emit a 'media' bus event. Errors are swallowed (logged) — must never
  // break the surrounding message-handling flow.
  async function handleIncomingMedia(msg, chatId, timestamp) {
    try {
      const media = await msg.downloadMedia();
      if (!media) {
        log('warn', 'media download returned null', {
          chatId,
          messageId: msg.id?._serialized,
          type: msg.type,
        });
        return;
      }

      const ext = mimeToExt(media.mimetype);
      const kind = mimeToKind(media.mimetype, msg.type);
      const messageId = msg.id._serialized;
      const relativePath = storagePathFor(chatId, messageId, ext);
      const absolutePath = path.isAbsolute(relativePath)
        ? relativePath
        : path.join(config.root, relativePath);

      const buffer = Buffer.from(media.data, 'base64');
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, buffer);
      const sizeBytes = buffer.length;

      const mediaRowId = insertMedia({
        chatId,
        messageId,
        mimeType: media.mimetype,
        fileName: media.filename,
        filePath: relativePath,
        sizeBytes,
        kind,
        timestamp,
      });

      bus.emit('media', {
        chatId,
        media: {
          id: mediaRowId,
          chat_id: chatId,
          message_id: messageId,
          mime_type: media.mimetype,
          file_name: media.filename,
          kind,
          size_bytes: sizeBytes,
          timestamp,
        },
      });

      // Auto-transcribe voice notes / audio so the AI has the text in context.
      if (kind === 'audio' && config.voice.autoTranscribe && transcribeAvailable()) {
        // Fire-and-forget; persistence + WS event happen when whisper returns.
        transcribeFile(absolutePath)
          .then((transcript) => {
            if (transcript) {
              setMessageTranscript(messageId, transcript);
              bus.emit('transcript', { chatId, messageId, mediaId: mediaRowId, transcript });
              bus.emit('message', {
                chatId,
                message: { id: messageId, chat_id: chatId, transcript, has_media: 1 },
              });
            }
          })
          .catch((err) => log('error', 'transcribe failed', { messageId, error: String(err) }));
      }

      // Auto-analyze images so the AI has a short description in context.
      if (kind === 'image' && config.vision?.autoAnalyze && visionAvailable()) {
        analyzeImage(absolutePath, { timeoutMs: config.vision.timeoutMs })
          .then((desc) => {
            if (desc) {
              setMessageTranscript(messageId, desc);
              bus.emit('transcript', { chatId, messageId, mediaId: mediaRowId, transcript: desc, kind: 'image' });
              bus.emit('message', {
                chatId,
                message: { id: messageId, chat_id: chatId, transcript: desc, has_media: 1 },
              });
            }
          })
          .catch((err) => log('error', 'image analyze failed', { messageId, error: String(err) }));
      }
    } catch (err) {
      log('error', 'failed to download/persist media', {
        chatId,
        messageId: msg.id?._serialized,
        error: String(err),
      });
    }
  }

  client.on('qr', (qr) => {
    state.status = 'qr';
    state.qr = qr;
    log('info', 'whatsapp qr received — scan with your phone');
    try {
      qrcodeTerminal.generate(qr, { small: true });
    } catch (err) {
      log('warn', 'failed to render qr to terminal', { error: String(err) });
    }
    bus.emit('qr', { qr });
  });

  client.on('authenticated', () => {
    state.status = 'authenticating';
    log('info', 'whatsapp authenticated');
  });

  client.on('auth_failure', (msg) => {
    state.status = 'disconnected';
    log('error', 'whatsapp auth failure', { msg });
    bus.emit('auth_failure', { msg: String(msg) });
  });

  client.on('ready', () => {
    state.status = 'ready';
    delete state.qr;
    log('info', 'whatsapp client ready', { wid: client.info?.wid?._serialized });
    bus.emit('ready', { info: client.info });
    // Kick off chat-list sync. Fire-and-forget; errors are logged.
    syncChats().catch((err) => log('error', 'initial chat sync failed', { error: String(err) }));
  });

  // ---------- reconnect with exponential backoff ----------
  // On disconnect we schedule client.initialize() again with backoff
  // 2s, 4s, 8s, 16s, 32s, capped at 60s. Counter resets on the next 'ready'.
  let reconnectAttempt = 0;
  let reconnectTimer = null;

  client.on('disconnected', (reason) => {
    state.status = 'disconnected';
    bus.emit('disconnected', { reason: String(reason) });
    log('warn', 'whatsapp disconnected', { reason });
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    const delay = Math.min(60_000, 2_000 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    log('info', 'reconnect scheduled', { in: delay, attempt: reconnectAttempt });
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      log('info', 'reconnect attempt', { attempt: reconnectAttempt });
      client.initialize().catch((err) => {
        log('error', 'reconnect initialize failed', { error: String(err) });
      });
    }, delay);
  });

  // Separate listener so we don't disturb the existing 'ready' handler above.
  // Multiple listeners on the same EventEmitter event are fine — Node calls
  // them in registration order.
  client.on('ready', () => {
    reconnectAttempt = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  });

  // Incoming messages from others.
  client.on('message', async (msg) => {
    try {
      const chat = await msg.getChat();
      const chatId = chat.id._serialized;
      const timestamp = (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
      const type = msg.type ?? 'chat';
      const body = msg.body ?? null;
      const id = msg.id._serialized;
      const hasMedia = msg.hasMedia === true;

      // Compute @-mention flag (used by group "mentioned_only" gate).
      let mentioned = 0;
      try {
        const myWid = client.info?.wid?._serialized;
        const mIds = Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [];
        if (myWid && mIds.includes(myWid)) mentioned = 1;
        else if (body && /@\d{6,}/.test(body)) mentioned = 1; // weak fallback
      } catch { /* ignore */ }

      upsertChat({ id: chatId, name: chat.name, isGroup: chat.isGroup });
      insertMessage({
        id,
        chatId,
        fromMe: false,
        author: msg.author ?? null,
        body,
        type,
        timestamp,
        isAuto: false,
        hasMedia,
        mentioned,
        rawJson: null,
      });

      bus.emit('message', {
        chatId,
        message: {
          id,
          chat_id: chatId,
          from_me: 0,
          body,
          type,
          timestamp,
          has_media: hasMedia ? 1 : 0,
          mentioned,
        },
      });

      if (hasMedia) {
        await handleIncomingMedia(msg, chatId, timestamp);
      }
    } catch (err) {
      log('error', 'failed to handle incoming message', { error: String(err) });
    }
  });

  // message_create fires for every outgoing message — including ones we sent
  // ourselves via client.sendMessage(). We only care here about messages the
  // user typed on their phone, so we filter against selfSentIds.
  client.on('message_create', async (msg) => {
    try {
      if (!msg.fromMe) return;
      const id = msg.id._serialized;
      if (selfSentIds.has(id)) {
        // Our own sendMessage() already persisted this; consume the marker.
        selfSentIds.delete(id);
        return;
      }
      const chat = await msg.getChat();
      const chatId = chat.id._serialized;
      const timestamp = (msg.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
      const type = msg.type ?? 'chat';
      const body = msg.body ?? null;
      const hasMedia = msg.hasMedia === true;

      // Compute @-mention flag (mirrors the inbound branch above).
      let mentioned = 0;
      try {
        const myWid = client.info?.wid?._serialized;
        const mIds = Array.isArray(msg.mentionedIds) ? msg.mentionedIds : [];
        if (myWid && mIds.includes(myWid)) mentioned = 1;
        else if (body && /@\d{6,}/.test(body)) mentioned = 1;
      } catch { /* ignore */ }

      upsertChat({ id: chatId, name: chat.name, isGroup: chat.isGroup });
      insertMessage({
        id,
        chatId,
        fromMe: true,
        author: msg.author ?? null,
        body,
        type,
        timestamp,
        isAuto: false,
        hasMedia,
        mentioned,
        rawJson: null,
      });

      bus.emit('message', {
        chatId,
        message: {
          id,
          chat_id: chatId,
          from_me: 1,
          body,
          type,
          timestamp,
          is_auto: 0,
          has_media: hasMedia ? 1 : 0,
          mentioned,
        },
      });
      bus.emit('user_self_reply', { chatId });

      if (hasMedia) {
        await handleIncomingMedia(msg, chatId, timestamp);
      }
    } catch (err) {
      log('error', 'failed to handle message_create', { error: String(err) });
    }
  });

  // WhatsApp ack updates (0=pending, 1=server, 2=delivered, 3=read, 4=played).
  client.on('message_ack', async (msg, ack) => {
    try {
      const id = msg.id?._serialized;
      if (!id) return;
      try { setMessageAck(id, Number(ack)); } catch { /* ignore */ }
      let chatId = null;
      try {
        const chat = await msg.getChat();
        chatId = chat.id._serialized;
      } catch { /* ignore */ }
      bus.emit('ack', { messageId: id, chatId, ack: Number(ack) });
    } catch (err) {
      log('warn', 'ack handler failed', { error: String(err) });
    }
  });

  // Kick off initialization but don't crash the server if puppeteer/launch fails.
  // The UI will reflect the disconnected state and the user can restart.
  client.initialize().catch((err) => {
    state.status = 'disconnected';
    log('error', 'whatsapp client failed to initialize', { error: String(err) });
    bus.emit('disconnected', { reason: `initialize failed: ${err?.message ?? err}` });
  });

  async function sendMessage(chatId, body, opts = {}) {
    const { isAuto = false, mediaPath = null, mediaCaption = null } = opts;

    // Path 1: media attachment.
    if (mediaPath) {
      const caption = mediaCaption ?? body ?? null;
      const mediaObj = MessageMedia.fromFilePath(mediaPath);
      const sent = await client.sendMessage(chatId, mediaObj, {
        caption: caption ?? undefined,
      });
      const id = sent.id._serialized;
      rememberSelfSent(id);
      const timestamp = Date.now();

      // mediaPath is assumed to already live under data/media/... (uploaded
      // there by the REST endpoint). Store path relative to project root if
      // possible, else keep as-is.
      let storedPath = mediaPath;
      try {
        const abs = path.resolve(mediaPath);
        const rel = path.relative(config.root, abs);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) {
          storedPath = rel;
        }
      } catch {
        // keep mediaPath
      }

      // Probe size/mime best-effort.
      let sizeBytes = 0;
      try {
        const st = fs.statSync(path.isAbsolute(mediaPath)
          ? mediaPath
          : path.join(config.root, mediaPath));
        sizeBytes = st.size;
      } catch {
        // size stays 0
      }
      const mimeType = mediaObj.mimetype ?? null;
      const fileName = mediaObj.filename ?? path.basename(mediaPath);
      const kind = mimeToKind(mimeType, sent.type);

      insertMessage({
        id,
        chatId,
        fromMe: true,
        author: null,
        body: caption,
        type: sent.type ?? 'chat',
        timestamp,
        isAuto,
        hasMedia: true,
        rawJson: null,
      });

      const mediaRowId = insertMedia({
        chatId,
        messageId: id,
        mimeType,
        fileName,
        filePath: storedPath,
        sizeBytes,
        kind,
        timestamp,
      });

      bus.emit('message', {
        chatId,
        message: {
          id,
          chat_id: chatId,
          from_me: 1,
          body: caption,
          type: sent.type ?? 'chat',
          timestamp,
          is_auto: isAuto ? 1 : 0,
          has_media: 1,
        },
      });

      bus.emit('media', {
        chatId,
        media: {
          id: mediaRowId,
          chat_id: chatId,
          message_id: id,
          mime_type: mimeType,
          file_name: fileName,
          kind,
          size_bytes: sizeBytes,
          timestamp,
        },
      });

      return { id, timestamp };
    }

    // Path 2: text-only (original behaviour).
    const sent = await client.sendMessage(chatId, body);
    const id = sent.id._serialized;
    rememberSelfSent(id);
    const timestamp = Date.now();

    insertMessage({
      id,
      chatId,
      fromMe: true,
      author: null,
      body,
      type: 'chat',
      timestamp,
      isAuto,
      rawJson: null,
    });

    bus.emit('message', {
      chatId,
      message: {
        id,
        chat_id: chatId,
        from_me: 1,
        body,
        type: 'chat',
        timestamp,
        is_auto: isAuto ? 1 : 0,
      },
    });

    return { id, timestamp };
  }

  function getState() {
    return { ...state };
  }

  // Pulls all chats from WhatsApp and upserts them into the DB, including the
  // last message per chat so the chat list isn't empty after first login.
  // Existing rows are merged; we never delete chats here.
  async function syncChats() {
    if (state.status !== 'ready') {
      throw new Error('whatsapp not ready');
    }
    log('info', 'syncing chats from whatsapp');
    bus.emit('sync', { phase: 'start' });
    const chats = await client.getChats();
    let synced = 0;
    let errors = 0;
    for (const c of chats) {
      try {
        const chatId = c.id._serialized;
        upsertChat({ id: chatId, name: c.name ?? c.formattedTitle ?? null, isGroup: !!c.isGroup });
        // Safer defaults for groups on first encounter: suggest, don't auto-send,
        // and only act when explicitly mentioned. We detect "first encounter" by
        // the absence of an existing chat_settings row (updated_at === null).
        if (c.isGroup) {
          try {
            const cur = getSettings(chatId);
            if (cur.updated_at == null) {
              updateSettings(chatId, { suggestion_mode: true, mentioned_only: true });
            }
          } catch (err) {
            log('warn', 'group default-settings apply failed', { chatId, error: String(err) });
          }
        }
        // Try to bring over the last message so the chat list shows a preview.
        let last = c.lastMessage;
        if (!last) {
          try {
            const msgs = await c.fetchMessages({ limit: 1 });
            last = msgs && msgs.length ? msgs[msgs.length - 1] : null;
          } catch { /* ignore */ }
        }
        if (last && last.id && last.id._serialized) {
          const ts = (last.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
          insertMessage({
            id: last.id._serialized,
            chatId,
            fromMe: !!last.fromMe,
            author: last.author ?? null,
            body: last.body ?? null,
            type: last.type ?? 'chat',
            timestamp: ts,
            isAuto: false,
            hasMedia: last.hasMedia === true,
            rawJson: null,
          });
        }
        synced++;
        if (synced % 25 === 0) {
          bus.emit('sync', { phase: 'progress', synced, total: chats.length });
        }
      } catch (err) {
        errors++;
        log('warn', 'chat sync failed', { id: c?.id?._serialized, error: String(err) });
      }
    }
    log('info', 'chat sync complete', { synced, errors, total: chats.length });
    bus.emit('sync', { phase: 'done', synced, errors, total: chats.length });
    return { synced, errors, total: chats.length };
  }

  // Pull the last `limit` messages of a specific chat into the DB. Existing
  // rows are kept (ON CONFLICT DO NOTHING in repo). Used when the user opens a
  // chat that doesn't have history yet, or to backfill on demand.
  async function syncChatHistory(chatId, limit = 50) {
    if (state.status !== 'ready') throw new Error('whatsapp not ready');
    const chat = await client.getChatById(chatId);
    if (!chat) throw new Error('chat not found on whatsapp');
    upsertChat({ id: chatId, name: chat.name ?? null, isGroup: !!chat.isGroup });
    const msgs = await chat.fetchMessages({ limit });
    let n = 0;
    for (const m of msgs) {
      try {
        const ts = (m.timestamp ?? Math.floor(Date.now() / 1000)) * 1000;
        insertMessage({
          id: m.id._serialized,
          chatId,
          fromMe: !!m.fromMe,
          author: m.author ?? null,
          body: m.body ?? null,
          type: m.type ?? 'chat',
          timestamp: ts,
          isAuto: false,
          hasMedia: m.hasMedia === true,
          rawJson: null,
        });
        n++;
      } catch (err) {
        log('warn', 'failed to persist history message', { id: m?.id?._serialized, error: String(err) });
      }
    }
    bus.emit('sync', { phase: 'history_done', chatId, count: n });
    return { count: n };
  }

  // Fire the "is typing…" presence indicator in `chatId` for `durationMs`,
  // then clear it. Errors are logged-and-swallowed — never break a send flow.
  async function sendTyping(chatId, durationMs = 1500) {
    try {
      const chat = await client.getChatById(chatId);
      await chat.sendStateTyping();
      await new Promise((r) => setTimeout(r, durationMs));
      try { await chat.clearState(); } catch { /* ignore */ }
    } catch (err) {
      log('warn', 'sendTyping failed', { chatId, error: String(err) });
    }
  }

  return { sendMessage, getState, syncChats, syncChatHistory, sendTyping };
}
