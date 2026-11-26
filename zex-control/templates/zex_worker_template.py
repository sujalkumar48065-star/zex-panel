#!/usr/bin/env python3
"""ZEX CLOUD dual-session worker (standard library only).

Rendered by the Zex CLOUD control backend. The control panel is the only
deployment surface; this file is embedded into each Kaggle notebook session.

Quota-safe role protocol
------------------------
Exactly one session runs projects at a time. A session:
  * waits until START_AFTER_EPOCH before starting projects,
  * exits by itself at STOP_AT_EPOCH (12h hard limit),
  * is only ever pushed with ROLE = "active" (a future START_AFTER makes it wait).

The backend prepares the next session ahead of time with a start time after the
current stop time, so the old worker has exited before the new one begins.
This prevents duplicate execution / conflicting polling and keeps the Kaggle
batch-session quota low (no permanent warm standby).
"""

import base64
import datetime
import gzip
import json
import os
import runpy
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SLOT = "__SLOT__"
ROLE = "__ROLE__"
START_AFTER_EPOCH = __START_AFTER__
STOP_AT_EPOCH = __STOP_AT__
PROJECT_BUNDLE_B64 = (
__BUNDLE_LINES__
)

SESSION_HOURS = 12.0
START = time.time()
STOP_AT = STOP_AT_EPOCH if STOP_AT_EPOCH > 0 else START + SESSION_HOURS * 3600
HANDOVER_WARNING_SECONDS = 15 * 60
STARTED_AT = datetime.datetime.now(datetime.timezone.utc).isoformat()
WORK_DIR = os.environ.get("ZEX_WORK_DIR", "/kaggle/working")
PROJECTS_DIR = os.path.join(WORK_DIR, "projects")
STATUS_PATH = os.environ.get("ZEX_STATUS_FILE", os.path.join(WORK_DIR, "zex_status.json"))
PORT = int(os.environ.get("PORT", "8080"))
_stop = threading.Event()
_procs = {}
_proc_lock = threading.Lock()


def _utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _elapsed():
    return time.time() - START


def _decode_bundle():
    raw = "".join(PROJECT_BUNDLE_B64.split())
    if not raw:
        return {"projects": []}
    data = gzip.decompress(base64.b64decode(raw))
    return json.loads(data.decode("utf-8"))


def _safe_join(base, rel):
    rel = str(rel).replace("\\", "/").lstrip("/")
    parts = [p for p in rel.split("/") if p not in ("", ".", "..")]
    return os.path.join(base, *parts)


def _prepare_projects(bundle):
    os.makedirs(PROJECTS_DIR, exist_ok=True)
    written = []
    for project in bundle.get("projects", []):
        pid = str(project.get("id", "")).strip()
        if not pid:
            continue
        pdir = _safe_join(PROJECTS_DIR, pid)
        os.makedirs(pdir, exist_ok=True)
        for rel, b64 in (project.get("files") or {}).items():
            target = _safe_join(pdir, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            with open(target, "wb") as fh:
                fh.write(base64.b64decode(b64 or ""))
            written.append(os.path.join(pid, rel))
        req = project.get("requirements") or ""
        if req:
            with open(os.path.join(pdir, "requirements.txt"), "w", encoding="utf-8") as fh:
                fh.write(req)
        cfg = {
            "id": pid,
            "name": project.get("name") or pid,
            "kind": project.get("kind") or "worker",
            "enabled": bool(project.get("enabled", True)),
            "start_command": project.get("start_command") or "",
            "public_url": project.get("public_url") or "",
            "env": project.get("env") or {},
            "requirements": req,
        }
        with open(os.path.join(pdir, ".zex-project.json"), "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
    print("[zex] prepared {} project file(s) for {}".format(len(written), len(bundle.get("projects", []))), flush=True)
    return bundle.get("projects", [])


def _project_env(project):
    env = {
        "PATH": os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin"),
        "HOME": os.environ.get("HOME", WORK_DIR),
        "LANG": os.environ.get("LANG", "C.UTF-8"),
        "PYTHONUNBUFFERED": "1",
        "ZEX_SESSION_SLOT": SLOT,
        "ZEX_PROJECT_ID": str(project.get("id", "")),
    }
    for key, value in (project.get("env") or {}).items():
        env[str(key)] = str(value)
    return env


def _has_internet():
    try:
        sock = socket.create_connection(("pypi.org", 443), 4)
        sock.close()
        return True
    except Exception:
        return False


def _install_deps(pdir):
    marker = os.path.join(pdir, ".zex-deps-ready")
    if os.path.exists(marker):
        return
    req = os.path.join(pdir, "requirements.txt")
    pkg = os.path.join(pdir, "package.json")
    if not os.path.exists(req) and not os.path.exists(pkg):
        return
    if not _has_internet():
        print("[zex] no internet; dependency install skipped", flush=True)
        try:
            with open(marker, "w", encoding="utf-8") as fh:
                fh.write("skipped: no internet\n")
        except Exception:
            pass
        return
    if os.path.exists(req):
        try:
            print("[zex] installing python requirements", flush=True)
            subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", req],
                cwd=pdir, timeout=300,
            )
        except Exception as exc:
            print("[zex] pip install failed: {}".format(exc), flush=True)
    if os.path.exists(pkg) and not os.path.isdir(os.path.join(pdir, "node_modules")) and shutil.which("npm"):
        try:
            print("[zex] installing node dependencies", flush=True)
            subprocess.run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=pdir, timeout=300)
        except Exception as exc:
            print("[zex] npm install failed: {}".format(exc), flush=True)
    try:
        with open(marker, "w", encoding="utf-8") as fh:
            fh.write("done\n")
    except Exception:
        pass


