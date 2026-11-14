'use strict';
// Where Claude Desktop / Claude Code keep sessions, and how to read, merge and write them.
// Port of cst/core.py (sxi9/claude-session-transfer) with orphan-transcript discovery added.
//
//   <appData>/claude-code-sessions/<account>/<device>/local_<id>.json   sidebar record
//   ~/.claude/projects/<cwd-slug>/<cliSessionId>.jsonl                   transcript
//   ~/.claude/projects/<cwd-slug>/<cliSessionId>/                        title + subagents
//   ~/.claude/projects/<cwd-slug>/memory/                                project memory
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const BUNDLE_VERSION = 2;

// ---------------------------------------------------------------- locations
function appDataDir() {
  if (process.env.CLAUDE_APP_DIR) return process.env.CLAUDE_APP_DIR;
  if (process.platform === 'win32') return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'Claude');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Claude');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'Claude');
}
function claudeHome() { return process.env.CLAUDE_HOME_DIR || path.join(os.homedir(), '.claude'); }
function sessionsRoot() { return path.join(appDataDir(), 'claude-code-sessions'); }
function backupsRoot() { return path.join(appDataDir(), 'claude-code-sessions-backups'); }
function projectsRoot() { return path.join(claudeHome(), 'projects'); }
function configFile() { return path.join(appDataDir(), 'config.json'); }

function cwdSlug(cwd) { return String(cwd || '').replace(/[^A-Za-z0-9]/g, '-'); }

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}
function readConfig() { return readJson(configFile(), {}) || {}; }
function currentAccountId() { return readConfig().lastKnownAccountUuid || null; }
function deviceIdHint() {
  for (const k of Object.keys(readConfig())) if (k.startsWith('dxt:allowlistEnabled:')) return k.split(':', 3)[2];
  const root = sessionsRoot();
  if (!fs.existsSync(root)) return null;
  for (const acc of safeDirs(root)) {
    const devs = safeDirs(path.join(root, acc));
    if (devs.length) return devs[0];
  }
  return null;
}
function safeDirs(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort(); } catch { return []; }
}
function safeFiles(p) {
  try { return fs.readdirSync(p, { withFileTypes: true }).filter(d => d.isFile()).map(d => d.name).sort(); } catch { return []; }
}
function walk(dir, base = dir, out = []) {
  for (const d of (() => { try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; } })()) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) walk(p, base, out);
    else if (d.isFile()) out.push({ abs: p, rel: path.relative(base, p).split(path.sep).join('/') });
  }
  return out;
}
function claudeAppRunning() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq claude.exe', '/NH'], { timeout: 10000 }).toString().toLowerCase();
      return out.includes('claude.exe');
    }
    const out = execFileSync('pgrep', ['-xi', 'claude'], { timeout: 10000 }).toString();
    return out.trim().length > 0;
  } catch { return false; }
}

// ---------------------------------------------------------------- transcripts
function* iterLines(buf) {
  const text = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line) continue;
    let obj = null;
    try { obj = JSON.parse(line); } catch { obj = null; }
    yield [obj, line];
  }
}

function textOf(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  const parts = [];
  for (const block of content || []) {
    if (!block || typeof block !== 'object') continue;
    if (block.type === 'text') parts.push(block.text || '');
    else if (block.type === 'tool_use') parts.push(`[tool: ${block.name}]`);
    else if (block.type === 'tool_result') {
      const c = block.content;
      if (typeof c === 'string') parts.push('[result] ' + c.slice(0, 400));
      else if (Array.isArray(c)) parts.push('[result] ' + c.map(x => (x && x.text ? x.text.slice(0, 400) : '')).join(' '));
    }
  }
  return parts.filter(Boolean).join('\n');
}

