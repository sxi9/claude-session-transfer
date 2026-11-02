# Claude Session Transfer

A small tkinter tool for moving Claude Desktop (Code tab) sessions around:
between accounts on one PC, or packed into a portable bundle and loaded on
another PC. Standard library only, nothing to install.

```bash
python claude_session_transfer.py
```

## What it does

| Tab | Purpose |
|---|---|
| **Transfer (this PC)** | Copy or move sessions between the accounts signed in on this machine. |
| **Capture → bundle** | Pack selected sessions, plus optional project memory and settings, into one `.zip`. |
| **Load ← bundle** | Open a bundle on any PC, pick the target account, remap working folders, install. |

Every write backs up the target folder first into `claude-code-sessions-backups`
beside the app's session store. The tool warns if the Claude app is running.

## How the app stores a session

Windows paths shown; macOS and Linux locations are handled too.

```
%APPDATA%\Claude\claude-code-sessions\<account-id>\<device-id>\local_<id>.json
    sidebar record; "cliSessionId" points at the transcript

%USERPROFILE%\.claude\projects\<cwd-slug>\<cliSessionId>.jsonl
    the conversation itself

%USERPROFILE%\.claude\projects\<cwd-slug>\<cliSessionId>\
    custom title, subagent transcripts

%USERPROFILE%\.claude\projects\<cwd-slug>\memory\
    Claude's persistent memory for that project folder
```

`<cwd-slug>` is the working directory with every non-alphanumeric character
replaced by a dash, e.g. `D:\physical_ai` → `D--physical-ai`.

## Bundle layout

```
manifest.json
sessions/<cliSessionId>/record.json
sessions/<cliSessionId>/transcript.jsonl
sessions/<cliSessionId>/extra/...        title + subagent files
memory/<cwd-slug>/...                    optional
settings/settings.json, settings/CLAUDE.md   optional
```

## Loading on another PC

1. Sign in to Claude on that PC once so the account and device folders exist.
2. Close Claude.
3. Run the tool, open the bundle on the **Load** tab.
4. Working folders that do not exist there show in red. Point each at where the
   project lives on that PC. The record and every transcript line are rewritten
   to match.
5. Load, then reopen Claude and sign in to the target account.

## Options

- **Copy vs Move** (Transfer tab): a copy leaves both accounts pointing at the
  same transcript file, so continuing the chat from both sides interleaves into
  one file. Move when you want to keep working on it in the other account.
- **Assign new session id**: give the loaded session a fresh id if the app ever
  complains about a duplicate.
- **Overwrite existing files**: off by default. Without it, existing transcripts
  and memory files are kept, and imported settings are saved beside the existing
  file as `settings.json.imported`.
- **Include settings**: off by default, since `settings.json` can hold keys.

## Caveats

This relies on an undocumented on-disk layout. An app update could change it.
Backups are written before every change, so a failed load is recoverable.
Never copy `.credentials.json` between accounts or machines.

Testing overrides: set `CLAUDE_APP_DIR` and `CLAUDE_HOME_DIR` to point the tool
at a throwaway store.
