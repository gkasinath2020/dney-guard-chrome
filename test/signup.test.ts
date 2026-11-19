// SCRUM-395: popup signup, service-worker side. Real captured responses
// (test/fixtures/scrum392/captured) through the real handler, with an in-memory
// chrome.storage, so "where does the token end up" is read from storage itself.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfigState, mergeConfig, readLocal } from "../src/lib/config";
import { _resetWelcomeTab, handleSignup, openWelcomeOnce, popupMode, showWelcome } from "../src/lib/onboarding";
import type { OnboardingDeps } from "../src/lib/onboarding";
import { EXTENSION_KEY_NAME, SIGNUP_ORG_NAME, classify422, popupSignup } from "../src/lib/signup";
import {
  ACCESS_TOKEN,
  PASSWORD,
  RAW_KEY,
  captured,
  installFakeChrome,
  removeFakeChrome,
  responseOf,
  routedFetch,
} from "./helpers/onboarding-env";
import type { FakeChrome } from "./helpers/onboarding-env";

const SIGNUP = "/api/v1/auth/signup";
const KEYS = "/api/v1/auth/api-keys";

function depsFor(fake: FakeChrome, fetchImpl: typeof fetch): OnboardingDeps {
  const c = fake.chrome as any;
  return {
    loadState: loadConfigState,
    readLocal,
    writeLocal: (items) => c.storage.local.set(items),
    removeLocal: (keys) => c.storage.local.remove(keys),
    createTab: async (url, active) => (await c.tabs.create({ url, active })).id,
    focusTab: async (id) => {
      await c.tabs.update(id, { active: true });
    },
    extensionUrl: (p) => c.runtime.getURL(p),
    fetchImpl,
  };
}

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  _resetWelcomeTab();
  consoleSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {}),
  );
});
afterEach(() => {
  removeFakeChrome();
  vi.restoreAllMocks();
});

function everythingLogged(): string {
  return JSON.stringify(consoleSpies.map((s) => s.mock.calls));
}

describe("success: key stored in chrome.storage.local, access token nowhere", () => {
  it("signs up, creates the key with the token, stores ONLY the key, opens the welcome tab once (in the background)", async () => {
    const fake = installFakeChrome();
    const f = routedFetch({ [SIGNUP]: [responseOf(captured("signup_201"))], [KEYS]: [responseOf(captured("api_key_201"))] });
    const outcome = await handleSignup({ email: " me@example.com ", password: PASSWORD }, depsFor(fake, f.impl));

    expect(outcome).toEqual({ ok: true }); // nothing else crosses back to the popup

    // The two requests, as sent.
    expect(f.calls.map((c) => c.url)).toEqual([`https://api.dney.dev${SIGNUP}`, `https://api.dney.dev${KEYS}`]);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({
      org_name: "My workspace",
      email: "me@example.com",
      password: PASSWORD,
      source: { channel: "extension" },
    });
    expect((f.calls[0].init.headers as Record<string, string>).authorization).toBeUndefined();
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ name: "DNey Guard (Chrome)" });
    expect((f.calls[1].init.headers as Record<string, string>).authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(f.calls.every((c) => c.init.credentials === "omit")).toBe(true);
    // The token is sent to exactly one place: the api-keys request.
    expect(f.calls.filter((c) => JSON.stringify(c.init).includes(ACCESS_TOKEN))).toHaveLength(1);

    // Storage: the key in local, and nothing anywhere carries the token or the password.
    // SCRUM-437: with the key's server id, so a later popup sign-in can revoke it.
    expect(fake.areas.local).toEqual({ api_key: RAW_KEY, api_key_id: "d5d3c1e4-02e4-410b-8623-9fd49a61b21b", welcome_opened: true });
    expect(fake.areas.sync).toEqual({});
    const allStorage = JSON.stringify(fake.areas);
    expect(allStorage).not.toContain(ACCESS_TOKEN);
    expect(allStorage).not.toContain(PASSWORD);
    // Logs: nothing at all is logged on the signup path (so no token, key or password).
    expect(everythingLogged()).not.toContain(ACCESS_TOKEN);
    expect(everythingLogged()).not.toContain(PASSWORD);
    expect(everythingLogged()).not.toContain(RAW_KEY);

    // Welcome tab: opened once, in the background, so the popup stays on "You're set up".
    expect(fake.tabsCreated).toEqual([{ url: "chrome-extension://ext-id/ui/welcome.html", active: false }]);

    // The rest of the extension now sees the key; the popup leaves signup mode.
    const state = await loadConfigState();
    expect(state.config.api_key).toBe(RAW_KEY);
    expect(popupMode(state)).toBe("status");
  });

  it("the welcome tab opens once: a second openWelcomeOnce does nothing; 'See it in action' focuses it", async () => {
    const fake = installFakeChrome();
    const deps = depsFor(fake, routedFetch({}).impl);
    await openWelcomeOnce(deps);
    await openWelcomeOnce(deps);
    expect(fake.tabsCreated).toHaveLength(1);
    await showWelcome(deps);
    expect((fake.chrome as any).tabs.update).toHaveBeenCalledWith(101, { active: true });
    expect(fake.tabsCreated).toHaveLength(1);
  });

  it("'See it in action' reopens the tab if the user closed it", async () => {
    const fake = installFakeChrome();
    const deps = depsFor(fake, routedFetch({}).impl);
    await openWelcomeOnce(deps);
    (fake.chrome as any).tabs.update.mockRejectedValueOnce(new Error("No tab with id"));
    await showWelcome(deps);
    expect(fake.tabsCreated).toEqual([
      { url: "chrome-extension://ext-id/ui/welcome.html", active: false },
      { url: "chrome-extension://ext-id/ui/welcome.html", active: true },
    ]);
  });

  it("a welcome tab that fails to open does not turn a successful signup into an error", async () => {
    const fake = installFakeChrome();
    (fake.chrome as any).tabs.create.mockRejectedValueOnce(new Error("boom"));
    const f = routedFetch({ [SIGNUP]: [responseOf(captured("signup_201"))], [KEYS]: [responseOf(captured("api_key_201"))] });
    expect(await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: true });
    expect(fake.areas.local.api_key).toBe(RAW_KEY);
  });
});

