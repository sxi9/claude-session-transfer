#!/usr/bin/env python3
"""Export Claude Code cloud sessions (claude.ai/code) as a Context Bank bundle.

Run inside a Claude Code cloud session. The session's agent fetches other sessions with its
session tools (list_sessions, get_session, list_events); this script reads those tool results
back out of the agent's own transcript, tells the agent which page to fetch next, and finally
packs everything into a bundle zip that Context Bank and claude-session-transfer both load.

    python3 -I cloud_export.py status          what is fetched, and the next cursor per session
    python3 -I cloud_export.py build --out X   write the bundle (refuses while pages are missing)
    python3 -I cloud_export.py build --out X --allow-partial

Standard library only. See CLOUD-EXPORT.md for the exact steps the agent follows.
"""
import argparse, glob, json, os, re, sys, time, uuid, zipfile
from collections import Counter
from datetime import datetime, timezone

CLAUDE_HOME = os.environ.get('CLAUDE_HOME_DIR') or os.path.join(os.path.expanduser('~'), '.claude')


def own_transcripts():
    """The running session's transcript file(s): newest .jsonl directly under projects/*/,
    plus any file of the same name under another project folder (the cwd can change mid-session)."""
    files = glob.glob(os.path.join(CLAUDE_HOME, 'projects', '*', '*.jsonl'))
    if not files:
        sys.exit(f'No transcripts under {CLAUDE_HOME}/projects. Is this a Claude Code session?')
    newest = max(files, key=os.path.getmtime)
    name = os.path.basename(newest)
    return sorted((f for f in files if os.path.basename(f) == name), key=os.path.getmtime), name[:-6]


def parse_ccr(text):
    m = re.search(r'\{"ccr":', text)
    if not m:
        return None
    try:
        return json.loads(text[m.start():text.rfind('}') + 1]).get('ccr')
    except Exception:
        return None


def result_text(block):
    c = block.get('content')
    text = c if isinstance(c, str) else ''.join(x.get('text', '') for x in (c or []) if isinstance(x, dict))
    m = re.search(r'saved to (\S+\.txt)', text)          # oversized results are spilled to a file
    if m and os.path.exists(m.group(1)):
        text = open(m.group(1), encoding='utf-8', errors='replace').read()
    return text


def load():
    paths, own_cli = own_transcripts()
    calls, order, results, own_lines, seen = {}, [], {}, [], set()
    for path in paths:
        for raw in open(path, encoding='utf-8', errors='replace'):
            raw = raw.strip()
            if not raw:
                continue
            try:
                o = json.loads(raw)
            except Exception:
                continue
            key = o.get('uuid') or raw
            if key not in seen:
                seen.add(key)
                own_lines.append(o)
            content = (o.get('message') or {}).get('content')
            if not isinstance(content, list):
                continue
            for b in content:
                if not isinstance(b, dict):
                    continue
                if b.get('type') == 'tool_use':
                    name = b.get('name') or ''
                    for kind in ('list_events', 'list_sessions', 'get_session'):
                        if name.endswith(kind) and b['id'] not in calls:
                            calls[b['id']] = (kind, b.get('input') or {})
                            order.append(b['id'])
                elif b.get('type') == 'tool_result' and b.get('tool_use_id') in calls and b['tool_use_id'] not in results:
                    ccr = parse_ccr(result_text(b))
                    if ccr is not None:
                        results[b['tool_use_id']] = ccr

    sessions = {}      # cloud id -> info
    self_id = None

    def info(sid):
        return sessions.setdefault(sid, {'id': sid, 'title': '', 'created': '', 'updated': '', 'sources': [], 'out_repo': '',
                                         'branch': '', 'events': {}, 'used': set(), 'firsts': [], 'done': False, 'pages': 0, 'detail': False})

    for tid in order:
        kind, inp = calls[tid]
        r = results.get(tid)
        if r is None:
            continue
        if kind == 'list_sessions':
            for s in r.get('data') or []:
                i = info(s['id'])
                i['title'] = s.get('title') or i['title']
                i['created'] = s.get('created_at') or i['created']
                i['updated'] = s.get('updated_at') or i['updated']
        elif kind == 'get_session':
            if not r.get('id'):
                continue
            i = info(r['id'])
            i['detail'] = True
            i['title'] = r.get('title') or i['title']
            i['created'] = r.get('created_at') or i['created']
            i['updated'] = r.get('updated_at') or i['updated']
            ctx = r.get('session_context') or {}
            i['sources'] = [s['git_repository']['url'] for s in ctx.get('sources') or [] if (s.get('git_repository') or {}).get('url')]
            for o in ctx.get('outcomes') or []:
                gi = (o.get('git_repository') or {}).get('git_info') or {}
                if gi.get('repo'):
                    i['out_repo'] = gi['repo']
                    i['branch'] = (gi.get('branches') or [''])[0]
            if not inp.get('session_id'):
                self_id = r['id']
        elif kind == 'list_events':
            sid = inp.get('session_id')
            if not sid:
                continue
            i = info(sid)
            i['pages'] += 1
            if inp.get('before_id'):
                i['used'].add(inp['before_id'])
            for e in r.get('data') or []:
                for role in ('user', 'assistant'):
                    if role in e and e[role].get('uuid'):
                        i['events'][e[role]['uuid']] = (role, e)
            if r.get('has_more'):
                if r.get('first_id'):
                    i['firsts'].append(r['first_id'])
            else:
                i['done'] = True
    return sessions, self_id, own_cli, own_lines


