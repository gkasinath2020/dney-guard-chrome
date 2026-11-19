// @vitest-environment jsdom
// SCRUM-480: Sign out. A signed-in consumer popup shows "Sign out" and NO sign-in
// or sign-up link (GK); a managed popup shows neither. Sign out is confirmed
// inline (never a browser dialog), clears the worker's audit log and badge,
// removes api_key + api_key_id (keeps welcome_opened), and re-mounts in signup
// mode with a one-time notice naming the old key's first 10 characters. The popup
// side runs against the real config readers over an in-memory chrome.storage.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigState, mergeConfig, readLocal } from "../src/lib/config";
import type { ConfigState } from "../src/lib/config";
import type { SigninOutcome } from "../src/lib/signin";
import { COPY } from "../src/ui/onboarding-copy";
import { KEY_PREFIX_LENGTH, mountPopup, renderStatus } from "../src/ui/popup-view";
import type { PopupDeps } from "../src/ui/popup-view";
import pinned from "./fixtures/scrum392/onboarding_copy_pinned.json";
import { installFakeChrome, removeFakeChrome } from "./helpers/onboarding-env";
import type { FakeChrome } from "./helpers/onboarding-env";

const P = pinned.copy as Record<string, string>;
const KEY = "asg_9f8e7d6c5b4a3210_rest_of_the_secret";
const KEY_ID = "33333333-3333-4333-8333-333333333333";
const PREFIX = "asg_9f8e7d"; // KEY[:10], as the dashboard shows it

const flush = () => new Promise((r) => setTimeout(r, 0));
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

function newRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root")!;
}

/** Any element a user could take as a way to sign in or create an account. */
const SIGN_IN_OR_UP = /sign\s*in|sign\s*up|create (a )?(free )?account|log\s*in/i;
function signInOrUpControls(root: HTMLElement): string[] {
  return [...root.querySelectorAll("a, button")].map((e) => e.textContent ?? "").filter((t) => SIGN_IN_OR_UP.test(t));
}

/** Remove each pinned string once per occurrence; what is left is unpinned text. */
function unpinnedRest(text: string, strings: string[]): string {
  let rest = norm(text);
  for (const s of [...strings].sort((a, b) => b.length - a.length)) rest = rest.split(norm(s)).join(" ");
  return rest.replace(/[\s:]+/g, " ").trim();
}

const consumerWithKey: ConfigState = { config: mergeConfig({}, null, { api_key: KEY }), managed: false, managedReadFailed: false };
const managedState: ConfigState = { config: mergeConfig({ api_key: "school-key" }, null), managed: true, managedReadFailed: false };

function plainDeps(state: ConfigState, send: PopupDeps["send"] = vi.fn(async () => [])): PopupDeps {
  return { loadState: async () => state, send, removeLocal: vi.fn(async () => {}), openOptions: vi.fn(), download: vi.fn() };
}

let fake: FakeChrome | undefined;
afterEach(() => {
  vi.restoreAllMocks();
  if (fake) removeFakeChrome();
  fake = undefined;
});

/** The popup wired as popup.ts wires it, over an in-memory chrome.storage. */
function chromePopupDeps(local: Record<string, unknown>, sync: Record<string, unknown> = {}) {
  fake = installFakeChrome({ local, sync });
  const c = fake.chrome as any;
  const send = vi.fn(async (m: unknown) => ((m as { type: string }).type === "dney-audit-recent" ? [] : true));
  const deps: PopupDeps = {
    loadState: loadConfigState,
    readLocal,
    removeLocal: (keys) => c.storage.local.remove(keys),
    removeSync: (keys) => c.storage.sync.remove(keys),
    send,
    openOptions: vi.fn(),
    download: vi.fn(),
  };
  return { deps, send, c };
}

