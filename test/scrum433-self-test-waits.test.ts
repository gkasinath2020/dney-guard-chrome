// @vitest-environment jsdom
// SCRUM-433: the adapter self-test ran once at DOMContentLoaded, before claude.ai
// and ChatGPT mount their React composer, so every healthy page load logged
// "composer NOT found". It now watches until the composer appears (cap 15 s).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMPOSER_WAIT_MS, waitForComposer } from "../src/lib/composer-wait";

vi.mock("../src/content/adapters", async (orig) => {
  const real = await orig<typeof import("../src/content/adapters")>();
  return { ...real, getAdapter: () => real.claudeAdapter };
});

const WARNING = "[DNey Guard] adapter self-test: composer NOT found — adapter may be out of date";

function mountComposer(): void {
  const el = document.createElement("div");
  el.setAttribute("contenteditable", "true");
  el.className = "ProseMirror";
  document.body.append(el);
}

describe("page-hook self-test waits for the composer", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    document.body.replaceChildren();
    delete (window as any).__dneyGuardInstalled;
    warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await import("../src/content/page-hook"); // document is already loaded: the self-test starts now
  });
  afterEach(() => {
    warn.mockRestore();
    vi.useRealTimers();
  });

  it("composer mounted 3 s after load: no warning, ever", async () => {
    await vi.advanceTimersByTimeAsync(3000);
    mountComposer();
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS * 2);
    expect(warn).not.toHaveBeenCalledWith(WARNING);
  });

  it("composer never appears: exactly one warning, at the cap and not before", async () => {
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS - 1);
    expect(warn).not.toHaveBeenCalledWith(WARNING);
    await vi.advanceTimersByTimeAsync(1);
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS * 2);
    expect(warn.mock.calls.filter((c) => c[0] === WARNING)).toHaveLength(1);
  });
});

describe("waitForComposer", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.replaceChildren();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  const found = () => !!document.querySelector("#composer");
  const mount = () => {
    const el = document.createElement("div");
    el.id = "composer";
    document.body.append(el);
  };

  it("disconnects the observer and clears the cap once the composer appears", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const onMissing = vi.fn();
    const probe = vi.fn(found);
    waitForComposer(document, probe, onMissing);
    await vi.advanceTimersByTimeAsync(2000);
    mount();
    await vi.advanceTimersByTimeAsync(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    const probesAtSuccess = probe.mock.calls.length;
    document.body.append(document.createElement("p")); // later mutations are not observed
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS);
    expect(probe.mock.calls.length).toBe(probesAtSuccess);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("composer already present: no observer, no timer", () => {
    mount();
    const observe = vi.spyOn(MutationObserver.prototype, "observe");
    waitForComposer(document, found, vi.fn());
    expect(observe).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("never appears: onMissing once at the cap, then stops observing", async () => {
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const onMissing = vi.fn();
    waitForComposer(document, found, onMissing);
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS);
    expect(onMissing).toHaveBeenCalledTimes(1);
    expect(disconnect).toHaveBeenCalledTimes(1);
    mount();
    await vi.advanceTimersByTimeAsync(COMPOSER_WAIT_MS);
    expect(onMissing).toHaveBeenCalledTimes(1);
  });
});
