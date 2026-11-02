"""Claude Session Transfer: command line entry point.

    python cst.py serve [--host 0.0.0.0] [--port 8765] [--no-browser]
    python cst.py gui
    python cst.py list [--account ID] [--all]
    python cst.py capture --account ID --ids ID... --out bundle.zip [--memory] [--project] [--settings]
    python cst.py load bundle.zip --account ID [--device ID] [--ids ID...] [--map OLD=NEW]...
                                  [--merge|--overwrite] [--new-id] [--memory] [--project] [--settings] [--dry-run]
    python cst.py sync --account ID --dir FOLDER [--since EPOCH]
    python cst.py push bundle.zip --url http://PC:8765 --token TOKEN
    python cst.py export --account ID --id ID [--fmt md|html]
    python cst.py scan --account ID --id ID
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from cst import core


def _account(arg: str | None) -> core.Account:
    accs = core.discover()
    if not accs:
        sys.exit(f"no session store at {core.sessions_root()}")
    if not arg:
        cur = core.current_account_id()
        return next((a for a in accs if a.id == cur), accs[0])
    hits = [a for a in accs if a.id == arg or a.id.startswith(arg) or core.account_label(a.id) == arg]
    if len(hits) != 1:
        sys.exit(f"account {arg!r} not found or ambiguous; known: " + ", ".join(a.id for a in accs))
    return hits[0]


def _sessions(acc: core.Account, ids: list[str] | None) -> list[core.Session]:
    if not ids:
        return acc.sessions
    out = []
    for i in ids:
        s = acc.find(i) or next((s for s in acc.sessions if s.id.startswith(i) or s.cli_id.startswith(i)), None)
        if not s:
            sys.exit(f"session {i!r} not found")
        out.append(s)
    return out


def cmd_list(a):
    cfg = core.load_tool_config()
    for acc in core.discover():
        if a.account and acc.id != _account(a.account).id:
            continue
        print(f"== {core.account_label(acc.id, cfg)}  {acc.id}  ({len(acc.sessions)} sessions)")
        for s in acc.sessions:
            if s.archived and not a.all:
                continue
            kb = s.transcript_size_kb
            print(f"  {s.id[6:14]}  {s.last_activity}  {kb if kb >= 0 else '  --':>7} KB  {s.title[:50]:<50}  {s.cwd}")


def cmd_capture(a):
    acc = _account(a.account)
    log = core.capture(_sessions(acc, a.ids), Path(a.out), a.memory, a.settings, a.project)
    print("\n".join(log))


def cmd_load(a):
    m = core.read_manifest(Path(a.bundle))
    ids = a.ids or [e["cliSessionId"] for e in m["sessions"]]
    cwd_map = dict(x.split("=", 1) for x in (a.map or []))
    device = a.device or core.device_id_hint()
    if not device:
        sys.exit("no device id found; pass --device")
    acc_id = a.account
    if not a.dry_run:
        core.backup_folder(core.sessions_root() / acc_id / device)
    log = core.load(Path(a.bundle), ids, acc_id, device, cwd_map, a.new_id, a.overwrite,
                    not a.overwrite and a.merge, a.memory, a.project, a.settings, dry_run=a.dry_run)
    print("\n".join(log))


def cmd_sync(a):
    acc = _account(a.account)
    out, log = core.sync_once(acc.id, Path(a.dir), since=a.since)
    print("\n".join(log))


def cmd_push(a):
    print(core.push_bundle(Path(a.bundle), a.url, a.token))


def cmd_export(a):
    s = _sessions(_account(a.account), [a.id])[0]
    sys.stdout.reconfigure(encoding="utf-8")
    print(core.export_html(s) if a.fmt == "html" else core.export_markdown(s))


def cmd_scan(a):
    s = _sessions(_account(a.account), [a.id])[0]
    for h in core.scan_secrets(s.transcript.read_bytes()):
        print(f"line {h['line']:>6}  {h['kind']:<22} {h['sample']}")


def main(argv=None):
    p = argparse.ArgumentParser(prog="cst", description="Claude Desktop session transfer")
    sub = p.add_subparsers(dest="cmd")

    s = sub.add_parser("serve", help="web UI")
    s.add_argument("--host", default="127.0.0.1")
    s.add_argument("--port", type=int, default=8765)
    s.add_argument("--no-browser", action="store_true")

    sub.add_parser("gui", help="tkinter window")

    s = sub.add_parser("list")
    s.add_argument("--account")
    s.add_argument("--all", action="store_true", help="include archived")

    s = sub.add_parser("capture")
    s.add_argument("--account")
    s.add_argument("--ids", nargs="*")
    s.add_argument("--out", required=True)
    s.add_argument("--memory", action="store_true")
    s.add_argument("--project", action="store_true")
    s.add_argument("--settings", action="store_true")

    s = sub.add_parser("load")
    s.add_argument("bundle")
    s.add_argument("--account", required=True)
    s.add_argument("--device")
    s.add_argument("--ids", nargs="*")
    s.add_argument("--map", action="append", metavar="OLD=NEW")
    s.add_argument("--merge", action="store_true", default=True)
    s.add_argument("--overwrite", action="store_true")
    s.add_argument("--new-id", action="store_true")
    s.add_argument("--memory", action="store_true")
    s.add_argument("--project", action="store_true")
    s.add_argument("--settings", action="store_true")
    s.add_argument("--dry-run", action="store_true")

    s = sub.add_parser("sync")
    s.add_argument("--account")
    s.add_argument("--dir", required=True)
    s.add_argument("--since", type=float, default=0.0)

    s = sub.add_parser("push")
    s.add_argument("bundle")
    s.add_argument("--url", required=True)
    s.add_argument("--token", required=True)

    s = sub.add_parser("export")
    s.add_argument("--account")
    s.add_argument("--id", required=True)
    s.add_argument("--fmt", choices=["md", "html"], default="md")

    s = sub.add_parser("scan")
    s.add_argument("--account")
    s.add_argument("--id", required=True)

    a = p.parse_args(argv)
    if a.cmd == "serve" or a.cmd is None:
        from cst.web import serve
        serve(getattr(a, "host", "127.0.0.1"), getattr(a, "port", 8765), not getattr(a, "no_browser", False))
    elif a.cmd == "gui":
        import claude_session_transfer
        claude_session_transfer.App().mainloop()
    else:
        globals()[f"cmd_{a.cmd}"](a)


if __name__ == "__main__":
    main()
