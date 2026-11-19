// ISOLATED-world content script. Two jobs:
//  1. The MAIN<->SW bridge (relay checks; render banners requested by the hook).
//  2. The DOM-layer send-prevention (§4.3): intercept the composer send in the
//     CAPTURE phase, check the prompt FIRST, and only let it proceed if allowed.
//     This is the primary block path — nothing is ever sent on a block, so
//     claude.ai never sees an aborted request (which it handles poorly). The
//     MAIN-world fetch hook stays as the backstop for paths the DOM layer misses.
import type { ClientMeta, Verdict } from "./../lib/types";
import { showBanner } from "./banners";
import { getAdapter } from "./adapters";
import { blockWhenCannotRewrite, decideInput, decideStaleTab, sendBanner, staleTabBanner } from "../lib/enforce";
import { bridgeDeadlineMs, DEFAULT_CONFIG } from "../lib/config";
import { bridgeFallback, requestConfigFromWorker } from "../lib/bridge-policy";
import type { Config } from "../lib/types";
import { STALE_TAB_BLOCKED_TEXT, STALE_TAB_SENT_TEXT, uncheckedBannerText } from "../lib/status";
import { sendPreapproval, sendRewrite } from "../lib/preapproval";
import { pickComposer, pickSendButton } from "../lib/composer-pick";

const CHANNEL = "dney-guard";
const adapter = getAdapter();

// After an extension update, a tab that was already open keeps running THIS copy
// of the script with a dead extension context: chrome.runtime.id is gone, and
// sendMessage throws "Extension context invalidated". Nothing here can reach DNey
// again until the tab reloads, so the user is told exactly that (R1/R2).
let contextGone = false;
function extensionContextGone(): boolean {
  try {
    return contextGone || !chrome.runtime?.id;
  } catch {
    return true;
  }
}
function noteIfInvalidated(err: unknown): void {
  const msg = err instanceof Error ? err.message : (err as { message?: unknown } | undefined)?.message;
  if (typeof msg === "string" && /context invalidated/i.test(msg)) contextGone = true;
}

// --- 1. bridge relay + banner rendering (for the MAIN-world fetch hook) --------
window.addEventListener("message", (ev: MessageEvent) => {
  if (ev.source !== window) return;
  const data = ev.data;
  if (!data || data.channel !== CHANNEL) return;

  if (data.kind === "check-request") {
    const direction: "input" | "output" = data.direction === "output" ? "output" : "input";
    // This world is the one that can read the config, so this world owns the
    // deadline. The hook keeps a net of its own for the case where THIS script is
    // gone, but in every ordinary failure (worker asleep, message dropped) it is
    // this timer that ends the wait — at the user's real budget, not a default.
    let answered = false;
    const answer = (got: Verdict | null) => {
      if (answered) return;
      answered = true;
      // No answer from the worker: a CLOSED install answers blocked, never null
      // (SCRUM-303: null made the hook fail open on managed student installs).
      const verdict = got ?? bridgeFallback(cachedConfig, data.text);
      if (!verdict) {
        // The fetch-layer backstop is about to fail open. Say so.
        reportUnchecked(direction);
        showBanner("warn", extensionContextGone() ? STALE_TAB_SENT_TEXT : uncheckedBannerText(null));
      }
      // Stale tab on a closed install: the fail-safe block says why (R2; shown bare).
      const answerVerdict = !got && verdict && extensionContextGone() ? { ...verdict, text: STALE_TAB_BLOCKED_TEXT } : verdict;
      window.postMessage({ channel: CHANNEL, kind: "check-response", id: data.id, verdict: answerVerdict }, "*");
    };
    const timer = setTimeout(() => answer(null), cachedDeadlineMs);
    try {
      chrome.runtime.sendMessage(
        { type: "dney-check", direction, text: data.text, metadata: data.metadata },
        (verdict) => {
          clearTimeout(timer);
          answer(chrome.runtime.lastError ? null : ((verdict as Verdict) ?? null));
        },
      );
    } catch (e) {
      // A dead context throws here; without the catch the hook waited out the deadline.
      clearTimeout(timer);
      noteIfInvalidated(e);
      answer(null);
    }
  } else if (data.kind === "banner") {
    showBanner(data.banner.kind, data.banner.text);
  } else if (data.kind === "unchecked") {
    // The MAIN-world hook's own net fired, so a prompt went out with no verdict.
    // Same signals as every other fail-open: amber `!` badge, on-page banner.
    reportUnchecked(data.direction === "output" ? "output" : "input");
    showBanner("warn", uncheckedBannerText(null));
  } else if (data.kind === "hook-ready") {
    publishDeadline();
    // If the config is still on its way, say it again the moment it lands.
    void configReady.then(publishDeadline);
  }
});

// --- 2. DOM-layer send-prevention --------------------------------------------
let bypass = false; // set true immediately before a programmatic re-send
let checking = false;

