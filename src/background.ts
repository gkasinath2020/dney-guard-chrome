// Service worker: the ONLY place DNey is called (keeps the API key out of the
// page). Receives check requests relayed from the content script, runs them, and
// maintains the toolbar badge + audit log.
import { loadConfig, loadConfigState, migrateSyncKey } from "./lib/config";
import { guardedCheck } from "./lib/guarded-check";
import { AuditLog } from "./lib/audit";
import { auditAction, badgeState } from "./lib/status";
import type { BadgeState } from "./lib/status";
import type { AuditEvent, ClientMeta, Direction } from "./lib/types";
import { chromeDeps, fromExtensionPage, handleSignin, handleSignup, handleTryCheck, showWelcome } from "./lib/onboarding";

let audit = new AuditLog(500);
let auditCapacity = 500;

function setBadge(state: BadgeState): void {
  const map: Record<BadgeState, { text: string; color: string }> = {
    healthy: { text: "", color: "#1a8f63" },
    degraded: { text: "!", color: "#e0a13c" },
    blocking: { text: "●", color: "#c23b32" },
    disabled: { text: "off", color: "#8892a0" },
  };
  const { text, color } = map[state];
  void chrome.action.setBadgeText({ text });
  void chrome.action.setBadgeBackgroundColor({ color });
}

interface CheckMessage {
  type: "dney-check";
  direction: Direction;
  text: string;
  metadata?: ClientMeta;
}

async function handleCheck(msg: CheckMessage) {
  const config = await loadConfig();
  // Only rebuild the buffer when its capacity actually changed. Rebuilding on
  // every check threw the history away each time, so a throttle recorded at 10:00
  // was gone by 10:01 — the popup could show a clean run that had a fail-open in it.
  if (config.audit_buffer_size !== auditCapacity) {
    auditCapacity = config.audit_buffer_size;
    audit = new AuditLog(auditCapacity);
  }

  const mode = msg.direction === "input" ? config.input_mode : config.output_mode;
  if (mode === "off") {
    return { action: "allowed", text: msg.text, original_text: msg.text, rails_triggered: [], latency_ms: 0, failed: false };
  }

  const verdict = await guardedCheck(config, msg);

  const event: AuditEvent = {
    ts: Date.now(),
    direction: msg.direction,
    action: auditAction(verdict),
    rails: verdict.rails_triggered,
    latency_ms: verdict.latency_ms,
    failed: verdict.failed,
  };
  audit.add(event);
  setBadge(badgeState(verdict));

  // monitor mode: report + log but never act on the verdict. `failed`/`throttled`
  // still travel back — monitor mode suppresses ENFORCEMENT, not the fact that
  // the check never happened.
  if (mode === "monitor") {
    return { action: "allowed", text: msg.text, original_text: msg.text, rails_triggered: verdict.rails_triggered, latency_ms: verdict.latency_ms, failed: verdict.failed, throttled: verdict.throttled };
  }
  return verdict;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // SCRUM-395/396: onboarding. Only the extension's own pages may ask; the popup
  // gets back an outcome id, never a token or a key. SCRUM-437: dney-signin too.
  if (
    msg?.type === "dney-signup" ||
    msg?.type === "dney-signin" ||
    msg?.type === "dney-try-check" ||
    msg?.type === "dney-open-welcome"
  ) {
    if (!fromExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
      sendResponse(null);
      return false;
    }
    const deps = chromeDeps();
    const run =
      msg.type === "dney-signup"
        ? handleSignup(msg, deps)
        : msg.type === "dney-signin"
          ? handleSignin(msg, deps)
          : msg.type === "dney-try-check"
            ? handleTryCheck(msg, deps)
            : showWelcome(deps).then(() => true);
    run.then(sendResponse, () => sendResponse(null));
    return true; // async response
  }
  if (msg?.type === "dney-check") {
    handleCheck(msg as CheckMessage).then(sendResponse);
    return true; // async response
  }
  // The content script could not get an answer at all (worker asleep, bridge
  // deadline blown). The message still went out, so it is recorded and badged as
  // unchecked rather than vanishing — otherwise the only fail-open path with no
  // audit trail would be the one where we know least about what happened.
  if (msg?.type === "dney-unchecked") {
    audit.add({
      ts: Date.now(),
      direction: (msg.direction as Direction) ?? "input",
      action: "unchecked",
      rails: [],
      latency_ms: 0,
      failed: true,
    });
    setBadge("degraded");
    sendResponse(true);
    return false;
  }
  // Content scripts cannot read the managed policy themselves (measured:
  // chrome.storage.managed.get never settles in a content script), so they ask
  // here for the effective, managed-aware config.
  if (msg?.type === "dney-config") {
    loadConfigState()
      .then((st) => sendResponse(st))
      .catch(() => sendResponse(null));
    return true; // async response
  }
  if (msg?.type === "dney-audit-recent") {
    sendResponse(audit.recent(20));
    return false;
  }
  if (msg?.type === "dney-audit-export") {
    sendResponse(audit.exportJSON());
    return false;
  }
  // SCRUM-480: Sign out (popup). Empties the in-memory audit log and puts the badge
  // back to the blank state a fresh, not-set-up install shows (onInstalled below).
  // Destructive, so only the extension's own pages may ask: never a content script.
  if (msg?.type === "dney-audit-clear") {
    if (!fromExtensionPage(sender, chrome.runtime.id, chrome.runtime.getURL(""))) {
      sendResponse(false);
      return false;
    }
    audit.clear();
    setBadge("healthy");
    sendResponse(true);
    return false;
  }
  return false;
});

// SCRUM-395: move a 0.2.0 key out of chrome.storage.sync into local, on update
// and on every browser start (idempotent; every config read also does this first).
chrome.runtime.onInstalled.addListener(() => {
  setBadge("healthy");
  void migrateSyncKey();
});
chrome.runtime.onStartup.addListener(() => {
  void migrateSyncKey();
});
