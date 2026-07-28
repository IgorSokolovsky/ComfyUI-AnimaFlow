"""Pure normalizer for a CORE ComfyUI node call's return value (the pure
function `pipeline.py`'s `_output0`/`_output0_multi` now act on, per this
pack's own pure/impure rule: "every decision it acts on is made first by a
pure function it calls" — `.claude/CLAUDE.md`).

Why this exists: `pipeline.py` calls core ComfyUI node classes directly
(`_comfy_node(...)().some_method(...)`), and every ComfyUI build up to some
point returned a bare tuple of outputs (the "V2" node schema) — ONE fixed
shape, so a bare `isinstance(result, tuple)` check used to be enough. ComfyUI
0.28.3 ships the "V3" node schema for some core nodes (its own
`execution.py` now carries a `v3_data` argument), where a node's `execute()`
can be a classmethod returning a `comfy_api`/`io.NodeOutput`-shaped object
whose outputs live on a `.result` attribute, not the return value itself. A
THIRD shape — `{"ui": ..., "result": (...)}`, ComfyUI's own convention for a
node that also wants to report UI/preview data alongside its outputs — is
legal under either schema too. This module tells those three apart,
STRUCTURALLY (duck-typing on `.result`/`"result"`), WITHOUT importing or
isinstance-ing any V3 class — that class's import path varies across ComfyUI
builds, and this module must stay ComfyUI-free (the pure/impure rule again).

Live bug this exists to fix: `comfy_extras.nodes_sam3.SAM3_Detect` on ComfyUI
0.28.3 returned a V3 `NodeOutput` from `_run_detailer_block`'s
`sam3_cls().execute(...)` call, and the old unwrapper's bare
`isinstance(result, tuple)` check rejected it outright with a message that
named neither the node nor the actual returned type. See `pipeline.py`'s
`_output0`/`_output0_multi` for the readable-error half of this fix — this
module only tells shapes apart, never raises.
"""
from __future__ import annotations

from typing import Any, NamedTuple, Optional, Tuple


class NormalizedNodeResult(NamedTuple):
    """The pure outcome of `normalize_node_result` — exactly one of the two
    fields is meaningful at a time:

    - `outputs` is a plain tuple (possibly EMPTY — that is a distinct, valid
      outcome a caller must check for itself; see `pipeline.py`'s two
      separate error messages) whenever the shape was recognised.
    - `unrecognized_type` is `type(result).__name__` whenever NONE of the
      three recognised shapes matched at all — `outputs` is `None` in that
      case, never an empty tuple, so a caller can tell "recognised but
      empty" and "not recognised at all" apart with a single `is None` check
      on this field alone.
    """

    outputs: Optional[Tuple[Any, ...]]
    unrecognized_type: Optional[str]


def normalize_node_result(result: Any) -> NormalizedNodeResult:
    """Any ComfyUI core-node call's return value -> a `NormalizedNodeResult`.
    Checked in this fixed order of preference:

      1. a `tuple`/`list` itself (the V2 shape) -> used as-is;
      2. an object with a `.result` attribute that is itself a `tuple`/`list`
         (the V3 `NodeOutput` shape) -> that attribute's value is used;
      3. a `dict` carrying a `"result"` key whose value is a `tuple`/`list`
         (the `{"ui": ..., "result": ...}` shape some nodes return under
         either schema) -> that value is used;
      4. anything else -> `unrecognized_type` is set to
         `type(result).__name__` and `outputs` is `None`.

    Never raises — every input, including `None` and a bare unrecognised
    object, resolves to a `NormalizedNodeResult`. Turning the two failure
    outcomes (empty-but-recognised vs. unrecognised) into a readable
    exception with node/method context is deliberately left to the caller
    (`pipeline.py`'s `_output0`/`_output0_multi`) — this module doesn't know
    which node or method produced `result`, so it can't name either in a
    message.
    """
    if isinstance(result, (tuple, list)):
        return NormalizedNodeResult(tuple(result), None)

    result_attr = getattr(result, "result", None)
    if isinstance(result_attr, (tuple, list)):
        return NormalizedNodeResult(tuple(result_attr), None)

    if isinstance(result, dict):
        dict_result = result.get("result")
        if isinstance(dict_result, (tuple, list)):
            return NormalizedNodeResult(tuple(dict_result), None)

    return NormalizedNodeResult(None, type(result).__name__)


__all__ = ("NormalizedNodeResult", "normalize_node_result")
