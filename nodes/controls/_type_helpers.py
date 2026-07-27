"""Shared type helper for the controls nodes.

`ANY` bypasses ComfyUI's strict type matching so a single declared output
slot can emit whatever type the row it holds actually is (STRING, INT,
FLOAT, LATENT, MODEL, VAE, CLIP, ...) without Python having to declare a
different `RETURN_TYPES` tuple per possible row layout. The frontend then
narrows each slot's *visible* type per row (see docs/control-panel-design.md
§5) so a wrong wire is refused at the wire, before it can fail mid-run.

Ported from ComfyUI-Pixaroma's `nodes/_type_helpers.py` (MIT © Pixaroma) —
see THIRD_PARTY_NOTICES.md.
"""


class AnyType(str):
    """A string subclass that compares equal to every other string."""

    def __ne__(self, other):
        return False


ANY = AnyType("*")
