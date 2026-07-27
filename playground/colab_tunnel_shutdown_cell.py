# =============================================================================
# ComfyUI · Colab launcher — tunnel shutdown cell
# -----------------------------------------------------------------------------
# Standalone companion to colab_launcher_cells.py. Paste as its own Colab cell.
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
