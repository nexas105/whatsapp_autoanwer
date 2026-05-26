// Markdown -> HTML -> PDF rendering for summary downloads.
//
// We deliberately avoid extra npm deps: a tiny custom MD->HTML converter
// covers our generated documents (headings, lists, bold/italic, code,
// fenced blocks, links). For PDF we launch a fresh puppeteer instance per
// call so we don't share state with the whatsapp-web.js browser session.
//
// Contract:
//   export function mdToHtml(md: string) -> string
//   export async function renderPdf({ title, content_md, meta? }) -> Buffer

import puppeteer from 'puppeteer';

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function inlineMd(s) {
  let out = escapeHtml(s);
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic (single asterisk). Avoid matching the middle of bold spans.
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

export function mdToHtml(md) {
  const lines = String(md == null ? '' : md).split(/\r?\n/);
  const out = [];
  let inCode = false;
  let codeBuf = [];
  let inList = false;
  let listType = null;

  function flushList() {
    if (inList) {
      out.push(`</${listType}>`);
      inList = false;
      listType = null;
    }
  }

  for (const raw of lines) {
    if (raw.startsWith('```')) {
      if (!inCode) {
        flushList();
        inCode = true;
        codeBuf = [];
        continue;
      }
      out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
      inCode = false;
      continue;
    }
    if (inCode) {
      codeBuf.push(raw);
      continue;
    }

    const h = raw.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flushList();
      out.push(`<h${h[1].length}>${inlineMd(h[2])}</h${h[1].length}>`);
      continue;
    }

    const ul = raw.match(/^\s*[-*]\s+(.+)$/);
    if (ul) {
      if (!inList || listType !== 'ul') {
        flushList();
        out.push('<ul>');
        inList = true;
        listType = 'ul';
      }
      out.push('<li>' + inlineMd(ul[1]) + '</li>');
      continue;
    }

    const ol = raw.match(/^\s*\d+\.\s+(.+)$/);
    if (ol) {
      if (!inList || listType !== 'ol') {
        flushList();
        out.push('<ol>');
        inList = true;
        listType = 'ol';
      }
      out.push('<li>' + inlineMd(ol[1]) + '</li>');
      continue;
    }

    if (!raw.trim()) {
      flushList();
      out.push('');
      continue;
    }

    flushList();
    out.push('<p>' + inlineMd(raw) + '</p>');
  }

  flushList();
  if (inCode) {
    // Unterminated fence: still render what we have so output isn't lost.
    out.push('<pre><code>' + escapeHtml(codeBuf.join('\n')) + '</code></pre>');
  }
  return out.join('\n');
}

const CSS = `
  body { font-family: -apple-system, "Helvetica Neue", Arial, sans-serif;
         color:#1f2937; max-width:780px; margin:32px auto; line-height:1.55;
         padding:0 24px; }
  h1 { font-size:24pt; border-bottom:2px solid #10b981; padding-bottom:4px; margin-top:0; }
  h2 { font-size:16pt; margin-top:28px; color:#0f766e; }
  h3 { font-size:13pt; margin-top:22px; color:#374151; }
  h4, h5, h6 { font-size:12pt; margin-top:18px; color:#374151; }
  p, li { font-size:11pt; }
  ul, ol { padding-left:22px; }
  code { background:#f3f4f6; padding:1px 5px; border-radius:3px; font-size:10.5pt; }
  pre { background:#f8fafc; border:1px solid #e5e7eb; padding:10px 12px;
        border-radius:6px; overflow:auto; font-size:10pt; }
  pre code { background:transparent; padding:0; }
  a { color:#0ea5e9; }
  .meta { color:#6b7280; font-size:9pt; margin-bottom:18px; }
`;

export async function renderPdf({ title, content_md, meta }) {
  const body = mdToHtml(content_md);
  const html = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title || 'Summary')}</title>
    <style>${CSS}</style>
    <h1>${escapeHtml(title || 'Summary')}</h1>
    ${meta ? `<div class="meta">${escapeHtml(meta)}</div>` : ''}
    ${body}`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    return await page.pdf({
      format: 'A4',
      margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
      printBackground: true,
    });
  } finally {
    await browser.close().catch(() => { /* ignore */ });
  }
}
