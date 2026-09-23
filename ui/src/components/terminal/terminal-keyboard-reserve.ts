/**
 * Terminal bottom reserve. PORT of `terminal-reserve.js` v1 (home-ops
 * control-ui-patch-configmap.yaml). Keeps the prompt above the soft
 * keyboard, and above the on-screen key row (terminal-key-row.ts) when that
 * shim is also installed. Standalone: with no key row present the row
 * contribution is zero and this still fixes the soft keyboard covering the
 * cursor.
 *
 * ghostty's FitAddon observes its own container with a ResizeObserver and
 * computes rows as (clientHeight - padding-top - padding-bottom) /
 * cellHeight, so padding-bottom on THAT element is its own reserve
 * mechanism. Padding the panel host does nothing, and neither does a
 * synthetic window resize: ghostty registers no window resize listener at
 * all.
 */

import { isCoarsePointerDevice } from "./terminal-coarse-pointer.ts";

const KEY_ROW_TAG = "openclaw-terminal-key-row";

function isContainer(n: unknown): n is HTMLElement {
  if (!(n instanceof Element)) {
    return false;
  }
  const textarea = n.querySelector("textarea");
  return Boolean(n.querySelector("canvas") && textarea && textarea.parentElement === n);
}

function collect(root: Document | ShadowRoot, depth: number, out: HTMLElement[]): HTMLElement[] {
  if (depth > 12 || !root || typeof root.querySelectorAll !== "function") {
    return out;
  }
  const all = root.querySelectorAll("*");
  for (const el of all) {
    if (isContainer(el)) {
      out.push(el);
    }
    if (el.shadowRoot) {
      collect(el.shadowRoot, depth + 1, out);
    }
  }
  return out;
}

// How much of the layout viewport is cut off below the visual viewport.
//
// This is deliberately NOT claimed to be "the keyboard". It is the
// geometric gap, and what produces that gap depends on the page's
// interactive-widget policy:
//
//   resizes-visual  the keyboard shrinks only the visual viewport, so the
//                   gap is the keyboard and this reserve is what keeps the
//                   prompt visible.
//   resizes-content the keyboard shrinks the layout viewport as well, so
//                   the gap is ~0 and the panel has already been resized by
//                   the browser. Contributing 0 is then correct, not a
//                   failure.
//
// The Control UI declares interactive-widget=resizes-content, which by the
// specification should shrink the layout viewport too and leave this at 0.
// MEASURED ON DEVICE, that is not what happens. Galaxy Z Fold6, Chrome, with
// the soft keyboard open:
//
//     innerHeight 676   visualViewport.height 363   offsetTop 0   scale 1
//     -> gap 313, applied as padding-bottom, canvas 611 -> 247
//
// innerHeight did not move, so the layout viewport was not resized and this
// reserve is what keeps the prompt visible. Do not remove it on the
// strength of the declared policy; the policy and the browser disagree
// here.
//
// Pinch-zoom also shrinks the visual viewport. Measured: at page scale 2
// with no keyboard, innerHeight 915 against visualViewport.height 457.5
// yields a false 458px reserve, which would collapse the terminal on a
// zoom. Zoom is therefore excluded rather than guessed at.
function keyboardInset(): number {
  const vv = window.visualViewport;
  if (!vv) {
    return 0;
  }
  const scale = typeof vv.scale === "number" ? vv.scale : 1;
  if (Math.abs(scale - 1) > 0.01) {
    return 0;
  }
  const gap = window.innerHeight - (vv.height + vv.offsetTop);
  return gap > 1 ? Math.round(gap) : 0;
}

function keyRow(): Element | null {
  return document.querySelector(KEY_ROW_TAG);
}

function keyRowHeight(): number {
  const bar = keyRow();
  if (!bar || bar.getAttribute("data-visible") !== "1") {
    return 0;
  }
  const r = bar.getBoundingClientRect();
  return r.height > 0 ? Math.round(r.height) : 0;
}

let installed = false;
let installAbort: AbortController | null = null;

/**
 * Installs the keyboard-space reserve exactly once per page. Idempotent:
 * safe to call from every terminal instance's setup path.
 */
export function installTerminalKeyboardReserve(): void {
  if (installed) {
    return;
  }
  installed = true;

  if (!isCoarsePointerDevice()) {
    return;
  }

  // Production never tears this down (install-once for the page's
  // lifetime, matching the original's `window[FLAG]` contract). The signal
  // exists so tests can fully uninstall between cases.
  const abort = new AbortController();
  installAbort = abort;

  const apply = (): void => {
    const kb = keyboardInset();
    const bar = keyRow();
    // Float the row on top of the keyboard rather than behind it.
    if (bar instanceof HTMLElement) {
      bar.style.bottom = `${kb}px`;
    }
    const want = kb + keyRowHeight() > 0 ? `${kb + keyRowHeight()}px` : "";
    // Every discovered container is reconciled on every pass. Comparing
    // only the scalar inset value would conflate the inset VALUE with the
    // SET of elements already carrying it: a container replaced while the
    // inset held steady would stay unpadded, and a container detached while
    // the reserve closed would keep its stale padding when reattached. The
    // per-element comparison below is the only guard needed; ghostty
    // additionally debounces its own observer and tracks last cols/rows, so
    // a stable value converges.
    for (const c of collect(document, 0, [])) {
      if (c.style.paddingBottom !== want) {
        c.style.paddingBottom = want;
      }
    }
  };

  let queued = false;
  const schedule = (): void => {
    if (queued) {
      return;
    }
    queued = true;
    (window.requestAnimationFrame || ((cb: FrameRequestCallback) => setTimeout(cb, 16)))(() => {
      queued = false;
      try {
        apply();
      } catch {
        /* never break the terminal */
      }
    });
  };

  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", schedule, { signal: abort.signal });
    window.visualViewport.addEventListener("scroll", schedule, { signal: abort.signal });
  }
  document.addEventListener("focusin", schedule, { capture: true, signal: abort.signal });
  document.addEventListener(
    "focusout",
    () => {
      setTimeout(schedule, 0);
    },
    { capture: true, signal: abort.signal },
  );
  try {
    const observer = new MutationObserver(schedule);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["data-visible"],
    });
    abort.signal.addEventListener("abort", () => observer.disconnect());
  } catch {
    /* observer optional */
  }
  schedule();

  // Debug/introspection accessor, ported verbatim from the shim (including
  // its name) for on-device debugging parity. Not used by any production
  // code path.
  // oxlint-disable-next-line no-underscore-dangle -- matches the shipped shim's window.__ocReserveState name exactly, for on-device debugging continuity
  (window as unknown as Record<string, unknown>).__ocReserveState = () => ({
    keyboardInset: keyboardInset(),
    keyRowHeight: keyRowHeight(),
    containers: collect(document, 0, []).map((c) => ({
      pad: c.style.paddingBottom || "(none)",
      canvasH: Math.round(
        (c.querySelector("canvas") as HTMLCanvasElement).getBoundingClientRect().height,
      ),
    })),
  });
}

/** Test-only: fully uninstalls (including listeners/observer) and resets the guard. */
export function resetTerminalKeyboardReserveForTests(): void {
  installAbort?.abort();
  installAbort = null;
  installed = false;
}