def _detect_command(project, pdir):
    kind = project.get("kind") or "worker"
    if kind == "website":
        return ""
    names = set()
    for root, _dirs, files in os.walk(pdir):
        for name in files:
            rel = os.path.relpath(os.path.join(root, name), pdir).replace(os.sep, "/")
            names.add(rel)
    def find(cands):
        for cand in cands:
            if cand in names:
                return cand
            for name in names:
                if name.endswith("/" + cand):
                    return name
        return None
    if "package.json" in names:
        try:
            with open(os.path.join(pdir, "package.json"), encoding="utf-8") as fh:
                pkg = json.load(fh)
            if (pkg.get("scripts") or {}).get("start"):
                return "npm start"
        except Exception:
            pass
    py_pref = {
        "discord_bot": ["bot.py", "main.py", "app.py", "index.py", "run.py", "server.py"],
        "telegram_bot": ["bot.py", "main.py", "app.py", "index.py", "run.py", "server.py"],
        "api": ["app.py", "main.py", "server.py", "index.py", "run.py"],
        "worker": ["main.py", "worker.py", "app.py", "run.py", "index.py"],
    }.get(kind, ["main.py", "app.py", "bot.py", "worker.py", "run.py", "index.py"])
    py = find(py_pref)
    if py:
        return "python3 -u " + py
    node_pref = {
        "discord_bot": ["index.js", "bot.js", "main.js", "server.js"],
        "telegram_bot": ["index.js", "bot.js", "main.js", "server.js"],
        "api": ["server.js", "index.js", "app.js", "main.js"],
        "worker": ["index.js", "worker.js", "main.js", "server.js"],
    }.get(kind, ["index.js", "server.js", "app.js", "main.js"])
    node = find(node_pref)
    if node:
        return "node " + node
    return ""


def _run_project(project):
    pid = str(project.get("id", ""))
    pdir = _safe_join(PROJECTS_DIR, pid)
    command = (project.get("start_command") or "").strip() or _detect_command(project, pdir)
    if (project.get("kind") or "") != "website":
        _install_deps(pdir)
    if (project.get("kind") or "") == "website":
        print("[zex] project {} is a static website (served by the panel)".format(pid), flush=True)
        return
    if not command:
        print("[zex] project {} has no detected start command; skipped".format(pid), flush=True)
        return
    while not _stop.is_set():
        if ROLE != "active":
            return
        if time.time() >= STOP_AT:
            print("[zex] project {} stop time reached".format(pid), flush=True)
            return
        if time.time() < START_AFTER_EPOCH:
            _stop.wait(min(15, max(1, min(START_AFTER_EPOCH, STOP_AT) - time.time())))
            continue
        try:
            proc = subprocess.Popen(
                command,
                shell=True,
                cwd=pdir,
                env=_project_env(project),
                stdout=sys.stdout,
                stderr=sys.stderr,
            )
            with _proc_lock:
                _procs[pid] = proc.pid
            print("[zex] project {} started pid={}".format(pid, proc.pid), flush=True)
            code = proc.wait()
            with _proc_lock:
                _procs.pop(pid, None)
            if _stop.is_set():
                break
            print("[zex] project {} exited code={}; restarting in 10s".format(pid, code), flush=True)
        except Exception as exc:
            print("[zex] project {} start failed: {}".format(pid, exc), flush=True)
            traceback.print_exc()
        _stop.wait(10)


