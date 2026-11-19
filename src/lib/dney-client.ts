// The DNey API client — POST {base}/api/v1/check. All DNey calls originate here
// (the service worker), keeping the API key out of the page context.
import { RETRY_BUDGET_MS } from "./config";
import { applyPartialPolicy } from "./enforce";
import type { ClientMeta, Config, Direction, Verdict } from "./types";

export interface CheckOpts {
  config: Config;
  direction: Direction;
  text: string;
  metadata?: ClientMeta;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so throttle back-off does not sleep in the suite. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Injectable for tests. Defaults to Date.now. */
  nowImpl?: () => number;
}

/** How many times we will wait out a 429 before giving up and surfacing it. */
export const MAX_THROTTLE_RETRIES = 3;
/** Used when the server sends no (or an unparseable) Retry-After. */
export const DEFAULT_RETRY_WAIT_MS = 3000;
const MIN_RETRY_WAIT_MS = 1000;
const MAX_RETRY_WAIT_MS = 30000;

function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, cancel: () => clearTimeout(t) };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * How long to wait before retrying a throttled request. Accepts both forms the
 * RFC allows — delta-seconds (what asgard-services sends) and an HTTP-date — and
 * CLAMPS the result. An unclamped Retry-After is a remote party deciding how long
 * to freeze the composer, and a missing one is not permission to hammer the API.
 */
export function retryAfterMs(header: string | null | undefined, now = Date.now()): number {
  const clamp = (ms: number) => Math.max(MIN_RETRY_WAIT_MS, Math.min(MAX_RETRY_WAIT_MS, ms));
  if (!header) return DEFAULT_RETRY_WAIT_MS;
  const raw = header.trim();
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) {
    if (seconds <= 0) return MIN_RETRY_WAIT_MS;
    return clamp(seconds * 1000);
  }
  const at = Date.parse(raw);
  if (Number.isFinite(at)) return clamp(at - now);
  return DEFAULT_RETRY_WAIT_MS;
}

/**
 * Fail-safe outcome (G3): fail_open -> allow the original text; fail_closed ->
 * block. Applied on any network error / timeout / non-2xx after retries.
 *
 * `throttled` marks the specific case where DNey answered 429 until we ran out of
 * budget. The outcome is the same as any other fail-safe, but the CAUSE must
 * travel with it: a throttle is sustained and self-inflicted, so the user has to
 * be told they are unprotected rather than shown something indistinguishable from
 * a clean pass.
 */
/**
 * Why a check could not be completed, when it is more specific than "unavailable".
 * Each has its own student-facing message (SCRUM-303 s303-08/11). None of them ever
 * names an email, a pseudonym or a key.
 */
export type FailCause =
  | "unavailable"
  | "not_set_up"
  | "signed_out"
  | "refused"
  | "not_enrolled"
  | "signing_in";

export const FAIL_MESSAGES: Record<FailCause, string> = {
  unavailable: "Blocked: the content check is unavailable and this organization uses a fail-closed policy.",
  not_set_up: "Blocked: DNey Guard is not set up on this device. Ask your teacher or school IT.",
  signed_out:
    "Blocked: your school sign-in needs renewing. Reload the page; if this keeps happening, ask your teacher.",
  refused: "Blocked: this device is not allowed to use this AI site right now. Ask your teacher.",
  not_enrolled:
    "Blocked: this device is not enrolled in a class, or you are not signed in with your school account. Ask your teacher.",
  signing_in:
    "Signing in to your school account… Your message was not sent. Finish signing in, then send it again.",
};

/** P4 (SCRUM-401): a 401 on an API-KEY install is a bad key, not a school sign-in. */
export const KEY_REJECTED_MESSAGE =
  "Blocked: this browser's DNey API key isn't working, and this organization uses a fail-closed policy. Ask your administrator for a new key.";

/** The fail-closed message for a cause. Only student mode (an enrolment token) says
 *  "school sign-in"; a key install whose key is rejected says so instead. */
function failMessage(config: Config, cause: FailCause): string {
  if (cause === "signed_out" && !config.enrolment_token) return KEY_REJECTED_MESSAGE;
  return FAIL_MESSAGES[cause];
}

