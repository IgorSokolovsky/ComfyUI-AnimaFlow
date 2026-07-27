# =============================================================================
# ComfyUI · Colab launcher — reference cells
# -----------------------------------------------------------------------------
# Mirror of playground/colab-launcher.html, as real Colab cells.
# Paste each block into its own Colab cell (markers below).
# All state lives in {GDRIVE_BASE}/launcher_config.json and persists across runtimes.
# Set cells 2 & 3 to Form view (⋮ → Form → Hide code) to get the code-hidden UI.
# =============================================================================


# ============================== CELL 1 — Drive mount =========================
# (Plain run-once cell. Needs Google auth, so it stays outside the panel.)

from google.colab import drive
import os

drive.mount('/content/drive', force_remount=True)

GDRIVE_BASE = '/content/drive/MyDrive/ComfyUI'   # persistent data lives here
COMFY_PATH  = '/content/ComfyUI'                  # app on fast local disk

REQUIRED_FOLDERS = [
    'models/checkpoints', 'models/controlnet', 'models/vae',
    'models/upscale_models', 'models/latent_upscale_models', 'models/clip',
    'models/unet', 'models/loras', 'models/ipadapter', 'models/clip_vision',
    'models/text_encoders',
    'custom_nodes', 'input', 'output', 'temp', 'user', 'my_workflows', 'pip_cache',
]
for f in REQUIRED_FOLDERS:
    os.makedirs(os.path.join(GDRIVE_BASE, f), exist_ok=True)

print("Drive folders ready.")


# ============================== CELL 2 — Backend =============================
#@title 🔧 Launcher backend (run once) { display-mode: "form" }
import os, sys, json, copy, shutil, subprocess, time, signal, socket

CONFIG_PATH = os.path.join(GDRIVE_BASE, 'launcher_config.json')
CN_DIR      = os.path.join(GDRIVE_BASE, 'custom_nodes')
PIP_CACHE   = os.path.join(GDRIVE_BASE, 'pip_cache')
LOG_PATH    = '/content/comfy.log'
PIP         = [sys.executable, '-m', 'pip']
SYMLINKS    = ['models', 'custom_nodes', 'input', 'output', 'user', 'my_workflows']

# Persistent pip target on Drive: install node/extra deps here ONCE, reuse every
# session (Colab wipes site-packages each runtime, but Drive persists). Version-
# tagged so a Colab Python bump gets a fresh dir instead of a broken ABI mix.
PY_DEPS = os.path.join(GDRIVE_BASE, 'py_deps', f'py{sys.version_info.major}.{sys.version_info.minor}')
os.makedirs(PY_DEPS, exist_ok=True)

def register_pydeps():
    """Make PY_DEPS importable by EVERY python process this runtime — including the
    ComfyUI subprocess — by writing a .pth file into site-packages. `site` auto-loads
    it at interpreter startup (more reliable than PYTHONPATH, which depends on env
    plumbing) and APPENDS it, so Colab's CUDA-matched torch/numpy stay authoritative.
    site-packages is wiped each runtime, so we (cheaply) rewrite the .pth each time."""
    if PY_DEPS not in sys.path:
        sys.path.append(PY_DEPS)
    import sysconfig, site as _site
    candidates = []
    try: candidates.append(sysconfig.get_path("purelib"))
    except Exception: pass
    try: candidates += _site.getsitepackages()
    except Exception: pass
    for sp in candidates:
        try:
            if sp and os.path.isdir(sp) and os.access(sp, os.W_OK):
                with open(os.path.join(sp, "zzz_comfy_pydeps.pth"), "w") as f:
                    f.write(PY_DEPS + "\n")
                return sp
        except Exception:
            continue
    return None

_PTH_DIR = register_pydeps()

def _pydeps_env():
    """Belt-and-suspenders: also expose PY_DEPS via PYTHONPATH (helps pip's resolver
    recognise already-target-installed packages so re-runs are fast no-ops)."""
    pp = PY_DEPS + (os.pathsep + os.environ["PYTHONPATH"] if os.environ.get("PYTHONPATH") else "")
    return {"PYTHONPATH": pp}

def _dist_present(spec):
    """Is this pip spec already installed (base env OR PY_DEPS, which is on sys.path)?
    Checks by distribution name so import-name!=package-name doesn't matter."""
    from importlib import metadata
    import re as _re2
    name = _re2.split(r"[<>=!~;\[\s]", spec.strip())[0]
    if not name:
        return True
    try:
        metadata.version(name); return True
    except Exception:
        return False

def _pydeps_has_content():
    """True once the Drive deps folder holds at least one installed package."""
    try:
        return any(e not in ("bin", "__pycache__") for e in os.listdir(PY_DEPS))
    except Exception:
        return False

