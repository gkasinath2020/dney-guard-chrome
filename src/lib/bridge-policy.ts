// Pure decisions for the two content-script bridges (SCRUM-303, Assay's
// real-browser finding): what the ISOLATED relay answers when the service worker
// does not, and how the MAIN-world hook learns that the install fails closed.
import { failSafe } from "./dney-client";
import type { Config, Verdict } from "./types";

/**
 * The relay's answer when the worker did not answer in time (or lastError). The
 * relay can read the config, so it applies the fail policy itself: a closed
 * install gets a fail-safe BLOCKED verdict, never `null` (which every consumer
 * downstream treats as "no answer"). An open install keeps `null`: the text goes
 * out and the caller badges it as unchecked, as before.
 */
export function bridgeFallback(config: Config | null, text: string): Verdict | null {
  if (!config || config.fail_policy !== "closed") return null;
  return failSafe(config, text, false, "unavailable");
}

/**
 * The MAIN-world hook cannot read storage; the relay tells it the policy over
 * window.postMessage, which ANY page script can also post to. So the hook only
 * ever TIGHTENS: "closed" latches, and nothing a page posts can re-open it. (A
 * page posting "closed" only blocks its own user: harmless.)
 */
export function nextHookFailPolicy(current: "open" | "closed", posted: unknown): "open" | "closed" {
  return current === "closed" || posted === "closed" ? "closed" : "open";
}

/** Shown when the hook cannot read a message to the AI site on a closed install. */
export const UNREADABLE_BLOCK_MESSAGE =
  "DNey Guard couldn't read this message, so it was not sent. If this keeps happening, ask your teacher or IT.";

/**
 * A request to the AI site's completion endpoint that the hook cannot read: the
 * body is not a string, is not JSON, carries no prompt where the adapter looks
 * (the site changed its request shape, which ChatGPT does), or the hook threw.
 * Closed installs BLOCK it; open installs pass it through and badge it unchecked.
 * (Before: every one of these passed through silently on every install.)
 */
export function onUnreadableCompletion(failPolicy: "open" | "closed"): "block" | "pass" {
  return failPolicy === "closed" ? "block" : "pass";
}

/** How long a content script waits for the worker's config before giving up. */
export const CONFIG_REQUEST_TIMEOUT_MS = 3000;

/**
 * The effective config, asked of the SERVICE WORKER. A content script must not
 * read chrome.storage.managed itself: measured 27 Sep (Chromium 145), that call
 * never settles in a content script (no value, no error), so a config loaded
 * there never arrived; the relay never published the real deadline or fail policy
 * and anything awaiting it hung. Always settles: the config, or null on timeout,
 * error or no answer.
 */
export function requestConfigFromWorker(
  send: (msg: unknown, cb: (resp: unknown) => void) => void,
  timeoutMs = CONFIG_REQUEST_TIMEOUT_MS,
  lastError: () => unknown = () => undefined,
): Promise<Config | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: Config | null) => {
      if (!done) {
        done = true;
        resolve(c);
      }
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      send({ type: "dney-config" }, (resp) => {
        clearTimeout(timer);
        const st = resp as { config?: Config } | null;
        finish(lastError() || !st?.config ? null : st.config);
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}

/** How long the hook waits to learn the fail policy before deciding an
 *  unreadable request. The worker's first managed read measured ~2 s. */
export const POLICY_WAIT_MS = 5000;
