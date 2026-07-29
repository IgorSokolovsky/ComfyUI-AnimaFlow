/**
 * size.mjs — the ONE duck-typed "is this a size/pos-shaped pair" predicate,
 * shared by BOTH tracks (`js/controls/`, `js/anima/`). Pure, no DOM, no
 * `app`/`window`/`LiteGraph` reference — same layering rule as
 * `js/shared/field_logic.mjs` (`js/shared/test_field_logic.mjs`'s own
 * layering-guard test enforces "js/shared/ never imports a track", not the
 * reverse — this file has zero imports at all, so it trivially satisfies it).
 *
 * ## Why this file exists — measured live, not a hypothesis
 *
 * `node.size` on a real, running litegraph node is NOT a plain `Array`. Probed
 * on a live node (`.claude/skills/comfyui-litegraph-node-sizing/SKILL.md`):
 *
 *   sizeIsArray: false        sizeCtor: "Float64Array"
 *   hasPosSize:  true         posSizeCtor: "Rectangle"
 *
 * `node.size` is a `Float64Array` VIEW over a `Rectangle` backing store, and
 * `Array.isArray(new Float64Array(2)) === false`. So EVERY
 * `Array.isArray(node.size)` guard ever written in this pack silently
 * short-circuited and did nothing, live — while passing every test, because
 * every test stub's `size` was a plain array. Sampling a live height drag
 * proved it: the height climbed `268 -> 386` and stayed there, uncorrected,
 * despite five separate mechanisms supposedly enforcing a maximum.
 *
 * `isSizeLike` duck-types instead of type-checking: it accepts a plain
 * `Array`, a `Float64Array`, or any other indexable with a numeric `.length`
 * and finite numbers in the entries that matter. Reading OR writing through
 * the reference it validates (`value[0] = x`) works identically for either
 * shape — a `Float64Array` writes through to its backing `Rectangle` exactly
 * like a plain array writes to itself. The one thing that does NOT work for
 * either shape is replacing the whole reference (`node.size = [w, h]`): for a
 * `Float64Array` view that detaches it from the `Rectangle` entirely, so
 * every caller of this predicate must keep mutating IN PLACE
 * (`node.size[0] = w; node.size[1] = h;`), never reassign `node.size` itself.
 */

/**
 * `isSizeLike(value, minLength = 2)` — true iff `value` is indexable (has a
 * finite numeric `.length`) with at least `minLength` entries, AND every
 * entry from `0` to `minLength - 1` is a finite number.
 *
 * `minLength` defaults to `2` (a full `[w, h]` — or `[x, y]` — pair); pass
 * `1` for a width-only (or x-only) check, mirroring `clampMinWidth`'s
 * narrower need in `js/anima/render.mjs`. A caller asking for `minLength: 1`
 * doesn't care whether index `1` exists or is numeric at all.
 *
 * Deliberately excludes `null`/`undefined` and strings up front (a string
 * has a numeric `.length` too, and `"12"[0]` is the character `"1"`, not the
 * number `1` — `Number.isFinite` alone already rejects that, but the
 * explicit check keeps the early-out obvious without relying on that
 * distinction holding for every future JS numeric-coercion edge case).
 *
 * Wrapped in a `try`/`catch`, returning `false` on any thrown error --
 * `TypedArray.prototype.length`'s getter is brand-checked (it throws
 * `TypeError: incompatible receiver` if `this` isn't a real TypedArray
 * instance, e.g. a `Proxy` wrapping one, which a test harness detecting
 * writes may reasonably construct even though litegraph itself never hands
 * this predicate anything but a genuine `Float64Array`/plain `Array`). A
 * duck-typing predicate should never throw regardless of what's handed to
 * it -- same defensive convention as `field_logic.mjs`'s `getComboOptions`.
 */
export function isSizeLike(value, minLength = 2) {
  try {
    if (value == null || typeof value === "string") {
      return false;
    }
    const len = value.length;
    if (typeof len !== "number" || !Number.isFinite(len) || len < minLength) {
      return false;
    }
    for (let i = 0; i < minLength; i += 1) {
      if (!Number.isFinite(value[i])) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}
