// SCRUM-292, extension side: student sign-in and the check around it.
// The real studentCredential / guardedCheck run; chrome.identity, fetch, session
// storage, the clock and the nonce are injected.
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG, mergeConfig } from "../src/lib/config";
import { FAIL_MESSAGES } from "../src/lib/dney-client";
import { guardedCheck } from "../src/lib/guarded-check";
import {
  REFRESH_MARGIN_MS,
  idTokenNonce,
  isStudentMode,
  studentCredential,
  type StudentAuthDeps,
} from "../src/lib/student-auth";
import type { Config, Verdict } from "../src/lib/types";

const b64url = (o: object) =>
  btoa(JSON.stringify(o)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const idToken = (nonce: string) => `${b64url({ alg: "RS256" })}.${b64url({ nonce, sub: "1" })}.sig`;

const school = (over: Partial<Config> = {}): Config =>
  mergeConfig({ enrolment_token: "dne_class3a", ...over }, null);

function harness(opts: {
  exchange?: (body: { id_token: string; enrolment_token: string }) => Response | Promise<Response>;
  flow?: (d: { url: string; interactive: boolean }) => Promise<string | undefined>;
  now?: number;
} = {}) {
  let t = opts.now ?? 1_000_000;
  let n = 0;
  const store = new Map<string, unknown>();
  const exchanges: { id_token: string; enrolment_token: string }[] = [];
  const exchangeHeaders: Record<string, string>[] = [];
  const flows: { url: string; interactive: boolean }[] = [];
  const deps: StudentAuthDeps = {
    clientId: "dney-client.apps.googleusercontent.com",
    redirectUrl: () => "https://ext-id.chromiumapp.org/",
    nonce: () => `nonce-${++n}`,
    now: () => t,
    storageGet: async (k) => store.get(k) as never,
    storageSet: async (k, v) => void (v === null ? store.delete(k) : store.set(k, v)),
    launchWebAuthFlow: async (d) => {
      flows.push(d);
      if (opts.flow) return opts.flow(d);
      const nonce = new URL(d.url).searchParams.get("nonce")!;
      return `https://ext-id.chromiumapp.org/#id_token=${idToken(nonce)}`;
    },
    fetchImpl: (async (_url: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      exchanges.push(body);
      exchangeHeaders.push(Object.fromEntries(new Headers(init?.headers).entries()));
      if (opts.exchange) return opts.exchange(body);
      return new Response(JSON.stringify({ credential: `dsc_${exchanges.length}`, expires_in: 86400 }), {
        status: 200,
      });
    }) as typeof fetch,
  };
  return { deps, store, exchanges, exchangeHeaders, flows, advance: (ms: number) => (t += ms) };
}

describe("student mode", () => {
  it("is on exactly when the managed policy carries an enrolment token", () => {
    expect(isStudentMode(school())).toBe(true);
    expect(isStudentMode(mergeConfig({ api_key: "asg_x" }, null))).toBe(false);
    expect(isStudentMode(DEFAULT_CONFIG)).toBe(false);
  });

  it("a student cannot turn it on or off from sync on a managed install", () => {
    expect(mergeConfig({ api_key: "asg_x" }, { enrolment_token: "dne_mine" }).enrolment_token).toBe("");
    expect(mergeConfig({ enrolment_token: "dne_class" }, { enrolment_token: "" }).enrolment_token).toBe(
      "dne_class",
    );
  });
});

describe("studentCredential", () => {
  it("signs in silently (prompt=none), sends only the ID token + enrolment token, stores the credential", async () => {
    const h = harness();
    const r = await studentCredential(school(), { deps: h.deps });
    expect(r).toEqual({ ok: true, credential: "dsc_1" });
    expect(h.flows).toHaveLength(1);
    const url = new URL(h.flows[0].url);
    expect(h.flows[0].interactive).toBe(false);
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      client_id: "dney-client.apps.googleusercontent.com",
      response_type: "id_token",
      scope: "openid email",
      prompt: "none",
      nonce: "nonce-1",
    });
    expect(Object.keys(h.exchanges[0]).sort()).toEqual(["enrolment_token", "id_token"]);
    expect(h.exchanges[0].enrolment_token).toBe("dne_class3a");
    const stored = [...h.store.values()][0] as { credential: string };
    expect(JSON.stringify(stored)).not.toContain(h.exchanges[0].id_token); // the ID token is not kept
  });

  it("reuses the stored credential until REFRESH_MARGIN before expiry, then refreshes", async () => {
    const h = harness();
    await studentCredential(school(), { deps: h.deps });
    h.advance(86400 * 1000 - REFRESH_MARGIN_MS - 1);
    expect(await studentCredential(school(), { deps: h.deps })).toEqual({ ok: true, credential: "dsc_1" });
    h.advance(2);
    expect(await studentCredential(school(), { deps: h.deps })).toEqual({ ok: true, credential: "dsc_2" });
  });

  it("the exchange never carries a credential or key header (Assay: the server's route guard would 403 it)", async () => {
    const h = harness();
    await studentCredential(school({ api_key: "asg_should_not_be_sent" }), { deps: h.deps });
    await studentCredential(school(), { deps: h.deps, force: true }); // the 24 h re-exchange
    expect(h.exchangeHeaders).toHaveLength(2);
    for (const hdrs of h.exchangeHeaders) {
      expect(Object.keys(hdrs)).toEqual(["content-type"]);
    }
  });

  it("force discards the stored credential (the server said 401)", async () => {
    const h = harness();
    await studentCredential(school(), { deps: h.deps });
    expect(await studentCredential(school(), { deps: h.deps, force: true })).toEqual({
      ok: true,
      credential: "dsc_2",
    });
  });

  it("a reply carrying someone else's nonce is not accepted", async () => {
    const h = harness({ flow: async () => `https://ext-id.chromiumapp.org/#id_token=${idToken("other")}` });
    expect(await studentCredential(school(), { deps: h.deps })).toEqual({ ok: false, cause: "signed_out" });
    expect(h.exchanges).toHaveLength(0);
  });

  it("falls back to ONE interactive attempt when silent sign-in needs interaction", async () => {
    const h = harness({
      flow: async (d) => {
        if (!d.interactive) throw new Error("User interaction required.");
        const nonce = new URL(d.url).searchParams.get("nonce")!;
        return `https://ext-id.chromiumapp.org/#id_token=${idToken(nonce)}`;
      },
    });
    expect((await studentCredential(school(), { deps: h.deps })).ok).toBe(true);
    expect(h.flows.map((f) => f.interactive)).toEqual([false, true]);
  });

  it.each([
    [403, "not_enrolled"],
    [401, "signed_out"],
    [429, "unavailable"],
    [503, "unavailable"],
  ] as const)("exchange HTTP %i -> %s, and nothing stored", async (status, cause) => {
    const h = harness({ exchange: () => new Response("{}", { status }) });
    expect(await studentCredential(school(), { deps: h.deps })).toEqual({ ok: false, cause });
    expect(h.store.size).toBe(0);
  });

  it("a network error on the exchange is unavailable", async () => {
    const h = harness({ exchange: () => Promise.reject(new TypeError("Failed to fetch")) });
    expect(await studentCredential(school(), { deps: h.deps })).toEqual({ ok: false, cause: "unavailable" });
  });

  it("no client id or no enrolment token is 'not set up', and Google is not contacted", async () => {
    const h = harness();
    expect(await studentCredential(school(), { deps: { ...h.deps, clientId: "" } })).toEqual({
      ok: false,
      cause: "not_set_up",
    });
    expect(await studentCredential(school({ enrolment_token: "" }), { deps: h.deps })).toEqual({
      ok: false,
      cause: "not_set_up",
    });
    expect(h.flows).toHaveLength(0);
  });

  it("idTokenNonce reads the nonce and survives garbage", () => {
    expect(idTokenNonce(idToken("abc"))).toBe("abc");
    expect(idTokenNonce("garbage")).toBeNull();
    expect(idTokenNonce("a.!!!.c")).toBeNull();
  });
});

