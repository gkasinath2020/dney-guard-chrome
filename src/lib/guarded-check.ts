// The check the service worker runs for every message (split out of
// background.ts so it can be tested without a service worker).
import { check, failSafe } from "./dney-client";
import { isStudentMode, studentCredential } from "./student-auth";
import type { ClientMeta, Config, Direction, Verdict } from "./types";

/**
 * How long a check waits for the student's sign-in before answering "signing
 * in…" (blocked under closed). Well inside the content bridge's deadline, so the
 * answer is ALWAYS a verdict from here and never a bridge timeout. The sign-in
 * itself keeps running (single-flight) and the next send uses its credential.
 */
export const SIGN_IN_WAIT_MS = 8000;

interface CheckRequest {
  direction: Direction;
  text: string;
  metadata?: ClientMeta;
}

/**
 * One check. In STUDENT mode (SCRUM-292) the key is the student credential: fetched
 * or refreshed first, and on a 401 (expired or revoked) re-exchanged ONCE and the
 * check retried, before the fail-safe applies. A failed sign-in never sends the
 * text unchecked: it is the fail-safe with its cause.
 */
export async function guardedCheck(
  config: Config,
  msg: CheckRequest,
  deps: {
    credential?: typeof studentCredential;
    check?: typeof check;
    signInWaitMs?: number;
  } = {},
): Promise<Verdict> {
  const getCredential = deps.credential ?? studentCredential;
  const runCheck = deps.check ?? check;
  if (!isStudentMode(config)) {
    return runCheck({ config, direction: msg.direction, text: msg.text, metadata: msg.metadata });
  }
  const waitMs = deps.signInWaitMs ?? SIGN_IN_WAIT_MS;
  for (const force of [false, true]) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const pending = new Promise<"pending">((resolve) => {
      timer = setTimeout(() => resolve("pending"), waitMs);
    });
    const cred = await Promise.race([getCredential(config, { force }), pending]);
    clearTimeout(timer);
    if (cred === "pending") return failSafe(config, msg.text, false, "signing_in");
    if (!cred.ok) return failSafe(config, msg.text, false, cred.cause);
    const verdict = await runCheck({
      config: { ...config, api_key: cred.credential },
      direction: msg.direction,
      text: msg.text,
      metadata: msg.metadata,
    });
    if (!(verdict.failed && verdict.cause === "signed_out") || force) return verdict;
  }
  return failSafe(config, msg.text, false, "signed_out"); // unreachable; keeps the type total
}
