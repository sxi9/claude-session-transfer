"""Claude Desktop session transfer tool: tkinter window.

Thin UI over cst/core.py. The web UI (python cst.py serve) has more options.
Three things, one window, pure standard library (tkinter):

  Transfer  - copy or move sessions between accounts on THIS PC.
  Capture   - pack sessions (plus optional memory and settings) into one
              portable zip bundle to carry to ANOTHER PC.
  Load      - open a bundle on any PC, pick the target account, remap working
              folders that do not exist here, and install the sessions.

How the app stores a session (Windows paths; macOS/Linux handled too):
  %APPDATA%\\Claude\\claude-code-sessions\\<account-id>\\<device-id>\\local_<id>.json
      -> small sidebar record; "cliSessionId" points at the transcript
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\<cliSessionId>.jsonl
      -> the conversation itself
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\<cliSessionId>\\
      -> custom title, subagent transcripts
  %USERPROFILE%\\.claude\\projects\\<cwd-slug>\\memory\\
      -> Claude's persistent memory for that project folder

Bundle layout (zip):
  manifest.json
  sessions/<cliSessionId>/record.json
  sessions/<cliSessionId>/transcript.jsonl
  sessions/<cliSessionId>/extra/...        (title + subagent files)
  memory/<cwd-slug>/...                    (optional)
  settings/settings.json, settings/CLAUDE.md (optional)

Environment overrides for testing: CLAUDE_APP_DIR, CLAUDE_HOME_DIR.
"""

from __future__ import annotations

import time
from datetime import datetime
import tkinter as tk
from pathlib import Path
from tkinter import filedialog, messagebox, ttk

from cst.core import (  # noqa: E402  shared core; see cst/core.py
    Account, Session, backup_folder, capture, claude_app_running, current_account_id,
    cwd_slug, device_id_hint, discover, load, read_manifest, sessions_root, transfer,
)

# ----------------------------------------------------------------------------
# UI helpers
# ----------------------------------------------------------------------------

COLS = ("title", "cwd", "last", "size", "id")
HEADS = {"title": ("Title", 300), "cwd": ("Working folder", 200),
         "last": ("Last activity", 110), "size": ("Transcript KB", 90),
         "id": ("Session id", 190)}


def make_tree(parent) -> ttk.Treeview:
    tree = ttk.Treeview(parent, columns=COLS, show="headings", selectmode="extended")
    for c in COLS:
        tree.heading(c, text=HEADS[c][0])
        tree.column(c, width=HEADS[c][1], anchor="w")
    tree.tag_configure("missing", foreground="#b00")
    tree.tag_configure("archived", foreground="#888")
    return tree


def fill_tree(tree: ttk.Treeview, sessions: list[Session], show_archived: bool) -> dict:
    tree.delete(*tree.get_children())
    rows = {}
    for s in sessions:
        if s.archived and not show_archived:
            continue
        size = s.transcript_size_kb
        tags = (["missing"] if size < 0 else []) + (["archived"] if s.archived else [])
        iid = tree.insert("", "end", tags=tags, values=(
            s.title, s.cwd, s.last_activity, size if size >= 0 else "missing", s.id))
        rows[iid] = s
    return rows


def show_log(title: str, log: list[str]):
    win = tk.Toplevel()
    win.title(title)
    win.geometry("760x420")
    txt = tk.Text(win, wrap="word")
    txt.pack(fill="both", expand=True)
    txt.insert("1.0", "\n".join(log))
    txt.config(state="disabled")
    ttk.Button(win, text="Close", command=win.destroy).pack(pady=6)


# ----------------------------------------------------------------------------
# tabs
# ----------------------------------------------------------------------------

class TransferTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=8)
        self.app = app
        self.mode = tk.StringVar(value="copy")
        self.new_id = tk.BooleanVar(value=False)
        self.show_archived = tk.BooleanVar(value=False)
        self.rows = {}

        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Label(top, text="Source account:").grid(row=0, column=0, sticky="w")
        self.src = ttk.Combobox(top, state="readonly", width=46)
        self.src.grid(row=0, column=1, padx=4, sticky="w")
        self.src.bind("<<ComboboxSelected>>", lambda e: self.fill())
        ttk.Label(top, text="Target account:").grid(row=1, column=0, sticky="w")
        self.dst = ttk.Combobox(top, state="readonly", width=46)
        self.dst.grid(row=1, column=1, padx=4, sticky="w")
        ttk.Checkbutton(top, text="Show archived", variable=self.show_archived,
                        command=self.fill).grid(row=1, column=2, padx=8, sticky="w")
        opts = ttk.Frame(top)
        opts.grid(row=0, column=3, rowspan=2, padx=16, sticky="w")
        ttk.Radiobutton(opts, text="Copy (both accounts see it)", variable=self.mode,
                        value="copy").pack(anchor="w")
        ttk.Radiobutton(opts, text="Move (remove from source)", variable=self.mode,
                        value="move").pack(anchor="w")
        ttk.Checkbutton(opts, text="Assign new session id", variable=self.new_id).pack(anchor="w")

        self.tree = make_tree(self)
        self.tree.pack(fill="both", expand=True, pady=4)
        bar = ttk.Frame(self)
        bar.pack(fill="x")
        ttk.Button(bar, text="Select all",
                   command=lambda: self.tree.selection_set(self.tree.get_children())).pack(side="left")
        ttk.Button(bar, text="Transfer selected ->", command=self.go).pack(side="right")

    def refresh(self):
        accs = self.app.accounts
        labels = [a.label(self.app.current) for a in accs]
        self.src["values"] = labels
        self.dst["values"] = labels
        if accs:
            cur = next((i for i, a in enumerate(accs) if a.id == self.app.current), 0)
            self.src.current(cur)
            self.dst.current(next((i for i in range(len(accs)) if i != cur), cur))
        self.fill()

    def _acc(self, box):
        i = box.current()
        return self.app.accounts[i] if 0 <= i < len(self.app.accounts) else None

    def fill(self):
        acc = self._acc(self.src)
        self.rows = fill_tree(self.tree, acc.sessions if acc else [], self.show_archived.get())

    def go(self):
        src, dst = self._acc(self.src), self._acc(self.dst)
        if not src or not dst:
            return
        if src.id == dst.id:
            messagebox.showwarning("Same account", "Source and target are the same account.")
            return
        chosen = [self.rows[i] for i in self.tree.selection()]
        if not chosen:
            messagebox.showinfo("Nothing selected", "Select one or more sessions first.")
            return
        if not self.app.confirm_app_closed():
            return
        move = self.mode.get() == "move"
        verb = "Move" if move else "Copy"
        if not messagebox.askyesno(f"{verb} {len(chosen)} session(s)?",
                                   f"{verb} {len(chosen)} session(s)\n\nfrom  {src.id}\nto      {dst.id}\n\n"
                                   "A backup of the target folder is written first."):
            return
        try:
            bk = backup_folder(dst.device_folder)
            if move:
                backup_folder(src.device_folder)
            log = transfer(chosen, dst, move, self.new_id.get())
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Transfer failed", str(e))
            return
        self.app.refresh()
        show_log("Transfer complete", log + ["", f"Backup: {bk}",
                                             "Restart Claude and sign in to the target account."])


class CaptureTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=8)
        self.app = app
        self.inc_memory = tk.BooleanVar(value=True)
        self.inc_settings = tk.BooleanVar(value=False)
        self.show_archived = tk.BooleanVar(value=False)
        self.rows = {}

        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Label(top, text="Account:").grid(row=0, column=0, sticky="w")
        self.src = ttk.Combobox(top, state="readonly", width=46)
        self.src.grid(row=0, column=1, padx=4, sticky="w")
        self.src.bind("<<ComboboxSelected>>", lambda e: self.fill())
        ttk.Checkbutton(top, text="Show archived", variable=self.show_archived,
                        command=self.fill).grid(row=0, column=2, padx=8)
        opts = ttk.Frame(top)
        opts.grid(row=0, column=3, padx=16, sticky="w")
        ttk.Checkbutton(opts, text="Include project memory (Claude's saved facts)",
                        variable=self.inc_memory).pack(anchor="w")
        ttk.Checkbutton(opts, text="Include ~/.claude settings.json and CLAUDE.md",
                        variable=self.inc_settings).pack(anchor="w")

        ttk.Label(self, text="Pick the sessions to pack into one portable bundle (.zip). "
                             "Carry the zip to the other PC and use the Load tab there.",
                  foreground="#555").pack(anchor="w", pady=(6, 2))
        self.tree = make_tree(self)
        self.tree.pack(fill="both", expand=True, pady=4)
        bar = ttk.Frame(self)
        bar.pack(fill="x")
        ttk.Button(bar, text="Select all",
                   command=lambda: self.tree.selection_set(self.tree.get_children())).pack(side="left")
        ttk.Button(bar, text="Capture selected to bundle...", command=self.go).pack(side="right")

    def refresh(self):
        accs = self.app.accounts
        self.src["values"] = [a.label(self.app.current) for a in accs]
        if accs:
            self.src.current(next((i for i, a in enumerate(accs) if a.id == self.app.current), 0))
        self.fill()

    def fill(self):
        i = self.src.current()
        acc = self.app.accounts[i] if 0 <= i < len(self.app.accounts) else None
        self.rows = fill_tree(self.tree, acc.sessions if acc else [], self.show_archived.get())

    def go(self):
        chosen = [self.rows[i] for i in self.tree.selection()]
        if not chosen:
            messagebox.showinfo("Nothing selected", "Select one or more sessions first.")
            return
        default = f"claude-bundle-{time.strftime('%Y%m%d-%H%M%S')}.zip"
        out = filedialog.asksaveasfilename(title="Save bundle", defaultextension=".zip",
                                           initialfile=default, filetypes=[("Zip bundle", "*.zip")])
        if not out:
            return
        try:
            log = capture(chosen, Path(out), self.inc_memory.get(), self.inc_settings.get())
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Capture failed", str(e))
            return
        show_log("Capture complete", log)


