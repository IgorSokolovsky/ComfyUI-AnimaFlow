"""`Anima Generator` — runs the whole txt2img pipeline (first pass -> highres
-> detailer -> upscale -> postprocess) behind one node (contract:
docs/generator-design.md §5). Thin: every real decision (context field
resolution, stage gating, sampler inheritance, tile/fit maths) is made by a
pure function in `src/anima/`; this class only wires up ComfyUI's
`INPUT_TYPES`/`RETURN_TYPES` and calls `src/anima/pipeline.run_generator`.

Not an `OUTPUT_NODE` — it doesn't save (design doc §2). A graph with no
Preview wired runs nothing at all; that's the intended behaviour, not an
oversight, since there is no output to produce without a consumer.

**2026-07-28 reversal, and a DELIBERATE breaking change to already-saved
workflows** (recorded here, not just in the design doc, because
`REQUIRED_KEY_ORDER`'s whole job is enforcing "widget order is append-only"
— this commit is the one deliberate exception to that rule, not a violation
of it). Every socket this node used to have except `positive`/`negative`/
`generation_settings` is GONE: `use_internal_loaders`, the four internal
pickers, and the `model`/`clip`/`vae`/`latent`/`seed`/`steps`/`cfg`/
`sampler_name`/`scheduler` sockets are all replaced by ONE `context`
(`ANIMA_CONTEXT`) input from the new `AnimaContextBridge` node. Removing
widgets — unlike inserting one mid-list, which is what `REQUIRED_KEY_ORDER`
actually guards against — breaks already-saved workflows unavoidably (every
positional widget after the cut point shifts). Accepted here because these
nodes are days old and still `EXPERIMENTAL`; `REQUIRED_KEY_ORDER` below is
updated to the NEW two-key surface, not preserved for compatibility.

**`image`/`image_base`/`image_mid` are also gone**, replaced by one `images`
LIST output (`OUTPUT_IS_LIST`) ordered `base, mid, final`, omitting any
stage that didn't produce a genuinely different image rather than
duplicating the previous one — see `src/anima/stages.resolve_stage_labels`'s
own docstring for exactly which stages count as "different", and
`metadata_json`'s `stage_labels` field for the position->label record
`AnimaPreview` reads back.
"""
from __future__ import annotations

# Frozen for `tests/test_anima_nodes.py`'s required-key-order regression
# (BACKLOG.md §4: widget order is append-only). Two keys now, not eight —
# see this module's own docstring for why shrinking this tuple here is a
# deliberate, documented exception to the append-ONLY rule, not a violation
# of it: `REQUIRED_KEY_ORDER` still freezes whatever the CURRENT surface is,
# it just no longer matches what a workflow saved before this commit expects.
REQUIRED_KEY_ORDER = ("context", "generation_settings")

CATEGORY = "AnimaFlow/Anima"


class AnimaGenerator:
    """`Anima Generator` — the whole txt2img pipeline behind one node, with
    popup settings (not yet built — see `docs/generator-design.md` §12; this
    node works, if plainly, with ComfyUI's raw widgets until the `js/anima/`
    slice lands)."""

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE", "LATENT", "STRING")
    RETURN_NAMES = ("images", "latent", "metadata_json")
    # `images` (index 0) is the ONE list-shaped output -- ComfyUI expects
    # `generate()` to hand back a real Python list already for that slot
    # (never a single tensor), while `latent`/`metadata_json` stay plain
    # single values. VERIFY-IN-COMFYUI: this is ComfyUI's documented
    # `OUTPUT_IS_LIST` contract, read from the execution engine's own
    # input-collection code rather than exercised against a live process
    # (none installed in this dev environment -- see the build report).
    # Expected downstream behaviour: a node wired to `images` that does NOT
    # itself declare `INPUT_IS_LIST` gets invoked ONCE PER ITEM in the list
    # (with every other, non-list input held constant across those calls);
    # a node that DOES declare `INPUT_IS_LIST` (like `AnimaPreview`) gets
    # the whole list in one call instead.
    OUTPUT_IS_LIST = (True, False, False)
    OUTPUT_TOOLTIPS = (
        "This run's produced images, as a LIST ordered base -> mid -> "
        "final. A stage that didn't run, or didn't change the image, is "
        "OMITTED -- never duplicated -- so the list can be length 1 (only "
        "base ran) up to length 3 (every stage changed something). See "
        "metadata_json's stage_labels for which position is which.",
        "Final latent -- the last real diffusion latent this run produced "
        "(the highres stage's, or the first pass's if highres is off; "
        "detailer/upscale/postprocess all operate on pixels, not latents).",
        "Per-stage metadata (JSON): resolved sampler values, the "
        "postprocess fit result, and stage_labels -- the ordered list "
        "naming which stage each position in images actually is. Wire "
        "this into AnimaPreview's metadata_json input so it can tell the "
        "positions apart.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "context": (
                    "ANIMA_CONTEXT",
                    {
                        "tooltip": (
                            "Bundled MODEL/CLIP/VAE/CONDITIONING/LATENT plus "
                            "sampler values from an Anima Context Bridge node. "
                            "Every field the bridge didn't have wired is "
                            "simply absent -- this node reports exactly what's "
                            "missing (e.g. no MODEL, no positive conditioning) "
                            "with a readable error at run time, not a crash."
                        ),
                    },
                ),
                "generation_settings": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized generation settings (JSON): sampler, mod "
                            "guidance, and per-stage highres/detailer/upscale/"
                            "postprocess settings. Hidden for rendering only, not "
                            "meant to be hand-edited -- see docs/generator-design.md §8."
                        ),
                    },
                ),
            },
            "optional": {},
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    def generate(
        self,
        context,
        generation_settings="{}",
        unique_id=None,
    ):
        try:
            # Real ComfyUI context: this module lives two package levels
            # below this pack's top-level package (`nodes/anima/` -> pack
            # root), so a relative import up to the pack's own
            # `src.anima.pipeline` is correct here -- same convention as
            # `nodes/prompt_rules/_rules_helpers.py`'s import of
            # `src.prompt_rules.core`.
            from ...src.anima import pipeline  # type: ignore
        except ImportError:
            # Standalone context (plain-script tests, repo root on
            # `sys.path`): fall back to the bare form.
            from src.anima import pipeline

        images, latent_out, metadata_json = pipeline.run_generator(
            context=context,
            generation_settings=generation_settings,
        )
        return (images, latent_out, metadata_json)


NODE_CLASS_MAPPINGS = {"AnimaGenerator": AnimaGenerator}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaGenerator": "Anima Generator"}
