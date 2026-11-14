'use strict';
// Builds a "handoff" prompt: everything a fresh Claude (any account, desktop, CLI or claude.ai)
// needs to continue a session from where it stopped, when a raw resume is not possible.
const { conversation, summarize } = require('./claude');

function clip(s, n) { s = String(s || '').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function buildHandoff(transcriptBuf, meta = {}, { turns = 12, perTurn = 1500 } = {}) {
  const s = summarize(transcriptBuf);
  const conv = conversation(transcriptBuf).filter(t => t.text && !t.text.startsWith('[result]'));
  const tail = conv.slice(-turns);
  const lines = [];
  lines.push(`# Continue this session: ${meta.title || s.title || clip(s.firstUser.split('\n')[0], 80)}`);
  lines.push('');
  lines.push('You are picking up a Claude Code session that was started elsewhere. Continue exactly where it left off. Do not restart the task or re-ask what was already decided.');
  lines.push('');
  lines.push('## Session facts');
  lines.push(`- Working folder: \`${meta.cwd || s.cwd || '(unknown)'}\``);
  if (s.branch) lines.push(`- Git branch: \`${s.branch}\``);
  if (s.model) lines.push(`- Model used: ${s.model}`);
  if (s.lastTs) lines.push(`- Last activity: ${String(s.lastTs).slice(0, 19).replace('T', ' ')}`);
  lines.push(`- Turns so far: ${s.userTurns} from the user, ${s.assistantTurns} from Claude`);
  if (meta.cliId) lines.push(`- Original session id: \`${meta.cliId}\` (resume natively with \`claude --resume ${meta.cliId}\` if the transcript is on this machine)`);
  lines.push('');
  lines.push('## Original request');
  lines.push(clip(s.firstUser, 2500) || '(none recorded)');
  lines.push('');
  if (s.files.length) {
    lines.push('## Files touched');
    for (const f of s.files.slice(0, 60)) lines.push(`- \`${f}\``);
    if (s.files.length > 60) lines.push(`- …and ${s.files.length - 60} more`);
    lines.push('');
  }
  lines.push(`## Last ${tail.length} turns`);
  for (const t of tail) {
    lines.push(`### ${t.role === 'user' ? 'User' : 'Claude'}${t.time ? ' · ' + String(t.time).slice(0, 16).replace('T', ' ') : ''}`);
    lines.push(clip(t.text, perTurn));
    lines.push('');
  }
  lines.push('## Where it stopped');
  lines.push(clip(s.lastAssistant, 2500) || '(Claude had not replied yet)');
  lines.push('');
  lines.push('## Your next step');
  lines.push('Read the facts above, look at the working folder if you have it, state in one line what you will do next, and continue the work.');
  return lines.join('\n');
}

module.exports = { buildHandoff };
