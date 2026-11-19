// @vitest-environment jsdom
// SCRUM-432: the Terms notice on every signup surface (only the popup offers
// "Create account": the welcome tab opens after signup and Settings takes a key),
// and terms_version_shown is sent ONLY by a signup whose surface rendered it.
// SCRUM-435: a Dashboard link in the popup status view, next to Settings.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mergeConfig } from "../src/lib/config";
import type { ConfigState } from "../src/lib/config";
import { _resetWelcomeTab, handleSignup } from "../src/lib/onboarding";
import type { OnboardingDeps } from "../src/lib/onboarding";
import { TERMS_VERSION, popupSignup } from "../src/lib/signup";
import { mountPopup, renderStatus, renderSuccess } from "../src/ui/popup-view";
import type { PopupDeps } from "../src/ui/popup-view";
import { renderWelcome } from "../src/ui/welcome-view";
import { captured, responseOf, routedFetch } from "./helpers/onboarding-env";

const NOTICE =
  "By creating an account, you confirm you're 18 or older and agree to our Terms of Service. Our Privacy Policy explains how we handle your data.";
const SIGNUP = "/api/v1/auth/signup";
const KEYS = "/api/v1/auth/api-keys";

const consumerNoKey: ConfigState = { config: mergeConfig({}, null), managed: false, managedReadFailed: false };
const consumerWithKey: ConfigState = { config: mergeConfig({}, { api_key: "k" }), managed: false, managedReadFailed: false };

function newRoot(): HTMLElement {
  document.body.innerHTML = '<div id="root"></div>';
  return document.getElementById("root")!;
}
function popupDeps(send: PopupDeps["send"] = async () => [], state = consumerNoKey): PopupDeps {
  return { loadState: async () => state, send, removeLocal: vi.fn(async () => {}), openOptions: vi.fn(), download: vi.fn() };
}
const flush = () => new Promise((r) => setTimeout(r, 0));
const links = (root: HTMLElement) => [...root.querySelectorAll("a")] as HTMLAnchorElement[];

afterEach(() => {
  _resetWelcomeTab();
  vi.restoreAllMocks();
});

describe("SCRUM-432: Terms notice on the popup signup", () => {
  it("exact text, immediately before Create account, links to /terms and /privacy in a new tab", async () => {
    const root = newRoot();
    expect(await mountPopup(root, popupDeps())).toBe("signup");
    const notice = root.querySelector("#terms-notice") as HTMLElement;
    expect(notice.textContent).toBe(NOTICE);
    expect(notice.nextElementSibling).toBe(root.querySelector("#create"));
    expect(root.querySelector("#create")!.textContent).toBe("Create account");
    expect(notice.hidden).toBe(false);
    const a = [...notice.querySelectorAll("a")];
    expect(a.map((x) => [x.textContent, x.getAttribute("href"), x.target, x.rel])).toEqual([
      ["Terms of Service", "https://dney.dev/terms", "_blank", "noopener noreferrer"],
      ["Privacy Policy", "https://dney.dev/privacy", "_blank", "noopener noreferrer"],
    ]);
    // No checkbox (GK 13 Oct), and one Privacy link only (the notice's).
    expect(root.querySelector("input[type=checkbox]")).toBeNull();
    expect(links(root).filter((x) => /privacy/i.test(x.textContent ?? ""))).toHaveLength(1);
  });

  it("styled like the form text (12px, links underlined), never hidden", () => {
    const html = readFileSync(join(__dirname, "..", "src", "ui", "popup.html"), "utf8");
    expect(html).toMatch(/\.terms \{ font-size: 12px;/);
    expect(html).toMatch(/\.terms a \{ text-decoration: underline; \}/);
    expect(html).not.toMatch(/\.terms[^{]*\{[^}]*display: none/);
  });

  it("the signed-in status view, the success view and the welcome tab show no notice and no Create account", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps());
    expect(root.querySelector("#terms-notice")).toBeNull();
    expect(root.textContent).not.toContain("Terms of Service");
    renderSuccess(root, popupDeps());
    expect(root.querySelector("#terms-notice")).toBeNull();
    renderWelcome(root, { send: async () => null });
    expect(root.textContent).not.toContain("Terms of Service");
    expect(root.textContent).not.toContain("Create account");
  });
});

