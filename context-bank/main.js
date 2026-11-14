'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const C = require('./lib/claude');
const bank = require('./lib/bank');
const { buildHandoff } = require('./lib/handoff');
const { toMarkdown, toHtml } = require('./lib/exporters');
const { scanSecrets } = require('./lib/secrets');
const chats = require('./lib/chats');

let win = null;
let autoTimer = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 900, minHeight: 560,
    frame: false, transparent: process.platform !== 'linux', hasShadow: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: process.platform === 'linux' ? (nativeTheme.shouldUseDarkColors ? '#0f1115' : '#f6f7f9') : '#00000000',
    show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.once('ready-to-show', () => {
    win.show();
    if (process.env.CONTEXT_BANK_SHOT) setTimeout(async () => {
      // dev aid: open the first session (and run a search if CONTEXT_BANK_SHOT_QUERY is set), capture, quit
      try {
        const q = process.env.CONTEXT_BANK_SHOT_QUERY || '';
        await win.webContents.executeJavaScript(`(async()=>{const r=document.querySelector('.row');if(r){r.click();await new Promise(x=>setTimeout(x,1500));}
          if(${JSON.stringify(q)}){const i=document.querySelector('#q');i.value=${JSON.stringify(q)};i.dispatchEvent(new Event('input'));await new Promise(x=>setTimeout(x,900));}})()`);
        const img = await win.webContents.capturePage(); fs.writeFileSync(process.env.CONTEXT_BANK_SHOT, img.toPNG());
      } catch (e) { console.error(e); }
      app.quit();
    }, 2500);
  });
  win.on('maximize', () => send('refresh', { maximized: true }));
  win.on('unmaximize', () => send('refresh', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
const progress = (text) => send('progress', text);

// ---------------------------------------------------------------- state
function liveSessions() {
  const d = C.discoverAll();
  const cfg = bank.loadConfig();
  const out = [];
  for (const a of d.accounts) for (const s of a.sessions) out.push({ ...s, banked: bank.has(s.cliId), label: cfg.labels[a.id] || '' });
  for (const s of d.orphans) out.push({ ...s, banked: bank.has(s.cliId), label: '' });
  return out;
}

ipcMain.handle('state', () => {
  const d = C.discoverAll();
  const cfg = bank.loadConfig();
  return {
    accounts: d.accounts.map(a => ({ id: a.id, label: cfg.labels[a.id] || '', devices: a.devices, sessions: a.sessions.length, current: a.id === d.currentAccount })),
    orphans: d.orphans.length, currentAccount: d.currentAccount, deviceHint: d.deviceHint, bankCount: bank.list().length, chatCount: bank.list().filter(m => m.chat).length,
    config: cfg, claudeRunning: C.claudeAppRunning(), platform: process.platform, hostname: os.hostname(),
    paths: { bank: bank.bankRoot(), sessions: C.sessionsRoot(), projects: C.projectsRoot(), backups: C.backupsRoot() },
    maximized: win ? win.isMaximized() : false,
  };
});
ipcMain.handle('live:list', () => liveSessions());
ipcMain.handle('bank:list', () => bank.list());
ipcMain.handle('bank:search', (_e, q, opts) => bank.search(q, opts || {}));

function transcriptFor(ref) {
  if (ref.kind === 'bank' || bank.has(ref.cliId)) return { buf: bank.transcript(ref.cliId), meta: bank.meta(ref.cliId), banked: true };
  const live = liveSessions().find(s => s.cliId === ref.cliId);
  if (!live || !live.hasTranscript) throw new Error('Transcript not found');
  const buf = fs.readFileSync(live.transcript);
  const s = C.summarize(buf);
  return { buf, banked: false, meta: { ...live, ...s, files: s.files, firstUser: s.firstUser, lastAssistant: s.lastAssistant } };
}

ipcMain.handle('session:get', (_e, ref) => {
  const { buf, meta, banked } = transcriptFor(ref);
  const turns = C.conversation(buf, { rich: true }).map(t => ({
    ...t, blocks: t.blocks.map(b => b.type === 'tool_use' ? { ...b, input: JSON.stringify(b.input || {}, null, 1).slice(0, 4000) }
      : b.type === 'tool_result' ? { ...b, text: (b.text || '').slice(0, 4000) } : b),
  }));
  return { meta: { ...meta, banked, cwdExists: !!meta.cwd && fs.existsSync(meta.cwd) }, turns, lines: buf.toString('utf8').split('\n').length - 1 };
});

// ---------------------------------------------------------------- banking
function summarizeResult(r, what) {
  return `${what}: ${r.added} new, ${r.merged} updated, ${r.unchanged} unchanged, ${r.skipped} skipped` + (r.scanned != null ? ` (${r.scanned} found)` : '');
}
ipcMain.handle('bank:all', () => { progress('Banking every session on this PC…'); const r = bank.bankLive({ onlyChanged: true }); const msg = summarizeResult(r, 'Bank everything'); progress(msg); return { ...r, message: msg }; });
ipcMain.handle('bank:one', (_e, refs) => {
  const live = liveSessions();
  const out = { added: 0, merged: 0, unchanged: 0, skipped: 0, items: [] };
  for (const ref of refs) {
    const s = live.find(x => x.cliId === ref.cliId);
    if (!s) { out.skipped++; continue; }
    const r = bank.bankSession({ cliId: s.cliId, transcript: s.transcript, extraDir: s.extraDir, record: s.recordFile ? C.readJson(s.recordFile) : null,
      account: s.account, device: s.device, origin: `${os.hostname()}:${s.account || 'orphan'}/${s.device || ''}`, memoryDir: path.join(path.dirname(s.transcript), 'memory') });
    out[r.status === 'skip' ? 'skipped' : r.status]++;
  }
  return { ...out, message: summarizeResult(out, 'Bank selected') };
});
ipcMain.handle('bank:folder', async (_e, folder) => {
  if (!folder) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a .claude folder, a projects folder, or a claude-code-sessions store', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    folder = r.filePaths[0];
  }
  progress('Scanning ' + folder);
  const res = bank.bankFolder(folder);
  const msg = summarizeResult(res, 'Folder ' + path.basename(folder));
  progress(msg);
  return { ...res, message: res.scanned ? msg : `No sessions found in ${folder}. Give it a .claude folder, its projects folder, or a claude-code-sessions store.` };
});
ipcMain.handle('bank:bundle', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a session bundle (.zip)', properties: ['openFile'], filters: [{ name: 'Bundle', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    file = r.filePaths[0];
  }
  const res = bank.bankBundle(file);
  const msg = summarizeResult(res, 'Bundle ' + path.basename(file));
  progress(msg);
  return { ...res, message: msg };
});
ipcMain.handle('bank:paths', (_e, paths) => {
  const msgs = [];
  for (const p of paths || []) {
    try {
      const st = fs.statSync(p);
      if (st.isDirectory()) msgs.push(summarizeResult(bank.bankFolder(p), path.basename(p)));
      else if (p.toLowerCase().endsWith('.zip')) {
        let isExport = false; try { isExport = new (require('./lib/zip').ZipReader)(fs.readFileSync(p)).names().some(n => n.endsWith('conversations.json')); } catch {}
        msgs.push(summarizeResult(isExport ? bank.bankChats(chats.readExport(p), { origin: 'claude.ai export' }) : bank.bankBundle(p), path.basename(p)));
      } else if (p.toLowerCase().endsWith('conversations.json')) msgs.push(summarizeResult(bank.bankChats(chats.readExport(p), { origin: 'claude.ai export' }), path.basename(p)));
      else if (p.toLowerCase().endsWith('.jsonl')) {
        const cliId = path.basename(p, '.jsonl');
        const r = bank.bankSession({ cliId, transcript: p, extraDir: path.join(path.dirname(p), cliId), origin: 'file:' + p });
        msgs.push(`${path.basename(p)}: ${r.status}`);
      } else msgs.push(`${path.basename(p)}: not a folder, .zip or .jsonl`);
    } catch (e) { msgs.push(`${p}: ${e.message}`); }
  }
  const message = msgs.join(' · ');
  progress(message);
  return { message };
});
ipcMain.handle('chats:export', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick the claude.ai data export (.zip) or its conversations.json', properties: ['openFile'], filters: [{ name: 'Export', extensions: ['zip', 'json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    file = r.filePaths[0];
  }
  progress('Reading ' + path.basename(file));
  const list = chats.readExport(file);
  const res = bank.bankChats(list, { origin: 'claude.ai export' });
  const msg = summarizeResult(res, `${list.length} chats from export`);
  progress(msg);
  return { ...res, message: msg };
});
ipcMain.handle('chats:sync', async (_e, opts) => {
  const cfg = bank.loadConfig();
  const key = (opts && opts.sessionKey) || cfg.sessionKey;
  if (!key) return { error: 'No session key. Paste the sessionKey cookie from a signed-in claude.ai browser tab in Settings.' };
  try {
    const r = await chats.fetchLive(key, { onProgress: progress, since: opts && opts.all ? 0 : cfg.chatsLastSync, orgId: cfg.chatsOrg || null });
    const res = bank.bankChats(r.chats, { origin: 'claude.ai:' + (r.org.name || r.org.uuid) });
    const c2 = bank.loadConfig(); c2.chatsLastSync = Date.now(); c2.chatsOrg = r.org.uuid; if (opts && opts.sessionKey) c2.sessionKey = opts.sessionKey; bank.saveConfig(c2);
    const msg = summarizeResult(res, `claude.ai chats (${r.total} in Recents)`);
    progress(msg);
    return { ...res, message: msg };
  } catch (e) { progress('Sync failed: ' + e.message); return { error: e.message }; }
});
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\/claude\.ai\//.test(url)) shell.openExternal(url); });
ipcMain.handle('bank:remove', async (_e, ids) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to trash', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Remove ${ids.length} session(s) from the bank?`, detail: `They go to ${path.join(bank.bankRoot(), 'trash')}. Live copies in Claude are not touched.` });
  if (r.response !== 0) return { removed: 0 };
  let n = 0; for (const id of ids) if (bank.remove(id)) n++;
  return { removed: n };
});

