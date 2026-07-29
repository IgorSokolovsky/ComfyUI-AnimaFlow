# ComfyUI · Colab recovery

> **Generated** from [`colab_recovery_cells.py`](colab_recovery_cells.py) by [`build_colab_md.py`](build_colab_md.py) — edit the `.py`, then re-run `python colab/build_colab_md.py`. Don't hand-edit this file.

ComfyUI · Colab launcher — recovery cells
Standalone companions to colab_launcher_cells.py, for when the panel is gone or
its state is stale. Paste each block into its own Colab cell.
CELL A — release a stuck pinggy tunnel  ("tunnel with the same token … active")
CELL B — free port 8188                 ("Port 8188 is already in use")
Both exist because the launcher's handles (TUNNEL, COMFY_PROC) live in ONE
runtime. Anything that outlives that runtime — a timeout, a crash, a "Manage
sessions" kill, or just re-running the backend cell — is invisible to Stop.

## Cells at a glance

| # | Cell | Contains |
|---|---|---|
| A | [tunnel](#cell-A) | — |
| B | [port 8188](#cell-B) | — |

**Paste each cell below into its own Colab cell, in order.** They are not interchangeable: later cells use names earlier ones define, and cells shown as one block must stay one block.

<a id="cell-A"></a>

## Cell A — tunnel

```python
#
# Use when Launch fails with:
#   "A tunnel with the same token (…) is already active."
#
# That happens because _kill_tunnel() in the launcher only knows about the TUNNEL
# object in the CURRENT runtime. When a runtime dies (timeout, crash, "Manage
# sessions" kill) nothing closes the tunnel client-side, yet pinggy's edge still
# counts it active — so every later Launch is refused until it ages out.
#
# Leaves ComfyUI RUNNING; this only drops the tunnel. If the launcher panel is
# still alive, its Stop button already does both (stop_comfy → _kill_tunnel) —
# this cell is for when the panel is gone or its state is stale.
#
# NOTE: force kicks any tunnel on that token, including one on another machine.
# =============================================================================

#@title 🛑 Shut down the pinggy tunnel { display-mode: "form" }
import json, time

try:
    import pinggy
except ImportError:
    import subprocess, sys
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "pinggy"])
    import pinggy

# 1) Close a tunnel owned by THIS runtime, if the launcher backend cell has run.
try:
    _t = TUNNEL
except NameError:
    _t = None
if _t is not None:
    for _m in ("stop", "close"):
        _fn = getattr(_t, _m, None)
        if callable(_fn):
            try:
                _fn(); print(f"tunnel.{_m}() ok")
            except Exception as e:
                print(f"tunnel.{_m}() error: {e}")
    TUNNEL = None
else:
    print("no tunnel object in this runtime")

# 2) Release a STALE tunnel left by a dead runtime: nothing local can close it, so
#    take the token over with force=True (drops the old one), then close the
#    replacement we just made. Net effect: the token is free again.
CFG = "/content/drive/MyDrive/ComfyUI/launcher_config.json"
try:
    with open(CFG) as f:
        token = (json.load(f).get("tunnel") or {}).get("pinggy_token", "") or ""
except Exception as e:
    token = ""
    print("could not read token from config:", e)

if not token:
    print("no stored token - free/random tunnels die with their runtime, nothing to release")
else:
    try:
        _tmp = pinggy.start_tunnel(forwardto="localhost:8188", token=token, force=True)
        time.sleep(2)
        for _m in ("stop", "close"):
            _fn = getattr(_tmp, _m, None)
            if callable(_fn):
                _fn(); print(f"takeover tunnel.{_m}() ok"); break
        print("token released - Launch will work again")
    except Exception as e:
        print("force-release failed:", e)
        print("  -> close it under Active Tunnels at https://dashboard.pinggy.io")
```

<a id="cell-B"></a>

## Cell B — port 8188

```python
# Use when ComfyUI exits with:
#   [ERROR] Port 8188 is already in use on address 0.0.0.0.
#
# Cause: a ComfyUI server from an earlier Launch is still alive, but this runtime
# no longer holds its handle (comfy_running() is False), so Stop did nothing.

#@title 🔌 Free port 8188 { display-mode: "form" }
import os, signal, socket, time

COMFY_PATH = globals().get("COMFY_PATH", "/content/ComfyUI")

def _port_open(port=8188, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0

if not _port_open():
    print("port 8188 is already free - nothing to do")
else:
    # /proc scan: no psutil/lsof/fuser needed, none are guaranteed on a Colab image.
    me, pids = os.getpid(), []
    for entry in os.listdir("/proc"):
        if not entry.isdigit() or int(entry) == me:
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as f:
                cmd = f.read().decode("utf-8", "replace").replace("\x00", " ")
        except Exception:
            continue
        if "main.py" not in cmd:
            continue
        try:
            cwd = os.readlink(f"/proc/{entry}/cwd")
        except Exception:
            cwd = ""
        if cwd == COMFY_PATH or "8188" in cmd:
            pids.append(int(entry))

    if not pids:
        print("port 8188 is held by something that is NOT a ComfyUI main.py.")
        print("  -> launch on another port, or restart the runtime")
    else:
        for pid in pids:
            print(f"killing orphaned ComfyUI pid {pid}")
            # started with start_new_session by the launcher, so pgid == pid
            for sig in (signal.SIGTERM, signal.SIGKILL):
                try:
                    os.killpg(os.getpgid(pid), sig)
                except Exception:
                    try: os.kill(pid, sig)
                    except Exception: pass
                freed = False
                for _ in range(20):        # up to 10s per signal
                    if not _port_open():
                        freed = True; break
                    time.sleep(0.5)
                if freed:
                    break
        try:
            COMFY_PROC = None              # drop the launcher's stale handle, if present
        except Exception:
            pass
        print("port 8188 free - Launch will work again" if not _port_open()
              else "port 8188 STILL bound after SIGKILL - restart the runtime")
```
