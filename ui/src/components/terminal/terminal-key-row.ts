/**
 * On-screen terminal key row for ghostty-web 0.4.0 on touch devices.
 *
 * PORT of `terminal-key-row.js` v4 (home-ops control-ui-patch-configmap.yaml).
 * This is a translation to TypeScript, not a reimplementation: every guard,
 * DOM-targeting choice, and the visibility-wiring fix documented below is
 * load-bearing. Do not "simplify" any of it without re-verifying on device.
 *
 * Android soft keyboards have no ESC, TAB, CTRL, ALT, arrows, HOME/END or
 * PGUP/PGDN, which makes the in-app terminal unusable for anything
 * interactive. This adds an accessory row above the keyboard.
 *
 * The row renders as a fixed overlay in its own shadow-rooted element
 * appended to document.body. It must never touch the terminal subtree: no
 * style/attribute changes on the panel host or ghostty container, no
 * synthetic resize dispatch. The overlay may cover the bottom terminal row
 * rather than resize the terminal; the touch fix (terminal-android-touch.ts)
 * is not disturbed by this shim existing.
 *
 * WRITE PATH. For navigation keys, dispatch a synthetic KeyboardEvent onto
 * ghostty's own hidden textarea so ghostty's keydown handler encodes it
 * against the live DECCKM state (arrows are CSI normally, SS3 in application
 * cursor mode). For everything else, and as a fallback if ghostty does not
 * acknowledge the key, dispatch a non-composed compositionend carrying the
 * literal escape sequence onto the container. Both are pre-existing ghostty
 * contracts already exercised by the sibling Android IME shim
 * (terminal-android-ime.ts).
 *
 * VISIBILITY. document-level focusin does not fire when focus moves inside
 * the terminal's shadow root (it retargets to the same host), so visibility
 * is driven by wiring focusin/focusout directly on each discovered ghostty
 * container's OWN root node (its ShadowRoot). Discovery must happen before a
 * container takes focus: a bounded initial scan, a MutationObserver on
 * document.body, and touchstart/pointerdown-triggered rediscovery (both are
 * composed events that cross the shadow boundary and reach document, unlike
 * a plain MutationObserver, which does not observe inside shadow roots)
 * cover every path a container can appear on.
 */

import { isCoarsePointerDevice } from "./terminal-coarse-pointer.ts";
import {
  isInstallFlagSet,
  releaseInstallFlagForTests,
  setInstallFlag,
} from "./terminal-shim-install-guard.ts";

const ESC = "\x1b";

// --- container resolution --------------------------------------------

/**
 * Descends into open shadow roots to reach the truly-focused element.
 * Closed shadow roots stop the descent, so activeElement will be the host
 * in that case.
 */
export function deepActiveElement(doc: Document = document): Element | null {
  let el: Element | null = doc.activeElement;
  let guard = 0;
  while (el && el.shadowRoot && el.shadowRoot.activeElement && guard < 64) {
    el = el.shadowRoot.activeElement;
    guard += 1;
  }
  return el;
}

/** ghostty's container owns the canvas and parents the hidden textarea. */
export function isGhosttyContainer(node: unknown): node is Element {
  return Boolean(
    node instanceof Element &&
    typeof node.querySelector === "function" &&
    node.querySelector("canvas") &&
    node.querySelector("textarea"),
  );
}

/**
 * Walks up from a start node across shadow boundaries. Returns the first
 * ancestor that structurally looks like a ghostty container. Deliberately
 * broader than "immediate parent of textarea": on a build where the
 * textarea sits under an extra wrapper the immediate-parent check misses.
 */
export function findGhosttyAncestor(start: Node | null): Element | null {
  let node: (Node & { host?: Element }) | null = start;
  let guard = 0;
  while (node && guard < 128) {
    if (isGhosttyContainer(node)) {
      return node;
    }
    const next: Node | null = node.parentNode ?? node.host ?? null;
    node = next;
    guard += 1;
  }
  return null;
}

