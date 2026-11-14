'use strict';
// The Context Bank: a local, account-independent copy of every session, with search.
//
//   <bank>/sessions/<cliId>/record.json        sidebar record (real or synthesized)
//   <bank>/sessions/<cliId>/transcript.jsonl   full transcript, merged across captures
//   <bank>/sessions/<cliId>/extra/...          custom title, subagent transcripts
//   <bank>/sessions/<cliId>/meta.json          summary used by the list and search
//   <bank>/sessions/<cliId>/text.txt           plain conversation text for full-text search
//   <bank>/memory/<cwd-slug>/...               project memory snapshots
//   <bank>/config.json, <bank>/trash/
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const C = require('./claude');
const { ZipWriter, ZipReader } = require('./zip');
const chats = require('./chats');

function bankRoot() { return process.env.CONTEXT_BANK_DIR || path.join(os.homedir(), '.context-bank'); }
function sessionsDir() { return path.join(bankRoot(), 'sessions'); }
function sessionDir(cliId) { return path.join(sessionsDir(), cliId); }
function configPath() { return path.join(bankRoot(), 'config.json'); }

const DEFAULT_CONFIG = { labels: {}, autoBank: true, autoBankMinutes: 5, lastAutoBank: 0, includeMemory: true, sources: [], chatsCwd: '', sessionKey: '', chatsLastSync: 0, chatsOrg: '' };
function loadConfig() { return { ...DEFAULT_CONFIG, ...(C.readJson(configPath(), {}) || {}) }; }
function saveConfig(cfg) { C.writeFile(configPath(), JSON.stringify(cfg, null, 2)); return cfg; }

const textCache = new Map();

function plainText(buf) {
  return C.conversation(buf).filter(t => t.text).map(t => (t.role === 'user' ? 'USER: ' : 'CLAUDE: ') + t.text).join('\n');
}

function sha(buf) { return crypto.createHash('sha1').update(buf).digest('hex'); }

// source: { cliId, transcript?: path, transcriptBuf?: Buffer, record?: object, extraDir?: path,
//           extraFiles?: [{rel, buf}], account?, device?, origin?: string, memoryDir?: path, title? }
function bankSession(source, { includeMemory = true } = {}) {
  const cliId = source.cliId;
  if (!cliId) return { status: 'skip', reason: 'no session id' };
  const incoming = source.transcriptBuf || (source.transcript && fs.existsSync(source.transcript) ? fs.readFileSync(source.transcript) : null);
  if (!incoming) return { status: 'skip', reason: 'no transcript', cliId };
  const dir = sessionDir(cliId);
  const tpath = path.join(dir, 'transcript.jsonl');
  const metaPath = path.join(dir, 'meta.json');
  const old = C.readJson(metaPath, null);
  let data = incoming, added = 0, status = 'added';
  if (fs.existsSync(tpath)) {
    const existing = fs.readFileSync(tpath);
    if (old && old.sha === sha(incoming)) { status = 'unchanged'; data = null; }
    else { const m = C.mergeTranscripts(existing, incoming); data = m.data; added = m.added; status = added ? 'merged' : 'unchanged'; if (!added) data = null; }
  }
  if (data) C.writeFile(tpath, data);
  const full = data || fs.readFileSync(tpath);
  // record: prefer a real one; keep the one we already have over a synthesized one
  let record = source.record || (old && old.record) || null;
  if (!record) record = C.synthesizeRecord(full, cliId, source.title || null);
  if (!record.cliSessionId) record.cliSessionId = cliId;
  C.writeFile(path.join(dir, 'record.json'), JSON.stringify(record));
  // extra files
  const extra = source.extraFiles || (source.extraDir && fs.existsSync(source.extraDir)
    ? C.walk(source.extraDir).map(f => ({ rel: f.rel, buf: fs.readFileSync(f.abs) })) : []);
  for (const f of extra) { const dst = path.join(dir, 'extra', f.rel); if (!fs.existsSync(dst) || status !== 'unchanged') C.writeFile(dst, f.buf); }
  // memory
  if (includeMemory && source.memoryDir && fs.existsSync(source.memoryDir) && record.cwd) {
    const memDst = path.join(bankRoot(), 'memory', C.cwdSlug(record.cwd));
    for (const f of C.walk(source.memoryDir)) C.writeFile(path.join(memDst, f.rel), fs.readFileSync(f.abs));
  }
  const s = C.summarize(full);
  const ct = extra.find(f => f.rel === 'custom-title.json');
  let title = record.title;
  if (ct) { try { title = JSON.parse(ct.buf.toString('utf8')).customTitle || title; } catch {} }
  if (s.title) title = s.title;
  const origins = new Set((old && old.origins) || []);
  if (source.origin) origins.add(source.origin);
  else if (source.account) origins.add(`${source.account}/${source.device || ''}`);
  const meta = {
    cliId, title: title || record.title || '(untitled)', cwd: record.cwd || s.cwd || '', model: s.model || record.model || '',
    branch: s.branch, version: s.version, firstTs: s.firstTs, lastTs: s.lastTs,
    lastActivityMs: Math.max(Number(record.lastActivityAt || 0), C.msOf(s.lastTs) || 0), createdMs: Number(record.createdAt || 0) || C.msOf(s.firstTs),
    userTurns: s.userTurns, assistantTurns: s.assistantTurns, firstUser: s.firstUser.slice(0, 600), lastAssistant: s.lastAssistant.slice(-600),
    files: s.files.slice(0, 200), tools: s.tools, sizeKB: Math.floor(full.length / 1024), sha: sha(full),
    archived: !!record.isArchived, origins: [...origins], account: source.account || (old && old.account) || '',
    bankedAt: Date.now(), firstBankedAt: (old && old.firstBankedAt) || Date.now(), extraFiles: extra.length,
    record: { sessionId: record.sessionId, title: record.title, cwd: record.cwd, model: record.model, lastActivityAt: record.lastActivityAt, createdAt: record.createdAt, isArchived: record.isArchived },
  };
  C.writeFile(metaPath, JSON.stringify(meta));
  if (status !== 'unchanged' || !fs.existsSync(path.join(dir, 'text.txt'))) {
    C.writeFile(path.join(dir, 'text.txt'), plainText(full));
    textCache.delete(cliId);
  }
  return { status, added, cliId, title: meta.title };
}

