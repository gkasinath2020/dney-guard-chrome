/**
 * The two bridges must not disagree about how long a check may take.
 *
 * A prompt is guarded twice: by the ISOLATED content script (composer intercept)
 * and by the MAIN-world fetch hook. Both wait for the same service-worker check,
 * so both must wait at least as long as that check may legitimately run —
 * input_timeout_ms plus the 429 back-off budget. Whichever one gives up early
 * releases the prompt UNCHECKED while a healthy check is still in flight, which
 * is the failure this whole deadline mechanism exists to prevent.
 *
 * The ISOLATED world reads the user's config and sizes its wait from it. The MAIN
 * world cannot read chrome.storage at all, so it is told the deadline over the
 * page bridge and holds a ceiling until it is. These tests pin both halves.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  bridgeDeadlineMs,
  clampBridgeDeadlineMs,
  coerceNumericField,
  DEFAULT_CONFIG,
  MAX_BRIDGE_DEADLINE_MS,
  MAX_INPUT_TIMEOUT_MS,
  MIN_INPUT_TIMEOUT_MS,
  RETRY_BUDGET_MS,
} from "../src/lib/config";

const src = (rel: string) =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), "utf8");

/** The longest a single check may legitimately take under a given config. */
const clientWorstCaseMs = (inputTimeoutMs: number) => inputTimeoutMs + RETRY_BUDGET_MS;

describe("the MAIN-world ceiling covers every config a user can save", () => {
  it("holds for every input timeout the options UI will persist", () => {
    // Sample the whole legal range, not just the default — the bug shipped because
    // only the default was ever considered.
    for (let t = MIN_INPUT_TIMEOUT_MS; t <= MAX_INPUT_TIMEOUT_MS; t += 1000) {
      expect(
        MAX_BRIDGE_DEADLINE_MS,
        `a user who sets input_timeout_ms=${t} would have their prompt released unchecked`,
      ).toBeGreaterThan(clientWorstCaseMs(t));
    }
  });

  it("the ceiling and the options-page bounds are the same numbers", () => {
    // If someone raises the options ceiling without raising this one, the MAIN
    // world starts failing open early again for the newly-allowed settings.
    expect(coerceNumericField("input_timeout_ms", String(MAX_INPUT_TIMEOUT_MS))).toBe(
      MAX_INPUT_TIMEOUT_MS,
    );
    expect(coerceNumericField("input_timeout_ms", String(MAX_INPUT_TIMEOUT_MS + 1))).toBe(
      DEFAULT_CONFIG.input_timeout_ms,
    );
    expect(MAX_BRIDGE_DEADLINE_MS).toBe(bridgeDeadlineMs({ input_timeout_ms: MAX_INPUT_TIMEOUT_MS }));
  });
});

describe("a deadline arriving over the page bridge is not trusted blindly", () => {
  // Any script on claude.ai can postMessage to window. A forged short deadline
  // would disarm the safety net; a forged huge one would hang every send.
  it("accepts what the ISOLATED relay can actually compute", () => {
    for (const t of [MIN_INPUT_TIMEOUT_MS, DEFAULT_CONFIG.input_timeout_ms, MAX_INPUT_TIMEOUT_MS]) {
      const ms = bridgeDeadlineMs({ input_timeout_ms: t });
      expect(clampBridgeDeadlineMs(ms)).toBe(ms);
    }
  });

  it("rejects anything that would shorten the wait below a legal check", () => {
    for (const bad of [0, -1, 1, 1000, 5000]) {
      expect(clampBridgeDeadlineMs(bad), `deadline ${bad} must be refused`).toBeNull();
    }
  });

  it("rejects anything unbounded or not a number", () => {
    for (const bad of [Infinity, NaN, MAX_BRIDGE_DEADLINE_MS + 1, "60000", null, undefined, {}]) {
      expect(clampBridgeDeadlineMs(bad), `deadline ${String(bad)} must be refused`).toBeNull();
    }
  });
});

describe("the deadline actually reaches the MAIN world", () => {
  // These read the source because the two worlds only meet in a real browser.
  // They fail if someone deletes the plumbing that carries the user's timeout
  // across the world boundary, which is exactly how the defect was introduced.
  const hook = src("content/page-hook.ts");
  const relay = src("content/main.ts");

  it("the hook never sizes its wait from DEFAULT_CONFIG", () => {
    expect(
      hook.includes("bridgeDeadlineMs(DEFAULT_CONFIG)"),
      "page-hook.ts cannot read the user's config, so a default-sized deadline there is " +
        "a silent fail-open for anyone who raised input_timeout_ms",
    ).toBe(false);
    expect(hook).toContain("MAX_BRIDGE_DEADLINE_MS");
  });

  it("the hook consumes a deadline pushed over the bridge", () => {
    expect(hook).toContain('d.kind === "deadline"');
    expect(hook).toContain("clampBridgeDeadlineMs");
  });

  it("the relay publishes the effective deadline, at startup and on config change", () => {
    expect(relay).toContain('kind: "deadline"');
    expect(
      relay.includes("chrome.storage.onChanged"),
      "a timeout edited in options must reach the hook without a page reload",
    ).toBe(true);
  });

  it("an unchecked send from the hook still raises the user-visible signals", () => {
    // SCRUM-171's rule: failing open is allowed, failing open SILENTLY is not.
    expect(hook).toContain('kind: "unchecked"');
    expect(relay).toContain('data.kind === "unchecked"');
    expect(relay).toContain("uncheckedBannerText");
    expect(relay).toContain("dney-unchecked"); // the amber `!` badge, via the worker
  });
});
