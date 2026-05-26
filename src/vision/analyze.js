// Image analysis ("vision") via the configured AI CLI.
//
// Pipeline:
//   <image file>  --claude CLI with Read tool--> stdout German description
//
// Contract:
//   analyzeImage(absImagePath, opts?) -> Promise<string>   // 1–2 short German sentences
//   visionAvailable()                  -> boolean
//
// The function spawns the AI CLI with arguments that force the Read tool to be
// available (so Claude can open the file) and a permission-mode that doesn't
// stop and ask the user. We deliberately ignore AI_CLI_ARGS here — those args
// often disable tools, which would defeat the purpose.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { config } from '../config.js';

export function visionAvailable() {
  return !!config.ai.cmd && config.ai.cmd !== 'mock';
}

export async function analyzeImage(absImagePath, { timeoutMs = 60000 } = {}) {
  if (!visionAvailable()) throw new Error('AI CLI not configured for vision');
  if (!fs.existsSync(absImagePath)) throw new Error(`image missing: ${absImagePath}`);

  // We need Read tool so claude can open the file; bypass permission prompts.
  // Don't honor AI_CLI_ARGS here — vision wants Read tool, regular ARGS may disable tools.
  const args = [
    '-p',
    '--tools', 'Read',
    '--permission-mode', 'bypassPermissions',
    '--no-session-persistence',
    '--model', 'sonnet',
  ];
  const prompt = `Lies das Bild unter folgendem Pfad ein und beschreibe es in 1-2 deutschen Sätzen.
Fokus: Was ist zu sehen, Stimmung, ggf. Text/Schrift, ggf. Personen (nur grob).
Antworte NUR mit der Beschreibung, ohne Vorrede.

Bildpfad: ${absImagePath}`;

  return await new Promise((resolve, reject) => {
    const child = spawn(config.ai.cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      reject(new Error('vision timeout'));
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += c.toString('utf8'); });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      if (code === 0) resolve(String(stdout).trim());
      else reject(new Error(`vision exited ${code}: ${stderr.slice(0, 200)}`));
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (err) {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err);
    }
  });
}
