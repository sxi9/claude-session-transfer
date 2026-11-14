'use strict';
const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtDate = ms => ms ? new Date(ms).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const shortId = id => id ? id.slice(0, 8) + '…' : '';
const shortPath = p => { if (!p) return ''; const parts = p.split(/[\\/]/).filter(Boolean); return parts.length > 3 ? '…/' + parts.slice(-3).join('/') : p; };

const S = { state: null, sessions: [], shown: [], scope: 'all', account: null, query: '', deep: true, sort: 'recent', archived: false,
  sel: new Set(), active: null, detail: null, lastClick: null, searchTimer: null };

// ---------------------------------------------------------------- status
let flashTimer = null;
function status(text) { $('#status-text').textContent = text; $('#status').classList.add('flash'); clearTimeout(flashTimer); flashTimer = setTimeout(() => $('#status').classList.remove('flash'), 4000); }
window.bank.onProgress(status);
window.bank.onRefresh(info => { if (info.auto) { status(info.auto); refresh(); } if ('maximized' in info) $('#w-max').textContent = info.maximized ? '❐' : '□'; });

// ---------------------------------------------------------------- data
// One merged view: banked sessions plus live sessions on this PC, keyed by cliId.
async function loadAll() {
  const [state, live, banked] = await Promise.all([window.bank.state(), window.bank.live(), window.bank.list()]);
  S.state = state;
  const byId = new Map();
  for (const b of banked) byId.set(b.cliId, { ...b, banked: true, live: null });
  for (const l of live) {
    if (!l.cliId) continue;
    const e = byId.get(l.cliId);
    if (e) { e.live = l; if (!e.account && l.account) e.account = l.account; e.lastActivityMs = Math.max(e.lastActivityMs, l.lastActivityMs); e.liveAccounts = [...(e.liveAccounts || []), l.account].filter(Boolean); }
    else byId.set(l.cliId, { cliId: l.cliId, title: l.title, cwd: l.cwd, lastActivityMs: l.lastActivityMs, createdMs: l.createdMs, model: l.model, sizeKB: l.sizeKB,
      archived: l.archived, account: l.account, liveAccounts: l.account ? [l.account] : [], orphan: l.orphan, banked: false, live: l, hasTranscript: l.hasTranscript, userTurns: null });
  }
  S.sessions = [...byId.values()];
  renderRail();
  await applyFilter();
}

function renderRail() {
  const st = S.state;
  $('#n-all').textContent = S.sessions.length;
  $('#n-bank').textContent = S.sessions.filter(s => s.banked).length;
  $('#n-unbanked').textContent = S.sessions.filter(s => !s.banked && s.hasTranscript !== false).length;
  $('#n-chats').textContent = S.sessions.filter(s => s.chat).length;
  const acc = $('#accounts'); acc.innerHTML = '';
  for (const a of st.accounts) {
    const b = document.createElement('button'); b.className = 'nav' + (S.account === a.id ? ' active' : ''); b.dataset.account = a.id;
    b.innerHTML = `<span>${esc(a.label || shortId(a.id))}${a.current ? '<span class="badge">current</span>' : ''}</span><span class="n">${a.sessions}</span>`;
    b.title = a.id; acc.appendChild(b);
  }
  if (st.orphans) { const b = document.createElement('button'); b.className = 'nav' + (S.account === 'orphan' ? ' active' : ''); b.dataset.account = 'orphan'; b.innerHTML = `<span>No sidebar record</span><span class="n">${st.orphans}</span>`; b.title = 'Transcripts in ~/.claude/projects that no account lists'; acc.appendChild(b); }
  if (!st.accounts.length) acc.innerHTML = '<div class="hint">No Claude Desktop session store found on this PC.</div>';
  $('#bankpath').textContent = st.paths.bank;
  $('#status-claude').textContent = st.claudeRunning ? 'A Claude process is running: close Claude Desktop before importing' : '';
}

