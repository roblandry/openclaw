/**
 * Android touch gesture translation for ghostty-web 0.4.0.
 *
 * PORT of `terminal-touch-fixes.js`'s touch-fix v6 (home-ops
 * control-ui-patch-configmap.yaml). This is a translation to TypeScript, not
 * a reimplementation: every guard, threshold, and DOM-targeting choice below
 * is load-bearing and was verified live on a Galaxy Z Fold6 (2026-09-09) for
 * the v5 interaction logic; v6 additionally scopes every interception to
 * ghostty's own canvas structure (statically validated, not yet
 * re-verified on device — preserve it exactly, do not loosen it).
 *
 * Desired touch contract (this shim supplies ONLY the touch-to-mouse/click
 * translation; it never reimplements hit-testing, selection, or copy):
 *   - quick tap on a link: open it
 *   - quick tap elsewhere: let ghostty focus its hidden textarea
 *   - one-finger drag: scroll the terminal scrollback
 *   - long press: begin selection; a drag from there extends it, using
 *     ghostty's existing SelectionManager
 *
 * ghostty-web 0.4.0 implements selection and links only through mouse
 * events, and its canvas `touchend` handler calls `preventDefault()`, so
 * Android never synthesizes those mouse events. This shim supplies only the
 * missing translation layer.
 */

const MOVE_TOLERANCE_PX = 10;
const LONG_PRESS_MS = 500;
const WHEEL_QUANTUM_PX = 33;
const WHEEL_MAX_STEPS = 5;

type Gesture = {
  canvas: HTMLCanvasElement;
  startX: number;
  startY: number;
  lastX: number;
  lastY: number;
  startedAt: number;
  selecting: boolean;
  scrolling: boolean;
  scrollResidual: number;
  longPressed: boolean;
  longPressTimer: ReturnType<typeof setTimeout> | null;
};

let installed = false;
let installAbort: AbortController | null = null;

/**
 * Installs the Android touch gesture workaround exactly once per page.
 * Idempotent: safe to call from every terminal instance's setup path.
 */
