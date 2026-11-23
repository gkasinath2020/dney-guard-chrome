// Toolbar popup views. "status": enforcement mode + last 20 audit events + export
// (unchanged apart from the heading). "signup" (SCRUM-395): consumer installs with
// no key; never on a managed install. "success": after a popup signup. "signin"
// (SCRUM-437): consumer installs only, from the signup footer or B3 "exists"; after
// it, the status view leads with S7-S10 and S11. SCRUM-480: a signed-in consumer
// status view offers "Sign out" (confirmed inline), never a sign-in or sign-up link.
// Every onboarding string comes from onboarding-copy.ts (pinned).
import { OUTPUT_NOT_CHECKED, OUTPUT_RAIL_AVAILABLE } from "../lib/config";
import type { ConfigState, LocalArea } from "../lib/config";
import { popupMode } from "../lib/onboarding";
import type { Protections, SigninError, SigninOutcome } from "../lib/signin";
import { TERMS_VERSION } from "../lib/signup";
import type { SignupError, SignupOutcome } from "../lib/signup";
import { CHECKER_UNAVAILABLE_ROW_LABEL, PARTIAL_ROW_LABEL } from "../lib/status";
import type { AuditAction, AuditEvent } from "../lib/types";
import { COPY, LINKS } from "./onboarding-copy";

export interface PopupDeps {
  loadState: () => Promise<ConfigState>;
  /**
   * chrome.storage.local. SCRUM-480: Sign out reads the saved key here for the
   * prefix it shows in the signed-out notice (falling back to the loaded config).
   */
  readLocal?: () => Promise<LocalArea | null>;
  /** chrome.storage.local.remove. SCRUM-480: Sign out removes api_key and api_key_id. */
  removeLocal: (keys: string[]) => Promise<void>;
  /**
   * chrome.storage.sync.remove. SCRUM-480 (Assay #458): Sign out also removes a
   * 0.2.0-era api_key from sync, or migrateSyncKey() on the next popup open would
   * copy it back into local and quietly sign the user in again.
   */
  removeSync?: (keys: string[]) => Promise<void>;
  /** chrome.runtime.sendMessage, promisified. */
  send: (msg: unknown) => Promise<unknown>;
  openOptions: () => void;
  download: (json: string) => void;
}

const ERROR_COPY: Record<SignupError, string> = {
  exists: COPY["B3.exists"],
  invalid_email: COPY["B3.invalid_email"],
  password_short: COPY["B3.password_short"],
  password_long: COPY["B3.password_long"],
  throttled: COPY["B3.throttled"],
  unavailable: COPY["B3.unavailable"],
  unknown: COPY["B3.unknown"],
};

/** S3/G3 by outcome id. S3.unavailable only for a real network failure. */
const SIGNIN_ERROR_COPY: Record<Exclude<SigninError, "not_admin" | "confirm_required">, string> = {
  invalid: COPY["S3.invalid"],
  throttled: COPY["S3.throttled"],
  unavailable: COPY["S3.unavailable"],
  key_kept: COPY["G3b.key_kept"],
  unknown: COPY["G3a.unknown"],
};

/** S7-S10: exactly one, by what the guardrail read found. Only "enforce" is S7. */
const PROTECTIONS_COPY: Record<Protections, string> = {
  enforce: COPY["S7.enforce"],
  monitor: COPY["S8.monitor"],
  disabled: COPY["S9.disabled"],
  none: COPY["S9b.none"],
  unknown: COPY["S10.read_failed"],
};

function el<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const e = doc.createElement(tag);
  Object.assign(e, props);
  for (const c of children) e.append(c);
  return e;
}

function externalLink(doc: Document, href: string, text: string): HTMLAnchorElement {
  return el(doc, "a", { href, target: "_blank", rel: "noopener noreferrer", textContent: text });
}