def next_cursor(i):
    if i['done']:
        return 'DONE'
    if not i['pages']:
        return 'NOT STARTED'
    open_ = [c for c in i['firsts'] if c not in i['used']]
    return open_[-1] if open_ else 'UNKNOWN (rerun status after the next call)'


def cmd_status(_args):
    sessions, self_id, _cli, _lines = load()
    if not sessions:
        print('No sessions known yet. Call list_sessions first (see CLOUD-EXPORT.md).')
        return
    todo = 0
    for sid, i in sessions.items():
        if sid == self_id:
            print(f'{sid}  SELF (taken from the local transcript, do not page it)  {i["title"]}')
            continue
        cur = next_cursor(i)
        if cur != 'DONE':
            todo += 1
        det = '' if i['detail'] else '  [get_session not called yet]'
        print(f'{sid}  pages={i["pages"]:<3} turns={len(i["events"]):<5} next={cur}{det}  {i["title"]}')
    if self_id is None:
        print('NOTE: call get_session with no session_id once, so this session can be identified and included.')
    print(f'{todo} session(s) still need pages.' if todo else 'All sessions complete. Run: build --out <file.zip>')


def ms(iso):
    try:
        return int(datetime.fromisoformat((iso or '').replace('Z', '+00:00')).timestamp() * 1000)
    except Exception:
        return int(time.time() * 1000)


def to_lines(i):
    evs = sorted(i['events'].values(), key=lambda e: e[1].get('created_at') or '')
    cwds, cli = Counter(), None
    for role, e in evs:
        c = e[role].get('internal_anthropic_catchall') or {}
        sid = c.get('session_id') or ''
        if sid and not sid.startswith('session_'):
            cli = cli or sid
        for v in (c.get('wire_ingest_context') or {}).values():
            if isinstance(v, dict) and v.get('cwd'):
                cwds[v['cwd']] += 1
    repo_names = [u.rstrip('/').split('/')[-1].replace('.git', '') for u in i['sources']]
    cwd = cwds.most_common(1)[0][0] if cwds else (f'/home/user/{repo_names[0]}' if repo_names else '/home/user')
    cli = cli or str(uuid.uuid5(uuid.NAMESPACE_URL, i['id']))
    lines, parent = [], None
    for role, e in evs:
        body = e[role]
        c = body.get('internal_anthropic_catchall') or {}
        msg = c.get('message')
        if not msg:
            continue
        line = {'parentUuid': parent, 'isSidechain': False, 'userType': 'external', 'cwd': cwd, 'sessionId': cli,
                'version': '2.1.0', 'gitBranch': '', 'type': role, 'uuid': body['uuid'],
                'timestamp': c.get('timestamp') or e.get('created_at'), 'message': msg}
        if c.get('isSynthetic'):
            line['isSynthetic'] = True
        if c.get('tool_use_result') is not None:
            line['toolUseResult'] = c['tool_use_result']
        lines.append(line)
        parent = body['uuid']
    return lines, cli, cwd


def repo_for(i, cwd):
    base = os.path.basename(cwd.rstrip('/'))
    url = next((u for u in i['sources'] if u.rstrip('/').split('/')[-1].replace('.git', '') == base), i['sources'][0] if i['sources'] else '')
    branch = i['branch'] if url and i['out_repo'] and url.rstrip('/').endswith(i['out_repo']) else ''
    return url, branch


