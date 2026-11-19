// SCRUM-395/396 through the real service worker module: the welcome tab is never
// opened on install or update, and onboarding messages are answered only for the
// extension's own pages (never a content script on claude.ai / chatgpt.com).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installFakeChrome, removeFakeChrome } from "./helpers/onboarding-env";
import type { FakeChrome } from "./helpers/onboarding-env";

let fake: FakeChrome;
let listeners: Record<string, ((...a: unknown[]) => unknown)[]>;

beforeEach(async () => {
  vi.resetModules();
  fake = installFakeChrome();
  listeners = (fake.chrome as { _listeners: typeof listeners })._listeners;
  vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("no network in this test"); }));
  await import("../src/background");
});
afterEach(() => {
  vi.unstubAllGlobals();
  removeFakeChrome();
});

function message(msg: unknown, sender: unknown): Promise<unknown> {
  return new Promise((resolve) => {
    const keepOpen = listeners.onMessage[0](msg, sender, resolve);
    if (!keepOpen) setTimeout(() => resolve("__sync__"), 0);
  });
}

const POPUP = { id: "ext-id", url: "chrome-extension://ext-id/ui/popup.html" };

describe("welcome tab: not on install, not on update", () => {
  it.each(["install", "update", "chrome_update"])("onInstalled(%s) opens no tab", async (reason) => {
    for (const l of listeners.onInstalled) await l({ reason });
    expect(fake.tabsCreated).toEqual([]);
    expect(fake.areas.local).toEqual({});
  });
});

describe("onboarding messages: extension pages only", () => {
  it.each([
    ["a content script on claude.ai", { id: "ext-id", url: "https://claude.ai/new", tab: { id: 7 } }],
    ["a content script on chatgpt.com", { id: "ext-id", url: "https://chatgpt.com/", tab: { id: 8 } }],
    ["another extension", { id: "other-ext", url: "chrome-extension://other-ext/x.html" }],
    ["no sender url", { id: "ext-id" }],
  ])("dney-signup from %s is refused before any request", async (_n, sender) => {
    const res = await message({ type: "dney-signup", email: "a@b.co", password: "correct-horse-1" }, sender);
    expect(res).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dney-try-check from a content script is refused", async () => {
    expect(await message({ type: "dney-try-check", text: "x" }, { id: "ext-id", url: "https://claude.ai/", tab: { id: 1 } })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("from the popup, a signup is attempted (and a network failure answers 'unavailable')", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const res = await message({ type: "dney-signup", email: "a@b.co", password: "correct-horse-1" }, POPUP);
    expect(res).toEqual({ ok: false, error: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