/**
 * SCRUM-432: the B2 Terms notice (no checkbox, GK 13 Oct). The pinned sentence
 * with its two link texts made links in place; the text is unchanged. Carries the
 * Terms version it shows, which the signup sends only if this is on the page.
 */
export function termsNotice(doc: Document): HTMLParagraphElement {
  const p = el(doc, "p", { id: "terms-notice", className: "terms" });
  p.dataset.termsVersion = TERMS_VERSION;
  const text = COPY["B2.terms_notice"];
  const terms = COPY["B2.terms_link"];
  const privacy = COPY["B2.terms_privacy_link"];
  const [before, rest] = text.split(terms);
  const [mid, after] = rest.split(privacy);
  p.append(before, externalLink(doc, LINKS.terms, terms), mid, externalLink(doc, LINKS.privacy, privacy), after);
  return p;
}

function heading(doc: Document): HTMLHeadingElement {
  return el(doc, "h1", { textContent: COPY["B1.heading"] });
}

/**
 * The B3 line for an error. "exists" (S4) links "Sign in" to the popup sign-in
 * form with the email prefilled (onSignIn); the text is unchanged.
 */
export function errorNode(doc: Document, error: SignupError, onSignIn: () => void): HTMLElement {
  const p = el(doc, "p", { className: "error", id: "signup-error" });
  p.setAttribute("role", "alert");
  const text = ERROR_COPY[error];
  if (error !== "exists") {
    p.textContent = text;
    return p;
  }
  p.append(...linkInPlace(text, COPY["B3.exists_link"], () => {
    const a = el(doc, "a", { href: "#", id: "exists-sign-in", textContent: COPY["B3.exists_link"] });
    a.addEventListener("click", (e) => {
      e.preventDefault();
      onSignIn();
    });
    return a;
  }));
  return p;
}

/** The text with its (first) occurrence of linkText replaced by link(). */
function linkInPlace(text: string, linkText: string, link: () => HTMLAnchorElement): (Node | string)[] {
  const at = text.indexOf(linkText);
  if (at < 0) return [text];
  return [text.slice(0, at), link(), text.slice(at + linkText.length)].filter((x) => x !== "");
}

export function renderSuccess(root: HTMLElement, deps: PopupDeps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const button = el(doc, "button", { id: "see-it", className: "primary", textContent: COPY["B4.button"] });
  button.addEventListener("click", () => {
    void deps.send({ type: "dney-open-welcome" });
  });
  root.append(
    heading(doc),
    el(doc, "h2", { textContent: COPY["B4.title"] }),
    el(doc, "p", { textContent: COPY["B4.body"] }),
    button,
  );
}

