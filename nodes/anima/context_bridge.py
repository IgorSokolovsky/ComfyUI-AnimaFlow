"""`Anima Context Bridge` — bundles everything `AnimaGenerator` needs (real
MODEL/CLIP/VAE/CONDITIONING/LATENT objects plus the five sampler scalars)
into one `ANIMA_CONTEXT` socket (contract: `docs/generator-design.md` §1's
dated reversal, §3/§5). Thin: the only decision made here — which fields
were actually supplied, distinctly from "supplied as `None`" — is made by
`src/anima/context.build_context`; this class only wires up ComfyUI's
`INPUT_TYPES`/`RETURN_TYPES` and hands it the raw kwargs.

Every socket is `optional` — nothing is required (design doc §1/§3): an
unwired socket simply contributes nothing to the context, and it's
`AnimaGenerator` (the consumer) that decides, at run time, what a
PARTICULAR run actually needs and raises a readable error for whatever's
missing — never this node, which has no way to know what any given run
needs.

Carries REAL objects, not names — this is what makes it compose with
`AnimaLoaderPanel` (real MODEL/VAE/CLIP outputs) and with Pixaroma's `LoRA
Loader Pixaroma` (which hands back PATCHED MODEL/CLIP), so LoRAs need no
socket of their own here: they arrive already applied, upstream of this
node, same as the old Generator's own MODEL/CLIP sockets always assumed
(design doc §5b, unaffected by this task — `src/anima/loras.py` is now dead
code with no caller at all, since the internal/inline LoRA path it served
was removed alongside `use_internal_loaders`; kept in place, unedited, per
this task's own instruction).

**Why `build()`'s own kwarg defaults are `context.MISSING`, not plain
`None`** (this is the whole mechanism, read before touching either): ComfyUI
omits an unconnected `optional` socket's kwarg entirely rather than ever
passing it as `None` — so whatever THIS METHOD's own Python default is,
is exactly what fires for "nothing wired". Defaulting every kwarg to `None`
would make "never wired" and "wired to a producer that legitimately outputs
`None`" the same observation — precisely the distinction `build_context`
exists to preserve (design brief: "the context must record which keys were
actually supplied, distinctly from 'supplied as None'"). Defaulting to the
sentinel ITSELF, and forwarding every kwarg verbatim into a plain dict,
means `build_context` sees the real signal with no lossy translation
in between — no separate "was this actually passed" bookkeeping needed here.

VERIFY-IN-COMFYUI: this "unconnected optional socket's kwarg is omitted, not
passed as `None`" call convention is ComfyUI's documented behaviour, ported
from reading the execution engine's own input-collection code rather than
exercised against a live process (none installed in this dev environment —
see the build report). If a future ComfyUI version instead always passes
`None` for an unconnected socket, `context_supplied()` would need a
different signal entirely (e.g. a hidden link-presence check) — flagged
here so that regression is easy to find later.
"""
from __future__ import annotations

try:
    # Real ComfyUI context: this module lives two package levels below this
    # pack's top-level package (`nodes/anima/` -> pack root) — same
    # convention as `nodes/prompt_rules/_rules_helpers.py`'s import of
    # `src.prompt_rules.core`. Safe at MODULE scope (not lazily, inside a
    # method) because `src/anima/context.py` carries zero comfy/torch
    # imports of its own — same reasoning `_preview_helpers.py` already
    # documents for its own top-of-file `preview_settings` import.
    from ...src.anima.context import MISSING, build_context  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima.context import MISSING, build_context

from ._combo_helpers import sampler_name_options, scheduler_options

CATEGORY = "AnimaFlow/Anima"

# All eleven fields are `optional` — there is no "required" list to freeze
# against BACKLOG.md §4's append-only rule the way `AnimaGenerator`'s own
# frozen `REQUIRED_KEY_ORDER` is. This IS the append-only order for
# `optional` all the same: a new context field belongs at the END of this
# tuple, never inserted, for the same "already-saved workflows silently
# shift" reason `42336c0` already taught this pack once.
OPTIONAL_KEY_ORDER = (
    "model", "clip", "vae", "positive", "negative", "latent",
    "seed", "steps", "cfg", "sampler_name", "scheduler",
)


