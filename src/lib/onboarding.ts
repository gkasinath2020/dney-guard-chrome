// SCRUM-395/396: the service-worker side of onboarding, split out of background.ts
// so it can be tested without a service worker. Four messages:
//   dney-signup       (popup)       -> create account + key; key into storage.local
//   dney-signin       (popup)       -> SCRUM-437: log in + key; key into storage.local
//   dney-open-welcome (popup)       -> show the welcome tab
//   dney-try-check    (welcome tab) -> one REAL /api/v1/check with the stored key
// Each accepts only messages from the extension's own pages (never a content
// script, which runs inside claude.ai / chatgpt.com).
import { loadConfigState, readLocal } from "./config";
import type { ConfigState, LocalArea } from "./config";
import { check } from "./dney-client";
import { popupSignin } from "./signin";
import type { SigninOutcome } from "./signin";
import { TERMS_VERSION, popupSignup } from "./signup";
import type { SignupOutcome } from "./signup";
import type { Action } from "./types";

export const WELCOME_PATH = "ui/welcome.html";

export interface OnboardingDeps {
  loadState: () => Promise<ConfigState>;
  readLocal: () => Promise<LocalArea | null>;
  writeLocal: (items: LocalArea) => Promise<void>;
  removeLocal: (keys: string[]) => Promise<void>;
  /** Opens a tab; resolves its id when known. */
  createTab: (url: string, active: boolean) => Promise<number | undefined>;
  /** Focuses a tab; rejects if it no longer exists. */
  focusTab: (id: number) => Promise<void>;
  extensionUrl: (path: string) => string;
  fetchImpl?: typeof fetch;
}

export function chromeDeps(): OnboardingDeps {
  return {
    loadState: loadConfigState,
    readLocal,
    writeLocal: (items) => chrome.storage.local.set(items),
    removeLocal: (keys) => chrome.storage.local.remove(keys),
    createTab: async (url, active) => (await chrome.tabs.create({ url, active }))?.id,
    focusTab: async (id) => {
      await chrome.tabs.update(id, { active: true });
    },
    extensionUrl: (path) => chrome.runtime.getURL(path),
  };
}

/** Only the extension's own pages (popup, welcome tab) may ask for these. */
export function fromExtensionPage(
  sender: { id?: string; url?: string } | undefined,
  ownId: string,
  ownOrigin: string,
): boolean {
  return !!sender && sender.id === ownId && typeof sender.url === "string" && sender.url.startsWith(ownOrigin);
}

/** Popup state: managed installs never see signup; a consumer with no key does. */
export function popupMode(state: Pick<ConfigState, "managed" | "config">): "signup" | "status" {
  return !state.managed && !state.config.api_key ? "signup" : "status";
}

let welcomeTabId: number | undefined;

/**
 * Open the welcome tab ONCE per install, after the first successful popup signup.
 * In the background (active: false) so the popup stays open on "You're set up".
 * Never on install or update: only the signup calls this.
 */
export async function openWelcomeOnce(deps: OnboardingDeps): Promise<void> {
  const local = await deps.readLocal();
  if (local?.welcome_opened) return;
  await deps.writeLocal({ welcome_opened: true });
  welcomeTabId = await deps.createTab(deps.extensionUrl(WELCOME_PATH), false);
}

/** "See it in action": focus the tab we opened, or open it again if it was closed. */
export async function showWelcome(deps: OnboardingDeps): Promise<void> {
  if (welcomeTabId !== undefined) {
    try {
      await deps.focusTab(welcomeTabId);
      return;
    } catch {
      welcomeTabId = undefined;
    }
  }
  welcomeTabId = await deps.createTab(deps.extensionUrl(WELCOME_PATH), true);
}

/** Test seam: forget the tab id between tests. */
export function _resetWelcomeTab(): void {
  welcomeTabId = undefined;
}

export async function handleSignup(
  msg: { email?: unknown; password?: unknown; terms_version_shown?: unknown },
  deps: OnboardingDeps,
): Promise<SignupOutcome> {
  const state = await deps.loadState();
  // Managed installs: never (their key comes from the organisation's policy).
  // A consumer who already has a key: never overwrite it from here.
  if (popupMode(state) !== "signup") return { ok: false, error: "unknown" };
  const email = typeof msg.email === "string" ? msg.email : "";
  const password = typeof msg.password === "string" ? msg.password : "";
  // SCRUM-432: passed on only when the page says it showed the notice, and only
  // the version this build shows; anything else is dropped (no claim of assent).
  const terms_version_shown = msg.terms_version_shown === TERMS_VERSION ? TERMS_VERSION : undefined;
  const outcome = await popupSignup(
    { email, password, terms_version_shown },
    {
      baseUrl: state.config.dney_base_url,
      fetchImpl: deps.fetchImpl,
      storeKey: (key, id) => deps.writeLocal(id ? { api_key: key, api_key_id: id } : { api_key: key }),
    },
  );
  if (outcome.ok) {
    try {
      await openWelcomeOnce(deps);
    } catch {
      // The account and key exist; a tab that failed to open must not read as a
      // failed signup. "See it in action" opens it.
    }
  }
  return outcome;
}

/**
 * SCRUM-437: sign in from the popup. Managed installs: never (no sign-in UI, and
 * the handler refuses too). A consumer who already has a key must have confirmed
 * S6 ("replace"); the old key is revoked only after the new one is stored and
 * verified (signin.ts). No welcome tab: its copy is for a brand-new account.
 */
export async function handleSignin(
  msg: { email?: unknown; password?: unknown; replace?: unknown },
  deps: OnboardingDeps,
): Promise<SigninOutcome> {
  const state = await deps.loadState();
  if (state.managed) return { ok: false, error: "unknown" };
  if (state.config.api_key && msg.replace !== true) return { ok: false, error: "confirm_required" };
  const email = typeof msg.email === "string" ? msg.email : "";
  const password = typeof msg.password === "string" ? msg.password : "";
  return popupSignin(
    { email, password },
    {
      baseUrl: state.config.dney_base_url,
      fetchImpl: deps.fetchImpl,
      store: { read: deps.readLocal, write: deps.writeLocal, remove: deps.removeLocal },
    },
  );
}

/** What the welcome tab is told: the verdict as returned, or that it failed. */
export type TryResult =
  | { ok: true; action: Action; text: string; rails_triggered: string[] }
  | { ok: false };

/**
 * Try-it (SCRUM-396): one real input check with the stored key. No fail-safe
 * substitution: a check that did not complete is reported as not completed, never
 * as "allowed". Not recorded in the audit log or the badge (it is not a message
 * to an AI site).
 */
export async function handleTryCheck(msg: { text?: unknown }, deps: OnboardingDeps): Promise<TryResult> {
  const text = typeof msg.text === "string" ? msg.text : "";
  if (!text.trim()) return { ok: false };
  const { config } = await deps.loadState();
  const verdict = await check({ config, direction: "input", text, fetchImpl: deps.fetchImpl });
  if (verdict.failed) return { ok: false };
  return {
    ok: true,
    action: verdict.action,
    text: verdict.text,
    rails_triggered: Array.isArray(verdict.rails_triggered) ? verdict.rails_triggered : [],
  };
}