export function renderSignup(root: HTMLElement, deps: PopupDeps): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const email = el(doc, "input", { id: "email", type: "email", name: "email", autocomplete: "email" });
  const password = el(doc, "input", { id: "password", type: "password", name: "password", autocomplete: "new-password" });
  password.setAttribute("aria-describedby", "password-hint");
  const submit = el(doc, "button", { id: "create", type: "submit", className: "primary", textContent: COPY["B2.button"] });
  const errorSlot = el(doc, "div", { id: "error-slot" });
  const form = el(
    doc,
    "form",
    { id: "signup", noValidate: true },
    el(doc, "label", { htmlFor: "email", textContent: COPY["B2.label_email"] }),
    email,
    el(doc, "label", { htmlFor: "password", textContent: COPY["B2.label_password"] }),
    password,
    el(doc, "div", { id: "password-hint", className: "hint", textContent: COPY["B2.password_hint"] }),
    termsNotice(doc),
    submit,
    errorSlot,
  );
  // S1: "Already have an account? Sign in" opens the sign-in form here; the
  // smaller "Use an API key instead" opens Settings, as "Use your key" did.
  const signIn = el(doc, "a", { href: "#", id: "sign-in", textContent: COPY["B2.footer_link"] });
  signIn.addEventListener("click", (e) => {
    e.preventDefault();
    renderSignin(root, deps, { email: email.value, hasKey: false });
  });
  const useKey = el(doc, "a", { href: "#", id: "use-key", textContent: COPY["S1.use_key_link"] });
  useKey.addEventListener("click", (e) => {
    e.preventDefault();
    deps.openOptions();
  });

  let busy = false;
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (busy) return;
    busy = true;
    submit.disabled = true;
    submit.textContent = COPY["B2.button_working"];
    errorSlot.replaceChildren();
    let outcome: SignupOutcome | null = null;
    try {
      // terms_version_shown only when the notice is actually on this page.
      const shown = form.querySelector<HTMLElement>("#terms-notice")?.dataset.termsVersion;
      const msg = { type: "dney-signup", email: email.value, password: password.value };
      outcome = (await deps.send(shown ? { ...msg, terms_version_shown: shown } : msg)) as SignupOutcome | null;
    } catch {
      outcome = null;
    }
    if (outcome?.ok) {
      renderSuccess(root, deps);
      return;
    }
    busy = false;
    submit.disabled = false;
    submit.textContent = COPY["B2.button"];
    errorSlot.append(
      errorNode(doc, outcome && !outcome.ok ? outcome.error : "unknown", () =>
        renderSignin(root, deps, { email: email.value.trim(), hasKey: false }),
      ),
    );
  });

  root.append(
    heading(doc),
    el(doc, "h2", { textContent: COPY["B2.title"] }),
    el(doc, "p", { textContent: COPY["B2.intro"] }),
    form,
    el(doc, "p", { className: "small", textContent: COPY["B2.under_button"] }),
    el(doc, "p", { className: "small footer" }, COPY["B2.footer"], " ", signIn),
    el(doc, "p", { className: "small" }, useKey),
  );
}

/**
 * SCRUM-437 S2: sign in with an existing Dney account. No Terms notice (Assay, 14
 * Oct). With a key already saved (hasKey), S6 is asked first and nothing is sent
 * until "Sign in and replace". The worker does the work; this page only ever
 * holds the email and password the user typed.
 */