describe("popup: per state, present / absent", () => {
  it("consumer signed in: Sign out present; no sign-in link, no 'Sign in' text, no 'Create a free account'", async () => {
    const root = newRoot();
    expect(await mountPopup(root, plainDeps(consumerWithKey))).toBe("status");
    const out = root.querySelector("#status-sign-out") as HTMLButtonElement;
    expect(out).not.toBeNull();
    expect(out.tagName).toBe("BUTTON");
    expect(out.textContent).toBe(P["status.signout_button"]);
    expect(out.textContent).toBe("Sign out");
    expect(root.querySelector("#status-sign-in")).toBeNull();
    expect(root.textContent).not.toMatch(/Sign in/);
    expect(root.textContent).not.toContain("Create a free account");
    expect(root.textContent).not.toContain(P["S2.under_form_link"]);
    expect(signInOrUpControls(root)).toEqual([]);
  });

  it("consumer right after a popup sign-in (status view with S7): the same", () => {
    const root = newRoot();
    const ok = { ok: true, org_name: "Acme", protections: "enforce" } as Extract<SigninOutcome, { ok: true }>;
    renderStatus(root, consumerWithKey, plainDeps(consumerWithKey), ok);
    expect(root.querySelector("#status-sign-out")).not.toBeNull();
    expect(root.querySelector("#status-sign-in")).toBeNull();
    expect(signInOrUpControls(root)).toEqual([]);
  });

  it("managed: neither Sign out nor any sign-in", async () => {
    for (const st of [
      managedState,
      { config: mergeConfig({ fail_policy: "closed" }, null), managed: true, managedReadFailed: false },
      { config: mergeConfig({}, null), managed: true, managedReadFailed: true },
    ] as ConfigState[]) {
      const root = newRoot();
      expect(await mountPopup(root, plainDeps(st))).toBe("status");
      expect(root.querySelector("#status-sign-out")).toBeNull();
      expect(root.querySelector("#status-sign-in")).toBeNull();
      expect(root.textContent).not.toContain("Sign out");
      expect(root.textContent).not.toMatch(/Sign in/);
      expect(signInOrUpControls(root)).toEqual([]);
    }
  });

  it("status.signin_link is gone from the copy (no stale string to render)", () => {
    expect("status.signin_link" in COPY).toBe(false);
    expect("status.signin_link" in P).toBe(false);
  });
});