class AnimaContextBridge:
    """`Anima Context Bridge` — one node that bundles everything
    `AnimaGenerator` needs into a single `ANIMA_CONTEXT` socket (design doc
    §1's dated reversal of the "no context socket" call: a single input
    keeps the graph clean, and since this bridge is where composition
    happens, the plain sockets aren't lost — they moved one node upstream)."""

    DESCRIPTION = (
        "Bundles the model, CLIP, VAE, conditioning, latent and sampler "
        "values into one wire. It exists because Anima Generator "
        "collapsed nine separate sockets down to this single "
        "context input -- wire whatever you have here instead of looking "
        "for those sockets on the Generator itself. Every input is "
        "optional; the Generator reports exactly what's missing when it "
        "runs."
    )

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "build"
    RETURN_TYPES = ("ANIMA_CONTEXT",)
    RETURN_NAMES = ("context",)
    OUTPUT_TOOLTIPS = (
        "Bundled MODEL/CLIP/VAE/CONDITIONING/LATENT plus sampler values, for "
        "AnimaGenerator's single input. Records which sockets were actually "
        "wired, distinctly from a wired socket that legitimately produced "
        "None -- AnimaGenerator uses that to decide what it can and can't run.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {},
            "optional": {
                "model": ("MODEL", {"tooltip": "Diffusion model -- e.g. AnimaLoaderPanel's output, or a LoRA loader's patched MODEL."}),
                "clip": ("CLIP", {"tooltip": "CLIP/text encoder -- route a LoRA loader's PATCHED clip here, not the raw loader's, or the LoRA's CLIP effect is silently lost (design doc §5b)."}),
                "vae": ("VAE", {"tooltip": "VAE for decode/encode."}),
                "positive": ("CONDITIONING", {"tooltip": "Positive conditioning, already encoded upstream (e.g. by Prompt Rules (CLIP))."}),
                "negative": ("CONDITIONING", {"tooltip": "Negative conditioning, already encoded upstream."}),
                "latent": ("LATENT", {"tooltip": "Starting latent -- size and batch. If unwired, AnimaGenerator falls back to a fixed default size."}),
                "seed": ("INT", {"forceInput": True, "tooltip": "Seed. If unwired, AnimaGenerator uses generation_settings.sampler.seed instead."}),
                "steps": ("INT", {"forceInput": True, "tooltip": "Step count. If unwired, AnimaGenerator uses generation_settings.sampler.steps instead."}),
                "cfg": ("FLOAT", {"forceInput": True, "tooltip": "CFG. If unwired, AnimaGenerator uses generation_settings.sampler.cfg instead."}),
                "sampler_name": (sampler_name_options(), {"forceInput": True, "tooltip": "Sampler name. If unwired, AnimaGenerator uses generation_settings.sampler.sampler_name instead."}),
                "scheduler": (scheduler_options(), {"forceInput": True, "tooltip": "Scheduler. If unwired, AnimaGenerator uses generation_settings.sampler.scheduler instead."}),
            },
        }

    def build(
        self,
        model=MISSING,
        clip=MISSING,
        vae=MISSING,
        positive=MISSING,
        negative=MISSING,
        latent=MISSING,
        seed=MISSING,
        steps=MISSING,
        cfg=MISSING,
        sampler_name=MISSING,
        scheduler=MISSING,
    ):
        raw = {
            "model": model, "clip": clip, "vae": vae,
            "positive": positive, "negative": negative, "latent": latent,
            "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": sampler_name, "scheduler": scheduler,
        }
        return (build_context(raw),)


NODE_CLASS_MAPPINGS = {"AnimaContextBridge": AnimaContextBridge}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaContextBridge": "Anima Context Bridge"}
