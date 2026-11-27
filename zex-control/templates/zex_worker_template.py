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

The worker reports live project status, CPU, RAM, storage and logs back to the
panel so the dashboard shows real Kaggle values, not Render placeholders.
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
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PANEL_URL = "__PANEL_URL__"
WORKER_TOKEN = "__WORKER_TOKEN__"
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
REPORT_INTERVAL = 30
STARTED_AT = datetime.datetime.now(datetime.timezone.utc).isoformat()
WORK_DIR = os.environ.get("ZEX_WORK_DIR", "/kaggle/working")
PROJECTS_DIR = os.path.join(WORK_DIR, "projects")
STATUS_PATH = os.environ.get("ZEX_STATUS_FILE", os.path.join(WORK_DIR, "zex_status.json"))
PORT = int(os.environ.get("PORT", "8080"))
_stop = threading.Event()
_procs = {}
_proc_lock = threading.Lock()
_proc_started = {}
_restarts = {}
_project_logs = {}
_project_meta = {}
_log_lines = []
_cpu_prev = {}
_sys_cpu_prev = None


def _utc():
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


def _elapsed():
    return time.time() - START


def _say(line):
    text = str(line)
    print(text, flush=True)
    _log_lines.append(text)
    if len(_log_lines) > 800:
        del _log_lines[:-800]


def _append_log(pid, line):
    text = str(line).rstrip("\r\n")
    if not text.strip():
        return
    _project_logs.setdefault(pid, []).append(text)
    if len(_project_logs[pid]) > 400:
        del _project_logs[pid][:-400]
    _say("[{}] {}".format(pid, text))


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
        code_bytes = 0
        for rel, b64 in (project.get("files") or {}).items():
            target = _safe_join(pdir, rel)
            os.makedirs(os.path.dirname(target), exist_ok=True)
            raw = base64.b64decode(b64 or "")
            with open(target, "wb") as fh:
                fh.write(raw)
            code_bytes += len(raw)
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
            "run_in_kaggle": project.get("run_in_kaggle") is not False,
        }
        with open(os.path.join(pdir, ".zex-project.json"), "w", encoding="utf-8") as fh:
            json.dump(cfg, fh, indent=2)
        try:
            os.remove(os.path.join(pdir, ".zex-deps-ready"))
        except Exception:
            pass
        project["_code_bytes"] = code_bytes
        _project_meta[pid] = {
            "id": pid, "name": cfg["name"], "kind": cfg["kind"], "enabled": cfg["enabled"],
            "start_command": cfg["start_command"], "run_in_kaggle": cfg["run_in_kaggle"],
            "code_bytes": code_bytes, "status": "pending", "error": None,
        }
    _say("[zex] prepared {} project file(s) for {}".format(len(written), len(bundle.get("projects", []))))
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
        _say("[zex] no internet; dependency install skipped for {}".format(os.path.basename(pdir)))
        return
    ok = True
    if os.path.exists(req):
        try:
            _say("[zex] installing python requirements for {}".format(os.path.basename(pdir)))
            proc = subprocess.run(
                [sys.executable, "-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", req],
                cwd=pdir, timeout=600,
            )
            if proc.returncode != 0:
                ok = False
                _say("[zex] pip install exit code {} for {}".format(proc.returncode, os.path.basename(pdir)))
        except Exception as exc:
            ok = False
            _say("[zex] pip install failed: {}".format(exc))
    if os.path.exists(pkg) and not os.path.isdir(os.path.join(pdir, "node_modules")) and shutil.which("npm"):
        try:
            _say("[zex] installing node dependencies")
            subprocess.run(["npm", "install", "--omit=dev", "--no-audit", "--no-fund"], cwd=pdir, timeout=300)
        except Exception as exc:
            _say("[zex] npm install failed: {}".format(exc))
    if not ok:
        return
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
        "worker": ["bot.py", "main.py", "worker.py", "app.py", "run.py", "index.py"],
    }.get(kind, ["main.py", "app.py", "bot.py", "worker.py", "run.py", "index.py"])
    py = find(py_pref)
    if py:
        return "python3 -u " + py
    py_files = [n for n in names if n.endswith(".py") and not os.path.basename(n) in ("setup.py", "conftest.py")
                and not any(x in n.split("/") for x in ("__pycache__", ".venv", "venv", "site-packages", "node_modules"))]
    if py_files:
        def rank(name):
            base = os.path.basename(name).lower()
            text = ""
            try:
                with open(os.path.join(pdir, name), encoding="utf-8", errors="ignore") as fh:
                    text = fh.read(200000)
            except Exception:
                pass
            score = 0
            if base in py_pref:
                score += 100
            if any(x in base for x in ("bot", "user", "main", "app", "run", "server", "worker", "start")):
                score += 30
            if base == "__main__.py":
                score += 25
            if "if __name__" in text and "__main__" in text:
                score += 90
            if "asyncio.run(" in text:
                score += 45
            if any(x in text for x in ("TelegramClient", "aiogram", "pyrogram", "discord.", "bot.run", "client.run", "uvicorn.run", "app.run", "FastAPI(")):
                score += 35
            if any(x in text.lower() for x in ("flask", "django", "aiohttp", "telethon", "python-telegram-bot")):
                score += 15
            score -= (name.count("/") * 3)
            return score
        py_files.sort(key=lambda n: (-rank(n), len(n)))
        return "python3 -u " + py_files[0]
    node_pref = {
        "discord_bot": ["index.js", "bot.js", "main.js", "server.js"],
        "telegram_bot": ["index.js", "bot.js", "main.js", "server.js"],
        "api": ["server.js", "index.js", "app.js", "main.js"],
        "worker": ["index.js", "worker.js", "main.js", "server.js"],
    }.get(kind, ["index.js", "server.js", "app.js", "main.js"])
    node = find(node_pref)
    if node:
        return "node " + node
    js_files = [n for n in names if n.endswith((".js", ".mjs", ".cjs"))
                and not any(x in n.split("/") for x in ("node_modules", "dist", "build"))]
    if js_files:
        def rank_js(name):
            base = os.path.basename(name).lower()
            text = ""
            try:
                with open(os.path.join(pdir, name), encoding="utf-8", errors="ignore") as fh:
                    text = fh.read(200000)
            except Exception:
                pass
            score = 0
            if base in node_pref:
                score += 100
            if any(x in base for x in ("bot", "user", "main", "app", "run", "server", "worker", "start", "index")):
                score += 30
            if any(x in text for x in ("listen(", "createServer(", ".login(", "Telegraf", "Client(", "express(")):
                score += 40
            score -= (name.count("/") * 3)
            return score
        js_files.sort(key=lambda n: (-rank_js(n), len(n)))
        return "node " + js_files[0]
    return ""


