/* @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import {
  resetTerminalAndroidImeFixForTests,
  installTerminalAndroidImeFix,
} from "./terminal-android-ime.ts";

function setCoarsePointer(coarse: boolean): void {
  Object.defineProperty(navigator, "maxTouchPoints", {
    value: coarse ? 5 : 0,
    configurable: true,
  });
  window.matchMedia = ((query: string) =>
    ({
      matches: coarse && /pointer:\s*coarse/.test(query),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    }) as unknown as MediaQueryList) as typeof window.matchMedia;
}

/** Builds the shipped DOM shape: open shadow root, container owning canvas + textarea. */
function buildGhosttyHost(): {
  host: HTMLElement;
  container: HTMLDivElement;
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
  // Reproduce ghostty-web 0.4.0's actual Terminal.open(A) behavior, which
  // is the root cause this shim works around: it cancels every beforeinput
  // on the container unconditionally. The shim's isBugPresent() probe
  // depends on exactly this being present to decide whether to forward.
  container.addEventListener("beforeinput", (e) => e.preventDefault());
  return { host, container, textarea };
}

describe("installTerminalAndroidImeFix", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    // These tests mutate the real global navigator/window; this repo's
    // vitest pool runs with isolate:false, so an un-reset stub here would
    // leak into whichever unrelated test file's jsdom environment happens
    // to run next in the same worker (including files that call
    // createIsolatedGhosttyTerminal and would otherwise unexpectedly get a
    // "coarse pointer" environment).
    Object.defineProperty(navigator, "maxTouchPoints", { value: 0, configurable: true });
    delete (window as unknown as Record<string, unknown>).matchMedia;
    resetTerminalAndroidImeFixForTests();
  });

  it("no-ops on a non-touch device", () => {
    setCoarsePointer(false);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    let forwarded: CompositionEvent | undefined;
    container.addEventListener("compositionend", (e) => {
      forwarded = e as CompositionEvent;
    });

    // keydown 229 then beforeinput, exactly the measured Android sequence.
    const keydown = new KeyboardEvent("keydown", {
      keyCode: 229,
      bubbles: true,
      composed: true,
    } as unknown as KeyboardEventInit);
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);
    const beforeinput = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "k",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    container.dispatchEvent(beforeinput);

    expect(forwarded).toBeUndefined();
  });

  it("forwards a committed insertText beforeinput as compositionend on the ghostty container", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    let forwarded: CompositionEvent | undefined;
    container.addEventListener("compositionend", (e) => {
      forwarded = e as CompositionEvent;
    });

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);

    const beforeinput = new InputEvent("beforeinput", {
      inputType: "insertText",
      data: "k",
      bubbles: true,
      composed: true,
      cancelable: true,
    });
    container.dispatchEvent(beforeinput);

    expect(forwarded?.data).toBe("k");
  });

  it("maps insertParagraph to a carriage return and deleteContentBackward to DEL", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);

    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertParagraph",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );
    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "deleteContentBackward",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual(["\r", "\x7f"]);
  });

  it("does not forward while not in an IME-active window (single physical keydown, no 229)", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    // A plain single-character keydown (physical keyboard path) clears imeActive.
    const keydown = new KeyboardEvent("keydown", { key: "k", bubbles: true, composed: true });
    document.dispatchEvent(keydown);
    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "k",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual([]);
  });

  it("ignores interim composition input types (insertCompositionText)", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);
    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertCompositionText",
        data: "partial",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual([]);
  });

  it("finds the container through an open shadow root via composedPath", () => {
    setCoarsePointer(true);
    const { container, textarea } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    let forwarded: CompositionEvent | undefined;
    container.addEventListener("compositionend", (e) => (forwarded = e as CompositionEvent));

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);

    // Dispatch on the textarea itself (as the real browser does), not the container.
    textarea.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "z",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded?.data).toBe("z");
  });

  it("is idempotent: installing twice registers only one set of listeners", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);
    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "k",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual(["k"]);
  });

  it("isBugPresent() false path: does not forward once ghostty stops cancelling beforeinput", () => {
    setCoarsePointer(true);
    // A container that behaves like a FIXED ghostty (does not call
    // preventDefault on beforeinput) -- built without buildGhosttyHost's
    // simulated bug, to exercise the probe's negative branch.
    const host = document.createElement("openclaw-terminal-panel");
    document.body.appendChild(host);
    const root = host.attachShadow({ mode: "open" });
    const container = document.createElement("div");
    const canvas = document.createElement("canvas");
    const textarea = document.createElement("textarea");
    container.appendChild(canvas);
    container.appendChild(textarea);
    root.appendChild(container);
    // No beforeinput listener here at all: ghostty "fixed upstream" never
    // cancels, so the probe's `defaultPrevented` comes back false.

    installTerminalAndroidImeFix();
    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    const keydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(keydown, "keyCode", { value: 229 });
    document.dispatchEvent(keydown);
    textarea.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "k",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual([]);
  });

  it("compositionstart alone (no prior 229 keydown) activates forwarding", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    document.dispatchEvent(new Event("compositionstart", { bubbles: true, composed: true }));
    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "k",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual(["k"]);
  });

  it("a single-character physical keydown after 229 deactivates forwarding again", () => {
    setCoarsePointer(true);
    const { container } = buildGhosttyHost();
    installTerminalAndroidImeFix();

    const forwarded: string[] = [];
    container.addEventListener("compositionend", (e) =>
      forwarded.push((e as CompositionEvent).data),
    );

    const imeKeydown = new KeyboardEvent("keydown", { bubbles: true, composed: true });
    Object.defineProperty(imeKeydown, "keyCode", { value: 229 });
    document.dispatchEvent(imeKeydown);
    // A plain single-character key (the physical-keyboard path) turns
    // imeActive back off.
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true, composed: true }),
    );

    container.dispatchEvent(
      new InputEvent("beforeinput", {
        inputType: "insertText",
        data: "k",
        bubbles: true,
        composed: true,
        cancelable: true,
      }),
    );

    expect(forwarded).toEqual([]);
  });

  it("uses the same window flag name as the shipped shim, so a coexisting legacy copy would defer to it", () => {
    setCoarsePointer(true);
    buildGhosttyHost();
    installTerminalAndroidImeFix();
    // oxlint-disable-next-line no-underscore-dangle -- asserting the shipped shim's literal flag name, not a naming choice here
    expect((window as unknown as Record<string, unknown>).__openclawTerminalImeShimV4).toBe(true);
  });
});
