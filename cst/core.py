"""Core library for Claude Desktop session transfer.

Pure standard library. Everything the web UI, CLI and tkinter GUI do goes
through here, so it is also usable as a plain Python module.

On-disk layout (Windows paths; macOS/Linux handled too):
  %APPDATA%\\Claude\\claude-code-sessions\\<account-id>\\<device-id>\\local_<id>.json
      sidebar record; "cliSessionId" points at the transcript
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\<cliSessionId>.jsonl
      the conversation itself (one JSON object per line)
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\<cliSessionId>\\
      custom title, subagent transcripts
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\memory\\
      Claude's persistent memory for that project folder

Bundle layout (zip):
  manifest.json
  sessions/<cliSessionId>/record.json
  sessions/<cliSessionId>/transcript.jsonl
  sessions/<cliSessionId>/extra/...          title + subagent files
  memory/<cwd-slug>/...                      optional
  project/<cwd-slug>/CLAUDE.md, .claude/...  optional
  settings/settings.json, settings/CLAUDE.md optional

Environment overrides for testing: CLAUDE_APP_DIR, CLAUDE_HOME_DIR, CST_CONFIG.
"""

from __future__ import annotations

import hashlib
import html
import json
import os
import platform
import re
import secrets
import shutil
import subprocess
import sys
import time
import uuid
import zipfile
from datetime import datetime
from pathlib import Path

BUNDLE_VERSION = 2


# ----------------------------------------------------------------------------
# locations
# ----------------------------------------------------------------------------

def app_data_dir() -> Path:
    if os.environ.get("CLAUDE_APP_DIR"):
        return Path(os.environ["CLAUDE_APP_DIR"])
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / "Claude"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "Claude"
    return Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config")) / "Claude"


def claude_home() -> Path:
    if os.environ.get("CLAUDE_HOME_DIR"):
        return Path(os.environ["CLAUDE_HOME_DIR"])
    return Path.home() / ".claude"


def sessions_root() -> Path:
    return app_data_dir() / "claude-code-sessions"


def backups_root() -> Path:
    return app_data_dir() / "claude-code-sessions-backups"


def projects_root() -> Path:
    return claude_home() / "projects"


def config_file() -> Path:
    return app_data_dir() / "config.json"


def tool_dir() -> Path:
    """Where this tool keeps its own state: config, incoming bundles, trash."""
    if os.environ.get("CST_CONFIG"):
        return Path(os.environ["CST_CONFIG"])
    return Path.home() / ".claude-session-transfer"


def incoming_dir() -> Path:
    return tool_dir() / "incoming"


def trash_dir() -> Path:
    return tool_dir() / "trash"


def cwd_slug(cwd: str) -> str:
    """Claude Code names the project folder by replacing every non
    alphanumeric character of the working directory with a dash."""
    return "".join(ch if ch.isalnum() else "-" for ch in cwd)


def read_config() -> dict:
    try:
        return json.loads(config_file().read_text("utf-8"))
    except Exception:
        return {}


def current_account_id() -> str | None:
    return read_config().get("lastKnownAccountUuid")


def device_id_hint() -> str | None:
    for k in read_config():
        if k.startswith("dxt:allowlistEnabled:"):
            return k.split(":", 2)[2]
    root = sessions_root()
    if root.exists():
        for acc in root.glob("*/*"):
            if acc.is_dir():
                return acc.name
    return None


def claude_app_running() -> bool:
    try:
        if sys.platform == "win32":
            out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq claude.exe", "/NH"],
                                 capture_output=True, text=True, timeout=10).stdout
            return "claude.exe" in out.lower()
        # exact process name only; a looser pattern matches this check's own command line
        out = subprocess.run(["pgrep", "-xi", "claude"], capture_output=True, text=True, timeout=10).stdout
        return bool(out.strip())
    except Exception:
        return False


# ----------------------------------------------------------------------------
# tool config (labels, peer token, sync settings)
# ----------------------------------------------------------------------------

DEFAULT_CONFIG = {
    "labels": {},            # account id -> friendly name
    "peer_token": "",        # required for pushes from other PCs
    "sync": {"enabled": False, "dir": "", "account": "", "interval_min": 60, "last_run": 0},
}