export function renderSignin(
  root: HTMLElement,
  deps: PopupDeps,
  opts: { email?: string; hasKey: boolean; keyHasNoId?: boolean },
): void {
  const doc = root.ownerDocument;
  root.replaceChildren();
  const email = el(doc, "input", { id: "signin-email", type: "email", name: "email", autocomplete: "email" });
  email.value = opts.email ?? "";
  const password = el(doc, "input", {
    id: "signin-password",
    type: "password",
    name: "password",
    autocomplete: "current-password",
  });
  const submit = el(doc, "button", { id: "signin-submit", type: "submit", className: "primary", textContent: COPY["S2.button"] });
  const confirmSlot = el(doc, "div", { id: "confirm-slot" });
  const errorSlot = el(doc, "div", { id: "error-slot" });
  const form = el(
    doc,
    "form",
    { id: "signin", noValidate: true },
    el(doc, "label", { htmlFor: "signin-email", textContent: COPY["S2.label_email"] }),
    email,
    el(doc, "label", { htmlFor: "signin-password", textContent: COPY["S2.label_password"] }),
    password,
    submit,
    confirmSlot,
    errorSlot,
  );

  let busy = false;
  const idle = () => {
    busy = false;
    submit.disabled = false;
    submit.textContent = COPY["S2.button"];
  };

  const showError = (outcome: SigninOutcome | null) => {
    const p = el(doc, "p", { className: "error", id: "signin-error" });
    p.setAttribute("role", "alert");
    if (outcome && !outcome.ok && outcome.error === "not_admin") {
      p.textContent = outcome.org_name
        ? COPY["S5.not_admin"].replace("{org}", outcome.org_name)
        : COPY["G1.not_admin_no_org"];
    } else {
      const error = outcome && !outcome.ok && outcome.error !== "confirm_required" ? outcome.error : "unknown";
      p.textContent = SIGNIN_ERROR_COPY[error as keyof typeof SIGNIN_ERROR_COPY];
    }
    errorSlot.append(p);
  };

  const send = async (replace: boolean) => {
    busy = true;
    submit.disabled = true;
    submit.textContent = COPY["S2.button_working"];
    confirmSlot.replaceChildren();
    errorSlot.replaceChildren();
    let outcome: SigninOutcome | null = null;
    try {
      const msg = { type: "dney-signin", email: email.value, password: password.value };
      outcome = (await deps.send(replace ? { ...msg, replace: true } : msg)) as SigninOutcome | null;
    } catch {
      outcome = null;
    }
    if (outcome?.ok) {
      renderStatus(root, await deps.loadState(), deps, outcome);
      return;
    }
    idle();
    if (outcome && !outcome.ok && outcome.error === "confirm_required") {
      confirm();
      return;
    }
    showError(outcome);
  };

  // S6: asked before anything is sent. Cancel sends nothing.
  const confirm = () => {
    busy = true;
    submit.disabled = true;
    const yes = el(doc, "button", { id: "replace", type: "button", className: "primary", textContent: COPY["S6.button_replace"] });
    const no = el(doc, "button", { id: "cancel", type: "button", textContent: COPY["S6.button_cancel"] });
    yes.addEventListener("click", () => void send(true));
    no.addEventListener("click", () => {
      confirmSlot.replaceChildren();
      idle();
    });
    const p = el(doc, "p", { id: "signin-confirm", textContent: COPY["S6.confirm"] });
    const nodes: Node[] = [p];
    // The S6 note ONLY when the saved key has no stored id: it will not be revoked.
    if (opts.keyHasNoId) nodes.push(settingsNote(doc, "signin-confirm-note", COPY["S6.note_no_id"]));
    confirmSlot.replaceChildren(...nodes, el(doc, "div", { className: "actions" }, yes, no));
  };

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    if (busy) return;
    errorSlot.replaceChildren();
    if (opts.hasKey) confirm();
    else void send(false);
  });

  root.append(heading(doc), el(doc, "h2", { textContent: COPY["S2.title"] }), form);
  // "New to Dney? Create a free account": back to the signup form. Not offered
  // when a key is already saved: signup never replaces a key.
  if (!opts.hasKey) {
    const create = el(doc, "a", { href: "#", id: "create-account", textContent: COPY["S2.under_form_link"] });
    create.addEventListener("click", (e) => {
      e.preventDefault();
      renderSignup(root, deps);
    });
    root.append(el(doc, "p", { className: "small" }, COPY["S2.under_form"], " ", create));
  }
}

/** The S6 note / S12: "your dashboard's Settings" links to the dashboard's keys. */
function settingsNote(doc: Document, id: string, text: string): HTMLParagraphElement {
  const p = el(doc, "p", { id, className: "small" });
  p.append(...linkInPlace(text, COPY["S6.settings_link"], () => externalLink(doc, LINKS.api_keys, COPY["S6.settings_link"])));
  return p;
}

/** S7-S10 (one line, by the guardrail read) and S11 under it when the org is known. */
function signinResult(doc: Document, outcome: Extract<SigninOutcome, { ok: true }>): HTMLElement {
  const text = PROTECTIONS_COPY[outcome.protections] ?? COPY["S10.read_failed"];
  const line = el(doc, "p", { id: "signin-protections" });
  line.append(
    ...linkInPlace(text, COPY["S8.dashboard_link"], () =>
      externalLink(doc, LINKS.dashboard, COPY["S8.dashboard_link"]),
    ),
  );
  const box = el(doc, "div", { id: "signin-result" }, line);
  if (outcome.org_name) {
    box.append(el(doc, "p", { id: "signin-org", className: "small", textContent: COPY["S11.org"].replace("{org}", outcome.org_name) }));
  }
  // S12 ONLY when the worker says an id'd old key's delete failed.
  if (outcome.old_key_not_revoked === true) box.append(settingsNote(doc, "signin-not-revoked", COPY["S12.revoke_failed"]));
  return box;
}

