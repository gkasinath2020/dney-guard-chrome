// @vitest-environment jsdom
// SCRUM-437: sign in from the popup. Service-worker side through the real handler
// with an in-memory chrome.storage (so "where does the JWT end up" is read from
// storage itself), and the popup side rendered in jsdom against the pinned copy.
//
// The server responses here are CONSTRUCTED from asgard-services main (not
// captured): POST /auth/login -> {access_token, token_type} | 401 "Invalid
// credentials" | 429 + Retry-After; GET /organizations/me -> OrgResponse {name..};
// GET /guardrails -> GuardrailResponse[] {mode, group_id, is_template..};
// POST /auth/api-keys -> 201 ApiKeyCreateResponse {id, key..} | 403 "Admin
// required"; DELETE /auth/api-keys/{id} -> 204 | 404.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfigState, mergeConfig, readLocal } from "../src/lib/config";
import type { ConfigState } from "../src/lib/config";
import { handleSignin } from "../src/lib/onboarding";
import type { OnboardingDeps } from "../src/lib/onboarding";
import { saveSettings } from "../src/lib/settings-store";
import { summarizeGuardrails } from "../src/lib/signin";
import type { Protections, SigninOutcome } from "../src/lib/signin";
import { mountPopup, renderSignin, renderStatus } from "../src/ui/popup-view";
import type { PopupDeps } from "../src/ui/popup-view";
import pinned from "./fixtures/scrum392/onboarding_copy_pinned.json";
import { installFakeChrome, removeFakeChrome, responseOf, routedFetch } from "./helpers/onboarding-env";
import type { FakeChrome } from "./helpers/onboarding-env";

const P = pinned.copy as Record<string, string>;
const JWT = "eyJ.signin-jwt.SIG-437";
const NEW_KEY = "asg_new_key_437";
const NEW_ID = "11111111-1111-4111-8111-111111111111";
const OLD_KEY = "asg_old_key_437";
const OLD_ID = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "correct-horse-battery";
const BASE = "https://api.dney.dev";

const LOGIN = "/api/v1/auth/login";
const ORG = "/api/v1/organizations/me";
const LIST = "/api/v1/guardrails";
const KEYS = "/api/v1/auth/api-keys";

const login200 = () => responseOf({ status: 200, body: { access_token: JWT, token_type: "bearer" } });
const org200 = (name = "Acme Learning") => responseOf({ status: 200, body: { id: "o1", name, slug: "acme", tier: "free" } });
const g = (mode: string, extra: Record<string, unknown> = {}) => ({ id: `g-${mode}`, mode, group_id: null, is_template: false, ...extra });
const list200 = (items: unknown[] = [g("enforce"), g("monitor")]) => responseOf({ status: 200, body: items });
const mint201 = () => responseOf({ status: 201, body: { id: NEW_ID, name: "DNey Guard (Chrome)", key: NEW_KEY, key_prefix: "asg_new_ke", rate_limit_rpm: 600, group_id: null } });
const status = (code: number, body: unknown = { detail: "x" }, headers?: Record<string, string>) => responseOf({ status: code, body, headers });
const noContent = () => new Response(null, { status: 204 });
const netErr = () => new TypeError("Failed to fetch");

/** Every route of a full successful sign-in; override per test. */
function happyRoutes(over: Record<string, (Response | Error)[]> = {}) {
  return {
    [LOGIN]: [login200()],
    [ORG]: [org200()],
    // first read is the JWT guardrail list, the second is the key verify
    [LIST]: [list200(), list200()],
    [KEYS]: [mint201()],
    ...over,
  };
}

function depsFor(fake: FakeChrome, fetchImpl: typeof fetch): OnboardingDeps {
  const c = fake.chrome as any;
  return {
    loadState: loadConfigState,
    readLocal,
    writeLocal: (items) => c.storage.local.set(items),
    removeLocal: (keys) => c.storage.local.remove(keys),
    createTab: async (url, active) => (await c.tabs.create({ url, active })).id,
    focusTab: async () => {},
    extensionUrl: (p) => c.runtime.getURL(p),
    fetchImpl,
  };
}

/** Every value ever handed to any chrome.storage write, across all areas. */
function everythingWritten(fake: FakeChrome): string {
  const areas = (fake.chrome as any).storage;
  return JSON.stringify(["managed", "sync", "local", "session"].map((a) => areas[a].set.mock.calls));
}

const header = (c: { init: RequestInit }, name: string) => (c.init.headers as Record<string, string> | undefined)?.[name];

let logSpies: ReturnType<typeof vi.spyOn>[] = [];
beforeEach(() => {
  logSpies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
});
afterEach(() => {
  removeFakeChrome();
  vi.restoreAllMocks();
});

