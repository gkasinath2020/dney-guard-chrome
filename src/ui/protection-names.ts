// SCRUM-396 (Hallmark's decision, 12 Oct): Try-it names the protection with the
// SAME three names the welcome tab's C4 list uses, mapped on the client from the
// rule names /api/v1/check returns in rails_triggered (it returns no template or
// policy id). The list is the rule names of the three default templates at
// asgard-services origin/main 5925bbb (templates/definitions/prompt_injection,
// pii_protection, data_exfiltration .yaml). config_builder derives per-entity
// rules as "<rule> (<ENTITY>)" and "<rule> (formats)", so a trailing
// parenthesised suffix is ignored. Anything else (a custom rule, another
// template) is shown as the server named it.
import { COPY } from "./onboarding-copy";

export const PROTECTION_ORDER = ["injection", "pii", "exfil"] as const;
type Protection = (typeof PROTECTION_ORDER)[number];

export const PROTECTION_NAMES: Record<Protection, string> = {
  injection: COPY["C4.injection_name"],
  pii: COPY["C4.pii_name"],
  exfil: COPY["C4.exfil_name"],
};

/** Base rule name (suffix stripped) -> protection. */
export const RULE_TO_PROTECTION: Readonly<Record<string, Protection>> = {
  // prompt_injection.yaml (Prompt Injection Protection)
  "Prompt Injection Detection": "injection",
  "Prompt Injection Semantic Check": "injection",
  "Prompt Injection Output Check": "injection",
  "Prompt Injection Semantic Output Check": "injection",
  // pii_protection.yaml (PII Protection)
  "Input PII Check": "pii",
  "Input Credit Card Check": "pii",
  "Output PII Check": "pii",
  // data_exfiltration.yaml (Data Exfiltration Protection)
  "Exfiltration Instruction Detection": "exfil",
  "Credential Disclosure Detection": "exfil",
  "Exfiltration Semantic Check": "exfil",
  "Exfiltration Channel Detection": "exfil",
  "Secret Disclosure Masking": "exfil",
  "Exfiltration Semantic Output Check": "exfil",
};

/** "Input PII Check (formats)" -> "Input PII Check"; "Input PII Check (EMAIL)" -> "Input PII Check". */
export function baseRuleName(rule: string): string {
  return rule.replace(/\s*\([^()]*\)\s*$/, "").trim();
}

/**
 * The one name Try-it shows for a verdict: the first mapped protection in the
 * order injection, personal data, exfiltration; if none of the rules maps, the
 * first rule's own name; "" when the verdict names no rule at all.
 */
export function protectionName(rails: readonly unknown[]): string {
  const rules = rails.filter((r): r is string => typeof r === "string" && r.trim() !== "");
  const hit = new Set(rules.map((r) => RULE_TO_PROTECTION[baseRuleName(r)]).filter(Boolean));
  for (const p of PROTECTION_ORDER) if (hit.has(p)) return PROTECTION_NAMES[p];
  return rules[0] ?? "";
}