class LoadTab(ttk.Frame):
    def __init__(self, master, app):
        super().__init__(master, padding=8)
        self.app = app
        self.bundle: Path | None = None
        self.manifest: dict = {}
        self.new_id = tk.BooleanVar(value=False)
        self.overwrite = tk.BooleanVar(value=False)
        self.imp_memory = tk.BooleanVar(value=True)
        self.imp_settings = tk.BooleanVar(value=False)
        self.cwd_entries: dict[str, tk.StringVar] = {}

        top = ttk.Frame(self)
        top.pack(fill="x")
        ttk.Button(top, text="Open bundle...", command=self.open).grid(row=0, column=0, sticky="w")
        self.bundle_lbl = ttk.Label(top, text="(no bundle opened)", foreground="#555")
        self.bundle_lbl.grid(row=0, column=1, columnspan=3, padx=8, sticky="w")

        ttk.Label(top, text="Target account:").grid(row=1, column=0, sticky="w", pady=(6, 0))
        self.dst = ttk.Combobox(top, width=46)
        self.dst.grid(row=1, column=1, padx=4, sticky="w", pady=(6, 0))
        ttk.Label(top, text="(pick one, or type an account id)", foreground="#777").grid(
            row=1, column=2, sticky="w")
        ttk.Label(top, text="Device id:").grid(row=2, column=0, sticky="w")
        self.dev = ttk.Entry(top, width=48)
        self.dev.grid(row=2, column=1, padx=4, sticky="w")
        ttk.Label(top, text="(auto-detected from this PC's app config)", foreground="#777").grid(
            row=2, column=2, sticky="w")

        opts = ttk.Frame(top)
        opts.grid(row=0, column=4, rowspan=3, padx=16, sticky="nw")
        ttk.Checkbutton(opts, text="Assign new session ids", variable=self.new_id).pack(anchor="w")
        ttk.Checkbutton(opts, text="Overwrite existing files", variable=self.overwrite).pack(anchor="w")
        ttk.Checkbutton(opts, text="Import project memory", variable=self.imp_memory).pack(anchor="w")
        ttk.Checkbutton(opts, text="Import settings", variable=self.imp_settings).pack(anchor="w")

        ttk.Label(self, text="Sessions in bundle:", foreground="#555").pack(anchor="w", pady=(8, 2))
        self.tree = ttk.Treeview(self, columns=("title", "cwd", "last", "size", "id"),
                                 show="headings", selectmode="extended", height=9)
        for c in COLS:
            self.tree.heading(c, text=HEADS[c][0])
            self.tree.column(c, width=HEADS[c][1], anchor="w")
        self.tree.pack(fill="both", expand=True)

        ttk.Label(self, text="Working folder mapping (red = folder does not exist on this PC; "
                             "edit the right side to point at where the project lives here):",
                  foreground="#555").pack(anchor="w", pady=(8, 2))
        self.map_frame = ttk.Frame(self)
        self.map_frame.pack(fill="x")

        bar = ttk.Frame(self)
        bar.pack(fill="x", pady=(8, 0))
        ttk.Button(bar, text="Select all",
                   command=lambda: self.tree.selection_set(self.tree.get_children())).pack(side="left")
        ttk.Button(bar, text="Load selected into this PC", command=self.go).pack(side="right")

    def refresh(self):
        accs = self.app.accounts
        self.dst["values"] = [a.id for a in accs]
        if self.app.current:
            self.dst.set(self.app.current)
        elif accs:
            self.dst.current(0)
        self.dev.delete(0, "end")
        self.dev.insert(0, device_id_hint() or "")

    def open(self):
        f = filedialog.askopenfilename(title="Open bundle", filetypes=[("Zip bundle", "*.zip")])
        if not f:
            return
        try:
            self.manifest = read_manifest(Path(f))
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Not a bundle", f"Could not read manifest.json:\n{e}")
            return
        self.bundle = Path(f)
        m = self.manifest
        self.bundle_lbl.config(text=f"{self.bundle.name}  from {m.get('sourceMachine')} "
                                    f"at {m.get('createdAt')}  |  {len(m['sessions'])} sessions, "
                                    f"memory for {len(m.get('memory', []))} folder(s)")
        self.tree.delete(*self.tree.get_children())
        self.rows = {}
        for e in m["sessions"]:
            ms = e.get("lastActivityAt") or 0
            last = datetime.fromtimestamp(ms / 1000).strftime("%Y-%m-%d %H:%M") if ms else ""
            iid = self.tree.insert("", "end", values=(
                e["title"], e["cwd"], last, e.get("transcriptKB", 0), e["cliSessionId"]))
            self.rows[iid] = e["cliSessionId"]
        self.tree.selection_set(self.tree.get_children())
        self.build_map()

    def build_map(self):
        for w in self.map_frame.winfo_children():
            w.destroy()
        self.cwd_entries = {}
        cwds = sorted({e["cwd"] for e in self.manifest["sessions"]} |
                      {m["cwd"] for m in self.manifest.get("memory", [])})
        for r, old in enumerate(cwds):
            exists = Path(old).is_dir()
            ttk.Label(self.map_frame, text=old, foreground="#060" if exists else "#b00",
                      width=40).grid(row=r, column=0, sticky="w")
            ttk.Label(self.map_frame, text="->").grid(row=r, column=1, padx=6)
            var = tk.StringVar(value=old)
            ttk.Entry(self.map_frame, textvariable=var, width=50).grid(row=r, column=2, sticky="w")
            ttk.Button(self.map_frame, text="Browse", command=lambda v=var: self.browse(v)).grid(
                row=r, column=3, padx=4)
            self.cwd_entries[old] = var

    def browse(self, var):
        d = filedialog.askdirectory(title="Where does this project live on this PC?")
        if d:
            var.set(str(Path(d)))

    def go(self):
        if not self.bundle:
            messagebox.showinfo("No bundle", "Open a bundle first.")
            return
        ids = [self.rows[i] for i in self.tree.selection()]
        if not ids:
            messagebox.showinfo("Nothing selected", "Select one or more sessions first.")
            return
        acc = self.dst.get().strip()
        dev = self.dev.get().strip()
        if not acc or not dev:
            messagebox.showwarning("Missing target", "Target account id and device id are both required.\n\n"
                                   "Sign in to Claude on this PC once so the app creates them, then Rescan.")
            return
        if not self.app.confirm_app_closed():
            return
        cwd_map = {old: var.get().strip() or old for old, var in self.cwd_entries.items()}
        missing = [n for n in cwd_map.values() if not Path(n).is_dir()]
        if missing and not messagebox.askyesno(
                "Folders missing", "These working folders do not exist on this PC:\n\n" +
                "\n".join(missing) + "\n\nSessions will still load but open with a missing-folder "
                "warning. Continue?"):
            return
        if not messagebox.askyesno("Load bundle?",
                                   f"Load {len(ids)} session(s) into account {acc}\n"
                                   f"device {dev}\n\nA backup of the target folder is written first."):
            return
        try:
            bk = backup_folder(sessions_root() / acc / dev)
            log = load(self.bundle, ids, acc, dev, cwd_map, new_id=self.new_id.get(),
                       overwrite=self.overwrite.get(), merge=not self.overwrite.get(),
                       import_memory=self.imp_memory.get(), import_settings=self.imp_settings.get())
        except Exception as e:  # noqa: BLE001
            messagebox.showerror("Load failed", str(e))
            return
        self.app.refresh()
        show_log("Load complete", log + ["", f"Backup: {bk or '(target folder was new)'}",
                                         "Restart Claude and sign in to the target account."])