# ---- defaults (seed for launcher_config.json on first run) ------------------
DEFAULT_CONFIG = {
    "version": 1,
    "paths": {"gdrive_base": GDRIVE_BASE, "comfy_path": COMFY_PATH},
    # comfy_ref_mode: "master" = track the branch tip · "pin" = check out comfy_ref
    # (a tag/sha). Pin when master regresses; ComfyUI cuts patch tags (v0.28.1+) on a
    # release branch, so a tag is NOT simply "master + fixes" — it diverges from it.
    # frontend_override off → ComfyUI uses the comfyui-frontend-package pinned by the
    # checked-out ref's requirements.txt. On → launch with --front-end-version, which
    # downloads that build from GitHub releases instead. Independent of comfy_ref: the
    # UI bugs live in the frontend, so this pins the UI without moving the repo.
    "settings": {"packs_update_mode": "pull", "env_force_reqs": False, "tail_lines": 40,
                 "comfy_ref_mode": "master", "comfy_ref": "v0.28.3",
                 "frontend_override": False,
                 "frontend_version": "Comfy-Org/ComfyUI_frontend@1.48.5"},
    "node_packs": [
        {"name": "ComfyUI-AnimaFlow",             "url": "https://github.com/IgorSokolovsky/ComfyUI-AnimaFlow.git",    "enabled": True},
        {"name": "ComfyUI_IPAdapter_plus",        "url": "https://github.com/cubiq/ComfyUI_IPAdapter_plus.git",        "enabled": True},
        {"name": "comfyui_controlnet_aux",        "url": "https://github.com/Fannovel16/comfyui_controlnet_aux.git",   "enabled": True},
        {"name": "ComfyUI_essentials",            "url": "https://github.com/cubiq/ComfyUI_essentials.git",            "enabled": True},
        {"name": "was-node-suite-comfyui",        "url": "https://github.com/WASasquatch/was-node-suite-comfyui.git",  "enabled": True},
        {"name": "rgthree-comfy",                 "url": "https://github.com/rgthree/rgthree-comfy.git",               "enabled": True},
        {"name": "ComfyUI-Custom-Scripts",        "url": "https://github.com/pythongosssss/ComfyUI-Custom-Scripts.git","enabled": True},
        {"name": "ComfyUI-KJNodes",               "url": "https://github.com/kijai/ComfyUI-KJNodes.git",               "enabled": True},
        {"name": "ComfyUI-RMBG",                  "url": "https://github.com/1038lab/ComfyUI-RMBG.git",                "enabled": True},
        {"name": "ComfyUI-Lora-Manager",          "url": "https://github.com/willmiao/ComfyUI-Lora-Manager.git",       "enabled": True},
        {"name": "ComfyUI_Comfyroll_CustomNodes", "url": "https://github.com/Suzie1/ComfyUI_Comfyroll_CustomNodes.git","enabled": True},
        {"name": "cg-use-everywhere",             "url": "https://github.com/chrisgoringe/cg-use-everywhere.git",      "enabled": True},
        {"name": "Civicomfy",                     "url": "https://github.com/MoonGoblinDev/Civicomfy.git",             "enabled": True},
        {"name": "ComfyUI-EasyIllustrious",       "url": "https://github.com/regiellis/ComfyUI-EasyIllustrious.git",   "enabled": True},
        {"name": "ComfyUI-EasyUseAnima",          "url": "https://github.com/n0va39/ComfyUI-EasyUseAnima.git",         "enabled": True},
        {"name": "ComfyUI-Pixaroma",              "url": "https://github.com/pixaroma/ComfyUI-Pixaroma.git",           "enabled": True},
        {"name": "comfyui_model_installer",       "url": "https://github.com/gignit/comfyui_model_installer.git",      "enabled": True},
        {"name": "ComfyUI-Crystools",             "url": "https://github.com/crystian/ComfyUI-Crystools.git",          "enabled": True},
        {"name": "Anima_Regional_Canvas",         "url": "https://github.com/ukr8b3g-cmyk/Anima_Regional_Canvas.git",  "enabled": True},
    ],
    "extra_pip": 'deepdiff piexif dpath open_clip_torch "kornia==0.7.3"',
    "models": [
        {"folder": "models/clip_vision",     "file": "CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors", "url": "https://huggingface.co/h94/IP-Adapter/resolve/main/models/image_encoder/model.safetensors",                          "enabled": True},
        {"folder": "models/ipadapter",       "file": "ip-adapter-plus_sdxl_vit-h.safetensors",      "url": "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus_sdxl_vit-h.safetensors",             "enabled": True},
        {"folder": "models/ipadapter",       "file": "ip-adapter-plus-face_sdxl_vit-h.safetensors", "url": "https://huggingface.co/h94/IP-Adapter/resolve/main/sdxl_models/ip-adapter-plus-face_sdxl_vit-h.safetensors",        "enabled": True},
        {"folder": "models/controlnet",      "file": "OpenPoseXL2.safetensors",                     "url": "https://huggingface.co/thibaud/controlnet-openpose-sdxl-1.0/resolve/main/OpenPoseXL2.safetensors",                 "enabled": True},
        {"folder": "models/controlnet",      "file": "diffusers_xl_depth_full.safetensors",         "url": "https://huggingface.co/diffusers/controlnet-depth-sdxl-1.0/resolve/main/diffusion_pytorch_model.safetensors",     "enabled": True},
        {"folder": "models/upscale_models",  "file": "4x_NMKD-Siax_200k.pth",                       "url": "https://icedrive.net/1/43GNBihZyi",                                                                                    "enabled": True},
        {"folder": "models/text_encoders",   "file": "qwen_3_06b_base.safetensors",                 "url": "https://huggingface.co/circlestone-labs/Anima/resolve/main/split_files/text_encoders/qwen_3_06b_base.safetensors",  "enabled": True},
    ],
    "tunnel": {"pinggy_token": "", "remember_token": True},
}

# ---- config load / merge / save --------------------------------------------
def _pack_key(p):  return p.get("name", "")
def _model_key(m): return m.get("folder", "") + "/" + m.get("file", "")

def _merge_list(saved_list, default_list, key_fn, seen_keys):
    """Saved list is authoritative for membership + flags. Append only defaults
    that are genuinely NEW (never seen before), so UI-removed packs stay removed."""
    result = [copy.deepcopy(x) for x in saved_list]
    have = {key_fn(x) for x in result}
    seen = set(seen_keys)
    for d in default_list:
        k = key_fn(d)
        if k not in seen and k not in have:
            result.append(copy.deepcopy(d))
            have.add(k)
        seen.add(k)
    return result, sorted(seen)

def load_config():
    saved = {}
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH) as f:
                saved = json.load(f)
        except Exception as e:
            print("⚠ config parse error — starting from defaults:", e)
            saved = {}
    cfg = copy.deepcopy(DEFAULT_CONFIG)
    for sect in ("paths", "settings", "tunnel"):
        cfg[sect].update(saved.get(sect, {}))
    cfg["extra_pip"] = saved.get("extra_pip", cfg["extra_pip"])
    cfg["node_packs"], cfg["_seen_default_packs"] = _merge_list(
        saved.get("node_packs", []), DEFAULT_CONFIG["node_packs"],
        _pack_key, saved.get("_seen_default_packs", []))
    cfg["models"], cfg["_seen_default_models"] = _merge_list(
        saved.get("models", []), DEFAULT_CONFIG["models"],
        _model_key, saved.get("_seen_default_models", []))
    return cfg

def save_config(cfg):
    tmp = CONFIG_PATH + ".tmp"
    with open(tmp, "w") as f:
        json.dump(cfg, f, indent=2)
    os.replace(tmp, CONFIG_PATH)   # atomic — never leaves a half-written file

# ---- shell helper: stream a command's output to a log callback --------------
def _run(cmd, log, cwd=None, extra_env=None):
    # git/pip/wget block-buffer when their stdout is a pipe (not a TTY), so
    # output wouldn't stream. Force line buffering: stdbuf on the command +
    # PYTHONUNBUFFERED for any Python child (pip). Without this only the last
    # chunk appears, long after the step "looks" frozen.
    env = dict(os.environ, PYTHONUNBUFFERED="1")
    if extra_env:
        env.update(extra_env)
    if shutil.which("stdbuf"):
        cmd = ["stdbuf", "-oL", "-eL"] + list(cmd)
    proc = subprocess.Popen(cmd, cwd=cwd, env=env, stdout=subprocess.PIPE,
                            stderr=subprocess.STDOUT, text=True, bufsize=1)
    for line in proc.stdout:
        log(line.rstrip())
    proc.wait()
    return proc.returncode

def _git_head(path):
    return subprocess.run(["git", "-C", path, "rev-parse", "HEAD"],
                          capture_output=True, text=True).stdout.strip()

def _install_reqs(path, log):
    req = os.path.join(path, "requirements.txt")
    if os.path.exists(req):
        log("   · installing requirements…")
        _run(PIP + ["install", "--cache-dir", PIP_CACHE, "--target", PY_DEPS, "-r", req],
             log, extra_env=_pydeps_env())
    else:
        log("   · no requirements.txt")

# ---- 01 Environment ---------------------------------------------------------
def link_drive_folders(log):
    for name in SYMLINKS:
        target = os.path.join(GDRIVE_BASE, name)
        os.makedirs(target, exist_ok=True)
        source = os.path.join(COMFY_PATH, name)
        if os.path.islink(source):
            os.unlink(source)
        elif os.path.isdir(source):
            shutil.rmtree(source)
        os.symlink(target, source)
    log(f"   · {len(SYMLINKS)} symlinks OK")

