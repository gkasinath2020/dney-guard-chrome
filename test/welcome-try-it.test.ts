// @vitest-environment jsdom
// SCRUM-396: Try-it shows ONLY what the real verdict returned. The page is wired
// to the real service-worker handler (handleTryCheck -> dney-client check) over
// a fetch that replays responses captured from a local asgard-services.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadConfigState, readLocal } from "../src/lib/config";
import { _resetWelcomeTab, handleTryCheck } from "../src/lib/onboarding";
import type { OnboardingDeps } from "../src/lib/onboarding";
import { COPY, fill } from "../src/ui/onboarding-copy";
import { renderWelcome } from "../src/ui/welcome-view";
import { RAW_KEY, captured, installFakeChrome, removeFakeChrome, responseOf, routedFetch } from "./helpers/onboarding-env";

const CHECK = "/api/v1/check";
const flush = () => new Promise((r) => setTimeout(r, 0));

function deps(fetchImpl: typeof fetch): OnboardingDeps {
  return {
    loadState: loadConfigState,
    readLocal,
    writeLocal: async () => {},
    removeLocal: async () => {},
    createTab: async () => 1,
    focusTab: async () => {},
    extensionUrl: (p) => p,
    fetchImpl,
  };
}

/** The welcome page wired to the real worker handler. */
function mount(fetchImpl: typeof fetch) {
  document.body.innerHTML = '<main id="root"></main>';
  const root = document.getElementById("root")!;
  const send = vi.fn(async (msg: unknown) => handleTryCheck(msg as { text: string }, deps(fetchImpl)));
  renderWelcome(root, { send });
  const click = (label: string) =>
    ([...root.querySelectorAll("button")].find((b) => b.textContent === label) as HTMLButtonElement).click();
  const result = () => (root.querySelector("#try-result")!.textContent ?? "").replace(/\s+/g, " ").trim();
  return { root, send, click, result };
}

beforeEach(() => {
  _resetWelcomeTab();
  installFakeChrome({ local: { api_key: RAW_KEY } }); // the key the popup signup stored
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  removeFakeChrome();
  vi.restoreAllMocks();
});

