'use strict';
// All bank/claude operations, free of Electron, so they can run in a worker thread.
// Every op takes a `progress(text)` callback as its last argument.
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('./claude');
const bank = require('./bank');
const chats = require('./chats');
const { buildHandoff } = require('./handoff');
const { toMarkdown, toHtml } = require('./exporters');
const { scanSecrets } = require('./secrets');
const { ZipReader } = require('./zip');

const MAX_TURNS = 400;

function liveSessions() {
  const d = C.discoverAll();
  const cfg = bank.loadConfig();
  const out = [];
  for (const a of d.accounts) for (const s of a.sessions) out.push({ ...s, banked: bank.has(s.cliId), label: cfg.labels[a.id] || '' });
  for (const s of d.orphans) out.push({ ...s, banked: bank.has(s.cliId), label: '' });
  return out;
}

function summarizeResult(r, what) {
  return `${what}: ${r.added} new, ${r.merged} updated, ${r.unchanged} unchanged, ${r.skipped} skipped` + (r.scanned != null ? ` (${r.scanned} found)` : '');
}

function bankLiveOne(s) {
  return bank.bankSession({ cliId: s.cliId, transcript: s.transcript, extraDir: s.extraDir, record: s.recordFile ? C.readJson(s.recordFile) : null,
    account: s.account, device: s.device, origin: `${os.hostname()}:${s.account || 'orphan'}/${s.device || ''}`, memoryDir: path.join(path.dirname(s.transcript), 'memory') });
}

function transcriptFor(ref) {
  if (ref.kind === 'bank' || bank.has(ref.cliId)) return { buf: bank.transcript(ref.cliId), meta: bank.meta(ref.cliId), banked: true };
  const live = liveSessions().find(s => s.cliId === ref.cliId);
  if (!live || !live.hasTranscript) throw new Error('Transcript not found');
  const buf = fs.readFileSync(live.transcript);
  const s = C.summarize(buf);
  return { buf, banked: false, meta: { ...live, ...s, files: s.files, firstUser: s.firstUser, lastAssistant: s.lastAssistant } };
}

