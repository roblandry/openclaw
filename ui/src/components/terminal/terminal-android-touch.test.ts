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
});