def load_tool_config() -> dict:
    p = tool_dir() / "config.json"
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    try:
        cfg.update(json.loads(p.read_text("utf-8")))
    except Exception:
        pass
    if not cfg.get("peer_token"):
        cfg["peer_token"] = secrets.token_urlsafe(18)
        save_tool_config(cfg)
    return cfg


def save_tool_config(cfg: dict) -> None:
    tool_dir().mkdir(parents=True, exist_ok=True)
    (tool_dir() / "config.json").write_text(json.dumps(cfg, indent=2), encoding="utf-8")


def account_label(account_id: str, cfg: dict | None = None) -> str:
    cfg = cfg or load_tool_config()
    return cfg.get("labels", {}).get(account_id) or account_id[:8] + "…"


# ----------------------------------------------------------------------------
# model
# ----------------------------------------------------------------------------

class Session:
    def __init__(self, record_file: Path | None, account: str, device: str, data: dict | None = None):
        self.file = record_file
        self.account = account
        self.device = device
        self.data = data if data is not None else json.loads(record_file.read_text("utf-8"))

    @property
    def id(self) -> str:
        return self.data.get("sessionId") or (self.file.stem if self.file else "")

    @property
    def cli_id(self) -> str:
        return self.data.get("cliSessionId", "")

    @property
    def title(self) -> str:
        return self.data.get("title") or "(untitled)"

    @property
    def cwd(self) -> str:
        return self.data.get("cwd", "")

    @property
    def archived(self) -> bool:
        return bool(self.data.get("isArchived"))

    @property
    def last_activity_ms(self) -> int:
        return int(self.data.get("lastActivityAt") or self.data.get("createdAt") or 0)

    @property
    def last_activity(self) -> str:
        ms = self.last_activity_ms
        return datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else ""

    @property
    def project_dir(self) -> Path:
        return projects_root() / cwd_slug(self.cwd)

    @property
    def transcript(self) -> Path:
        return self.project_dir / f"{self.cli_id}.jsonl"

    @property
    def extra_dir(self) -> Path:
        return self.project_dir / self.cli_id

    @property
    def transcript_size_kb(self) -> int:
        try:
            return self.transcript.stat().st_size // 1024
        except OSError:
            return -1

    @property
    def transcript_mtime(self) -> float:
        try:
            return self.transcript.stat().st_mtime
        except OSError:
            return 0.0

    def to_dict(self) -> dict:
        return {
            "id": self.id, "cliId": self.cli_id, "title": self.title, "cwd": self.cwd,
            "archived": self.archived, "lastActivity": self.last_activity,
            "lastActivityMs": self.last_activity_ms, "sizeKB": self.transcript_size_kb,
            "hasTranscript": self.transcript.exists(), "model": self.data.get("model", ""),
            "account": self.account, "device": self.device,
        }


class Account:
    def __init__(self, folder: Path):
        self.folder = folder
        self.id = folder.name
        self.devices = [d for d in folder.iterdir() if d.is_dir()]
        self.sessions: list[Session] = []
        for dev in self.devices:
            for f in sorted(dev.glob("local_*.json")):
                try:
                    self.sessions.append(Session(f, self.id, dev.name))
                except Exception:
                    pass
        self.sessions.sort(key=lambda s: s.last_activity_ms, reverse=True)

    @property
    def device_folder(self) -> Path:
        if self.devices:
            return self.devices[0]
        return self.folder / (device_id_hint() or "unknown-device")

    def find(self, session_id: str) -> Session | None:
        return next((s for s in self.sessions if s.id == session_id or s.cli_id == session_id), None)


def discover() -> list[Account]:
    root = sessions_root()
    if not root.exists():
        return []
    return [Account(d) for d in sorted(root.iterdir()) if d.is_dir()]


def find_account(account_id: str) -> Account | None:
    return next((a for a in discover() if a.id == account_id), None)


def find_sessions(account_id: str, ids: list[str]) -> list[Session]:
    acc = find_account(account_id)
    if not acc:
        return []
    out = []
    for i in ids:
        s = acc.find(i)
        if s:
            out.append(s)
    return out


# ----------------------------------------------------------------------------
# backups
# ----------------------------------------------------------------------------