describe("service worker: the happy path", () => {
  it("stores the key AND its id, the JWT never touches chrome.storage, S11 + S7", async () => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes());
    const out = await handleSignin({ email: " me@example.com ", password: PASSWORD }, depsFor(fake, f.impl));

    expect(out).toEqual({ ok: true, org_name: "Acme Learning", protections: "enforce" });
    expect(JSON.stringify(out)).not.toContain(JWT);
    expect(JSON.stringify(out)).not.toContain(NEW_KEY);

    // storage: the key and its id in local only; the JWT and password nowhere, ever
    expect(fake.areas.local).toEqual({ api_key: NEW_KEY, api_key_id: NEW_ID });
    expect(fake.areas.sync).toEqual({});
    expect(fake.areas.session).toEqual({});
    expect(everythingWritten(fake)).not.toContain(JWT);
    expect(everythingWritten(fake)).not.toContain(PASSWORD);
    expect(JSON.stringify(logSpies.map((s) => s.mock.calls))).toBe("[[],[],[],[],[]]");

    // the requests, as sent
    expect(f.calls.map((c) => `${c.init.method} ${c.url}`)).toEqual([
      `POST ${BASE}${LOGIN}`,
      `GET ${BASE}${ORG}`,
      `GET ${BASE}${LIST}`,
      `POST ${BASE}${KEYS}`,
      `GET ${BASE}${LIST}`,
    ]);
    expect(JSON.parse(String(f.calls[0].init.body))).toEqual({ email: "me@example.com", password: PASSWORD });
    expect(header(f.calls[0], "authorization")).toBeUndefined();
    expect(JSON.parse(String(f.calls[3].init.body))).toEqual({ name: "DNey Guard (Chrome)" });
    for (const i of [1, 2, 3]) expect(header(f.calls[i], "authorization")).toBe(`Bearer ${JWT}`);
    // the verify is made with the stored key, not the JWT
    expect(header(f.calls[4], "x-api-key")).toBe(NEW_KEY);
    expect(header(f.calls[4], "authorization")).toBeUndefined();
    expect(f.calls.every((c) => c.init.credentials === "omit")).toBe(true);
    // the JWT goes only in Authorization headers, and only to the configured DNey
    expect(f.calls.filter((c) => JSON.stringify(c.init).includes(JWT))).toHaveLength(3);
    expect(f.calls.every((c) => c.url.startsWith(`${BASE}/`))).toBe(true);
    // no welcome tab: its copy is for a brand-new account
    expect(fake.tabsCreated).toEqual([]);

    // the rest of the extension now uses the new key
    expect((await loadConfigState()).config.api_key).toBe(NEW_KEY);
  });
});

describe("service worker: which line (S7/S8/S9/S9b/S10)", () => {
  it.each([
    ["S7: >=1 enforce", [g("enforce"), g("disabled")], "enforce"],
    ["S8: 0 enforce, >=1 monitor", [g("monitor"), g("disabled")], "monitor"],
    ["S9: all disabled", [g("disabled"), g("disabled")], "disabled"],
    ["S9b: zero guardrails", [], "none"],
    // an org-wide key is checked against org-wide guardrails only
    ["group-scoped enforce does not count for an org-wide key", [g("enforce", { group_id: "grp" }), g("monitor")], "monitor"],
    ["templates never count", [g("enforce", { is_template: true })], "none"],
  ] as const)("%s", async (_n, items, protections) => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [LIST]: [list200([...items]), list200()] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({
      ok: true,
      org_name: "Acme Learning",
      protections,
    });
  });

  it.each([
    ["a 500", status(500)],
    ["a 401", status(401)],
    ["a network failure", netErr()],
    ["a body that is not a list", status(200, { detail: "nope" })],
  ])("S10: the guardrail read failed (%s) -> 'unknown', the key is still minted", async (_n, res) => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [LIST]: [res, list200()] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({
      ok: true,
      org_name: "Acme Learning",
      protections: "unknown",
    });
    expect(fake.areas.local.api_key).toBe(NEW_KEY);
  });

  it("summarizeGuardrails: S7 only for a real list with an org-wide enforce", () => {
    expect(summarizeGuardrails([g("enforce")])).toBe("enforce");
    expect(summarizeGuardrails(null)).toBe("unknown");
    expect(summarizeGuardrails({ mode: "enforce" })).toBe("unknown");
    expect(summarizeGuardrails([{ mode: "Enforce", group_id: null }])).toBe("disabled");
  });

  it("no org name -> no org_name in the outcome (S11 is left out)", async () => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [ORG]: [status(404)] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: true, protections: "enforce" });
  });
});