// ---------------------------------------------------------------- import / take over
ipcMain.handle('import', async (_e, ids, opts) => {
  // anything not banked yet gets banked first, so the bank is always the source of truth
  const live = liveSessions();
  for (const id of ids) if (!bank.has(id)) {
    const s = live.find(x => x.cliId === id);
    if (s) bank.bankSession({ cliId: s.cliId, transcript: s.transcript, extraDir: s.extraDir, record: s.recordFile ? C.readJson(s.recordFile) : null, account: s.account, device: s.device });
  }
  if (!opts.dryRun && C.claudeAppRunning() && !opts.force) {
    const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Import anyway', 'Cancel'], defaultId: 1, cancelId: 1,
      message: 'Claude Desktop is running', detail: 'It may overwrite the session list while it is open. Close it first for a clean import, or import anyway and restart Claude afterwards.' });
    if (r.response !== 0) return { cancelled: true, log: ['Cancelled: Claude Desktop is running'] };
  }
  const res = bank.importToAccount(ids, opts);
  progress(`${opts.dryRun ? 'Dry run' : 'Imported'} ${res.installed.length || ids.length} session(s) into ${opts.accountId.slice(0, 8)}…`);
  return res;
});

async function savePath(defaultName, filters) {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), defaultName), filters });
  return r.canceled ? null : r.filePath;
}
const safeName = s => String(s || 'session').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 60).trim() || 'session';

