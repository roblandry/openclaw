/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  resetTerminalAndroidTouchFixForTests,
  installTerminalAndroidTouchFix,
} from "./terminal-android-touch.ts";

function buildGhosttyHost(): {
  host: HTMLElement;
  container: HTMLDivElement;
  canvas: HTMLCanvasElement;
  textarea: HTMLTextAreaElement;
} {
  const host = document.createElement("openclaw-terminal-panel");
  document.body.appendChild(host);
  const root = host.attachShadow({ mode: "open" });
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  const textarea = document.createElement("textarea");
  container.appendChild(canvas);
  container.appendChild(textarea);
  root.appendChild(container);
  return { host, container, canvas, textarea };
}

// jsdom implements the TouchEvent constructor but not the Touch constructor;
// a plain object with the fields ghostty/the shim actually reads (identifier,
// clientX, clientY, target) satisfies TouchEvent's touch-list initializer.
type FakeTouch = { identifier: number; clientX: number; clientY: number; target: EventTarget };
function makeTouch(init: {
  identifier?: number;
  clientX: number;
  clientY: number;
  target: EventTarget;
}): FakeTouch {
  return {
    identifier: init.identifier ?? 1,
    target: init.target,
    clientX: init.clientX,
    clientY: init.clientY,
  };
}
function touchEvent(
  type: string,
  target: EventTarget,
  touches: FakeTouch[],
  opts: { cancelable?: boolean; changedTouches?: FakeTouch[] } = {},
): TouchEvent {
  return new TouchEvent(type, {
    bubbles: true,
    composed: true,
    cancelable: opts.cancelable ?? true,
    touches: touches as unknown as Touch[],
    changedTouches: (opts.changedTouches ?? touches) as unknown as Touch[],
  });
}