def _comfy_version(log):
    """Log what we actually ended up on: the version string ComfyUI reports plus the
    nearest tag. Master's comfyui_version.py lags its own patch tags (it still says
    0.28.0 while v0.28.3 exists), so print both or the log is misleading."""
    ver = "?"
    try:
        with open(os.path.join(COMFY_PATH, "comfyui_version.py")) as f:
            for line in f:
                if "__version__" in line:
                    ver = line.split("=", 1)[1].strip().strip("\"'")
                    break
    except Exception:
        pass
    desc = subprocess.run(["git", "-C", COMFY_PATH, "describe", "--tags", "--always"],
                          capture_output=True, text=True).stdout.strip()
    log(f"   · ComfyUI {ver}  (git {desc or _git_head(COMFY_PATH)[:8]})")

def checkout_comfy(ref, log):
    """ref = "" → track master's tip · ref = "v0.28.3"/sha → detached checkout.

    checkout needs -f because link_drive_folders() has replaced tracked dirs
    (models/, input/, custom_nodes/, user/) with symlinks, so git sees them as
    deleted and refuses a clean switch.

    IMPORTANT: -f DROPS those symlinks — git deletes each one and restores the real
    tracked dir (models/put_checkpoints_here, input/example.png …) in its place. The
    Drive data is never touched (git replaces the link, it does not write through
    it), but ComfyUI would then read local /content instead of Drive. That is why
    bootstrap_env() must call link_drive_folders() AFTER this — do not reorder.

    Only master gets a pull; a tag checkout is a detached HEAD, where `git pull`
    fails."""
    _run(["git", "-C", COMFY_PATH, "fetch", "--tags", "--force", "origin"], log)
    target = ref or "master"
    log(f"▸ checkout ComfyUI @ {target}")
    if _run(["git", "-C", COMFY_PATH, "checkout", "-f", target], log) != 0:
        log(f"   ✖ no such ref '{target}' — staying put. Check the tag name.")
        return False
    if not ref:
        _run(["git", "-C", COMFY_PATH, "pull", "--ff-only"], log)
    _comfy_version(log)
    return True

def bootstrap_env(force, log, ref=""):
    if not os.path.exists(COMFY_PATH):
        log("▸ cloning ComfyUI…")
        # full clone (no --depth): a shallow one has no tags to check out
        _run(["git", "clone", "https://github.com/Comfy-Org/ComfyUI.git", COMFY_PATH], log)
        checkout_comfy(ref, log)
    else:
        log("▸ git fetch ComfyUI")
        checkout_comfy(ref, log)

    log("▸ pip install ComfyUI requirements" + ("  (--force-reinstall)" if force else ""))
    cmd = PIP + ["install", "--cache-dir", PIP_CACHE]
    if force:
        cmd.append("--force-reinstall")
    cmd += ["-r", os.path.join(COMFY_PATH, "requirements.txt")]
    _run(cmd, log)

    log("▸ symlinking Drive folders")
    link_drive_folders(log)

    mgr = os.path.join(CN_DIR, "ComfyUI-Manager")
    if not os.path.exists(mgr):
        log("▸ installing ComfyUI-Manager")
        _run(["git", "clone", "https://github.com/ltdrdata/ComfyUI-Manager.git", mgr], log)
    else:
        log("▸ ComfyUI-Manager present")

    try:
        import torch
        dev = torch.cuda.get_device_name(0) if torch.cuda.is_available() else "None"
        log(f"CUDA: {torch.cuda.is_available()} · {dev}")
    except Exception as e:
        log(f"torch check skipped: {e}")
    log("✔ Environment ready.")

# ---- 02 Node packs ----------------------------------------------------------
def sync_packs(cfg, log):
    mode = cfg["settings"]["packs_update_mode"]
    os.makedirs(CN_DIR, exist_ok=True)
    packs = [p for p in cfg["node_packs"]
             if p.get("enabled", True) and p.get("name") and p.get("url")]
    log(f"Mode: {mode} · {len(packs)} pack(s)")
    installed = 0
    for p in packs:
        name, url = p["name"], p["url"]
        path = os.path.join(CN_DIR, name)
        log(f"▸ {name}")
        if not os.path.exists(path):
            log("   · cloning…")
            if _run(["git", "clone", url, path], log) != 0:
                log("   ✗ clone failed"); continue
            _install_reqs(path, log); installed += 1
            continue
        if mode == "skip":
            log("   · exists — skipping"); continue
        before = _git_head(path)
        _run(["git", "-C", path, "pull", "--ff-only"], log)
        after = _git_head(path)
        if before != after:
            log(f"   · updated {before[:7]} → {after[:7]}")
        else:
            log("   · already up to date")
        if before != after or mode == "force":
            _install_reqs(path, log); installed += 1
    log(f"✔ Done · {installed} pack(s) touched requirements.")

def install_all_reqs(cfg, log, force=False):
    """Install requirements.txt for every enabled pack in ONE pip pass → Drive deps.
    Persisted, so this is a catch-all for a fresh setup or a newly added node — NOT a
    per-session step. If the Drive folder is already populated it no-ops instantly
    unless Force is set (which adds --upgrade to actually refresh)."""
    if not force and _pydeps_has_content():
        log("✔ Drive deps already populated — skipping (tick Force to reinstall/refresh).")
        return
    packs = [p for p in cfg["node_packs"] if p.get("enabled", True) and p.get("name")]
    req_files = [os.path.join(CN_DIR, p["name"], "requirements.txt") for p in packs]
    req_files = [r for r in req_files if os.path.isfile(r)]
    if not req_files:
        log("No requirements.txt files found among enabled packs."); return
    log(f"{'Force: ' if force else ''}Installing {len(req_files)} requirements file(s) → Drive deps, one pass…")
    cmd = PIP + ["install", "--cache-dir", PIP_CACHE, "--target", PY_DEPS] + (["--upgrade"] if force else [])
    for r in req_files:
        cmd += ["-r", r]
    if _run(cmd, log, extra_env=_pydeps_env()) != 0:
        # one bad/conflicting file sinks the combined pass — isolate per-pack so the
        # rest still install, and the culprit is obvious in the log.
        log("⚠ combined pass failed — retrying per-pack to isolate the culprit…")
        per = PIP + ["install", "--cache-dir", PIP_CACHE, "--target", PY_DEPS] + (["--upgrade"] if force else [])
        for r in req_files:
            log(f"▸ {os.path.basename(os.path.dirname(r))}")
            _run(per + ["-r", r], log, extra_env=_pydeps_env())
    log("✔ Requirements pass complete.")