/** The focused ghostty container, or null. */
export function focusedContainer(doc: Document = document): Element | null {
  const el = deepActiveElement(doc);
  if (!el) {
    return null;
  }
  if (el.tagName === "TEXTAREA") {
    const byAncestor = findGhosttyAncestor(el.parentNode);
    if (byAncestor) {
      return byAncestor;
    }
  }
  return null;
}

// --- modifier latches -------------------------------------------------

export type KeyRowLatch = { ctrl: boolean; alt: boolean };

/** Applies the armed Ctrl/Alt modifiers to a literal data string. */
export function applyLatches(data: string, mods: KeyRowLatch): string {
  let out = data;
  if (mods.ctrl && out.length === 1) {
    const code = out.toLowerCase().charCodeAt(0);
    if (code >= 97 && code <= 122) {
      out = String.fromCharCode(code - 96);
    } else if (code >= 64 && code <= 95) {
      out = String.fromCharCode(code - 64);
    } else if (out === " ") {
      out = "\x00";
    }
  }
  if (mods.alt) {
    out = ESC + out;
  }
  return out;
}

// --- keys -------------------------------------------------------------

type KeyDef =
  | { label: string; data: string; code?: undefined; latch?: undefined; dismiss?: undefined }
  | { label: string; code: string; data: string; latch?: undefined; dismiss?: undefined }
  | {
      label: string;
      latch: "ctrl" | "alt";
      data?: undefined;
      code?: undefined;
      dismiss?: undefined;
    }
  | { label: string; dismiss: true; data?: undefined; code?: undefined; latch?: undefined };

export const KEY_ROW_ROWS: readonly KeyDef[][] = [
  [
    { label: "ESC", data: ESC },
    { label: "/", data: "/" },
    { label: "|", data: "|" },
    { label: "-", data: "-" },
    // Column pairing, top over bottom: Up over Down so the four arrows form
    // the inverted T every physical keyboard uses (with HOME in that
    // column instead, reaching for Up lands on HOME), and PGUP over PGDN
    // so the page pair reads as one control.
    { label: "↑", code: "ArrowUp", data: `${ESC}[A` },
    { label: "HOME", code: "Home", data: `${ESC}[H` },
    { label: "PGUP", code: "PageUp", data: `${ESC}[5~` },
    { label: "END", code: "End", data: `${ESC}[F` },
  ],
  [
    { label: "TAB", data: "\t" },
    { label: "CTRL", latch: "ctrl" },
    { label: "ALT", latch: "alt" },
    { label: "←", code: "ArrowLeft", data: `${ESC}[D` },
    { label: "↓", code: "ArrowDown", data: `${ESC}[B` },
    { label: "→", code: "ArrowRight", data: `${ESC}[C` },
    { label: "PGDN", code: "PageDown", data: `${ESC}[6~` },
    { label: "⌨", dismiss: true },
  ],
];

const INSTALL_FLAG = "__openclawTerminalKeyRowV4";
let installAbort: AbortController | null = null;

/**
 * Installs the on-screen key row exactly once per page. Idempotent: safe to
 * call from every terminal instance's setup path.
 */