def _read_proc_stat(pid):
    try:
        with open("/proc/{}/stat".format(pid), encoding="utf-8") as fh:
            parts = fh.read().split()
        return int(parts[13]) + int(parts[14]), int(parts[3])
    except Exception:
        return None


def _tree_pids(root_pid):
    parents = {}
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open("/proc/{}/stat".format(entry), encoding="utf-8") as fh:
                parts = fh.read().split()
            parents[int(entry)] = int(parts[3])
        except Exception:
            continue
    out = [root_pid]
    changed = True
    while changed:
        changed = False
        for pid, ppid in parents.items():
            if ppid in out and pid not in out:
                out.append(pid)
                changed = True
    return out


def _proc_rss_kb(pid):
    try:
        with open("/proc/{}/status".format(pid), encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except Exception:
        pass
    return 0


def _project_metrics(pid):
    pids = _tree_pids(pid)
    rss = sum(_proc_rss_kb(p) for p in pids)
    ticks = 0
    for p in pids:
        stat = _read_proc_stat(p)
        if stat:
            ticks += stat[0]
    now = time.time()
    prev = _cpu_prev.get(pid)
    _cpu_prev[pid] = (ticks, now)
    cpu = 0.0
    if prev and now > prev[1]:
        hz = 100
        try:
            hz = os.sysconf("SC_CLK_TCK")
        except Exception:
            pass
        cpu = max(0.0, (ticks - prev[0]) / float(hz) / (now - prev[1]) * 100.0)
    return {
        "pid": pid, "processes": len(pids), "memoryMb": round(rss / 1024.0, 1),
        "cpuPercent": round(min(cpu, 100.0 * max(1, os.cpu_count() or 1)), 1),
    }


def _dir_size(path):
    total = 0
    files = 0
    for root, _dirs, names in os.walk(path):
        for name in names:
            try:
                total += os.path.getsize(os.path.join(root, name))
                files += 1
            except Exception:
                pass
    return total, files


def _system_snapshot():
    global _sys_cpu_prev
    cpu = 0.0
    try:
        with open("/proc/stat", encoding="utf-8") as fh:
            fields = [int(x) for x in fh.readline().split()[1:]]
        idle = fields[3] + (fields[4] if len(fields) > 4 else 0)
        total = sum(fields)
        if _sys_cpu_prev:
            dt = total - _sys_cpu_prev[0]
            di = idle - _sys_cpu_prev[1]
            if dt > 0:
                cpu = max(0.0, min(100.0, (dt - di) / float(dt) * 100.0))
        _sys_cpu_prev = (total, idle)
    except Exception:
        pass
    mem_total = mem_avail = 0
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            info = {}
            for line in fh:
                parts = line.split()
                if len(parts) >= 2:
                    info[parts[0].rstrip(":")] = int(parts[1]) * 1024
        mem_total = info.get("MemTotal", 0)
        mem_avail = info.get("MemAvailable", info.get("MemFree", 0))
    except Exception:
        pass
    disk = None
    try:
        usage = shutil.disk_usage(WORK_DIR)
        disk = {
            "totalBytes": usage.total, "usedBytes": usage.used, "freeBytes": usage.free,
            "percent": round(usage.used / float(usage.total) * 1000) / 10 if usage.total else 0,
        }
    except Exception:
        pass
    return {
        "cpuPercent": round(cpu, 1), "cpuCount": os.cpu_count() or 1,
        "loadavg": list(os.getloadavg()) if hasattr(os, "getloadavg") else [],
        "memory": {
            "totalBytes": mem_total, "usedBytes": max(0, mem_total - mem_avail),
            "availableBytes": mem_avail,
            "percent": round((mem_total - mem_avail) / float(mem_total) * 1000) / 10 if mem_total else 0,
        },
        "disk": disk, "uptimeMs": int(_elapsed() * 1000), "platform": sys.platform,
    }


def _project_rows():
    rows = []
    for pid, meta in _project_meta.items():
        proc_pid = _procs.get(pid)
        alive = False
        if proc_pid:
            try:
                os.kill(proc_pid, 0)
                alive = True
            except Exception:
                alive = False
        status = meta.get("status") or "pending"
        if proc_pid and alive:
            status = "running"
        elif status == "running":
            status = "stopped"
        metrics = _project_metrics(proc_pid) if proc_pid and alive else {
            "pid": None, "processes": 0, "memoryMb": 0.0, "cpuPercent": 0.0,
        }
        pdir = _safe_join(PROJECTS_DIR, pid)
        storage_bytes, _files = _dir_size(pdir)
        code_bytes = int(meta.get("code_bytes") or 0)
        started = _proc_started.get(proc_pid) if proc_pid else None
        rows.append({
            "id": pid, "name": meta.get("name") or pid, "kind": meta.get("kind") or "worker",
            "status": status, "pid": proc_pid if alive else None,
            "cpuPercent": metrics["cpuPercent"] if alive else 0.0,
            "memoryMb": metrics["memoryMb"] if alive else 0.0,
            "processes": metrics["processes"] if alive else 0,
            "storageBytes": storage_bytes, "codeBytes": code_bytes,
            "depsBytes": max(0, storage_bytes - code_bytes),
            "startedAt": int(started * 1000) if started else None,
            "uptimeMs": int((time.time() - started) * 1000) if started and alive else 0,
            "restarts": int(_restarts.get(pid, 0)), "error": meta.get("error"),
            "command": meta.get("start_command") or "", "autoStart": bool(meta.get("enabled", True)),
            "logs": (_project_logs.get(pid) or [])[-120:],
        })
    return rows


def _report_once():
    if not PANEL_URL or not WORKER_TOKEN:
        return
    payload = {
        "slot": SLOT, "role": ROLE, "projects": _project_rows(),
        "system": _system_snapshot(),
        "session": {
            "startedAt": STARTED_AT, "stopAt": int(STOP_AT * 1000),
            "remainingMs": max(0, int((STOP_AT - time.time()) * 1000)),
            "elapsedSeconds": round(_elapsed(), 1),
            "startAfterEpoch": START_AFTER_EPOCH, "stopAtEpoch": int(STOP_AT),
        },
        "logs": _log_lines[-250:],
    }
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        PANEL_URL.rstrip("/") + "/api/worker/report", data=data,
        headers={"Content-Type": "application/json", "X-ZEX-Worker-Token": WORKER_TOKEN},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=12) as resp:
        resp.read()