describe("each error -> one outcome id (the popup maps each to its pinned B3 line)", () => {
  it.each([
    ["signup_409", "exists"],
    ["signup_429", "throttled"],
    ["signup_422_short", "password_short"],
    ["signup_422_long", "password_long"],
    ["signup_422_email", "invalid_email"],
  ] as const)("captured %s -> %s, nothing stored, no key request", async (name, error) => {
    const fake = installFakeChrome();
    const f = routedFetch({ [SIGNUP]: [responseOf(captured(name))] });
    expect(await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error });
    expect(f.calls).toHaveLength(1);
    expect(fake.areas.local).toEqual({});
    expect(fake.tabsCreated).toEqual([]);
  });

  it.each([
    [503, "unavailable"],
    [502, "unavailable"],
    [504, "unavailable"],
    [500, "unknown"],
    [400, "unknown"],
  ] as const)("HTTP %s -> %s", async (status, error) => {
    const f = routedFetch({ [SIGNUP]: [responseOf({ status, body: { detail: "x" } })] });
    const out = await popupSignup({ email: "a@b.co", password: PASSWORD }, { baseUrl: "https://api.dney.dev", fetchImpl: f.impl, storeKey: async () => {} });
    expect(out).toEqual({ ok: false, error });
  });

  it("network failure / timeout on signup -> unavailable, and signup is NOT retried (a retry could read as 'exists')", async () => {
    const f = routedFetch({ [SIGNUP]: [new TypeError("Failed to fetch"), responseOf(captured("signup_201"))] });
    const out = await popupSignup({ email: "a@b.co", password: PASSWORD }, { baseUrl: "https://api.dney.dev", fetchImpl: f.impl, storeKey: async () => {} });
    expect(out).toEqual({ ok: false, error: "unavailable" });
    expect(f.calls).toHaveLength(1);
  });

  it("api-keys network failure is retried once, then succeeds", async () => {
    const stored: string[] = [];
    const f = routedFetch({
      [SIGNUP]: [responseOf(captured("signup_201"))],
      [KEYS]: [new TypeError("Failed to fetch"), responseOf(captured("api_key_201"))],
    });
    const out = await popupSignup({ email: "a@b.co", password: PASSWORD }, { baseUrl: "https://api.dney.dev/", fetchImpl: f.impl, storeKey: async (k) => void stored.push(k) });
    expect(out).toEqual({ ok: true });
    expect(stored).toEqual([RAW_KEY]);
  });

  it.each([
    [[new TypeError("x"), new TypeError("x")], "unavailable"],
    [[responseOf({ status: 503, body: {} })], "unavailable"],
    [[responseOf({ status: 401, body: { detail: "Could not validate credentials" } })], "unknown"],
    [[responseOf({ status: 201, body: { id: "no-key-field" } })], "unknown"],
  ] as const)("api-keys failure %# -> %s, nothing stored", async (keyResponses, error) => {
    const stored: string[] = [];
    const f = routedFetch({ [SIGNUP]: [responseOf(captured("signup_201"))], [KEYS]: [...keyResponses] });
    const out = await popupSignup({ email: "a@b.co", password: PASSWORD }, { baseUrl: "https://api.dney.dev", fetchImpl: f.impl, storeKey: async (k) => void stored.push(k) });
    expect(out).toEqual({ ok: false, error });
    expect(stored).toEqual([]);
  });

  it("a 201 without an access_token -> unknown, and no key request is made", async () => {
    const f = routedFetch({ [SIGNUP]: [responseOf({ status: 201, body: { token_type: "bearer" } })] });
    const out = await popupSignup({ email: "a@b.co", password: PASSWORD }, { baseUrl: "https://api.dney.dev", fetchImpl: f.impl, storeKey: async () => {} });
    expect(out).toEqual({ ok: false, error: "unknown" });
    expect(f.calls).toHaveLength(1);
  });

  it("classify422: email first; password by TYPE, not by echoing msg", () => {
    expect(classify422({ detail: [{ loc: ["body", "password"], type: "password_too_short" }, { loc: ["body", "email"], type: "value_error" }] })).toBe("invalid_email");
    expect(classify422({ detail: [{ loc: ["body", "password"], type: "password_too_long", msg: "anything" }] })).toBe("password_long");
    expect(classify422({ detail: [{ loc: ["body", "org_name"], type: "missing" }] })).toBe("unknown");
    expect(classify422({ detail: "not a list" })).toBe("unknown");
  });

  it("constants are what the server and dashboard see", () => {
    expect(SIGNUP_ORG_NAME).toBe("My workspace");
    expect(EXTENSION_KEY_NAME).toBe("DNey Guard (Chrome)");
  });
});

