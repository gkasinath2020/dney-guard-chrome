// SCRUM-565: a block because Dney's safety checker could not run is not a policy
// match. Copy: marketing/SCRUM565_CLIENT_COPY.md (Hallmark, cleared by Assay #3026).
import { describe, expect, it } from "vitest";
import { bannerText, decideInput } from "../src/lib/enforce";
import {
  CHECKER_UNAVAILABLE_ROW_LABEL,
  CHECKER_UNAVAILABLE_TOOLTIP,
  auditAction,
  badgeState,
  badgeTitle,
  isCheckerUnavailable,
} from "../src/lib/status";
import type { Verdict } from "../src/lib/types";

const SERVER_TEXT =
  "Dney's safety checker is unavailable right now, so this message was blocked to be safe. Please try again in a moment. This isn't a judgement about your message.";

function verdict(over: Partial<Verdict>): Verdict {
  return {
    action: "blocked",
    text: SERVER_TEXT,
    original_text: "What are OKRs?",
    rails_triggered: [],
    latency_ms: 20000,
    checked: "partial",
    unchecked: ["timed_out_blocked"],
    checker_unavailable: ["Prompt Injection Semantic Check", "PHI Self-Check"],
    failed: false,
    ...over,
  };
}

describe("pure could-not-check block (no rule fired)", () => {
  const v = verdict({});
  for (const policy of ["open", "closed"] as const) {
    it(`is bare: the server text as-is, no prefix, no rule names (${policy})`, () => {
      const d = decideInput("What are OKRs?", v, policy);
      expect(d.kind).toBe("block");
      expect(bannerText(d)).toBe(SERVER_TEXT);
      expect(bannerText(d)).not.toContain("blocked by policy");
      expect(bannerText(d)).not.toContain("Prompt Injection");
    });
  }
  it("is labelled 'Checker unavailable', with the tooltip, and still blocking", () => {
    expect(isCheckerUnavailable(v)).toBe(true);
    expect(auditAction(v)).toBe("checker_unavailable");
    expect(CHECKER_UNAVAILABLE_ROW_LABEL).toBe("Checker unavailable");
    expect(badgeTitle(v)).toBe(CHECKER_UNAVAILABLE_TOOLTIP);
    expect(CHECKER_UNAVAILABLE_TOOLTIP).toBe("Safety checker unavailable: message not sent.");
    expect(badgeState(v)).toBe("blocking"); // not sent, so never the amber 'sent unchecked'
  });
  it("a server that only sets semantic_unavailable counts too", () => {
    const s = verdict({ checker_unavailable: undefined, semantic_unavailable: true });
    expect(isCheckerUnavailable(s)).toBe(true);
    expect(bannerText(decideInput("x", s, "closed"))).toBe(SERVER_TEXT);
  });
});

describe("mixed: a rule really fired while another could not run (Assay #3026)", () => {
  const real = "PII detected: this message contains a Social Security number.";
  const v = verdict({
    text: real,
    rails_triggered: ["PII Detection"],
    checker_unavailable: ["Prompt Injection Semantic Check"],
  });
  it("keeps the policy prefix with the real rule and message, never 'judgement'", () => {
    const b = bannerText(decideInput("my ssn is ...", v, "closed"));
    expect(b).toBe(`Message blocked by policy (PII Detection): ${real}`);
    expect(b).not.toContain("judgement");
  });
  it("is a normal policy block in the popup and badge", () => {
    expect(isCheckerUnavailable(v)).toBe(false);
    expect(auditAction(v)).toBe("blocked");
    expect(badgeTitle(v)).toBeNull();
  });
});

describe("unchanged paths", () => {
  it("an ordinary policy block is unchanged", () => {
    const v = verdict({ text: "Toxic.", rails_triggered: ["Toxicity"], checker_unavailable: [], checked: "complete" });
    expect(bannerText(decideInput("x", v, "closed"))).toBe("Message blocked by policy (Toxicity): Toxic.");
    expect(auditAction(v)).toBe("blocked");
  });
  it("an older server without the field behaves as before", () => {
    const v = verdict({ text: "Blocked.", rails_triggered: ["X"], checker_unavailable: undefined, checked: undefined });
    expect(isCheckerUnavailable(v)).toBe(false);
    expect(bannerText(decideInput("x", v, "closed"))).toBe("Message blocked by policy (X): Blocked.");
  });
  it("a failed call (extension couldn't reach Dney) keeps its own path", () => {
    const v = verdict({ failed: true, checker_unavailable: undefined });
    expect(isCheckerUnavailable(v)).toBe(false);
    expect(auditAction(v)).toBe("error");
  });
});