def _report_loop():
    _say("[zex] reporter started url={} token={}".format(PANEL_URL, "set" if WORKER_TOKEN else "missing"))
    last_ok = 0.0
    while not _stop.is_set():
        try:
            _report_once()
            if time.time() - last_ok > 300:
                last_ok = time.time()
                _say("[zex] report ok")
        except Exception as exc:
            _say("[zex] report failed: {}".format(exc))
        _stop.wait(REPORT_INTERVAL)


def _run_project(project):
    pid = str(project.get("id", ""))
    pdir = _safe_join(PROJECTS_DIR, pid)
    command = (project.get("start_command") or "").strip() or _detect_command(project, pdir)
    if (project.get("kind") or "") != "website":
        _install_deps(pdir)
    if (project.get("kind") or "") == "website":
        _say("[zex] project {} is a static website (served by the panel)".format(pid))
        _project_meta.setdefault(pid, {})["status"] = "static"
        return
    if not command:
        _say("[zex] project {} has no detected start command; skipped".format(pid))
        _project_meta.setdefault(pid, {})["status"] = "error"
        _project_meta[pid]["error"] = "no start command detected"
        return
    while not _stop.is_set():
        if ROLE != "active":
            return
        if time.time() >= STOP_AT:
            _say("[zex] project {} stop time reached".format(pid))
            return
        if time.time() < START_AFTER_EPOCH:
            _stop.wait(min(15, max(1, min(START_AFTER_EPOCH, STOP_AT) - time.time())))
            continue
        try:
            _project_meta.setdefault(pid, {})["status"] = "starting"
            proc = subprocess.Popen(
                command, shell=True, cwd=pdir, env=_project_env(project),
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, bufsize=1, start_new_session=True,
            )
            with _proc_lock:
                _procs[pid] = proc.pid
                _proc_started[proc.pid] = time.time()
                _restarts[pid] = int(_restarts.get(pid, 0)) + 1
            _project_meta.setdefault(pid, {})["status"] = "running"
            _project_meta[pid]["error"] = None
            _say("[zex] project {} started pid={} command={}".format(pid, proc.pid, command))
            threading.Thread(target=_pump_output, args=(pid, proc), daemon=True).start()
            code = proc.wait()
            with _proc_lock:
                _procs.pop(pid, None)
                _proc_started.pop(proc.pid, None)
            if _stop.is_set() or time.time() >= STOP_AT:
                _project_meta.setdefault(pid, {})["status"] = "stopped"
                break
            _project_meta.setdefault(pid, {})["status"] = "restarting"
            _say("[zex] project {} exited code={}; restarting in 10s".format(pid, code))
        except Exception as exc:
            _project_meta.setdefault(pid, {})["status"] = "error"
            _project_meta[pid]["error"] = str(exc)
            _say("[zex] project {} start failed: {}".format(pid, exc))
            traceback.print_exc()
        _stop.wait(10)


