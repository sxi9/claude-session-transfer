'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const call = (ch, ...args) => ipcRenderer.invoke(ch, ...args);

contextBridge.exposeInMainWorld('bank', {
  state: () => call('state'),
  live: () => call('live:list'),
  list: () => call('bank:list'),
  search: (q, opts) => call('bank:search', q, opts),
  session: (ref) => call('session:get', ref),
  bankAll: () => call('bank:all'),
  bankOne: (refs) => call('bank:one', refs),
  bankFolder: (folder) => call('bank:folder', folder),
  bankBundle: (file) => call('bank:bundle', file),
  bankPaths: (paths) => call('bank:paths', paths),
  remove: (ids) => call('bank:remove', ids),
  chatsExport: (file) => call('chats:export', file),
  chatsSync: (opts) => call('chats:sync', opts),
  openUrl: (u) => call('open:url', u),
  importTo: (ids, opts) => call('import', ids, opts),
  exportOne: (cliId, fmt) => call('export:one', cliId, fmt),
  exportBundle: (ids) => call('export:bundle', ids),
  handoff: (cliId, copy) => call('handoff', cliId, copy),
  secrets: (cliId) => call('secrets', cliId),
  resume: (cliId, cwd) => call('resume', cliId, cwd),
  openClaude: () => call('open:claude'),
  openPath: (p) => call('open:path', p),
  openBank: () => call('open:bank'),
  pickFolder: () => call('pick:folder'),
  config: (patch) => call('config', patch),
  backups: () => call('backups:list'),
  restore: (p) => call('backups:restore', p),
  win: (op) => call('win', op),
  pathOf: (file) => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  onProgress: (fn) => { ipcRenderer.on('progress', (_e, msg) => fn(msg)); },
  onRefresh: (fn) => { ipcRenderer.on('refresh', (_e, info) => fn(info)); },
});
