"""Pure math + duck-typed Impact Pack `DETAILER_HOOK` object for
`AnimaDetailerAlignHook`.

Ported from `../ComfyUI-EasyUseAnima/easyuse_anima/image/detailer.py`'s
`_EasyUseAnimaAlignedDetailerHook`. No Impact Pack import anywhere in this
module (the reference doesn't import it either): Impact Pack's
`DetailerForEach`-family nodes call into their `detailer_hook` input purely
by duck-typed method name (`touch_scaled_size`, `pre_ksample`, etc — no
shared base class), so this object structurally satisfies that protocol
whether or not Impact Pack is installed. It simply never gets called unless
something wires it into an actual Impact detailer node.
"""

from __future__ import annotations

from typing import Optional


def align_up(value: int, alignment: int) -> int:
    """Round `value` UP to the nearest multiple of `alignment` (minimum
    `alignment` itself)."""
    value = int(value)
    alignment = max(1, int(alignment))
    return max(alignment, ((value + alignment - 1) // alignment) * alignment)


class AnimaAlignedDetailerHook:
    """Impact-Pack-compatible `DETAILER_HOOK`: rounds the crop-sampling size
    UP to `size_multiple` (latent-safety) and optionally chains to
    `base_hook` first (its methods run FIRST; this hook's own behavior,
    where it differs, is layered on top of whatever `base_hook` returns), so
    an existing hook the user already has wired keeps working, just with
    size alignment additionally enforced.

    `size_multiple=None` (or <= 1) disables the rounding entirely and this
    object becomes a pure passthrough to `base_hook` (or a no-op if there is
    none) — every method below falls back to the plain Impact Pack default
    behavior documented per-method.
    """

    def __init__(self, base_hook, size_multiple: Optional[int]):
        self.base_hook = base_hook
        self.size_multiple = int(size_multiple) if size_multiple and int(size_multiple) > 1 else None

    def __getattr__(self, name):
        # Any DETAILER_HOOK method this class doesn't explicitly implement
        # falls through to the wrapped base_hook (if any) — so a
        # partially-customized base_hook's extra methods keep working
        # through this wrapper untouched.
        if self.base_hook is not None:
            return getattr(self.base_hook, name)
        raise AttributeError(name)

    def touch_scaled_size(self, width, height):
        if self.base_hook is not None and hasattr(self.base_hook, "touch_scaled_size"):
            width, height = self.base_hook.touch_scaled_size(width, height)
        if self.size_multiple is None:
            return width, height
        return align_up(width, self.size_multiple), align_up(height, self.size_multiple)

    def post_upscale(self, image, noise_mask):
        if self.base_hook is not None and hasattr(self.base_hook, "post_upscale"):
            return self.base_hook.post_upscale(image, noise_mask)
        return image

    def get_skip_sampling(self):
        if self.base_hook is not None and hasattr(self.base_hook, "get_skip_sampling"):
            return self.base_hook.get_skip_sampling()
        return False

    def post_encode(self, latent):
        if self.base_hook is not None and hasattr(self.base_hook, "post_encode"):
            return self.base_hook.post_encode(latent)
        return latent

    def get_custom_sampler(self):
        if self.base_hook is not None and hasattr(self.base_hook, "get_custom_sampler"):
            return self.base_hook.get_custom_sampler()
        return None

    def set_steps(self, steps):
        if self.base_hook is not None and hasattr(self.base_hook, "set_steps"):
            return self.base_hook.set_steps(steps)
        return None

    def cycle_latent(self, latent):
        if self.base_hook is not None and hasattr(self.base_hook, "cycle_latent"):
            return self.base_hook.cycle_latent(latent)
        return latent

    def pre_ksample(self, model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise):
        if self.base_hook is not None and hasattr(self.base_hook, "pre_ksample"):
            return self.base_hook.pre_ksample(
                model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise
            )
        return model, seed, steps, cfg, sampler_name, scheduler, positive, negative, latent, denoise

    def get_custom_noise(self, seed, noise, is_touched):
        if self.base_hook is not None and hasattr(self.base_hook, "get_custom_noise"):
            return self.base_hook.get_custom_noise(seed, noise, is_touched)
        return noise, is_touched

    def pre_decode(self, latent):
        if self.base_hook is not None and hasattr(self.base_hook, "pre_decode"):
            return self.base_hook.pre_decode(latent)
        return latent

    def post_decode(self, image):
        if self.base_hook is not None and hasattr(self.base_hook, "post_decode"):
            return self.base_hook.post_decode(image)
        return image

    def post_paste(self, image):
        if self.base_hook is not None and hasattr(self.base_hook, "post_paste"):
            return self.base_hook.post_paste(image)
        return image


__all__ = ("AnimaAlignedDetailerHook", "align_up")