def _pump_output(pid, proc):
    try:
        for line in iter(proc.stdout.readline, ""):
            if not line:
                break
            _append_log(pid, line)
    except Exception:
        pass
    finally:
        try:
            proc.stdout.close()
        except Exception:
            pass


def _start_projects(projects):
    if ROLE != "active":
        _say("[zex] role={}; projects prepared but not started".format(ROLE))
        return
    if time.time() >= STOP_AT:
        _say("[zex] stop time already reached; projects not started")
        return
    for project in projects:
        pid = str(project.get("id", ""))
        if not project.get("enabled", True):
            _project_meta.setdefault(pid, {})["status"] = "disabled"
            continue
        if project.get("run_in_kaggle") is False:
            _project_meta.setdefault(pid, {})["status"] = "render"
            _say("[zex] project {} is set to Render runtime; skipping in Kaggle".format(pid))
            continue
        if (project.get("kind") or "") == "website":
            _project_meta.setdefault(pid, {})["status"] = "static"
            continue
        threading.Thread(target=_run_project, args=(project,), daemon=True).start()


def _write_status(state="running", detail=None):
    with _proc_lock:
        running = dict(_procs)
    data = {
        "slot": SLOT, "role": ROLE, "state": state, "detail": detail,
        "pid": os.getpid(), "started_at": STARTED_AT, "updated_at": _utc(),
        "elapsed_seconds": round(_elapsed(), 1), "session_hours": SESSION_HOURS,
        "remaining_seconds": max(0, round(STOP_AT - time.time(), 1)),
        "start_after_epoch": START_AFTER_EPOCH, "stop_at_epoch": STOP_AT,
        "projects_running": running,
    }
    try:
        os.makedirs(WORK_DIR, exist_ok=True)
        tmp = STATUS_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(data, fh, indent=2)
        os.replace(tmp, STATUS_PATH)
    except Exception as exc:
        _say("[zex] status write failed: {}".format(exc))
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
        _say("[zex] local status server disabled: {}".format(exc))