describe("service worker: errors", () => {
  it.each([
    ["401 (unknown email OR wrong password: one neutral outcome)", status(401, { detail: "Invalid credentials" }), "invalid"],
    ["422 (malformed email)", status(422, { detail: [{ loc: ["body", "email"], type: "value_error" }] }), "invalid"],
    ["429", status(429, { detail: "Too many login attempts. Try again later." }, { "retry-after": "42" }), "throttled"],
    // S3's network line is for a real network failure only (fetch rejected / timed out)
    ["network failure", netErr(), "unavailable"],
    ["503", status(503), "unknown"],
    ["a 200 without an access_token", status(200, { token_type: "bearer" }), "unknown"],
  ] as const)("login %s -> %s; nothing stored, no further request", async (_n, res, error) => {
    const fake = installFakeChrome();
    const f = routedFetch({ [LOGIN]: [res] });
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error });
    expect(f.calls).toHaveLength(1);
    expect(fake.areas.local).toEqual({});
  });

  it("403 from the key mint (not an admin) -> not_admin with the org name; NO key stored, no JWT stored", async () => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [KEYS]: [status(403, { detail: "Admin required" })] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({
      ok: false,
      error: "not_admin",
      org_name: "Acme Learning",
    });
    expect(fake.areas.local).toEqual({});
    expect(everythingWritten(fake)).not.toContain(JWT);
    expect(f.calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it.each([
    ["a network failure", netErr(), "unavailable"],
    ["a 500", status(500), "unknown"],
    ["a 503", status(503), "unknown"],
  ] as const)("mint %s -> %s, nothing stored", async (_n, res, error) => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [KEYS]: [res] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error });
    expect(fake.areas.local).toEqual({});
  });

  it("a mint response without an id or key -> unknown, nothing stored", async () => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [KEYS]: [status(201, { key: NEW_KEY })] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "unknown" });
    expect(fake.areas.local).toEqual({});
  });
});