describe("popup: Sign out flow", () => {
  async function toConfirm(local: Record<string, unknown>, sync: Record<string, unknown> = {}) {
    const env = chromePopupDeps(local, sync);
    const root = newRoot();
    expect(await mountPopup(root, env.deps)).toBe("status");
    await flush();
    env.send.mockClear();
    (root.querySelector("#status-sign-out") as HTMLButtonElement).click();
    return { root, ...env };
  }

  it("Sign out asks INLINE (no browser dialog): the pinned text and two buttons", async () => {
    const confirmSpy = vi.spyOn(window, "confirm");
    const { root, send } = await toConfirm({ api_key: KEY, api_key_id: KEY_ID, welcome_opened: true });
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(root.querySelector("#signout-confirm-text")!.textContent).toBe(P["status.signout_confirm"]);
    expect(root.querySelector("#signout-yes")!.textContent).toBe(P["status.signout_confirm_yes"]);
    expect(root.querySelector("#signout-cancel")!.textContent).toBe(P["status.signout_confirm_cancel"]);
    expect([...root.querySelectorAll("#signout-confirm button")].map((b) => b.textContent)).toEqual(["Sign out", "Cancel"]);
    // the status view's actions give way to the confirm; nothing sent yet
    expect(root.querySelector("#status-sign-out")).toBeNull();
    expect(root.querySelector("#mode")).not.toBeNull();
    expect(send).not.toHaveBeenCalled();
  });

  it("Cancel: storage untouched, nothing sent, the status view back as it was", async () => {
    const local = { api_key: KEY, api_key_id: KEY_ID, welcome_opened: true };
    const { root, send, c } = await toConfirm({ ...local });
    (root.querySelector("#signout-cancel") as HTMLButtonElement).click();
    await flush();
    expect(fake!.areas.local).toEqual(local);
    expect(c.storage.local.remove).not.toHaveBeenCalled();
    expect(c.storage.local.set).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(root.querySelector("#signout-confirm")).toBeNull();
    const actions = root.querySelector(".actions")!;
    expect([...actions.children].map((x) => x.id)).toEqual(["export", "options", "dashboard", "status-sign-out"]);
    // and it still works afterwards
    (root.querySelector("#status-sign-out") as HTMLButtonElement).click();
    expect(root.querySelector("#signout-confirm")).not.toBeNull();
  });

  it("confirm: removes api_key + api_key_id, keeps welcome_opened, clears the audit log, re-mounts in signup with the notice", async () => {
    const { root, send, c } = await toConfirm({ api_key: KEY, api_key_id: KEY_ID, welcome_opened: true });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(fake!.areas.local).toEqual({ welcome_opened: true });
    expect(c.storage.local.remove).toHaveBeenCalledWith(["api_key", "api_key_id"]);
    expect(send).toHaveBeenCalledWith({ type: "dney-audit-clear" });
    // signup mode
    expect(root.querySelector("form")!.id).toBe("signup");
    // the notice, first, with exactly the first 10 characters of the old key
    const notice = root.querySelector("#signed-out-notice")!;
    expect(root.firstElementChild).toBe(notice);
    expect(KEY_PREFIX_LENGTH).toBe(10);
    expect(KEY.slice(0, 10)).toBe(PREFIX);
    expect(notice.textContent).toBe(P["status.signed_out_notice"].replace("{prefix}", PREFIX));
    expect(notice.textContent).toContain(`starts with ${PREFIX}.`);
    expect(notice.textContent).not.toContain(KEY.slice(0, 11));
    expect(notice.textContent).not.toContain("{prefix}");
    // the prefix is never stored anywhere
    const written = JSON.stringify(["managed", "sync", "local", "session"].map((a) => c.storage[a].set.mock.calls));
    expect(written).not.toContain(PREFIX);
  });

  it("Assay #458: a 0.2.0 api_key left in chrome.storage.sync does not sign the user back in", async () => {
    const { root, c } = await toConfirm({ api_key: KEY, api_key_id: KEY_ID }, { api_key: "asg_SYNCED_OLD_KEY_0123" });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(c.storage.sync.remove).toHaveBeenCalledWith(["api_key"]);
    expect(fake!.areas.sync.api_key).toBeUndefined();
    expect(root.querySelector("form")!.id).toBe("signup");
    // reopening the popup runs the real migrate-then-read path: still signed out
    const again = newRoot();
    expect(await mountPopup(again, (chromePopupDeps({ ...fake!.areas.local }, { ...fake!.areas.sync })).deps)).toBe("signup");
  });

  it("Assay #458: no readable key means no prefix clause (never 'starts with .')", async () => {
    const env = chromePopupDeps({});
    const root = newRoot();
    expect(await mountPopup(root, env.deps, { signedOutPrefix: "" })).toBe("signup");
    const text = root.querySelector("#signed-out-notice")!.textContent!;
    expect(text).not.toContain("starts with");
    expect(text).toBe(P["status.signed_out_notice_noprefix"]);
    expect(text).toContain("may still work");
  });

  it("the signed-out view: notice + the pinned signup copy, nothing else", async () => {
    const { root } = await toConfirm({ api_key: KEY, welcome_opened: true });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    const shown = [
      P["status.signed_out_notice"].replace("{prefix}", PREFIX),
      ...["B1.heading", "B2.title", "B2.intro", "B2.label_email", "B2.label_password", "B2.password_hint", "B2.button", "B2.terms_notice", "B2.under_button", "B2.footer", "B2.footer_link", "S1.use_key_link"].map((i) => P[i]),
    ];
    expect(unpinnedRest(root.textContent ?? "", shown)).toBe("");
  });

  it("a key with no stored id (pasted in Settings) signs out the same way", async () => {
    const { root, c } = await toConfirm({ api_key: KEY });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(fake!.areas.local).toEqual({});
    expect(c.storage.local.remove).toHaveBeenCalledWith(["api_key", "api_key_id"]);
    expect(root.querySelector("#signed-out-notice")!.textContent).toContain(PREFIX);
  });

  it("the notice is one-time: reopening the popup shows the plain signup view", async () => {
    const { root, deps } = await toConfirm({ api_key: KEY, welcome_opened: true });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    const again = newRoot();
    expect(await mountPopup(again, deps)).toBe("signup");
    expect(again.querySelector("#signed-out-notice")).toBeNull();
  });

  it("the storage remove fails: the status view comes back, and no notice claims a sign-out", async () => {
    const { root, c } = await toConfirm({ api_key: KEY, welcome_opened: true });
    c.storage.local.remove.mockImplementationOnce(async () => {
      throw new Error("quota");
    });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(root.querySelector("#signed-out-notice")).toBeNull();
    expect(root.querySelector("#status-sign-out")).not.toBeNull();
  });

  it("the worker not answering dney-audit-clear does not stop the sign-out", async () => {
    const { root, send } = await toConfirm({ api_key: KEY, welcome_opened: true });
    send.mockImplementation(async () => {
      throw new Error("worker gone");
    });
    (root.querySelector("#signout-yes") as HTMLButtonElement).click();
    await flush();
    await flush();
    expect(fake!.areas.local).toEqual({ welcome_opened: true });
    expect(root.querySelector("#signed-out-notice")).not.toBeNull();
  });
});

