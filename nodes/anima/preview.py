"""`Anima Preview` — compares two of the Generator's stage images with a
hover wipe (`js/anima/`), and OWNS SAVING (contract: docs/generator-design.md
§2/§7/§7a). Terminal, `OUTPUT_NODE = True`: a graph with no Preview wired
runs nothing at all, since the Generator itself isn't an output node (design
doc §2).

The hidden `PROMPT`/`EXTRA_PNGINFO` inputs live HERE, not on the Generator,
because this is where embed-workflow happens (§9 divergence #3's fix — the
deleted old port never declared them anywhere, so its saves were worse than
stock `SaveImage`: dragging a saved PNG back into ComfyUI restored nothing).

Real logic lives in `nodes/anima/_preview_helpers.py` (impure — PIL/
folder_paths) and `src/anima/preview_settings.py` (pure — settings shape,
filename tokens, and stage-routing decisions); this class only wires up
`INPUT_TYPES` and calls them.

**2026-07-28 reversal — `image_a`/`image_b`/`image_c` are gone, replaced by
one `images` list.** The Generator now returns a single `IMAGE` LIST
(`OUTPUT_IS_LIST`) instead of three fixed sockets, so this node declares
`INPUT_IS_LIST = True` and receives that list directly, plus the Generator's
`metadata_json` (to recover which position is which stage — see
`src/anima/preview_settings.resolve_run_stage_labels`, "keep the label
mapping in exactly one pure place").

**`INPUT_IS_LIST = True` is a WHOLE-NODE flag — every declared input,
including the hidden ones, arrives wrapped in a list.** This is easy to get
wrong in a way that's very hard to read later, so every input this method
receives is unwrapped EXPLICITLY, with a comment saying why, right at the
top of `preview()` — see `_unwrap_single`'s own docstring for the mechanism,
and note `images` is the one input that must NOT be unwrapped to its first
element: staying the full multi-item list IS its entire point (it's the
real, possibly-length-3 list the Generator produced this run), whereas every
other input here is naturally single-valued and only wrapped in a
one-element list because the node-level flag wraps EVERYTHING, regardless of
whether the upstream producer itself emitted a list.

**PREVIEW vs SAVE are two different questions, answered by two different
inputs** — this is the fix for the bug where saving off meant the frontend's
hover wipe got zero images: `preview_stages` (below) is EVERY stage present
this run, ALWAYS, because the wipe needs whichever two the user picks in
`compare.a`/`compare.b` regardless of what gets saved to disk; `stages_to_save`
is `save.which`'s scoped subset, only computed at all when saving is on.
`_preview_helpers.build_preview_ui_images` then routes each previewed stage
to exactly one write: a real output file if it's also in `stages_to_save`,
an ephemeral temp file otherwise (never both, so one run never produces two
files for the same stage) — see that function's and `resolve_wired_stages`'s
own docstrings for the rest of this contract.
"""
from __future__ import annotations

import logging
import os

from ._preview_helpers import (
    build_preview_ui_images,
    extract_seed_from_prompt,
    resolve_run_stage_labels,
    resolve_save_stages,
    resolve_wired_stages,
)

try:
    # Real ComfyUI context -- same convention as `nodes/prompt_rules/
    # _rules_helpers.py`'s import of `src.prompt_rules.core`.
    from ...src.anima import frontend_settings as frontend_settings_mod  # type: ignore
    from ...src.anima import logs as logs_mod  # type: ignore
except ImportError:
    # Standalone context (plain-script tests, repo root on `sys.path`).
    from src.anima import frontend_settings as frontend_settings_mod
    from src.anima import logs as logs_mod

CATEGORY = "AnimaFlow/Anima"

# One console-visible line per run (task brief: "how many images arrived,
# the stage labels resolved for them, and for each stage whether it was
# saved ... or written to temp"). Same shared logger name as `pipeline.py`
# so ComfyUI's console groups every Anima line together; the message text
# still carries its own `[AnimaFlow]` prefix (see `src/anima/logs.py`'s own
# docstring for why both).
_logger = logging.getLogger(logs_mod.LOGGER_NAME)


def _should_log() -> bool:
    """Same three-level "Console logging" contract `src/anima/pipeline.py`'s
    own `_should_log` uses (that module's own docstring has the full
    precedence) -- `ANIMAFLOW_DEBUG` forces logging on; otherwise the
    Settings-dialog value, defaulting to `logs.DEFAULT_LOG_LEVEL` ("off").
    This node has no debug-only lines of its own (just the one summary line
    below), so there is no separate `_debug_enabled()` here."""
    setting_value = frontend_settings_mod.get_setting(
        logs_mod.CONSOLE_LOGGING_SETTING_ID, logs_mod.DEFAULT_LOG_LEVEL,
    )
    return logs_mod.effective_log_level(os.environ, setting_value) != "off"


