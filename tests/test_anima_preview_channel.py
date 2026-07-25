"""Plain-script tests for `nodes._anima_preview_channel` and `AnimaPreview`.

Run directly: `python tests/test_anima_preview_channel.py` (no pytest, per project
convention). `broadcast_preview` is guarded exactly like
`autocomplete/api.py`'s route registration: `from server import
PromptServer` (and, separately, `numpy`/`PIL` for frame encoding) must not
crash this module when run outside a live ComfyUI process. This test suite
rigs `sys.meta_path` to explicitly SIMULATE that absence (rather than only
relying on this dev environment happening to lack those packages), so it
stays meaningful even on a machine that does have numpy/PIL/torch
installed but isn't running inside ComfyUI itself.
"""

from __future__ import annotations

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import nodes._anima_preview_channel as preview_channel
from nodes._anima_preview_channel import (
    DEFAULT_CHANNEL,
    PREVIEW_EVENT,
    broadcast_preview,
    build_preview_payload,
    normalize_channel,
)
from nodes.node_anima_preview import AnimaPreview


class _BlockImportFinder:
    """A `sys.meta_path` finder that makes `import <name>` fail for any
    name in `blocked`, simulating "this package isn't installed" without
    needing to actually uninstall anything."""

    def __init__(self, blocked):
        self.blocked = set(blocked)

    def find_spec(self, fullname, path, target=None):  # noqa: ARG002
        if fullname in self.blocked or fullname.split(".")[0] in self.blocked:
            raise ImportError(f"blocked for test: {fullname}")
        return None


class _blocked_imports:
    """Context manager: block `names` from being imported for the duration
    of the `with` block, evicting any already-cached `sys.modules` entries
    first so a fresh import attempt actually reaches the finder."""

    def __init__(self, *names):
        self.names = names
        self._finder = None
        self._evicted = {}

    def __enter__(self):
        self._finder = _BlockImportFinder(self.names)
        sys.meta_path.insert(0, self._finder)
        for name in self.names:
            if name in sys.modules:
                self._evicted[name] = sys.modules.pop(name)
        return self

    def __exit__(self, exc_type, exc, tb):
        sys.meta_path.remove(self._finder)
        sys.modules.update(self._evicted)
        return False


class _fake_prompt_server_module:
    """Context manager: inject a fake `server` module with a
    `PromptServer.instance.send_sync` that records every call, so the
    happy path (PromptServer genuinely available) is also exercised."""

    def __init__(self):
        self.calls = []
        self._previous = None

    def __enter__(self):
        calls = self.calls

        class _FakePromptServerInstance:
            client_id = "test-client"

            def send_sync(self, event, payload, client_id):
                calls.append((event, payload, client_id))

        class _FakePromptServer:
            instance = _FakePromptServerInstance()

        fake_module = type(sys)("server")
        fake_module.PromptServer = _FakePromptServer
        self._previous = sys.modules.get("server")
        sys.modules["server"] = fake_module
        return self

    def __exit__(self, exc_type, exc, tb):
        if self._previous is None:
            sys.modules.pop("server", None)
        else:
            sys.modules["server"] = self._previous
        return False


def test_normalize_channel_defaults_blank_to_default():
    assert normalize_channel("") == DEFAULT_CHANNEL
    assert normalize_channel(None) == DEFAULT_CHANNEL
    assert normalize_channel("   ") == DEFAULT_CHANNEL
    assert normalize_channel("  gen_01  ") == "gen_01"


def test_build_preview_payload_shape():
    payload = build_preview_payload("gen_01", "Highres", "QUJD")
    assert payload == {"channel": "gen_01", "stage_label": "Highres", "image_data": "QUJD"}


def test_build_preview_payload_normalizes_channel_and_stage_label():
    payload = build_preview_payload("", None, "QUJD")
    assert payload["channel"] == DEFAULT_CHANNEL
    assert payload["stage_label"] == ""


def test_broadcast_preview_no_op_when_encoding_fails():
    # No monkeypatch needed for THIS environment (no numpy/PIL installed at
    # all) - but also explicitly block them so the assertion holds even on
    # a machine that does have them installed.
    with _blocked_imports("numpy", "PIL"):
        sent = broadcast_preview("gen_01", object(), "First pass")
    assert sent is False