// Not "the first match on the page": a reply's own editable card can match too
// and come first (SCRUM-442). See composer-pick.ts.
function composerEl(): HTMLElement | null {
  if (!adapter) return null;
  const { composer, composerFallback } = adapter.selectors;
  return pickComposer(document, [composer, composerFallback], sendButtonEl());
}
function sendButtonEl(): HTMLButtonElement | null {
  if (!adapter) return null;
  const { composer, composerFallback, sendButton } = adapter.selectors;
  return pickSendButton(document, sendButton, [composer, composerFallback]);
}
/** Signed-out chatgpt.com's composer is a plain <textarea> (its text is .value). */
function isTextarea(el: Element | null): el is HTMLTextAreaElement {
  return el?.tagName === "TEXTAREA";
}
function composerText(): string {
  const el = composerEl();
  if (isTextarea(el)) return el.value.trim();
  return el ? (el.innerText || el.textContent || "").trim() : "";
}
/** The <form> around the composer, when the site uses a real form (signed-out ChatGPT). */
function composerForm(): HTMLFormElement | null {
  return composerEl()?.closest("form") ?? null;
}

// The bridge deadline is derived from the SAME budget the client works to
// (per-attempt timeout + the 429 back-off budget). A fixed 12s here was shorter
// than the 30s input timeout, so a slow-but-healthy check was abandoned mid-flight
// and the message went out unchecked while the answer was still coming.
//
// The MAIN-world fetch hook guards the same check and cannot read storage at all,
// so it cannot do this for itself. Rather than let it fall back to the defaults —
// which is how it came to abandon a healthy 60s check at 42s — we push the
// effective deadline to it over the bridge the two worlds already use, at startup
// and again whenever the config changes.
let cachedDeadlineMs = bridgeDeadlineMs(DEFAULT_CONFIG);
// The effective (managed-aware) config, for the fail policy when no verdict
// arrives. Every no-verdict path fires after a multi-second deadline, by which
// time this has long loaded; configReady covers the rest.
let cachedConfig: Config | null = null;

function publishDeadline(): void {
  window.postMessage(
    {
      channel: CHANNEL,
      kind: "deadline",
      deadlineMs: cachedDeadlineMs,
      // The MAIN-world hook latches "closed"; it never accepts "open" back.
      failPolicy: cachedConfig?.fail_policy,
    },
    "*",
  );
}

function refreshDeadline(): Promise<void> {
  return requestConfigFromWorker(
    (m, cb) => chrome.runtime.sendMessage(m, cb),
    undefined,
    () => chrome.runtime.lastError,
  )
    .then((cfg) => {
      if (!cfg) return; // no answer: keep what we had; a later check retries
      cachedConfig = cfg;
      cachedDeadlineMs = bridgeDeadlineMs(cfg);
      publishDeadline();
    })
    .catch(() => undefined);
}

const configReady = refreshDeadline();
// A timeout edited in the options page must reach the hook without a page reload,
// or the two bridges disagree again for the rest of the session.
try {
  chrome.storage.onChanged.addListener(() => void refreshDeadline());
} catch {
  /* storage events unavailable — the startup value stands */
}

/** Tell the service worker a message went out with no completed check. */
function reportUnchecked(direction: "input" | "output"): void {
  try {
    chrome.runtime.sendMessage({ type: "dney-unchecked", direction }, () => {
      void chrome.runtime.lastError; // nothing more we can do; the banner already fired
    });
  } catch {
    /* worker gone — the banner is the remaining signal */
  }
}

function checkInput(text: string): Promise<Verdict | null> {
  if (extensionContextGone()) return Promise.resolve(null); // cannot reach the extension
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: Verdict | null) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // Never hang: if the service worker is asleep/gone or drops the message, resolve
    // null (fail-open) so guardSend's `checking` flag always resets. Without this a
    // single dropped check would freeze every subsequent send silently.
    const timer = setTimeout(() => {
      console.warn("[DNey Guard] check timed out — failing open");
      finish(null);
    }, cachedDeadlineMs);
    try {
      chrome.runtime.sendMessage(
        { type: "dney-check", direction: "input", text, metadata: { surface: adapter?.surface ?? "claude-web" } as ClientMeta },
        (v) => {
          clearTimeout(timer);
          if (chrome.runtime.lastError) {
            console.warn("[DNey Guard] check error:", chrome.runtime.lastError.message);
            noteIfInvalidated(chrome.runtime.lastError);
            finish(null);
          } else {
            finish((v as Verdict) ?? null);
          }
        },
      );
    } catch (e) {
      clearTimeout(timer);
      console.warn("[DNey Guard] sendMessage threw:", e);
      noteIfInvalidated(e);
      finish(null);
    }
  });
}

