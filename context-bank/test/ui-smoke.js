'use strict';
// Loads renderer/index.html in headless Chromium with window.bank backed by the real libraries
// (no Electron needed). Seeds a throwaway store, exercises search/open/import, saves screenshots.
const fs = require('fs'); const os = require('os'); const path = require('path');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-ui-'));
process.env.CLAUDE_APP_DIR = path.join(tmp, 'app'); process.env.CLAUDE_HOME_DIR = path.join(tmp, 'home'); process.env.CONTEXT_BANK_DIR = path.join(tmp, 'bank');
const C = require('../lib/claude'); const bank = require('../lib/bank'); const { buildHandoff } = require('../lib/handoff'); const { scanSecrets } = require('../lib/secrets');
const { chromium } = require('playwright');

const ACC = '0a1b2c3d-1111-2222-3333-444444444444', ACC2 = '9f8e7d6c-aaaa-bbbb-cccc-dddddddddddd', DEV = 'dev-9999-eeee';
const CWD = '/home/me/physical_ai';
function mk(cliId, n, cwd, extraText = '') {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(JSON.stringify({ uuid: cliId + 'u' + i, type: 'user', cwd, gitBranch: 'main', timestamp: `2026-03-${String(1 + i).padStart(2, '0')}T09:1${i % 10}:00Z`, message: { role: 'user', content: `Step ${i}: ${i === 2 ? extraText : ""} please refactor the ${['parser', 'router', 'db layer', 'auth'][i % 4]}` } }));
    out.push(JSON.stringify({ uuid: cliId + 'a' + i, type: 'assistant', cwd, timestamp: `2026-03-${String(1 + i).padStart(2, '0')}T09:1${i % 10}:30Z`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'thinking', thinking: 'Let me look at the code first.' },
      { type: 'tool_use', id: 't' + i, name: 'Read', input: { file_path: cwd + '/src/mod' + i + '.py' } },
      { type: 'text', text: `I refactored module ${i}.\n\n- extracted helpers\n- added tests\n\nNext I will wire it up.` }] } }));
    out.push(JSON.stringify({ uuid: cliId + 'r' + i, type: 'user', cwd, timestamp: `2026-03-0${1 + i}T09:1${i % 10}:31Z`, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't' + i, content: 'def main(): pass' }] } }));
  }
  return out.join('\n') + '\n';
}
const devDir = path.join(C.sessionsRoot(), ACC, DEV); fs.mkdirSync(devDir, { recursive: true });
fs.mkdirSync(path.join(C.sessionsRoot(), ACC2, DEV), { recursive: true });
const sessions = [['aaaa1111-0000-0000-0000-000000000001', 'Refactor the physical AI parser', 6, CWD, 'pineapple'], ['aaaa1111-0000-0000-0000-000000000002', 'Fix login bug', 3, '/home/me/webapp', ''], ['aaaa1111-0000-0000-0000-000000000003', 'Write docs for API', 2, CWD, '']];
for (const [id, title, n, cwd, x] of sessions) {
  fs.writeFileSync(path.join(devDir, `local_${id}.json`), JSON.stringify({ sessionId: 'local_' + id, cliSessionId: id, cwd, title, lastActivityAt: Date.parse('2026-03-0' + n + 'T10:00:00Z'), createdAt: 1700000000000, model: 'claude-opus-5-5' }));
  C.writeFile(path.join(C.projectsRoot(), C.cwdSlug(cwd), id + '.jsonl'), mk(id, n, cwd, x));
}
C.writeFile(path.join(C.projectsRoot(), 'orphan-proj', 'bbbb2222-0000-0000-0000-000000000009.jsonl'), mk('bbbb2222-0000-0000-0000-000000000009', 2, '/tmp/scratch', 'orphan'));
fs.writeFileSync(C.configFile(), JSON.stringify({ lastKnownAccountUuid: ACC }));
const chatsLib = require('../lib/chats');
bank.bankChats(chatsLib.normalize([{ uuid: 'c0ffee00-0000-4000-8000-00000000aaaa', name: 'Kyoto trip ideas', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-02T10:00:00Z', chat_messages: [
  { uuid: 'm1', sender: 'human', text: 'Plan a trip to Kyoto in autumn', created_at: '2026-05-01T10:00:00Z' }, { uuid: 'm2', sender: 'assistant', text: 'Day 1: Fushimi Inari at dawn…', created_at: '2026-05-01T10:01:00Z' }] }]), { cwd: '/home/me' });