# ---- 03 Extra pip -----------------------------------------------------------
def install_extra_pip(text, log, force=False):
    import shlex
    pkgs = shlex.split(text)          # respects quotes like "kornia==0.7.3"
    if not pkgs:
        log("⚠ Nothing to install."); return
    if not force:
        pkgs = [p for p in pkgs if not _dist_present(p)]   # only what's genuinely missing
        if not pkgs:
            log("✔ All listed packages already present — nothing to do (tick Force to reinstall).")
            return
        log(f"▸ installing {len(pkgs)} missing package(s) → Drive deps")
    else:
        log(f"▸ Force: (re)installing {len(pkgs)} package(s) → Drive deps")
    base = PIP + ["install", "--cache-dir", PIP_CACHE, "--target", PY_DEPS] + (["--upgrade"] if force else [])
    if _run(base + pkgs, log, extra_env=_pydeps_env()) != 0:
        # one bad/unbuildable package (e.g. a typo or an abandoned project) fails the
        # whole batch — retry per-package so the good ones still land and the culprit
        # is named instead of silently taking everything down with it.
        log("⚠ batch failed — installing one-by-one to isolate the bad package…")
        failed = []
        for p in pkgs:
            log(f"▸ {p}")
            if _run(base + [p], log, extra_env=_pydeps_env()) != 0:
                failed.append(p)
        if failed:
            log("✗ could not install: " + ", ".join(failed))
    log("✔ Done.")

# ---- 04 Models --------------------------------------------------------------
def model_present(m):
    return os.path.exists(os.path.join(GDRIVE_BASE, m["folder"], m["file"]))

def download_models(cfg, log):
    sel = [m for m in cfg["models"] if not model_present(m) and m.get("enabled", True)]
    if not sel:
        log("Nothing to download — all present."); return
    for m in sel:
        dest_dir = os.path.join(GDRIVE_BASE, m["folder"])
        os.makedirs(dest_dir, exist_ok=True)
        fpath = os.path.join(dest_dir, m["file"])
        log(f"▸ {m['file']}")
        rc = _run(["wget", "--progress=dot:giga", "-O", fpath, m["url"]], log)
        if rc == 0 and os.path.getsize(fpath) > 0:
            log("   · saved to Drive")
        else:
            log("   ✗ download failed")
            if os.path.exists(fpath) and os.path.getsize(fpath) == 0:
                os.remove(fpath)   # don't leave a 0-byte file that masks the missing model
    log("✔ Models ready.")

# ---- 05 Launch & tunnel -----------------------------------------------------
COMFY_PROC = None
TUNNEL = None

def comfy_running():
    return COMFY_PROC is not None and COMFY_PROC.poll() is None

def _port_open(port=8188, host="127.0.0.1"):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0

def launch_comfy(token, log, set_status, set_url, frontend=""):
    """Start ComfyUI and wait (SYNCHRONOUSLY) until :8188 answers, then open the
    tunnel. Synchronous on purpose: in Colab, log lines only stream to the browser
    during blocking main-thread execution — an asyncio/thread waiter would run
    outside that context and the live log would freeze. Cost: the panel is busy for
    the duration of the boot (can't click Stop mid-boot); that's the Colab trade-off,
    and streaming the boot log is worth more here. 30-min deadline covers a cold
    start of a big node set (~13 min); on timeout we leave it running (never lock
    out Stop) rather than dropping to a dead 'error' state."""
    global COMFY_PROC, TUNNEL
    if comfy_running():
        log("Already running."); return
    set_status("starting")
    log("▸ starting ComfyUI…")
    # -u + PYTHONUNBUFFERED so ComfyUI flushes to the log file promptly.
    # No PYTHONPATH on purpose: ComfyUI picks up PY_DEPS via the .pth file, which
    # APPENDS it, so Colab's CUDA-matched base numpy/protobuf/torch win.
    logf = open(LOG_PATH, "w")
    argv = [sys.executable, "-u", "main.py", "--listen", "0.0.0.0", "--port", "8188",
            "--cuda-device", "0", "--enable-cors-header", "*"]
    if frontend:
        # owner/repo@version — ComfyUI fetches this build from GitHub releases at boot
        # (needs network; it caches under ComfyUI/web_custom_versions afterwards). An
        # unknown version makes ComfyUI exit early, which shows up as "exited early".
        argv += ["--front-end-version", frontend]
        log(f"   · frontend override: {frontend}")
    COMFY_PROC = subprocess.Popen(
        argv,
        cwd=COMFY_PATH, stdout=logf, stderr=subprocess.STDOUT,
        env=dict(os.environ, PYTHONUNBUFFERED="1"),
        start_new_session=True)   # own process group → Stop can kill it + any children cleanly

    ready = False
    deadline = time.time() + 1800          # 30-min cap for a cold big-node-set boot
    next_check = 0.0
    with open(LOG_PATH) as reader:
        while time.time() < deadline:
            line = reader.readline()
            if line:
                log(line.rstrip())          # streams live (blocking main-thread execution)
            else:
                if COMFY_PROC.poll() is not None:
                    for rest in reader:
                        log(rest.rstrip())
                    log("✗ ComfyUI exited early — see § Server log.")
                    set_status("error"); return
                time.sleep(0.3)
            now = time.time()
            if now >= next_check:
                next_check = now + 2
                if _port_open(8188):
                    ready = True; break
    if not ready:
        log("⚠ :8188 not up after 30 min — leaving ComfyUI running (Stop enabled). "
            "Check § Server log, or Restart.")
        set_status("running" if comfy_running() else "error")
        return
    log("  server up on :8188")

    try:
        import pinggy
    except Exception:
        log("  installing pinggy…")
        _run(PIP + ["install", "pinggy"], log)
        import pinggy
    try:
        _kill_tunnel(log)          # close any leftover tunnel so the new one isn't rejected
        log("▸ opening pinggy tunnel…")
        # force=True is REQUIRED on Colab, not just nice-to-have: _kill_tunnel only knows
        # about TUNNEL in THIS runtime. When a runtime dies (timeout, crash, "Manage
        # sessions" kill) the tunnel is never closed client-side, yet pinggy's edge still
        # counts it as active — so the next Launch is refused with "A tunnel with the same
        # token (…) is already active". force tells pinggy to drop that stale tunnel first.
        # Safe here because one token serves one Colab session; it WOULD kick a tunnel
        # using the same token elsewhere. Older pinggy builds lack the kwarg, so fall back.
        try:
            TUNNEL = pinggy.start_tunnel(forwardto="localhost:8188",
                                         token=token or "", force=True)
        except TypeError:
            log("  (pinggy build has no force= — retrying without it)")
            TUNNEL = pinggy.start_tunnel(forwardto="localhost:8188", token=token or "")
        urls = None
        for _ in range(20):                     # urls may populate a moment later
            urls = getattr(TUNNEL, "urls", None)
            if urls:
                break
            time.sleep(0.5)
        if urls:
            log(f"✔ tunnel: {urls}")
            set_url(urls)
        else:
            log("⚠ tunnel started but reported no URL yet.")
    except Exception as e:
        log(f"✗ tunnel failed: {e}")
        if "already active" in str(e):
            log("  → a stale tunnel still holds this token. Close it under Active Tunnels "
                "at https://dashboard.pinggy.io, or clear the token field to get a free "
                "random URL for this session.")
    set_status("running")

def _kill_tunnel(log):
    global TUNNEL
    if TUNNEL is None:
        return
    log("▸ closing pinggy tunnel…")
    done = False
    for m in ("stop", "close"):                 # API name varies by version
        fn = getattr(TUNNEL, m, None)
        if callable(fn):
            try:
                fn(); log(f"  tunnel.{m}() ✔"); done = True
            except Exception as e:
                log(f"  tunnel.{m}() error: {e}")
    if not done:
        log("  ⚠ no stop/close method found on tunnel object")
    TUNNEL = None