async function applyFilter() {
  let list = S.sessions;
  if (S.scope === 'bank') list = list.filter(s => s.banked);
  if (S.scope === 'unbanked') list = list.filter(s => !s.banked);
  if (S.scope === 'chats') list = list.filter(s => s.chat);
  if (S.account === 'orphan') list = list.filter(s => s.orphan || (s.live && s.live.orphan));
  else if (S.account) list = list.filter(s => (s.liveAccounts || []).includes(S.account) || s.account === S.account);
  if (!S.archived) list = list.filter(s => !s.archived);
  let snippets = new Map();
  if (S.query.trim()) {
    const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
    const hits = await window.bank.search(S.query, { content: S.deep });
    for (const h of hits) snippets.set(h.cliId, h.snippet);
    list = list.filter(s => snippets.has(s.cliId) || (!s.banked && words.every(w => `${s.title}\n${s.cwd}\n${s.cliId}`.toLowerCase().includes(w))));
  }
  const key = { recent: (a, b) => b.lastActivityMs - a.lastActivityMs, oldest: (a, b) => a.lastActivityMs - b.lastActivityMs,
    title: (a, b) => String(a.title).localeCompare(String(b.title)), size: (a, b) => (b.sizeKB || 0) - (a.sizeKB || 0), turns: (a, b) => (b.userTurns || 0) - (a.userTurns || 0) }[S.sort];
  list = [...list].sort(key);
  S.shown = list; S.snippets = snippets;
  renderRows();
}

function renderRows() {
  const rows = $('#rows'); rows.innerHTML = '';
  $('#count').textContent = `${S.shown.length} session${S.shown.length === 1 ? '' : 's'}`;
  $('#empty').classList.toggle('hidden', S.shown.length > 0 || !!S.query);
  const words = S.query.toLowerCase().split(/\s+/).filter(Boolean);
  const frag = document.createDocumentFragment();
  for (const s of S.shown) {
    const d = document.createElement('div'); d.className = 'row' + (S.active === s.cliId ? ' active' : ''); d.dataset.id = s.cliId;
    const accLabel = s.liveAccounts && s.liveAccounts.length ? s.liveAccounts.map(a => (S.state.accounts.find(x => x.id === a) || {}).label || shortId(a)).join(', ') : (s.account ? shortId(s.account) : '');
    let snip = S.snippets && S.snippets.get(s.cliId);
    if (snip) snip = esc(snip);
    if (snip) for (const w of words) snip = snip.replace(new RegExp(w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), m => `<mark>${m}</mark>`);
    d.innerHTML = `<input type="checkbox" ${S.sel.has(s.cliId) ? 'checked' : ''}>
      <div><div class="t">${esc(s.title)}${s.banked ? '<span class="pill ok">banked</span>' : '<span class="pill warn">not banked</span>'}${s.chat ? '<span class="pill acc">claude.ai chat</span>' : s.live ? '' : '<span class="pill">bank only</span>'}${s.orphan || (s.live && s.live.orphan) ? '<span class="pill">no record</span>' : ''}${accLabel ? `<span class="pill acc">${esc(accLabel)}</span>` : ''}</div>
      <div class="s">${esc(shortPath(s.cwd))}${s.model ? ' · ' + esc(s.model.replace(/^claude-/, '')) : ''}</div>${snip ? `<div class="snip">${snip}</div>` : ''}</div>
      <div class="r">${esc(fmtDate(s.lastActivityMs))}<br>${s.userTurns != null ? s.userTurns + ' turns · ' : ''}${s.sizeKB >= 0 ? s.sizeKB + ' KB' : ''}</div>`;
    frag.appendChild(d);
  }
  rows.appendChild(frag);
  updateBulk();
}

function updateBulk() {
  const n = S.sel.size;
  $('#bulk').classList.toggle('hidden', n === 0);
  $('#selcount').textContent = `${n} selected`;
  $('#sel-all').checked = n > 0 && S.shown.every(s => S.sel.has(s.cliId));
  $('#b-remove').disabled = ![...S.sel].some(id => (S.sessions.find(s => s.cliId === id) || {}).banked);
}

async function refresh() { await loadAll(); if (S.active) await openSession(S.active, true); }