describe("installTerminalAndroidTouchFix", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = "";
    resetTerminalAndroidTouchFixForTests();
  });

  it("quick tap: synthesizes a click with ctrlKey on the canvas (link activation)", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const clicks: MouseEvent[] = [];
    canvas.addEventListener("click", (e) => clicks.push(e as MouseEvent));

    const t = makeTouch({ clientX: 10, clientY: 10, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t]));
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t] }));

    expect(clicks).toHaveLength(1);
    expect(clicks[0]?.ctrlKey).toBe(true);
    expect(clicks[0]?.clientX).toBe(10);
  });

  it("tap-to-focus: defers focusing the hidden textarea by one task", () => {
    const { host, canvas, textarea } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const t = makeTouch({ clientX: 5, clientY: 5, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t]));
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t] }));

    // document.activeElement retargets across an open shadow boundary to the
    // host per spec; the shadow root's OWN activeElement is what reveals
    // whether the textarea inside it is truly focused.
    const shadowActive = () => (host.shadowRoot as ShadowRoot).activeElement;
    expect(shadowActive()).not.toBe(textarea);
    vi.advanceTimersByTime(0);
    expect(shadowActive()).toBe(textarea);
  });

  it("tap-to-focus: stops propagation so ghostty's own canvas touchend listener never runs", () => {
    const { canvas } = buildGhosttyHost();
    // ghostty's own listener: preventDefault + synchronous focus on the
    // container. Registered BEFORE the shim installs, exactly like the real
    // page (ghostty creates the terminal before this shim's document-level
    // listener is registered, and same-target registration order does not
    // matter here because the shim's dismissal listener stops propagation
    // before the event reaches the canvas' own listener at all).
    let ghosttyTouchEndRan = false;
    canvas.addEventListener("touchend", () => {
      ghosttyTouchEndRan = true;
    });
    installTerminalAndroidTouchFix();

    const t = makeTouch({ clientX: 5, clientY: 5, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t]));
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t] }));

    expect(ghosttyTouchEndRan).toBe(false);
  });

  it("drag without a long press: scrolls via a wheel event on the container, not a selection", () => {
    const { canvas, container } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const wheels: WheelEvent[] = [];
    container.addEventListener("wheel", (e) => wheels.push(e as WheelEvent));
    const mouseEvents: string[] = [];
    canvas.addEventListener("mousedown", () => mouseEvents.push("mousedown"));

    const t0 = makeTouch({ clientX: 100, clientY: 100, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    const t1 = makeTouch({ clientX: 100, clientY: 140, target: canvas }); // 40px vertical drag, well over tolerance and one quantum
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));

    expect(wheels.length).toBeGreaterThan(0);
    expect(mouseEvents).toEqual([]);
  });

  it("long press then drag: begins a mouse-based selection instead of scrolling", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const mouseEvents: string[] = [];
    canvas.addEventListener("mousedown", () => mouseEvents.push("mousedown"));
    canvas.addEventListener("mousemove", () => mouseEvents.push("mousemove"));

    const t0 = makeTouch({ clientX: 50, clientY: 50, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    vi.advanceTimersByTime(500); // LONG_PRESS_MS

    const t1 = makeTouch({ clientX: 75, clientY: 75, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));

    expect(mouseEvents).toEqual(["mousedown", "mousemove"]);
  });

  it("long press released without moving: no click, no selection (Android paste bubble stands)", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const clicks: MouseEvent[] = [];
    canvas.addEventListener("click", (e) => clicks.push(e as MouseEvent));

    const t = makeTouch({ clientX: 20, clientY: 20, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t]));
    vi.advanceTimersByTime(500);
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t] }));

    expect(clicks).toEqual([]);
  });

  it("selecting through touchend: finishes with a mousemove + mouseup", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const mouseEvents: string[] = [];
    canvas.addEventListener("mousedown", () => mouseEvents.push("mousedown"));
    canvas.addEventListener("mousemove", () => mouseEvents.push("mousemove"));
    canvas.addEventListener("mouseup", () => mouseEvents.push("mouseup"));

    const t0 = makeTouch({ clientX: 50, clientY: 50, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    vi.advanceTimersByTime(500);
    const t1 = makeTouch({ clientX: 75, clientY: 75, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t1] }));

    expect(mouseEvents).toEqual(["mousedown", "mousemove", "mousemove", "mouseup"]);
  });

  it("touchcancel while selecting: finishes the selection instead of leaving it dangling", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const mouseEvents: string[] = [];
    canvas.addEventListener("mouseup", () => mouseEvents.push("mouseup"));

    const t0 = makeTouch({ clientX: 50, clientY: 50, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    vi.advanceTimersByTime(500);
    const t1 = makeTouch({ clientX: 75, clientY: 75, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));
    canvas.dispatchEvent(touchEvent("touchcancel", canvas, []));

    expect(mouseEvents).toEqual(["mouseup"]);
  });

  it("scoping: a non-ghostty canvas (e.g. noVNC) is never intercepted", () => {
    const otherContainer = document.createElement("div");
    const otherCanvas = document.createElement("canvas");
    otherContainer.appendChild(otherCanvas); // no sibling textarea -> not ghostty's shape
    document.body.appendChild(otherContainer);
    installTerminalAndroidTouchFix();

    const clicks: MouseEvent[] = [];
    otherCanvas.addEventListener("click", (e) => clicks.push(e as MouseEvent));

    const t = makeTouch({ clientX: 5, clientY: 5, target: otherCanvas });
    otherCanvas.dispatchEvent(touchEvent("touchstart", otherCanvas, [t]));
    otherCanvas.dispatchEvent(touchEvent("touchend", otherCanvas, [], { changedTouches: [t] }));

    expect(clicks).toEqual([]);
  });

  it("multi-touch (pinch) start clears any in-progress gesture", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const clicks: MouseEvent[] = [];
    canvas.addEventListener("click", (e) => clicks.push(e as MouseEvent));

    const t0 = makeTouch({ identifier: 1, clientX: 5, clientY: 5, target: canvas });
    const t1 = makeTouch({ identifier: 2, clientX: 15, clientY: 15, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0, t1]));
    canvas.dispatchEvent(touchEvent("touchend", canvas, [], { changedTouches: [t0] }));

    expect(clicks).toEqual([]);
  });

  it("exact 10px tolerance boundary: dy=10 from start does not count as moved", () => {
    const { canvas, container } = buildGhosttyHost();
    installTerminalAndroidTouchFix();
    const wheels: WheelEvent[] = [];
    container.addEventListener("wheel", (e) => wheels.push(e as WheelEvent));

    const t0 = makeTouch({ clientX: 100, clientY: 100, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    const atTolerance = makeTouch({ clientX: 100, clientY: 110, target: canvas }); // dy===10
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [atTolerance]));
    expect(wheels).toEqual([]); // exactly at tolerance: NOT "moved" (code checks `>`, not `>=`)

    // A further move whose delta since the LAST position (not since start)
    // is large enough to clear one wheel quantum proves scrolling engaged.
    const overTolerance = makeTouch({ clientX: 100, clientY: 200, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [overTolerance]));
    expect(wheels.length).toBeGreaterThan(0);
  });

  it("wheel quantization: a single large move flushes multiple ±5-step quanta in one pass, bounded by the 8-iteration guard", () => {
    const { canvas, container } = buildGhosttyHost();
    installTerminalAndroidTouchFix();
    const wheelDeltas: number[] = [];
    container.addEventListener("wheel", (e) => wheelDeltas.push((e as WheelEvent).deltaY));

    const t0 = makeTouch({ clientX: 100, clientY: 100, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    // A single 500px drag: flushScroll loops within ONE touchmove call until
    // the residual drops below a whole quantum. residual=500 -> round(500/33)=15,
    // capped to 5 -> emit -165, residual=335 -> round(335/33)=10, capped to 5
    // -> emit -165, residual=170 -> round(170/33)=5, capped to 5 -> emit -165,
    // residual=5 -> round(5/33)=0 -> stop. Three emitted events, not one:
    // the cap limits each EVENT's magnitude, not the total flushed per move.
    const t1 = makeTouch({ clientX: 100, clientY: 600, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));

    expect(wheelDeltas).toEqual([-165, -165, -165]);
  });

  it("small sub-quantum drags accumulate residual across moves instead of being dropped", () => {
    const { canvas, container } = buildGhosttyHost();
    installTerminalAndroidTouchFix();
    const wheelDeltas: number[] = [];
    container.addEventListener("wheel", (e) => wheelDeltas.push((e as WheelEvent).deltaY));

    const t0 = makeTouch({ clientX: 100, clientY: 100, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    // First move clears the 10px tolerance and contributes 12px (residual 12, round(12/33)=0: no wheel yet).
    const t1 = makeTouch({ clientX: 100, clientY: 112, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t1]));
    expect(wheelDeltas).toEqual([]);
    // A further 12px (residual 24, round(24/33)=1 -> one wheel event).
    const t2 = makeTouch({ clientX: 100, clientY: 124, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [t2]));
    expect(wheelDeltas).toEqual([-33]);
  });

  it("non-cancelable touchmove is not rejected (Chrome intervention guard)", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();

    const t0 = makeTouch({ clientX: 100, clientY: 100, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [t0]));
    const t1 = makeTouch({ clientX: 100, clientY: 150, target: canvas });
    const event = touchEvent("touchmove", canvas, [t1], { cancelable: false });
    expect(() => canvas.dispatchEvent(event)).not.toThrow();
  });

  it("a stale long-press timer from a discarded gesture does not arm the next gesture", () => {
    const { canvas } = buildGhosttyHost();
    installTerminalAndroidTouchFix();
    const mouseEvents: string[] = [];
    canvas.addEventListener("mousedown", () => mouseEvents.push("mousedown"));

    // First touch arms a long-press timer, then is abandoned (touchcancel)
    // WITHOUT the timer having fired yet.
    const tA = makeTouch({ identifier: 1, clientX: 10, clientY: 10, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [tA]));
    canvas.dispatchEvent(touchEvent("touchcancel", canvas, []));

    // A second, brand-new touch starts and moves before 500ms elapses.
    const tB0 = makeTouch({ identifier: 2, clientX: 200, clientY: 200, target: canvas });
    canvas.dispatchEvent(touchEvent("touchstart", canvas, [tB0]));
    const tB1 = makeTouch({ identifier: 2, clientX: 220, clientY: 220, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [tB1]));

    // If the stale timer from touch A fired and armed gesture B as
    // longPressed by identity confusion, this move would have started a
    // mouse-based selection instead of a scroll.
    vi.advanceTimersByTime(500);
    const tB2 = makeTouch({ identifier: 2, clientX: 240, clientY: 240, target: canvas });
    canvas.dispatchEvent(touchEvent("touchmove", canvas, [tB2]));
    expect(mouseEvents).toEqual([]);
  });

  it("uses the same window flag name as the shipped shim, so a coexisting legacy copy would defer to it", () => {
    buildGhosttyHost();
    installTerminalAndroidTouchFix();
    // oxlint-disable-next-line no-underscore-dangle -- asserting the shipped shim's literal flag name, not a naming choice here
    expect((window as unknown as Record<string, unknown>).__openclawTerminalTouchFixV6).toBe(true);
  });
});