/** Activity-row labels that differ from the raw action id. */
const ACTION_LABELS: Partial<Record<AuditAction, string>> = {
  partial: PARTIAL_ROW_LABEL,
  checker_unavailable: CHECKER_UNAVAILABLE_ROW_LABEL, // SCRUM-565
};

/** What Sign out removes from chrome.storage.local. welcome_opened is kept. */
export const SIGN_OUT_KEYS = ["api_key", "api_key_id"] as const;

/** The dashboard shows a key as its first 10 characters (raw_key[:10]). */
export const KEY_PREFIX_LENGTH = 10;

/**
 * SCRUM-480: the inline Sign out confirm (never a browser dialog). Cancel puts the
 * actions back untouched. "Sign out": note the key's prefix, ask the worker to
 * clear the audit log and badge, remove the key from storage, and re-mount, which
 * (with no key) is the signup view with the one-time signed-out notice above it.
 * The prefix is passed in memory only; it is never stored.
 */
function signOutConfirm(
  root: HTMLElement,
  actions: HTMLElement,
  cfg: ConfigState["config"],
  deps: PopupDeps,
): HTMLElement {
  const doc = root.ownerDocument;
  const yes = el(doc, "button", { id: "signout-yes", type: "button", className: "primary", textContent: COPY["status.signout_confirm_yes"] });
  const no = el(doc, "button", { id: "signout-cancel", type: "button", textContent: COPY["status.signout_confirm_cancel"] });
  const box = el(
    doc,
    "div",
    { id: "signout-confirm" },
    el(doc, "p", { id: "signout-confirm-text", textContent: COPY["status.signout_confirm"] }),
    el(doc, "div", { className: "actions" }, yes, no),
  );
  no.addEventListener("click", () => {
    box.replaceWith(actions);
  });
  let busy = false;
  yes.addEventListener("click", async () => {
    if (busy) return;
    busy = true;
    yes.disabled = true;
    no.disabled = true;
    let key = cfg.api_key;
    try {
      const local = deps.readLocal ? await deps.readLocal() : null;
      if (local && typeof local.api_key === "string") key = local.api_key;
    } catch {
      // keep the loaded config's key
    }
    const prefix = (key ?? "").slice(0, KEY_PREFIX_LENGTH);
    try {
      await deps.send({ type: "dney-audit-clear" });
    } catch {
      // The worker may be asleep; its buffer is in memory and dies with it.
    }
    try {
      // Sync first: once local is empty, the next config read migrates sync into it.
      if (deps.removeSync) await deps.removeSync(["api_key"]);
    } catch {
      // Best effort; the local remove below still decides what the re-mount shows.
    }
    try {
      await deps.removeLocal([...SIGN_OUT_KEYS]);
    } catch {
      // Re-mounting reads storage: if the key is still there, the status view is
      // shown again rather than a notice that would claim a sign-out.
    }
    await mountPopup(root, deps, { signedOutPrefix: prefix });
  });
  return box;
}

/** SCRUM-480: shown once, above the signup view, right after Sign out. */
function signedOutNotice(doc: Document, prefix: string): HTMLParagraphElement {
  // No readable key means no prefix: its own cleared wording (Assay #458, Hallmark #459).
  const text = prefix
    ? COPY["status.signed_out_notice"].replace("{prefix}", prefix)
    : COPY["status.signed_out_notice_noprefix"];
  const p = el(doc, "p", { id: "signed-out-notice", textContent: text });
  p.setAttribute("role", "status");
  return p;
}

/**
 * The pre-0.3.0 popup, unchanged apart from the heading (B1). SCRUM-437: right
 * after a popup sign-in it leads with the sign-in result. SCRUM-480: a consumer
 * install (always signed in here, see popupMode) gets "Sign out", and no sign-in
 * or sign-up link; a managed install gets neither.
 */