# ----------------------------------------------------------------------------
# main window
# ----------------------------------------------------------------------------

class App(tk.Tk):
    def __init__(self):
        super().__init__()
        self.title("Claude Session Transfer")
        self.geometry("1060x700")
        self.minsize(860, 540)
        self.accounts: list[Account] = []
        self.current = current_account_id()

        hdr = ttk.Frame(self, padding=(8, 6))
        hdr.pack(fill="x")
        ttk.Button(hdr, text="Rescan", command=self.refresh).pack(side="left")
        self.status = ttk.Label(hdr, text="", foreground="#444")
        self.status.pack(side="left", padx=12)
        ttk.Label(hdr, text=f"Store: {sessions_root()}", foreground="#777").pack(side="right")

        nb = ttk.Notebook(self)
        nb.pack(fill="both", expand=True)
        self.transfer_tab = TransferTab(nb, self)
        self.capture_tab = CaptureTab(nb, self)
        self.load_tab = LoadTab(nb, self)
        nb.add(self.transfer_tab, text="  Transfer (this PC)  ")
        nb.add(self.capture_tab, text="  Capture -> bundle  ")
        nb.add(self.load_tab, text="  Load <- bundle  ")
        self.refresh()

    def refresh(self):
        self.accounts = discover()
        self.current = current_account_id()
        for t in (self.transfer_tab, self.capture_tab, self.load_tab):
            t.refresh()
        n = len(self.accounts)
        self.status.config(text=f"Found {n} account folder{'s' if n != 1 else ''}."
                           if n else f"No session store at {sessions_root()} (sign in to Claude once).")

    def confirm_app_closed(self) -> bool:
        if not claude_app_running():
            return True
        return messagebox.askyesno(
            "Claude is running",
            "The Claude desktop app is running and may overwrite or ignore changes made while "
            "open.\n\nClose Claude first for a reliable result.\n\nContinue anyway?")


if __name__ == "__main__":
    App().mainloop()
