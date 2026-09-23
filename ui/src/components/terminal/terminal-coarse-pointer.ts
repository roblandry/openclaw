/**
 * Coarse-pointer (touch) device gate shared by every Android soft-keyboard
 * terminal workaround. Ported unchanged from the shipped shims' `isTouch`
 * check (see terminal-key-row.ts): a phone soft keyboard is the only reason
 * this on-screen key row exists, so it stays off physical-keyboard desktop.
 */
export function isCoarsePointerDevice(): boolean {
  return (
    (navigator.maxTouchPoints || 0) > 0 &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}
