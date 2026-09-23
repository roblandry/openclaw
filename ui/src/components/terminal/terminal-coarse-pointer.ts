/**
 * Coarse-pointer (touch) device gate shared by every Android soft-keyboard
 * terminal workaround (IME text delivery, touch gesture translation,
 * keyboard-space reserve). Ported unchanged from the shipped shims'
 * `isTouch` check (see terminal-android-ime.ts, terminal-android-touch.ts,
 * terminal-keyboard-reserve.ts): desktop's native `keydown`/`compositionend`
 * path already works, so these workarounds must stay off it.
 */
export function isCoarsePointerDevice(): boolean {
  return (
    (navigator.maxTouchPoints || 0) > 0 &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
