# Claude Session Transfer

Move Claude Desktop (Code tab) sessions around: between accounts on one PC, or
between PCs as portable bundles. Web UI, command line, and a tkinter window.
Standard library only, nothing to install.

```bash
python cst.py serve        # web UI at http://127.0.0.1:8765
python cst.py gui          # tkinter window (fewer options)
python cst.py --help       # command line
```

## What it does

| Area | Options |
|---|---|
| **Sessions** | Search and sort, preview first message and last reply, multi-select. Transfer between accounts (copy or move, optional new id, dry run). Capture to a bundle. Export as Markdown, HTML, or raw JSONL. Scan a transcript for API keys, tokens, and passwords. Delete to trash. |
| **Load bundle** | Drop or pick a `.zip`, or use one that was captured or pushed here. Pick target account and device id (auto-detected). Remap working folders that do not exist on this PC. Merge, overwrite, or keep-existing. Dry run. Push the bundle to another PC, or download it. |
| **Backups** | Every change backs up the target folder first. List and restore them, with dry run. |
| **Sync & peers** | Scheduled capture of changed sessions into a folder (point it at a shared drive). Peer token for receiving pushes from other PCs. |
| **Settings** | Friendly labels for account ids. Paths the tool uses. |

## Capture from any PC, nothing installed

Host the tool on one machine (see *Hosting* below) and open
`http://<host>:8766/capture` in Chrome or Edge on any other PC.

1. Drag your `.claude` folder onto the page (`C:\Users\<you>\.claude` on
   Windows, `~/.claude` elsewhere), or press **Pick folder**. The browser asks
   whether the site may view it. Nothing is read before you accept.
2. The page lists every session it finds. The last seven days are preselected.
3. Press **Build bundle and upload**. The zip is built in the browser and sent
   to the host, where it appears on the Load page.

Over plain HTTP on a LAN address, Chrome disables its modern folder picker, so
the page uses the basic picker and drag-and-drop instead. Both work; the basic
picker asks "Upload N files?" rather than "view folder?". Nothing is uploaded
until you press the button.

The sidebar records live in AppData, which browsers refuse to open, so the host
rebuilds them from the transcripts when the bundle is loaded. Title, folder,
dates and model are recovered. Firefox has no folder picker, so drag-and-drop
is the only route there.

## Hosting on a server

```bash
git clone https://github.com/sxi9/claude-session-transfer.git ~/claude-session-transfer
cat > ~/.config/systemd/user/cst-web.service <<'UNIT'
[Unit]
Description=Claude Session Transfer web UI
After=network-online.target
[Service]
WorkingDirectory=%h/claude-session-transfer
ExecStart=/usr/bin/python3 %h/claude-session-transfer/cst.py serve --host 0.0.0.0 --port 8766 --no-browser
Restart=on-failure
[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload && systemctl --user enable --now cst-web
loginctl enable-linger $USER     # keep it running when logged out
```

Open the port in the host firewall for your LAN only, for example with
firewalld:

```bash
sudo firewall-cmd --permanent --zone=public --add-rich-rule='rule family=ipv4 source address=192.168.1.0/24 port port=8766 protocol=tcp accept' && sudo firewall-cmd --reload
```

The UI has no login. Anyone who can reach the port can read and delete what
the host holds, so keep it on a trusted network.

## Carry a session to another PC

**Option A, bundle file**

1. Sessions page: select, tick memory and project files if wanted, press **Capture**.
2. Load page: **Download .zip**, or find it in the incoming folder.
3. On the other PC: sign in to Claude once, close it, run `python cst.py serve`,
   drop the zip on the Load page, fix any red working folders, **Load**.
4. Reopen Claude and sign in to the target account.

**Option B, direct push over the LAN**

1. On the receiving PC: `python cst.py serve --host 0.0.0.0`, copy the peer
   token from the Sync & peers page.
2. On the sending PC: capture a bundle, open it on the Load page, enter
   `http://<receiver-ip>:8765` and the token, press **Push**.
