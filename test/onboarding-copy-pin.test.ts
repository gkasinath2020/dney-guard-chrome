// @vitest-environment jsdom
// SCRUM-392: the popup signup and the welcome tab are PINNED to the cleared copy
// (marketing/ONBOARDING_COPY.md v1.3), both ways: every pinned string is shown,
// and NOTHING beyond the pinned copy is shown. The fixture was extracted from the
// copy file by line, not from the source.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeConfig } from "../src/lib/config";
import type { ConfigState } from "../src/lib/config";
import type { SignupError } from "../src/lib/signup";
import { COPY, LINKS } from "../src/ui/onboarding-copy";
import { mountPopup, renderStatus, renderSuccess } from "../src/ui/popup-view";
import type { PopupDeps } from "../src/ui/popup-view";
import { renderWelcome } from "../src/ui/welcome-view";
import pinned from "./fixtures/scrum392/onboarding_copy_pinned.json";
import { captured } from "./helpers/onboarding-env";

const P = pinned.copy as Record<string, string>;
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

/** Remove each pinned string once per occurrence; what is left is unpinned text. */
function unpinnedRest(text: string, strings: string[]): string {
  let rest = norm(text);
  for (const s of [...strings].sort((a, b) => b.length - a.length)) rest = rest.split(norm(s)).join(" ");
  return rest.replace(/[\s:]+/g, " ").trim();
}

function newRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root")!;
}

const consumerNoKey: ConfigState = { config: mergeConfig({}, null), managed: false, managedReadFailed: false };
const managedState: ConfigState = { config: mergeConfig({ api_key: "school" }, null), managed: true, managedReadFailed: false };

function popupDeps(send: PopupDeps["send"] = async () => null, state = consumerNoKey): PopupDeps {
  return { loadState: async () => state, send, removeLocal: vi.fn(async () => {}), openOptions: vi.fn(), download: vi.fn() };
}

const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => vi.restoreAllMocks());

describe("source <-> fixture (same commit)", () => {
  it("src/ui/onboarding-copy.ts equals the pinned copy exactly, both ways", () => {
    expect({ ...COPY }).toEqual(P);
    expect({ ...LINKS }).toEqual(pinned.links);
  });

  it("the welcome tab's <title> is the pinned C tab title", () => {
    const html = readFileSync(join(__dirname, "..", "src", "ui", "welcome.html"), "utf8");
    expect(html).toContain(`<title>${P["C.tab_title"]}</title>`);
  });

  it("the server's own messages for 422 password / 429 match the pinned B3 lines (captured, local origin/main)", () => {
    const msg = (n: string) => (captured(n).body as { detail: { msg: string }[] }).detail[0].msg;
    expect(msg("signup_422_short")).toBe(P["B3.password_short"]);
    expect(msg("signup_422_long")).toBe(P["B3.password_long"]);
    expect((captured("signup_429").body as { detail: string }).detail).toBe(P["B3.throttled"]);
  });

  it("HELD strings appear nowhere in the source, and the stale heading is gone", () => {
    const files: string[] = [];
    const walk = (d: string) => {
      for (const f of readdirSync(d)) {
        const p = join(d, f);
        statSync(p).isDirectory() ? walk(p) : files.push(p);
      }
    };
    walk(join(__dirname, "..", "src"));
    const all = files.map((f) => readFileSync(f, "utf8")).join("\n");
    for (const held of Object.values(pinned.held_not_shown)) expect(all).not.toContain(held);
    expect(all).not.toContain("DNey Guard for Claude");
    // SCRUM-432: the Terms line is a notice only (GK 13 Oct), never an "I agree" control.
    expect(all).not.toMatch(/I agree/i);
  });
});