describe("guardedCheck (s292-19, s303-08)", () => {
  const ok: Verdict = { action: "allowed", text: "hi", original_text: "hi", rails_triggered: [], latency_ms: 1, failed: false };
  const signedOut: Verdict = { ...ok, action: "blocked", failed: true, cause: "signed_out" };

  it("a failed sign-in blocks with its cause and never sends the text", async () => {
    const check = vi.fn();
    for (const cause of ["not_set_up", "not_enrolled", "signed_out", "unavailable"] as const) {
      const v = await guardedCheck(school(), { direction: "input", text: "SECRET" }, {
        credential: async () => ({ ok: false, cause }),
        check,
      });
      expect(v).toMatchObject({ action: "blocked", failed: true, cause });
      expect(v.text).toBe(FAIL_MESSAGES[cause]);
      expect(v.text).not.toContain("SECRET");
    }
    expect(check).not.toHaveBeenCalled();
  });

  it("checks with the student credential as the key", async () => {
    const check = vi.fn(async () => ok);
    await guardedCheck(school(), { direction: "input", text: "hi" }, {
      credential: async () => ({ ok: true, credential: "dsc_live" }),
      check,
    });
    expect((check.mock.calls[0] as unknown as [{ config: Config }])[0].config.api_key).toBe("dsc_live");
  });

  it("on 401 it re-exchanges ONCE and retries, then gives up blocked", async () => {
    const creds = vi.fn(async (_c: Config, o?: { force?: boolean }) => ({
      ok: true as const,
      credential: o?.force ? "dsc_new" : "dsc_old",
    }));
    const check = vi.fn(async ({ config }: { config: Config }) => (config.api_key === "dsc_new" ? ok : signedOut));
    expect(await guardedCheck(school(), { direction: "input", text: "hi" }, { credential: creds, check })).toBe(ok);
    expect(creds.mock.calls.map((c) => c[1]?.force)).toEqual([false, true]);

    const always401 = vi.fn(async () => signedOut);
    const v = await guardedCheck(school(), { direction: "input", text: "hi" }, { credential: creds, check: always401 });
    expect(v).toMatchObject({ action: "blocked", cause: "signed_out" });
    expect(always401).toHaveBeenCalledTimes(2);
  });

  it("non-student installs are untouched: the configured key, no sign-in", async () => {
    const creds = vi.fn();
    const check = vi.fn(async () => ok);
    await guardedCheck(mergeConfig({ api_key: "asg_x" }, null), { direction: "input", text: "hi" }, {
      credential: creds,
      check,
    });
    expect(creds).not.toHaveBeenCalled();
    expect((check.mock.calls[0] as unknown as [{ config: Config }])[0].config.api_key).toBe("asg_x");
  });
});