3. On the receiver the bundle appears in the incoming list. Load it as above.

**Option C, synced folder**

Set a sync folder on both PCs pointing at the same shared or synced location
(Dropzone, a network share, OneDrive). Every interval the sender captures what
changed. The receiver loads from that folder's bundles.

## Merge

Loading a session whose transcript already exists here **merges** by default:
existing lines are kept, incoming lines not yet present are appended, keyed by
each message's id. So a session can go PC A → PC B, continue on B, come back to
A, and nothing is lost. Overwrite replaces files outright. With neither, only
missing files are added.

## Command line

```
python cst.py serve [--host 0.0.0.0] [--port 8765] [--no-browser]
python cst.py gui
python cst.py list [--account ID] [--all]
python cst.py capture --account ID --ids ID... --out bundle.zip [--memory] [--project] [--settings]
python cst.py load bundle.zip --account ID [--device ID] [--ids ID...] [--map OLD=NEW]...
                              [--overwrite] [--new-id] [--memory] [--project] [--settings] [--dry-run]
python cst.py sync --account ID --dir FOLDER
python cst.py push bundle.zip --url http://PC:8765 --token TOKEN
python cst.py export --account ID --id ID [--fmt md|html] > file
python cst.py scan --account ID --id ID
```

Ids can be the first few characters of a session id or account id.

## How the app stores a session

Windows paths shown; macOS and Linux locations are handled too.

```
%APPDATA%\Claude\claude-code-sessions\<account-id>\<device-id>\local_<id>.json
    sidebar record; "cliSessionId" points at the transcript

%USERPROFILE%\.claude\projects\<cwd-slug>\<cliSessionId>.jsonl
    the conversation itself, one JSON object per line

%USERPROFILE%\.claude\projects\<cwd-slug>\<cliSessionId>\
    custom title, subagent transcripts

%USERPROFILE%\.claude\projects\<cwd-slug>\memory\
    Claude's persistent memory for that project folder
```

`<cwd-slug>` is the working directory with every non-alphanumeric character
replaced by a dash, e.g. `D:\physical_ai` → `D--physical-ai`.

The tool's own state (config, peer token, incoming bundles, trash) lives in
`~/.claude-session-transfer/`. Backups go to
`%APPDATA%\Claude\claude-code-sessions-backups\`, beside the store, not inside it.

## Bundle layout

```
manifest.json
sessions/<cliSessionId>/record.json
sessions/<cliSessionId>/transcript.jsonl
sessions/<cliSessionId>/extra/...          title + subagent files
memory/<cwd-slug>/...                      optional
project/<cwd-slug>/CLAUDE.md, .claude/...  optional
settings/settings.json, settings/CLAUDE.md optional
```

## Layout of this repo

```
cst.py                     command line entry point
cst/core.py                all logic: discovery, transfer, capture, load, merge, export, scan, backups, sync, peers
cst/web.py                 local HTTP server and JSON API
cst/static/index.html      the web UI, single file, dark mode by system preference
cst/static/capture.html    browser-side capture page: reads a .claude folder, builds the zip in the browser
claude_session_transfer.py tkinter window, thin wrapper over cst/core.py
```

## Caveats

- This relies on an undocumented on-disk layout. An app update could change it.
  Backups are written before every change.
- Close the Claude app before loading or transferring. It may overwrite changes
  made while open. The UI warns when it is running.
- A **copy** between accounts leaves both pointing at the same transcript file.
  Continuing the chat from both sides interleaves into one file. Use **move**
  if you want to keep working on it in the other account.
- Binding to `0.0.0.0` exposes the whole UI on the LAN, not only the peer
  endpoint. Do it only on networks you trust.
- `settings.json` can hold keys. Including it in a bundle is off by default.
  Run the secret scan before sharing a bundle.
- Never copy `.credentials.json` between accounts or machines.

Testing overrides: `CLAUDE_APP_DIR`, `CLAUDE_HOME_DIR`, and `CST_CONFIG` point
the tool at a throwaway store.