def cmd_build(args):
    sessions, self_id, own_cli, own_lines = load()
    pending = [i for sid, i in sessions.items() if sid != self_id and next_cursor(i) != 'DONE']
    if pending and not args.allow_partial:
        for i in pending:
            print(f'INCOMPLETE {i["id"]} next={next_cursor(i)}  {i["title"]}')
        sys.exit('Some sessions are incomplete. Fetch the remaining pages (status shows the cursors) or pass --allow-partial.')
    manifest = {'bundleVersion': 2, 'createdAt': datetime.now(timezone.utc).isoformat(timespec='seconds'),
                'sourceMachine': 'claude.ai cloud', 'sourcePlatform': 'cloud', 'sourceAccount': None,
                'sessions': [], 'memory': [], 'project': [], 'settings': [], 'exportedBy': 'context-bank cloud_export.py'}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    rows = []
    with zipfile.ZipFile(args.out, 'w', zipfile.ZIP_DEFLATED) as z:
        for sid, i in sessions.items():
            if sid == self_id:
                lines, cli = own_lines, own_cli
                cwd = next((l.get('cwd') for l in lines if l.get('cwd')), '/home/user')
            else:
                if not i['events']:
                    continue
                lines, cli, cwd = to_lines(i)
            if not lines:
                continue
            title = i['title'] or f'Cloud session {sid[-8:]}'
            url, branch = repo_for(i, cwd)
            text = '\n'.join(json.dumps(l, ensure_ascii=False) for l in lines) + '\n'
            first = next((l.get('timestamp') for l in lines if l.get('timestamp')), i['created'])
            last = next((l.get('timestamp') for l in reversed(lines) if l.get('timestamp')), i['updated'])
            model = next((l['message'].get('model') for l in lines if l.get('type') == 'assistant' and isinstance(l.get('message'), dict) and l['message'].get('model')), '')
            turns = sum(1 for l in lines if l.get('type') == 'user' and isinstance((l.get('message') or {}).get('content'), str))
            rec = {'sessionId': 'local_' + str(uuid.uuid4()), 'cliSessionId': cli, 'cwd': cwd, 'originCwd': cwd, 'gitAnchorsFolderRealpath': cwd,
                   'createdAt': ms(first), 'lastActivityAt': ms(last), 'lastFocusedAt': ms(last), 'lastTurnEdgeAt': ms(last), 'model': model,
                   'effort': 'medium', 'isArchived': False, 'title': title, 'titleSource': 'custom', 'permissionMode': 'default',
                   'remoteMcpServersConfig': [], 'completedTurns': turns, 'importedBy': 'context-bank', 'source': 'claude.ai cloud session',
                   'cloudSessionId': sid, 'cloudUrl': f'https://claude.ai/code/{sid}', 'repoUrl': url, 'branch': branch,
                   'partial': bool(sid != self_id and next_cursor(i) != 'DONE')}
            z.writestr(f'sessions/{cli}/record.json', json.dumps(rec, ensure_ascii=False))
            z.writestr(f'sessions/{cli}/transcript.jsonl', text)
            z.writestr(f'sessions/{cli}/extra/custom-title.json', json.dumps({'customTitle': title, 'sessionId': cli}))
            manifest['sessions'].append({'cliSessionId': cli, 'sessionId': rec['sessionId'], 'title': title, 'cwd': cwd, 'lastActivityAt': rec['lastActivityAt'],
                                         'hasTranscript': True, 'transcriptKB': len(text) // 1024, 'cloudSessionId': sid, 'repoUrl': url, 'branch': branch})
            rows.append((title[:44], len(lines), turns, len(text) // 1024, url.split('github.com/')[-1], branch))
        z.writestr('manifest.json', json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f'Bundle written: {args.out} ({os.path.getsize(args.out) // 1024} KB, {len(rows)} sessions)')
    for r in rows:
        print('  %-44s lines=%-5d userTurns=%-3d KB=%-6d %s %s' % r)
    if self_id is None:
        print('NOTE: this session itself is not in the bundle (get_session with no session_id was never called).')


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest='cmd', required=True)
    sub.add_parser('status').set_defaults(func=cmd_status)
    b = sub.add_parser('build')
    b.add_argument('--out', required=True)
    b.add_argument('--allow-partial', action='store_true')
    b.set_defaults(func=cmd_build)
    args = p.parse_args()
    args.func(args)


if __name__ == '__main__':
    main()
