/**
 * SCRUM-171 QA — coverage beyond test/throttle.test.ts.
 *
 * The MR's own suite covers Retry-After parsing, retry/budget bounds in both
 * directions, and the "never reported as a clean pass" rule. These are the
 * things it does not cover.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { retryAfterMs, check } from "../src/lib/dney-client";
import {
  bridgeDeadlineMs,
  DEFAULT_CONFIG,
  MAX_BRIDGE_DEADLINE_MS,
  MAX_INPUT_TIMEOUT_MS,
  RETRY_BUDGET_MS,
} from "../src/lib/config";
import { badgeState, auditAction, wentOutUnchecked } from "../src/lib/status";
import type { Verdict } from "../src/lib/types";

afterEach(() => vi.restoreAllMocks());

describe("Retry-After parsing — hostile and malformed inputs", () => {
  it("never returns a negative or zero wait, whatever the header says", () => {
    for (const h of ["-5", "0", "-0", "  -120  "]) {
      const ms = retryAfterMs(h);
      expect(ms, `header ${h}`).toBeGreaterThan(0);
    }
  });

  it("treats an HTTP-date already in the past as a floor, not a negative wait", () => {
    const past = new Date(Date.now() - 60_000).toUTCString();
    const ms = retryAfterMs(past);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(30_000);
  });

  it("survives junk without throwing", () => {
    for (const h of ["", "soon", "NaN", "1e999", "٣٠", "12,5"]) {
      expect(() => retryAfterMs(h), `header ${h}`).not.toThrow();
    }
  });

  it("clamps an absurd server demand rather than freezing the composer", () => {
    const ms = retryAfterMs("86400");
    expect(ms).toBeLessThanOrEqual(30_000);
  });
});

describe("status reporting invariant, exhaustively", () => {
  // The defect this ticket exists for: an incomplete check reading as a clean pass.
  const actions = ["allowed", "blocked", "modified"] as const;
  it("no combination of flags ever reports an incomplete check as healthy/allowed", () => {
    for (const action of actions) {
      for (const throttled of [true, false]) {
        for (const failed of [true, false]) {
          const v = { action, throttled, failed } as unknown as Verdict;
          const incomplete = throttled || failed;
          if (!incomplete) continue;
          expect(badgeState(v), `${action}/${throttled}/${failed}`).not.toBe("healthy");
          expect(auditAction(v), `${action}/${throttled}/${failed}`).not.toBe("allowed");
        }
      }
    }
  });

  it("a completed clean pass is still healthy — the fix must not badge everything amber", () => {
    const v = { action: "allowed", throttled: false, failed: false } as unknown as Verdict;
    expect(badgeState(v)).toBe("healthy");
    expect(auditAction(v)).toBe("allowed");
    expect(wentOutUnchecked(v)).toBe(false);
  });
});

describe("the bridge deadline must cover what the client may legitimately spend", () => {
  // main.ts recomputes the deadline from the USER's config. page-hook.ts cannot
  // read storage, so it is pinned to DEFAULT_CONFIG. Both guard the same check.
  const clientWorstCaseMs = (cfg: typeof DEFAULT_CONFIG) =>
    cfg.input_timeout_ms + RETRY_BUDGET_MS;

  it("holds for the default config", () => {
    expect(bridgeDeadlineMs(DEFAULT_CONFIG)).toBeGreaterThan(clientWorstCaseMs(DEFAULT_CONFIG));
  });

  it("page-hook's standing deadline still covers a user-raised input timeout", () => {
    // input_timeout_ms is user-editable up to 120000 (config bounds).
    const userCfg = { ...DEFAULT_CONFIG, input_timeout_ms: 60_000 };
    const pageHookDeadline = MAX_BRIDGE_DEADLINE_MS; // what page-hook.ts starts with
    expect(
      pageHookDeadline,
      "page-hook gives up before a legitimate check can finish, failing open silently",
    ).toBeGreaterThan(clientWorstCaseMs(userCfg));
  });

  it("covers the SLOWEST config the options UI will save, not just a plausible one", () => {
    const maxCfg = { ...DEFAULT_CONFIG, input_timeout_ms: MAX_INPUT_TIMEOUT_MS };
    expect(MAX_BRIDGE_DEADLINE_MS).toBeGreaterThan(clientWorstCaseMs(maxCfg));
  });
});

describe("privacy: the throttle path must not leak prompt text", () => {
  it("logs the failure without echoing the prompt", async () => {
    const secret = "PROMPT-CANARY-9c2f-do-not-log";
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const fetchImpl = async () =>
      new Response("", { status: 429, headers: { "Retry-After": "1" } }) as unknown as Response;
    const cfg = { ...DEFAULT_CONFIG, api_key: "asg_test", fail_policy: "open" as const };
    await check({
      config: cfg, direction: "input", text: secret, metadata: {},
      fetchImpl: fetchImpl as never, sleepImpl: async () => undefined,
    } as never).catch(() => undefined);
    const logged = [...spy.mock.calls, ...errSpy.mock.calls].flat().map(String).join(" ");
    expect(logged).not.toContain(secret);
  }, 30_000);
});