def _kill_comfy(log):
    global COMFY_PROC
    if comfy_running():
        log("▸ stopping ComfyUI…")
        try:                                    # kill the whole process group
            os.killpg(os.getpgid(COMFY_PROC.pid), signal.SIGTERM)
        except Exception:
            COMFY_PROC.terminate()
        try:
            COMFY_PROC.wait(timeout=10)
        except Exception:
            try: os.killpg(os.getpgid(COMFY_PROC.pid), signal.SIGKILL)
            except Exception: COMFY_PROC.kill()
    COMFY_PROC = None

def stop_comfy(log, set_status, set_url):
    _kill_tunnel(log)                           # tunnel first, so it can't outlive the server
    _kill_comfy(log)
    set_url(None)
    set_status("stopped")
    log("■ stopped.")

# ---- 06 Server log ----------------------------------------------------------
def tail_log(n=40):
    if not os.path.exists(LOG_PATH):
        return "(no log yet)"
    with open(LOG_PATH) as f:
        return "".join(f.readlines()[-n:]) or "(empty)"

print("Backend ready. Run the control panel cell below. ⬇️")


# ============================== CELL 3 — Control panel =======================
#@title 🎛️ ComfyUI Control Panel { display-mode: "form" }
import ipywidgets as widgets
from IPython.display import display

cfg = load_config()
_guard = {"on": False}   # re-entrancy guard for select-all observers

def ui_save():
    save_config(cfg)
    cfg_view.value = json.dumps(cfg, indent=2)
    saved_tag.value = "<span style='color:#4ade80;font-family:monospace'>saved ✓</span>"

import html as _html, time as _time, re as _re

_ANSI = _re.compile(r"\x1b\[[0-9;]*[A-Za-z]")   # strip terminal color/escape codes

class LogBox:
    """A live log console backed by an HTML widget. Updating .value syncs
    reliably from background threads in Colab (unlike ipywidgets.Output, which
    silently drops thread output). Newest line stays pinned to the bottom via a
    column-reverse flex container. Call it like a function: log('some line')."""
    def __init__(self, max_lines=500):
        self.w = widgets.HTML(layout=widgets.Layout(width="100%"))
        self.buf, self.max, self._last = [], max_lines, 0.0
        self._render()
    def _cls(self, s):
        if "✔" in s: return "ok"
        if "✗" in s: return "bad"
        if "⚠" in s or "■" in s: return "warn"
        if s.startswith("▸"): return "head"
        return ""
    def _render(self):
        if not self.buf:
            self.w.value = "<div class='cc-log'><div class='dim'>— idle —</div></div>"
            return
        rows = "".join(f"<div class='{c}'>{t or '&nbsp;'}</div>"
                       for t, c in reversed(self.buf))   # newest first → shows at bottom
        self.w.value = f"<div class='cc-log'>{rows}</div>"
    def __call__(self, msg=""):
        s = _ANSI.sub("", str(msg))            # drop ANSI color codes (the [32m…[0m noise)
        self.buf.append((_html.escape(s), self._cls(s)))
        if len(self.buf) > self.max:
            self.buf = self.buf[-self.max:]
        now = _time.time()
        if self._cls(s) or now - self._last > 0.15:   # throttle chatter, always flush markers
            self._last = now
            self._render()
    def clear(self):
        self.buf = []
        self._render()
    def flush(self):
        self._last = _time.time()
        self._render()

def bg(btn, busy_label, fn):
    """Run fn synchronously on the main kernel thread. This is deliberate:
    in Colab, widget .value updates only flush to the browser when they happen
    on the main thread — updates from a background thread queue up and never
    render until the next interaction. So logs would appear frozen. Running
    here keeps the panel busy during the action, but the log streams live."""
    old = btn.description
    btn.disabled, btn.description = True, busy_label
    try:
        fn()
    except Exception as e:
        print("error:", e)
    finally:
        btn.disabled, btn.description = False, old

# ---------- 01 Environment ----------
comfy_src = widgets.RadioButtons(
    options=[("master — latest commits", "master"), ("pinned tag / sha", "pin")],
    value=cfg["settings"].get("comfy_ref_mode", "master"), description="ComfyUI:",
    style={"description_width": "initial"})
comfy_ref = widgets.Text(value=cfg["settings"].get("comfy_ref", "v0.28.3"),
                         placeholder="v0.28.3", description="ref:",
                         layout={"width": "230px"},
                         disabled=cfg["settings"].get("comfy_ref_mode", "master") != "pin")
env_force = widgets.Checkbox(value=cfg["settings"]["env_force_reqs"],
                             description="Force-reinstall ComfyUI requirements", indent=False)
env_btn   = widgets.Button(description="Bootstrap / Update", button_style="primary", icon="rocket")
env_log   = LogBox()

def _comfy_src_change(c):
    cfg["settings"]["comfy_ref_mode"] = c["new"]
    comfy_ref.disabled = c["new"] != "pin"
    ui_save()
def _comfy_ref_change(c): cfg["settings"]["comfy_ref"] = c["new"].strip(); ui_save()
comfy_src.observe(_comfy_src_change, names="value")
comfy_ref.observe(_comfy_ref_change, names="value")

def _wanted_ref():
    """"" = track master · otherwise the pinned tag/sha."""
    return comfy_ref.value.strip() if comfy_src.value == "pin" else ""

def _env_force_change(c): cfg["settings"]["env_force_reqs"] = c["new"]; ui_save()
env_force.observe(_env_force_change, names="value")
env_btn.on_click(lambda _: bg(env_btn, "Bootstrapping…",
                              lambda: (env_log.clear(),
                                       bootstrap_env(env_force.value, env_log, _wanted_ref()))))
sec_env = widgets.VBox([
    widgets.HTML("<b>Clone/pull ComfyUI, install its requirements, symlink Drive, install Manager.</b>"),
    widgets.HBox([comfy_src, comfy_ref]),
    widgets.HTML("<small>Pin a tag when master regresses. Switching either way re-runs the "
                 "requirements install, since <code>requirements.txt</code> differs per ref.</small>"),
    env_force, env_btn, env_log.w])

# ---------- 02 Node packs ----------
packs_mode = widgets.RadioButtons(
    options=[("Pull & update", "pull"), ("Skip existing", "skip"), ("Force reinstall reqs", "force")],
    value=cfg["settings"]["packs_update_mode"], description="Update:",
    style={"description_width": "initial"})
def _mode_change(c): cfg["settings"]["packs_update_mode"] = c["new"]; ui_save()
packs_mode.observe(_mode_change, names="value")

packs_all  = widgets.Checkbox(value=True, description="Select all", indent=False)
# ^ description is rewritten by sync_all_cb() to carry the n/total count.
packs_box  = widgets.VBox()
packs_custom = widgets.Text(placeholder="+ custom repo URL  (https://github.com/…/repo.git)",
                            layout={"flex": "1"})
packs_add  = widgets.Button(description="Add", icon="plus")
packs_btn  = widgets.Button(description="Sync & Install", button_style="primary", icon="download")
reqs_btn   = widgets.Button(description="Install all requirements", icon="cogs",
                            tooltip="Install every enabled pack's requirements into the "
                                    "Drive deps folder — persists, so run once (or after "
                                    "adding a node), not every session.")
