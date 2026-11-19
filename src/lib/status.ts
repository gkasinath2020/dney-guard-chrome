// How a verdict is REPORTED — badge state and audit action. Pure, so the one rule
// that matters here can be asserted in tests without a browser: a check that did
// not complete is never reported as a clean pass.
import type { AuditAction, Verdict } from "./types";

/** Badge states, as documented in docs/INSTALL.md. */
export type BadgeState = "healthy" | "degraded" | "blocking" | "disabled";

/**
 * A throttle and an outage both map to `degraded` — the amber `!` the install
 * guide already defines as "that message was sent without being checked". It is
 * deliberately NOT `healthy`: the whole defect being fixed here is that a
 * throttled send looked identical to a checked one.
 */
export function badgeState(verdict: Verdict): BadgeState {
  if (verdict.throttled || verdict.failed) return "degraded";
  if (isPartial(verdict) && verdict.action !== "blocked") return "degraded";
  return verdict.action === "blocked" ? "blocking" : "healthy";
}

/** The audit row's action. Mirrors badgeState so the popup and the badge agree. */
export function auditAction(verdict: Verdict): AuditAction {
  if (verdict.throttled) return "throttled";
  if (verdict.failed) return "error";
  if (isPartial(verdict) && verdict.action !== "blocked") return "partial";
  return verdict.action;
}

/** True when the message went out without a completed guardrail check. */
export function wentOutUnchecked(verdict: Verdict): boolean {
  return (verdict.throttled || verdict.failed) === true && verdict.action !== "blocked";
}

// --- A tab still running this content script from before an update -----------
// Chrome leaves the old script in tabs that were open across an update, and its
// extension context is dead: nothing in it can reach DNey until the tab reloads.

/** R1: fail-open, so the message went out. */
export const STALE_TAB_SENT_TEXT =
  "DNey Guard was just updated, so this tab can't reach it. Your message was sent WITHOUT being checked. Reload this tab to turn checking back on.";
/** R2: fail-closed, so it did not. */
export const STALE_TAB_BLOCKED_TEXT =
  "Blocked: DNey Guard was just updated, so this tab can't reach it. Reload this tab, then send again.";

/** One line of user-facing explanation for a check that did not complete. */
export function uncheckedBannerText(verdict: Verdict | null): string {
  if (verdict?.throttled) {
    return "DNey is rate-limiting this API key, so that message was sent WITHOUT being checked. Wait a moment before sending again.";
  }
  return "DNey could not check that message, so it was sent WITHOUT being checked.";
}

// --- SCRUM-401: a check DNey answered but only partly judged -----------------
// A lesser state than "could not check": the server did answer. A fully failed
// check (failed/throttled) is never partial, so the two banners cannot both apply.

/** P1: a partial check that was sent (fail-open). */
export const PARTIAL_SENT_MESSAGE =
  "DNey only partly checked that message: some of your protections couldn't run, so it was sent WITHOUT being fully checked.";
/** P2: a partial check on a fail-closed install. */
export const PARTIAL_BLOCK_MESSAGE =
  "Blocked: DNey could not fully check this message, and this organization uses a fail-closed policy.";
/** P3: the popup activity-row label for the "partial" audit action. */
export const PARTIAL_ROW_LABEL = "Partly checked";
/** P5: appended to the modify banner when a modified message was only partly checked. */
export const PARTIAL_MODIFY_SUFFIX =
  "Some of your protections couldn't run, so it was sent WITHOUT being fully checked.";

/** True when DNey answered but some protections did not judge the text. A missing
 *  `checked` (older servers) is "complete". */
export function isPartial(verdict: Verdict | null | undefined): boolean {
  return !!verdict && !verdict.failed && !verdict.throttled && verdict.checked === "partial";
}
