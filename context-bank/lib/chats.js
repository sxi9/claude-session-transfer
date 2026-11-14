'use strict';
// claude.ai chats (the "Recents" list in Claude Desktop and claude.ai). They live on the server,
// so they come in two ways: the official data export (Settings > Privacy > Export data, a zip
// holding conversations.json) or a live pull from claude.ai with the browser session key.
// Each chat is turned into a Claude Code transcript so it can be banked, searched, read,
// imported into an account and resumed like any other session.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { ZipReader } = require('./zip');

function textOfMessage(m) {
  let t = '';
  if (Array.isArray(m.content) && m.content.length) {
    const parts = [];
    for (const b of m.content) {
      if (!b) continue;
      if (b.type === 'text' && b.text) parts.push(b.text);
      else if (b.type === 'tool_use') parts.push(`[tool: ${b.name || 'tool'}] ${JSON.stringify(b.input || {}).slice(0, 500)}`);
      else if (b.type === 'tool_result') parts.push('[result] ' + (typeof b.content === 'string' ? b.content : JSON.stringify(b.content || '')).slice(0, 500));
    }
    if (parts.length) t = parts.join('\n');
  }
  if (!t) t = m.text || '';
  for (const a of m.attachments || []) if (a.extracted_content) t += `\n\n[attachment ${a.file_name || ''}]\n${a.extracted_content.slice(0, 20000)}`;
  return t;
}

// -> [{ uuid, name, createdAt, updatedAt, messages: [{ role, text, time, uuid }] }]
function normalize(conversations) {
  const out = [];
  for (const c of conversations || []) {
    if (!c || !c.uuid) continue;
    const msgs = (c.chat_messages || []).map(m => ({
      role: m.sender === 'human' ? 'user' : 'assistant', text: textOfMessage(m).trim(), time: m.created_at || c.created_at || '', uuid: m.uuid || crypto.randomUUID(),
    })).filter(m => m.text);
    out.push({ uuid: c.uuid, name: c.name || c.summary || (msgs[0] ? msgs[0].text.split('\n')[0].slice(0, 80) : 'Untitled chat'), summary: c.summary || '',
      createdAt: c.created_at || '', updatedAt: c.updated_at || c.created_at || '', model: c.model || '', messages: msgs, project: c.project ? (c.project.name || '') : '' });
  }
  return out;
}

function readExport(file) {
  const lower = file.toLowerCase();
  let raw;
  if (lower.endsWith('.zip')) {
    const z = ZipReader.fromFile(file);
    const name = z.names().find(n => n.endsWith('conversations.json'));
    if (!name) throw new Error('No conversations.json in this zip. Use the export from claude.ai Settings > Privacy > Export data.');
    raw = z.read(name).toString('utf8');
  } else raw = fs.readFileSync(file, 'utf8');
  const data = JSON.parse(raw);
  return normalize(Array.isArray(data) ? data : data.conversations || []);
}

// A transcript the Claude Code CLI and the desktop Code tab can read and resume.
function toTranscript(chat, cwd) {
  const lines = [];
  let parent = null;
  const ts = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? new Date(t).toISOString() : new Date().toISOString(); };
  for (const m of chat.messages) {
    const uuid = m.uuid;
    const base = { parentUuid: parent, isSidechain: false, userType: 'external', cwd, sessionId: chat.uuid, version: '0.0.0', gitBranch: '', type: m.role, uuid, timestamp: ts(m.time) };
    if (m.role === 'user') lines.push(JSON.stringify({ ...base, message: { role: 'user', content: m.text } }));
    else lines.push(JSON.stringify({ ...base, message: { id: 'msg_' + uuid.replace(/-/g, '').slice(0, 24), type: 'message', role: 'assistant', model: chat.model || 'claude', content: [{ type: 'text', text: m.text }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 0, output_tokens: 0 } } }));
    parent = uuid;
  }
  if (chat.name) lines.push(JSON.stringify({ type: 'custom-title', customTitle: chat.name, sessionId: chat.uuid }));
  return Buffer.from(lines.join('\n') + '\n', 'utf8');
}

function toRecord(chat, cwd) {
  const ms = iso => { const t = Date.parse(iso); return Number.isFinite(t) ? t : Date.now(); };
  return { sessionId: 'local_' + crypto.randomUUID(), cliSessionId: chat.uuid, cwd, originCwd: cwd, gitAnchorsFolderRealpath: cwd,
    createdAt: ms(chat.createdAt), lastActivityAt: ms(chat.updatedAt), lastFocusedAt: ms(chat.updatedAt), lastTurnEdgeAt: ms(chat.updatedAt),
    model: chat.model || '', effort: 'medium', isArchived: false, title: chat.name, titleSource: 'custom', permissionMode: 'default', remoteMcpServersConfig: [],
    completedTurns: chat.messages.filter(m => m.role === 'user').length, importedBy: 'context-bank', source: 'claude.ai', chatUrl: `https://claude.ai/chat/${chat.uuid}` };
}

// Live pull. Undocumented endpoints, the same ones the claude.ai web app calls; they can change.
async function fetchLive(sessionKey, { onProgress = () => {}, since = 0, orgId = null } = {}) {
  const key = String(sessionKey || '').trim().replace(/^sessionKey=/, '');
  if (!key) throw new Error('No session key');
  const headers = { Cookie: `sessionKey=${key}`, Accept: 'application/json', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36', Referer: 'https://claude.ai/' };
  const get = async (p) => {
    const r = await fetch((process.env.CLAUDE_AI_BASE || 'https://claude.ai') + p, { headers });
    if (r.status === 401 || r.status === 403) throw new Error(`claude.ai answered ${r.status}. The session key is wrong or expired, or the request was blocked. Copy a fresh sessionKey cookie from a signed-in browser.`);
    if (!r.ok) throw new Error(`claude.ai answered ${r.status} for ${p}`);
    return r.json();
  };
  const orgs = await get('/api/organizations');
  const org = orgs.find(o => o.uuid === orgId) || orgs.find(o => (o.capabilities || []).includes('chat')) || orgs[0];
  if (!org) throw new Error('No organization on this account');
  onProgress(`Listing chats in ${org.name || org.uuid}…`);
  const list = await get(`/api/organizations/${org.uuid}/chat_conversations`);
  const chats = [];
  let i = 0;
  for (const c of list) {
    i++;
    if (since && Date.parse(c.updated_at || 0) < since) continue;
    onProgress(`Fetching chat ${i}/${list.length}: ${c.name || c.uuid}`);
    try {
      const full = await get(`/api/organizations/${org.uuid}/chat_conversations/${c.uuid}?tree=True&rendering_mode=messages&render_all_tools=true`);
      chats.push(...normalize([{ ...c, ...full }]));
    } catch (e) { onProgress(`Skipped ${c.name || c.uuid}: ${e.message}`); }
  }
  return { org: { uuid: org.uuid, name: org.name || '' }, total: list.length, chats };
}

module.exports = { normalize, readExport, toTranscript, toRecord, fetchLive, defaultCwd: () => os.homedir() };