export function failSafe(
  config: Config,
  text: string,
  throttled = false,
  cause: FailCause = "unavailable",
): Verdict {
  const blocked = config.fail_policy === "closed";
  return {
    action: blocked ? "blocked" : "allowed",
    text: blocked
      ? throttled
        ? "Blocked: DNey is rate-limiting this API key and this organization uses a fail-closed policy."
        : failMessage(config, cause)
      : text,
    original_text: text,
    rails_triggered: [],
    latency_ms: 0,
    failed: true,
    throttled,
    cause,
  };
}

/** Header read that survives the plain-object Responses used in tests. */
function header(res: Response, name: string): string | null {
  try {
    return res.headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
}

/**
 * Run one guardrail check. One retry on network error for INPUT only (never for
 * output — it adds visible latency). A 429 is retried in BOTH directions after
 * honouring Retry-After, because a throttle is transient by construction and
 * treating it as "unreachable" silently disables the guardrail for the rest of
 * the burst. Retries are bounded twice over: at most MAX_THROTTLE_RETRIES waits,
 * and never more than RETRY_BUDGET_MS of total waiting, so the send path cannot
 * hang no matter what the server asks for.
 *
 * Returns a Verdict; on failure applies the configured fail-safe rather than
 * throwing. `verdict.throttled` distinguishes "we were rate-limited" from every
 * other failure.
 */
export async function check(opts: CheckOpts): Promise<Verdict> {
  const { config, direction, text, metadata } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const doSleep = opts.sleepImpl ?? sleep;
  const timeoutMs = direction === "input" ? config.input_timeout_ms : config.output_timeout_ms;
  const maxNetworkAttempts = direction === "input" ? 2 : 1; // input: 1 retry; output: none

  // No key: nothing to check with. Never send an unauthenticated request whose
  // 401 would be indistinguishable from an outage (s303-11).
  if (!config.api_key) {
    console.warn("[DNey Guard] no API key configured, applying fail-safe: not set up");
    return failSafe(config, text, false, "not_set_up");
  }

  let lastErr: unknown;
  let cause: FailCause = "unavailable";
  let networkAttempts = 0;
  let throttleRetries = 0;
  let waitedMs = 0;
  let sawThrottle = false;

  while (networkAttempts < maxNetworkAttempts) {
    networkAttempts++;
    const { signal, cancel } = withTimeout(timeoutMs);
    try {
      const res = await doFetch(`${config.dney_base_url}/api/v1/check`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-api-key": config.api_key },
        body: JSON.stringify({ text, direction, metadata }),
        signal,
      });
      if (res.status === 429) {
        sawThrottle = true;
        const wait = retryAfterMs(header(res, "Retry-After"), opts.nowImpl?.() ?? Date.now());
        if (throttleRetries >= MAX_THROTTLE_RETRIES || waitedMs + wait > RETRY_BUDGET_MS) {
          lastErr = new Error(`DNey check HTTP 429 (gave up after ${throttleRetries} retries)`);
          break;
        }
        throttleRetries++;
        waitedMs += wait;
        networkAttempts--; // a throttle is not a network failure; it has its own budget
        cancel();
        await doSleep(wait);
        continue;
      }
      // 401/403 are answers, not outages: retrying cannot change them (s303-08).
      if (res.status === 401 || res.status === 403) {
        cause = res.status === 401 ? "signed_out" : "refused";
        lastErr = new Error(`DNey check HTTP ${res.status}`);
        break;
      }
      if (!res.ok) throw new Error(`DNey check HTTP ${res.status}`);
      const j = (await res.json()) as Omit<Verdict, "failed">;
      // SCRUM-401: a partial pass on a fail-closed install is a block (P2).
      return applyPartialPolicy({ ...j, failed: false, throttled: false }, config.fail_policy);
    } catch (err) {
      lastErr = err;
    } finally {
      cancel();
    }
  }
  console.warn(
    `[DNey Guard] check failed${sawThrottle ? " (rate limited)" : ""}, applying fail-safe:`,
    lastErr,
  );
  return failSafe(config, text, sawThrottle && cause === "unavailable", cause);
}
