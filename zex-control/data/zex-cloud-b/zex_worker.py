#!/usr/bin/env python3
"""ZEX CLOUD dual-session worker (standard library only).

Rendered by the Zex CLOUD control backend. The control panel is the only
deployment surface; this file is embedded into each Kaggle notebook session.

Role protocol
-------------
Exactly one session runs projects at a time:
  ROLE = "active"   -> start registered projects (after START_AFTER_EPOCH)
  ROLE = "standby"  -> stay warm, run nothing

The backend pushes the new active session first, then pushes the previous
session as standby. The active session waits START_AFTER_EPOCH before starting
projects, so the old session has stopped (or restarted as standby) before the
new one begins. This prevents duplicate execution / conflicting polling without
any shared external database.
"""

import base64
import datetime
import gzip
import json
import os
import runpy
import shutil
import signal
import subprocess
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SLOT = "B"
ROLE = "standby"
START_AFTER_EPOCH = 0
PROJECT_BUNDLE_B64 = (
    "H4sIAAAAAAAAAzWO0QrCMAxFf0XyvIkrKK7giyKob6KgTES6LWp1TWvXDefYv9uBvoVzT5LbQo22"
    "lJqARwFUJhcO84twwIGN2CSMopCN9yPG2ZhH8TCOpwkEYKx+YOZK4KcWZO7lD77DUukn+pSEQo+S"
    "5XGw+6HSCesumVZKUK+bxt01DZSQNDSNF66yQH+uhT/ikK02JqWtXpMpcDH/pIfYJrt5LZq1Wdxm"
    "M+gCQKr9kh8svippUSH1rQD6SKQF+mfOVtiduy+gtCVy6gAAAA=="
)

SESSION_HOURS = 12.0
HANDOVER_WARNING_HOURS = 11.75
START = time.time()
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
            "enabled": bool(project.get("enabled", True)),
            "start_command": project.get("start_command") or "",
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


def _run_project(project):
    pid = str(project.get("id", ""))
    pdir = _safe_join(PROJECTS_DIR, pid)
    command = (project.get("start_command") or "").strip()
    if not command:
        print("[zex] project {} has no start_command; skipped".format(pid), flush=True)
        return
    while not _stop.is_set():
        if ROLE != "active":
            return
        if time.time() < START_AFTER_EPOCH:
            _stop.wait(min(15, max(1, START_AFTER_EPOCH - time.time())))
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
        print("[zex] role=standby; projects prepared but not started", flush=True)
        return
    for project in projects:
        if not project.get("enabled", True):
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
        "remaining_seconds": max(0, round(SESSION_HOURS * 3600 - _elapsed(), 1)),
        "start_after_epoch": START_AFTER_EPOCH,
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
        json.dump({"slot": SLOT, "role": ROLE, "start_after_epoch": START_AFTER_EPOCH}, fh)

    threading.Thread(target=_serve, daemon=True).start()
    _start_projects(projects)
    threading.Thread(target=_run_optional_workload, daemon=True).start()

    last_log = 0.0
    warned = False
    while not _stop.is_set():
        elapsed = _elapsed()
        status = _write_status("running")
        if elapsed - last_log >= 60:
            last_log = elapsed
            print("[zex] slot={} role={} alive={}m remaining={}m projects={}".format(
                SLOT, ROLE, int(elapsed // 60),
                int(status["remaining_seconds"] // 60),
                len(status["projects_running"])), flush=True)
        if ROLE == "active" and not warned and elapsed >= HANDOVER_WARNING_HOURS * 3600:
            warned = True
            print("[zex] handover window reached", flush=True)
            _write_status("handover-window")
        _stop.wait(30)

    _write_status("stopped")
    print("[zex] worker stopped", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        _write_status("error", "unhandled worker exception")
        sys.exit(1)