// Rich turn list for the chat viewer: text, thinking, tool calls and results kept separate.
function conversation(buf, { rich = false } = {}) {
  const out = [];
  for (const [obj] of iterLines(buf)) {
    if (!obj || (obj.type !== 'user' && obj.type !== 'assistant')) continue;
    const msg = obj.message || {};
    const turn = { role: obj.type, time: obj.timestamp || '', uuid: obj.uuid || '', text: '', blocks: [] };
    const content = msg.content;
    if (typeof content === 'string') turn.blocks.push({ type: 'text', text: content });
    else for (const b of content || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'text') turn.blocks.push({ type: 'text', text: b.text || '' });
      else if (b.type === 'thinking') turn.blocks.push({ type: 'thinking', text: b.thinking || '' });
      else if (b.type === 'tool_use') turn.blocks.push({ type: 'tool_use', name: b.name, input: b.input, id: b.id });
      else if (b.type === 'tool_result') {
        const c = b.content;
        const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(x => (x && x.text) || '').join('\n') : '';
        turn.blocks.push({ type: 'tool_result', text, isError: !!b.is_error, id: b.tool_use_id });
      }
    }
    turn.text = turn.blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
    if (turn.role === 'user' && turn.text.startsWith('<system-reminder>') && turn.text.length < 20) continue;
    if (!turn.text && !turn.blocks.length) continue;
    if (turn.role === 'user' && !turn.text && turn.blocks.every(b => b.type === 'tool_result') && !rich) continue;
    if (!rich) delete turn.blocks;
    out.push(turn);
  }
  return out;
}

function isSpokenUser(t) { return t.role === 'user' && t.text && !t.text.startsWith('[result]') && !t.text.startsWith('<'); }

// Everything the sidebar record would say, derived from a transcript alone.
function summarize(buf) {
  let cwd = '', model = '', title = null, firstTs = null, lastTs = null, branch = '', version = '';
  let turns = 0, assistantTurns = 0, firstUser = '', lastAssistant = '';
  const files = new Set(), tools = new Set();
  for (const [obj] of iterLines(buf)) {
    if (!obj) continue;
    if (!cwd && obj.cwd) cwd = obj.cwd;
    if (!branch && obj.gitBranch) branch = obj.gitBranch;
    if (!version && obj.version) version = obj.version;
    if (obj.type === 'custom-title' && obj.customTitle) title = obj.customTitle;
    if (obj.timestamp) { firstTs = firstTs || obj.timestamp; lastTs = obj.timestamp; }
    const msg = obj.message || {};
    if (obj.type === 'user') {
      const txt = textOf(msg).trim();
      if (txt && !txt.startsWith('[result]') && !txt.startsWith('<')) { turns++; if (!firstUser) firstUser = txt; }
    } else if (obj.type === 'assistant') {
      assistantTurns++;
      if (!model && msg.model) model = msg.model;
      for (const b of msg.content || []) {
        if (!b || typeof b !== 'object') continue;
        if (b.type === 'text' && b.text && b.text.trim()) lastAssistant = b.text.trim();
        if (b.type === 'tool_use') {
          tools.add(b.name);
          const inp = b.input || {};
          const f = inp.file_path || inp.path || inp.notebook_path;
          if (typeof f === 'string') files.add(f);
        }
      }
    }
  }
  return { cwd, model, title, firstTs, lastTs, branch, version, userTurns: turns, assistantTurns,
    firstUser, lastAssistant, files: [...files], tools: [...tools] };
}

function msOf(iso) {
  if (!iso) return Date.now();
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Date.now();
}

function newLocalId() { return 'local_' + crypto.randomUUID(); }

function synthesizeRecord(buf, cliId, title) {
  const s = summarize(buf);
  const autoTitle = (s.firstUser ? s.firstUser.split(/\r?\n/)[0].slice(0, 80) : '') || `Imported ${cliId.slice(0, 8)}`;
  const t = title || s.title;
  return {
    sessionId: newLocalId(), cliSessionId: cliId,
    cwd: s.cwd, originCwd: s.cwd, gitAnchorsFolderRealpath: s.cwd,
    createdAt: msOf(s.firstTs), lastActivityAt: msOf(s.lastTs), lastFocusedAt: msOf(s.lastTs), lastTurnEdgeAt: msOf(s.lastTs),
    model: s.model, effort: 'medium', isArchived: false,
    title: t || autoTitle, titleSource: t ? 'custom' : 'auto',
    permissionMode: 'default', remoteMcpServersConfig: [], completedTurns: s.userTurns,
    importedBy: 'context-bank',
  };
}