def backup_folder(folder: Path) -> Path | None:
    """Copy a device folder to the backups area OUTSIDE the session store, so
    the app never mistakes the backup for another device."""
    if not folder.exists():
        return None
    base = backups_root() / folder.parent.name / f"{folder.name}-{time.strftime('%Y%m%d-%H%M%S')}"
    dest, i = base, 1
    while dest.exists():
        dest = base.with_name(f"{base.name}-{i}")
        i += 1
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(folder, dest)
    return dest


def _backup_device(name: str) -> str:
    """'<device>-YYYYMMDD-HHMMSS[-n]' -> '<device>'"""
    return re.sub(r"-\d{8}-\d{6}(?:-\d+)?$", "", name)


def list_backups() -> list[dict]:
    out = []
    root = backups_root()
    if not root.exists():
        return out
    for acc in sorted(root.iterdir()):
        if not acc.is_dir():
            continue
        for b in sorted(acc.iterdir(), reverse=True):
            if b.is_dir():
                n = len(list(b.glob("local_*.json")))
                device = _backup_device(b.name)
                out.append({"path": str(b), "account": acc.name, "device": device,
                            "name": b.name, "records": n,
                            "created": datetime.fromtimestamp(b.stat().st_mtime).strftime("%Y-%m-%d %H:%M")})
    return out


def restore_backup(backup_path: str, dry_run: bool = False) -> list[str]:
    """Put a device-folder backup back. The current folder is backed up first."""
    b = Path(backup_path)
    if not b.is_dir() or backups_root() not in b.parents:
        raise ValueError("Not a backup folder made by this tool")
    account = b.parent.name
    device = _backup_device(b.name)
    target = sessions_root() / account / device
    log = [f"Restore {b.name} -> {target}"]
    if dry_run:
        log.append(f"DRY RUN: would replace {len(list(target.glob('local_*.json'))) if target.exists() else 0} "
                   f"records with {len(list(b.glob('local_*.json')))}")
        return log
    bk = backup_folder(target)
    if target.exists():
        shutil.rmtree(target)
    shutil.copytree(b, target)
    log.append(f"Restored. Previous state saved to {bk}")
    return log


# ----------------------------------------------------------------------------
# transcript reading: preview, export, secrets, merge
# ----------------------------------------------------------------------------

def iter_lines(raw: bytes):
    for line in raw.decode("utf-8", "replace").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            yield json.loads(line), line
        except Exception:
            yield None, line


def _text_of(message: dict) -> str:
    content = message.get("content")
    if isinstance(content, str):
        return content
    parts = []
    for block in content or []:
        if not isinstance(block, dict):
            continue
        t = block.get("type")
        if t == "text":
            parts.append(block.get("text", ""))
        elif t == "tool_use":
            parts.append(f"[tool: {block.get('name')}]")
        elif t == "tool_result":
            c = block.get("content")
            if isinstance(c, str):
                parts.append(f"[result] {c[:400]}")
            elif isinstance(c, list):
                parts.append("[result] " + " ".join(x.get("text", "")[:400] for x in c if isinstance(x, dict)))
    return "\n".join(p for p in parts if p)


def conversation(session: Session) -> list[dict]:
    """[{role, text, time}] for user and assistant turns, in order."""
    if not session.transcript.exists():
        return []
    out = []
    for obj, _ in iter_lines(session.transcript.read_bytes()):
        if not obj or obj.get("type") not in ("user", "assistant"):
            continue
        msg = obj.get("message") or {}
        text = _text_of(msg).strip()
        if not text or text.startswith("<system-reminder>") and obj["type"] == "user" and len(text) < 20:
            continue
        out.append({"role": obj["type"], "text": text, "time": obj.get("timestamp", "")})
    return out


def preview(session: Session, limit: int = 600) -> dict:
    conv = conversation(session)
    users = [c for c in conv if c["role"] == "user" and not c["text"].startswith("[result]")]
    assistants = [c for c in conv if c["role"] == "assistant"]
    spoken = [c for c in assistants if not c["text"].startswith("[tool:")] or assistants
    return {
        "turns": len(conv), "userTurns": len(users), "assistantTurns": len(assistants),
        "first": users[0]["text"][:limit] if users else "",
        "last": spoken[-1]["text"][-limit:] if spoken else "",
    }