describe("service worker: re-sign-in when a key is already saved", () => {
  /** One ordered log of the requests and the storage writes/removes. */
  function traced(fake: FakeChrome, routes: Record<string, (Response | Error)[]>) {
    const log: string[] = [];
    const f = routedFetch(routes);
    const impl = (async (url: string, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      const auth = header({ init: init ?? {} }, "x-api-key") ? "key" : "jwt";
      log.push(`${init?.method} ${path}${path === LIST ? ` (${auth})` : ""}`);
      return f.impl(url, init);
    }) as unknown as typeof fetch;
    const local = (fake.chrome as any).storage.local;
    local.set.mockImplementation(async (items: Record<string, unknown>) => {
      log.push(`store ${items.api_key}`);
      Object.assign(fake.areas.local, items);
    });
    local.remove.mockImplementation(async (k: string | string[]) => {
      log.push(`remove ${[k].flat().join(",")}`);
      for (const key of [k].flat()) delete fake.areas.local[key];
    });
    return { log, impl, calls: f.calls };
  }

  it("without the S6 confirmation the worker refuses before any request", async () => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const f = routedFetch({});
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "confirm_required" });
    expect(f.calls).toEqual([]);
    expect(fake.areas.local).toEqual({ api_key: OLD_KEY, api_key_id: OLD_ID });
  });

  it("order: mint -> store -> verify (with the stored key) -> only THEN revoke the old key id", async () => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const t = traced(fake, happyRoutes({ [`${KEYS}/${OLD_ID}`]: [noContent()] }));
    const out = await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, t.impl));
    expect(out).toEqual({ ok: true, org_name: "Acme Learning", protections: "enforce" });
    expect(t.log).toEqual([
      `POST ${LOGIN}`,
      `GET ${ORG}`,
      `GET ${LIST} (jwt)`,
      `POST ${KEYS}`,
      `store ${NEW_KEY}`,
      `GET ${LIST} (key)`,
      `DELETE ${KEYS}/${OLD_ID}`,
    ]);
    expect(header(t.calls[5], "authorization")).toBe(`Bearer ${JWT}`);
    expect(fake.areas.local).toEqual({ api_key: NEW_KEY, api_key_id: NEW_ID });
    expect(everythingWritten(fake)).not.toContain(JWT);
  });

  it.each([
    ["a 500", status(500)],
    ["a network failure", netErr()],
    ["a 403", status(403, { detail: "Admin required" })],
  ])("mint failure (%s): the old key stays, nothing is revoked", async (_n, res) => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const t = traced(fake, happyRoutes({ [KEYS]: [res] }));
    const out = await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, t.impl));
    expect(out.ok).toBe(false);
    expect(fake.areas.local).toEqual({ api_key: OLD_KEY, api_key_id: OLD_ID });
    expect(t.log.filter((l) => l.startsWith("DELETE") || l.startsWith("store") || l.startsWith("remove"))).toEqual([]);
  });

  it.each([
    ["the key is rejected (401)", status(401, { detail: "Invalid API key" })],
    ["a network failure", netErr()],
    ["a 500", status(500)],
  ])("verify failure (%s): the old key is restored and NOT revoked -> key_kept (G3b); the unverified new key is tidied away", async (_n, res) => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const t = traced(fake, happyRoutes({ [LIST]: [list200(), res], [`${KEYS}/${NEW_ID}`]: [noContent()] }));
    const out = await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, t.impl));
    expect(out).toEqual({ ok: false, error: "key_kept" });
    // G3b only because storage really holds the previous key and its id again
    expect(fake.areas.local).toEqual({ api_key: OLD_KEY, api_key_id: OLD_ID });
    expect((await loadConfigState()).config.api_key).toBe(OLD_KEY);
    expect(t.log.slice(4)).toEqual([`store ${NEW_KEY}`, `GET ${LIST} (key)`, `store ${OLD_KEY}`, `DELETE ${KEYS}/${NEW_ID}`]);
    expect(t.log).not.toContain(`DELETE ${KEYS}/${OLD_ID}`);
  });

  it.each([
    ["a 401", status(401)],
    ["a network failure", netErr()],
  ])("verify failure (%s) on a FIRST sign-in: no key stored, unknown (G3a), never key_kept", async (_n, res) => {
    const fake = installFakeChrome();
    const f = routedFetch(happyRoutes({ [LIST]: [list200(), res], [`${KEYS}/${NEW_ID}`]: [noContent()] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "unknown" });
    expect(fake.areas.local).toEqual({});
  });

  it("a pasted previous key (no id) restored after a failed verify -> key_kept, and no stray id", async () => {
    const fake = installFakeChrome({ local: { api_key: "pasted" } });
    const f = routedFetch(happyRoutes({ [LIST]: [list200(), status(401)], [`${KEYS}/${NEW_ID}`]: [noContent()] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "key_kept" });
    expect(fake.areas.local).toEqual({ api_key: "pasted" });
  });

  it("the restore does not stick (write fails) -> unknown, NOT key_kept; the new key is left alone", async () => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const local = (fake.chrome as any).storage.local;
    const real = local.set.getMockImplementation();
    let writes = 0;
    local.set.mockImplementation(async (items: Record<string, unknown>) => {
      if (++writes === 2) throw new Error("quota"); // the restore
      return real(items);
    });
    const f = routedFetch(happyRoutes({ [LIST]: [list200(), status(401)] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "unknown" });
    expect(fake.areas.local).toEqual({ api_key: NEW_KEY, api_key_id: NEW_ID });
    expect(f.calls.some((c) => c.init.method === "DELETE")).toBe(false);
  });

  it("the stored key does not read back: not verified, nothing revoked", async () => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const local = (fake.chrome as any).storage.local;
    const real = local.get.getMockImplementation();
    let reads = 0;
    local.get.mockImplementation(async (k: unknown) => {
      const v = await real(k);
      // the read after the write returns a stale key
      return ++reads >= 3 && Array.isArray(k) ? { ...v, api_key: "stale" } : v;
    });
    const f = routedFetch(happyRoutes({ [LIST]: [list200()], [`${KEYS}/${NEW_ID}`]: [noContent()] }));
    const out = await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl));
    // the restore cannot be confirmed by reading back either: never G3b
    expect(out).toEqual({ ok: false, error: "unknown" });
    expect(f.calls.some((c) => c.url.endsWith(OLD_ID))).toBe(false);
  });

  it.each([
    ["a 500", status(500)],
    ["a 404 (old key in another org)", status(404, { detail: "API key not found" })],
    ["a network failure", netErr()],
  ])("revoke failure (%s) is non-fatal: signed in, new key kept, old_key_not_revoked (S12)", async (_n, res) => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    const f = routedFetch(happyRoutes({ [`${KEYS}/${OLD_ID}`]: [res] }));
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))).toEqual({
      ok: true,
      org_name: "Acme Learning",
      protections: "enforce",
      old_key_not_revoked: true,
    });
    expect(fake.areas.local).toEqual({ api_key: NEW_KEY, api_key_id: NEW_ID });
  });

  it("a pasted key (no id saved): replaced, nothing revoked", async () => {
    const fake = installFakeChrome({ local: { api_key: "pasted" } });
    const f = routedFetch(happyRoutes());
    // replaced, not revoked: and no S12 either (nothing was attempted)
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))).toEqual({
      ok: true,
      org_name: "Acme Learning",
      protections: "enforce",
    });
    expect(f.calls.some((c) => c.init.method === "DELETE")).toBe(false);
    expect(fake.areas.local).toEqual({ api_key: NEW_KEY, api_key_id: NEW_ID });
  });

  it("Settings: a different (or cleared) key forgets the popup's key id; re-saving the same key keeps it", async () => {
    const fake = installFakeChrome({ local: { api_key: OLD_KEY, api_key_id: OLD_ID } });
    await saveSettings({ api_key: OLD_KEY });
    expect(fake.areas.local).toEqual({ api_key: OLD_KEY, api_key_id: OLD_ID });
    await saveSettings({ api_key: "asg_pasted" });
    expect(fake.areas.local).toEqual({ api_key: "asg_pasted" });
    fake.areas.local.api_key_id = OLD_ID;
    await saveSettings({ api_key: "" });
    expect(fake.areas.local).toEqual({});
  });
});

