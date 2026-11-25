#!/usr/bin/env python3
import sys, os, json, traceback

MARK = "@@JSON@@"

def out(obj):
    print(MARK + json.dumps(obj))

def get_api():
    os.environ.setdefault("KAGGLE_USERNAME", os.environ.get("ZEX_KAGGLE_USER", ""))
    os.environ.setdefault("KAGGLE_KEY", os.environ.get("ZEX_KAGGLE_KEY", ""))
    from kaggle.api.kaggle_api_extended import KaggleApi
    api = KaggleApi()
    api.authenticate()
    return api

def clean_status(s):
    s = str(s)
    return s.split(".")[-1]

def main():
    if len(sys.argv) < 2:
        out({"ok": False, "error": "usage: kaggle_ctl.py <status|push|logs|output> ..."})
        return 1
    cmd = sys.argv[1]
    try:
        if cmd == "status":
            ref = sys.argv[2]
            api = get_api()
            r = api.kernels_status(ref)
            out({
                "ok": True,
                "ref": ref,
                "status": clean_status(r.status),
                "raw": str(r.status),
                "failure": getattr(r, "failure_message", None),
            })
            return 0
        if cmd == "push":
            folder = sys.argv[2]
            api = get_api()
            r = api.kernels_push(folder)
            out({"ok": True, "folder": folder, "result": {
                "ref": getattr(r, "ref", None),
                "url": getattr(r, "url", None),
                "versionNumber": getattr(r, "versionNumber", None),
                "kernelId": getattr(r, "kernelId", None),
                "error": getattr(r, "error", None),
            }})
            return 0
        if cmd == "logs":
            ref = sys.argv[2]
            api = get_api()
            text = api.kernels_logs(ref)
            if not text:
                import time
                lines = []
                deadline = time.time() + 12
                try:
                    for ev in api.kernels_logs_stream(ref):
                        data = (ev.get("data") or "").rstrip()
                        if data:
                            lines.append(data)
                        if time.time() > deadline or len(lines) >= 200:
                            break
                except Exception:
                    pass
                text = "\n".join(lines[-200:])
            print(text)
            return 0
        if cmd == "output":
            ref = sys.argv[2]
            dest = sys.argv[3]
            api = get_api()
            files, msg = api.kernels_output(ref, dest, force=True, quiet=True)
            out({"ok": True, "files": files, "message": str(msg)})
            return 0
        out({"ok": False, "error": "unknown command " + cmd})
        return 1
    except Exception as e:
        out({"ok": False, "error": str(e), "trace": traceback.format_exc()[-800:]})
        return 1

if __name__ == "__main__":
    sys.exit(main())