reqs_force = widgets.Checkbox(value=False, description="Force", indent=False,
                             layout={"width": "90px"})
packs_log  = LogBox()

def build_packs():
    rows = []
    for i, p in enumerate(cfg["node_packs"]):
        cb = widgets.Checkbox(value=p.get("enabled", True),
                              description=p["name"], indent=False,
                              layout={"flex": "1", "min_width": "0", "margin": "0"})
        rm = widgets.Button(description="✕", tooltip="remove",
                            layout={"width": "28px", "height": "28px"})
        rm.add_class("cc-rm")
        def on_toggle(c, idx=i):
            if _guard["on"]: return
            cfg["node_packs"][idx]["enabled"] = c["new"]; ui_save(); sync_all_cb()
        def on_remove(_, idx=i):
            del cfg["node_packs"][idx]; ui_save(); build_packs()
        cb.observe(on_toggle, names="value")
        rm.on_click(on_remove)
        row = widgets.HBox([cb, rm], layout={"width": "auto", "align_items": "center"})
        row.add_class("cc-row")
        rows.append(row)
    # two-column grid so the long pack list isn't one tall column
    grid = widgets.GridBox(rows, layout=widgets.Layout(
        grid_template_columns="1fr 1fr", grid_gap="0 24px"))
    packs_box.children = (grid,)
    sync_all_cb()

def sync_all_cb():
    """Master checkbox is an ON/OFF SWITCH for the whole group -- NOT an
    "all are selected" indicator. It reads CHECKED whenever AT LEAST ONE pack is
    enabled, so unticking it ALWAYS flips the value and therefore always fires,
    clearing the list from any state.

    Why not mirror "all selected": in a partial state that would leave the box
    already unchecked, so the user's uncheck click would assign False to a value
    that is already False -- traitlets fires nothing on an unchanged assignment,
    so the click would be a silent no-op and the remaining packs would stay on.
    The n/total in the label carries the all-vs-partial distinction instead.

    DELIBERATE DIVERGENCE from the colab-launcher.html mock: there, a native DOM
    checkbox gets a true tri-state via `.indeterminate`, and a browser click always
    fires `change` regardless of the prior value -- so the mock has no dead-click to
    avoid. `ipywidgets.Checkbox` has no indeterminate trait, so this count-in-label
    switch is the closest faithful equivalent. Don't "resync" the two by copying the
    mock's all()-based logic back here; that reintroduces the no-op click."""
    if _guard["on"]: return
    _guard["on"] = True
    vals = [p.get("enabled", True) for p in cfg["node_packs"]]
    n = sum(1 for v in vals if v)
    packs_all.value = n > 0
    packs_all.description = f"Select all  ({n}/{len(vals)})"
    _guard["on"] = False

def on_all(c):
    if _guard["on"]: return
    for p in cfg["node_packs"]:
        p["enabled"] = c["new"]
    ui_save(); build_packs()
packs_all.observe(on_all, names="value")

def on_pack_add(_):
    v = packs_custom.value.strip()
    if not v: return
    name = v.rstrip("/").replace(".git", "").split("/")[-1]
    if not name: return
    cfg["node_packs"].append({"name": name, "url": v, "enabled": True, "custom": True})
    packs_custom.value = ""; ui_save(); build_packs()
packs_add.on_click(on_pack_add)
packs_btn.on_click(lambda _: bg(packs_btn, "Syncing…",
                                lambda: (packs_log.clear(), sync_packs(cfg, packs_log))))
reqs_btn.on_click(lambda _: bg(reqs_btn, "Installing…",
                               lambda: (packs_log.clear(),
                                        install_all_reqs(cfg, packs_log, force=reqs_force.value))))
sec_packs = widgets.VBox([
    packs_mode, packs_all, packs_box,
    widgets.HBox([packs_custom, packs_add]),
    widgets.HBox([packs_btn, reqs_btn, reqs_force]), packs_log.w])

# ---------- 03 Extra pip ----------
pip_text = widgets.Textarea(value=cfg["extra_pip"], layout={"width": "100%", "height": "80px"})
pip_btn  = widgets.Button(description="Install", button_style="primary", icon="download")
pip_log  = LogBox()
pip_force = widgets.Checkbox(value=False, description="Force reinstall", indent=False)
def _pip_change(c): cfg["extra_pip"] = c["new"]; ui_save()
pip_text.observe(_pip_change, names="value")
pip_btn.on_click(lambda _: bg(pip_btn, "Installing…",
                              lambda: (pip_log.clear(),
                                       install_extra_pip(pip_text.value, pip_log, force=pip_force.value))))
sec_pip = widgets.VBox([widgets.HTML("<b>Free-form pip install → Drive deps (persists). "
                                     "Only missing packages install unless Force.</b>"),
                        pip_text, widgets.HBox([pip_btn, pip_force]), pip_log.w])

# ---------- 04 Models ----------
models_all = widgets.Checkbox(value=True, description="Select all missing", indent=False)
models_box = widgets.VBox()
model_folder = widgets.Text(placeholder="folder (models/loras)", layout={"width": "180px"})
model_file   = widgets.Text(placeholder="filename.safetensors", layout={"flex": "1"})
model_url    = widgets.Text(placeholder="https://…", layout={"flex": "1"})
model_add    = widgets.Button(description="Add model", icon="plus")
models_btn   = widgets.Button(description="Download selected", button_style="primary", icon="download")
models_log   = LogBox()

def build_models():
    groups = {}
    for i, m in enumerate(cfg["models"]):
        groups.setdefault(m["folder"], []).append((i, m))
    blocks = []
    for folder, items in groups.items():
        blocks.append(widgets.HTML(f"<code style='color:#888'>{folder}</code>"))
        for i, m in items:
            present = model_present(m)
            cb = widgets.Checkbox(value=(False if present else m.get("enabled", True)),
                                  description=m["file"], indent=False, disabled=present,
                                  layout={"flex": "1", "min_width": "0", "margin": "0"})
            tag = widgets.HTML(("<span style='color:#4ade80'>present</span>" if present
                                else "<span style='color:#fbbf24'>missing</span>"),
                               layout={"width": "70px"})
            rm = widgets.Button(description="✕", tooltip="remove",
                                layout={"width": "28px", "height": "28px"})
            rm.add_class("cc-rm")
            def on_toggle(c, idx=i):
                cfg["models"][idx]["enabled"] = c["new"]; ui_save()
            def on_remove(_, idx=i):
                del cfg["models"][idx]; ui_save(); build_models()
            cb.observe(on_toggle, names="value")
            rm.on_click(on_remove)
            row = widgets.HBox([cb, tag, rm], layout={"align_items": "center"})
            row.add_class("cc-row")
            blocks.append(row)
    models_box.children = tuple(blocks)

def on_models_all(c):
    for m in cfg["models"]:
        if not model_present(m):
            m["enabled"] = c["new"]
    ui_save(); build_models()
models_all.observe(on_models_all, names="value")