describe("Try-it renders exactly the real verdict", () => {
  it("prompt-injection sample -> the captured block, named with the C4 name its rule maps to", async () => {
    const f = routedFetch({ [CHECK]: [responseOf(captured("check_injection"))] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_injection_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    // captured rails_triggered: ["Prompt Injection Detection"]
    expect(ui.result()).toBe(fill(COPY["C2.result_blocked"], "Prompt injection protection"));
    expect(ui.result()).toBe("Blocked by Prompt injection protection. On ChatGPT or claude.ai, this message wouldn't have been sent.");
    // the request: the real check endpoint, the stored key, the sample text, input direction
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(`https://api.dney.dev${CHECK}`);
    expect((f.calls[0].init.headers as Record<string, string>)["x-api-key"]).toBe(RAW_KEY);
    expect(JSON.parse(String(f.calls[0].init.body))).toMatchObject({ text: COPY["C2.sample_injection_text"], direction: "input" });
  });

  it("personal-data sample -> the captured mask: the pinned line + the text the SERVER returned", async () => {
    const f = routedFetch({ [CHECK]: [responseOf(captured("check_ssn"))] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_pii_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    // captured rails_triggered: ["Input PII Check (formats)"]
    expect(ui.root.querySelector(".result")!.textContent).toBe(
      "Personal data protection masked part of this message. On ChatGPT or claude.ai, it would have been sent like this:",
    );
    expect(ui.root.querySelector("#masked-text")!.textContent).toBe("My Social Security number is [SSN].");
  });

  it("ordinary sample -> the captured allow", async () => {
    const f = routedFetch({ [CHECK]: [responseOf(captured("check_benign"))] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_benign_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    expect(ui.result()).toBe(COPY["C2.result_allowed"]);
  });

  it("the SAME sample shows whatever the server said (no canned result): injection text, server allows", async () => {
    const f = routedFetch({ [CHECK]: [responseOf({ status: 200, body: { ...(captured("check_benign").body as object), original_text: "x" } })] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_injection_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    expect(ui.result()).toBe(COPY["C2.result_allowed"]);
  });

  it("personal-data text, server blocks under an UNMAPPED (custom) rule -> that rule's own name, that action", async () => {
    const body = { action: "blocked", text: "blocked", original_text: "x", rails_triggered: ["Some Other Rail"], latency_ms: 1 };
    const f = routedFetch({ [CHECK]: [responseOf({ status: 200, body })] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_pii_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    expect(ui.result()).toBe(fill(COPY["C2.result_blocked"], "Some Other Rail"));
  });

  it("a typed message is checked as typed", async () => {
    const f = routedFetch({ [CHECK]: [responseOf(captured("check_benign"))] });
    const ui = mount(f.impl);
    (ui.root.querySelector("#try-text") as HTMLTextAreaElement).value = "my own words";
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    expect(JSON.parse(String(f.calls[0].init.body)).text).toBe("my own words");
  });

  it("while checking: the pinned 'Checking…' on the button", async () => {
    let release!: (r: Response) => void;
    const f = vi.fn(() => new Promise<Response>((r) => (release = r)));
    const ui = mount(f as unknown as typeof fetch);
    ui.click(COPY["C2.sample_benign_button"]);
    ui.click(COPY["C2.button"]);
    await flush();
    await flush();
    const btn = ui.root.querySelector("#try-check")!;
    expect(btn.textContent).toBe(COPY["C2.checking"]);
    release(responseOf(captured("check_benign")));
    await flush();
    await flush();
    await flush();
    expect(btn.textContent).toBe(COPY["C2.button"]);
  });
});

describe("a check that did not complete is never shown as 'Allowed' (fail-open is not a verdict)", () => {
  it.each([
    ["captured 401 (bad key)", [responseOf(captured("check_401"))]],
    ["network failure x2", [new TypeError("Failed to fetch"), new TypeError("Failed to fetch")]],
    ["503 x2", [responseOf({ status: 503, body: {} }), responseOf({ status: 503, body: {} })]],
  ] as const)("%s -> the pinned couldn't-check line", async (_name, responses) => {
    const f = routedFetch({ [CHECK]: [...responses] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_benign_button"]);
    ui.click(COPY["C2.button"]);
    for (let i = 0; i < 6; i++) await flush();
    expect(ui.result()).toBe(COPY["C2.result_failed"]);
  });

  it("no key stored -> couldn't check, and no request is made", async () => {
    removeFakeChrome();
    installFakeChrome();
    const f = routedFetch({});
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_benign_button"]);
    ui.click(COPY["C2.button"]);
    for (let i = 0; i < 4; i++) await flush();
    expect(ui.result()).toBe(COPY["C2.result_failed"]);
    expect(f.calls).toEqual([]);
  });

  it("a block that names no protection -> couldn't check (the page never invents a name)", async () => {
    const body = { action: "blocked", text: "b", original_text: "x", rails_triggered: [], latency_ms: 1 };
    const f = routedFetch({ [CHECK]: [responseOf({ status: 200, body })] });
    const ui = mount(f.impl);
    ui.click(COPY["C2.sample_injection_button"]);
    ui.click(COPY["C2.button"]);
    for (let i = 0; i < 4; i++) await flush();
    expect(ui.result()).toBe(COPY["C2.result_failed"]);
  });

  it("the worker not answering -> couldn't check", async () => {
    document.body.innerHTML = '<main id="root"></main>';
    const root = document.getElementById("root")!;
    renderWelcome(root, { send: async () => { throw new Error("gone"); } });
    (root.querySelector("#try-text") as HTMLTextAreaElement).value = "x";
    (root.querySelector("#try-check") as HTMLButtonElement).click();
    await flush();
    expect(root.querySelector("#try-result")!.textContent).toBe(COPY["C2.result_failed"]);
  });
});