def test_broadcast_preview_no_op_when_promptserver_module_missing():
    # Bypass frame encoding (monkeypatch it to succeed) so this test
    # isolates ONLY the PromptServer-absence guard, matching the technique
    # used to verify autocomplete/api.py's guard.
    original_encode = preview_channel._encode_frame_to_png_base64
    preview_channel._encode_frame_to_png_base64 = lambda image: "ZmFrZQ=="
    try:
        with _blocked_imports("server"):
            sent = broadcast_preview("gen_01", object(), "Highres")
        assert sent is False
    finally:
        preview_channel._encode_frame_to_png_base64 = original_encode


def test_broadcast_preview_no_op_when_promptserver_instance_is_none():
    original_encode = preview_channel._encode_frame_to_png_base64
    preview_channel._encode_frame_to_png_base64 = lambda image: "ZmFrZQ=="
    try:
        fake_module = type(sys)("server")

        class _FakePromptServerNoInstance:
            instance = None

        fake_module.PromptServer = _FakePromptServerNoInstance
        previous = sys.modules.get("server")
        sys.modules["server"] = fake_module
        try:
            sent = broadcast_preview("gen_01", object(), "Highres")
        finally:
            if previous is None:
                sys.modules.pop("server", None)
            else:
                sys.modules["server"] = previous
        assert sent is False
    finally:
        preview_channel._encode_frame_to_png_base64 = original_encode


def test_broadcast_preview_sends_when_promptserver_and_encoding_available():
    original_encode = preview_channel._encode_frame_to_png_base64
    preview_channel._encode_frame_to_png_base64 = lambda image: "ZmFrZQ=="
    try:
        with _fake_prompt_server_module() as fake_server:
            sent = broadcast_preview("gen_01", object(), "Highres")
        assert sent is True
        assert len(fake_server.calls) == 1
        event, payload, client_id = fake_server.calls[0]
        assert event == PREVIEW_EVENT
        assert payload == {"channel": "gen_01", "stage_label": "Highres", "image_data": "ZmFrZQ=="}
        assert client_id == "test-client"
    finally:
        preview_channel._encode_frame_to_png_base64 = original_encode


def test_broadcast_preview_never_raises_on_unexpected_exception():
    original_encode = preview_channel._encode_frame_to_png_base64

    def _boom(image):
        raise RuntimeError("simulated encode failure")

    preview_channel._encode_frame_to_png_base64 = _boom
    try:
        sent = broadcast_preview("gen_01", object(), "Highres")
        raised = False
    except Exception:  # noqa: BLE001 - explicitly proving broadcast_preview itself never raises
        raised = True
    finally:
        preview_channel._encode_frame_to_png_base64 = original_encode
    assert raised is False
    assert sent is False


def test_node_input_types_contract():
    schema = AnimaPreview.INPUT_TYPES()
    required = schema["required"]
    assert required["channel"][0] == "STRING"
    assert required["channel"][1]["default"] == "default"
    assert "tooltip" in required["channel"][1] and required["channel"][1]["tooltip"]
    assert AnimaPreview.CATEGORY == "AnimaFlow/anima"
    assert AnimaPreview.FUNCTION == "preview"
    assert AnimaPreview.RETURN_TYPES == ()
    assert AnimaPreview.OUTPUT_NODE is True


def test_node_preview_is_a_no_op():
    node = AnimaPreview()
    result = node.preview(channel="gen_01")
    assert result == {}


ALL_TESTS = [
    test_normalize_channel_defaults_blank_to_default,
    test_build_preview_payload_shape,
    test_build_preview_payload_normalizes_channel_and_stage_label,
    test_broadcast_preview_no_op_when_encoding_fails,
    test_broadcast_preview_no_op_when_promptserver_module_missing,
    test_broadcast_preview_no_op_when_promptserver_instance_is_none,
    test_broadcast_preview_sends_when_promptserver_and_encoding_available,
    test_broadcast_preview_never_raises_on_unexpected_exception,
    test_node_input_types_contract,
    test_node_preview_is_a_no_op,
]


if __name__ == "__main__":
    failures = []
    for test in ALL_TESTS:
        try:
            test()
            print(f"PASS  {test.__name__}")
        except AssertionError as exc:
            failures.append(test.__name__)
            print(f"FAIL  {test.__name__}: {exc}")

    total = len(ALL_TESTS)
    passed = total - len(failures)
    print(f"\n{passed}/{total} tests passed")
    if failures:
        raise SystemExit(1)
