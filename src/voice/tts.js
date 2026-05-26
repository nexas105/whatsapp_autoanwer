// Local text-to-speech via macOS `say` + ffmpeg → opus/ogg WhatsApp voice notes.
//
// Pipeline:
//   "<text>" --say-> tmp.aiff --ffmpeg(libopus)-> <out.ogg>
//
// Exports:
//   synthesizeOpus(text, outPath) -> Promise<{ path, sizeBytes }>
//   ttsAvailable()                -> boolean
//   setVoice(name)                -> void

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

import { config } from '../config.js';
import { log } from '../events.js';

const DEFAULT_TIMEOUT_MS = 60000;

let currentVoice = config?.voiceReply?.voice ?? 'Anna';

export function setVoice(name) {
  if (name && typeof name === 'string' && name.trim()) {
    currentVoice = name.trim();
  }
}

// We trust macOS `say` and ffmpeg exist on this box (per environment notes).
export function ttsAvailable() {
  return true;
}

function tmpAiffPath() {
  const name = `wa-tts-${process.pid}-${crypto.randomBytes(6).toString('hex')}.aiff`;
  return path.join(os.tmpdir(), name);
}

function runSpawn(cmd, args, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      if (settled) return;
      settled = true;
      reject(new Error(`${cmd} timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.resume();
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
        resolve({ stderr });
      } else {
        reject(new Error(`${cmd} exited ${code}: ${stderr.slice(0, 500)}`));
      }
    });
  });
}

// Probe if `say` knows about a given voice name. Falls back gracefully.
async function pickVoice(preferred) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('say', ['-v', '?'], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve(preferred);
      return;
    }
    let stdout = '';
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      resolve(preferred);
    }, 5000);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.resume();
    child.on('error', () => {
      clearTimeout(timer);
      resolve(preferred);
    });
    child.on('close', () => {
      clearTimeout(timer);
      const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
      // Each line: "<Name>            <lang>    # sample sentence"
      const names = lines.map((l) => l.split(/\s+/)[0]);
      if (names.includes(preferred)) {
        resolve(preferred);
        return;
      }
      // Fallback: first German voice if available, else first voice overall.
      const germanLine = lines.find((l) => /\bde[_-]/i.test(l));
      if (germanLine) {
        resolve(germanLine.split(/\s+/)[0]);
        return;
      }
      resolve(names[0] || preferred);
    });
  });
}

export async function synthesizeOpus(text, outPath) {
  const inputText = String(text ?? '').trim();
  if (!inputText) throw new Error('synthesizeOpus: text required');
  if (!outPath || typeof outPath !== 'string') throw new Error('synthesizeOpus: outPath required');

  const absOut = path.isAbsolute(outPath) ? outPath : path.resolve(config.root, outPath);
  fs.mkdirSync(path.dirname(absOut), { recursive: true });

  const aiff = tmpAiffPath();
  const voice = await pickVoice(currentVoice);
  const bitrate = config?.voiceReply?.bitrate ?? '32k';

  // 1) macOS `say` -> AIFF
  try {
    log('info', 'tts start', { voice, chars: inputText.length });
    await runSpawn('say', ['-v', voice, '-o', aiff, '--', inputText]);
  } catch (err) {
    try { fs.unlinkSync(aiff); } catch { /* ignore */ }
    throw new Error(`say failed: ${err.message}`);
  }

  // 2) ffmpeg -> opus in ogg
  const ffmpegBin = config?.voice?.ffmpegBin ?? 'ffmpeg';
  try {
    await runSpawn(ffmpegBin, [
      '-loglevel', 'error',
      '-y',
      '-i', aiff,
      '-c:a', 'libopus',
      '-b:a', String(bitrate),
      '-ar', '16000',
      '-ac', '1',
      '-application', 'voip',
      absOut,
    ]);
  } catch (err) {
    try { fs.unlinkSync(aiff); } catch { /* ignore */ }
    throw new Error(`ffmpeg failed: ${err.message}`);
  }

  try { fs.unlinkSync(aiff); } catch { /* ignore */ }

  let sizeBytes = 0;
  try { sizeBytes = fs.statSync(absOut).size; } catch { sizeBytes = 0; }

  log('info', 'tts done', { out: path.basename(absOut), bytes: sizeBytes });
  return { path: absOut, sizeBytes };
}
