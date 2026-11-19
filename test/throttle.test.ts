// SCRUM-171: a 429 must not look like a clean pass.
import { describe, it, expect, vi } from "vitest";
import { check, failSafe, retryAfterMs, MAX_THROTTLE_RETRIES, DEFAULT_RETRY_WAIT_MS } from "../src/lib/dney-client";
import { DEFAULT_CONFIG, RETRY_BUDGET_MS } from "../src/lib/config";
import { auditAction, badgeState, wentOutUnchecked, uncheckedBannerText } from "../src/lib/status";
import type { Config, Verdict } from "../src/lib/types";

const cfg = (over: Partial<Config> = {}): Config => ({ ...DEFAULT_CONFIG, api_key: "k", ...over });

function res(status: number, body: unknown = {}, headers: Record<string, string> = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (n: string) => headers[n] ?? headers[n.toLowerCase()] ?? null },
    json: async () => body,
  } as unknown as Response;
}
const allowed = () =>
  res(200, { action: "allowed", text: "hi", original_text: "hi", rails_triggered: [], latency_ms: 3 });
const throttled = (retryAfter = "1") => res(429, { detail: "rate limit" }, { "Retry-After": retryAfter });

/** Records the back-off waits instead of actually sleeping. */
function recorder() {
  const waits: number[] = [];
  return { waits, sleepImpl: async (ms: number) => void waits.push(ms) };
}

describe("retryAfterMs", () => {
  it("reads delta-seconds, the form asgard-services sends", () => {
    expect(retryAfterMs("2")).toBe(2000);
  });
  it("reads an HTTP-date", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(retryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now)).toBe(5000);
  });
  it("falls back when the header is missing or junk", () => {
    expect(retryAfterMs(null)).toBe(DEFAULT_RETRY_WAIT_MS);
    expect(retryAfterMs("soon")).toBe(DEFAULT_RETRY_WAIT_MS);
  });
  it("clamps — a remote party does not get to freeze the composer", () => {
    expect(retryAfterMs("3600")).toBe(30000);
    expect(retryAfterMs("0")).toBe(1000);
    expect(retryAfterMs("-5")).toBe(1000);
  });
});

describe("check — 429 then success", () => {
  it("waits out the throttle and returns the real verdict", async () => {
    const { waits, sleepImpl } = recorder();
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? throttled("2") : allowed()));
    const v = await check({ config: cfg(), direction: "input", text: "hi", fetchImpl, sleepImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([2000]); // honoured Retry-After, did not hammer
    expect(v.action).toBe("allowed");
    expect(v.failed).toBe(false);
    expect(v.throttled).toBe(false);
  });

  it("retries a throttled OUTPUT check too — a throttle is not a network failure", async () => {
    const { sleepImpl } = recorder();
    let n = 0;
    const fetchImpl = vi.fn(async () => (++n === 1 ? throttled("1") : allowed()));
    const v = await check({ config: cfg(), direction: "output", text: "hi", fetchImpl, sleepImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(v.failed).toBe(false);
  });

  it("still does not retry OUTPUT on a network error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("down");
    });
    await check({ config: cfg(), direction: "output", text: "x", fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("check — 429 exhausting the retries", () => {
  it("gives up after MAX_THROTTLE_RETRIES and marks the verdict throttled", async () => {
    const { waits, sleepImpl } = recorder();
    const fetchImpl = vi.fn(async () => throttled("1"));
    const v = await check({ config: cfg(), direction: "input", text: "x", fetchImpl, sleepImpl });
    expect(waits.length).toBe(MAX_THROTTLE_RETRIES);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_THROTTLE_RETRIES + 1);
    expect(v.failed).toBe(true);
    expect(v.throttled).toBe(true);
  });

  it("never waits longer than the retry budget, whatever the server asks for", async () => {
    const { waits, sleepImpl } = recorder();
    const fetchImpl = vi.fn(async () => throttled("30")); // clamped to 30s, over budget
    const v = await check({ config: cfg(), direction: "input", text: "x", fetchImpl, sleepImpl });
    expect(waits.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(RETRY_BUDGET_MS);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // gave up immediately rather than sleeping 30s
    expect(v.throttled).toBe(true);
  });

  it("fail_closed blocks a throttle, with a message naming the rate limit", async () => {
    const { sleepImpl } = recorder();
    const fetchImpl = vi.fn(async () => throttled("1"));
    const v = await check({ config: cfg({ fail_policy: "closed" }), direction: "input", text: "x", fetchImpl, sleepImpl });
    expect(v.action).toBe("blocked");
    expect(v.throttled).toBe(true);
    expect(v.text).toMatch(/rate-limit/i);
  });
});

describe("a throttled check is never reported as allowed", () => {
  const throttledVerdict: Verdict = { ...failSafe(cfg(), "text", true) };

  it("fail-open lets the text through but keeps failed+throttled set", () => {
    expect(throttledVerdict.action).toBe("allowed"); // the message IS sent — fail-open
    expect(throttledVerdict.failed).toBe(true); // but never as a clean pass
    expect(throttledVerdict.throttled).toBe(true);
  });

  it("is audited as 'throttled', not 'allowed'", () => {
    expect(auditAction(throttledVerdict)).toBe("throttled");
  });

  it("badges amber, not healthy — the v0.1.2 signal, reused", () => {
    expect(badgeState(throttledVerdict)).toBe("degraded");
    expect(badgeState({ ...throttledVerdict, failed: false, throttled: true })).toBe("degraded");
  });

  it("a real clean pass is still healthy/allowed", () => {
    const clean: Verdict = { action: "allowed", text: "t", original_text: "t", rails_triggered: [], latency_ms: 1, failed: false, throttled: false };
    expect(badgeState(clean)).toBe("healthy");
    expect(auditAction(clean)).toBe("allowed");
    expect(wentOutUnchecked(clean)).toBe(false);
  });

  it("tells the user, in words, that the message went out unchecked", () => {
    expect(wentOutUnchecked(throttledVerdict)).toBe(true);
    expect(uncheckedBannerText(throttledVerdict)).toMatch(/rate-limit/i);
    expect(uncheckedBannerText(throttledVerdict)).toMatch(/without being checked/i);
    expect(uncheckedBannerText(null)).toMatch(/without being checked/i);
  });

  it("a block is not an 'unchecked send' — the check completed", () => {
    const blocked: Verdict = { ...failSafe(cfg({ fail_policy: "closed" }), "t", true) };
    expect(wentOutUnchecked(blocked)).toBe(false);
    expect(badgeState(blocked)).toBe("degraded");
  });
});