describe("the PRODUCTION wiring (default deps), not an injected fake (Assay Z1)", () => {
  function chromeMock() {
    const areas = { session: new Map<string, unknown>(), local: new Map<string, unknown>(), sync: new Map<string, unknown>() };
    const area = (m: Map<string, unknown>) => ({
      get: vi.fn(async (k: string) => (m.has(k) ? { [k]: m.get(k) } : {})),
      set: vi.fn(async (o: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(o)) m.set(k, v);
      }),
      remove: vi.fn(async (k: string) => void m.delete(k)),
    });
    const storage = { session: area(areas.session), local: area(areas.local), sync: area(areas.sync) };
    const identity = {
      getRedirectURL: () => "https://ext-id.chromiumapp.org/",
      launchWebAuthFlow: vi.fn(async (d: { url: string }) => {
        const nonce = new URL(d.url).searchParams.get("nonce")!;
        return `https://ext-id.chromiumapp.org/#id_token=${idToken(nonce)}`;
      }),
    };
    return { areas, storage, identity };
  }

  it("with no Google client ID built in, never touches chrome.identity (0.2.0 omits the permission)", async () => {
    const m = chromeMock();
    // chrome.identity is ABSENT, as it is when the manifest does not declare it.
    vi.stubGlobal("chrome", { storage: m.storage });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const r = await studentCredential(school(), { deps: { clientId: "" } });
      expect(r).toEqual({ ok: false, cause: "not_set_up" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the credential in chrome.storage.SESSION only; the ID token is written nowhere", async () => {
    const m = chromeMock();
    vi.stubGlobal("chrome", { storage: m.storage, identity: m.identity });
    let sentIdToken = "";
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
        sentIdToken = JSON.parse(String(init?.body)).id_token;
        return new Response(JSON.stringify({ credential: "dsc_real", expires_in: 86400 }), { status: 200 });
      }),
    );
    try {
      // Only the client id is supplied (it is a build-time define, "" in tests);
      // storage, identity, fetch, clock and nonce are the real defaults.
      const r = await studentCredential(school(), { deps: { clientId: "dney-client" } });
      expect(r).toEqual({ ok: true, credential: "dsc_real" });
      expect(m.storage.session.set).toHaveBeenCalledTimes(1);
      expect(m.storage.local.set).not.toHaveBeenCalled();
      expect(m.storage.sync.set).not.toHaveBeenCalled();
      const everything = JSON.stringify([...m.areas.session, ...m.areas.local, ...m.areas.sync]);
      expect(everything).toContain("dsc_real");
      expect(sentIdToken.length).toBeGreaterThan(10);
      expect(everything).not.toContain(sentIdToken);
      // and the stored credential is read back from SESSION on the next call
      const again = await studentCredential(school(), { deps: { clientId: "dney-client" } });
      expect(again).toEqual({ ok: true, credential: "dsc_real" });
      expect(m.storage.session.get).toHaveBeenCalled();
      expect(m.storage.local.get).not.toHaveBeenCalled();
      expect(m.identity.launchWebAuthFlow).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("GOOGLE_CLIENT_ID is empty unless a build defines it, and empty means no Google contact", async () => {
    const { GOOGLE_CLIENT_ID } = await import("../src/lib/student-auth");
    expect(GOOGLE_CLIENT_ID).toBe("");
    const m = chromeMock();
    vi.stubGlobal("chrome", { storage: m.storage, identity: m.identity });
    try {
      expect(await studentCredential(school())).toEqual({ ok: false, cause: "not_set_up" });
      expect(m.identity.launchWebAuthFlow).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("sign-in pending (Assay: the check raced the bridge deadline and failed open)", () => {
  it("a check waits at most signInWaitMs, then answers 'signing in' BLOCKED (managed)", async () => {
    const never = () => new Promise<never>(() => {});
    const check = vi.fn();
    const t0 = Date.now();
    const v = await guardedCheck(school(), { direction: "input", text: "42 Wallaby Street" }, {
      credential: never as never,
      check,
      signInWaitMs: 20,
    });
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(v).toMatchObject({ action: "blocked", failed: true, cause: "signing_in" });
    expect(v.text).toBe(FAIL_MESSAGES.signing_in);
    expect(check).not.toHaveBeenCalled();
  });

  it("the default wait is well inside the content bridge's deadline", async () => {
    const { SIGN_IN_WAIT_MS } = await import("../src/lib/guarded-check");
    const { bridgeDeadlineMs } = await import("../src/lib/config");
    expect(SIGN_IN_WAIT_MS).toBeLessThan(bridgeDeadlineMs({ input_timeout_ms: 1000 }));
  });

  it("concurrent checks share ONE Google sign-in (single-flight)", async () => {
    let release!: (v: string) => void;
    const h = harness({
      flow: (d) =>
        new Promise((r) => {
          const nonce = new URL(d.url).searchParams.get("nonce")!;
          release = () => r(`https://ext-id.chromiumapp.org/#id_token=${idToken(nonce)}`);
        }),
    });
    const all = Promise.all([1, 2, 3].map(() => studentCredential(school(), { deps: h.deps })));
    await new Promise((r) => setTimeout(r, 5));
    release("go");
    const results = await all;
    expect(h.flows).toHaveLength(1);
    expect(new Set(results.map((r) => (r.ok ? r.credential : "x")))).toEqual(new Set(["dsc_1"]));
  });
});
