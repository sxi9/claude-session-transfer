'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, nativeTheme } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Worker } = require('worker_threads');

let win = null;
let autoTimer = null;

// Startup diagnostics: anything that goes wrong before the window shows is written to
// <userData>/startup.log and shown in a dialog, instead of the app silently doing nothing.
function logLine(msg) {
  try { fs.mkdirSync(app.getPath('userData'), { recursive: true }); fs.appendFileSync(path.join(app.getPath('userData'), 'startup.log'), `${new Date().toISOString()} ${msg}\n`); } catch {}
}
process.on('uncaughtException', (e) => {
  logLine('uncaughtException ' + (e && e.stack || e));
  try { dialog.showErrorBox('Context Bank could not start', String(e && e.stack || e) + '\n\nLog: ' + path.join(app.getPath('userData'), 'startup.log')); } catch {}
});
// The UI is plain HTML; GPU compositing only adds ways for a frameless window to come up blank.
app.disableHardwareAcceleration();
if (!app.requestSingleInstanceLock()) app.quit();
else app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });

// ---------------------------------------------------------------- worker pool
// Nothing heavy runs on this thread. "fast" serves reads (lists, search, open a session);
// "slow" serves banking, imports and exports, so a long bank never freezes the window.
class Lane {
  constructor(name) { this.name = name; this.pending = new Map(); this.seq = 0; this.spawn(); }
  spawn() {
    this.worker = new Worker(path.join(__dirname, 'lib', 'worker.js'));
    this.worker.on('message', (m) => {
      const p = this.pending.get(m.id);
      if (!p) return;
      if ('progress' in m) { progress(m.progress); return; }
      this.pending.delete(m.id);
      if ('error' in m) p.reject(new Error(m.error)); else p.resolve(m.result);
    });
    this.worker.on('error', (e) => { logLine(`${this.name} worker error ${e && e.stack || e}`); for (const p of this.pending.values()) p.reject(e); this.pending.clear(); this.spawn(); });
    this.worker.on('exit', (code) => { if (code !== 0) logLine(`${this.name} worker exited ${code}`); });
  }
  call(op, ...args) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, op, args });
    });
  }
}
let fast, slow;
const F = (op, ...a) => fast.call(op, ...a);
const S = (op, ...a) => slow.call(op, ...a);

function send(ch, payload) { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); }
const progress = (text) => send('progress', text);

function createWindow() {
  const dark = nativeTheme.shouldUseDarkColors;
  // Transparency is only used on macOS. On Windows a transparent frameless window can stay
  // invisible and never report ready-to-show, which looks like the app not opening at all.
  const transparent = process.platform === 'darwin';
  win = new BrowserWindow({
    width: 1380, height: 860, minWidth: 900, minHeight: 560,
    frame: false, transparent, hasShadow: true,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    backgroundColor: transparent ? '#00000000' : (dark ? '#0f1115' : '#f6f7f9'),
    show: true, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false, spellcheck: false },
  });
  win.setMenuBarVisibility(false);
  logLine(`window created platform=${process.platform} electron=${process.versions.electron} transparent=${transparent}`);
  win.webContents.on('did-fail-load', (_e, code, desc) => logLine(`did-fail-load ${code} ${desc}`));
  win.webContents.on('render-process-gone', (_e, d) => logLine('render-process-gone ' + JSON.stringify(d)));
  win.loadFile(path.join(__dirname, 'renderer', 'index.html')).catch(e => logLine('loadFile failed ' + e));
  setTimeout(() => { if (win && !win.isDestroyed() && !win.isVisible()) { logLine('window still hidden after 3s, forcing show'); win.show(); } }, 3000);
  win.once('ready-to-show', () => {
    logLine('ready-to-show');
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
    }, 4000);
  });
  win.on('maximize', () => send('refresh', { maximized: true }));
  win.on('unmaximize', () => send('refresh', { maximized: false }));
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
}