def _start_projects(projects):
    if ROLE != "active":
        print("[zex] role={}; projects prepared but not started".format(ROLE), flush=True)
        return
    if time.time() >= STOP_AT:
        print("[zex] stop time already reached; projects not started", flush=True)
        return
    for project in projects:
        if not project.get("enabled", True):
            continue
        if project.get("run_in_kaggle") is False:
            print("[zex] project {} is set to Render runtime; skipping in Kaggle".format(project.get("id")), flush=True)
            continue
        threading.Thread(target=_run_project, args=(project,), daemon=True).start()


def _write_status(state="running", detail=None):
    with _proc_lock:
        running = dict(_procs)
    data = {
        "slot": SLOT,
        "role": ROLE,
        "state": state,
        "detail": detail,
        "pid": os.getpid(),
        "started_at": STARTED_AT,
        "updated_at": _utc(),
        "elapsed_seconds": round(_elapsed(), 1),
        "session_hours": SESSION_HOURS,
        "remaining_seconds": max(0, round(STOP_AT - time.time(), 1)),
        "start_after_epoch": START_AFTER_EPOCH,
        "stop_at_epoch": STOP_AT,
        "projects_running": running,
    }
    try:
        os.makedirs(WORK_DIR, exist_ok=True)
        tmp = STATUS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, STATUS_PATH)
    except Exception as exc:
        print("[zex] status write failed:", exc, flush=True)
    return data


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ("/health", "/status"):
            body = json.dumps(_write_status()).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, *args):
        pass


def _serve():
    try:
        srv = ThreadingHTTPServer(("0.0.0.0", PORT), _Handler)
        srv.daemon_threads = True
        srv.serve_forever()
    except Exception as exc:
        print("[zex] local status server disabled:", exc, flush=True)


def _run_optional_workload():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "workload.py")
    if not os.path.exists(path):
        return
    try:
        runpy.run_path(path, run_name="__main__")
    except Exception:
        print("[zex] legacy workload.py crashed", flush=True)
        traceback.print_exc()


def _on_signal(signum, _frame):
    print("[zex] signal {} received; stopping".format(signum), flush=True)
    _stop.set()
    with _proc_lock:
        pids = list(_procs.values())
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    print("=" * 60, flush=True)
    print("ZEX CLOUD session {} | role={}".format(SLOT, ROLE), flush=True)
    print("started_at:", STARTED_AT, flush=True)
    print("planned session:", SESSION_HOURS, "hours", flush=True)
    print("stop_at:", datetime.datetime.fromtimestamp(STOP_AT, datetime.timezone.utc).isoformat(), flush=True)
    if ROLE == "active" and START_AFTER_EPOCH > time.time():
        print("project start delayed until:", datetime.datetime.fromtimestamp(START_AFTER_EPOCH, datetime.timezone.utc).isoformat(), flush=True)
    print("=" * 60, flush=True)
    _write_status("starting")

    try:
        bundle = _decode_bundle()
    except Exception:
        traceback.print_exc()
        bundle = {"projects": []}
        _write_status("degraded", "project bundle decode failed")
    projects = _prepare_projects(bundle)
    with open(os.path.join(WORK_DIR, "zex_role.json"), "w", encoding="utf-8") as fh:
        json.dump({"slot": SLOT, "role": ROLE, "start_after_epoch": START_AFTER_EPOCH, "stop_at_epoch": STOP_AT}, fh)

    threading.Thread(target=_serve, daemon=True).start()
    _start_projects(projects)
    threading.Thread(target=_run_optional_workload, daemon=True).start()

    last_log = 0.0
    warned = False
    while not _stop.is_set() and time.time() < STOP_AT:
        elapsed = _elapsed()
        status = _write_status("running")
        if elapsed - last_log >= 60:
            last_log = elapsed
            print("[zex] slot={} role={} alive={}m remaining={}m projects={}".format(
                SLOT, ROLE, int(elapsed // 60),
                int(status["remaining_seconds"] // 60),
                len(status["projects_running"])), flush=True)
        if ROLE == "active" and not warned and STOP_AT - time.time() <= HANDOVER_WARNING_SECONDS:
            warned = True
            print("[zex] handover window reached", flush=True)
            _write_status("handover-window")
        _stop.wait(30)

    expired = time.time() >= STOP_AT and not _stop.is_set()
    _stop.set()
    with _proc_lock:
        pids = list(_procs.values())
    for pid in pids:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass
    _write_status("expired" if expired else "stopped")
    print("[zex] worker {} at {}".format("expired" if expired else "stopped", _utc()), flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        _write_status("error", "unhandled worker exception")
        sys.exit(1)
