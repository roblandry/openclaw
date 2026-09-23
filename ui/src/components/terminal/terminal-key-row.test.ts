/* @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyLatches,
  installTerminalKeyRow,
  resetTerminalKeyRowForTests,
} from "./terminal-key-row.ts";

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

/** Builds the shipped DOM shape: open shadow root, container owning canvas + textarea. */
function buildGhosttyHost(): {
  host: HTMLElement;
  root: ShadowRoot;
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
  return { host, root, container, textarea };
}

function overlay(): HTMLElement {
  const el = document.getElementById("openclaw-terminal-key-row");
  if (!el) {
    throw new Error("overlay not found");
  }
  return el;
}

function snapshotStyleAndAttrs(el: Element): {
  attrs: Record<string, string>;
  styles: Record<string, string>;
} {
  const attrs: Record<string, string> = {};
  for (const a of Array.from(el.attributes)) {
    attrs[a.name] = a.value;
  }
  const styles: Record<string, string> = {};
  const s = (el as HTMLElement).style;
  for (let i = 0; i < s.length; i++) {
    const name = s.item(i);
    styles[name] = s.getPropertyValue(name);
  }
  return { attrs, styles };
}

describe("applyLatches", () => {
  it("Ctrl folds a lowercase letter to its control code", () => {
    expect(applyLatches("c", { ctrl: true, alt: false })).toBe("\x03");
  });
  it("Ctrl folds an uppercase letter the same way", () => {
    expect(applyLatches("C", { ctrl: true, alt: false })).toBe("\x03");
  });
  it("Ctrl+space sends NUL", () => {
    expect(applyLatches(" ", { ctrl: true, alt: false })).toBe("\x00");
  });
  it("Ctrl on a non-transformable multi-char string passes through unmodified", () => {
    expect(applyLatches("\x1b[A", { ctrl: true, alt: false })).toBe("\x1b[A");
  });
  it("Alt prefixes ESC ahead of the data", () => {
    expect(applyLatches("x", { ctrl: false, alt: true })).toBe("\x1bx");
  });
  it("Ctrl+Alt combines both transforms", () => {
    expect(applyLatches("c", { ctrl: true, alt: true })).toBe("\x1b\x03");
  });
  it("no modifiers passes data through unmodified", () => {
    expect(applyLatches("q", { ctrl: false, alt: false })).toBe("q");
  });
});