function list() {
  const out = [];
  for (const id of C.safeDirs(sessionsDir())) {
    const m = C.readJson(path.join(sessionDir(id), 'meta.json'), null);
    if (m) out.push({ ...m, kind: 'bank', id: m.record && m.record.sessionId, hasTranscript: true });
  }
  out.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
  return out;
}
function has(cliId) { return fs.existsSync(path.join(sessionDir(cliId), 'transcript.jsonl')); }
function meta(cliId) { return C.readJson(path.join(sessionDir(cliId), 'meta.json'), null); }
function transcript(cliId) { return fs.readFileSync(path.join(sessionDir(cliId), 'transcript.jsonl')); }
function record(cliId) { return C.readJson(path.join(sessionDir(cliId), 'record.json'), null); }
function extraFiles(cliId) {
  const d = path.join(sessionDir(cliId), 'extra');
  return fs.existsSync(d) ? C.walk(d).map(f => ({ rel: f.rel, buf: fs.readFileSync(f.abs) })) : [];
}
function textOf(cliId) {
  if (textCache.has(cliId)) return textCache.get(cliId);
  let t = '';
  try { t = fs.readFileSync(path.join(sessionDir(cliId), 'text.txt'), 'utf8'); } catch { try { t = plainText(transcript(cliId)); } catch {} }
  textCache.set(cliId, t);
  return t;
}

// Search: every word must appear in title+cwd+firstUser+lastAssistant (fast), or, with
// content=true, anywhere in the conversation text. Returns [{cliId, score, snippet}].
function search(query, { content = true, limit = 500 } = {}) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  const all = list();
  if (!words.length) return all.map(m => ({ ...m, score: 0, snippet: '' }));
  const out = [];
  for (const m of all) {
    const head = `${m.title}\n${m.cwd}\n${m.firstUser}\n${m.lastAssistant}\n${m.branch}\n${m.model}\n${m.cliId}`.toLowerCase();
    let score = 0, snippet = '';
    const snip = (text, low) => { const i = low.indexOf(words[0]); return i < 0 ? '' : text.slice(Math.max(0, i - 80), i + 160).replace(/\s+/g, ' '); };
    if (words.every(w => head.includes(w))) score = 10;
    else if (content) {
      const text = textOf(m.cliId); const low = text.toLowerCase();
      if (words.every(w => low.includes(w))) { score = 5; snippet = snip(text, low); }
    }
    if (score && !snippet) {
      const text = content ? textOf(m.cliId) : `${m.firstUser}\n${m.lastAssistant}`;
      snippet = snip(text, text.toLowerCase());
    }
    if (score) { out.push({ ...m, score, snippet }); if (out.length >= limit) break; }
  }
  return out;
}

function remove(cliId) {
  const dir = sessionDir(cliId);
  if (!fs.existsSync(dir)) return false;
  const t = path.join(bankRoot(), 'trash', C.stamp(), cliId);
  fs.mkdirSync(path.dirname(t), { recursive: true });
  fs.renameSync(dir, t);
  textCache.delete(cliId);
  return true;
}