export function renderStatus(
  root: HTMLElement,
  state: ConfigState,
  deps: PopupDeps,
  signedIn?: Extract<SigninOutcome, { ok: true }>,
): void {
  const doc = root.ownerDocument;
  const { config: cfg, managed, managedReadFailed } = state;
  root.replaceChildren();
  const mode = el(doc, "div", { className: "mode", id: "mode" });
  mode.textContent =
    `Input: ${cfg.input_mode} · ${OUTPUT_RAIL_AVAILABLE ? `Output: ${cfg.output_mode}` : OUTPUT_NOT_CHECKED}` +
    ` · On failure: fail-${cfg.fail_policy}` +
    (managed ? " · Managed by your organisation" : "");
  // s303-05 / s303-11: the two states where nothing can be checked are SHOWN,
  // never left to look like a quiet, working extension.
  const warn = el(doc, "div", { className: "warn", id: "warn" });
  warn.textContent = managedReadFailed
    ? "Configuration unavailable: your organisation's settings could not be read. Using the safest settings."
    : managed && !cfg.api_key && !cfg.enrolment_token
      ? "Not set up: this device has no DNey key from your organisation. AI sites are blocked until it is set up."
      : "";
  const body = el(doc, "tbody", { id: "events" });
  const table = el(
    doc,
    "table",
    {},
    el(
      doc,
      "thead",
      {},
      el(doc, "tr", {}, ...["Dir", "Action", "Rails", "ms"].map((h) => el(doc, "th", { textContent: h }))),
    ),
    body,
  );
  const exportBtn = el(doc, "button", { id: "export", textContent: "Export audit log" });
  exportBtn.addEventListener("click", async () => {
    deps.download((await deps.send({ type: "dney-audit-export" })) as string);
  });
  const options = el(doc, "a", { href: "#", id: "options", textContent: "Settings" });
  options.addEventListener("click", (e) => {
    e.preventDefault();
    deps.openOptions();
  });
  const dashboard = externalLink(doc, LINKS.dashboard, COPY["status.dashboard_link"]);
  dashboard.id = "dashboard";
  const actions = el(doc, "div", { className: "actions" }, exportBtn, options, dashboard);
  if (!managed) {
    const signOut = el(doc, "button", { id: "status-sign-out", type: "button", textContent: COPY["status.signout_button"] });
    signOut.addEventListener("click", () => {
      actions.replaceWith(signOutConfirm(root, actions, cfg, deps));
    });
    actions.append(signOut);
  }
  root.append(heading(doc), ...(signedIn ? [signinResult(doc, signedIn)] : []), mode, warn, table, actions);

  void deps.send({ type: "dney-audit-recent" }).then((events) => {
    for (const e of (events as AuditEvent[] | undefined) ?? []) {
      const tr = doc.createElement("tr");
      const cells = [e.direction, ACTION_LABELS[e.action] ?? e.action, e.rails.join(", ") || "—", String(Math.round(e.latency_ms))];
      cells.forEach((c, i) => {
        const td = doc.createElement("td");
        td.textContent = c;
        if (i === 1) td.className = `a-${e.action}`;
        tr.appendChild(td);
      });
      body.appendChild(tr);
    }
  });
}

/**
 * Pick and render the view. opts.signedOutPrefix (SCRUM-480, from Sign out only)
 * puts the signed-out notice above the signup view; it is shown only if the popup
 * really is in signup mode now, and only this once (it is never stored).
 */
export async function mountPopup(
  root: HTMLElement,
  deps: PopupDeps,
  opts: { signedOutPrefix?: string } = {},
): Promise<"signup" | "status"> {
  const state = await deps.loadState();
  const mode = popupMode(state);
  if (mode === "signup") {
    renderSignup(root, deps);
    if (opts.signedOutPrefix !== undefined) root.prepend(signedOutNotice(root.ownerDocument, opts.signedOutPrefix));
  } else renderStatus(root, state, deps);
  return mode;
}