/**
 * Tell the MAIN-world fetch hook this text was already checked -> skip re-check.
 * Synchronous (a DOM event, not postMessage): reSend's click makes the page fetch
 * in this same task, before a posted message would arrive (SCRUM-329).
 */
function preapprove(text: string): void {
  sendPreapproval(text);
}

/** Re-trigger the native send for an allowed/modified message. */
function reSend(): void {
  bypass = true;
  const btn = sendButtonEl();
  const form = composerForm();
  if (btn) {
    btn.click(); // in a form, a submit button's click submits it (bypass covers that too)
  } else if (form) {
    form.requestSubmit();
  } else {
    composerEl()?.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  }
  setTimeout(() => (bypass = false), 0);
}

/** Best-effort replace of the composer text (for `modified`). */
function setComposerText(text: string): void {
  const el = composerEl();
  if (!el) return;
  if (isTextarea(el)) {
    // The NATIVE setter, then an input event: a framework that tracks the value
    // itself (React's value tracker) sees the change instead of swallowing it,
    // and the form's `prompt` field is the new text either way.
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(el, text);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertReplacementText", data: text }));
    return;
  }
  el.focus();
  document.execCommand("selectAll", false);
  document.execCommand("insertText", false, text);
}

async function guardSend(): Promise<void> {
  if (checking) {
    console.debug("[DNey Guard] send ignored — a check is already in flight");
    return;
  }
  const text = composerText();
  if (!text) {
    reSend(); // nothing to check; let the empty/other action proceed
    return;
  }
  checking = true;
  console.debug("[DNey Guard] checking", { site: adapter?.site, len: text.length });
  const spinner = showBanner("checking", "Checking with DNey…", 0);
  try {
    const verdict = await checkInput(text);
    if (!verdict && extensionContextGone()) {
      // Stale tab (the extension updated under it). Use the last policy this tab
      // heard (unknown -> open, as before); asking the worker again cannot work.
      // ONE banner: R1 or R2, never also "could not check".
      const stale = decideStaleTab(text, cachedConfig?.fail_policy);
      spinner.remove();
      const banner = staleTabBanner(stale);
      showBanner(banner.kind, banner.text);
      if (stale.kind === "block") return; // composer keeps its text; nothing sent
      preapprove(text);
      reSend();
      return;
    }
    await configReady;
    if (!cachedConfig) await refreshDeadline(); // the worker was asleep at load: ask again
    // SCRUM-452: where the send cannot be rewritten (claude.ai), a mask blocks instead.
    const decision = blockWhenCannotRewrite(
      decideInput(text, verdict, cachedConfig?.fail_policy ?? "open"),
      adapter?.cannotRewriteSend,
    );
    spinner.remove();
    console.debug("[DNey Guard] verdict:", decision.kind);
    // Fail-open is still the right outcome — it must never block a developer
    // mid-task — but it is not allowed to be SILENT. A throttled or unreachable
    // check that lets the text through says so, on the page and on the badge, so
    // "checked and clean" can never be confused with "never checked".
    // ONE banner per send (SCRUM-401): sendBanner picks it, partial included.
    if (!verdict && decision.kind !== "block") {
      reportUnchecked("input");
      showBanner("warn", uncheckedBannerText(null));
    } else {
      const banner = sendBanner(decision, verdict);
      if (banner) showBanner(banner.kind, banner.text);
    }
    if (decision.kind === "block") return; // composer keeps its text; nothing sent
    if (decision.kind === "modify") {
      setComposerText(decision.text);
      preapprove(decision.text);
      // If the page still sends the original (signed-in ChatGPT), the hook masks it
      // with this instead of checking it again (SCRUM-441).
      sendRewrite(text, decision.text);
      reSend();
      return;
    }
    preapprove(text); // allow
    reSend();
  } finally {
    checking = false;
  }
}

function intercept(e: Event): void {
  if (bypass) return; // our own programmatic re-send
  e.preventDefault();
  e.stopImmediatePropagation();
  void guardSend();
}

// Enter (no Shift, not mid-IME) inside the composer.
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
    const el = composerEl();
    if (!el || !el.contains(e.target as Node)) return;
    intercept(e);
  },
  true,
);

// Send-button click.
document.addEventListener(
  "click",
  (e) => {
    const btn = sendButtonEl();
    if (!btn) return;
    const path = (e as MouseEvent).composedPath?.() ?? [];
    if (e.target === btn || btn.contains(e.target as Node) || path.includes(btn)) intercept(e);
  },
  true,
);

// The composer's form being submitted (signed-out ChatGPT is a real <form>): it
// fires `submit` TWICE per Enter, so this leans on guardSend's `checking` flag
// for one check per send, and preventDefault stops any native POST.
document.addEventListener(
  "submit",
  (e) => {
    const form = composerForm();
    if (form && e.target === form) intercept(e);
  },
  true,
);

console.debug("[DNey Guard] content bridge + composer guard ready");
