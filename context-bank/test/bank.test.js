'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-'));
process.env.CLAUDE_APP_DIR = path.join(tmp, 'app');
process.env.CLAUDE_HOME_DIR = path.join(tmp, 'home');
process.env.CONTEXT_BANK_DIR = path.join(tmp, 'bank');

const C = require('../lib/claude');
const bank = require('../lib/bank');
const { buildHandoff } = require('../lib/handoff');
const { toMarkdown, toHtml } = require('../lib/exporters');
const { scanSecrets } = require('../lib/secrets');
const { ZipWriter, ZipReader } = require('../lib/zip');

const CWD = process.platform === 'win32' ? 'D:\\physical_ai' : '/home/me/physical_ai';
const CLI = '11111111-2222-3333-4444-555555555555';
const ACC = 'acc-aaaa', DEV = 'dev-bbbb';
const line = (o) => JSON.stringify(o);
function transcript(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(line({ uuid: 'u' + i, type: 'user', cwd: CWD, gitBranch: 'main', timestamp: `2026-01-0${1 + (i % 9)}T10:0${i % 10}:00Z`, message: { role: 'user', content: `please build feature ${i} with widgets${i === 1 ? ' pineapple' : ''}` } }));
    out.push(line({ uuid: 'a' + i, type: 'assistant', cwd: CWD, timestamp: `2026-01-0${1 + (i % 9)}T10:0${i % 10}:30Z`, message: { role: 'assistant', model: 'claude-opus-5-5', content: [
      { type: 'text', text: `Done with feature ${i}. token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789` },
      { type: 'tool_use', id: 't' + i, name: 'Edit', input: { file_path: CWD + '/src/f' + i + '.js' } }] } }));
  }
  return Buffer.from(out.join('\n') + '\n');
}
function seedStore() {
  const devDir = path.join(C.sessionsRoot(), ACC, DEV);
  fs.mkdirSync(devDir, { recursive: true });
  const rec = { sessionId: 'local_abc', cliSessionId: CLI, cwd: CWD, title: 'Widget work', lastActivityAt: 1700000000000, createdAt: 1690000000000, model: 'claude-opus-5-5' };
  fs.writeFileSync(path.join(devDir, 'local_abc.json'), JSON.stringify(rec));
  C.writeFile(path.join(C.projectsRoot(), C.cwdSlug(CWD), CLI + '.jsonl'), transcript(3));
  C.writeFile(path.join(C.projectsRoot(), C.cwdSlug(CWD), CLI, 'custom-title.json'), JSON.stringify({ customTitle: 'Widget work' }));
  C.writeFile(path.join(C.projectsRoot(), C.cwdSlug(CWD), 'memory', 'MEMORY.md'), '# memory');
  // orphan transcript, no record
  C.writeFile(path.join(C.projectsRoot(), 'other-proj', 'orphan-0000.jsonl'), transcript(2));
  fs.writeFileSync(C.configFile(), JSON.stringify({ lastKnownAccountUuid: ACC, ['dxt:allowlistEnabled:' + DEV]: true }));
}

test('cwdSlug matches Claude Code', () => {
  assert.equal(C.cwdSlug('D:\\physical_ai'), 'D--physical-ai');
  assert.equal(C.cwdSlug('/home/user/trust-gain'), '-home-user-trust-gain');
});

test('zip round trip', () => {
  const z = new ZipWriter(); z.add('a/b.txt', 'hello'.repeat(100)); z.add('c.bin', Buffer.from([1, 2, 3]));
  const r = new ZipReader(z.toBuffer());
  assert.deepEqual(r.names().sort(), ['a/b.txt', 'c.bin']);
  assert.equal(r.read('a/b.txt').toString(), 'hello'.repeat(100));
  assert.deepEqual([...r.read('c.bin')], [1, 2, 3]);
});

test('discover, orphans, bank everything, search', () => {
  seedStore();
  const d = C.discoverAll();
  assert.equal(d.accounts.length, 1);
  assert.equal(d.accounts[0].sessions[0].cliId, CLI);
  assert.equal(d.orphans.length, 1);
  assert.equal(d.currentAccount, ACC);
  assert.equal(d.deviceHint, DEV);
  const r = bank.bankLive();
  assert.equal(r.added, 2);
  const again = bank.bankLive();
  assert.equal(again.unchanged, 2);
  const all = bank.list();
  assert.equal(all.length, 2);
  const m = bank.meta(CLI);
  assert.equal(m.title, 'Widget work');
  assert.equal(m.userTurns, 3);
  assert.equal(m.files.length, 3);
  assert.ok(fs.existsSync(path.join(bank.bankRoot(), 'memory', C.cwdSlug(CWD), 'MEMORY.md')));
  assert.equal(bank.search('widget').length, 2);
  assert.equal(bank.search('feature 2').length, 2);
  assert.equal(bank.search('pineapple').length, 2);
  assert.equal(bank.search('pineapple', { content: false }).length, 0);
  assert.equal(bank.search('nonexistentzzz').length, 0);
});

test('merge keeps old lines and adds new', () => {
  const r = bank.bankSession({ cliId: CLI, transcriptBuf: transcript(5) });
  assert.equal(r.status, 'merged'); assert.equal(r.added, 4);
  assert.equal(bank.meta(CLI).userTurns, 5);
});

test('handoff, exports, secrets', () => {
  const t = bank.transcript(CLI);
  const h = buildHandoff(t, bank.meta(CLI));
  assert.match(h, /Continue this session: Widget work/);
  assert.match(h, /claude --resume 11111111/);
  assert.match(h, /src\/f4\.js/);
  assert.match(toMarkdown(t, bank.meta(CLI)), /\*\*Claude\*\*/);
  assert.match(toHtml(t, bank.meta(CLI)), /<div class="m a">/);
  const hits = scanSecrets(t);
  assert.ok(hits.some(x => x.kind === 'Anthropic API key'));
});