def export_markdown(session: Session) -> str:
    lines = [f"# {session.title}", "",
             f"- Working folder: `{session.cwd}`", f"- Last activity: {session.last_activity}",
             f"- Session: `{session.cli_id}`", "", "---", ""]
    for c in conversation(session):
        who = "**You**" if c["role"] == "user" else "**Claude**"
        lines += [f"{who}  <sub>{c['time'][:19].replace('T', ' ')}</sub>", "", c["text"], "", "---", ""]
    return "\n".join(lines)


def export_html(session: Session) -> str:
    rows = []
    for c in conversation(session):
        cls = "u" if c["role"] == "user" else "a"
        rows.append(f'<div class="m {cls}"><div class="who">{"You" if cls == "u" else "Claude"}'
                    f'<span>{html.escape(c["time"][:19].replace("T", " "))}</span></div>'
                    f'<pre>{html.escape(c["text"])}</pre></div>')
    return f"""<!doctype html><html><head><meta charset="utf-8"><title>{html.escape(session.title)}</title>
<style>body{{font:15px/1.5 system-ui,sans-serif;max-width:900px;margin:32px auto;padding:0 16px;color:#222;background:#fafafa}}
h1{{font-size:22px}} .meta{{color:#666;font-size:13px}} .m{{margin:14px 0;padding:12px 16px;border-radius:10px}}
.u{{background:#e8f0fe}} .a{{background:#fff;border:1px solid #e3e3e3}} .who{{font-weight:600;margin-bottom:6px}}
.who span{{font-weight:400;color:#888;font-size:12px;margin-left:8px}} pre{{white-space:pre-wrap;margin:0;font:inherit}}
@media(prefers-color-scheme:dark){{body{{background:#111;color:#ddd}}.u{{background:#1d2a44}}.a{{background:#1b1b1b;border-color:#333}}}}
</style></head><body><h1>{html.escape(session.title)}</h1>
<p class="meta">{html.escape(session.cwd)} · {session.last_activity} · {session.cli_id}</p>{"".join(rows)}</body></html>"""