// Bank everything Claude knows about on this PC: every account's records plus orphan transcripts.
function bankLive({ includeMemory = true, onlyChanged = true } = {}) {
  const { accounts, orphans } = C.discoverAll();
  const results = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [] };
  const seen = new Set();
  const consider = (s, origin) => {
    if (!s.cliId || seen.has(s.cliId) || !s.hasTranscript) { if (!s.hasTranscript) results.skipped++; return; }
    seen.add(s.cliId);
    if (onlyChanged) { const m = meta(s.cliId); if (m && m.bankedAt && s.mtimeMs && s.mtimeMs < m.bankedAt - 1000 && m.sizeKB === s.sizeKB) { results.unchanged++; return; } }
    const r = bankSession({ cliId: s.cliId, transcript: s.transcript, extraDir: s.extraDir, record: s.recordFile ? C.readJson(s.recordFile) : null,
      account: s.account, device: s.device, origin, memoryDir: path.join(path.dirname(s.transcript), 'memory') }, { includeMemory });
    results[r.status === 'skip' ? 'skipped' : r.status]++;
    if (r.status === 'added' || r.status === 'merged') results.items.push(r);
  };
  for (const a of accounts) for (const s of a.sessions) consider(s, `${os.hostname()}:${a.id}/${s.device}`);
  for (const s of orphans) consider(s, `${os.hostname()}:orphan`);
  const cfg = loadConfig(); cfg.lastAutoBank = Date.now(); saveConfig(cfg);
  return results;
}

// Bank every session found in any folder (a copied .claude folder, a projects folder, a USB stick…).
function bankFolder(folder, { includeMemory = true } = {}) {
  const scan = C.scanFolder(folder);
  const results = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [], scanned: scan.sources.length, projectRoots: scan.projectRoots };
  for (const src of scan.sources) {
    const r = bankSession({ ...src, origin: `folder:${folder}` }, { includeMemory });
    results[r.status === 'skip' ? 'skipped' : r.status]++;
    if (r.status === 'added' || r.status === 'merged') results.items.push(r);
  }
  const cfg = loadConfig();
  if (!cfg.sources.includes(folder)) { cfg.sources.push(folder); saveConfig(cfg); }
  return results;
}

// Bank a bundle zip made by claude-session-transfer (or by this app).
function bankBundle(zipPath) {
  const z = ZipReader.fromFile(zipPath);
  const manifest = JSON.parse(z.read('manifest.json').toString('utf8'));
  const results = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [], scanned: (manifest.sessions || []).length };
  const names = z.names();
  for (const e of manifest.sessions || []) {
    const cid = e.cliSessionId; const base = `sessions/${cid}/`;
    if (!z.has(base + 'transcript.jsonl')) { results.skipped++; continue; }
    const record = z.has(base + 'record.json') ? JSON.parse(z.read(base + 'record.json').toString('utf8')) : null;
    const extra = names.filter(n => n.startsWith(base + 'extra/') && !n.endsWith('/')).map(n => ({ rel: n.slice((base + 'extra/').length), buf: z.read(n) }));
    const r = bankSession({ cliId: cid, transcriptBuf: z.read(base + 'transcript.jsonl'), record, extraFiles: extra, title: e.title,
      account: manifest.sourceAccount || '', origin: `bundle:${manifest.sourceMachine || path.basename(zipPath)}` });
    results[r.status === 'skip' ? 'skipped' : r.status]++;
    if (r.status === 'added' || r.status === 'merged') results.items.push(r);
  }
  for (const m of manifest.memory || []) {
    const prefix = `memory/${m.slug}/`;
    for (const n of names) if (n.startsWith(prefix) && !n.endsWith('/')) C.writeFile(path.join(bankRoot(), 'memory', m.slug, n.slice(prefix.length)), z.read(n));
  }
  return results;
}

// Bank claude.ai chats (from a data export file or a live pull) as sessions.
function bankChats(list, { cwd, origin = 'claude.ai' } = {}) {
  cwd = cwd || loadConfig().chatsCwd || chats.defaultCwd();
  const results = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [], scanned: list.length };
  for (const chat of list) {
    if (!chat.messages.length) { results.skipped++; continue; }
    const old = meta(chat.uuid);
    const r = bankSession({ cliId: chat.uuid, transcriptBuf: chats.toTranscript(chat, (old && old.cwd) || cwd), record: old ? null : chats.toRecord(chat, cwd), origin, title: chat.name,
      extraFiles: [{ rel: 'custom-title.json', buf: Buffer.from(JSON.stringify({ customTitle: chat.name })) }] });
    if (r.status !== 'skip') {
      const m = meta(chat.uuid); m.chat = true; m.chatUrl = `https://claude.ai/chat/${chat.uuid}`; m.title = chat.name || m.title; if (chat.project) m.project = chat.project;
      C.writeFile(path.join(sessionDir(chat.uuid), 'meta.json'), JSON.stringify(m));
    }
    results[r.status === 'skip' ? 'skipped' : r.status]++;
    if (r.status === 'added' || r.status === 'merged') results.items.push(r);
  }
  return results;
}