// ---------------------------------------------------------------- reads
ipcMain.handle('state', () => F('state', { maximized: win ? win.isMaximized() : false }));
ipcMain.handle('live:list', () => F('live'));
ipcMain.handle('bank:list', () => F('list'));
ipcMain.handle('bank:search', (_e, q, opts) => F('search', q, opts));
ipcMain.handle('session:get', (_e, ref) => F('session', ref));
ipcMain.handle('config', (_e, patch) => F('config', patch).then(cfg => { if (patch) scheduleAuto(); return cfg; }));
ipcMain.handle('backups:list', () => F('backups'));
ipcMain.handle('handoff', async (_e, cliId, copy) => { const text = await F('handoff', cliId); if (copy) clipboard.writeText(text); return text; });
ipcMain.handle('secrets', (_e, cliId) => F('secrets', cliId));

// ---------------------------------------------------------------- banking (slow lane)
let busy = false;
async function heavy(label, fn) {
  if (busy) return { message: 'Still working on the previous job, try again in a moment.', busy: true };
  busy = true; progress(label);
  try { const r = await fn(); if (r && r.message) progress(r.message); return r; }
  catch (e) { progress('Failed: ' + e.message); return { error: e.message, message: 'Failed: ' + e.message }; }
  finally { busy = false; }
}
ipcMain.handle('bank:all', () => heavy('Banking every session on this PC…', () => S('bankAll')));
ipcMain.handle('bank:one', (_e, refs) => heavy('Banking selected…', () => S('bankOne', refs)));
ipcMain.handle('bank:folder', async (_e, folder) => {
  if (!folder) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a .claude folder, a projects folder, or a claude-code-sessions store', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths.length) return null;
    folder = r.filePaths[0];
  }
  return heavy('Scanning ' + folder, () => S('bankFolder', folder));
});
ipcMain.handle('bank:bundle', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick a session bundle (.zip)', properties: ['openFile'], filters: [{ name: 'Bundle', extensions: ['zip'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    file = r.filePaths[0];
  }
  return heavy('Reading ' + path.basename(file), () => S('bankBundle', file));
});
ipcMain.handle('bank:paths', (_e, paths) => heavy(`Adding ${(paths || []).length} item(s)…`, () => S('bankPaths', paths)));
ipcMain.handle('chats:export', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Pick the claude.ai data export (.zip) or its conversations.json', properties: ['openFile'], filters: [{ name: 'Export', extensions: ['zip', 'json'] }] });
    if (r.canceled || !r.filePaths.length) return null;
    file = r.filePaths[0];
  }
  return heavy('Reading ' + path.basename(file), () => S('chatsExport', file));
});
ipcMain.handle('chats:sync', (_e, opts) => heavy('Syncing Recents from claude.ai…', () => S('chatsSync', opts)));
ipcMain.handle('open:url', (_e, url) => { if (/^https:\/\/claude\.ai\//.test(url)) shell.openExternal(url); });
ipcMain.handle('bank:remove', async (_e, ids) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Move to trash', 'Cancel'], defaultId: 1, cancelId: 1,
    message: `Remove ${ids.length} session(s) from the bank?`, detail: 'They go to the bank\'s trash folder. Live copies in Claude are not touched.' });
  if (r.response !== 0) return { removed: 0 };
  return S('remove', ids);
});

// ---------------------------------------------------------------- import / take over
ipcMain.handle('import', async (_e, ids, opts) => {
  if (!opts.dryRun && !opts.force) {
    const st = await F('state');
    if (st.claudeRunning) {
      const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Import anyway', 'Cancel'], defaultId: 1, cancelId: 1,
        message: 'Claude Desktop is running', detail: 'It may overwrite the session list while it is open. Close it first for a clean import, or import anyway and restart Claude afterwards.' });
      if (r.response !== 0) return { cancelled: true, log: ['Cancelled: Claude Desktop is running'], installed: [] };
    }
  }
  const res = await heavy(opts.dryRun ? 'Dry run…' : 'Importing…', () => S('importTo', ids, opts));
  if (res.error) return { log: [res.message], installed: [] };
  progress(`${opts.dryRun ? 'Dry run' : 'Imported'} ${res.installed.length || ids.length} session(s) into ${opts.accountId.slice(0, 8)}…`);
  return res;
});

