// Pure enforcement decisions, shared by the DOM layer (composer intercept, §4.3)
// and the fetch layer (§4.2). Kept side-effect-free so it is unit-testable without
// a browser; the content scripts do the actual DOM/network work around these.
import type { Config, Verdict } from "./types";
import {
  PARTIAL_BLOCK_MESSAGE,
  PARTIAL_MODIFY_SUFFIX,
  PARTIAL_SENT_MESSAGE,
  STALE_TAB_BLOCKED_TEXT,
  STALE_TAB_SENT_TEXT,
  isPartial,
  uncheckedBannerText,
  wentOutUnchecked,
} from "./status";

/** What to do when NO verdict arrived at all (bridge timeout, worker gone). */
export type FailPolicy = Config["fail_policy"];

/** Shown when a closed install blocks because no answer arrived in time. */
export const NO_VERDICT_BLOCK_MESSAGE =
  "Blocked: the content check did not complete, and this device is set to block when it cannot check. Try again in a moment; if it keeps happening, ask your teacher or IT.";

export type InputDecision =
  | { kind: "allow"; text: string }
  | { kind: "modify"; text: string; rails: string[] }
  | { kind: "block"; message: string; rails: string[]; bare?: boolean };

/**
 * Map a DNey verdict for a user PROMPT to an action.
 * - A fail-safe `allowed` (verdict.failed) is treated as allow (fail-open) — the
 *   client already applied the org's fail policy, so a `blocked` here is honored.
 * - NO verdict (the bridge timed out, the worker never answered) follows
 *   `failPolicy`: open allows (and the caller says so), CLOSED BLOCKS. It used to
 *   allow unconditionally, so a managed student install whose sign-in never
 *   completed sent every prompt unchecked (Assay, real-browser e2e, SCRUM-303).
 *   The policy is a required argument so no caller can forget it.
 */
export function decideInput(
  original: string,
  verdict: Verdict | null,
  failPolicy: FailPolicy,
): InputDecision {
  verdict = applyPartialPolicy(verdict, failPolicy);
  if (!verdict) {
    return failPolicy === "closed"
      ? { kind: "block", message: NO_VERDICT_BLOCK_MESSAGE, rails: [], bare: true }
      : { kind: "allow", text: original };
  }
  if (verdict.action === "blocked") {
    // A block because the check could not run or only partly ran (fail-closed) is
    // not a policy match: shown bare, with no "blocked by policy (rails)" prefix.
    const bare = verdict.failed === true || (isPartial(verdict) && verdict.text === PARTIAL_BLOCK_MESSAGE);
    return {
      kind: "block",
      message: verdict.text || "Blocked by policy.",
      rails: bare ? [] : verdict.rails_triggered,
      ...(bare ? { bare } : {}),
    };
  }
  if (verdict.action === "modified") {
    return { kind: "modify", text: verdict.text, rails: verdict.rails_triggered };
  }
  return { kind: "allow", text: original };
}

/**
 * SCRUM-391/401: a PARTIAL check that DNey let through (allowed or modified) is
 * BLOCKED on a fail-closed install, with P2. Fail-open sends it (with a warning,
 * see sendBanner). A partial block stays the server's block. Applied in the worker
 * (so the badge and audit row say "blocked") and again in decideInput, so neither
 * content layer can send it whatever policy it has heard of.
 */
export function applyPartialPolicy<V extends Verdict | null>(verdict: V, failPolicy: FailPolicy): V {
  if (!verdict || failPolicy !== "closed" || !isPartial(verdict) || verdict.action === "blocked") {
    return verdict;
  }
  return { ...verdict, action: "blocked", text: PARTIAL_BLOCK_MESSAGE };
}

/**
 * Rewrite the completion request body for a `modify` decision using the adapter's
 * prompt setter. Returns a new body object; callers re-stringify it.
 */
export function rewriteBody(
  body: unknown,
  decision: InputDecision,
  setPrompt: (body: unknown, text: string) => unknown,
): unknown {
  if (decision.kind === "modify") return setPrompt(body, decision.text);
  return body;
}

/**
 * SCRUM-452 banner (Hallmark, marketing/BANNER_452.md). {protection} is the same
 * rule-name string the "modified" banner shows, so the user knows what to remove.
 */
export function cannotMaskHereText(rails: string[]): string {
  const protection = rails.length ? rails.join(", ") : "a DNey protection";
  return `Message not sent (${protection}). DNey Guard can't mask text on claude.ai yet, so it stopped this message instead. Remove that part and send again.`;
}

/**
 * SCRUM-452: on a site whose send the extension cannot rewrite (claude.ai), a
 * "modify" decision becomes a BLOCK: the composer keeps the user's text, nothing
 * is sent, and the banner says why. Saying "masked" while the original goes out is
 * the one outcome this must never produce. Other decisions pass through unchanged.
 */
export function blockWhenCannotRewrite(decision: InputDecision, cannotRewrite: boolean | undefined): InputDecision {
  if (!cannotRewrite || decision.kind !== "modify") return decision;
  return { kind: "block", message: cannotMaskHereText(decision.rails), rails: decision.rails, bare: true };
}

/** Short, human phrasing for a banner. */
export function bannerText(decision: InputDecision): string {
  const rails = "rails" in decision && decision.rails.length ? ` (${decision.rails.join(", ")})` : "";
  if (decision.kind === "block") {
    return decision.bare ? decision.message : `Message blocked by policy${rails}: ${decision.message}`;
  }
  if (decision.kind === "modify") return `DNey modified your message${rails}.`;
  return "";
}

/**
 * The send when this tab's extension context is dead (the extension updated under
 * it). There is no verdict and cannot be one until the tab reloads. A closed
 * install blocks (R2, bare: it is not a policy match); an open or not-yet-known
 * policy sends. Banner: staleTabBanner.
 */
export function decideStaleTab(original: string, failPolicy: FailPolicy | undefined): InputDecision {
  return failPolicy === "closed"
    ? { kind: "block", message: STALE_TAB_BLOCKED_TEXT, rails: [], bare: true }
    : { kind: "allow", text: original };
}

export interface SendBanner {
  kind: "block" | "modify" | "warn";
  text: string;
}

/**
 * The ONE banner for a decided send, shared by the DOM layer and the fetch hook.
 * Block -> the block banner only. Modify -> the modify banner (P5 when partial).
 * Allow -> P1 when partial, else the "could not check" warning when the check
 * failed open, else nothing. A NULL verdict is the caller's (it also reports it).
 */
export function sendBanner(decision: InputDecision, verdict: Verdict | null): SendBanner | null {
  if (decision.kind === "block") return { kind: "block", text: bannerText(decision) };
  if (decision.kind === "modify") {
    const text = bannerText(decision);
    return { kind: "modify", text: isPartial(verdict) ? `${text} ${PARTIAL_MODIFY_SUFFIX}` : text };
  }
  if (isPartial(verdict)) return { kind: "warn", text: PARTIAL_SENT_MESSAGE };
  if (verdict && wentOutUnchecked(verdict)) return { kind: "warn", text: uncheckedBannerText(verdict) };
  return null;
}

/** The ONE banner for a stale-tab send: R2 when blocked, else R1 (never "could not check"). */
export function staleTabBanner(decision: InputDecision): SendBanner {
  if (decision.kind === "block") return { kind: "block", text: bannerText(decision) };
  return { kind: "warn", text: STALE_TAB_SENT_TEXT };
}
