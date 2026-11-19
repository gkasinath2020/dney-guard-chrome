import { describe, it, expect } from "vitest";
import { decideInput, rewriteBody, bannerText } from "../src/lib/enforce";
import type { Verdict } from "../src/lib/types";

const v = (over: Partial<Verdict>): Verdict => ({
  action: "allowed",
  text: "",
  original_text: "",
  rails_triggered: [],
  latency_ms: 0,
  failed: false,
  ...over,
});

describe("decideInput", () => {
  it("null verdict (bridge failure) -> allow (fail-open on the hook)", () => {
    expect(decideInput("hi", null, "open")).toEqual({ kind: "allow", text: "hi" });
  });

  it("allowed -> allow with original text", () => {
    expect(decideInput("hi", v({ action: "allowed" }), "open")).toEqual({ kind: "allow", text: "hi" });
  });

  it("modified -> modify with the new text + rails", () => {
    const d = decideInput("my ssn 123", v({ action: "modified", text: "my ssn [REDACTED]", rails_triggered: ["pii"] }), "open");
    expect(d).toEqual({ kind: "modify", text: "my ssn [REDACTED]", rails: ["pii"] });
  });

  it("blocked -> block with the message + rails", () => {
    const d = decideInput("x", v({ action: "blocked", text: "Nope.", rails_triggered: ["Prompt Injection Detection"] }), "open");
    expect(d).toEqual({ kind: "block", message: "Nope.", rails: ["Prompt Injection Detection"] });
  });

  it("a fail-closed verdict (blocked + failed) is still honored", () => {
    const d = decideInput("x", v({ action: "blocked", text: "unavailable", failed: true }), "open");
    expect(d.kind).toBe("block");
  });
});

describe("rewriteBody", () => {
  const setPrompt = (body: unknown, text: string) => ({ ...(body as object), prompt: text });

  it("rewrites the prompt on modify", () => {
    const out = rewriteBody({ prompt: "old", model: "m" }, { kind: "modify", text: "new", rails: [] }, setPrompt);
    expect(out).toEqual({ prompt: "new", model: "m" });
  });

  it("leaves the body unchanged on allow", () => {
    const body = { prompt: "old" };
    expect(rewriteBody(body, { kind: "allow", text: "old" }, setPrompt)).toBe(body);
  });
});

describe("bannerText", () => {
  it("block includes the message and rails", () => {
    expect(bannerText({ kind: "block", message: "No.", rails: ["r1"] })).toContain("blocked by policy (r1)");
  });
  it("modify mentions modification", () => {
    expect(bannerText({ kind: "modify", text: "x", rails: ["pii"] })).toContain("modified your message (pii)");
  });
  it("allow -> empty", () => {
    expect(bannerText({ kind: "allow", text: "x" })).toBe("");
  });
});

describe("no verdict follows the fail policy (SCRUM-303, Assay real-browser finding)", () => {
  it("closed: a missing verdict BLOCKS", () => {
    const d = decideInput("42 Wallaby Street", null, "closed");
    expect(d.kind).toBe("block");
    expect(bannerText(d)).toContain("did not complete");
  });
  it("open: a missing verdict allows (the caller badges it unchecked)", () => {
    expect(decideInput("hi", null, "open")).toEqual({ kind: "allow", text: "hi" });
  });
  it("a real verdict is unaffected by the policy", () => {
    expect(decideInput("hi", v({ action: "allowed" }), "closed").kind).toBe("allow");
  });
});
