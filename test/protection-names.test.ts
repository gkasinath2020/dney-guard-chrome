// SCRUM-396 (Hallmark, 12 Oct): Try-it names the protection with the C4 names.
import { describe, expect, it } from "vitest";
import { COPY } from "../src/ui/onboarding-copy";
import { RULE_TO_PROTECTION, baseRuleName, protectionName } from "../src/ui/protection-names";
import rules from "./fixtures/scrum392/default_template_rules.json";
import { captured } from "./helpers/onboarding-env";

const INJ = COPY["C4.injection_name"];
const PII = COPY["C4.pii_name"];
const EXF = COPY["C4.exfil_name"];
const rails = (name: string) => (captured(name).body as { rails_triggered: string[] }).rails_triggered;

describe("each captured verdict renders the mapped C4 name", () => {
  it("captured injection block -> Prompt injection protection", () => {
    expect(rails("check_injection")).toEqual(["Prompt Injection Detection"]);
    expect(protectionName(rails("check_injection"))).toBe("Prompt injection protection");
  });
  it("captured SSN mask -> Personal data protection", () => {
    expect(rails("check_ssn")).toEqual(["Input PII Check (formats)"]);
    expect(protectionName(rails("check_ssn"))).toBe("Personal data protection");
  });
  it("captured benign allow names nothing", () => {
    expect(protectionName(rails("check_benign"))).toBe("");
  });
});

describe("the map covers exactly the three default templates' rules (asgard-services 5925bbb)", () => {
  it("every rule of each default template maps to its own protection, and nothing else is mapped", () => {
    const expected: Record<string, string> = {};
    for (const r of rules.templates["prompt-injection"]) expected[r] = "injection";
    for (const r of rules.templates["pii-protection"]) expected[r] = "pii";
    for (const r of rules.templates["data-exfiltration"]) expected[r] = "exfil";
    expect({ ...RULE_TO_PROTECTION }).toEqual(expected);
  });

  it.each([
    ["Input PII Check (EMAIL)", PII],
    ["Input PII Check (SSN)", PII],
    ["Input PII Check (PHONE)", PII],
    ["Input PII Check (formats)", PII],
    ["Input Credit Card Check", PII],
    ["Input Credit Card Check (CREDIT_CARD)", PII],
    ["Credential Disclosure Detection", EXF],
    ["Exfiltration Channel Detection", EXF],
    ["Secret Disclosure Masking", EXF],
    ["Exfiltration Semantic Check", EXF],
    ["Prompt Injection Semantic Check", INJ],
  ])("config_builder-derived / template rule %s -> %s", (rule, name) => {
    expect(protectionName([rule])).toBe(name);
  });

  it("baseRuleName strips one trailing generated suffix only", () => {
    expect(baseRuleName("Input PII Check (formats)")).toBe("Input PII Check");
    expect(baseRuleName("My (team) rule")).toBe("My (team) rule".replace(/\s*\([^()]*\)\s*$/, ""));
  });
});

describe("unmapped and multiple rules", () => {
  it("a custom rule (or another template's rule) renders as the server named it", () => {
    expect(protectionName(["Block Competitor Names"])).toBe("Block Competitor Names");
    expect(protectionName(["Jailbreak Pattern Detection"])).toBe("Jailbreak Pattern Detection");
  });

  it.each([
    [["Credential Disclosure Detection", "Prompt Injection Detection"], INJ],
    [["Exfiltration Channel Detection", "Input PII Check (EMAIL)"], PII],
    [["Input PII Check (EMAIL)", "Prompt Injection Detection", "Secret Disclosure Masking"], INJ],
    [["Block Competitor Names", "Secret Disclosure Masking"], EXF],
    [["Custom A", "Custom B"], "Custom A"],
  ])("%j -> the first by injection, personal data, exfiltration: %s", (rs, name) => {
    expect(protectionName(rs)).toBe(name);
  });

  it("no rule at all -> '' (the page then says it couldn't check, never invents a name)", () => {
    expect(protectionName([])).toBe("");
    expect(protectionName(["", 3 as unknown as string])).toBe("");
  });
});