describe("managed installs never sign up; an existing key is never overwritten", () => {
  it("managed: the handler refuses before any request", async () => {
    const fake = installFakeChrome({ managed: { api_key: "school-key" } });
    const f = routedFetch({});
    expect(await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "unknown" });
    expect(f.calls).toEqual([]);
    expect(fake.areas.local).toEqual({});
  });

  it("managed with NO key in the policy (e.g. enrolment only) still refuses", async () => {
    const fake = installFakeChrome({ managed: { enrolment_token: "class-token" } });
    const f = routedFetch({});
    expect((await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).ok).toBe(false);
    expect(f.calls).toEqual([]);
  });

  it("a consumer with a pasted key: refused, key untouched", async () => {
    const fake = installFakeChrome({ local: { api_key: "pasted" } });
    const f = routedFetch({});
    expect((await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(fake.areas.local).toEqual({ api_key: "pasted" });
  });

  it("an upgraded 0.2.0 user (key still in sync) is migrated first, so is never offered signup", async () => {
    const fake = installFakeChrome({ sync: { api_key: "from-0.2.0", fail_policy: "open" } });
    const f = routedFetch({});
    expect((await handleSignup({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).ok).toBe(false);
    expect(f.calls).toEqual([]);
    expect(fake.areas.local).toEqual({ api_key: "from-0.2.0" });
    expect(fake.areas.sync).toEqual({ fail_policy: "open" });
  });

  it("popupMode: signup only for a consumer with no key", () => {
    const st = (managed: boolean, api_key: string) => ({ managed, config: { ...mergeConfig({}, null), api_key } });
    expect(popupMode(st(false, ""))).toBe("signup");
    expect(popupMode(st(false, "k"))).toBe("status");
    expect(popupMode(st(true, ""))).toBe("status");
    expect(popupMode(st(true, "k"))).toBe("status");
  });
});

describe("config: where the popup key is read from", () => {
  it("consumer: the key comes from local ONLY; a key in sync is never read", () => {
    expect(mergeConfig({}, {}, { api_key: "local" }).api_key).toBe("local");
    expect(mergeConfig({}, { api_key: "" }, { api_key: "local" }).api_key).toBe("local");
    expect(mergeConfig({}, { api_key: "synced" }, { api_key: "local" }).api_key).toBe("local");
    expect(mergeConfig({}, { api_key: "synced" }, null).api_key).toBe("");
  });

  it("managed: the local key is ignored, exactly as sync is", () => {
    expect(mergeConfig({ fail_policy: "closed" }, null, { api_key: "local" }).api_key).toBe("");
    expect(mergeConfig({ api_key: "school" }, null, { api_key: "local" }).api_key).toBe("school");
  });
});