describe("popup (B): pinned both ways in every state", () => {
  const B2_SHOWN = ["B1.heading", "B2.title", "B2.intro", "B2.label_email", "B2.label_password", "B2.password_hint", "B2.button", "B2.terms_notice", "B2.under_button", "B2.footer", "B2.footer_link", "S1.use_key_link"];

  it("signup state: every B1/B2 string, and nothing else", async () => {
    const root = newRoot();
    expect(await mountPopup(root, popupDeps())).toBe("signup");
    const text = norm(root.textContent ?? "");
    for (const id of B2_SHOWN) expect(text).toContain(norm(P[id]));
    expect(unpinnedRest(text, B2_SHOWN.map((id) => P[id]))).toBe("");
    // Links go where the copy says.
    const href = (t: string) => ([...root.querySelectorAll("a")].find((a) => a.textContent === t) as HTMLAnchorElement).href;
    expect(href(P["B2.terms_link"])).toBe(pinned.links.terms);
    expect(href(P["B2.terms_privacy_link"])).toBe(pinned.links.privacy);
    // No organisation field (copy B2), no Terms checkbox (notice only, GK 13 Oct).
    expect(root.querySelectorAll("input").length).toBe(2);
    expect(root.querySelector("input[type=checkbox]")).toBeNull();
  });

  it("S1: 'Use an API key instead' opens Settings", async () => {
    const root = newRoot();
    const deps = popupDeps();
    await mountPopup(root, deps);
    (root.querySelector("#use-key") as HTMLAnchorElement).click();
    expect(deps.openOptions).toHaveBeenCalledTimes(1);
  });

  it("while working: the button says the pinned working text, and the form sends ONLY email + password + the Terms version shown", async () => {
    const root = newRoot();
    let release!: (v: unknown) => void;
    const send = vi.fn(() => new Promise((r) => (release = r)));
    await mountPopup(root, popupDeps(send));
    (root.querySelector("#email") as HTMLInputElement).value = "me@example.com";
    (root.querySelector("#password") as HTMLInputElement).value = "correct-horse-1";
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
    expect(root.querySelector("#create")!.textContent).toBe(P["B2.button_working"]);
    expect(send).toHaveBeenCalledWith({
      type: "dney-signup",
      email: "me@example.com",
      password: "correct-horse-1",
      terms_version_shown: "2026-10-14",
    });
    release({ ok: true });
    await flush();
  });

  const ERRORS: [SignupError, string][] = [
    ["exists", "B3.exists"],
    ["invalid_email", "B3.invalid_email"],
    ["password_short", "B3.password_short"],
    ["password_long", "B3.password_long"],
    ["throttled", "B3.throttled"],
    ["unavailable", "B3.unavailable"],
    ["unknown", "B3.unknown"],
  ];

  it.each(ERRORS)("error %s -> exactly the pinned %s line, and the form is usable again", async (error, id) => {
    const root = newRoot();
    await mountPopup(root, popupDeps(async () => ({ ok: false, error })));
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
    expect(norm(root.querySelector("#signup-error")!.textContent ?? "")).toBe(P[id]);
    expect(unpinnedRest(root.textContent ?? "", [...B2_SHOWN.map((i) => P[i]), P[id]])).toBe("");
    expect((root.querySelector("#create") as HTMLButtonElement).disabled).toBe(false);
    expect(root.querySelector("#create")!.textContent).toBe(P["B2.button"]);
  });

  it("'exists' (S4): 'Sign in' opens the popup sign-in form with the email prefilled", async () => {
    const root = newRoot();
    const deps = popupDeps(async () => ({ ok: false, error: "exists" }));
    await mountPopup(root, deps);
    (root.querySelector("#email") as HTMLInputElement).value = " me@example.com ";
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
    const links = [...root.querySelectorAll("#signup-error a")] as HTMLAnchorElement[];
    expect(links.map((a) => a.textContent)).toEqual([P["B3.exists_link"]]);
    links[0].click();
    expect(root.querySelector("form")!.id).toBe("signin");
    expect((root.querySelector("#signin-email") as HTMLInputElement).value).toBe("me@example.com");
    expect(deps.openOptions).not.toHaveBeenCalled();
  });

  it("no answer from the service worker -> the pinned unknown line (never silence)", async () => {
    const root = newRoot();
    await mountPopup(root, popupDeps(async () => { throw new Error("worker gone"); }));
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
    expect(root.querySelector("#signup-error")!.textContent).toBe(P["B3.unknown"]);
  });

  it("success state (B4): heading + B4 only; 'See it in action' asks the worker to show the welcome tab", async () => {
    const root = newRoot();
    const send = vi.fn(async (m: unknown) => ((m as { type: string }).type === "dney-signup" ? { ok: true } : true));
    await mountPopup(root, popupDeps(send));
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
    const shown = ["B1.heading", "B4.title", "B4.body", "B4.button"].map((i) => P[i]);
    for (const s of shown) expect(norm(root.textContent ?? "")).toContain(s);
    expect(unpinnedRest(root.textContent ?? "", shown)).toBe("");
    (root.querySelector("#see-it") as HTMLButtonElement).click();
    expect(send).toHaveBeenLastCalledWith({ type: "dney-open-welcome" });
  });

  it("MANAGED install: no signup form, ever; the heading is the pinned one", async () => {
    const root = newRoot();
    const send = vi.fn(async () => []);
    expect(await mountPopup(root, popupDeps(send, managedState))).toBe("status");
    expect(root.querySelector("form")).toBeNull();
    expect(root.querySelector("input")).toBeNull();
    expect(root.textContent).not.toContain(P["B2.title"]);
    expect(root.querySelector("h1")!.textContent).toBe(P["B1.heading"]);
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: "dney-signup" }));
  });

  it("MANAGED with no key in the policy (the 'Not set up' state) still shows no signup", async () => {
    const root = newRoot();
    const st: ConfigState = { config: mergeConfig({ fail_policy: "closed" }, null), managed: true, managedReadFailed: false };
    expect(await mountPopup(root, popupDeps(async () => [], st))).toBe("status");
    expect(root.querySelector("form")).toBeNull();
    expect(root.textContent).toContain("Not set up: this device has no DNey key from your organisation.");
  });

  it("consumer WITH a key: the status view, pinned heading (B1 'all states')", async () => {
    const root = newRoot();
    const st: ConfigState = { config: mergeConfig({}, { api_key: "k" }), managed: false, managedReadFailed: false };
    renderStatus(root, st, popupDeps(async () => []));
    expect(root.querySelector("h1")!.textContent).toBe(P["B1.heading"]);
    // the pre-0.3.0 status view is otherwise unchanged
    expect(root.querySelector("#mode")!.textContent).toBe("Input: enforce · AI replies: not checked yet · On failure: fail-open");
    expect([...root.querySelectorAll("th")].map((t) => t.textContent)).toEqual(["Dir", "Action", "Rails", "ms"]);
    expect(root.querySelector("#export")!.textContent).toBe("Export audit log");
    expect(root.querySelector("form")).toBeNull();
    renderSuccess(root, popupDeps());
    expect(root.querySelector("h1")!.textContent).toBe(P["B1.heading"]);
  });
});