// Export banked sessions as a bundle zip (same layout as claude-session-transfer, so either tool loads it).
function exportBundle(cliIds, outPath, { includeMemory = true } = {}) {
  const zw = new ZipWriter();
  const manifest = { bundleVersion: C.BUNDLE_VERSION, createdAt: new Date().toISOString().slice(0, 19), sourceMachine: os.hostname(),
    sourcePlatform: process.platform, sourceAccount: null, sessions: [], memory: [], project: [], settings: [], exportedBy: 'context-bank' };
  const slugs = new Set();
  for (const cid of cliIds) {
    const m = meta(cid); if (!m) continue;
    const rec = record(cid); const t = transcript(cid);
    zw.add(`sessions/${cid}/record.json`, JSON.stringify(rec));
    zw.add(`sessions/${cid}/transcript.jsonl`, t);
    for (const f of extraFiles(cid)) zw.add(`sessions/${cid}/extra/${f.rel}`, f.buf);
    manifest.sessions.push({ cliSessionId: cid, sessionId: rec.sessionId, title: m.title, cwd: m.cwd, lastActivityAt: m.lastActivityMs, hasTranscript: true, transcriptKB: m.sizeKB });
    const slug = C.cwdSlug(m.cwd);
    const memDir = path.join(bankRoot(), 'memory', slug);
    if (includeMemory && !slugs.has(slug) && fs.existsSync(memDir)) {
      slugs.add(slug);
      const files = C.walk(memDir);
      for (const f of files) zw.add(`memory/${slug}/${f.rel}`, fs.readFileSync(f.abs));
      manifest.memory.push({ cwd: m.cwd, slug, files: files.length });
    }
  }
  zw.add('manifest.json', JSON.stringify(manifest, null, 2));
  zw.writeFile(outPath);
  return { path: outPath, sessions: manifest.sessions.length, memory: manifest.memory.length, sizeKB: Math.floor(fs.statSync(outPath).size / 1024) };
}

// Install banked sessions into an account on this PC so Claude Desktop lists them and can resume.
function importToAccount(cliIds, { accountId, deviceId, cwdMap = {}, newId = false, overwrite = false, merge = true, dryRun = false, includeMemory = true, backup = true }) {
  const log = [];
  const destDir = path.join(C.sessionsRoot(), accountId, deviceId);
  if (!dryRun && backup) { const b = C.backupFolder(destDir); if (b) log.push(`Backup of ${accountId.slice(0, 8)}…/${deviceId.slice(0, 8)}… -> ${b}`); }
  if (!dryRun) fs.mkdirSync(destDir, { recursive: true });
  const installed = [];
  const slugs = new Set();
  for (const cid of cliIds) {
    const m = meta(cid);
    if (!m) { log.push(`SKIP ${cid}: not in bank`); continue; }
    const r = C.installSession({ cliId: cid, record: record(cid), transcriptBuf: transcript(cid), extraFiles: extraFiles(cid) },
      { accountId, deviceId, cwdMap, newId, overwrite, merge, dryRun });
    log.push(...r.log);
    if (r.recordPath && !r.dry) installed.push({ cliId: cid, sessionId: r.sessionId, recordPath: r.recordPath, transcriptPath: r.transcriptPath, cwd: cwdMap[m.cwd] || m.cwd });
    const newCwd = cwdMap[m.cwd] || m.cwd; const slug = C.cwdSlug(newCwd);
    const memSrc = path.join(bankRoot(), 'memory', C.cwdSlug(m.cwd));
    if (includeMemory && !slugs.has(slug) && fs.existsSync(memSrc)) {
      slugs.add(slug);
      let added = 0, kept = 0;
      for (const f of C.walk(memSrc)) {
        const dst = path.join(C.projectsRoot(), slug, 'memory', f.rel);
        if (fs.existsSync(dst) && !overwrite) { kept++; continue; }
        if (!dryRun) C.writeFile(dst, fs.readFileSync(f.abs));
        added++;
      }
      log.push(`${dryRun ? 'DRY ' : ''}MEMORY ${newCwd}: ${added} files added, ${kept} kept`);
    }
  }
  return { log, installed };
}

module.exports = { bankRoot, sessionsDir, sessionDir, loadConfig, saveConfig, bankSession, list, has, meta, transcript, record,
  extraFiles, textOf, search, remove, bankLive, bankFolder, bankBundle, bankChats, exportBundle, importToAccount, plainText };