describe("worker: dney-audit-clear", () => {
  const POPUP = { id: "ext-id", url: "chrome-extension://ext-id/ui/popup.html" };
  let listeners: Record<string, ((...a: unknown[]) => unknown)[]>;

  async function loadWorker() {
    vi.resetModules();
    fake = installFakeChrome();
    listeners = (fake.chrome as { _listeners: typeof listeners })._listeners;
    await import("../src/background");
  }
  function message(msg: unknown, sender: unknown): Promise<unknown> {
    return new Promise((resolve) => {
      listeners.onMessage[0](msg, sender, resolve);
    });
  }
  async function addEvents(n: number) {
    for (let i = 0; i < n; i++) await message({ type: "dney-unchecked", direction: "input" }, POPUP);
  }

  it("empties the buffer (dney-audit-recent then returns []) and resets the badge to blank", async () => {
    await loadWorker();
    await addEvents(3);
    expect(await message({ type: "dney-audit-recent" }, POPUP)).toHaveLength(3);
    const c = fake!.chrome as any;
    expect(c.action.setBadgeText).toHaveBeenLastCalledWith({ text: "!" });
    expect(await message({ type: "dney-audit-clear" }, POPUP)).toBe(true);
    expect(await message({ type: "dney-audit-recent" }, POPUP)).toEqual([]);
    expect(await message({ type: "dney-audit-export" }, POPUP)).toBe("[]");
    // the same blank badge a fresh (not set up) install gets from onInstalled
    expect(c.action.setBadgeText).toHaveBeenLastCalledWith({ text: "" });
    expect(c.action.setBadgeBackgroundColor).toHaveBeenLastCalledWith({ color: "#1a8f63" });
  });

  it.each([
    ["a content script on claude.ai", { id: "ext-id", url: "https://claude.ai/new", tab: { id: 7 } }],
    ["another extension", { id: "other-ext", url: "chrome-extension://other-ext/x.html" }],
  ])("refused from %s: the buffer is kept", async (_n, sender) => {
    await loadWorker();
    await addEvents(2);
    expect(await message({ type: "dney-audit-clear" }, sender)).toBe(false);
    expect(await message({ type: "dney-audit-recent" }, POPUP)).toHaveLength(2);
  });
});

describe("options page: no sign-in or sign-up link in any state", () => {
  const html = readFileSync(join(__dirname, "..", "src", "ui", "options.html"), "utf8");
  const body = html.slice(html.indexOf("<body>") + 6, html.indexOf("</body>")).replace(/<script[^>]*><\/script>/g, "");

  it.each([
    ["consumer signed in", { local: { api_key: KEY, api_key_id: KEY_ID, welcome_opened: true } }],
    ["consumer signed out", { local: { welcome_opened: true } }],
    ["managed", { managed: { api_key: "school-key" } }],
  ])("%s", async (_n, init) => {
    vi.resetModules();
    fake = installFakeChrome(init as Parameters<typeof installFakeChrome>[0]);
    document.body.innerHTML = body;
    await import("../src/ui/options");
    await flush();
    await flush();
    // rendered (the form has its fields), so the check below is not vacuous
    expect(document.querySelectorAll("#form input, #form select").length).toBeGreaterThan(3);
    expect(signInOrUpControls(document.body)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/Sign in|Sign up|Create a free account/);
    expect(document.querySelector("#status-sign-in, #sign-in, #create-account")).toBeNull();
  });
});