describe("welcome tab (C): pinned both ways", () => {
  const C_STATIC = [
    "C1.heading", "C1.lead", "C2.heading", "C2.intro", "C2.sample_injection_button", "C2.sample_pii_button", "C2.sample_benign_button",
    "C2.textbox_label", "C2.button", "C3.heading", "C3.blocked_label", "C3.blocked_line", "C3.not_checked_label", "C3.not_checked_line",
    "C4.heading", "C4.injection_name", "C4.injection_line", "C4.pii_name", "C4.pii_line", "C4.exfil_name", "C4.exfil_line",
    "C4.below", "C4.button", "C5.footer", "C5.privacy_link",
  ];

  it("static content: every C string, nothing else; title; Masked banner line HELD", () => {
    const root = newRoot();
    renderWelcome(root, { send: async () => null });
    const text = norm(root.textContent ?? "");
    for (const id of C_STATIC) expect(text).toContain(norm(P[id]));
    expect(unpinnedRest(text, C_STATIC.map((i) => P[i]))).toBe("");
    expect(document.title).toBe(P["C.tab_title"]);
    for (const held of Object.values(pinned.held_not_shown)) expect(text).not.toContain(held);
    const href = (t: string) => ([...root.querySelectorAll("a")].find((a) => a.textContent === t) as HTMLAnchorElement).href;
    expect(href(P["C4.button"])).toBe(pinned.links.dashboard);
    expect(href(P["C5.privacy_link"])).toBe(pinned.links.privacy);
  });

  it("each sample button fills the box with the pinned sample text (and sends nothing)", () => {
    const root = newRoot();
    const send = vi.fn(async () => null);
    renderWelcome(root, { send });
    const box = root.querySelector("#try-text") as HTMLTextAreaElement;
    const btn = (label: string) => [...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement;
    btn(P["C2.sample_injection_button"]).click();
    expect(box.value).toBe(P["C2.sample_injection_text"]);
    btn(P["C2.sample_pii_button"]).click();
    expect(box.value).toBe(P["C2.sample_pii_text"]);
    btn(P["C2.sample_benign_button"]).click();
    expect(box.value).toBe(P["C2.sample_benign_text"]);
    expect(send).not.toHaveBeenCalled();
  });
});