SECRET_PATTERNS = [
    ("Anthropic API key", re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}")),
    ("OpenAI-style key", re.compile(r"\bsk-[A-Za-z0-9]{32,}\b")),
    ("GitHub token", re.compile(r"\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b")),
    ("AWS access key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("Slack token", re.compile(r"\bxox[baprs]-[A-Za-z0-9\-]{10,}\b")),
    ("Google API key", re.compile(r"\bAIza[0-9A-Za-z_\-]{35}\b")),
    ("Bearer token", re.compile(r"Bearer\s+[A-Za-z0-9_\-\.=]{24,}")),
    ("Private key block", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----")),
    ("Password assignment", re.compile(r"(?i)\b(?:password|passwd|pwd)\s*[:=]\s*['\"]?[^\s'\"]{6,}")),
    ("Telegram bot token", re.compile(r"\b\d{8,10}:[A-Za-z0-9_\-]{35}\b")),
    ("JWT", re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.eyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b")),
]


def scan_secrets(raw: bytes, max_hits: int = 50) -> list[dict]:
    text = raw.decode("utf-8", "replace")
    hits = []
    for name, rx in SECRET_PATTERNS:
        for m in rx.finditer(text):
            s = m.group(0)
            shown = s[:6] + "…" + s[-4:] if len(s) > 14 else s[:3] + "…"
            line_no = text.count("\n", 0, m.start()) + 1
            hits.append({"kind": name, "sample": shown, "line": line_no})
            if len(hits) >= max_hits:
                return hits
    return hits


def _line_key(obj: dict | None, raw: str) -> str:
    if obj and obj.get("uuid"):
        return "u:" + obj["uuid"]
    return "h:" + hashlib.sha1(raw.encode("utf-8")).hexdigest()


def merge_transcripts(existing: bytes, incoming: bytes) -> tuple[bytes, int]:
    """Union of two transcripts of the same session. Existing lines are kept in
    order; incoming lines not already present are appended in their order.
    Returns (merged bytes, number of lines added)."""
    seen = set()
    out = []
    for obj, raw in iter_lines(existing):
        seen.add(_line_key(obj, raw))
        out.append(raw)
    added = 0
    for obj, raw in iter_lines(incoming):
        k = _line_key(obj, raw)
        if k in seen:
            continue
        seen.add(k)
        out.append(raw)
        added += 1
    return ("\n".join(out) + "\n").encode("utf-8"), added


def remap_transcript(raw: bytes, old: str, new: str) -> bytes:
    if old == new:
        return raw
    out = []
    for obj, raw_line in iter_lines(raw):
        if obj and isinstance(obj, dict) and obj.get("cwd") == old:
            obj["cwd"] = new
            raw_line = json.dumps(obj, ensure_ascii=False)
        out.append(raw_line)
    return ("\n".join(out) + "\n").encode("utf-8")


# ----------------------------------------------------------------------------
# same-PC transfer, delete
# ----------------------------------------------------------------------------

def transfer(sessions: list[Session], target: Account, move: bool, new_id: bool,
             dry_run: bool = False) -> list[str]:
    log = []
    dest_dir = target.device_folder
    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
    for s in sessions:
        data = dict(s.data)
        if new_id:
            data["sessionId"] = f"local_{uuid.uuid4()}"
        dest = dest_dir / f"{data['sessionId']}.json"
        if dest.exists():
            log.append(f"SKIP  {s.title!r}: already exists in target")
            continue
        verb = "MOVE" if move else "COPY"
        note = "" if s.transcript.exists() else "  (warning: transcript file not found)"
        if dry_run:
            log.append(f"DRY {verb} {s.title!r} -> {dest}{note}")
            continue
        dest.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        if move and s.file:
            s.file.unlink()
        log.append(f"{verb}D {s.title!r} -> {dest.name}{note}")
    return log


def delete_sessions(sessions: list[Session], delete_transcript: bool, dry_run: bool = False) -> list[str]:
    """Remove sidebar records (and optionally transcripts). Everything goes to
    the tool's trash folder first, so it can be put back by hand."""
    log = []
    stamp = time.strftime("%Y%m%d-%H%M%S")
    for s in sessions:
        t = trash_dir() / stamp / s.id
        items = [s.file] if s.file else []
        if delete_transcript:
            if s.transcript.exists():
                items.append(s.transcript)
            if s.extra_dir.is_dir():
                items.append(s.extra_dir)
        if dry_run:
            log.append(f"DRY DELETE {s.title!r}: " + ", ".join(str(i) for i in items))
            continue
        t.mkdir(parents=True, exist_ok=True)
        for i in items:
            shutil.move(str(i), str(t / i.name))
        log.append(f"DELETED {s.title!r} ({len(items)} item(s)) -> trash {t}")
    return log


# ----------------------------------------------------------------------------
# capture (export bundle)
# ----------------------------------------------------------------------------

def project_files(cwd: str) -> list[Path]:
    """Project-level Claude files worth carrying: CLAUDE.md and .claude/."""
    root = Path(cwd)
    out = []
    if not root.is_dir():
        return out
    for name in ("CLAUDE.md", "CLAUDE.local.md"):
        p = root / name
        if p.is_file():
            out.append(p)
    d = root / ".claude"
    if d.is_dir():
        out += [p for p in d.rglob("*") if p.is_file() and p.stat().st_size < 2_000_000]
    return out


def capture(sessions: list[Session], out_zip: Path, include_memory: bool = True,
            include_settings: bool = False, include_project: bool = False) -> list[str]:
    log = []
    manifest = {
        "bundleVersion": BUNDLE_VERSION,
        "createdAt": datetime.now().isoformat(timespec="seconds"),
        "sourceMachine": platform.node(), "sourcePlatform": sys.platform,
        "sourceAccount": sessions[0].account if sessions else None,
        "sessions": [], "memory": [], "project": [], "settings": [],
    }
    out_zip.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as z:
        slugs_done: set[str] = set()
        for s in sessions:
            if not s.cli_id:
                log.append(f"SKIP {s.title!r}: never started a transcript")
                continue
            base = f"sessions/{s.cli_id}"
            z.writestr(f"{base}/record.json", json.dumps(s.data, ensure_ascii=False))
            has_transcript = s.transcript.exists()
            if has_transcript:
                z.write(s.transcript, f"{base}/transcript.jsonl")
            if s.extra_dir.is_dir():
                for p in s.extra_dir.rglob("*"):
                    if p.is_file():
                        z.write(p, f"{base}/extra/{p.relative_to(s.extra_dir).as_posix()}")
            manifest["sessions"].append({
                "cliSessionId": s.cli_id, "sessionId": s.id, "title": s.title, "cwd": s.cwd,
                "lastActivityAt": s.last_activity_ms, "hasTranscript": has_transcript,
                "transcriptKB": max(s.transcript_size_kb, 0),
            })
            log.append(f"PACKED {s.title!r}" + ("" if has_transcript else " (no transcript)"))
            slug = cwd_slug(s.cwd)
            if slug in slugs_done:
                continue
            slugs_done.add(slug)
            if include_memory:
                mem = s.project_dir / "memory"
                if mem.is_dir():
                    n = 0
                    for p in mem.rglob("*"):
                        if p.is_file():
                            z.write(p, f"memory/{slug}/{p.relative_to(mem).as_posix()}")
                            n += 1
                    manifest["memory"].append({"cwd": s.cwd, "slug": slug, "files": n})
                    log.append(f"MEMORY {s.cwd}: {n} files")
            if include_project:
                files = project_files(s.cwd)
                for p in files:
                    z.write(p, f"project/{slug}/{p.relative_to(s.cwd).as_posix()}")
                if files:
                    manifest["project"].append({"cwd": s.cwd, "slug": slug, "files": len(files)})
                    log.append(f"PROJECT {s.cwd}: {len(files)} files")
        if include_settings:
            for name in ("settings.json", "CLAUDE.md"):
                p = claude_home() / name
                if p.is_file():
                    z.write(p, f"settings/{name}")
                    manifest["settings"].append(name)
                    log.append(f"SETTINGS {name}")
        z.writestr("manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    log.append(f"Bundle written: {out_zip} ({out_zip.stat().st_size // 1024} KB)")
    return log


# ----------------------------------------------------------------------------
# load (import bundle)
# ----------------------------------------------------------------------------

def read_manifest(bundle: Path) -> dict:
    with zipfile.ZipFile(bundle) as z:
        m = json.loads(z.read("manifest.json"))
    m.setdefault("memory", []), m.setdefault("project", []), m.setdefault("settings", [])
    return m


def _write(dst: Path, data: bytes):
    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_bytes(data)


def synthesize_record(transcript: bytes, cli_id: str, title: str | None = None) -> dict:
    """Build a sidebar record from a transcript alone. Used for bundles made in
    the browser, where the AppData records are not reachable."""
    cwd = ""
    first_user = ""
    model = ""
    first_ts = last_ts = None
    turns = 0
    for obj, _ in iter_lines(transcript):
        if not obj:
            continue
        if not cwd and obj.get("cwd"):
            cwd = obj["cwd"]
        if obj.get("type") == "custom-title" and obj.get("customTitle"):
            title = title or obj["customTitle"]
        ts = obj.get("timestamp")
        if ts:
            first_ts = first_ts or ts
            last_ts = ts
        t = obj.get("type")
        if t == "user":
            turns += 1
            if not first_user:
                txt = _text_of(obj.get("message") or {}).strip()
                if txt and not txt.startswith("<"):
                    first_user = txt
        elif t == "assistant" and not model:
            model = (obj.get("message") or {}).get("model", "")

    def ms(iso):
        if not iso:
            return int(time.time() * 1000)
        try:
            return int(datetime.fromisoformat(iso.replace("Z", "+00:00")).timestamp() * 1000)
        except Exception:
            return int(time.time() * 1000)

    auto_title = (first_user.splitlines()[0][:80] if first_user else "") or f"Imported {cli_id[:8]}"
    return {
        "sessionId": f"local_{uuid.uuid4()}", "cliSessionId": cli_id,
        "cwd": cwd, "originCwd": cwd, "gitAnchorsFolderRealpath": cwd,
        "createdAt": ms(first_ts), "lastActivityAt": ms(last_ts), "lastFocusedAt": ms(last_ts),
        "lastTurnEdgeAt": ms(last_ts), "model": model, "effort": "medium", "isArchived": False,
        "title": title or auto_title, "titleSource": "custom" if title else "auto",
        "permissionMode": "default", "remoteMcpServersConfig": [], "completedTurns": turns,
        "importedBy": "claude-session-transfer",
    }


def load(bundle: Path, cli_ids: list[str], target_account_id: str, device_id: str,
         cwd_map: dict[str, str] | None = None, new_id: bool = False, overwrite: bool = False,
         merge: bool = True, import_memory: bool = True, import_project: bool = False,
         import_settings: bool = False, dry_run: bool = False) -> list[str]:
    """Install sessions from a bundle.

    merge=True   : an existing transcript is unioned with the incoming one
                   (safe for carrying a session back and forth between PCs)
    overwrite    : replace existing files outright (wins over merge)
    neither      : keep what exists, only add what is missing
    """
    cwd_map = cwd_map or {}
    log = []
    manifest = read_manifest(bundle)
    dest_dir = sessions_root() / target_account_id / device_id
    if not dry_run:
        dest_dir.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(bundle) as z:
        names = set(z.namelist())
        for entry in manifest["sessions"]:
            cid = entry["cliSessionId"]
            if cid not in cli_ids:
                continue
            tname = f"sessions/{cid}/transcript.jsonl"
            if f"sessions/{cid}/record.json" in names:
                record = json.loads(z.read(f"sessions/{cid}/record.json"))
            elif tname in names:
                ttl = None
                if f"sessions/{cid}/extra/custom-title.json" in names:
                    try:
                        ttl = json.loads(z.read(f"sessions/{cid}/extra/custom-title.json")).get("customTitle")
                    except Exception:
                        pass
                record = synthesize_record(z.read(tname), cid, ttl or entry.get("title"))
            else:
                log.append(f"SKIP {entry.get('title', cid)!r}: no record and no transcript in bundle")
                continue
            old_cwd = record.get("cwd", "")
            new_cwd = cwd_map.get(old_cwd, old_cwd)
            for k in ("cwd", "originCwd", "gitAnchorsFolderRealpath"):
                if record.get(k) == old_cwd:
                    record[k] = new_cwd
            if new_id:
                record["sessionId"] = f"local_{uuid.uuid4()}"
            rec_path = dest_dir / f"{record['sessionId']}.json"
            proj = projects_root() / cwd_slug(new_cwd)
            tpath = proj / f"{cid}.jsonl"
            note = f"  (folder remapped -> {new_cwd})" if new_cwd != old_cwd else ""

            if rec_path.exists() and not (overwrite or merge):
                log.append(f"SKIP {entry['title']!r}: record already exists")
                continue

            action = "LOAD"
            if tname in names:
                incoming = z.read(tname)
                if tpath.exists() and overwrite:
                    action = "REPLACE transcript"
                    data = remap_transcript(incoming, old_cwd, new_cwd)
                elif tpath.exists() and merge:
                    data, added = merge_transcripts(tpath.read_bytes(),
                                                    remap_transcript(incoming, old_cwd, new_cwd))
                    action = f"MERGE transcript (+{added} lines)"
                    if added == 0:
                        data = None
                elif tpath.exists():
                    action = "KEEP existing transcript"
                    data = None
                else:
                    data = remap_transcript(incoming, old_cwd, new_cwd)
                if dry_run:
                    log.append(f"DRY {action} {entry['title']!r} -> {tpath}{note}")
                else:
                    if data is not None:
                        _write(tpath, data)
                    log.append(f"{action} {entry['title']!r}{note}")
            elif dry_run:
                log.append(f"DRY LOAD record only {entry['title']!r}{note}")
            else:
                log.append(f"LOAD record only {entry['title']!r}{note}")
            if dry_run:
                continue
            prefix = f"sessions/{cid}/extra/"
            for n in names:
                if n.startswith(prefix) and not n.endswith("/"):
                    dst = proj / cid / n[len(prefix):]
                    if not dst.exists() or overwrite:
                        _write(dst, z.read(n))
            # keep whichever lastActivity is newer when merging onto an existing record
            if rec_path.exists() and merge and not overwrite:
                try:
                    old = json.loads(rec_path.read_text("utf-8"))
                    if old.get("lastActivityAt", 0) > record.get("lastActivityAt", 0):
                        record = {**record, **{k: old[k] for k in ("lastActivityAt", "title", "isArchived") if k in old}}
                except Exception:
                    pass
            rec_path.write_text(json.dumps(record, ensure_ascii=False), encoding="utf-8")

        def copy_tree(prefix: str, dest: Path, label: str):
            added = skipped = 0
            for n in names:
                if n.startswith(prefix) and not n.endswith("/"):
                    dst = dest / n[len(prefix):]
                    if dst.exists() and not overwrite:
                        skipped += 1
                        continue
                    if not dry_run:
                        _write(dst, z.read(n))
                    added += 1
            log.append(f"{'DRY ' if dry_run else ''}{label}: {added} files added, {skipped} kept")

        if import_memory:
            for m in manifest["memory"]:
                new_cwd = cwd_map.get(m["cwd"], m["cwd"])
                copy_tree(f"memory/{m['slug']}/", projects_root() / cwd_slug(new_cwd) / "memory",
                          f"MEMORY {new_cwd}")
        if import_project:
            for m in manifest["project"]:
                new_cwd = cwd_map.get(m["cwd"], m["cwd"])
                if Path(new_cwd).is_dir():
                    copy_tree(f"project/{m['slug']}/", Path(new_cwd), f"PROJECT {new_cwd}")
                else:
                    log.append(f"PROJECT {new_cwd}: folder missing, skipped")
        if import_settings:
            for name in manifest["settings"]:
                dst = claude_home() / name
                if dst.exists() and not overwrite:
                    dst = claude_home() / f"{name}.imported"
                if not dry_run:
                    _write(dst, z.read(f"settings/{name}"))
                log.append(f"{'DRY ' if dry_run else ''}SETTINGS -> {dst}")
    return log


# ----------------------------------------------------------------------------
# incoming bundles, sync, peers
# ----------------------------------------------------------------------------

def list_bundles(folder: Path | None = None) -> list[dict]:
    folder = folder or incoming_dir()
    out = []
    if not folder.exists():
        return out
    for p in sorted(folder.glob("*.zip"), key=lambda p: p.stat().st_mtime, reverse=True):
        try:
            m = read_manifest(p)
            out.append({"path": str(p), "name": p.name, "sizeKB": p.stat().st_size // 1024,
                        "from": m.get("sourceMachine"), "created": m.get("createdAt"),
                        "sessions": len(m["sessions"]), "memory": len(m["memory"]),
                        "project": len(m["project"]), "settings": m["settings"]})
        except Exception:
            pass
    return out


def save_incoming(data: bytes, name: str | None = None) -> Path:
    incoming_dir().mkdir(parents=True, exist_ok=True)
    safe = re.sub(r"[^A-Za-z0-9._-]", "_", name or "")
    if not safe.endswith(".zip"):
        safe = f"bundle-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    dst = incoming_dir() / safe
    i = 1
    while dst.exists():
        dst = incoming_dir() / f"{safe[:-4]}-{i}.zip"
        i += 1
    dst.write_bytes(data)
    read_manifest(dst)  # validates
    return dst


def sync_once(account_id: str, sync_dir: Path, since: float = 0.0,
              include_memory: bool = True) -> tuple[Path | None, list[str]]:
    """Capture every session of an account whose transcript changed after
    `since` (epoch seconds) into a dated bundle in sync_dir."""
    acc = find_account(account_id)
    if not acc:
        return None, [f"account {account_id} not found"]
    changed = [s for s in acc.sessions if s.cli_id and s.transcript.exists() and s.transcript_mtime > since]
    if not changed:
        return None, ["nothing changed since last sync"]
    out = sync_dir / f"sync-{platform.node()}-{time.strftime('%Y%m%d-%H%M%S')}.zip"
    log = capture(changed, out, include_memory=include_memory)
    return out, log


def push_bundle(bundle: Path, peer_url: str, token: str, timeout: int = 120) -> dict:
    """POST a bundle to another PC running this tool. Returns the peer's reply."""
    import urllib.request
    url = peer_url.rstrip("/") + "/api/peer/receive"
    req = urllib.request.Request(url, data=bundle.read_bytes(), method="POST", headers={
        "Content-Type": "application/zip", "X-Bundle-Name": bundle.name, "X-Peer-Token": token,
    })
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def peer_info(peer_url: str, timeout: int = 10) -> dict:
    import urllib.request
    with urllib.request.urlopen(peer_url.rstrip("/") + "/api/peer/info", timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))
