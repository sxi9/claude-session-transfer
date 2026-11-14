'use strict';
const PATTERNS = [
  ['Anthropic API key', /sk-ant-[A-Za-z0-9_\-]{20,}/g],
  ['OpenAI-style key', /\bsk-[A-Za-z0-9]{32,}\b/g],
  ['GitHub token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['AWS access key', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack token', /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/g],
  ['Google API key', /\bAIza[0-9A-Za-z_\-]{35}\b/g],
  ['Bearer token', /Bearer\s+[A-Za-z0-9_\-.=]{24,}/g],
  ['Private key block', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g],
  ['Password assignment', /\b(?:password|passwd|pwd)\s*[:=]\s*['"]?[^\s'"]{6,}/gi],
  ['Telegram bot token', /\b\d{8,10}:[A-Za-z0-9_\-]{35}\b/g],
  ['JWT', /\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/g],
];
function scanSecrets(buf, maxHits = 50) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  const hits = [];
  for (const [kind, rx] of PATTERNS) {
    rx.lastIndex = 0;
    let m;
    while ((m = rx.exec(text))) {
      const s = m[0];
      const sample = s.length > 14 ? s.slice(0, 6) + '…' + s.slice(-4) : s.slice(0, 3) + '…';
      let line = 1; for (let i = 0; i < m.index; i++) if (text.charCodeAt(i) === 10) line++;
      hits.push({ kind, sample, line });
      if (hits.length >= maxHits) return hits;
    }
  }
  return hits;
}
module.exports = { scanSecrets, PATTERNS };