export function installTerminalKeyRow(): void {
  if (isInstallFlagSet(INSTALL_FLAG)) {
    return;
  }

  // Same scoping rule as the touch fixes: this is a soft-keyboard
  // accessory. On a device with a real keyboard it is redundant and would
  // only cover terminal rows.
  //
  // Unlike the sibling IME/reserve shims (which latch the flag BEFORE this
  // gate), the shipped key-row shim latches its flag AFTER: a call on a
  // non-touch device does not consume the once-only install, so a later
  // call on a hybrid/convertible device that has since reported a coarse
  // pointer can still install it. Preserve that exact ordering -- do not
  // merge this into the shared claimInstallFlag() used by the sibling
  // shims, which checks and sets atomically.
  if (!isCoarsePointerDevice()) {
    return;
  }
  setInstallFlag(INSTALL_FLAG);

  // Production never tears this down (install-once for the page's
  // lifetime, matching the original's `window[FLAG]` contract). The signal
  // exists so tests can fully uninstall between cases.
  const abort = new AbortController();
  installAbort = abort;

  const latch: KeyRowLatch = { ctrl: false, alt: false };
  let reentrant = false;

  // Non-composed non-bubbling compositionend on the container: exactly the
  // same delivery contract the sibling IME shim uses.
  const writeTo = (container: Element, data: string): void => {
    reentrant = true;
    try {
      container.dispatchEvent(
        new CompositionEvent("compositionend", { data, bubbles: false, cancelable: false }),
      );
    } finally {
      reentrant = false;
    }
  };

  // Clears ghostty's composition latch without writing anything. Its
  // compositionend handler sets isComposing=false unconditionally but
  // guards the PTY write behind data.length > 0, so a zero-length event is
  // exactly the reset and nothing else.
  const endComposition = (container: Element): void => {
    reentrant = true;
    try {
      container.dispatchEvent(
        new CompositionEvent("compositionend", { data: "", bubbles: false, cancelable: false }),
      );
    } catch {
      /* nothing to clear */
    } finally {
      reentrant = false;
    }
  };

  // Latch consumption on the sibling shim's synthetic compositionend.
  // Attach to the container's own root, not to document, because a
  // non-composed CompositionEvent never leaves its shadow tree.
  const containerFromEvent = (event: Event): Element | null => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (isGhosttyContainer(node)) {
        return node;
      }
    }
    return isGhosttyContainer(event.target) ? event.target : null;
  };

  const buttons: { button: HTMLButtonElement; latch: "ctrl" | "alt" }[] = [];
  const render = (): void => {
    for (const entry of buttons) {
      entry.button.setAttribute("data-on", latch[entry.latch] ? "1" : "0");
    }
  };

  const onCompositionEnd = (event: Event): void => {
    try {
      if (reentrant) {
        return;
      }
      if (!latch.ctrl && !latch.alt) {
        return;
      }
      const data = (event as CompositionEvent).data;
      if (!data || data.length === 0) {
        return;
      }
      const container = containerFromEvent(event);
      if (!container) {
        return;
      }
      const transformed = applyLatches(data, latch);
      latch.ctrl = false;
      latch.alt = false;
      render();
      if (transformed === data) {
        return;
      }
      event.stopPropagation();
      writeTo(container, transformed);
    } catch {
      /* never break the terminal */
    }
  };

  const wiredRoots = new WeakSet<Node>();
  const wireRoot = (container: Element): void => {
    const root = container.getRootNode ? container.getRootNode() : null;
    if (!root || wiredRoots.has(root)) {
      return;
    }
    wiredRoots.add(root);
    root.addEventListener("compositionend", onCompositionEnd, {
      capture: true,
      signal: abort.signal,
    });
  };

  // Hands the key to ghostty's keydown listener so ITS encoder picks the
  // spelling under the live DECCKM state. Returns whether ghostty
  // acknowledged: not pre-cancelled, and cancelled once ghostty had run.
  const sendKey = (container: Element, code: string, mods: KeyRowLatch): boolean => {
    const target = container.querySelector("textarea");
    if (!target) {
      return false;
    }
    let event: KeyboardEvent;
    try {
      event = new KeyboardEvent("keydown", {
        key: code,
        code,
        bubbles: true,
        composed: false,
        cancelable: true,
        ctrlKey: mods.ctrl,
        altKey: mods.alt,
      });
    } catch {
      return false;
    }
    let preCancelled = false;
    const probe = (seen: Event): void => {
      if (seen === event) {
        preCancelled = event.defaultPrevented;
      }
    };
    container.addEventListener("keydown", probe, true);
    try {
      target.dispatchEvent(event);
    } finally {
      container.removeEventListener("keydown", probe, true);
    }
    return !preCancelled && event.defaultPrevented;
  };

  const send = (key: KeyDef): void => {
    const container = focusedContainer();
    if (!container) {
      return;
    }
    const mods: KeyRowLatch = { ctrl: latch.ctrl, alt: latch.alt };
    latch.ctrl = false;
    latch.alt = false;
    render();
    if (key.code) {
      if (sendKey(container, key.code, mods)) {
        return;
      }
      endComposition(container);
      if (sendKey(container, key.code, mods)) {
        return;
      }
    }
    if (key.data !== undefined) {
      writeTo(container, applyLatches(key.data, mods));
    }
  };

  // --- overlay ----------------------------------------------------------

  // The overlay lives in its OWN element on document.body, inside its own
  // shadow root. Nothing about the terminal subtree changes.
  const overlayHost = document.createElement("openclaw-terminal-key-row");
  overlayHost.id = "openclaw-terminal-key-row";
  const shadow = overlayHost.attachShadow({ mode: "open" });

  const style = document.createElement("style");
  style.textContent = [
    ":host {",
    "  position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483000;",
    "  display: none; pointer-events: none;",
    "}",
    ':host([data-visible="1"]) { display: block; }',
    ".bar {",
    "  pointer-events: auto;",
    "  display: flex; flex-direction: column; gap: 1px;",
    "  background: rgba(20,22,26,.96);",
    "  border-top: 1px solid rgba(255,255,255,.14);",
    "  padding: 2px 0 max(2px, env(safe-area-inset-bottom));",
    "  font: 500 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace;",
    "  -webkit-user-select: none; user-select: none;",
    "  touch-action: manipulation;",
    "}",
    ".row { display: flex; gap: 1px; }",
    "button {",
    "  flex: 1 1 0; min-width: 0; min-height: 34px; padding: 0 2px;",
    "  background: rgba(255,255,255,.07); color: #e8eaed;",
    "  border: 0; border-radius: 5px; font: inherit; cursor: pointer;",
    "  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;",
    "}",
    "button:active { background: rgba(255,255,255,.20); }",
    'button[data-on="1"] { background: #8ab4f8; color: #16181c; }',
  ].join("\n");
  shadow.appendChild(style);

  const bar = document.createElement("div");
  bar.className = "bar";
  shadow.appendChild(bar);

  for (const row of KEY_ROW_ROWS) {
    const rowEl = document.createElement("div");
    rowEl.className = "row";
    for (const key of row) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = key.label;
      // Keep focus on the hidden textarea: soft keyboard stays up, and
      // focusedContainer() still resolves during the click.
      button.addEventListener(
        "pointerdown",
        (e) => {
          e.preventDefault();
        },
        { signal: abort.signal },
      );
      button.addEventListener(
        "mousedown",
        (e) => {
          e.preventDefault();
        },
        { signal: abort.signal },
      );
      button.addEventListener(
        "click",
        (e) => {
          e.preventDefault();
          if (key.latch) {
            latch[key.latch] = !latch[key.latch];
            render();
          } else if (key.dismiss) {
            const container = focusedContainer();
            const textarea = container?.querySelector("textarea");
            if (textarea instanceof HTMLTextAreaElement) {
              textarea.blur();
            }
          } else {
            send(key);
          }
        },
        { signal: abort.signal },
      );
      if (key.latch) {
        buttons.push({ button, latch: key.latch });
      }
      rowEl.appendChild(button);
    }
    bar.appendChild(rowEl);
  }

  // --- lifecycle --------------------------------------------------------

  // Wires focusin/focusout on a container's own root. This is the fix for
  // v3's on-device failure: focus movement inside the terminal's shadow
  // root retargets to the same host, so no document-level focusin
  // dispatches. A listener on the ShadowRoot itself does see it.
  const wiredFocusRoots = new WeakSet<Node>();
  const wireContainer = (container: Element): void => {
    wireRoot(container); // compositionend latch, unchanged from earlier
    const root = container.getRootNode ? container.getRootNode() : null;
    if (!root || wiredFocusRoots.has(root)) {
      return;
    }
    wiredFocusRoots.add(root);
    root.addEventListener("focusin", update, { capture: true, signal: abort.signal });
    root.addEventListener(
      "focusout",
      () => {
        setTimeout(update, 0);
      },
      { capture: true, signal: abort.signal },
    );
  };

  function update(): void {
    const container = focusedContainer();
    const visible = Boolean(container);
    overlayHost.setAttribute("data-visible", visible ? "1" : "0");
    if (visible && container) {
      wireContainer(container);
    }
  }

  // Bounded discovery of every ghostty container currently in the tree plus
  // a MutationObserver for ones added later. This runs BEFORE any focus
  // event, which is what makes per-root focusin wiring reachable. Traverses
  // open shadow roots.
  function scanFrom(root: Document | ShadowRoot): void {
    try {
      if (!root || typeof root.querySelectorAll !== "function") {
        return;
      }
      const all = root.querySelectorAll("*");
      for (const el of all) {
        if (isGhosttyContainer(el)) {
          wireContainer(el);
        }
        if (el.shadowRoot) {
          scanFrom(el.shadowRoot);
        }
      }
    } catch {
      /* never break the page */
    }
  }

  let scanScheduled = false;
  function scheduleScan(): void {
    if (scanScheduled) {
      return;
    }
    scanScheduled = true;
    (window.requestAnimationFrame || ((cb: FrameRequestCallback) => setTimeout(cb, 16)))(() => {
      scanScheduled = false;
      scanFrom(document);
      update();
    });
  }

  // Document focusin is kept as a secondary trigger; it is not sufficient
  // by itself, per measured evidence, but does cover light-DOM paths.
  document.addEventListener("focusin", update, { capture: true, signal: abort.signal });
  document.addEventListener(
    "focusout",
    () => {
      setTimeout(update, 0);
    },
    { capture: true, signal: abort.signal },
  );
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", update, { signal: abort.signal });
  }

  // A MutationObserver does NOT observe inside shadow roots, and the
  // terminal panel mounts into one. When this shim installs at page load,
  // before the panel exists, the observer below therefore never fires for
  // it, discovery never runs, no per-root focusin is wired, and the row
  // stays hidden. Measured: installing after the terminal already existed
  // worked, installing at page load did not, which is the real load order.
  //
  // touchstart and pointerdown are composed, so they DO cross the shadow
  // boundary and reach document. Any interaction with the terminal is
  // therefore a reliable point to (re)discover it. The scan is idempotent
  // and WeakSet-guarded, so repeats are cheap. The trailing update covers
  // the focus landing after this handler returns, which the touch fix
  // defers by a task.
  function rediscover(): void {
    scheduleScan();
    setTimeout(() => {
      scanFrom(document);
      update();
    }, 60);
  }
  document.addEventListener("touchstart", rediscover, {
    capture: true,
    passive: true,
    signal: abort.signal,
  });
  document.addEventListener("pointerdown", rediscover, {
    capture: true,
    passive: true,
    signal: abort.signal,
  });

  function attach(): void {
    if (!document.body) {
      return;
    }
    document.body.appendChild(overlayHost);
    render();
    scanFrom(document);
    update();
    try {
      const mo = new MutationObserver(scheduleScan);
      mo.observe(document.body, { childList: true, subtree: true });
      abort.signal.addEventListener("abort", () => mo.disconnect());
    } catch {
      /* no MutationObserver: initial scan still runs */
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", attach, { once: true, signal: abort.signal });
  } else {
    attach();
  }

  abort.signal.addEventListener("abort", () => overlayHost.remove());
}

/** Test-only: fully uninstalls (including document listeners/overlay) and resets the guard. */
export function resetTerminalKeyRowForTests(): void {
  installAbort?.abort();
  installAbort = null;
  releaseInstallFlagForTests(INSTALL_FLAG);
}
