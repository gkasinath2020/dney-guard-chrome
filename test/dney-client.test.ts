import { describe, it, expect, vi } from "vitest";
import { check, failSafe, FAIL_MESSAGES } from "../src/lib/dney-client";
import { DEFAULT_CONFIG } from "../src/lib/config";
import type { Config } from "../src/lib/types";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, api_key: "k", ...over });

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("dney-client — verdicts", () => {
  it("passes through an allowed verdict", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
      jsonResponse({ action: "allowed", text: "hi", original_text: "hi", rails_triggered: [], latency_ms: 3 }),
    );
    const v = await check({ config: cfg(), direction: "input", text: "hi", fetchImpl });
    expect(v.action).toBe("allowed");
    expect(v.failed).toBe(false);
    // Sends to /api/v1/check with the api key.
    const [url, init] = fetchImpl.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/check$/);
    expect(init?.headers).toMatchObject({ "x-api-key": "k" });
  });

  it("returns a blocked verdict with the block message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ action: "blocked", text: "nope", original_text: "x", rails_triggered: ["r"], latency_ms: 9 }),
    );
    const v = await check({ config: cfg(), direction: "input", text: "x", fetchImpl });
    expect(v.action).toBe("blocked");
    expect(v.text).toBe("nope");
    expect(v.rails_triggered).toEqual(["r"]);
  });
});

describe("dney-client — fail-safe (G3)", () => {
  it("fail_open allows the original text on error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const v = await check({ config: cfg({ fail_policy: "open" }), direction: "output", text: "keep me", fetchImpl });
    expect(v.action).toBe("allowed");
    expect(v.text).toBe("keep me");
    expect(v.failed).toBe(true);
  });

  it("fail_closed blocks on error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("network down");
    });
    const v = await check({ config: cfg({ fail_policy: "closed" }), direction: "output", text: "x", fetchImpl });
    expect(v.action).toBe("blocked");
    expect(v.failed).toBe(true);
  });

  it("non-2xx triggers fail-safe", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, false, 500));
    const v = await check({ config: cfg({ fail_policy: "open" }), direction: "input", text: "t", fetchImpl });
    expect(v.failed).toBe(true);
    expect(v.action).toBe("allowed");
  });

  it("failSafe helper is deterministic", () => {
    expect(failSafe(cfg({ fail_policy: "open" }), "t").action).toBe("allowed");
    expect(failSafe(cfg({ fail_policy: "closed" }), "t").action).toBe("blocked");
  });
});

describe("dney-client — retry policy", () => {
  it("retries once on INPUT (fails then succeeds)", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n++;
      if (n === 1) throw new Error("transient");
      return jsonResponse({ action: "allowed", text: "ok", original_text: "ok", rails_triggered: [], latency_ms: 1 });
    });
    const v = await check({ config: cfg(), direction: "input", text: "ok", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(v.action).toBe("allowed");
    expect(v.failed).toBe(false);
  });

  it("does NOT retry on OUTPUT (one attempt, then fail-safe)", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("transient");
    });
    await check({ config: cfg(), direction: "output", text: "x", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("SCRUM-303: closed-policy causes and student-facing messages", () => {
  const managed = (over: Partial<Config> = {}) =>
    cfg({ fail_policy: "closed", output_mode: "enforce_hard", api_key: "dsc_x", ...over });
  const res = (status: number, body: object = {}) =>
    ({ ok: status < 300, status, json: async () => body, headers: { get: () => null } }) as unknown as Response;
  const IDENTITY = ["ada", "@", "stu_", "dsc_", "asg_"];

  it("s303-11: no key -> blocked 'not set up', and nothing is sent", async () => {
    const fetchImpl = vi.fn();
    const v = await check({ config: managed({ api_key: "" }), direction: "input", text: "hi", fetchImpl });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(v).toMatchObject({ action: "blocked", failed: true, text: FAIL_MESSAGES.not_set_up });
  });

  it("a consumer install with no key is unchanged: allowed, failed", async () => {
    const v = await check({ config: cfg({ fail_policy: "open", api_key: "" }), direction: "input", text: "hi", fetchImpl: vi.fn() });
    expect(v).toMatchObject({ action: "allowed", failed: true, text: "hi" });
  });

  it.each([
    [401, "signed_out"],
    [403, "refused"],
  ] as const)("s303-08: HTTP %i under closed (student mode) -> blocked with its message, no retry", async (status, cause) => {
    const fetchImpl = vi.fn(async () =>
      res(status, { detail: "This API key's group no longer exists, so the key cannot be used." }),
    );
    // Student mode: guardedCheck passes the config with its enrolment token intact.
    const v = await check({ config: managed({ enrolment_token: "class-token" }), direction: "input", text: "hi", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(v).toMatchObject({ action: "blocked", failed: true, text: FAIL_MESSAGES[cause] });
    for (const bit of IDENTITY) expect(v.text.toLowerCase()).not.toContain(bit);
  });

  it.each([
    ["input", "timeout"],
    ["output", "timeout"],
    ["input", "5xx"],
    ["output", "5xx"],
    ["input", "network"],
    ["output", "network"],
  ] as const)("s303-07: %s %s under closed -> blocked, the text never passes", async (direction, kind) => {
    const fetchImpl = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      if (kind === "5xx") return res(503);
      if (kind === "network") throw new TypeError("Failed to fetch");
      return new Promise<Response>((_, reject) =>
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))),
      );
    });
    const v = await check({
      config: managed({ input_timeout_ms: 20, output_timeout_ms: 20 }),
      direction,
      text: "SECRET-UNCHECKED",
      fetchImpl,
    });
    expect(v.action).toBe("blocked");
    expect(v.text).not.toContain("SECRET-UNCHECKED");
    expect(v.failed).toBe(true);
  });

  it("FAIL_MESSAGES never contain an identity marker", () => {
    for (const m of Object.values(FAIL_MESSAGES))
      for (const bit of IDENTITY) expect(m.toLowerCase()).not.toContain(bit);
  });
});