const ops = {
  state(progress, { maximized = false } = {}) {
    const d = C.discoverAll();
    const cfg = bank.loadConfig();
    const all = bank.list();
    return {
      accounts: d.accounts.map(a => ({ id: a.id, label: cfg.labels[a.id] || '', devices: a.devices, sessions: a.sessions.length, current: a.id === d.currentAccount })),
      orphans: d.orphans.length, currentAccount: d.currentAccount, deviceHint: d.deviceHint, bankCount: all.length, chatCount: all.filter(m => m.chat).length, configFiles: bank.configCount(),
      config: cfg, claudeRunning: C.claudeAppRunning(), platform: process.platform, hostname: os.hostname(),
      paths: { bank: bank.bankRoot(), sessions: C.sessionsRoot(), projects: C.projectsRoot(), backups: C.backupsRoot() }, maximized,
    };
  },
  live() { return liveSessions(); },
  list() { return bank.list(); },
  search(progress, q, opts) { return bank.search(q, opts || {}); },
  session(progress, ref) {
    const { buf, meta, banked } = transcriptFor(ref);
    const all = C.conversation(buf, { rich: true });
    const turns = all.slice(-MAX_TURNS).map(t => ({
      ...t, blocks: t.blocks.map(b => b.type === 'tool_use' ? { ...b, input: JSON.stringify(b.input || {}, null, 1).slice(0, 4000) }
        : b.type === 'tool_result' ? { ...b, text: (b.text || '').slice(0, 4000) } : b.type === 'thinking' ? { ...b, text: (b.text || '').slice(0, 6000) } : { ...b, text: (b.text || '').slice(0, 20000) }),
    }));
    let lines = 0; for (let i = 0; i < buf.length; i++) if (buf[i] === 10) lines++;
    return { meta: { ...meta, banked, cwdExists: !!meta.cwd && fs.existsSync(meta.cwd) }, turns, turnsTotal: all.length, lines };
  },
  bankAll(progress) { const r = bank.bankLive({ onlyChanged: true }, progress); return { ...r, message: summarizeResult(r, 'Bank everything') }; },
  bankOne(progress, refs) {
    const live = liveSessions();
    const out = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [] };
    let i = 0;
    for (const ref of refs) {
      const s = live.find(x => x.cliId === ref.cliId);
      if (!s) { out.skipped++; continue; }
      progress(`Banking ${++i}/${refs.length}: ${s.title}`);
      const r = bankLiveOne(s);
      out[r.status === 'skip' ? 'skipped' : r.status]++;
    }
    return { ...out, message: summarizeResult(out, 'Bank selected') };
  },
  bankFolder(progress, folder) {
    const res = bank.bankFolder(folder, {}, progress);
    const msg = summarizeResult(res, 'Folder ' + path.basename(folder));
    return { ...res, message: res.scanned ? msg : `No sessions found in ${folder}. Give it a .claude folder, its projects folder, or a claude-code-sessions store.` };
  },
  bankBundle(progress, file) { const res = bank.bankBundle(file, progress); return { ...res, message: summarizeResult(res, 'Bundle ' + path.basename(file)) }; },
  bankPaths(progress, paths) {
    const msgs = [];
    for (const p of paths || []) {
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) msgs.push(summarizeResult(bank.bankFolder(p, {}, progress), path.basename(p)));
        else if (p.toLowerCase().endsWith('.zip')) {
          let isExport = false; try { isExport = new ZipReader(fs.readFileSync(p)).names().some(n => n.endsWith('conversations.json')); } catch {}
          msgs.push(summarizeResult(isExport ? bank.bankChats(chats.readExport(p), { origin: 'claude.ai export' }, progress) : bank.bankBundle(p, progress), path.basename(p)));
        } else if (p.toLowerCase().endsWith('conversations.json')) msgs.push(summarizeResult(bank.bankChats(chats.readExport(p), { origin: 'claude.ai export' }, progress), path.basename(p)));
        else if (p.toLowerCase().endsWith('.jsonl')) {
          const cliId = path.basename(p, '.jsonl');
          const r = bank.bankSession({ cliId, transcript: p, extraDir: path.join(path.dirname(p), cliId), origin: 'file:' + p });
          msgs.push(`${path.basename(p)}: ${r.status}`);
        } else msgs.push(`${path.basename(p)}: not a folder, .zip or .jsonl`);
      } catch (e) { msgs.push(`${p}: ${e.message}`); }
    }
    return { message: msgs.join(' · ') };
  },
  chatsExport(progress, file) {
    const list = chats.readExport(file);
    const res = bank.bankChats(list, { origin: 'claude.ai export' }, progress);
    return { ...res, message: summarizeResult(res, `${list.length} chats from export`) };
  },
  async chatsSync(progress, opts) {
    const cfg = bank.loadConfig();
    const key = (opts && opts.sessionKey) || cfg.sessionKey;
    if (!key) return { error: 'No session key. Paste the sessionKey cookie from a signed-in claude.ai browser tab in Settings.' };
    try {
      const r = await chats.fetchLive(key, { onProgress: progress, since: opts && opts.all ? 0 : cfg.chatsLastSync, orgId: cfg.chatsOrg || null });
      const res = bank.bankChats(r.chats, { origin: 'claude.ai:' + (r.org.name || r.org.uuid) }, progress);
      const c2 = bank.loadConfig(); c2.chatsLastSync = Date.now(); c2.chatsOrg = r.org.uuid; if (opts && opts.sessionKey) c2.sessionKey = opts.sessionKey; bank.saveConfig(c2);
      return { ...res, message: summarizeResult(res, `claude.ai chats (${r.total} in Recents)`) };
    } catch (e) { return { error: e.message }; }
  },
  ensureBanked(progress, ids) {
    const live = liveSessions();
    for (const id of ids) if (!bank.has(id)) { const s = live.find(x => x.cliId === id); if (s) { progress('Banking ' + s.title); bankLiveOne(s); } }
    return true;
  },
  importTo(progress, ids, opts) { ops.ensureBanked(progress, ids); return bank.importToAccount(ids, opts, progress); },
  exportOne(progress, cliId, fmt) {
    const { buf, meta } = transcriptFor({ cliId });
    const data = fmt === 'md' ? toMarkdown(buf, meta) : fmt === 'html' ? toHtml(buf, meta) : buf;
    return { title: meta.title, data: Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8') };
  },
  exportBundle(progress, ids, file) { ops.ensureBanked(progress, ids); progress('Writing bundle…'); return bank.exportBundle(ids, file); },
  handoff(progress, cliId) { const { buf, meta } = transcriptFor({ cliId }); return buildHandoff(buf, { title: meta.title, cwd: meta.cwd, cliId }); },
  secrets(progress, cliId) { return scanSecrets(transcriptFor({ cliId }).buf); },
  remove(progress, ids) { let n = 0; for (const id of ids) if (bank.remove(id)) n++; return { removed: n }; },
  // Put a banked transcript where the CLI looks for it under `dir`, so `claude --resume` finds it.
  prepareResume(progress, cliId, dir) {
    const m = bank.meta(cliId);
    if (!m) throw new Error('Not banked and not on this PC');
    const t = C.remapTranscript(bank.transcript(cliId), m.cwd, dir);
    const dst = path.join(C.projectsRoot(), C.cwdSlug(dir), `${cliId}.jsonl`);
    if (fs.existsSync(dst)) C.writeFile(dst, C.mergeTranscripts(fs.readFileSync(dst), t).data); else C.writeFile(dst, t);
    for (const f of bank.extraFiles(cliId)) { const p = path.join(C.projectsRoot(), C.cwdSlug(dir), cliId, f.rel); if (!fs.existsSync(p)) C.writeFile(p, f.buf); }
    return true;
  },
  liveTranscript(progress, cliId) { const s = liveSessions().find(x => x.cliId === cliId && x.hasTranscript); return s && fs.existsSync(s.transcript) ? { cwd: s.cwd } : null; },
  bankMeta(progress, cliId) { return bank.meta(cliId); },
  config(progress, patch) { const cfg = bank.loadConfig(); if (patch) { Object.assign(cfg, patch); bank.saveConfig(cfg); } return cfg; },
  backups() { return C.listBackups(); },
  restore(progress, p) { return C.restoreBackup(p); },
  autoBank(progress) { const r = bank.bankLive({ onlyChanged: true }, progress); return (r.added || r.merged) ? summarizeResult(r, 'Auto bank') : null; },
};

module.exports = { ops, liveSessions, summarizeResult };