export function installTerminalAndroidTouchFix(): void {
  if (installed) {
    return;
  }
  installed = true;

  // Production never tears this down (install-once for the page's
  // lifetime, matching the original's `window[FLAG]` contract). The signal
  // exists so tests can fully uninstall between cases.
  const abort = new AbortController();
  installAbort = abort;

  let gesture: Gesture | null = null;

  // Accept only ghostty's canvas. The Control UI also embeds other canvases,
  // including noVNC, whose native touch state must never be intercepted by
  // this workaround.
  const canvasFromPath = (event: Event): HTMLCanvasElement | null => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    for (const node of path) {
      if (!(node instanceof Element) || node.tagName !== "CANVAS") {
        continue;
      }
      const container = node.parentElement;
      if (
        container &&
        Array.from(container.children).some((child) => child.tagName === "TEXTAREA")
      ) {
        return node as HTMLCanvasElement;
      }
    }
    return null;
  };

  const mouse = (
    target: Element,
    type: string,
    x: number,
    y: number,
    options: { button?: number; buttons?: number; ctrlKey?: boolean } = {},
  ): void => {
    target.dispatchEvent(
      new MouseEvent(type, {
        clientX: x,
        clientY: y,
        button: options.button ?? 0,
        buttons: options.buttons ?? 0,
        ctrlKey: options.ctrlKey ?? false,
        bubbles: true,
        cancelable: true,
        composed: true,
        // No `view: window`: ghostty's mouse handlers read clientX/clientY/
        // buttons/ctrlKey only, never `view`, and the repo's other synthetic
        // event (chat-scroll-input.ts's WheelEvent) omits it for the same
        // reason. Also avoids a jsdom cross-realm "member view is not of
        // type Window" failure under this repo's non-isolated vitest pool.
      }),
    );
  };

  const beginSelection = (currentX: number, currentY: number): void => {
    if (!gesture || gesture.selecting) {
      return;
    }
    gesture.selecting = true;
    mouse(gesture.canvas, "mousedown", gesture.startX, gesture.startY, { button: 0, buttons: 1 });
    mouse(gesture.canvas, "mousemove", currentX, currentY, { button: 0, buttons: 1 });
  };

  const finishSelection = (x: number, y: number): void => {
    if (!gesture || !gesture.selecting) {
      return;
    }
    mouse(gesture.canvas, "mousemove", x, y, { button: 0, buttons: 1 });
    mouse(gesture.canvas, "mouseup", x, y, { button: 0, buttons: 0 });
  };

  // Scrolling goes through ghostty's own wheel handler rather than any
  // scroll code of our own; it is registered on the CONTAINER and already
  // does the right thing per mode (alternate screen -> arrow keys, normal
  // screen -> scrollback). Reimplementing that here would be a second
  // opinion that could drift from ghostty's.
  //
  // deltaY is negated so content tracks the finger, which is the platform
  // convention: dragging down reveals earlier output.
  const wheelScroll = (canvas: HTMLCanvasElement, deltaY: number, x: number, y: number): void => {
    const container = canvas.parentElement;
    if (!container || !deltaY) {
      return;
    }
    container.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY: -deltaY,
        deltaMode: 0,
        clientX: x,
        clientY: y,
        bubbles: true,
        cancelable: true,
        composed: true,
        // See mouse()'s comment: `view` intentionally omitted.
      }),
    );
  };

  const cancelLongPress = (): void => {
    if (gesture && gesture.longPressTimer !== null) {
      clearTimeout(gesture.longPressTimer);
      gesture.longPressTimer = null;
    }
  };

  // ghostty's two wheel branches consume deltaY differently, and only one
  // of them is lossy:
  //   - normal scrollback keeps the fraction (any delta moves the viewport)
  //   - alternate screen emits arrow keys via
  //     Math.round(deltaY / 33), capped at 5, with no residual carried
  //     between events, so small drags round to zero and fast flicks
  //     discard everything past 165px.
  // So deltas are accumulated here and flushed using ghostty's OWN rounding
  // rule (round, not truncate: half a quantum is already one arrow), then the
  // emitted amount is subtracted and the remainder carried forward.
  const flushScroll = (x: number, y: number): void => {
    if (!gesture) {
      return;
    }
    // Bounded: each pass leaves |residual| <= half a quantum, so this
    // settles immediately. The counter is a guard, not part of the logic.
    for (let guard = 0; guard < 8; guard++) {
      const steps = Math.round(gesture.scrollResidual / WHEEL_QUANTUM_PX);
      if (!steps) {
        return;
      }
      const capped = Math.max(-WHEEL_MAX_STEPS, Math.min(WHEEL_MAX_STEPS, steps));
      const chunk = capped * WHEEL_QUANTUM_PX;
      wheelScroll(gesture.canvas, chunk, x, y);
      gesture.scrollResidual -= chunk;
    }
  };

  document.addEventListener(
    "touchstart",
    (event) => {
      const te = event as TouchEvent;
      // Every path that discards a gesture must cancel its timer first, or
      // the old timer outlives the gesture it belonged to and arms the next
      // one.
      cancelLongPress();
      if (te.touches.length !== 1) {
        gesture = null;
        return;
      }
      const canvas = canvasFromPath(event);
      const touch = te.touches[0];
      if (!canvas || !touch) {
        gesture = null;
        return;
      }
      const started: Gesture = {
        canvas,
        startX: touch.clientX,
        startY: touch.clientY,
        lastX: touch.clientX,
        lastY: touch.clientY,
        startedAt: performance.now(),
        selecting: false,
        scrolling: false,
        scrollResidual: 0,
        longPressed: false,
        longPressTimer: null,
      };
      gesture = started;
      // A press held in place arms selection. It only ARMS it: nothing is
      // selected until the finger then moves, so a long press that is
      // simply released still reaches Android untouched and still offers
      // paste.
      //
      // The callback closes over THIS gesture and checks identity before
      // arming. Reading the module-level `gesture` instead would let a
      // timer from an abandoned touch arm whichever gesture happened to be
      // current when it fired, turning a later scroll into a selection.
      started.longPressTimer = setTimeout(() => {
        if (gesture !== started) {
          return;
        }
        started.longPressed = true;
        started.longPressTimer = null;
      }, LONG_PRESS_MS);
      // Do not preventDefault here. Android needs the untouched press to
      // offer paste.
    },
    { capture: true, passive: true, signal: abort.signal },
  );

  document.addEventListener(
    "touchmove",
    (event) => {
      const te = event as TouchEvent;
      if (!gesture || te.touches.length !== 1) {
        return;
      }
      const touch = te.touches[0];
      if (!touch) {
        return;
      }
      // lastX/lastY are updated at the END of this handler, not here: the
      // scroll branch needs the delta since the previous move.

      const moved =
        Math.abs(touch.clientX - gesture.startX) > MOVE_TOLERANCE_PX ||
        Math.abs(touch.clientY - gesture.startY) > MOVE_TOLERANCE_PX;
      if (!moved && !gesture.selecting && !gesture.scrolling) {
        gesture.lastX = touch.clientX;
        gesture.lastY = touch.clientY;
        return;
      }

      // Movement means this is no longer a press held in place.
      cancelLongPress();

      // Chrome marks touchmove non-cancelable once a scroll is already in
      // progress. Calling preventDefault() then is rejected and logged as
      // an [Intervention].
      if (event.cancelable) {
        event.preventDefault();
      }

      // Three-way split, matching what the platform does with the same
      // gestures:
      //   already selecting        -> keep extending the selection
      //   moved after a long press -> start selecting from where the press
      //                                landed
      //   moved without one        -> scroll
      if (gesture.selecting) {
        mouse(gesture.canvas, "mousemove", touch.clientX, touch.clientY, { button: 0, buttons: 1 });
      } else if (gesture.longPressed) {
        beginSelection(touch.clientX, touch.clientY);
      } else {
        gesture.scrolling = true;
        gesture.scrollResidual += touch.clientY - gesture.lastY;
        flushScroll(touch.clientX, touch.clientY);
      }

      gesture.lastX = touch.clientX;
      gesture.lastY = touch.clientY;
    },
    { capture: true, passive: false, signal: abort.signal },
  );

  document.addEventListener(
    "touchend",
    (event) => {
      if (!gesture) {
        return;
      }
      const te = event as TouchEvent;
      const ended = gesture;
      const touch = te.changedTouches && te.changedTouches[0];
      const x = touch ? touch.clientX : ended.lastX;
      const y = touch ? touch.clientY : ended.lastY;
      const heldFor = performance.now() - ended.startedAt;
      cancelLongPress();

      if (ended.selecting) {
        finishSelection(x, y);
        gesture = null;
        return;
      }

      gesture = null;

      if (ended.scrolling) {
        // A scroll is not a tap. Synthesizing a click here would resolve a
        // link under the finger at the end of a flick.
        return;
      }

      if (heldFor >= LONG_PRESS_MS) {
        // A press held in place and released without moving belongs to
        // Android: this is the path that offers paste. Do not synthesize a
        // click and do not clear the selection.
        return;
      }

      // ghostty's click handler performs cell hit-testing and resolves both
      // OSC 8 and plain-URL links. Ctrl is required by its providers. A
      // non-link is a harmless no-op; the final capture listener below
      // focuses the textarea for typing.
      mouse(ended.canvas, "click", x, y, { button: 0, buttons: 0, ctrlKey: true });
    },
    { capture: true, passive: true, signal: abort.signal },
  );

  document.addEventListener(
    "touchcancel",
    () => {
      cancelLongPress();
      if (gesture && gesture.selecting) {
        finishSelection(gesture.lastX, gesture.lastY);
      }
      gesture = null;
    },
    { capture: true, passive: true, signal: abort.signal },
  );

  // Restore the browser's native tap handling by keeping ghostty's canvas
  // touchend listener from running, then do its useful half (focus the
  // textarea) ourselves. Registered last so the gesture handlers above
  // still see every event.
  //
  // The focus call is deferred by one task. ghostty's container carries
  // contenteditable="true" and tabindex="0", so the browser's own tap
  // handling focuses the CONTAINER, and it does so after this listener
  // returns. Focusing synchronously here is therefore overwritten, which
  // left the container as the end-state active element even though this
  // code had run.
  //
  // Measured in a real browser against a live terminal. Focusing
  // synchronously, the deep active element after a real touch tap was
  // DIV.tp-host at 0, 50, 200, 500, 1000 and 2000ms. Deferring with
  // setTimeout(..., 0), it is TEXTAREA at 50, 300 and 1200ms.
  //
  // This matters beyond typing: anything keyed on the terminal holding
  // focus, such as an accessory key row, cannot observe focus while it
  // lands on the container.
  document.addEventListener(
    "touchend",
    (event) => {
      try {
        const canvas = canvasFromPath(event);
        if (!canvas) {
          return;
        }
        event.stopPropagation();
        const container = canvas.parentElement;
        const textarea = container && container.querySelector("textarea");
        if (!textarea) {
          return;
        }
        setTimeout(() => {
          try {
            (textarea as HTMLTextAreaElement).focus();
          } catch {
            /* never break the page */
          }
        }, 0);
      } catch {
        /* never break the page */
      }
    },
    { capture: true, passive: true, signal: abort.signal },
  );
}

/** Test-only: fully uninstalls (including document listeners) and resets the guard. */
export function resetTerminalAndroidTouchFixForTests(): void {
  installAbort?.abort();
  installAbort = null;
  installed = false;
}
