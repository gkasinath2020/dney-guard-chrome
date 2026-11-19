/**
 * SCRUM-178 QA — the fix introduces a NEW untrusted input.
 *
 * The deadline now arrives in the MAIN world over window.postMessage, and any
 * script on the page can post to window. So the clamp is now a security control,
 * not a validation nicety: a hostile "deadline: 1" disarms the fetch hook's
 * safety net and every subsequent prompt is released unchecked.
 */
import { describe, it, expect } from "vitest";
import {
  clampBridgeDeadlineMs,
  bridgeDeadlineMs,
  MAX_BRIDGE_DEADLINE_MS,
  MAX_INPUT_TIMEOUT_MS,
  MIN_INPUT_TIMEOUT_MS,
  RETRY_BUDGET_MS,
  DEFAULT_CONFIG,
} from "../src/lib/config";

describe("clampBridgeDeadlineMs rejects hostile bridge input", () => {
  it("rejects a short deadline that would disarm the safety net", () => {
    for (const evil of [1, 0, -1, 5, 100]) {
      expect(clampBridgeDeadlineMs(evil), `deadline ${evil}`).toBeNull();
    }
  });

  it("rejects values that would hang every send", () => {
    for (const evil of [Infinity, -Infinity, Number.MAX_VALUE, MAX_BRIDGE_DEADLINE_MS + 1]) {
      expect(clampBridgeDeadlineMs(evil), `deadline ${evil}`).toBeNull();
    }
  });

  it("rejects non-numbers rather than coercing them", () => {
    for (const evil of ["42000", null, undefined, NaN, {}, [], true, () => 42000]) {
      expect(clampBridgeDeadlineMs(evil as unknown), `deadline ${String(evil)}`).toBeNull();
    }
  });

  it("accepts every deadline the options UI can legitimately produce", () => {
    for (const t of [MIN_INPUT_TIMEOUT_MS, DEFAULT_CONFIG.input_timeout_ms, MAX_INPUT_TIMEOUT_MS]) {
      const legit = bridgeDeadlineMs({ input_timeout_ms: t });
      expect(clampBridgeDeadlineMs(legit), `input_timeout_ms ${t}`).toBe(legit);
    }
  });

  it("a rejected deadline leaves the caller its ceiling — null, never a fallback short value", () => {
    // The contract that matters: on rejection the hook KEEPS MAX_BRIDGE_DEADLINE_MS.
    // If this ever returned a number on bad input, the hook would adopt it.
    expect(clampBridgeDeadlineMs(1)).toBeNull();
    expect(clampBridgeDeadlineMs("evil" as unknown)).toBeNull();
  });
});

describe("the standing ceiling is genuinely safe for every saveable config", () => {
  it("covers the slowest legitimate check, with the retry budget included", () => {
    expect(MAX_BRIDGE_DEADLINE_MS).toBeGreaterThan(MAX_INPUT_TIMEOUT_MS + RETRY_BUDGET_MS);
  });

  it("guessing long is the safe direction: the ceiling is never below any real deadline", () => {
    for (let t = MIN_INPUT_TIMEOUT_MS; t <= MAX_INPUT_TIMEOUT_MS; t += 7919) {
      expect(MAX_BRIDGE_DEADLINE_MS, `input_timeout_ms ${t}`)
        .toBeGreaterThanOrEqual(bridgeDeadlineMs({ input_timeout_ms: t }));
    }
  });
});
