// MAIN-world script (patches window.fetch). The ENFORCEMENT GUARANTEE (§4.2):
// every completion POST is held, its prompt checked via the ISOLATED bridge (which
// reaches the service worker + DNey), then modified/blocked/allowed. Runs at
// document_start so the patch is in place before claude.ai's bundle loads.
//
// Blocking here rejects the request (AbortError — treated as a cancelled send).
// Rendering a synthetic assistant refusal as an SSE stream is Phase D. Output-rail
// stream wrapping is also Phase D. Any hook error falls through to the original
// fetch (fail-open for the hook itself; the DNey fail-policy still governs verdicts).
import { getAdapter } from "./adapters";
import { decideInput, rewriteBody, sendBanner } from "../lib/enforce";
import type { SendBanner } from "../lib/enforce";
import {
  POLICY_WAIT_MS,
  UNREADABLE_BLOCK_MESSAGE,
  nextHookFailPolicy,
  onUnreadableCompletion,
} from "../lib/bridge-policy";

/** Thrown inside the hook when a completion request cannot be read. */
class UnreadableCompletion extends Error {}
import { clampBridgeDeadlineMs, MAX_BRIDGE_DEADLINE_MS } from "../lib/config";
import {
  createPreapprovals,
  createRewrites,
  listenForPreapprovals,
  listenForRewrites,
  PREAPPROVE_EVENT,
} from "../lib/preapproval";
import { waitForComposer } from "../lib/composer-wait";
import type { Verdict } from "../lib/types";

const adapter = getAdapter();

const CHANNEL = "dney-guard";

declare global {
  interface Window {
    __dneyGuardInstalled?: boolean;
  }
}

// --- bridge: MAIN -> ISOLATED (which calls the service worker) ----------------
const pending = new Map<string, (v: Verdict | null) => void>();

// Prompts the DOM layer already checked (§4.3 double-check suppression). The
// fetch hook passes these through without a second DNey call. They arrive by a
// synchronous DOM event, not the postMessage bridge (SCRUM-329, see preapproval.ts).
const preapproved = createPreapprovals();
listenForPreapprovals(preapproved);
// SCRUM-452 tripwire: when the DOM layer last handed a checked send to the page.
let lastDomVerdictAt = 0;
document.addEventListener(PREAPPROVE_EVENT, () => {
  lastDomVerdictAt = Date.now();
});
/** A send the hook cannot read counts as covered if a DOM verdict came this recently. */
const DOM_VERDICT_WINDOW_MS = 5000;
let unobservedWarned = false;
/**
 * SCRUM-452 tripwire (Assay): a send the hook cannot read (claude.ai's binary
 * PerformAction) with no DOM-layer verdict just before it went out UNCHECKED by
 * a path the DOM layer did not intercept. Console only, once per page, never the
 * body. The DOM layer is the only check on such a site, so this is the signal
 * that it was bypassed. (PerformAction may also carry non-send actions; a
 * false warning there costs one console line.)
 */
function warnUnobservedSend(): void {
  if (unobservedWarned || Date.now() - lastDomVerdictAt < DOM_VERDICT_WINDOW_MS) return;
  unobservedWarned = true;
  console.warn("[DNey Guard] a message was sent through a channel DNey Guard cannot read, with no check just before it (SCRUM-452)");
}
// Originals the DOM layer already checked and masked (SCRUM-441, see preapproval.ts).
const rewrites = createRewrites();
listenForRewrites(rewrites);

// How long this hook will wait for a verdict before it gives up and lets the
// message through unchecked. It CANNOT be computed here: the effective deadline
// comes from input_timeout_ms, which lives in chrome.storage, which the MAIN world
// cannot read. So the ISOLATED relay computes it and posts it over the bridge that
// already exists between the two worlds, and until that arrives we hold the
// ceiling that covers every config the options UI will accept. Deriving it from
// DEFAULT_CONFIG instead — which is what this did — meant a user who raised the
// input timeout to 60s had their prompt released at 42s while a healthy check was
// still running: the exact silent fail-open SCRUM-171 removed from the other bridge.
let deadlineMs = MAX_BRIDGE_DEADLINE_MS;
// What to do with NO verdict. Starts open (consumer installs); the relay says
// "closed" for a closed install and it latches: a page script cannot re-open it.
let failPolicy: "open" | "closed" = "open";
// Whether the relay has told us the policy yet. The worker's first managed read
// takes ~2 s after page load; until then "open" above is a guess, not an answer.
let policyKnown = false;
const policyWaiters: (() => void)[] = [];

/** Resolve once the relay has said what the policy is, or after POLICY_WAIT_MS. */
function policySettled(): Promise<void> {
  if (policyKnown) return Promise.resolve();
  return new Promise((resolve) => {
    policyWaiters.push(resolve);
    setTimeout(resolve, POLICY_WAIT_MS);
  });
}

window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const d = ev.data;
  if (!d || d.channel !== CHANNEL) return;
  if (d.kind === "deadline") {
    const ms = clampBridgeDeadlineMs(d.deadlineMs);
    if (ms !== null) deadlineMs = ms;
    failPolicy = nextHookFailPolicy(failPolicy, d.failPolicy);
    if (d.failPolicy === "open" || d.failPolicy === "closed") {
      policyKnown = true;
      policyWaiters.splice(0).forEach((w) => w());
    }
  } else if (d.kind === "check-response") {
    const cb = pending.get(d.id);
    if (cb) {
      pending.delete(d.id);
      cb(d.verdict as Verdict | null);
    }
  }
});

