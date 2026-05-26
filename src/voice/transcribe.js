// Voice-message transcription via whisper.cpp (whisper-cli) + ffmpeg.
//
// Pipeline:
//   <audio file> --ffmpeg--> 16 kHz mono WAV (tmp) --whisper-cli--> stdout text
//
// Config via .env:
//   WHISPER_BIN          path or name of whisper-cli  (default: 'whisper-cli')
//   FFMPEG_BIN           path or name of ffmpeg       (default: 'ffmpeg')
//   WHISPER_MODEL        absolute or project-relative path to ggml model
//   WHISPER_LANG         language code (de, en, auto, …)  (default: 'auto')
//   WHISPER_THREADS      threads                          (default: 8)
//   TRANSCRIBE_AUTO      'true'/'false'                   (default: true)
//   TRANSCRIBE_TIMEOUT_MS                                 (default: 180000)
//
// Exports:
//   transcribeFile(audioPath) -> Promise<string>
//   transcribeAvailable()     -> boolean (true if model exists on disk)

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { config } from '../config.js';
import { log } from '../events.js';

function tmpWavPath() {
  const name = `wa-transcribe-${process.pid}-${crypto.randomBytes(6).toString('hex')}.wav`;
  return path.join(os.tmpdir(), name);
}

function runSpawn(cmd, args, { timeoutMs, captureStdout = false } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    if (captureStdout) {
      child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    } else {
      child.stdout.resume();
    }
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

function resolveModelPath() {
  const raw = config.voice.modelPath;
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(config.root, raw);
}

export function transcribeAvailable() {
  const model = resolveModelPath();
  return !!(model && fs.existsSync(model));
}

export async function transcribeFile(audioPath) {
  const model = resolveModelPath();
  if (!model) throw new Error('WHISPER_MODEL not configured');
  if (!fs.existsSync(model)) throw new Error(`whisper model missing at ${model}`);
  if (!fs.existsSync(audioPath)) throw new Error(`audio file missing at ${audioPath}`);

  const wav = tmpWavPath();
  const timeoutMs = config.voice.timeoutMs;

  // 1) ffmpeg → 16 kHz mono WAV
  try {
    await runSpawn(config.voice.ffmpegBin, [
      '-loglevel', 'error',
      '-y',
      '-i', audioPath,
      '-ar', '16000',
      '-ac', '1',
      '-f', 'wav',
      wav,
    ], { timeoutMs });
  } catch (err) {
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
    throw new Error(`ffmpeg failed: ${err.message}`);
  }

  // 2) whisper-cli → stdout text
  try {
    const args = [
      '-m', model,
      '-f', wav,
      '-l', config.voice.lang,
      '-t', String(config.voice.threads),
      '-nt',           // no timestamps
      '-np',           // no prints (only the result text)
      '--no-fallback', // skip temperature fallback for speed
    ];
    log('info', 'transcribe start', { audio: path.basename(audioPath), lang: config.voice.lang });
    const t0 = Date.now();
    const { stdout } = await runSpawn(config.voice.whisperBin, args, {
      timeoutMs,
      captureStdout: true,
    });
    const text = String(stdout).replace(/\s+/g, ' ').trim();
    log('info', 'transcribe done', {
      audio: path.basename(audioPath),
      tookMs: Date.now() - t0,
      chars: text.length,
    });
    return text;
  } finally {
    try { fs.unlinkSync(wav); } catch { /* ignore */ }
  }
}