def on_model_add(_):
    file, url = model_file.value.strip(), model_url.value.strip()
    if not file or not url:
        models_log("⚠ Add needs both a filename and a URL.")
        return
    folder = model_folder.value.strip() or "models/checkpoints"
    cfg["models"].append({"folder": folder, "file": file, "url": url, "enabled": True, "custom": True})
    model_folder.value = model_file.value = model_url.value = ""
    ui_save(); build_models()
model_add.on_click(on_model_add)

def _models_run():
    models_log.clear()
    download_models(cfg, models_log)
    build_models()   # refresh present/missing tags
models_btn.on_click(lambda _: bg(models_btn, "Downloading…", _models_run))
sec_models = widgets.VBox([
    models_all, models_box,
    widgets.HBox([model_folder, model_file]),
    widgets.HBox([model_url, model_add]), models_btn, models_log.w])

# ---------- 05 Launch & tunnel ----------
pinggy_token = widgets.Password(
    value=(cfg["tunnel"].get("pinggy_token", "") if cfg["tunnel"].get("remember_token", True) else ""),
    description="Pinggy token:", style={"description_width": "initial"}, layout={"width": "420px"})
pinggy_remember = widgets.Checkbox(value=cfg["tunnel"].get("remember_token", True),
                                   description="Remember token in config", indent=False)
launch_btn  = widgets.Button(description="Launch ComfyUI", button_style="success", icon="play")
restart_btn = widgets.Button(description="Restart", icon="refresh", disabled=True)
stop_btn    = widgets.Button(description="Stop", button_style="danger", icon="stop", disabled=True)
status_html = widgets.HTML()
url_html    = widgets.HTML("<i style='color:#888'>tunnel URL appears here once running…</i>")
launch_log  = LogBox()

def _token_change(c):
    if pinggy_remember.value:
        cfg["tunnel"]["pinggy_token"] = c["new"]; ui_save()
pinggy_token.observe(_token_change, names="value")
def _remember_change(c):
    cfg["tunnel"]["remember_token"] = c["new"]
    cfg["tunnel"]["pinggy_token"] = pinggy_token.value if c["new"] else ""
    ui_save()
pinggy_remember.observe(_remember_change, names="value")

_STATUS = {"stopped": ("#8b95a5", "STOPPED"), "starting": ("#fbbf24", "STARTING"),
           "running": ("#4ade80", "RUNNING"), "error": ("#f87171", "ERROR")}
def set_status(state):
    color, label = _STATUS[state]
    status_html.value = (
        f"<span style='font-family:ui-monospace,Menlo,monospace;font-size:12px;font-weight:700;"
        f"color:{color};border:1px solid {color}66;background:{color}14;"
        f"padding:5px 13px;border-radius:999px;letter-spacing:.03em'>● {label}</span>")
    active = state in ("starting", "running")   # 'starting' can last 10+ min for big node sets
    launch_btn.disabled = active
    stop_btn.disabled = not active              # allow Stop mid-boot to abort a slow start
    restart_btn.disabled = state != "running"
def set_url(urls):
    if urls:
        u = urls[0] if isinstance(urls, (list, tuple)) else urls
        url_html.value = f"open → <a href='{u}' target='_blank'>{u}</a>"
    else:
        url_html.value = "<i style='color:#888'>tunnel URL appears here once running…</i>"

fe_on  = widgets.Checkbox(value=cfg["settings"].get("frontend_override", False),
                          description="Override frontend version", indent=False,
                          layout={"width": "260px"})
fe_ver = widgets.Text(value=cfg["settings"].get("frontend_version",
                                                "Comfy-Org/ComfyUI_frontend@1.48.5"),
                      placeholder="Comfy-Org/ComfyUI_frontend@1.48.5",
                      layout={"width": "330px"},
                      disabled=not cfg["settings"].get("frontend_override", False))
def _fe_on_change(c):
    cfg["settings"]["frontend_override"] = c["new"]
    fe_ver.disabled = not c["new"]
    ui_save()
def _fe_ver_change(c): cfg["settings"]["frontend_version"] = c["new"].strip(); ui_save()
fe_on.observe(_fe_on_change, names="value")
fe_ver.observe(_fe_ver_change, names="value")

def _wanted_frontend():
    """"" = use the ref's pinned comfyui-frontend-package · else owner/repo@version."""
    return fe_ver.value.strip() if fe_on.value else ""

# launch/restart are NOT wrapped in bg(): launch_comfy returns immediately (the wait
# runs as an async task), and set_status drives the button enable/disable states.
def _do_launch(_):
    launch_log.clear()
    launch_comfy(pinggy_token.value.strip(), launch_log, set_status, set_url,
                 _wanted_frontend())
launch_btn.on_click(_do_launch)
stop_btn.on_click(lambda _: stop_comfy(launch_log, set_status, set_url))
def _restart(_):
    stop_comfy(launch_log, set_status, set_url)
    time.sleep(3)   # let port :8188 fully release before the new bind (blocking, like launch)
    launch_comfy(pinggy_token.value.strip(), launch_log, set_status, set_url,
                 _wanted_frontend())
restart_btn.on_click(_restart)
set_status("running" if comfy_running() else "stopped")
sec_launch = widgets.VBox([
    pinggy_token, pinggy_remember,
    widgets.HBox([fe_on, fe_ver]),
    widgets.HTML("<small>Off = whatever <code>requirements.txt</code> pinned for the checked-out "
                 "ref. On = boot that frontend build instead (Restart to apply). <b>Use this to go "
                 "UP only.</b> ComfyUI reports <code>required_frontend_version</code> from the "
                 "ref's own <code>requirements.txt</code>, so a LOWER frontend always trips "
                 "\"Frontend version X is outdated\" — to run an older UI, pin the ref above "
                 "instead (<code>v0.28.3</code> ⇒ 1.45.21) and leave this off, so core and frontend "
                 "move together. FYI 1.47.10 filters <code>canvasOnly</code> widgets (seed's "
                 "<code>control_after_generate</code>) out of subgraph promotion and the Parameters "
                 "panel — PRs #12957/#13870/#13868, still true in 1.48.5. Unrelated: a custom DOM "
                 "widget with no backing input slot (Pixaroma Resolution) can never be promoted "
                 "onto a subgraph in ANY version — not a pin issue."),
    widgets.HBox([launch_btn, restart_btn, stop_btn]),
    url_html, launch_log.w])

# ---------- 06 Server log ----------
server_log = LogBox(max_lines=5000)
tail_n = widgets.BoundedIntText(value=int(cfg["settings"].get("tail_lines", 40)),
                                min=10, max=5000, step=10, description="Tail lines:",
                                style={"description_width": "initial"}, layout={"width": "170px"})
log_refresh = widgets.Button(description="Refresh", icon="refresh")

def _tail_change(c): cfg["settings"]["tail_lines"] = int(c["new"]); ui_save()
tail_n.observe(_tail_change, names="value")

# Synchronous refresh only. (A live "auto-tail" would need an asyncio/thread loop,
# whose widget updates don't flush in Colab — so it'd silently not update. Click
# Refresh to re-read the tail; the Launch console already streams the live boot.)
def _refresh_log(_):
    server_log.clear()
    for line in tail_log(tail_n.value).splitlines():
        server_log(line)
    server_log.flush()
log_refresh.on_click(_refresh_log)
sec_logs = widgets.VBox([widgets.HBox([tail_n, log_refresh]), server_log.w])

