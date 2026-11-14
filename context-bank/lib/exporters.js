'use strict';
const { conversation } = require('./claude');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = t => String(t || '').slice(0, 19).replace('T', ' ');

function toMarkdown(buf, meta) {
  const lines = [`# ${meta.title || ''}`, '', `- Working folder: \`${meta.cwd || ''}\``,
    `- Last activity: ${meta.lastActivityMs ? new Date(meta.lastActivityMs).toISOString().slice(0, 16).replace('T', ' ') : ''}`,
    `- Session: \`${meta.cliId || ''}\``, '', '---', ''];
  for (const c of conversation(buf)) {
    if (!c.text) continue;
    lines.push(`${c.role === 'user' ? '**You**' : '**Claude**'}  <sub>${fmtTime(c.time)}</sub>`, '', c.text, '', '---', '');
  }
  return lines.join('\n');
}

function toHtml(buf, meta) {
  const rows = conversation(buf).filter(c => c.text).map(c => {
    const cls = c.role === 'user' ? 'u' : 'a';
    return `<div class="m ${cls}"><div class="who">${cls === 'u' ? 'You' : 'Claude'}<span>${esc(fmtTime(c.time))}</span></div><pre>${esc(c.text)}</pre></div>`;
  }).join('');
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(meta.title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#222;background:#fafafa}
h1{font-size:22px}.meta{color:#666;font-size:13px}.m{margin:14px 0;padding:12px 16px;border-radius:10px}
.u{background:#e8f0fe}.a{background:#fff;border:1px solid #e3e3e3}.who{font-weight:600;margin-bottom:6px}
.who span{font-weight:400;color:#888;font-size:12px;margin-left:8px}pre{white-space:pre-wrap;margin:0;font:inherit}
@media(prefers-color-scheme:dark){body{background:#111;color:#ddd}.u{background:#1d2a44}.a{background:#1b1b1b;border-color:#333}}
</style></head><body><h1>${esc(meta.title)}</h1><p class="meta">${esc(meta.cwd)} · ${esc(meta.cliId)}</p>${rows}</body></html>`;
}

module.exports = { toMarkdown, toHtml };
