// Generic AI CLI wrapper.
//
// Contract:
//   export async function runAi(prompt: string, opts?: { timeoutMs?: number, system?: string }) -> string
//
// Behavior:
// - Reads config.ai = { cmd, args, promptMode: 'stdin'|'arg', timeoutMs }.
// - If config.ai.cmd === 'mock', return a deterministic mock reply for offline dev.
// - Else: spawn the configured command with config.ai.args.
//     - promptMode='arg':   push prompt as final arg, no stdin.
//     - promptMode='stdin': write prompt to stdin then close it.
//   Capture stdout, capture stderr; on exit code != 0 throw with stderr in message.
//   Enforce timeoutMs (default config.ai.timeoutMs), killing the process on timeout.
//   Return trimmed stdout as the AI reply.
//
// - `system` option: optional system-prompt-style preamble. Combine as
//   `${system}\n\n${prompt}` before sending. The CLI knows nothing about roles; we just
//   inline the system text.

import { spawn } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../events.js';

// Heuristic: classify an error as transient enough to retry. We retry on
// timeouts, non-zero CLI exits, and the typical pipe/socket reset codes.
function isRetryable(err) {
  if (!err) return false;
  const msg = String(err.message || err);
  if (/timeout/i.test(msg)) return true;
  if (/exited \d+/i.test(msg)) return true; // any non-zero exit
  if (/EPIPE/i.test(msg) || /ECONNRESET/i.test(msg)) return true;
  if (err.code === 'EPIPE' || err.code === 'ECONNRESET') return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runAi(prompt, opts = {}) {
  // Total attempts = 1 + maxRetries. Backoff between attempts: 1s, 3s.
  const maxRetries = Number.isInteger(opts.maxRetries) ? opts.maxRetries : 2;
  const backoffs = [1000, 3000];
  let lastErr;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await runAiOnce(prompt, opts);
    } catch (err) {
      lastErr = err;
      if (attempt >= maxRetries || !isRetryable(err)) {
        throw err;
      }
      const delay = backoffs[attempt] ?? backoffs[backoffs.length - 1];
      log('warn', 'ai-cli retry', {
        attempt: attempt + 1,
        of: maxRetries + 1,
        nextDelayMs: delay,
        error: String(err.message || err).slice(0, 200),
      });
      await sleep(delay);
    }
  }
  throw lastErr;
}

async function runAiOnce(prompt, opts = {}) {
  const system = opts.system;
  const finalPrompt = system ? `${system}\n\n${prompt}` : String(prompt);

  // Mock mode: pass through the last line of the prompt (truncated) for debugging.
  if (config.ai.cmd === 'mock') {
    const lastLine = finalPrompt.trim().split('\n').pop().slice(0, 200);
    return `MOCK_REPLY:: ${lastLine}`;
  }

  const cmd = config.ai.cmd;
  const baseArgs = Array.isArray(config.ai.args) ? [...config.ai.args] : [];
  const mode = config.ai.promptMode === 'arg' ? 'arg' : 'stdin';
  const timeoutMs = opts.timeoutMs ?? config.ai.timeoutMs;

  const argv = mode === 'arg' ? [...baseArgs, finalPrompt] : baseArgs;

  log('info', 'ai-cli call', { cmd, mode, len: finalPrompt.length });

  return await new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, argv, {
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      log('error', 'ai-cli spawn failed', { cmd, error: String(err) });
      reject(err);
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      log('error', 'ai-cli error', { cmd, error: String(err) });
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        log('error', 'ai-cli timeout', { cmd, timeoutMs });
        reject(new Error('AI CLI timeout'));
        return;
      }
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        log('error', 'ai-cli non-zero exit', { cmd, code, stderr: stderr.slice(0, 500) });
        reject(new Error(`AI CLI exited ${code}: ${stderr}`));
      }
    });

    if (mode === 'stdin') {
      try {
        child.stdin.write(finalPrompt);
        child.stdin.end();
      } catch (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        log('error', 'ai-cli stdin write failed', { cmd, error: String(err) });
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        reject(err);
      }
    } else {
      // arg mode: close stdin so the child doesn't block waiting for input.
      try { child.stdin.end(); } catch { /* ignore */ }
    }
  });
}
