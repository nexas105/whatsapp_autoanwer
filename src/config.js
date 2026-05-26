import 'dotenv/config';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function abs(p) {
  return path.isAbsolute(p) ? p : path.join(root, p);
}

function parseJson(value, fallback) {
  if (!value) return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export const config = {
  root,
  port: Number(process.env.PORT ?? 3000),
  host: process.env.HOST ?? '127.0.0.1',
  dbPath: abs(process.env.DB_PATH ?? './data/app.db'),
  wwebjsAuthDir: abs(process.env.WWEBJS_AUTH_DIR ?? './data/.wwebjs_auth'),
  ai: {
    cmd: process.env.AI_CLI_CMD ?? 'mock',
    args: parseJson(process.env.AI_CLI_ARGS, []),
    promptMode: process.env.AI_CLI_PROMPT_MODE ?? 'stdin', // 'stdin' | 'arg'
    timeoutMs: Number(process.env.AI_CLI_TIMEOUT_MS ?? 60000),
  },
  defaults: {
    autoReply: process.env.DEFAULT_AUTO_REPLY === 'true',
    replyDelayMs: Number(process.env.DEFAULT_REPLY_DELAY_MS ?? 15000),
    contextMessages: Number(process.env.DEFAULT_CONTEXT_MESSAGES ?? 20),
  },
  voice: {
    whisperBin: process.env.WHISPER_BIN ?? 'whisper-cli',
    ffmpegBin: process.env.FFMPEG_BIN ?? 'ffmpeg',
    modelPath: process.env.WHISPER_MODEL ?? './data/models/ggml-large-v3-turbo.bin',
    lang: process.env.WHISPER_LANG ?? 'auto',
    threads: Number(process.env.WHISPER_THREADS ?? 8),
    autoTranscribe: (process.env.TRANSCRIBE_AUTO ?? 'true') !== 'false',
    timeoutMs: Number(process.env.TRANSCRIBE_TIMEOUT_MS ?? 180000),
  },
  voiceReply: {
    voice: process.env.TTS_VOICE ?? 'Anna',
    bitrate: process.env.TTS_BITRATE ?? '32k',
  },
  vision: {
    autoAnalyze: (process.env.VISION_AUTO ?? 'true') !== 'false',
    timeoutMs: Number(process.env.VISION_TIMEOUT_MS ?? 90000),
  },
  auth: {
    token: process.env.DASHBOARD_TOKEN || '',
  },
};
