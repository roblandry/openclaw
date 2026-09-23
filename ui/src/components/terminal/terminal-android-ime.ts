/**
 * Android IME text-delivery workaround for ghostty-web 0.4.0.
 *
 * PORT of `terminal-touch-fixes.js`'s typing-fix v4 (home-ops
 * control-ui-patch-configmap.yaml). This is a translation to TypeScript, not
 * a reimplementation: every guard, event sequence, and DOM-targeting choice
 * below is load-bearing and was verified live on a Galaxy Z Fold6
 * (2026-09-09). Do not "simplify" any of it without re-verifying on device.
 *
 * Root cause (ghostty-web@0.4.0 `Terminal.open(A)`):
 *     A.addEventListener("beforeinput", (E) => E.preventDefault());
 * and it returns early for keyCode 229. Android Chrome delivers soft
 * keyboard text via `beforeinput`; ghostty cancels every one of them without
 * forwarding `event.data`, so `handleCompositionEnd`'s
 * `if (data && data.length > 0) onDataCallback(data)` guard never runs.
 * Upstream: coder/ghostty-web#120 (open, unreleased).
 *
 * The terminal lives inside an OPEN shadow root, so document-level listeners
 * see events retargeted to the panel host; `composedPath()` is required to
 * reach the real container (a DIV that owns both the canvas and ghostty's
 * hidden textarea).
 *
 * We do not reimplement the write path: we hand the text to ghostty's own
 * `handleCompositionEnd` via a synthetic `compositionend`.
 */

import { isCoarsePointerDevice } from "./terminal-coarse-pointer.ts";
import { claimInstallFlag, releaseInstallFlagForTests } from "./terminal-shim-install-guard.ts";

const INSTALL_FLAG = "__openclawTerminalImeShimV4";
let installAbort: AbortController | null = null;

/**
 * Installs the Android IME workaround exactly once per page. Idempotent:
 * safe to call from every terminal instance's setup path.
 */
export function installTerminalAndroidImeFix(): void {
  // Matches the shipped shim: the flag is claimed BEFORE the touch gate, so
  // a non-touch device still permanently consumes the once-only install
  // (see terminal-key-row.ts for the one shim that does this the other way
  // around).
  if (!claimInstallFlag(INSTALL_FLAG)) {
    return;
  }

  // [P1] Scope strictly to the broken path. On desktop, ghostty's keydown
  // route already works and a native compositionend still fires, so
  // forwarding here would deliver the same text twice for CJK input.
  if (!isCoarsePointerDevice()) {
    return;
  }

  // Production never tears this down (the shim is install-once for the
  // page's lifetime, matching the original's `window[FLAG]` contract). The
  // signal exists so tests can fully uninstall between cases.
  const abort = new AbortController();
  installAbort = abort;

  let imeActive = false;
  document.addEventListener(
    "keydown",
    (e) => {
      // keyCode 229 ("process key") is the measured signal Android soft
      // keyboards send for this event (see the module doc comment); `.key`
      // is deprecated but this is the specific, verified detection this
      // shim depends on.
      // oxlint-disable-next-line unicorn/prefer-keyboard-event-key -- measured Android IME keydown carries keyCode 229, not a reliable `.key` value
      if (e.keyCode === 229 || e.isComposing) {
        imeActive = true;
      } else if (e.key && e.key.length === 1) {
        imeActive = false;
      }
    },
    { capture: true, signal: abort.signal },
  );
  document.addEventListener(
    "compositionstart",
    () => {
      imeActive = true;
    },
    { capture: true, signal: abort.signal },
  );

  // ghostty's container owns the canvas and is the textarea's parent.
  const containerFromPath = (event: Event): Element | null => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof Element)) {
        continue;
      }
      // Identify ghostty's container structurally instead of depending on
      // incidental contenteditable state.
      if (node.querySelector("canvas") && node.querySelector("textarea")) {
        return node;
      }
    }
    return null;
  };

  // Secondary cancellation guard. Detects the specific ghostty-web
  // 0.4.0 `beforeinput` cancellation behavior, not every possible upstream
  // IME fix, so the shim disables itself automatically once ghostty stops
  // cancelling. Empty data is a no-op for ghostty's own handler.
  const bugged = new WeakMap<Element, boolean>();
  const isBugPresent = (container: Element): boolean => {
    if (bugged.has(container)) {
      return bugged.get(container) as boolean;
    }
    let result: boolean;
    try {
      const probe = new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: "",
      });
      container.dispatchEvent(probe);
      result = probe.defaultPrevented;
    } catch {
      result = true; // cannot probe: assume the bug and keep working
    }
    bugged.set(container, result);
    return result;
  };

  const send = (event: Event, data: string): boolean => {
    const container = containerFromPath(event);
    if (!container) {
      return false;
    }
    if (!isBugPresent(container)) {
      return false;
    }
    container.dispatchEvent(
      new CompositionEvent("compositionend", { data, bubbles: false, cancelable: false }),
    );
    return true;
  };

  document.addEventListener(
    "beforeinput",
    (event) => {
      try {
        if (!imeActive) {
          return;
        }
        const ie = event as InputEvent;
        const t = ie.inputType;
        let data: string | null = null;
        // [P1] Only COMMITTED text. insertCompositionText /
        // insertFromComposition are interim preedit updates; forwarding
        // them writes partial text and then the final text again. Measured
        // Android soft-keyboard commits arrive as insertText.
        if (t === "insertText") {
          data = ie.data;
        } else if (t === "insertLineBreak" || t === "insertParagraph") {
          data = "\r";
        } else if (t === "deleteContentBackward") {
          data = "\x7f";
        }
        if (!data || data.length === 0) {
          return;
        }
        send(event, data);
      } catch {
        /* never break the page */
      }
    },
    { capture: true, signal: abort.signal }, // capture: ahead of ghostty's bubble-phase preventDefault
  );
}

/** Test-only: fully uninstalls (including document listeners) and resets the guard. */
export function resetTerminalAndroidImeFixForTests(): void {
  installAbort?.abort();
  installAbort = null;
  releaseInstallFlagForTests(INSTALL_FLAG);
}