describe("installTerminalKeyRow", () => {
  afterEach(() => {
    resetTerminalKeyRowForTests();
    document.body.innerHTML = "";
  });

  it("no-ops on a non-touch device: no overlay is inserted", () => {
    setCoarsePointer(false);
    installTerminalKeyRow();
    expect(document.getElementById("openclaw-terminal-key-row")).toBeNull();
  });

  it("installs the overlay as a shadow-rooted direct child of document.body, isolated from the terminal subtree", () => {
    setCoarsePointer(true);
    const { host, container } = buildGhosttyHost();
    const hostBefore = snapshotStyleAndAttrs(host);
    const containerBefore = snapshotStyleAndAttrs(container);
    const bodyChildrenBefore = document.body.children.length;

    installTerminalKeyRow();

    const bar = overlay();
    expect(bar.parentNode).toBe(document.body);
    expect(bar.shadowRoot).not.toBeNull();
    expect(document.body.children.length).toBe(bodyChildrenBefore + 1);

    // Zero-diff invariant: this is the exact regression (PR #1021/#1022,
    // reverted) this port must never reintroduce. The row must never mutate
    // the panel host or the ghostty container's attributes or inline style.
    expect(snapshotStyleAndAttrs(host)).toEqual(hostBefore);
    expect(snapshotStyleAndAttrs(container)).toEqual(containerBefore);
  });

  it("dispatches no synthetic window resize during install", () => {
    setCoarsePointer(true);
    buildGhosttyHost();
    let resizeCount = 0;
    window.addEventListener("resize", () => {
      resizeCount += 1;
    });

    installTerminalKeyRow();

    expect(resizeCount).toBe(0);
  });

  it("becomes visible when the ghostty textarea is focused (shadow-root-scoped focusin)", () => {
    setCoarsePointer(true);
    const { textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    expect(overlay().getAttribute("data-visible")).toBe("0");

    textarea.focus();
    // The wiring happens via a scan the touchstart/pointerdown path or the
    // initial scanFrom(document) call in attach() performs synchronously.
    expect(overlay().getAttribute("data-visible")).toBe("1");
  });

  it("hides again after focusout (deferred by one task)", async () => {
    setCoarsePointer(true);
    const { textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();
    expect(overlay().getAttribute("data-visible")).toBe("1");

    textarea.blur();
    // focusout handling is deferred via setTimeout(update, 0).
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(overlay().getAttribute("data-visible")).toBe("0");
  });

  it("rediscovers a ghostty container added after install, via touchstart", () => {
    setCoarsePointer(true);
    installTerminalKeyRow();
    expect(overlay().getAttribute("data-visible")).toBe("0");

    const { textarea } = buildGhosttyHost();
    // touchstart is a composed event that crosses the shadow boundary and
    // reaches document, triggering rediscovery even though a
    // MutationObserver does not see inside shadow roots.
    document.dispatchEvent(new Event("touchstart", { bubbles: true, composed: true }));
    textarea.focus();

    expect(overlay().getAttribute("data-visible")).toBe("1");
  });

  it("tapping ESC sends the ESC byte via compositionend on the container", () => {
    setCoarsePointer(true);
    const { container, textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();

    const written: string[] = [];
    container.addEventListener("compositionend", (e) => written.push((e as CompositionEvent).data));

    overlay().shadowRoot?.querySelector<HTMLButtonElement>("button")?.click();

    expect(written).toEqual(["\x1b"]);
  });

  it("ARROW keys try ghostty's own keydown encoder first, and fall back to compositionend if ghostty does not acknowledge", () => {
    setCoarsePointer(true);
    const { container, textarea } = buildGhosttyHost();
    // Simulate ghostty acknowledging (defaultPrevented after its own handler runs).
    container.addEventListener("keydown", (e) => e.preventDefault());
    installTerminalKeyRow();
    textarea.focus();

    const written: string[] = [];
    container.addEventListener("compositionend", (e) => written.push((e as CompositionEvent).data));
    const keydownsOnTextarea: string[] = [];
    textarea.addEventListener("keydown", (e) => keydownsOnTextarea.push((e as KeyboardEvent).code));

    const upButton = Array.from(overlay().shadowRoot?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "↑",
    );
    upButton?.click();

    expect(keydownsOnTextarea).toEqual(["ArrowUp"]);
    expect(written).toEqual([]); // ghostty acknowledged; no compositionend fallback needed
  });

  it("ARROW keys fall back to a literal CSI sequence when ghostty never acknowledges", () => {
    setCoarsePointer(true);
    const { container, textarea } = buildGhosttyHost();
    // No listener prevents default: ghostty "does not acknowledge".
    installTerminalKeyRow();
    textarea.focus();

    const written: string[] = [];
    container.addEventListener("compositionend", (e) => written.push((e as CompositionEvent).data));

    const upButton = Array.from(overlay().shadowRoot?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "↑",
    );
    upButton?.click();

    expect(written).toEqual(["", "\x1b[A"]); // endComposition() resets ghostty's composition latch before the retry, then the literal fallback is written
  });

  it("Ctrl arms on tap, transforms the next compositionend-forwarded character, then disarms", () => {
    setCoarsePointer(true);
    const { container, textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();

    const ctrlButton = Array.from(overlay().shadowRoot?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "CTRL",
    ) as HTMLButtonElement;
    ctrlButton.click();
    expect(ctrlButton.getAttribute("data-on")).toBe("1");

    // Simulate the sibling IME shim forwarding a committed character via the
    // exact same non-composed compositionend contract.
    const written: string[] = [];
    container.addEventListener("compositionend", (e) => written.push((e as CompositionEvent).data));
    container.dispatchEvent(
      new CompositionEvent("compositionend", { data: "c", bubbles: false, cancelable: false }),
    );

    // onCompositionEnd runs in the CAPTURE phase on the container's shadow
    // root (an ancestor) and calls stopPropagation() once it transforms the
    // data, so the original untransformed "c" never reaches a listener
    // registered directly on the container itself -- only the
    // writeTo()-dispatched transformed event does.
    expect(written).toEqual(["\x03"]);
    expect(ctrlButton.getAttribute("data-on")).toBe("0");
  });

  it("tapping CTRL twice disarms it without transforming anything", () => {
    setCoarsePointer(true);
    const { textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();

    const ctrlButton = Array.from(overlay().shadowRoot?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "CTRL",
    ) as HTMLButtonElement;
    ctrlButton.click();
    ctrlButton.click();
    expect(ctrlButton.getAttribute("data-on")).toBe("0");
  });

  it("the dismiss button blurs the focused ghostty textarea", () => {
    setCoarsePointer(true);
    const { textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();
    expect(document.activeElement).not.toBeNull();

    const dismissButton = Array.from(overlay().shadowRoot?.querySelectorAll("button") ?? []).find(
      (b) => b.textContent === "⌨",
    ) as HTMLButtonElement;
    const blurSpy = vi.spyOn(textarea, "blur");
    dismissButton.click();

    expect(blurSpy).toHaveBeenCalled();
  });

  it("button pointerdown/mousedown preventDefault so tapping a key does not blur the textarea", () => {
    setCoarsePointer(true);
    const { textarea } = buildGhosttyHost();
    installTerminalKeyRow();
    textarea.focus();

    const escButton = overlay().shadowRoot?.querySelector<HTMLButtonElement>("button");
    const pointerdown = new Event("pointerdown", { bubbles: true, cancelable: true });
    escButton?.dispatchEvent(pointerdown);
    expect(pointerdown.defaultPrevented).toBe(true);
  });

  it("is idempotent: installing twice does not add a second overlay", () => {
    setCoarsePointer(true);
    buildGhosttyHost();
    installTerminalKeyRow();
    installTerminalKeyRow();
    expect(document.querySelectorAll("#openclaw-terminal-key-row").length).toBe(1);
  });
});