async function savePath(defaultName, filters) {
  const r = await dialog.showSaveDialog(win, { defaultPath: path.join(app.getPath('downloads'), defaultName), filters });
  return r.canceled ? null : r.filePath;
}
const safeName = s => String(s || 'session').replace(/[^A-Za-z0-9._ -]+/g, '_').slice(0, 60).trim() || 'session';
const stamp = () => new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');

ipcMain.handle('export:one', async (_e, cliId, fmt) => {
  const meta = await F('bankMeta', cliId);
  const ext = fmt === 'md' ? 'md' : fmt === 'html' ? 'html' : 'jsonl';
  const file = await savePath(`${safeName(meta ? meta.title : cliId)}.${ext}`, [{ name: ext.toUpperCase(), extensions: [ext] }]);
  if (!file) return null;
  const r = await S('exportOne', cliId, fmt);
  fs.writeFileSync(file, Buffer.from(r.data));
  return file;
});
ipcMain.handle('export:bundle', async (_e, ids) => {
  const file = await savePath(`context-bank-${os.hostname()}-${stamp()}.zip`, [{ name: 'Bundle', extensions: ['zip'] }]);
  if (!file) return null;
  const r = await heavy('Exporting bundle…', () => S('exportBundle', ids, file));
  if (!r.error) progress(`Bundle written: ${file} (${r.sizeKB} KB, ${r.sessions} sessions)`);
  return r;
});

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
  const live = await F('liveTranscript', cliId);
  let dir = cwd;
  if (!live) {
    const m = await F('bankMeta', cliId);
    if (!m) return { ok: false, message: 'Not banked and not on this PC' };
    dir = cwd || m.cwd;
    if (!dir || !fs.existsSync(dir)) {
      const r = await dialog.showOpenDialog(win, { title: `Pick the folder to continue "${m.title}" in (original: ${m.cwd || 'unknown'})`, properties: ['openDirectory'] });
      if (r.canceled || !r.filePaths.length) return { ok: false, message: 'Cancelled' };
      dir = r.filePaths[0];
    }
    await S('prepareResume', cliId, dir);
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
ipcMain.handle('open:bank', async () => { const st = await F('state'); fs.mkdirSync(st.paths.bank, { recursive: true }); shell.openPath(st.paths.bank); });
ipcMain.handle('pick:folder', async () => { const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] }); return r.canceled ? null : r.filePaths[0]; });
ipcMain.handle('backups:restore', async (_e, p) => {
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: ['Restore', 'Cancel'], defaultId: 1, cancelId: 1, message: 'Restore this backup?', detail: 'The current device folder is backed up first, then replaced.' });
  if (r.response !== 0) return ['Cancelled'];
  return S('restore', p);
});
ipcMain.handle('win', (_e, op) => {
  if (!win) return;
  if (op === 'min') win.minimize();
  else if (op === 'max') win.isMaximized() ? win.unmaximize() : win.maximize();
  else if (op === 'close') win.close();
  return win.isMaximized();
});

// ---------------------------------------------------------------- auto bank
async function scheduleAuto() {
  if (autoTimer) clearInterval(autoTimer);
  const cfg = await F('config');
  if (!cfg.autoBank) return;
  const ms = Math.max(1, Number(cfg.autoBankMinutes) || 5) * 60 * 1000;
  autoTimer = setInterval(async () => {
    if (busy) return;
    const r = await heavy('Auto bank…', () => S('autoBank'));
    if (r && typeof r === 'string') send('refresh', { auto: r });
  }, ms);
}

app.whenReady().then(() => {
  fast = new Lane('fast'); slow = new Lane('slow');
  createWindow();
  scheduleAuto();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