const handlers = {
  'state': () => { const d = C.discoverAll(); const cfg = bank.loadConfig(); return { accounts: d.accounts.map(a => ({ id: a.id, label: cfg.labels[a.id] || '', devices: a.devices, sessions: a.sessions.length, current: a.id === d.currentAccount })), orphans: d.orphans.length, currentAccount: d.currentAccount, deviceHint: d.deviceHint, bankCount: bank.list().length, config: cfg, claudeRunning: false, platform: process.platform, hostname: os.hostname(), paths: { bank: bank.bankRoot(), sessions: C.sessionsRoot(), projects: C.projectsRoot(), backups: C.backupsRoot() }, maximized: false }; },
  'live:list': () => { const d = C.discoverAll(); const out = []; for (const a of d.accounts) for (const s of a.sessions) out.push({ ...s, banked: bank.has(s.cliId) }); for (const s of d.orphans) out.push({ ...s, banked: bank.has(s.cliId) }); return out; },
  'bank:list': () => bank.list(), 'bank:search': (q, o) => bank.search(q, o || {}),
  'session:get': (ref) => { const buf = bank.has(ref.cliId) ? bank.transcript(ref.cliId) : fs.readFileSync(handlers['live:list']().find(s => s.cliId === ref.cliId).transcript); const meta = bank.has(ref.cliId) ? bank.meta(ref.cliId) : { ...handlers['live:list']().find(s => s.cliId === ref.cliId), ...C.summarize(buf) }; return { meta: { ...meta, banked: bank.has(ref.cliId), cwdExists: fs.existsSync(meta.cwd || '') }, turns: C.conversation(buf, { rich: true }).map(t => ({ ...t, blocks: t.blocks.map(b => b.type === 'tool_use' ? { ...b, input: JSON.stringify(b.input) } : b) })), lines: 10 }; },
  'bank:all': () => { const r = bank.bankLive(); return { ...r, message: `Bank everything: ${r.added} new, ${r.merged} updated, ${r.unchanged} unchanged` }; },
  'bank:one': (refs) => { const live = handlers['live:list'](); let n = 0; for (const r of refs) { const s = live.find(x => x.cliId === r.cliId); if (s) { bank.bankSession({ cliId: s.cliId, transcript: s.transcript, record: s.recordFile ? C.readJson(s.recordFile) : null, account: s.account, device: s.device }); n++; } } return { message: `Banked ${n}` }; },
  'import': (ids, opts) => bank.importToAccount(ids, opts), 'handoff': (id) => buildHandoff(bank.transcript(id), bank.meta(id)), 'secrets': (id) => scanSecrets(bank.transcript(id)),
  'config': (patch) => { const cfg = bank.loadConfig(); if (patch) { Object.assign(cfg, patch); bank.saveConfig(cfg); } return cfg; }, 'backups:list': () => C.listBackups(), 'win': () => false,
  'open:url': () => {}, 'chats:export': () => null, 'chats:sync': () => ({ error: 'stub' }),
  'bank:remove': (ids) => ({ removed: ids.filter(i => bank.remove(i)).length }), 'export:bundle': (ids) => bank.exportBundle(ids, path.join(tmp, 'out.zip')), 'open:claude': () => 'stub', 'resume': () => ({ ok: true, message: 'stub' }),
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1380, height: 860 }, deviceScaleFactor: 1, colorScheme: process.argv[2] === 'light' ? 'light' : 'dark' });
  await page.exposeFunction('__ipc', (ch, ...args) => handlers[ch] ? handlers[ch](...args) : (() => { throw new Error('no handler ' + ch); })());
  await page.addInitScript(() => {
    const call = (ch, ...a) => window.__ipc(ch, ...a);
    window.bank = { state: () => call('state'), live: () => call('live:list'), list: () => call('bank:list'), search: (q, o) => call('bank:search', q, o), session: r => call('session:get', r), bankAll: () => call('bank:all'), bankOne: r => call('bank:one', r), bankFolder: () => null, bankBundle: () => null, bankPaths: () => ({ message: 'stub' }), remove: ids => call('bank:remove', ids), chatsExport: () => call('chats:export'), chatsSync: o => call('chats:sync', o), openUrl: u => call('open:url', u), importTo: (ids, o) => call('import', ids, o), exportOne: () => null, exportBundle: ids => call('export:bundle', ids), handoff: id => call('handoff', id), secrets: id => call('secrets', id), resume: (a, b) => call('resume', a, b), openClaude: () => call('open:claude'), openPath: () => true, openBank: () => {}, pickFolder: () => null, config: p => call('config', p), backups: () => call('backups:list'), restore: () => ['stub'], win: op => call('win', op), pathOf: () => '', onProgress: () => {}, onRefresh: () => {} };
  });
  const errors = []; page.on('pageerror', e => errors.push(e.message)); page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto('file://' + path.join(__dirname, '..', 'renderer', 'index.html'));
  await page.waitForSelector('.row');
  await page.click('#bank-all'); await page.waitForFunction(() => document.querySelectorAll('.pill.ok').length >= 5);
  const check = async (cond, msg) => { if (!(await cond())) throw new Error('FAIL: ' + msg); console.log('ok  ' + msg); };
  await check(async () => (await page.$$('.row')).length === 5, '5 listed (3 account sessions + 1 orphan + 1 claude.ai chat)');
  await check(async () => (await page.$$('.pill.ok')).length === 5, 'all banked after Bank everything');
  await page.click('.nav[data-scope=chats]'); await page.waitForTimeout(200);
  await check(async () => (await page.$$('.row')).length === 1, 'chats scope shows the chat');
  await page.click('.row >> nth=0'); await page.waitForSelector('.turn');
  await check(async () => !(await page.$eval('#d-open-chat', e => e.classList.contains('hidden'))), 'Open on claude.ai button shown for a chat');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), 'context-bank-chat.png') });
  await page.click('.nav[data-scope=all]'); await page.waitForTimeout(200);
  await page.click('.row >> nth=1'); await page.waitForSelector('details.tool');
  await check(async () => (await page.$$('.turn')).length >= 6, 'chat turns rendered');
  await check(async () => (await page.$$('details.tool')).length >= 6, 'tool calls shown');
  await page.fill('#q', 'pineapple'); await page.waitForTimeout(400);
  await check(async () => (await page.$$('.row')).length === 1, 'full-text search narrows to 1');
  await check(async () => (await page.$$('.row .snip mark')).length >= 1, 'snippet highlighted');
  await page.uncheck('#deep'); await page.waitForTimeout(300);
  await check(async () => (await page.$$('.row')).length === 0, 'title-only search misses body text');
  await page.check('#deep'); await page.fill('#q', ''); await page.waitForTimeout(400);
  await page.click('.row >> nth=0'); await page.waitForSelector('.turn');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), 'context-bank-' + (process.argv[2] || 'dark') + '.png') });
  await page.click('#d-import'); await page.waitForSelector('#m-import:not(.hidden)');
  await page.selectOption('#i-account', ACC2);
  await page.click('#i-dry'); await page.waitForFunction(() => document.querySelector('#i-log').textContent.includes('DRY'));
  await page.click('#i-go'); await page.waitForFunction(() => /LOAD|MERGE/.test(document.querySelector('#i-log').textContent));
  await check(async () => fs.readdirSync(path.join(C.sessionsRoot(), ACC2, DEV)).length === 1, 'record written into the second account');
  await page.screenshot({ path: path.join(process.env.SHOT_DIR || os.tmpdir(), 'context-bank-import.png') });
  await page.click('#i-cancel');
  await page.click('#d-handoff'); await page.waitForSelector('#m-text:not(.hidden)');
  await check(async () => (await page.textContent('#t-body')).includes('Continue this session'), 'handoff prompt shown');
  await page.click('#t-close');
  await page.click('#settings'); await page.waitForSelector('#m-settings:not(.hidden)');
  await check(async () => (await page.$$('#s-backups .bk')).length >= 1, 'backup listed after import');
  await page.click('#s-close');
  if (errors.length) { console.log('page errors:', errors); process.exit(1); }
  console.log('UI smoke passed'); await browser.close();
})().catch(e => { console.error(e); process.exit(1); });