function lineKey(obj, raw) {
  if (obj && obj.uuid) return 'u:' + obj.uuid;
  return 'h:' + crypto.createHash('sha1').update(raw).digest('hex');
}

// Union of two transcripts of the same session, keyed by message uuid.
function mergeTranscripts(existing, incoming) {
  const seen = new Set(); const out = [];
  for (const [obj, raw] of iterLines(existing)) { seen.add(lineKey(obj, raw)); out.push(raw); }
  let added = 0;
  for (const [obj, raw] of iterLines(incoming)) {
    const k = lineKey(obj, raw);
    if (seen.has(k)) continue;
    seen.add(k); out.push(raw); added++;
  }
  return { data: Buffer.from(out.join('\n') + '\n', 'utf8'), added };
}

function remapTranscript(buf, oldCwd, newCwd) {
  if (oldCwd === newCwd) return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  const out = [];
  for (let [obj, raw] of iterLines(buf)) {
    if (obj && typeof obj === 'object' && obj.cwd === oldCwd) { obj.cwd = newCwd; raw = JSON.stringify(obj); }
    out.push(raw);
  }
  return Buffer.from(out.join('\n') + '\n', 'utf8');
}

// ---------------------------------------------------------------- discovery
function recordToSession(record, file, account, device) {
  const cliId = record.cliSessionId || '';
  const projectDir = path.join(projectsRoot(), cwdSlug(record.cwd || ''));
  const transcript = path.join(projectDir, cliId + '.jsonl');
  let sizeKB = -1, mtime = 0;
  try { const st = fs.statSync(transcript); sizeKB = Math.floor(st.size / 1024); mtime = st.mtimeMs; } catch {}
  return {
    kind: 'live', id: record.sessionId || (file ? path.basename(file, '.json') : ''), cliId,
    title: record.title || '(untitled)', cwd: record.cwd || '', archived: !!record.isArchived,
    lastActivityMs: Number(record.lastActivityAt || record.createdAt || 0), createdMs: Number(record.createdAt || 0),
    model: record.model || '', account, device, recordFile: file, transcript, extraDir: path.join(projectDir, cliId),
    hasTranscript: sizeKB >= 0, sizeKB, mtimeMs: mtime, orphan: false,
  };
}

function discover() {
  const root = sessionsRoot();
  const accounts = [];
  for (const accId of safeDirs(root)) {
    const acc = { id: accId, folder: path.join(root, accId), devices: safeDirs(path.join(root, accId)), sessions: [] };
    for (const dev of acc.devices) {
      const devDir = path.join(root, accId, dev);
      for (const f of safeFiles(devDir)) {
        if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
        const rec = readJson(path.join(devDir, f));
        if (rec) acc.sessions.push(recordToSession(rec, path.join(devDir, f), accId, dev));
      }
    }
    acc.sessions.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    accounts.push(acc);
  }
  return accounts;
}

