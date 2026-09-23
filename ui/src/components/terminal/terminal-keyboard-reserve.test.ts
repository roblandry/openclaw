/* @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resetTerminalKeyboardReserveForTests,
  installTerminalKeyboardReserve,
} from "./terminal-keyboard-reserve.ts";

function setCoarsePointer(coarse: boolean): void {
  Object.defineProperty(navigator, "maxTouchPoints", { value: coarse ? 5 : 0, configurable: true });
  window.matchMedia = ((query: string) =>
    ({
      matches: coarse && /pointer:\s*coarse/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

type FakeVisualViewport = {
  height: number;
  offsetTop: number;
  scale: number;
  addEventListener: (type: string, fn: () => void) => void;
  removeEventListener: (type: string, fn: () => void) => void;
  trigger: (type: string) => void;
};

function stubVisualViewport(height: number, offsetTop = 0, scale = 1): FakeVisualViewport {
  const listeners: Record<string, Array<() => void>> = {};
  const vv: FakeVisualViewport = {
    height,
    offsetTop,
    scale,
    addEventListener(type, fn) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type, fn) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
    trigger(type) {
      for (const fn of listeners[type] ?? []) {
        fn();
      }
    },
  };
  Object.defineProperty(window, "visualViewport", { value: vv, configurable: true });
  return vv;
}

function buildGhosttyContainer(): { container: HTMLDivElement; textarea: HTMLTextAreaElement } {
  const container = document.createElement("div");
  const canvas = document.createElement("canvas");
  const textarea = document.createElement("textarea");
  container.appendChild(canvas);
  container.appendChild(textarea);
  document.body.appendChild(container);
  return { container, textarea };
}

async function flushRaf(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe("installTerminalKeyboardReserve", () => {
  beforeEach(() => {
    Object.defineProperty(window, "innerHeight", {
      value: 800,
      configurable: true,
      writable: true,
    });
  });

  afterEach(() => {
    document.body.innerHTML = "";
    resetTerminalKeyboardReserveForTests();
  });

  it("no-ops on a non-touch device", async () => {
    setCoarsePointer(false);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(363);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("");
  });

  it("Fold6 measured case: innerHeight 676, vv.height 363, offsetTop 0 -> 313px reserve", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(363, 0, 1);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("313px");
  });

  it("keyboard closed (vv.height == innerHeight): no padding", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(800, 0, 1);

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("");
  });

  it("pinch-zoom guard: scale 2 with a large apparent gap applies no padding", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(457.5, 0, 2);
    Object.defineProperty(window, "innerHeight", { value: 915, configurable: true });

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("");
  });

  it("adds the visible key row's height on top of the keyboard inset", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(363, 0, 1);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    const keyRow = document.createElement("openclaw-terminal-key-row");
    keyRow.setAttribute("data-visible", "1");
    Object.defineProperty(keyRow, "getBoundingClientRect", {
      value: () => ({ height: 44 }) as DOMRect,
    });
    document.body.appendChild(keyRow);

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("357px"); // 313 + 44
    expect((keyRow as HTMLElement).style.bottom).toBe("313px");
  });

  it("ignores an invisible (data-visible=0) key row's height", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(363, 0, 1);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    const keyRow = document.createElement("openclaw-terminal-key-row");
    keyRow.setAttribute("data-visible", "0");
    Object.defineProperty(keyRow, "getBoundingClientRect", {
      value: () => ({ height: 44 }) as DOMRect,
    });
    document.body.appendChild(keyRow);

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("313px");
  });

  it("responds to a visualViewport resize (keyboard closing)", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });
    const vv = stubVisualViewport(363, 0, 1);

    installTerminalKeyboardReserve();
    await flushRaf();
    expect(container.style.paddingBottom).toBe("313px");

    vv.height = 676; // keyboard gone
    vv.trigger("resize");
    await flushRaf();

    expect(container.style.paddingBottom).toBe("");
  });

  it("descends into open shadow roots to find containers", async () => {
    setCoarsePointer(true);
    stubVisualViewport(363, 0, 1);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    const canvas = document.createElement("canvas");
    const textarea = document.createElement("textarea");
    container.appendChild(canvas);
    container.appendChild(textarea);
    root.appendChild(container);

    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("313px");
  });

  it("is idempotent: installing twice does not double-register listeners", async () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyContainer();
    stubVisualViewport(363, 0, 1);
    Object.defineProperty(window, "innerHeight", { value: 676, configurable: true });

    installTerminalKeyboardReserve();
    installTerminalKeyboardReserve();
    await flushRaf();

    expect(container.style.paddingBottom).toBe("313px");
  });
});