# ---------- 07 Config ----------
cfg_view  = widgets.Textarea(value=json.dumps(cfg, indent=2),
                             layout={"width": "100%", "height": "240px"}, disabled=True)
saved_tag = widgets.HTML("")
cfg_reset = widgets.Button(description="Reset to defaults", button_style="danger", icon="trash")
def _reset(_):
    global cfg
    if os.path.exists(CONFIG_PATH):
        os.remove(CONFIG_PATH)
    cfg = load_config(); save_config(cfg)
    # re-sync every control from fresh cfg
    packs_mode.value = cfg["settings"]["packs_update_mode"]
    env_force.value  = cfg["settings"]["env_force_reqs"]
    comfy_src.value  = cfg["settings"]["comfy_ref_mode"]
    comfy_ref.value  = cfg["settings"]["comfy_ref"]
    fe_on.value      = cfg["settings"]["frontend_override"]
    fe_ver.value     = cfg["settings"]["frontend_version"]
    pip_text.value   = cfg["extra_pip"]
    pinggy_remember.value = cfg["tunnel"]["remember_token"]
    pinggy_token.value    = cfg["tunnel"].get("pinggy_token", "")
    build_packs(); build_models()
    cfg_view.value = json.dumps(cfg, indent=2)
cfg_reset.on_click(_reset)
sec_cfg = widgets.VBox([
    widgets.HTML(f"<b>Auto-saved to</b> <code>{CONFIG_PATH}</code>"),
    widgets.HBox([saved_tag, cfg_reset]), cfg_view,
    widgets.HTML("<small>⚠ The Pinggy token is stored in this file on your Drive.</small>")])

# ---------- assemble ----------
# Custom collapsible card. The header is an HTML widget with an inline onclick
# that toggles a CSS class on the parent card — so collapse/expand happens
# entirely in the browser (NO Python round-trip → instant, no lag). The body
# is a normal widget container hidden/shown purely by CSS.
def card(title, body, open=True):
    hd = widgets.HTML(
        "<div class='cc-hd' onclick=\"this.closest('.cc-card').classList.toggle('collapsed')\">"
        f"<span class='cc-chev'>&#9656;</span>{title}</div>")
    body_box = widgets.VBox([body], layout=widgets.Layout(padding="6px 16px 16px"))
    body_box.add_class("cc-body")
    wrap = widgets.VBox([hd, body_box])
    wrap.add_class("cc-card")
    if not open:
        wrap.add_class("collapsed")
    return wrap

# tag buttons so the CSS can theme them
for _b in (env_btn, packs_btn, pip_btn, models_btn, launch_btn): _b.add_class("cc-btn")
for _b in (packs_add, model_add, log_refresh, restart_btn, reqs_btn): _b.add_class("cc-ghost")
for _b in (stop_btn, cfg_reset):                                 _b.add_class("cc-danger")

build_packs()
build_models()

CSS = """
<style>
.cc-panel { max-width: 920px; font-family: ui-monospace, Menlo, Consolas, monospace; }

/* cards */
.cc-panel .cc-card { border: 1px solid #28303b; border-radius: 10px;
  background: #151a21; margin-bottom: 12px; overflow: hidden; }
.cc-panel .cc-hd { display: flex; align-items: center; width: 100%;
  padding: 12px 16px; background: #171b22; color: #e7ecf3;
  font-weight: 600; font-size: 14px; cursor: pointer; user-select: none; }
.cc-panel .cc-hd:hover { background: #1b212a; }
.cc-panel .cc-chev { color: #2dd4bf; margin-right: 10px; display: inline-block;
  transition: transform .15s; transform: rotate(90deg); }   /* open → points down */
.cc-panel .cc-card.collapsed .cc-chev { transform: rotate(0deg); }  /* collapsed → points right */
.cc-panel .cc-card.collapsed .cc-body { display: none; }

/* list rows */
.cc-panel .cc-row { padding: 1px 0; }
.cc-panel .cc-row .widget-checkbox { margin: 0 !important; }
.cc-panel .cc-row label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cc-panel input[type=checkbox], .cc-panel input[type=radio] { accent-color: #2dd4bf; }

/* primary buttons */
.cc-panel .cc-btn { background: #2dd4bf !important; color: #062420 !important;
  border: none !important; font-weight: 700 !important; border-radius: 8px !important; box-shadow: none !important; }
.cc-panel .cc-btn:hover { background: #34e5d2 !important; }
/* ghost buttons */
.cc-panel .cc-ghost { background: transparent !important; color: #e7ecf3 !important;
  border: 1px solid #28303b !important; border-radius: 8px !important; box-shadow: none !important; }
.cc-panel .cc-ghost:hover { border-color: #2dd4bf !important; color: #2dd4bf !important; }
/* danger buttons */
.cc-panel .cc-danger { background: transparent !important; color: #f87171 !important;
  border: 1px solid rgba(248,113,113,.4) !important; border-radius: 8px !important; box-shadow: none !important; }
.cc-panel .cc-danger:hover { background: rgba(248,113,113,.14) !important; }
/* remove buttons */
.cc-panel .cc-rm { background: transparent !important; border: none !important; box-shadow: none !important;
  color: #f87171 !important; font-weight: 700 !important; min-width: 0 !important; padding: 0 !important; }
.cc-panel .cc-rm:hover { background: rgba(248,113,113,.15) !important; border-radius: 6px; }

/* text inputs / textareas */
.cc-panel .widget-text input, .cc-panel .widget-password input, .cc-panel textarea {
  background: #0a0d12 !important; color: #e7ecf3 !important;
  border: 1px solid #28303b !important; border-radius: 8px !important;
  font-family: ui-monospace, Menlo, Consolas, monospace !important; }

/* log console */
.cc-panel .cc-log { display: flex; flex-direction: column-reverse;
  max-height: 260px; overflow-y: auto; background: #090c11; border: 1px solid #28303b;
  border-radius: 8px; padding: 8px 10px; margin-top: 8px;
  font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55;
  color: #93a0b1; white-space: pre-wrap; word-break: break-word; }
.cc-panel .cc-log .ok   { color: #4ade80; }
.cc-panel .cc-log .bad  { color: #f87171; }
.cc-panel .cc-log .warn { color: #fbbf24; }
.cc-panel .cc-log .head { color: #e7ecf3; font-weight: 600; }
.cc-panel .cc-log .dim  { color: #5f6c7d; }
</style>
"""

panel = widgets.VBox([
    card("01 · Environment",       sec_env,    open=True),
    card("02 · Node Packs",        sec_packs,  open=True),
    card("03 · Extra pip",         sec_pip,    open=False),
    card("04 · Models",            sec_models, open=False),
    card("05 · Launch & Tunnel",   sec_launch, open=True),
    card("06 · Server log",        sec_logs,   open=False),
    card("07 · Config",            sec_cfg,    open=False),
])
panel.add_class("cc-panel")
display(widgets.HTML(CSS),
        widgets.HTML("<h2 style='margin:6px 0;font-family:ui-monospace,Menlo,monospace;"
                     "font-weight:650;color:#e7ecf3'>🎛️ ComfyUI · Colab Control</h2>"),
        status_html, panel)