def _unwrap_single(value, default=None):
    """`INPUT_IS_LIST = True` wraps EVERY input in a list, including
    naturally single-valued ones (a STRING widget, the hidden `PROMPT`/
    `EXTRA_PNGINFO`) — this pulls that one element back out. Defensive about
    a non-list arriving anyway (a hand-written test calling `preview()`
    directly without going through ComfyUI's own wrapping) by passing a
    non-list value through unchanged rather than indexing into it. NEVER
    used for `images` — see the module docstring for why that one input
    stays the full list.
    """
    if isinstance(value, list):
        return value[0] if value else default
    return value if value is not None else default


class AnimaPreview:
    """`Anima Preview` — terminal node: compares (`js/anima/`'s hover wipe)
    and saves. `images` is optional so "I don't want preview" is expressed
    by leaving it unwired — the whole Generator then does nothing at all,
    which is intended (design doc §2)."""

    DESCRIPTION = (
        "Compares two of the Generator's stage images with a hover wipe, "
        "and owns saving them to disk. Wire the Generator's images and "
        "metadata_json outputs here directly -- base, mid and final can "
        "each be saved under their own filename via the %stage% token. "
        "This is the terminal node of the pipeline: nothing runs if a "
        "Preview isn't wired, since the Generator itself never saves or "
        "displays anything on its own."
    )

    CATEGORY = CATEGORY
    EXPERIMENTAL = True
    OUTPUT_NODE = True
    INPUT_IS_LIST = True
    FUNCTION = "preview"
    RETURN_TYPES = ()
    RETURN_NAMES = ()

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "preview_state": (
                    "STRING",
                    {
                        "default": "{}",
                        "tooltip": (
                            "Serialized Preview state (JSON): the compare "
                            "picker (which two stages, and whether the wipe "
                            "is on) and the save settings (which images, "
                            "filename tokens, path, extension, embed-"
                            "workflow). Hidden for rendering only, not meant "
                            "to be hand-edited -- see docs/generator-design.md §8."
                        ),
                    },
                ),
            },
            "optional": {
                "images": ("IMAGE", {"tooltip": "The Generator's images list for this run -- wire AnimaGenerator's images output here directly (it's already a list: base/mid/final, whichever actually ran)."}),
                "metadata_json": ("STRING", {"default": "", "tooltip": "The Generator's metadata_json output -- wire it here so this node can tell which list position is which stage. Without it, positions fall back to base/mid/final order."}),
            },
            "hidden": {"prompt": "PROMPT", "extra_pnginfo": "EXTRA_PNGINFO"},
        }

    def preview(self, preview_state="{}", images=None, metadata_json=None, prompt=None, extra_pnginfo=None):
        # `INPUT_IS_LIST = True` wraps every input above in a list --
        # unwrap each single-valued one explicitly (see module docstring).
        # `images` is deliberately NOT unwrapped here: it stays the whole
        # list ComfyUI handed us (this run's real stage count), which is
        # the entire reason this node declared the flag in the first place.
        preview_state = _unwrap_single(preview_state, "{}")
        metadata_json = _unwrap_single(metadata_json, None)
        prompt = _unwrap_single(prompt, None)
        extra_pnginfo = _unwrap_single(extra_pnginfo, None)

        # `images` is `None` only when the socket is genuinely unwired (its
        # kwarg is then omitted entirely, so this method's own default
        # fires -- never a list). Any wired producer, list-shaped or not,
        # arrives as a real list under `INPUT_IS_LIST`.
        if not isinstance(images, list):
            images = [] if images is None else [images]

        try:
            # Real ComfyUI context -- same convention as
            # `nodes/prompt_rules/_rules_helpers.py`'s import of `src.prompt_rules.core`.
            from ...src.anima.preview_settings import normalize_preview_settings  # type: ignore
        except ImportError:
            from src.anima.preview_settings import normalize_preview_settings

        settings = normalize_preview_settings(preview_state)

        # THE single pure place this run's position -> stage-label mapping
        # comes from (task brief) -- everything past this line reads stage
        # NAMES, never a list index or a socket name.
        labels = resolve_run_stage_labels(len(images), metadata_json)
        wired = dict(zip(labels, images))

        save_settings = settings.get("save", {})
        compare_settings = settings.get("compare", {})

        # PREVIEW is every stage present this run, ALWAYS -- independent of
        # save.enabled (this module's own top-doc comment explains why;
        # conflating the two is exactly how "saving off means the wipe
        # shows nothing" happened).
        preview_stages = resolve_wired_stages(wired)
        # SAVE is `save.which`'s scoped subset -- only computed at all when
        # saving is actually on; empty otherwise, which routes every
        # previewed stage to a temp file (see `build_preview_ui_images`).
        stages_to_save = (
            resolve_save_stages(save_settings, compare_settings, wired)
            if isinstance(save_settings, dict) and save_settings.get("enabled", True)
            else []
        )

        seed = extract_seed_from_prompt(prompt)
        ui_images = build_preview_ui_images(
            wired=wired, preview_stages=preview_stages, stages_to_save=stages_to_save,
            preview_settings=settings, seed=seed, prompt=prompt, extra_pnginfo=extra_pnginfo,
        )

        # Server-side console line (task brief): how many images arrived,
        # which stage labels they resolved to, and -- per stage -- whether
        # it landed in a real output file (and where) or only a temp one.
        # Built from `ui_images` itself (already the authoritative routing
        # result `split_preview_stages` produced), never re-derived. Gated on
        # the "Console logging" setting/ANIMAFLOW_DEBUG (`_should_log`,
        # above) -- "off" silences this the same way it silences every
        # per-run line `pipeline.py` prints.
        if _should_log():
            _logger.info(logs_mod.format_preview_run_line(
                image_count=len(images), stage_labels=labels, entries=ui_images,
            ))

        # The key is `anima_stages`, deliberately NOT `images` -- this node
        # already draws its own preview (`js/anima/`'s DOM hover wipe), and
        # `"ui": {"images": [...]}}` is ComfyUI's OWN frontend trigger for
        # drawing a native image preview inside the node. Returning under
        # `images` produced two stacked previews (our wipe AND ComfyUI's
        # own, "1024 x 1024" caption included) -- the actual bug this
        # rename fixes, at the source, rather than fighting the frontend's
        # own rendering after the fact. `js/anima/interaction.mjs`'s
        # `handleExecuted` reads this exact key, with no fallback to the
        # old one.
        #
        # Accepted cost: these entries no longer show up in ComfyUI's
        # outputs sidebar / queue-history thumbnails (both key off the same
        # native `images` mechanism) -- acceptable because an unsaved stage
        # was only ever a `temp` file to begin with, and a SAVED stage still
        # lands on disk under its own `%stage%`-templated filename; nothing
        # is actually lost, just not double-surfaced in that one UI.
        #
        # `anima_seed` -- fixes the "Save now" `%seed%` token always
        # resolving to `0` (§7a's own documented gap, `TODO.md`'s last Now
        # item): `seed` above is computed on every run but was previously
        # never sent anywhere, so a later "Save now" click had nothing but
        # `src/anima/api.py`'s hardcoded fallback to go on. Two landmines
        # already bitten by this repo, both load-bearing here:
        #   1. A `ui` payload value MUST be a LIST -- a bare scalar gets
        #      FLATTENED to its own keys by ComfyUI's executor's accumulator
        #      (the exact bug `f22b3c0`/`885410b` fixed for a different key
        #      on this same node -- see `handleGeneratorExecuted`'s own doc
        #      comment in `js/anima/interaction.mjs`). So this is
        #      `[str(seed)]`, a one-element list, never a bare string.
        #   2. The seed MUST travel as a decimal STRING, never a JSON number
        #      -- a seed can reach 2**64-1, past JS's `Number.MAX_SAFE_INTEGER`
        #      (2**53-1), so a real 20-digit seed would silently corrupt on
        #      the JSON round trip through the browser (the same class of bug
        #      `717feaa` fixed for `generation_settings.sampler.seed` --
        #      design doc §8). `str(seed)` here is what keeps it a string for
        #      the entire wire/JS trip; `js/anima/interaction.mjs` must never
        #      `Number(...)`/`parseInt` it back, and it becomes an `int`
        #      again exactly ONCE, at `_preview_helpers.save_now`'s
        #      `format_filename` call site, via `settings.resolve_seed_int`
        #      -- the same "convert once at the boundary" discipline
        #      `pipeline.py` already uses for the settings-tree seed.
        #
        # **Known gap, not papered over**: a CACHED run (this node not
        # re-executed this queue) emits no `ui` payload at all, so
        # `handleExecuted` is never called and `node._anSeed` is never
        # populated for that queue -- `%seed%` then correctly falls back to
        # `src/anima/api.py`'s documented default (`0`) on the very next
        # "Save now" click, the same "no report this run" degradation design
        # doc §5a-0 already documents for the Generator's own context report.
        # There is no workaround for this: the RESOLVED seed only exists on
        # a real execution, and reaching into the settings blob's own
        # `sampler.seed` instead would frequently read back the `-1` "random"
        # sentinel, not the seed that actually ran.
        return {"ui": {"anima_stages": ui_images, "anima_seed": [str(seed)]}}


NODE_CLASS_MAPPINGS = {"AnimaPreview": AnimaPreview}
NODE_DISPLAY_NAME_MAPPINGS = {"AnimaPreview": "Anima Preview"}