function requestCheck(direction: "input" | "output", text: string): Promise<Verdict | null> {
  return new Promise((resolve) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    pending.set(id, resolve);
    window.postMessage(
      { channel: CHANNEL, kind: "check-request", id, direction, text, metadata: { surface: adapter?.surface ?? "claude-web" } },
      "*",
    );
    // Bridge safety net of last resort: it only fires when the ISOLATED relay
    // itself never answers (extension reloaded/removed mid-send), because the relay
    // — which knows the real config — gives up and answers `null` first. Sized to
    // the effective deadline when the relay has told us one, and to the ceiling
    // until then, so it can never abandon a check that is still legitimately
    // running. If it does fire, the send is unchecked and the user is told: we ask
    // the relay for the amber `!` badge and the on-page banner from SCRUM-171.
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reportUnchecked(direction);
        resolve(null);
      }
    }, deadlineMs);
  });
}

/** Ask the ISOLATED relay to badge + banner a send that went out with no verdict. */
function reportUnchecked(direction: "input" | "output"): void {
  window.postMessage({ channel: CHANNEL, kind: "unchecked", direction }, "*");
}

function showBanner(kind: SendBanner["kind"], text: string): void {
  window.postMessage({ channel: CHANNEL, kind: "banner", banner: { kind, text } }, "*");
}

// --- fetch patch --------------------------------------------------------------
function installFetchHook(): void {
  const orig = window.fetch;
  window.fetch = async function (this: unknown, input: RequestInfo | URL, init?: RequestInit) {
    let completion = false;
    try {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
      if (adapter?.isUnobservedSendUrl?.(url)) warnUnobservedSend();
      // A draft sent while the user is still typing: strip it, never check it.
      const stripped = adapter?.stripDraft?.(url, init?.body);
      if (stripped !== undefined) return orig.call(this, input, { ...init, body: stripped as BodyInit });
      completion = !!adapter?.isCompletionUrl(url);
      // A pre-flight that may carry a prompt: checked when it does, else untouched.
      const optional = !completion && !!adapter?.mayCarryPrompt?.(url);
      if ((completion || optional) && adapter) {
        const body = init?.body;
        // A body that is not a JSON string (signed-out ChatGPT's URLSearchParams):
        // the adapter's codec reads it, and writes it back as the same type.
        const codec = adapter.bodyCodec?.(url);
        if (!codec) {
          if (typeof body !== "string") throw new UnreadableCompletion("body is not a string");
        }
        const parsed = codec ? codec.decode(body) : JSON.parse(body as string);
        const prompt = adapter.getPrompt(parsed);
        if (prompt === null && optional) return orig.call(this, input, init); // nothing to check
        if (prompt === null) throw new UnreadableCompletion("no prompt where the adapter looks");
        // A pre-flight must not spend the DOM layer's preapproval: the send after it needs it.
        if (prompt && (optional ? preapproved.has(prompt) : preapproved.consume(prompt))) {
          // DOM layer already checked this text (one-shot, whitespace-insensitive).
          // A masked send that arrived masked spends its rewrite too (SCRUM-441).
          if (!optional) rewrites.dropTo(prompt);
          return orig.call(this, input, init);
        }
        // The composer still sent the ORIGINAL of a masked send: apply the masked
        // text DNey already returned for it. No second check, no second banner.
        const masked = prompt ? (optional ? rewrites.peek(prompt) : rewrites.take(prompt)) : null;
        if (masked !== null) {
          if (!optional) preapproved.consume(masked); // this send used it up
          const newBody = adapter.setPrompt(parsed, masked);
          init = { ...init, body: codec ? codec.encode(newBody, body) : JSON.stringify(newBody) };
          return orig.call(this, input, init);
        }
        if (prompt) {
          const verdict = await requestCheck("input", prompt);
          const decision = decideInput(prompt, verdict, failPolicy);
          // The same ONE banner the DOM layer would show (SCRUM-401: partial too).
          const banner = sendBanner(decision, verdict);
          if (banner) showBanner(banner.kind, banner.text);
          if (decision.kind === "block") {
            throw new DOMException("Blocked by DNey Guard", "AbortError");
          }
          if (decision.kind === "modify") {
            const newBody = rewriteBody(parsed, decision, adapter!.setPrompt);
            // Same body type as the page sent (headers untouched, so is Content-Type).
            init = { ...init, body: codec ? codec.encode(newBody, body) : JSON.stringify(newBody) };
            return orig.call(this, input, init);
          }
        }
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw err; // our block
      if (completion) {
        // A message to the AI that we could not read (Assay): closed installs block.
        await policySettled(); // do not decide on a guess made before the relay spoke
        if (onUnreadableCompletion(failPolicy) === "block") {
          console.warn("[DNey Guard] unreadable completion request, blocking (fail-closed)");
          showBanner("block", UNREADABLE_BLOCK_MESSAGE);
          throw new DOMException("Blocked by DNey Guard", "AbortError");
        }
        reportUnchecked("input");
      }
      console.warn("[DNey Guard] fetch hook error, passing through:", err instanceof Error ? err.message : "error");
    }
    return orig.call(this, input as RequestInfo | URL, init);
  };
}

if (!window.__dneyGuardInstalled) {
  window.__dneyGuardInstalled = true;
  installFetchHook();
  // Whichever world loads second would otherwise miss the other's opening message,
  // so the hook announces itself and the relay replies with the current deadline.
  window.postMessage({ channel: CHANNEL, kind: "hook-ready" }, "*");
  // The site mounts its composer after DOMContentLoaded, so wait for it (SCRUM-433).
  const selfTest = () =>
    waitForComposer(
      document,
      () => adapter?.selfTest(document).composerFound ?? false,
      () => console.warn("[DNey Guard] adapter self-test: composer NOT found — adapter may be out of date"),
    );
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", selfTest, { once: true });
  } else {
    selfTest();
  }
}
