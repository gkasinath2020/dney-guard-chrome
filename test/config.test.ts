import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_CONFIG,
  MANAGED_READ_FAILED,
  coerceNumericField,
  isManagedInstall,
  loadConfig,
  loadConfigState,
  lockedKeys,
  mergeConfig,
} from "../src/lib/config";


describe("consumer install (no managed policy): defaults < sync, unchanged", () => {
  it("s303-06: consumer defaults stay fail-open / enforce_soft", () => {
    expect(mergeConfig(null, null)).toEqual(DEFAULT_CONFIG);
    expect(mergeConfig({}, null)).toEqual(DEFAULT_CONFIG); // Chrome returns {} with no policy
    expect(DEFAULT_CONFIG.fail_policy).toBe("open");
    expect(DEFAULT_CONFIG.output_mode).toBe("enforce_soft");
  });

  it("sync still configures a consumer install, except the key, which comes from local only (SCRUM-395)", () => {
    const c = mergeConfig({}, { fail_policy: "closed", api_key: "k", input_mode: "monitor" });
    expect(c).toMatchObject({ fail_policy: "closed", api_key: "", input_mode: "monitor" });
    expect(mergeConfig({}, { api_key: "k" }, { api_key: "local" }).api_key).toBe("local");
    expect(lockedKeys({})).toEqual([]);
  });
});

describe("managed install (SCRUM-303): policy > closed defaults; sync ignored", () => {
  it("s303-01: a policy that sets only api_key gets the closed defaults", () => {
    const c = mergeConfig({ api_key: "k" }, null);
    expect(c).toMatchObject({
      api_key: "k",
      fail_policy: "closed",
      output_mode: "enforce_hard",
      input_mode: "enforce",
      allow_override: false,
    });
  });

  it("s303-02: the school's explicit fail_policy 'open' wins", () => {
    expect(mergeConfig({ api_key: "k", fail_policy: "open" }, null).fail_policy).toBe("open");
  });

  it.each([
    ["fail_policy", "open"],
    ["input_mode", "off"],
    ["output_mode", "off"],
    ["output_mode", "monitor"],
    ["allow_override", true],
    ["dney_base_url", "https://evil.example"],
    ["api_key", "a-students-own-key"],
  ] as const)("s303-03: a student's sync %s=%s is ignored", (key, value) => {
    const c = mergeConfig({ api_key: "k" }, { [key]: value });
    expect(c[key]).toBe(mergeConfig({ api_key: "k" }, null)[key]);
  });

  it("s303-04: NO field is user-editable on a managed install (stated policy)", () => {
    const sync = {
      chunk_size: 1,
      chunk_interval_ms: 999999,
      input_timeout_ms: 1000,
      output_timeout_ms: 1000,
      audit_buffer_size: 1,
    };
    expect(mergeConfig({ api_key: "k" }, sync)).toEqual(mergeConfig({ api_key: "k" }, null));
    expect(lockedKeys({ api_key: "k" }).sort()).toEqual(Object.keys(DEFAULT_CONFIG).sort());
  });

  it("s303-05: a managed read that FAILED is managed: closed, and sync ignored", () => {
    const c = mergeConfig(MANAGED_READ_FAILED, { fail_policy: "open", input_mode: "off" });
    expect(isManagedInstall(MANAGED_READ_FAILED)).toBe(true);
    expect(c).toMatchObject({ fail_policy: "closed", input_mode: "enforce", output_mode: "enforce_hard" });
    expect(lockedKeys(MANAGED_READ_FAILED).length).toBe(Object.keys(DEFAULT_CONFIG).length);
  });

  it("an invalid policy value falls back to the closed default, not to sync or consumer", () => {
    const c = mergeConfig({ api_key: "k", fail_policy: "opn" as never, allow_override: "yes" as never }, {
      fail_policy: "open",
    });
    expect(c.fail_policy).toBe("closed");
    expect(c.allow_override).toBe(false);
  });

  it("unknown policy keys are dropped", () => {
    const c = mergeConfig({ api_key: "k", ...({ surprise: 1 } as object) }, null);
    expect("surprise" in c).toBe(false);
  });
});

describe("loadConfig / loadConfigState through chrome.storage", () => {
  function mockStorage(managed: () => Promise<unknown>, sync: object = {}) {
    (globalThis as { chrome?: unknown }).chrome = {
      storage: { managed: { get: managed }, sync: { get: async () => sync } },
    };
  }
  afterEach(() => {
    delete (globalThis as { chrome?: unknown }).chrome;
  });

  it("no policy (Chrome resolves {}) is a consumer install", async () => {
    mockStorage(async () => ({}), { fail_policy: "closed" });
    const st = await loadConfigState();
    expect(st).toMatchObject({ managed: false, managedReadFailed: false });
    expect(st.config.fail_policy).toBe("closed"); // the consumer's own choice
  });

  it("s303-05: a rejected managed read reports managedReadFailed and loads closed", async () => {
    mockStorage(async () => Promise.reject(new Error("storage error")), { fail_policy: "open" });
    const st = await loadConfigState();
    expect(st).toMatchObject({ managed: true, managedReadFailed: true });
    expect(st.config).toMatchObject({ fail_policy: "closed", output_mode: "enforce_hard" });
    expect((await loadConfig()).fail_policy).toBe("closed");
  });

  it("s303-11: a managed install with no key loads (closed) and reports managed", async () => {
    mockStorage(async () => ({ fail_policy: "closed" }));
    const st = await loadConfigState();
    expect(st.managed).toBe(true);
    expect(st.config.api_key).toBe("");
  });
});

describe("numeric option coercion", () => {
  // The options page stored every field as a raw string, so a timeout typed into
  // a number input would have persisted as "30000". These also guard the floor:
  // a 0 would make every check time out instantly and, under fail_policy "open",
  // silently pass all traffic unchecked — a disabled guardrail that still looks on.
  it("parses a valid value to a number", () => {
    expect(coerceNumericField("input_timeout_ms", "30000")).toBe(30000);
  });

  it("falls back to the default for unparseable input", () => {
    expect(coerceNumericField("input_timeout_ms", "abc")).toBe(DEFAULT_CONFIG.input_timeout_ms);
    expect(coerceNumericField("input_timeout_ms", "")).toBe(DEFAULT_CONFIG.input_timeout_ms);
  });

  it("rejects values outside the safe range rather than persisting them", () => {
    expect(coerceNumericField("input_timeout_ms", "0")).toBe(DEFAULT_CONFIG.input_timeout_ms);
    expect(coerceNumericField("input_timeout_ms", "-5000")).toBe(DEFAULT_CONFIG.input_timeout_ms);
    expect(coerceNumericField("input_timeout_ms", "999999")).toBe(DEFAULT_CONFIG.input_timeout_ms);
  });

  it("defaults the input timeout above the measured p90 of a clean check", () => {
    // Clean inputs measured p50 17.1s / max 33.6s against a fully-enforcing org.
    // Anything at or below ~15s fails open on the majority of ordinary messages.
    expect(DEFAULT_CONFIG.input_timeout_ms).toBeGreaterThanOrEqual(30000);
  });
});
