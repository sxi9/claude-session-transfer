"""Local web server and JSON API for Claude Session Transfer.

    python cst.py serve                 # http://127.0.0.1:8765
    python cst.py serve --host 0.0.0.0  # reachable from other PCs (peer push)

Standard library only (http.server). The UI is cst/static/index.html.

Security model: the UI and all /api/* routes are meant for localhost. When
bound to a LAN address, only /api/peer/* is intended for other machines and it
requires the peer token shown in Settings. Everything else still answers on
the LAN, so bind to 0.0.0.0 only on networks you trust.
"""

from __future__ import annotations

import json
import mimetypes
import threading
import time
import traceback
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from . import __version__, core

STATIC = Path(__file__).parent / "static"


# ----------------------------------------------------------------------------
# background sync
# ----------------------------------------------------------------------------

class SyncWorker(threading.Thread):
    def __init__(self):
        super().__init__(daemon=True)
        self.last_log: list[str] = []
        self.stop = threading.Event()

    def run(self):
        while not self.stop.wait(30):
            try:
                cfg = core.load_tool_config()
                s = cfg["sync"]
                if not (s.get("enabled") and s.get("dir") and s.get("account")):
                    continue
                due = s.get("last_run", 0) + max(1, int(s.get("interval_min", 60))) * 60
                if time.time() < due:
                    continue
                out, log = core.sync_once(s["account"], Path(s["dir"]), since=s.get("last_run", 0))
                s["last_run"] = time.time()
                cfg["sync"] = s
                core.save_tool_config(cfg)
                self.last_log = [time.strftime("%Y-%m-%d %H:%M")] + log
            except Exception as e:  # noqa: BLE001
                self.last_log = [f"sync error: {e}"]


SYNC = SyncWorker()