describe("service worker: managed installs never sign in", () => {
  it.each([
    ["with a policy key", { api_key: "school" }],
    ["with no key in the policy", { enrolment_token: "class" }],
  ])("managed %s: refused before any request", async (_n, managed) => {
    const fake = installFakeChrome({ managed });
    const f = routedFetch({});
    expect(await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))).toEqual({ ok: false, error: "unknown" });
    expect(f.calls).toEqual([]);
    expect(fake.areas.local).toEqual({});
  });
});

describe("service worker routing: dney-signin from extension pages only", () => {
  let listeners: Record<string, ((...a: unknown[]) => unknown)[]>;
  beforeEach(async () => {
    vi.resetModules();
    const fake = installFakeChrome();
    listeners = (fake.chrome as { _listeners: typeof listeners })._listeners;
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("no network in this test"); }));
    await import("../src/background");
  });
  afterEach(() => vi.unstubAllGlobals());
  const message = (msg: unknown, sender: unknown) =>
    new Promise((resolve) => {
      if (!listeners.onMessage[0](msg, sender, resolve)) setTimeout(() => resolve("__sync__"), 0);
    });

  it("from a content script on claude.ai: refused, no request", async () => {
    expect(await message({ type: "dney-signin", email: "a@b.co", password: PASSWORD }, { id: "ext-id", url: "https://claude.ai/new", tab: { id: 1 } })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("from the popup: attempted (a network failure answers 'unavailable')", async () => {
    const res = await message({ type: "dney-signin", email: "a@b.co", password: PASSWORD }, { id: "ext-id", url: "chrome-extension://ext-id/ui/popup.html" });
    expect(res).toEqual({ ok: false, error: "unavailable" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Popup (jsdom), against the pinned copy.

const norm = (s: string) => s.replace(/\s+/g, " ").trim();
function unpinnedRest(text: string, strings: string[]): string {
  let rest = norm(text);
  for (const s of [...strings].sort((a, b) => b.length - a.length)) rest = rest.split(norm(s)).join(" ");
  return rest.replace(/[\s:]+/g, " ").trim();
}
function newRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root")!;
}
const consumerNoKey: ConfigState = { config: mergeConfig({}, null), managed: false, managedReadFailed: false };
const consumerWithKey: ConfigState = { config: mergeConfig({}, {}, { api_key: OLD_KEY }), managed: false, managedReadFailed: false };
const managedState: ConfigState = { config: mergeConfig({ api_key: "school" }, null), managed: true, managedReadFailed: false };
function popupDeps(send: PopupDeps["send"] = async () => [], state = consumerNoKey, after = state): PopupDeps {
  let n = 0;
  return { loadState: async () => (n++ === 0 ? state : after), send, removeLocal: vi.fn(async () => {}), openOptions: vi.fn(), download: vi.fn() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const fill = (root: HTMLElement, email = "me@example.com", password = PASSWORD) => {
  (root.querySelector("#signin-email") as HTMLInputElement).value = email;
  (root.querySelector("#signin-password") as HTMLInputElement).value = password;
};
const submit = (root: HTMLElement) => (root.querySelector("#signin") as HTMLFormElement).requestSubmit();
const S2_SHOWN = ["B1.heading", "S2.title", "S2.label_email", "S2.label_password", "S2.button", "S2.under_form", "S2.under_form_link"];

describe("popup: the way in (S1, S4) and the form (S2)", () => {
  it("S1 footer 'Already have an account? Sign in' opens the sign-in form in the popup", async () => {
    const root = newRoot();
    const deps = popupDeps();
    await mountPopup(root, deps);
    const footer = root.querySelector(".footer")!;
    expect(norm(footer.textContent ?? "")).toBe("Already have an account? Sign in");
    (root.querySelector("#sign-in") as HTMLAnchorElement).click();
    expect(root.querySelector("form")!.id).toBe("signin");
    expect(deps.openOptions).not.toHaveBeenCalled();
  });

  it("S2: every pinned string and nothing else; NO Terms notice; two inputs; 'Create a free account' goes back to signup", () => {
    const root = newRoot();
    renderSignin(root, popupDeps(), { hasKey: false });
    const text = norm(root.textContent ?? "");
    for (const id of S2_SHOWN) expect(text).toContain(norm(P[id]));
    expect(unpinnedRest(text, S2_SHOWN.map((i) => P[i]))).toBe("");
    expect(root.querySelector("#terms-notice")).toBeNull();
    expect(text).not.toContain("Terms of Service");
    expect(text).not.toContain(P["B2.terms_notice"]);
    expect(root.querySelectorAll("input").length).toBe(2);
    expect((root.querySelector("#signin-password") as HTMLInputElement).autocomplete).toBe("current-password");
    (root.querySelector("#create-account") as HTMLAnchorElement).click();
    expect(root.querySelector("form")!.id).toBe("signup");
    expect(root.querySelector("#terms-notice")).not.toBeNull(); // the signup keeps its notice
  });

  it("submit sends ONLY type + email + password (no replace, no Terms version); working text while it runs", async () => {
    const root = newRoot();
    let release!: (v: unknown) => void;
    const send = vi.fn(() => new Promise((r) => (release = r)));
    renderSignin(root, popupDeps(send), { hasKey: false });
    fill(root);
    submit(root);
    await flush();
    expect(root.querySelector("#signin-submit")!.textContent).toBe(P["S2.button_working"]);
    expect(send).toHaveBeenCalledWith({ type: "dney-signin", email: "me@example.com", password: PASSWORD });
    release({ ok: false, error: "invalid" });
    await flush();
  });
});

describe("popup: errors (S3, S5)", () => {
  it.each([
    ["invalid", "S3.invalid"],
    ["throttled", "S3.throttled"],
    ["unavailable", "S3.unavailable"],
    ["unknown", "G3a.unknown"],
    ["key_kept", "G3b.key_kept"],
  ] as const)("%s -> exactly %s, form usable again", async (error, id) => {
    const root = newRoot();
    renderSignin(root, popupDeps(async () => ({ ok: false, error })), { hasKey: false });
    fill(root);
    submit(root);
    await flush();
    expect(root.querySelector("#signin-error")!.textContent).toBe(P[id]);
    expect(unpinnedRest(root.textContent ?? "", [...S2_SHOWN.map((i) => P[i]), P[id]])).toBe("");
    expect((root.querySelector("#signin-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(root.querySelector("#signin-submit")!.textContent).toBe(P["S2.button"]);
  });

  it("no answer from the worker -> the unexpected-error line (never silence)", async () => {
    const root = newRoot();
    renderSignin(root, popupDeps(async () => { throw new Error("gone"); }), { hasKey: false });
    submit(root);
    await flush();
    expect(root.querySelector("#signin-error")!.textContent).toBe(P["G3a.unknown"]);
  });

  it("not_admin -> S5 with the org name; nothing says 'signed in'", async () => {
    const root = newRoot();
    renderSignin(root, popupDeps(async () => ({ ok: false, error: "not_admin", org_name: "Acme Learning" })), { hasKey: false });
    submit(root);
    await flush();
    expect(root.querySelector("#signin-error")!.textContent).toBe(
      "Only an admin of Acme Learning can connect DNey Guard to this workspace. Ask your admin to set it up for you.",
    );
    expect(root.textContent).not.toMatch(/signed in/i);
    expect(root.querySelector("#signin-result")).toBeNull();
  });

  it("not_admin without an org name -> G1, the whole sentence", async () => {
    const root = newRoot();
    renderSignin(root, popupDeps(async () => ({ ok: false, error: "not_admin" })), { hasKey: false });
    submit(root);
    await flush();
    expect(root.querySelector("#signin-error")!.textContent).toBe(
      "Only a workspace admin can connect DNey Guard to this workspace. Ask your admin to set it up for you.",
    );
    expect(P["G1.not_admin_no_org"]).toBe(root.querySelector("#signin-error")!.textContent);
  });
});

describe("popup: after sign-in, S11 and exactly one of S7/S8/S9/S9b/S10", () => {
  const LINES: [Protections, string][] = [
    ["enforce", "S7.enforce"],
    ["monitor", "S8.monitor"],
    ["disabled", "S9.disabled"],
    ["none", "S9b.none"],
    ["unknown", "S10.read_failed"],
  ];
  const ALL = LINES.map(([, id]) => P[id]);

  it.each(LINES)("%s -> %s, then 'Connected to <org>'; the status view follows", async (protections, id) => {
    const root = newRoot();
    const after: ConfigState = { ...consumerWithKey, config: mergeConfig({}, {}, { api_key: NEW_KEY }) };
    renderSignin(root, popupDeps(async (m) => ((m as { type: string }).type === "dney-signin" ? { ok: true, org_name: "Acme Learning", protections } : []), consumerNoKey, after), { hasKey: false });
    submit(root);
    await flush();
    const line = root.querySelector("#signin-protections")!;
    expect(line.textContent).toBe(P[id]);
    // exactly one of the five, and S7 only for "enforce"
    expect(ALL.filter((s) => norm(root.querySelector("#signin-result")!.textContent ?? "").includes(s))).toEqual(
      // S10 "You're signed in." is a prefix of S7, so it is checked by the line itself
      ALL.filter((s) => P[id].includes(s)),
    );
    if (protections !== "enforce") expect(root.textContent).not.toContain(P["S7.enforce"]);
    expect(root.querySelector("#signin-org")!.textContent).toBe("Connected to Acme Learning");
    expect(root.querySelector("#signin-org")!.previousElementSibling).toBe(line);
    // S11 has no "change this in your dashboard" hint
    expect(root.querySelector("#signin-org")!.querySelector("a")).toBeNull();
    // the dashboard link in S8/S9/S9b, nothing else linked in the result
    const links = [...line.querySelectorAll("a")] as HTMLAnchorElement[];
    if (["monitor", "disabled", "none"].includes(protections)) {
      expect(links.map((a) => [a.textContent, a.getAttribute("href"), a.target])).toEqual([["your dashboard", pinned.links.dashboard, "_blank"]]);
    } else {
      expect(links).toEqual([]);
    }
    // the status view itself
    expect(root.querySelector("#mode")).not.toBeNull();
    expect(root.querySelector("form")).toBeNull();
  });

  it("no org name -> no S11 line", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps(), { ok: true, protections: "enforce" } as Extract<SigninOutcome, { ok: true }>);
    expect(root.querySelector("#signin-protections")!.textContent).toBe(P["S7.enforce"]);
    expect(root.querySelector("#signin-org")).toBeNull();
  });

  it("an outcome with an unexpected protections value never reads as S7", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps(), { ok: true, protections: "bogus" } as unknown as Extract<SigninOutcome, { ok: true }>);
    expect(root.querySelector("#signin-protections")!.textContent).toBe(P["S10.read_failed"]);
  });

  it("the plain status view (popup reopened) has no sign-in result", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps());
    expect(root.querySelector("#signin-result")).toBeNull();
  });
});

describe("popup: a key is already saved (S6)", () => {
  // SCRUM-480 removed the status view's "Sign in" link (the way here with a key
  // saved); the hasKey form is still pinned directly, as the worker can still
  // answer confirm_required.
  it("hasKey: the form without 'Create a free account'; submit shows S6 and sends NOTHING", async () => {
    const root = newRoot();
    const send = vi.fn(async () => []);
    renderSignin(root, popupDeps(send), { hasKey: true });
    expect(root.querySelector("form")!.id).toBe("signin");
    expect(root.querySelector("#create-account")).toBeNull();
    expect(root.textContent).not.toContain(P["S2.under_form"]);
    fill(root);
    submit(root);
    await flush();
    expect(root.querySelector("#signin-confirm")!.textContent).toBe(P["S6.confirm"]);
    expect(root.querySelector("#replace")!.textContent).toBe(P["S6.button_replace"]);
    expect(root.querySelector("#cancel")!.textContent).toBe(P["S6.button_cancel"]);
    expect(send).not.toHaveBeenCalled();
    // submitting again while asking sends nothing either
    submit(root);
    await flush();
    expect(send).not.toHaveBeenCalled();
  });

  it("Cancel sends nothing and leaves the form usable", async () => {
    const root = newRoot();
    const send = vi.fn(async () => []);
    renderSignin(root, popupDeps(send), { hasKey: true });
    fill(root);
    submit(root);
    await flush();
    (root.querySelector("#cancel") as HTMLButtonElement).click();
    expect(root.querySelector("#signin-confirm")).toBeNull();
    expect((root.querySelector("#signin-submit") as HTMLButtonElement).disabled).toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it("'Sign in and replace' sends replace: true", async () => {
    const root = newRoot();
    const send = vi.fn(async () => ({ ok: false, error: "invalid" }));
    renderSignin(root, popupDeps(send), { hasKey: true });
    fill(root);
    submit(root);
    await flush();
    (root.querySelector("#replace") as HTMLButtonElement).click();
    await flush();
    expect(send).toHaveBeenCalledWith({ type: "dney-signin", email: "me@example.com", password: PASSWORD, replace: true });
    expect(root.querySelector("#signin-error")!.textContent).toBe(P["S3.invalid"]);
  });

  it("the worker answering confirm_required shows S6 (never an error line)", async () => {
    const root = newRoot();
    renderSignin(root, popupDeps(async () => ({ ok: false, error: "confirm_required" })), { hasKey: false });
    submit(root);
    await flush();
    expect(root.querySelector("#signin-confirm")!.textContent).toBe(P["S6.confirm"]);
    expect(root.querySelector("#signin-error")).toBeNull();
  });
});

describe("popup: the S6 note and S12 (an old key that keeps working)", () => {
  const withLocal = (local: Record<string, unknown> | null, send: PopupDeps["send"] = vi.fn(async () => [])): PopupDeps => ({
    ...popupDeps(send, consumerWithKey),
    readLocal: async () => local,
  });
  // SCRUM-480: no longer reached from the status view (its "Sign in" link is gone);
  // renderSignin's keyHasNoId option is pinned directly.
  async function toS6(root: HTMLElement, deps: PopupDeps, keyHasNoId: boolean) {
    renderSignin(root, deps, { hasKey: true, keyHasNoId });
    fill(root);
    submit(root);
    await flush();
  }
  const expectSettingsLink = (node: Element) => {
    const a = [...node.querySelectorAll("a")] as HTMLAnchorElement[];
    expect(a.map((x) => [x.textContent, x.getAttribute("href"), x.target, x.rel])).toEqual([
      ["your dashboard's Settings", "https://dney.dev/settings", "_blank", "noopener noreferrer"],
    ]);
    expect(pinned.links.api_keys).toBe("https://dney.dev/settings");
  };

  it("saved key with NO stored id: the S6 note under S6, with the Settings link", async () => {
    const root = newRoot();
    await toS6(root, withLocal({ api_key: "pasted" }), true);
    const note = root.querySelector("#signin-confirm-note")!;
    expect(note.textContent).toBe(P["S6.note_no_id"]);
    expect(note.textContent).toBe("Your current key won't be revoked. It keeps working until you revoke it in your dashboard's Settings.");
    expect(note.previousElementSibling).toBe(root.querySelector("#signin-confirm"));
    expectSettingsLink(note);
  });

  it("saved key WITH a stored id: S6 without the note", async () => {
    const root = newRoot();
    await toS6(root, withLocal({ api_key: OLD_KEY, api_key_id: OLD_ID }), false);
    expect(root.querySelector("#signin-confirm")!.textContent).toBe(P["S6.confirm"]);
    expect(root.querySelector("#signin-confirm-note")).toBeNull();
    expect(root.textContent).not.toContain(P["S6.note_no_id"]);
  });

  const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, org_name: "Acme Learning", protections: "enforce", ...extra }) as Extract<SigninOutcome, { ok: true }>;

  it("S12 only when the worker reports the old key's revoke failed; after S11, with the Settings link", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps(), ok({ old_key_not_revoked: true }));
    const s12 = root.querySelector("#signin-not-revoked")!;
    expect(s12.textContent).toBe(P["S12.revoke_failed"]);
    expect(s12.textContent).toBe("Your previous key couldn't be revoked. It keeps working until you revoke it in your dashboard's Settings.");
    expect(s12.previousElementSibling).toBe(root.querySelector("#signin-org"));
    expectSettingsLink(s12);
  });

  it("no S12 after a successful revoke or on the no-id path (no flag)", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps(), ok());
    expect(root.querySelector("#signin-not-revoked")).toBeNull();
    expect(root.textContent).not.toContain(P["S12.revoke_failed"]);
  });

  it("end to end: revoke 500 -> S12 shown; revoke 204 -> none; no id -> none", async () => {
    for (const [local, revoke, shown] of [
      [{ api_key: OLD_KEY, api_key_id: OLD_ID }, status(500), true],
      [{ api_key: OLD_KEY, api_key_id: OLD_ID }, noContent(), false],
      [{ api_key: "pasted" }, null, false],
    ] as const) {
      const fake = installFakeChrome({ local: { ...local } });
      const f = routedFetch(happyRoutes(revoke ? { [`${KEYS}/${OLD_ID}`]: [revoke] } : {}));
      const out = (await handleSignin({ email: "a@b.co", password: PASSWORD, replace: true }, depsFor(fake, f.impl))) as Extract<SigninOutcome, { ok: true }>;
      const root = newRoot();
      renderStatus(root, consumerWithKey, popupDeps(), out);
      expect(!!root.querySelector("#signin-not-revoked")).toBe(shown);
      removeFakeChrome();
    }
  });
});

describe("popup: managed installs show no sign-in at all", () => {
  it("no form, no 'Sign in' anywhere, no sign-in message", async () => {
    const root = newRoot();
    const send = vi.fn(async () => []);
    expect(await mountPopup(root, popupDeps(send, managedState))).toBe("status");
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("#status-sign-in")).toBeNull();
    expect(root.querySelector("#sign-in")).toBeNull();
    expect(root.textContent).not.toContain("Sign in");
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "dney-signin" }));
  });
});