ipcMain.handle('export:one', async (_e, cliId, fmt) => {
  const { buf, meta } = transcriptFor({ cliId });
  const ext = fmt === 'md' ? 'md' : fmt === 'html' ? 'html' : 'jsonl';
  const file = await savePath(`${safeName(meta.title)}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
  if (!file) return null;
  const data = fmt === 'md' ? toMarkdown(buf, meta) : fmt === 'html' ? toHtml(buf, meta) : buf;
  fs.writeFileSync(file, data);
  return file;
});
ipcMain.handle('export:bundle', async (_e, ids) => {
  const live = liveSessions();
  for (const id of ids) if (!bank.has(id)) { const s = live.find(x => x.cliId === id); if (s) bank.bankSession({ cliId: s.cliId, transcript: s.transcript, extraDir: s.extraDir, record: s.recordFile ? C.readJson(s.recordFile) : null, account: s.account, device: s.device }); }
  const file = await savePath(`context-bank-${os.hostname()}-${C.stamp()}.zip`, [{ name: 'Bundle', extensions: ['zip'] }]);
  if (!file) return null;
  const r = bank.exportBundle(ids, file);
  progress(`Bundle written: ${file} (${r.sizeKB} KB, ${r.sessions} sessions)`);
  return r;
});
ipcMain.handle('handoff', (_e, cliId, copy) => {
  const { buf, meta } = transcriptFor({ cliId });
  const text = buildHandoff(buf, { title: meta.title, cwd: meta.cwd, cliId });
  if (copy) clipboard.writeText(text);
  return text;
});
ipcMain.handle('secrets', (_e, cliId) => scanSecrets(transcriptFor({ cliId }).buf));

function openTerminal(cmd, cwd) {
  const dir = cwd && fs.existsSync(cwd) ? cwd : os.homedir();
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '"Claude"', 'cmd.exe', '/k', `cd /d "${dir}" && ${cmd}`], { detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    return 'Opened a command window';
  }
  if (process.platform === 'darwin') {
    const script = `tell application "Terminal" to do script "cd ${JSON.stringify(dir)} && ${cmd.replace(/"/g, '\\"')}"`;
    execFile('osascript', ['-e', script, '-e', 'tell application "Terminal" to activate']);
    return 'Opened Terminal';
  }
  const shellCmd = `cd ${JSON.stringify(dir)} && ${cmd}; exec $SHELL`;
  for (const [bin, args] of [['x-terminal-emulator', ['-e', 'bash', '-lc', shellCmd]], ['gnome-terminal', ['--', 'bash', '-lc', shellCmd]], ['konsole', ['-e', 'bash', '-lc', shellCmd]], ['xterm', ['-e', 'bash', '-lc', shellCmd]]]) {
    try { spawn(bin, args, { detached: true, stdio: 'ignore' }).unref(); return `Opened ${bin}`; } catch {}
  }
  clipboard.writeText(`cd ${JSON.stringify(dir)} && ${cmd}`);
  return 'No terminal found; the command was copied to the clipboard';
}