# ----------------------------------------------------------------------------
# request handler
# ----------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = f"cst/{__version__}"

    def log_message(self, fmt, *args):  # quieter console
        if "/api/" in (args[0] if args else ""):
            return
        super().log_message(fmt, *args)

    # helpers --------------------------------------------------------------
    def _json(self, obj, status=200):
        data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(data)

    def _bytes(self, data: bytes, ctype: str, filename: str | None = None):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        if filename:
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.end_headers()
        self.wfile.write(data)

    def _body(self) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(n) if n else b""

    def _body_json(self) -> dict:
        raw = self._body()
        return json.loads(raw.decode("utf-8")) if raw else {}

    def _is_local(self) -> bool:
        return self.client_address[0] in ("127.0.0.1", "::1")

    # routing --------------------------------------------------------------
    def do_GET(self):
        u = urllib.parse.urlsplit(self.path)
        q = dict(urllib.parse.parse_qsl(u.query))
        try:
            if u.path == "/" or u.path == "/index.html":
                return self._static("index.html")
            if u.path == "/capture":
                return self._static("capture.html")
            if u.path.startswith("/static/"):
                return self._static(u.path[len("/static/"):])
            if u.path == "/api/peer/info":
                return self._json({"tool": "claude-session-transfer", "version": __version__,
                                   "machine": core.platform.node(), "accepts": "bundle"})
            if not u.path.startswith("/api/"):
                return self._json({"error": "not found"}, 404)
            return self._api_get(u.path, q)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def do_POST(self):
        u = urllib.parse.urlsplit(self.path)
        try:
            if u.path == "/api/peer/receive":
                return self._peer_receive()
            if not u.path.startswith("/api/"):
                return self._json({"error": "not found"}, 404)
            return self._api_post(u.path)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            self._json({"error": str(e)}, 500)

    def _static(self, name: str):
        p = (STATIC / name).resolve()
        if STATIC.resolve() not in p.parents or not p.is_file():
            return self._json({"error": "not found"}, 404)
        ctype = mimetypes.guess_type(str(p))[0] or "application/octet-stream"
        if ctype.startswith("text/"):
            ctype += "; charset=utf-8"
        self._bytes(p.read_bytes(), ctype)

    # GET API --------------------------------------------------------------
    def _api_get(self, path: str, q: dict):
        if path == "/api/state":
            cfg = core.load_tool_config()
            accounts = []
            for a in core.discover():
                accounts.append({"id": a.id, "label": core.account_label(a.id, cfg),
                                 "device": a.device_folder.name, "sessions": [s.to_dict() for s in a.sessions]})
            return self._json({
                "version": __version__, "accounts": accounts, "current": core.current_account_id(),
                "deviceHint": core.device_id_hint(), "appRunning": core.claude_app_running(),
                "store": str(core.sessions_root()), "projects": str(core.projects_root()),
                "incomingDir": str(core.incoming_dir()), "labels": cfg.get("labels", {}),
                "peerToken": cfg.get("peer_token", ""), "sync": cfg.get("sync", {}),
                "syncLog": SYNC.last_log, "platform": core.sys.platform,
            })
        if path == "/api/preview":
            s = core.find_sessions(q["account"], [q["id"]])
            return self._json(core.preview(s[0]) if s else {"error": "not found"})
        if path == "/api/export":
            s = core.find_sessions(q["account"], [q["id"]])
            if not s:
                return self._json({"error": "not found"}, 404)
            s = s[0]
            safe = "".join(c if c.isalnum() or c in " -_" else "_" for c in s.title)[:60].strip() or s.cli_id
            if q.get("fmt") == "html":
                return self._bytes(core.export_html(s).encode("utf-8"), "text/html; charset=utf-8", f"{safe}.html")
            if q.get("fmt") == "jsonl":
                return self._bytes(s.transcript.read_bytes(), "application/jsonl", f"{s.cli_id}.jsonl")
            return self._bytes(core.export_markdown(s).encode("utf-8"), "text/markdown; charset=utf-8", f"{safe}.md")
        if path == "/api/scan":
            s = core.find_sessions(q["account"], [q["id"]])
            if not s or not s[0].transcript.exists():
                return self._json({"hits": []})
            return self._json({"hits": core.scan_secrets(s[0].transcript.read_bytes())})
        if path == "/api/backups":
            return self._json({"backups": core.list_backups()})
        if path == "/api/bundles":
            return self._json({"bundles": core.list_bundles()})
        if path == "/api/bundle":
            p = Path(q["path"])
            m = core.read_manifest(p)
            cwds = sorted({e["cwd"] for e in m["sessions"]} | {x["cwd"] for x in m["memory"]} |
                          {x["cwd"] for x in m["project"]})
            m["cwdStatus"] = {c: Path(c).is_dir() for c in cwds}
            return self._json(m)
        if path == "/api/peer/check":
            return self._json(core.peer_info(q["url"]))
        return self._json({"error": "unknown endpoint"}, 404)

    # POST API -------------------------------------------------------------
    def _api_post(self, path: str):
        if path == "/api/upload":
            name = self.headers.get("X-Bundle-Name") or "upload.zip"
            dst = core.save_incoming(self._body(), name)
            return self._json({"path": str(dst), "manifest": core.read_manifest(dst)})

        b = self._body_json()
        dry = bool(b.get("dryRun"))

        if path == "/api/transfer":
            src = core.find_sessions(b["source"], b["ids"])
            dst = core.find_account(b["target"])
            if not dst:
                return self._json({"error": "target account not found"}, 400)
            bk = None if dry else core.backup_folder(dst.device_folder)
            if b.get("move") and not dry:
                srcacc = core.find_account(b["source"])
                if srcacc:
                    core.backup_folder(srcacc.device_folder)
            log = core.transfer(src, dst, bool(b.get("move")), bool(b.get("newId")), dry_run=dry)
            return self._json({"log": log, "backup": str(bk) if bk else None})

        if path == "/api/capture":
            src = core.find_sessions(b["account"], b["ids"])
            if not src:
                return self._json({"error": "no sessions"}, 400)
            name = f"claude-bundle-{time.strftime('%Y%m%d-%H%M%S')}.zip"
            out = Path(b["outDir"]) / name if b.get("outDir") else core.incoming_dir() / name
            log = core.capture(src, out, bool(b.get("memory", True)), bool(b.get("settings")),
                               bool(b.get("project")))
            return self._json({"log": log, "path": str(out), "name": name})

        if path == "/api/download":
            data = Path(b["path"]).read_bytes()
            return self._bytes(data, "application/zip", Path(b["path"]).name)

        if path == "/api/load":
            acc, dev = b["account"], b["device"]
            bk = None if dry else core.backup_folder(core.sessions_root() / acc / dev)
            log = core.load(Path(b["path"]), b["ids"], acc, dev, b.get("cwdMap") or {},
                            bool(b.get("newId")), bool(b.get("overwrite")), bool(b.get("merge", True)),
                            bool(b.get("memory", True)), bool(b.get("project")), bool(b.get("settings")),
                            dry_run=dry)
            return self._json({"log": log, "backup": str(bk) if bk else None})

        if path == "/api/delete":
            src = core.find_sessions(b["account"], b["ids"])
            if not dry:
                acc = core.find_account(b["account"])
                if acc:
                    core.backup_folder(acc.device_folder)
            return self._json({"log": core.delete_sessions(src, bool(b.get("transcript")), dry_run=dry)})

        if path == "/api/restore":
            return self._json({"log": core.restore_backup(b["path"], dry_run=dry)})

        if path == "/api/labels":
            cfg = core.load_tool_config()
            cfg["labels"] = {k: v for k, v in (b.get("labels") or {}).items() if v}
            core.save_tool_config(cfg)
            return self._json({"ok": True})

        if path == "/api/sync":
            cfg = core.load_tool_config()
            s = cfg["sync"]
            for k in ("enabled", "dir", "account", "interval_min"):
                if k in b:
                    s[k] = b[k]
            if b.get("runNow"):
                out, log = core.sync_once(s["account"], Path(s["dir"]), since=s.get("last_run", 0))
                s["last_run"] = time.time()
                SYNC.last_log = [time.strftime("%Y-%m-%d %H:%M")] + log
            cfg["sync"] = s
            core.save_tool_config(cfg)
            return self._json({"sync": s, "log": SYNC.last_log})

        if path == "/api/push":
            reply = core.push_bundle(Path(b["path"]), b["url"], b["token"])
            return self._json({"reply": reply})

        if path == "/api/delete-bundle":
            p = Path(b["path"])
            if p.parent.resolve() != core.incoming_dir().resolve():
                return self._json({"error": "only bundles in the incoming folder can be deleted"}, 400)
            p.unlink()
            return self._json({"ok": True})

        return self._json({"error": "unknown endpoint"}, 404)

    # peer -----------------------------------------------------------------
    def _peer_receive(self):
        cfg = core.load_tool_config()
        if self.headers.get("X-Peer-Token") != cfg.get("peer_token"):
            return self._json({"error": "bad peer token"}, 403)
        name = self.headers.get("X-Bundle-Name") or "peer.zip"
        dst = core.save_incoming(self._body(), name)
        m = core.read_manifest(dst)
        return self._json({"ok": True, "saved": str(dst), "sessions": len(m["sessions"]),
                           "machine": core.platform.node()})


def serve(host: str = "127.0.0.1", port: int = 8765, open_browser: bool = True):
    core.load_tool_config()  # creates the peer token on first run
    core.incoming_dir().mkdir(parents=True, exist_ok=True)
    SYNC.start()
    srv = ThreadingHTTPServer((host, port), Handler)
    url = f"http://{'127.0.0.1' if host in ('0.0.0.0', '::') else host}:{port}"
    print(f"Claude Session Transfer {__version__}  ->  {url}")
    if host in ("0.0.0.0", "::"):
        print("LAN mode: other PCs can push bundles to this one using the peer token shown in Settings.")
    if open_browser:
        import webbrowser
        threading.Timer(0.6, lambda: webbrowser.open(url)).start()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        srv.server_close()