// ---------------------------------------------------------------- detail
async function openSession(cliId, quiet) {
  const s = S.sessions.find(x => x.cliId === cliId);
  if (!s) return;
  S.active = cliId;
  $$('.row').forEach(r => r.classList.toggle('active', r.dataset.id === cliId));
  try { S.detail = await window.bank.session({ kind: s.banked ? 'bank' : 'live', cliId }); }
  catch (e) { if (!quiet) status('Could not open: ' + e.message); return; }
  const m = S.detail.meta;
  $('#detail-empty').classList.add('hidden'); $('#detail-body').classList.remove('hidden');
  $('#d-title').textContent = m.title || s.title;
  const bits = [];
  bits.push(`<span title="${esc(m.cwd)}" class="${m.cwdExists ? '' : 'bad'}">${esc(shortPath(m.cwd)) || '(no folder)'}${m.cwdExists ? '' : ' · folder missing here'}</span>`);
  if (m.branch) bits.push(`branch ${esc(m.branch)}`);
  if (m.model) bits.push(esc(m.model));
  bits.push(`${m.userTurns ?? '?'} user turns · ${m.assistantTurns ?? '?'} replies · ${S.detail.lines} lines`);
  bits.push(`last ${esc(fmtDate(m.lastActivityMs))}`);
  bits.push(`<span title="${esc(cliId)}">id ${shortId(cliId)}</span>`);
  bits.push(m.banked ? `<span style="color:var(--ok)">in bank</span>` : `<span style="color:var(--warn)">not banked yet</span>`);
  if (m.origins && m.origins.length) bits.push(`from ${esc(m.origins.join(', '))}`);
  $('#d-meta').innerHTML = bits.join('<span class="muted"> · </span>');
  $('#d-bank').textContent = m.banked ? 'Re-bank now' : 'Bank now';
  $('#d-open-chat').classList.toggle('hidden', !m.chatUrl);
  $('#d-bank').classList.toggle('hidden', !!m.chat);
  $('#d-takeover').disabled = !S.state.currentAccount;
  $('#d-takeover').title = S.state.currentAccount ? 'Import into the current account, then open Claude Desktop' : 'No current account found in Claude Desktop config';
  renderChat();
  const files = m.files || [];
  $('#tab-files').innerHTML = files.length ? `<div class="filelist">${files.map(f => `<div>${esc(f)}</div>`).join('')}</div>` : '<div class="muted">No file paths were touched by tools in this session.</div>';
  const kv = [['Session id', cliId], ['Sidebar id', (m.record && m.record.sessionId) || m.id || ''], ['Working folder', m.cwd], ['Folder exists here', m.cwdExists ? 'yes' : 'no'], ['Model', m.model], ['Git branch', m.branch],
    ['Claude Code version', m.version], ['Created', fmtDate(m.createdMs)], ['Last activity', fmtDate(m.lastActivityMs)], ['Tools used', (m.tools || []).join(', ')], ['Transcript size', (m.sizeKB ?? '') + ' KB'],
    ['Banked at', fmtDate(m.bankedAt)], ['First banked', fmtDate(m.firstBankedAt)], ['Origins', (m.origins || []).join('\n')], ['Live transcript', m.live ? m.live.transcript : (m.transcript || '')], ['Account', m.account]];
  $('#tab-info').innerHTML = `<dl class="kv">${kv.filter(([, v]) => v).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
}

function renderChat() {
  if (!S.detail) return;
  const showTools = $('#show-tools').checked, showThink = $('#show-thinking').checked;
  const pane = $('#tab-chat'); const frag = document.createDocumentFragment();
  for (const t of S.detail.turns) {
    const hasText = t.blocks.some(b => b.type === 'text' && b.text.trim());
    const hasVisible = hasText || t.blocks.some(b => (b.type === 'tool_use' || b.type === 'tool_result') && showTools) || t.blocks.some(b => b.type === 'thinking' && showThink);
    if (!hasVisible) continue;
    const toolsOnly = t.role === 'user' && !hasText && t.blocks.every(b => b.type === 'tool_result');
    const d = document.createElement('div'); d.className = 'turn ' + (toolsOnly ? 'tools' : t.role);
    let html = `<div class="who"><span>${t.role === 'user' ? 'You' : 'Claude'}</span><span>${esc(String(t.time).slice(0, 16).replace('T', ' '))}</span></div>`;
    for (const b of t.blocks) {
      if (b.type === 'text' && b.text.trim()) html += `<div class="txt">${esc(b.text)}</div>`;
      else if (b.type === 'thinking' && showThink && b.text) html += `<details class="tool think"><summary>thinking</summary><pre>${esc(b.text)}</pre></details>`;
      else if (b.type === 'tool_use' && showTools) html += `<details class="tool"><summary>tool: ${esc(b.name)}</summary><pre>${esc(b.input)}</pre></details>`;
      else if (b.type === 'tool_result' && showTools) html += `<details class="tool${b.isError ? ' err' : ''}"><summary>${b.isError ? 'error result' : 'result'}</summary><pre>${esc(b.text || '(empty)')}</pre></details>`;
    }
    d.innerHTML = html; frag.appendChild(d);
  }
  pane.innerHTML = ''; pane.appendChild(frag);
  if (!pane.children.length) pane.innerHTML = '<div class="muted">No messages to show.</div>';
}

// ---------------------------------------------------------------- import dialog
let importIds = [];
function openImport(ids) {
  importIds = ids;
  const st = S.state;
  if (!st.accounts.length) { status('No Claude Desktop account store found on this PC. Sign in to Claude once, then try again.'); return; }
  const titles = ids.map(id => (S.sessions.find(s => s.cliId === id) || {}).title || id);
  $('#i-what').textContent = ids.length === 1 ? titles[0] : `${ids.length} sessions: ${titles.slice(0, 3).join(', ')}${ids.length > 3 ? '…' : ''}`;
  const accSel = $('#i-account'); accSel.innerHTML = st.accounts.map(a => `<option value="${esc(a.id)}" ${a.current ? 'selected' : ''}>${esc(a.label || shortId(a.id))}${a.current ? ' (current)' : ''} — ${a.sessions} sessions</option>`).join('');
  fillDevices();
  // folders that do not exist here get a remap box
  const missing = [...new Set(ids.map(id => (S.sessions.find(s => s.cliId === id) || {}).cwd).filter(Boolean))];
  Promise.resolve().then(() => {
    const box = $('#i-remap'); box.innerHTML = '';
    const detail = S.detail && ids.includes(S.detail.meta.cliId) ? S.detail.meta : null;
    for (const cwd of missing) {
      const exists = detail && detail.cwd === cwd ? detail.cwdExists : null;
      const div = document.createElement('div'); div.className = 'remap'; div.dataset.cwd = cwd;
      div.innerHTML = `<div>Working folder <code>${esc(cwd)}</code>${exists === false ? ' <b>does not exist on this PC</b>. Point it at the folder here:' : '. Change it if the project lives elsewhere on this PC:'}</div><div class="r"><input type="text" value="${esc(cwd)}"><button class="pick">Pick…</button></div>`;
      div.querySelector('.pick').onclick = async () => { const p = await window.bank.pickFolder(); if (p) div.querySelector('input').value = p; };
      box.appendChild(div);
    }
  });
  $('#i-log').classList.add('hidden'); $('#i-log').textContent = '';
  $('#m-import').classList.remove('hidden');
}
function fillDevices() {
  const a = S.state.accounts.find(x => x.id === $('#i-account').value);
  const devs = a && a.devices.length ? a.devices : [S.state.deviceHint || 'unknown-device'];
  $('#i-device').innerHTML = devs.map(d => `<option value="${esc(d)}">${esc(shortId(d))}</option>`).join('');
}
function importOpts(dryRun) {
  const cwdMap = {};
  $$('#i-remap .remap').forEach(div => { const v = div.querySelector('input').value.trim(); if (v && v !== div.dataset.cwd) cwdMap[div.dataset.cwd] = v; });
  const mode = $('#i-mode').value;
  return { accountId: $('#i-account').value, deviceId: $('#i-device').value, cwdMap, newId: $('#i-newid').checked, merge: mode === 'merge', overwrite: mode === 'overwrite',
    includeMemory: $('#i-memory').checked, backup: $('#i-backup').checked, dryRun };
}
async function runImport(dryRun) {
  $('#i-go').disabled = $('#i-dry').disabled = true;
  try {
    const r = await window.bank.importTo(importIds, importOpts(dryRun));
    $('#i-log').classList.remove('hidden'); $('#i-log').textContent = r.log.join('\n');
    if (!dryRun && !r.cancelled) { status(`Imported ${r.installed.length} session(s). Restart Claude Desktop to see them in the sidebar.`); await refresh(); }
  } catch (e) { $('#i-log').classList.remove('hidden'); $('#i-log').textContent = 'Failed: ' + e.message; }
  $('#i-go').disabled = $('#i-dry').disabled = false;
}

// ---------------------------------------------------------------- settings dialog
async function openSettings() {
  const cfg = await window.bank.config();
  $('#s-key').value = cfg.sessionKey || ''; $('#s-chatcwd').value = cfg.chatsCwd || ''; $('#s-syncall').checked = !!cfg.syncAll;
  $('#s-auto').checked = !!cfg.autoBank; $('#s-min').value = cfg.autoBankMinutes || 5; $('#s-memory').checked = cfg.includeMemory !== false;
  $('#s-labels').innerHTML = S.state.accounts.map(a => `<div class="lbl"><code title="${esc(a.id)}">${esc(shortId(a.id))}</code><input type="text" data-id="${esc(a.id)}" value="${esc(cfg.labels[a.id] || '')}" placeholder="e.g. work, personal"></div>`).join('') || '<div class="muted small">No accounts found.</div>';
  $('#s-sources').textContent = (cfg.sources || []).join('\n') || 'none yet';
  $('#s-paths').innerHTML = Object.entries(S.state.paths).map(([k, v]) => `<div><b>${esc(k)}</b>: ${esc(v)}</div>`).join('');
  const bks = await window.bank.backups();
  $('#s-backups').innerHTML = bks.length ? bks.slice(0, 30).map(b => `<div class="bk"><span class="grow">${esc(fmtDate(b.createdMs))} · ${esc(shortId(b.account))} · ${b.records} records</span><button data-restore="${esc(b.path)}">Restore</button></div>`).join('') : '<div class="muted">No backups yet. One is made before every import.</div>';
  $('#m-settings').classList.remove('hidden');
}

// ---------------------------------------------------------------- text dialog
function showText(title, body) { $('#t-title').textContent = title; $('#t-body').textContent = body; $('#m-text').classList.remove('hidden'); }

// ---------------------------------------------------------------- wiring
function selectedIds() { return S.sel.size ? [...S.sel] : S.active ? [S.active] : []; }

document.addEventListener('DOMContentLoaded', async () => {
  $('#w-min').onclick = () => window.bank.win('min');
  $('#w-max').onclick = async () => { const m = await window.bank.win('max'); $('#w-max').textContent = m ? '❐' : '□'; };
  $('#w-close').onclick = () => window.bank.win('close');
  $('#titlebar').addEventListener('dblclick', e => { if (!e.target.closest('.nodrag')) $('#w-max').click(); });

  $('#q').addEventListener('input', () => { S.query = $('#q').value; clearTimeout(S.searchTimer); S.searchTimer = setTimeout(applyFilter, 180); });
  $('#deep').onchange = () => { S.deep = $('#deep').checked; applyFilter(); };
  $('#sort').onchange = () => { S.sort = $('#sort').value; applyFilter(); };
  $('#show-archived').onchange = () => { S.archived = $('#show-archived').checked; applyFilter(); };
  $$('.nav[data-scope]').forEach(b => b.onclick = () => { S.scope = b.dataset.scope; S.account = null; $$('.nav').forEach(x => x.classList.remove('active')); b.classList.add('active'); applyFilter(); });
  $('#accounts').addEventListener('click', e => { const b = e.target.closest('.nav'); if (!b) return; S.account = S.account === b.dataset.account ? null : b.dataset.account; S.scope = 'all'; $$('.nav').forEach(x => x.classList.remove('active')); (S.account ? b : $('.nav[data-scope=all]')).classList.add('active'); applyFilter(); });

  $('#rows').addEventListener('click', e => {
    const row = e.target.closest('.row'); if (!row) return;
    const id = row.dataset.id;
    if (e.target.type === 'checkbox' || e.shiftKey || e.ctrlKey || e.metaKey) {
      if (e.shiftKey && S.lastClick) {
        const ids = S.shown.map(s => s.cliId); const a = ids.indexOf(S.lastClick), b = ids.indexOf(id);
        for (const x of ids.slice(Math.min(a, b), Math.max(a, b) + 1)) S.sel.add(x);
      } else if (S.sel.has(id)) S.sel.delete(id); else S.sel.add(id);
      S.lastClick = id; renderRows(); return;
    }
    S.lastClick = id; openSession(id);
  });
  $('#rows').addEventListener('keydown', e => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const ids = S.shown.map(s => s.cliId); let i = ids.indexOf(S.active); i = e.key === 'ArrowDown' ? Math.min(ids.length - 1, i + 1) : Math.max(0, i - 1);
    if (ids[i]) { openSession(ids[i]); const el = $(`.row[data-id="${ids[i]}"]`); el && el.scrollIntoView({ block: 'nearest' }); }
  });
  $('#sel-all').onchange = () => { if ($('#sel-all').checked) S.shown.forEach(s => S.sel.add(s.cliId)); else S.sel.clear(); renderRows(); };

  $('#bank-all').onclick = async () => { $('#bank-all').disabled = true; status('Banking…'); try { const r = await window.bank.bankAll(); status(r.message); } catch (e) { status('Failed: ' + e.message); } $('#bank-all').disabled = false; refresh(); };
  $('#add-folder').onclick = async () => { const r = await window.bank.bankFolder(); if (r) { status(r.message); refresh(); } };
  $('#add-bundle').onclick = async () => { const r = await window.bank.bankBundle(); if (r) { status(r.message); refresh(); } };
  $('#open-bank').onclick = () => window.bank.openBank();
  $('#settings').onclick = openSettings;

  $('#b-bank').onclick = async () => { const r = await window.bank.bankOne([...S.sel].map(cliId => ({ cliId }))); status(r.message); refresh(); };
  $('#b-import').onclick = () => openImport([...S.sel]);
  $('#b-bundle').onclick = async () => { const r = await window.bank.exportBundle([...S.sel]); if (r) status(`Bundle written: ${r.path}`); refresh(); };
  $('#b-remove').onclick = async () => { const r = await window.bank.remove([...S.sel].filter(id => (S.sessions.find(s => s.cliId === id) || {}).banked)); if (r.removed) { status(`Removed ${r.removed} from the bank (moved to trash)`); S.sel.clear(); if (S.active) { S.active = null; $('#detail-body').classList.add('hidden'); $('#detail-empty').classList.remove('hidden'); } refresh(); } };

  $('#d-takeover').onclick = async () => {
    const cur = S.state.currentAccount; const a = S.state.accounts.find(x => x.id === cur);
    if (!a) { openImport([S.active]); return; }
    const m = S.detail.meta;
    if (!m.cwdExists) { openImport([S.active]); status('The working folder is missing on this PC. Point it at the right folder, then import.'); return; }
    const r = await window.bank.importTo([S.active], { accountId: cur, deviceId: a.devices[0] || S.state.deviceHint, merge: true, overwrite: false, includeMemory: true, backup: true });
    if (r.cancelled) { status(r.log.join(' ')); return; }
    showText('Taken over', r.log.join('\n') + '\n\nRestart Claude Desktop if it was open. The session now appears in its sidebar under the current account; open it and keep going.');
    const msg = await window.bank.openClaude(); status(msg); refresh();
  };
  $('#d-import').onclick = () => openImport([S.active]);
  $('#d-open-chat').onclick = () => window.bank.openUrl(S.detail.meta.chatUrl);
  $('#chats-export').onclick = async () => { const r = await window.bank.chatsExport(); if (r) { status(r.message); refresh(); } };
  $('#chats-sync').onclick = async () => {
    const cfg = await window.bank.config();
    if (!cfg.sessionKey) { openSettings(); status('Paste your claude.ai session key first, then press Sync again.'); return; }
    $('#chats-sync').disabled = true; status('Syncing Recents from claude.ai…');
    const r = await window.bank.chatsSync({ all: !!cfg.syncAll });
    $('#chats-sync').disabled = false; status(r.error ? 'Sync failed: ' + r.error : r.message); refresh();
  };
  $('#d-resume').onclick = async () => { const r = await window.bank.resume(S.active, S.detail.meta.cwdExists ? S.detail.meta.cwd : null); status(r.message); };
  $('#d-handoff').onclick = async () => { const t = await window.bank.handoff(S.active, true); status('Handoff prompt copied to the clipboard'); showText('Handoff prompt (copied)', t); };
  $('#d-bank').onclick = async () => { const r = await window.bank.bankOne([{ cliId: S.active }]); status(r.message); refresh(); };
  $('#d-secrets').onclick = async () => { const hits = await window.bank.secrets(S.active); showText(hits.length ? `${hits.length} possible secret(s)` : 'No secrets found', hits.length ? hits.map(h => `line ${h.line}  ${h.kind}  ${h.sample}`).join('\n') : 'Nothing matched the API key, token, password and private key patterns.'); };
  $('#d-export').onclick = e => { e.stopPropagation(); $('#d-export').parentElement.classList.toggle('open'); };
  $$('.menu-items button').forEach(b => b.onclick = async () => {
    $('.menu').classList.remove('open');
    if (b.dataset.fmt === 'bundle') { const r = await window.bank.exportBundle([S.active]); if (r) status(`Bundle written: ${r.path}`); }
    else { const f = await window.bank.exportOne(S.active, b.dataset.fmt); if (f) status('Saved ' + f); }
  });
  document.addEventListener('click', () => $('.menu').classList.remove('open'));
  $$('.tab').forEach(t => t.onclick = () => { $$('.tab').forEach(x => x.classList.remove('active')); t.classList.add('active'); $$('.tabpane').forEach(p => p.classList.add('hidden')); $('#tab-' + t.dataset.tab).classList.remove('hidden'); });
  $('#show-tools').onchange = $('#show-thinking').onchange = renderChat;

  $('#i-account').onchange = fillDevices;
  $('#i-cancel').onclick = () => $('#m-import').classList.add('hidden');
  $('#i-dry').onclick = () => runImport(true);
  $('#i-go').onclick = () => runImport(false);
  $('#s-close').onclick = () => $('#m-settings').classList.add('hidden');
  $('#s-chatcwd-pick').onclick = async () => { const p = await window.bank.pickFolder(); if (p) $('#s-chatcwd').value = p; };
  $('#s-save').onclick = async () => {
    const labels = {}; $$('#s-labels input').forEach(i => { if (i.value.trim()) labels[i.dataset.id] = i.value.trim(); });
    await window.bank.config({ sessionKey: $('#s-key').value.trim(), chatsCwd: $('#s-chatcwd').value.trim(), syncAll: $('#s-syncall').checked, autoBank: $('#s-auto').checked, autoBankMinutes: Math.max(1, Number($('#s-min').value) || 5), includeMemory: $('#s-memory').checked, labels });
    $('#m-settings').classList.add('hidden'); status('Settings saved'); refresh();
  };
  $('#s-backups').addEventListener('click', async e => { const b = e.target.closest('[data-restore]'); if (!b) return; const log = await window.bank.restore(b.dataset.restore); showText('Restore', log.join('\n')); refresh(); });
  $('#t-close').onclick = () => $('#m-text').classList.add('hidden');
  $('#t-copy').onclick = () => { navigator.clipboard.writeText($('#t-body').textContent); status('Copied'); };

  document.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#q').focus(); $('#q').select(); }
    if (e.key === 'Escape') { const open = $$('.modal:not(.hidden)'); if (open.length) open.forEach(m => m.classList.add('hidden')); else if ($('#q').value) { $('#q').value = ''; S.query = ''; applyFilter(); } else if (S.sel.size) { S.sel.clear(); renderRows(); } }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && document.activeElement === $('#rows')) { e.preventDefault(); S.shown.forEach(s => S.sel.add(s.cliId)); renderRows(); }
  });

  // drag & drop of folders, bundles and transcripts
  let dragDepth = 0;
  document.addEventListener('dragenter', e => { e.preventDefault(); dragDepth++; $('#dropzone').classList.remove('hidden'); });
  document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('#dropzone').classList.add('hidden'); } });
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', async e => {
    e.preventDefault(); dragDepth = 0; $('#dropzone').classList.add('hidden');
    const paths = [...e.dataTransfer.files].map(f => window.bank.pathOf(f)).filter(Boolean);
    if (!paths.length) return;
    status('Adding ' + paths.length + ' item(s)…');
    const r = await window.bank.bankPaths(paths); status(r.message); refresh();
  });

  await loadAll();
  if (S.state.config.autoBank && !S.state.bankCount && S.sessions.length) { status('First run: banking everything on this PC…'); const r = await window.bank.bankAll(); status(r.message); refresh(); }
});