describe("SCRUM-432: terms_version_shown only when the notice was rendered", () => {
  async function submit(root: HTMLElement) {
    (root.querySelector("#email") as HTMLInputElement).value = "me@example.com";
    (root.querySelector("#password") as HTMLInputElement).value = "correct-horse-1";
    (root.querySelector("form") as HTMLFormElement).requestSubmit();
    await flush();
  }

  it("popup with the notice rendered: sends terms_version_shown 2026-10-14", async () => {
    const root = newRoot();
    const send = vi.fn(async (_m: unknown) => ({ ok: false, error: "unknown" }));
    await mountPopup(root, popupDeps(send));
    await submit(root);
    expect(send).toHaveBeenCalledWith(expect.objectContaining({ type: "dney-signup", terms_version_shown: "2026-10-14" }));
  });

  it("the notice not on the page: the message carries no terms_version_shown", async () => {
    const root = newRoot();
    const send = vi.fn(async (_m: unknown) => ({ ok: false, error: "unknown" }));
    await mountPopup(root, popupDeps(send));
    root.querySelector("#terms-notice")!.remove();
    await submit(root);
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toEqual({ type: "dney-signup", email: "me@example.com", password: "correct-horse-1" });
  });

  it("TERMS_VERSION is the server's and the web UI's 2026-10-14", () => {
    expect(TERMS_VERSION).toBe("2026-10-14");
  });

  function workerDeps(fetchImpl: typeof fetch): OnboardingDeps {
    return {
      loadState: async () => consumerNoKey,
      readLocal: async () => ({}),
      writeLocal: async () => {},
      removeLocal: async () => {},
      createTab: async () => 1,
      focusTab: async () => {},
      extensionUrl: (p) => `chrome-extension://x/${p}`,
      fetchImpl,
    };
  }
  const okFetch = () =>
    routedFetch({ [SIGNUP]: [responseOf(captured("signup_201"))], [KEYS]: [responseOf(captured("api_key_201"))] });
  const signupBody = (f: ReturnType<typeof routedFetch>) => JSON.parse(String(f.calls[0].init.body));

  it("worker: a message that showed the notice -> the signup body includes terms_version_shown", async () => {
    const f = okFetch();
    const out = await handleSignup({ email: "me@example.com", password: "correct-horse-1", terms_version_shown: "2026-10-14" }, workerDeps(f.impl));
    expect(out).toEqual({ ok: true });
    expect(signupBody(f).terms_version_shown).toBe("2026-10-14");
  });

  it.each([
    ["absent", undefined],
    ["a different version", "2020-01-01"],
    ["not a string", 20261014],
  ])("worker: terms_version_shown %s -> the signup body has no terms_version_shown", async (_name, v) => {
    const f = okFetch();
    const msg: Record<string, unknown> = { email: "me@example.com", password: "correct-horse-1" };
    if (v !== undefined) msg.terms_version_shown = v;
    await handleSignup(msg, workerDeps(f.impl));
    expect("terms_version_shown" in signupBody(f)).toBe(false);
  });

  it("popupSignup: sends the field only when given", async () => {
    const withIt = okFetch();
    await popupSignup({ email: "a@b.co", password: "pw-pw-pw-pw", terms_version_shown: TERMS_VERSION }, { baseUrl: "https://api.dney.dev", fetchImpl: withIt.impl, storeKey: async () => {} });
    expect(signupBody(withIt)).toEqual({
      org_name: "My workspace",
      email: "a@b.co",
      password: "pw-pw-pw-pw",
      source: { channel: "extension" },
      terms_version_shown: "2026-10-14",
    });
    const without = okFetch();
    await popupSignup({ email: "a@b.co", password: "pw-pw-pw-pw" }, { baseUrl: "https://api.dney.dev", fetchImpl: without.impl, storeKey: async () => {} });
    expect("terms_version_shown" in signupBody(without)).toBe(false);
  });
});

describe("SCRUM-435: Dashboard link in the popup status view", () => {
  it("next to Settings, href exactly https://dney.dev/dashboard, new tab; Export and Settings still render", () => {
    const root = newRoot();
    renderStatus(root, consumerWithKey, popupDeps());
    const actions = root.querySelector(".actions")!;
    // SCRUM-480: then the consumer's "Sign out" (it replaced SCRUM-437's "Sign in").
    expect([...actions.children].map((c) => c.id)).toEqual(["export", "options", "dashboard", "status-sign-out"]);
    const d = root.querySelector("#dashboard") as HTMLAnchorElement;
    expect(d.textContent).toBe("Dashboard");
    expect(d.getAttribute("href")).toBe("https://dney.dev/dashboard");
    expect(d.target).toBe("_blank");
    expect(d.rel).toBe("noopener noreferrer");
    expect(root.querySelector("#export")!.textContent).toBe("Export audit log");
    expect(root.querySelector("#options")!.textContent).toBe("Settings");
  });

  it("the signup-mode popup has no Dashboard link", async () => {
    const root = newRoot();
    expect(await mountPopup(root, popupDeps())).toBe("signup");
    expect(root.querySelector("#dashboard")).toBeNull();
    expect(links(root).some((a) => a.textContent === "Dashboard" || a.href.includes("/dashboard"))).toBe(false);
  });
});