test('bundle export + import to a second account + merge on re-import', () => {
  const out = path.join(tmp, 'b.zip');
  const e = bank.exportBundle([CLI], out);
  assert.equal(e.sessions, 1); assert.equal(e.memory, 1);
  const rr = bank.bankBundle(out);
  assert.equal(rr.unchanged, 1);
  const NEW_CWD = process.platform === 'win32' ? 'E:\\moved' : '/srv/moved';
  const res = bank.importToAccount([CLI], { accountId: 'acc-new', deviceId: DEV, cwdMap: { [CWD]: NEW_CWD }, newId: true });
  assert.equal(res.installed.length, 1);
  const rec = JSON.parse(fs.readFileSync(res.installed[0].recordPath, 'utf8'));
  assert.equal(rec.cwd, NEW_CWD); assert.notEqual(rec.sessionId, 'local_abc');
  const tp = path.join(C.projectsRoot(), C.cwdSlug(NEW_CWD), CLI + '.jsonl');
  assert.ok(fs.existsSync(tp));
  assert.ok(fs.readFileSync(tp, 'utf8').includes(JSON.stringify(NEW_CWD)));
  assert.ok(fs.existsSync(path.join(C.projectsRoot(), C.cwdSlug(NEW_CWD), 'memory', 'MEMORY.md')));
  // importing into the original account merges (no duplicate lines)
  const res2 = bank.importToAccount([CLI], { accountId: ACC, deviceId: DEV });
  assert.ok(res2.log.some(l => /MERGE transcript \(\+4 lines\)/.test(l)), res2.log.join('\n'));
  const lines = fs.readFileSync(path.join(C.projectsRoot(), C.cwdSlug(CWD), CLI + '.jsonl'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 10);
  assert.ok(C.listBackups().length >= 1);
});

test('scanFolder on a copied .claude folder', () => {
  const copy = path.join(tmp, 'usb', '.claude');
  fs.cpSync(C.claudeHome(), copy, { recursive: true });
  const s = C.scanFolder(path.join(tmp, 'usb'));
  assert.equal(s.sources.length, 2, 'same cliId under two project folders counts once');
  const r = bank.bankFolder(copy);
  assert.equal(r.scanned, 2);
});

test('real transcript from this machine parses', { skip: !fs.existsSync('/root/.claude/projects') }, () => {
  const files = fs.readdirSync('/root/.claude/projects', { recursive: true }).filter(f => f.endsWith('.jsonl'));
  if (!files.length) return;
  const buf = fs.readFileSync(path.join('/root/.claude/projects', files[0]));
  const s = C.summarize(buf);
  assert.ok(s.cwd); assert.ok(s.userTurns >= 1);
  const conv = C.conversation(buf, { rich: true });
  assert.ok(conv.some(t => t.blocks.some(b => b.type === 'tool_use')));
});

test('claude.ai export: parse, bank as sessions, convert to transcript, import', () => {
  const chats = require('../lib/chats');
  const exp = [{ uuid: 'c0ffee00-0000-4000-8000-000000000001', name: 'Trip planning', created_at: '2026-05-01T10:00:00Z', updated_at: '2026-05-02T10:00:00Z', chat_messages: [
    { uuid: 'm1', sender: 'human', text: 'Plan a trip to Kyoto in autumn', content: [{ type: 'text', text: 'Plan a trip to Kyoto in autumn' }], created_at: '2026-05-01T10:00:00Z', attachments: [{ file_name: 'notes.txt', extracted_content: 'budget 2000' }] },
    { uuid: 'm2', sender: 'assistant', text: 'Here is a 5 day plan…', content: [{ type: 'text', text: 'Here is a 5 day plan…' }], created_at: '2026-05-01T10:01:00Z' }] },
    { uuid: 'c0ffee00-0000-4000-8000-000000000002', name: '', chat_messages: [] }];
  const file = path.join(tmp, 'conversations.json'); fs.writeFileSync(file, JSON.stringify(exp));
  const list = chats.readExport(file);
  assert.equal(list.length, 2); assert.equal(list[0].messages.length, 2); assert.match(list[0].messages[0].text, /budget 2000/);
  const zw = new ZipWriter(); zw.add('conversations.json', JSON.stringify(exp)); zw.add('users.json', '[]'); zw.writeFile(path.join(tmp, 'export.zip'));
  assert.equal(chats.readExport(path.join(tmp, 'export.zip')).length, 2);
  const r = bank.bankChats(list, { cwd: CWD });
  assert.equal(r.added, 1); assert.equal(r.skipped, 1);
  const m = bank.meta(list[0].uuid);
  assert.equal(m.chat, true); assert.equal(m.title, 'Trip planning'); assert.equal(m.userTurns, 1); assert.equal(m.cwd, CWD);
  assert.equal(bank.search('kyoto').length, 1);
  assert.equal(bank.bankChats(list, { cwd: CWD }).unchanged, 1);
  const conv = C.conversation(bank.transcript(list[0].uuid));
  assert.equal(conv.length, 2); assert.equal(conv[1].role, 'assistant');
  const res = bank.importToAccount([list[0].uuid], { accountId: ACC, deviceId: DEV });
  assert.equal(res.installed.length, 1);
  assert.ok(fs.existsSync(path.join(C.projectsRoot(), C.cwdSlug(CWD), list[0].uuid + '.jsonl')));
  assert.match(buildHandoff(bank.transcript(list[0].uuid), m), /Kyoto/);
});
