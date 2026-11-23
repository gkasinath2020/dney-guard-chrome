// Shared types for DNey Guard.

export type Action = "allowed" | "blocked" | "modified";
export type Direction = "input" | "output";

/** Flat response from POST /api/v1/check (asgard-services). */
export interface CheckResult {
  action: Action;
  text: string; // modified text when modified; block message when blocked; echo when allowed
  original_text: string;
  rails_triggered: string[];
  latency_ms: number;
  /** SCRUM-401: "partial" = some protections could not judge the text. Absent on
   *  older servers, which means "complete". */
  checked?: "complete" | "partial";
  /** SCRUM-401: internal reason-type ids for a partial check. Never shown to users. */
  unchecked?: string[];
  /** SCRUM-565 (server v0.99.7+): checks that blocked because Dney's safety checker
   *  could not run, by name. They did not fire, so they are not in rails_triggered.
   *  Never shown to the user. */
  checker_unavailable?: string[];
  /** Set by servers that report a model-tier outage on the result. */
  semantic_unavailable?: boolean;
}

/** A CheckResult plus whether the fail-safe policy had to be applied. */
export interface Verdict extends CheckResult {
  /** true when the DNey call failed/timed out and fail_policy decided the outcome. */
  failed: boolean;
  /** true when the failure was specifically a 429 that outlived the retry budget. */
  throttled?: boolean;
  /** Why a failed check failed, when known (drives the message and the re-sign-in). */
  cause?: "unavailable" | "not_set_up" | "signed_out" | "refused" | "not_enrolled" | "signing_in";
}

export interface Config {
  dney_base_url: string;
  api_key: string;
  input_mode: "enforce" | "monitor" | "off";
  output_mode: "enforce_hard" | "enforce_soft" | "monitor" | "off";
  fail_policy: "open" | "closed";
  allow_override: boolean;
  chunk_size: number;
  chunk_interval_ms: number;
  input_timeout_ms: number;
  output_timeout_ms: number;
  audit_buffer_size: number;
  /** SCRUM-292: the class enrolment token, pushed in a class OU's managed policy.
   *  Set = STUDENT MODE: the device signs in with Google and exchanges for a
   *  short-lived student credential; api_key is not used. */
  enrolment_token: string;
}

/**
 * What the audit row says happened. "allowed" means DNey answered and cleared the
 * text — it is never used for a check that did not complete. "throttled" (429),
 * "error" (unreachable/timeout) and "unchecked" (the check never reached the
 * service worker) are the three ways a message can go out unguarded, and they are
 * kept distinct so a rate limit is never read back as a clean pass. "partial"
 * (SCRUM-401) is a send DNey answered but only partly judged.
 */
export type AuditAction = Action | "error" | "throttled" | "unchecked" | "partial" | "checker_unavailable";

export interface AuditEvent {
  ts: number;
  direction: Direction;
  action: AuditAction;
  rails: string[];
  latency_ms: number;
  failed?: boolean;
}

/** Optional client context sent to DNey (never PII; matches the endpoint's allow-list). */
export interface ClientMeta {
  surface: "claude-web";
  conversation_id?: string;
  user_agent_hash?: string;
}