def _run_optional_workload():
    here = os.path.dirname(os.path.abspath(__file__))
    path = os.path.join(here, "workload.py")
    if not os.path.exists(path):
        return
    try:
        runpy.run_path(path, run_name="__main__")
    except Exception:
        _say("[zex] legacy workload.py crashed")
        traceback.print_exc()


def _kill_tree(pid):
    try:
        os.killpg(os.getpgid(pid), signal.SIGTERM)
    except Exception:
        try:
            os.kill(pid, signal.SIGTERM)
        except Exception:
            pass


def _on_signal(signum, _frame):
    _say("[zex] signal {} received; stopping".format(signum))
    _stop.set()
    with _proc_lock:
        pids = list(_procs.values())
    for pid in pids:
        _kill_tree(pid)


def main():
    os.makedirs(WORK_DIR, exist_ok=True)
    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)
    _say("=" * 60)
    _say("ZEX CLOUD session {} | role={}".format(SLOT, ROLE))
    _say("started_at: {}".format(STARTED_AT))
    _say("planned session: {} hours".format(SESSION_HOURS))
    _say("stop_at: {}".format(datetime.datetime.fromtimestamp(STOP_AT, datetime.timezone.utc).isoformat()))
    if ROLE == "active" and START_AFTER_EPOCH > time.time():
        _say("project start delayed until: {}".format(datetime.datetime.fromtimestamp(START_AFTER_EPOCH, datetime.timezone.utc).isoformat()))
    for host in ("pypi.org", "zex-cloud-panel.onrender.com", "api.telegram.org"):
        try:
            probe = socket.create_connection((host, 443), 5)
            probe.close()
            _say("[zex] net {}:443 ok".format(host))
        except Exception as exc:
            _say("[zex] net {}:443 failed: {}".format(host, exc))
    _say("=" * 60)
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
    threading.Thread(target=_report_loop, daemon=True).start()
    _start_projects(projects)
    threading.Thread(target=_run_optional_workload, daemon=True).start()

    last_log = 0.0
    warned = False
    while not _stop.is_set() and time.time() < STOP_AT:
        elapsed = _elapsed()
        status = _write_status("running")
        if elapsed - last_log >= 60:
            last_log = elapsed
            _say("[zex] slot={} role={} alive={}m remaining={}m projects={}".format(
                SLOT, ROLE, int(elapsed // 60),
                int(status["remaining_seconds"] // 60),
                len(status["projects_running"])))
        if ROLE == "active" and not warned and STOP_AT - time.time() <= HANDOVER_WARNING_SECONDS:
            warned = True
            _say("[zex] handover window reached")
            _write_status("handover-window")
        _stop.wait(30)

    expired = time.time() >= STOP_AT and not _stop.is_set()
    _stop.set()
    with _proc_lock:
        pids = list(_procs.values())
    for pid in pids:
        _kill_tree(pid)
    try:
        _report_once()
    except Exception:
        pass
    _write_status("expired" if expired else "stopped")
    _say("[zex] worker {} at {}".format("expired" if expired else "stopped", _utc()))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        _write_status("error", "unhandled worker exception")
        sys.exit(1)