// Transcripts under ~/.claude/projects that no sidebar record points at (deleted from the
// sidebar, made by the CLI, or left over from another account). Still worth banking.
function discoverOrphans(known = new Set(), projRoot = projectsRoot()) {
  const out = [];
  for (const slug of safeDirs(projRoot)) {
    const dir = path.join(projRoot, slug);
    for (const f of safeFiles(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const cliId = f.slice(0, -6);
      if (known.has(cliId)) continue;
      const transcript = path.join(dir, f);
      let st; try { st = fs.statSync(transcript); } catch { continue; }
      if (st.size === 0) continue;
      const head = fs.readFileSync(transcript);
      const s = summarize(head);
      if (!s.userTurns && !s.assistantTurns) continue;
      let title = s.title;
      const ct = readJson(path.join(dir, cliId, 'custom-title.json'));
      if (ct && ct.customTitle) title = ct.customTitle;
      out.push({
        kind: 'live', id: '', cliId, title: title || (s.firstUser ? s.firstUser.split(/\r?\n/)[0].slice(0, 80) : `Session ${cliId.slice(0, 8)}`),
        cwd: s.cwd, archived: false, lastActivityMs: msOf(s.lastTs), createdMs: msOf(s.firstTs), model: s.model,
        account: '', device: '', recordFile: null, transcript, extraDir: path.join(dir, cliId),
        hasTranscript: true, sizeKB: Math.floor(st.size / 1024), mtimeMs: st.mtimeMs, orphan: true,
      });
    }
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}

function discoverAll() {
  const accounts = discover();
  const known = new Set();
  for (const a of accounts) for (const s of a.sessions) if (s.cliId) known.add(s.cliId);
  return { accounts, orphans: discoverOrphans(known), currentAccount: currentAccountId(), deviceHint: deviceIdHint() };
}

// Read any folder that looks like a Claude home (".claude"), a projects folder, or a
// claude-code-sessions store, and return session sources that can be banked.
function scanFolder(folder) {
  const sources = [];
  const candidates = [];
  const base = path.basename(folder);
  const has = n => fs.existsSync(path.join(folder, n));
  if (has('projects')) candidates.push(path.join(folder, 'projects'));
  else if (base === 'projects' || safeDirs(folder).some(d => safeFiles(path.join(folder, d)).some(f => f.endsWith('.jsonl')))) candidates.push(folder);
  if (has('.claude') && fs.existsSync(path.join(folder, '.claude', 'projects'))) candidates.push(path.join(folder, '.claude', 'projects'));
  // records: <store>/<account>/<device>/local_*.json
  const records = new Map();
  const storeDirs = [];
  if (has('claude-code-sessions')) storeDirs.push(path.join(folder, 'claude-code-sessions'));
  if (base === 'claude-code-sessions') storeDirs.push(folder);
  for (const store of storeDirs) for (const acc of safeDirs(store)) for (const dev of safeDirs(path.join(store, acc)))
    for (const f of safeFiles(path.join(store, acc, dev))) {
      if (!f.startsWith('local_') || !f.endsWith('.json')) continue;
      const rec = readJson(path.join(store, acc, dev, f));
      if (rec && rec.cliSessionId) records.set(rec.cliSessionId, { record: rec, account: acc, device: dev });
    }
  const seen = new Set();
  for (const projRoot of candidates) {
    for (const slug of safeDirs(projRoot)) {
      const dir = path.join(projRoot, slug);
      for (const f of safeFiles(dir)) {
        if (!f.endsWith('.jsonl')) continue;
        const cliId = f.slice(0, -6);
        if (seen.has(cliId)) continue;
        seen.add(cliId);
        const transcript = path.join(dir, f);
        const known = records.get(cliId);
        const extraDir = path.join(dir, cliId);
        sources.push({ cliId, transcript, extraDir: fs.existsSync(extraDir) ? extraDir : null,
          record: known ? known.record : null, account: known ? known.account : '', device: known ? known.device : '',
          memoryDir: fs.existsSync(path.join(dir, 'memory')) ? path.join(dir, 'memory') : null });
      }
    }
  }
  return { sources, projectRoots: candidates, recordsFound: records.size };
}

// ---------------------------------------------------------------- backups + writes
function stamp() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
function backupFolder(folder) {
  if (!fs.existsSync(folder)) return null;
  const base = path.join(backupsRoot(), path.basename(path.dirname(folder)), `${path.basename(folder)}-${stamp()}`);
  let dest = base, i = 1;
  while (fs.existsSync(dest)) dest = `${base}-${i++}`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.cpSync(folder, dest, { recursive: true });
  return dest;
}
function listBackups() {
  const out = []; const root = backupsRoot();
  for (const acc of safeDirs(root)) for (const b of safeDirs(path.join(root, acc)).reverse()) {
    const dir = path.join(root, acc, b);
    out.push({ path: dir, account: acc, device: b.replace(/-\d{8}-\d{6}(?:-\d+)?$/, ''), name: b,
      records: safeFiles(dir).filter(f => f.startsWith('local_')).length, createdMs: fs.statSync(dir).mtimeMs });
  }
  return out;
}
function restoreBackup(backupPath) {
  const b = path.resolve(backupPath);
  if (!b.startsWith(path.resolve(backupsRoot()) + path.sep) || !fs.existsSync(b)) throw new Error('Not a backup folder made by this tool');
  const account = path.basename(path.dirname(b));
  const device = path.basename(b).replace(/-\d{8}-\d{6}(?:-\d+)?$/, '');
  const target = path.join(sessionsRoot(), account, device);
  const bk = backupFolder(target);
  fs.rmSync(target, { recursive: true, force: true });
  fs.cpSync(b, target, { recursive: true });
  return [`Restored ${path.basename(b)} -> ${target}`, bk ? `Previous state saved to ${bk}` : 'No previous state'];
}
function writeFile(dst, data) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.writeFileSync(dst, data); }

// Install one session (record + transcript + extra files) into an account on this PC.
// source: { record, transcriptBuf, extraFiles: [{rel, buf}], cliId }
function installSession(source, { accountId, deviceId, cwdMap = {}, newId = false, overwrite = false, merge = true, dryRun = false }) {
  const log = [];
  const destDir = path.join(sessionsRoot(), accountId, deviceId);
  const cid = source.cliId;
  let record = source.record ? { ...source.record } : synthesizeRecord(source.transcriptBuf, cid, null);
  if (!record.cliSessionId) record.cliSessionId = cid;
  const oldCwd = record.cwd || '';
  const newCwd = cwdMap[oldCwd] || oldCwd;
  for (const k of ['cwd', 'originCwd', 'gitAnchorsFolderRealpath']) if (record[k] === oldCwd) record[k] = newCwd;
  if (newId || !record.sessionId) record.sessionId = newLocalId();
  const recPath = path.join(destDir, `${record.sessionId}.json`);
  const proj = path.join(projectsRoot(), cwdSlug(newCwd));
  const tpath = path.join(proj, `${cid}.jsonl`);
  const note = newCwd !== oldCwd ? `  (folder remapped -> ${newCwd})` : '';
  const title = record.title || cid;
  if (fs.existsSync(recPath) && !(overwrite || merge)) { log.push(`SKIP ${title}: record already exists`); return { log, recordPath: null }; }

  let action = 'LOAD', data = null;
  if (source.transcriptBuf) {
    const incoming = remapTranscript(source.transcriptBuf, oldCwd, newCwd);
    if (fs.existsSync(tpath) && overwrite) { action = 'REPLACE transcript'; data = incoming; }
    else if (fs.existsSync(tpath) && merge) {
      const m = mergeTranscripts(fs.readFileSync(tpath), incoming);
      action = `MERGE transcript (+${m.added} lines)`; data = m.added ? m.data : null;
    } else if (fs.existsSync(tpath)) { action = 'KEEP existing transcript'; }
    else data = incoming;
  }
  if (dryRun) { log.push(`DRY ${action} ${title} -> ${tpath}${note}`); return { log, recordPath: recPath, dry: true }; }
  if (data) writeFile(tpath, data);
  log.push(`${action} ${title}${note}`);
  for (const f of source.extraFiles || []) {
    const dst = path.join(proj, cid, f.rel);
    if (!fs.existsSync(dst) || overwrite) writeFile(dst, f.buf);
  }
  if (fs.existsSync(recPath) && merge && !overwrite) {
    const old = readJson(recPath);
    if (old && (old.lastActivityAt || 0) > (record.lastActivityAt || 0))
      for (const k of ['lastActivityAt', 'title', 'isArchived']) if (k in old) record[k] = old[k];
  }
  writeFile(recPath, JSON.stringify(record));
  return { log, recordPath: recPath, transcriptPath: tpath, sessionId: record.sessionId };
}

module.exports = {
  BUNDLE_VERSION, appDataDir, claudeHome, sessionsRoot, backupsRoot, projectsRoot, configFile, cwdSlug,
  readConfig, currentAccountId, deviceIdHint, claudeAppRunning, iterLines, textOf, conversation, isSpokenUser,
  summarize, synthesizeRecord, mergeTranscripts, remapTranscript, discover, discoverOrphans, discoverAll,
  scanFolder, backupFolder, listBackups, restoreBackup, installSession, writeFile, walk, readJson, safeDirs, safeFiles,
  msOf, newLocalId, stamp,
};