ipcMain.handle('resume', async (_e, cliId, cwd) => {
  // Make sure the transcript sits where the CLI looks for it, under the folder the session will run in.
  const live = liveSessions().find(s => s.cliId === cliId && s.hasTranscript);
  let dir = cwd;
  if (!live || !fs.existsSync(live.transcript)) {
    const m = bank.meta(cliId);
    if (!m) return { ok: false, message: 'Not banked and not on this PC' };
    dir = cwd || m.cwd;
    if (!dir || !fs.existsSync(dir)) {
      const r = await dialog.showOpenDialog(win, { title: `Pick the folder to continue "${m.title}" in (original: ${m.cwd || 'unknown'})`, properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false, message: 'Cancelled' };
      dir = r.filePaths[0];
    }
    const t = C.remapTranscript(bank.transcript(cliId), m.cwd, dir);
    const dst = path.join(C.projectsRoot(), C.cwdSlug(dir), `${cliId}.jsonl`);
    if (fs.existsSync(dst)) C.writeFile(dst, C.mergeTranscripts(fs.readFileSync(dst), t).data); else C.writeFile(dst, t);
    for (const f of bank.extraFiles(cliId)) { const p = path.join(C.projectsRoot(), C.cwdSlug(dir), cliId, f.rel); if (!fs.existsSync(p)) C.writeFile(p, f.buf); }
  } else dir = cwd || live.cwd;
  const msg = openTerminal(`claude --resume ${cliId}`, dir);
  return { ok: true, message: `${msg}: claude --resume ${cliId.slice(0, 8)}… in ${dir}` };
});

ipcMain.handle('open:claude', () => {
  try {
    if (process.platform === 'win32') {
      const exe = path.join(process.env.LOCALAPPDATA || '', 'AnthropicClaude', 'claude.exe');
      if (fs.existsSync(exe)) { spawn(exe, [], { detached: true, stdio: 'ignore' }).unref(); return 'Starting Claude Desktop'; }
      spawn('cmd.exe', ['/c', 'start', '', 'claude://'], { detached: true, stdio: 'ignore' }).unref(); return 'Asked Windows to open Claude';
    }
    if (process.platform === 'darwin') { execFile('open', ['-a', 'Claude']); return 'Starting Claude Desktop'; }
    shell.openExternal('claude://'); return 'Asked the desktop to open Claude';
  } catch (e) { return 'Could not start Claude: ' + e.message; }
});
ipcMain.handle('open:path', (_e, p) => { if (p && fs.existsSync(p)) { shell.showItemInFolder(p); return true; } return false; });
ipcMain.handle('open:bank', () => { fs.mkdirSync(bank.bankRoot(), { recursive: true }); shell.openPath(bank.bankRoot()); });
ipcMain.handle('pick:folder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('config', (_e, patch) => { const cfg = bank.loadConfig(); if (patch) { Object.assign(cfg, patch); bank.saveConfig(cfg); scheduleAuto(); } return cfg; });
ipcMain.handle('backups:list', () => C.listBackups());
ipcMain.handle('backups:restore', async (_e, p) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Restore this backup?', detail: 'The current device folder is backed up first, then replaced.' });
  if (r.response !== 0) return ['Cancelled'];
  return C.restoreBackup(p);
});
ipcMain.handle('win', (_e, op) => {
  if (!win) return;
  if (op === 'min') win.minimize();
  else if (op === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (op === 'close') win.close();
  return win.isMaximized();
});

// ---------------------------------------------------------------- auto bank
function scheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  const cfg = bank.loadConfig();
  if (!cfg.autoBank) return;
  const ms = Math.max(1, Number(cfg.autoBankMinutes) || 5) * 60 * 1000;
  autoTimer = setInterval(() => {
    try { const r = bank.bankLive({ onlyChanged: true }); if (r.added || r.merged) send('refresh', { auto: summarizeResult(r, 'Auto bank') }); }
    catch (e) { progress('Auto bank failed: ' + e.message); }
  }, ms);
}

app.whenReady().then(() => {
  createWindow();
  scheduleAuto();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
