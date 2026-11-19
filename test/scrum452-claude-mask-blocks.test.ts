// @vitest-environment jsdom
// SCRUM-452 (Assay, real-site matrix 19 Oct): claude.ai now sends messages as
// binary protobuf over Connect-RPC (PerformAction). The hook can neither read nor
// rewrite that, and the DOM layer's composer edit does not reach what the site
// sends, so a "modify" verdict showed "DNey modified your message" while the
// ORIGINAL went out. On claude.ai a mask now BLOCKS: nothing is sent, the composer
// keeps the user's text, and the banner says why. These run the REAL main.ts and
// page-hook.ts with the real claude adapter, on a page whose send is PerformAction.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { blockWhenCannotRewrite, cannotMaskHereText } from "../src/lib/enforce";
import { claudeAdapter } from "../src/content/adapter-claude";
import { chatgptAdapter } from "../src/content/adapter-chatgpt";
import type { Verdict } from "../src/lib/types";

// The REAL claude adapter, unmodified (jsdom's URL is not claude.ai).
vi.mock("../src/content/adapters", async (orig) => {
  const real = await orig<typeof import("../src/content/adapters")>();
  return { ...real, getAdapter: () => real.claudeAdapter };
});

const PERFORM_ACTION =
  "https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/PerformAction";
const RAIL = "Input PII Check (EMAIL)";

let checks: string[] = [];
let verdictFor: (text: string) => Verdict;
const verdict = (action: Verdict["action"], text: string, rails: string[] = []): Verdict => ({
  action,
  text,
  original_text: text,
  rails_triggered: rails,
  latency_ms: 1,
  failed: false,
});

let composerValue = "";
const sent: unknown[] = [];
const warns: string[] = [];
let composer: HTMLElement;
let btn: HTMLButtonElement;

/** The site's send: a binary body to PerformAction, synchronously in the click. */
function pageSend(): void {
  const body = new TextEncoder().encode(composerValue);
  void window.fetch(PERFORM_ACTION, { method: "POST", body }).catch(() => undefined);
}

const settle = async () => {
  for (let i = 0; i < 30; i++) await new Promise((r) => setTimeout(r, 0));
};
// A banner's text, without its close button's "×".
const bannerTexts = (kind: string) =>
  [...document.querySelectorAll(`.dney-banner.${kind}`)].map((b) => (b.textContent ?? "").replace(/×$/, ""));

beforeAll(async () => {
  (globalThis as any).chrome = {
    runtime: {
      id: "ext-id",
      lastError: undefined,
      sendMessage(msg: any, cb?: (r: unknown) => void) {
        let resp: unknown;
        if (msg.type === "dney-check") {
          checks.push(msg.text);
          resp = verdictFor(msg.text);
        } else if (msg.type === "dney-config") {
          resp = { config: DEFAULT_CONFIG };
        }
        setTimeout(() => cb?.(resp), 0);
      },
    },
    storage: { onChanged: { addListener() {} } },
  };
  composer = document.createElement("div");
  composer.setAttribute("contenteditable", "true");
  composer.className = "ProseMirror";
  Object.defineProperty(composer, "innerText", { get: () => composerValue, configurable: true });
  btn = document.createElement("button");
  btn.setAttribute("aria-label", "Send message");
  btn.addEventListener("click", pageSend);
  document.body.append(composer, btn);
  (document as any).execCommand = (cmd: string, _ui: boolean, value?: string) => {
    if (cmd === "insertText") composerValue = value ?? "";
    return true;
  };
  window.postMessage = ((data: unknown) => {
    setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data, source: window })), 0);
  }) as typeof window.postMessage;
  window.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push(init?.body);
    return { ok: true } as Response;
  }) as typeof fetch;
  console.warn = (...a: unknown[]) => void warns.push(a.join(" "));
  await import("../src/content/page-hook");
  await import("../src/content/main");
  await settle();
});

beforeEach(() => {
  checks = [];
  sent.length = 0;
  warns.length = 0;
  verdictFor = (text) => verdict("allowed", text);
  document.getElementById("dney-guard-banners")?.replaceChildren();
});

async function userSends(text: string): Promise<void> {
  composerValue = text;
  btn.click();
  await settle();
}

describe("claude.ai: a mask blocks instead (real main.ts + page-hook.ts)", () => {
  it("modify verdict: nothing is sent, the composer keeps the text, ONE block banner with the rule", async () => {
    verdictFor = (t) => verdict("modified", t.replace("a@b.co", "[EMAIL]"), [RAIL]);
    await userSends("contact a@b.co please");
    expect(checks).toEqual(["contact a@b.co please"]);
    expect(sent).toEqual([]); // fail closed: no re-send at all
    expect(composerValue).toBe("contact a@b.co please"); // left for the user to edit
    expect(bannerTexts("block")).toEqual([cannotMaskHereText([RAIL])]);
    expect(bannerTexts("modify")).toEqual([]); // never "DNey modified your message"
  });

  it("allow still sends once (and the DOM verdict before it means no tripwire); block still blocks", async () => {
    await userSends("hello");
    expect(sent).toHaveLength(1);
    expect(warns.filter((w) => w.includes("SCRUM-452"))).toEqual([]);
    sent.length = 0;
    verdictFor = (t) => ({ ...verdict("blocked", "Blocked."), original_text: t, rails_triggered: ["X"] });
    await userSends("bad thing");
    expect(sent).toEqual([]);
  });
});

describe("SCRUM-452 tripwire: a PerformAction with no DOM verdict just before it", () => {
  it("warns once per page and never logs the body", async () => {
    // Well past the window after the previous test's DOM verdict.
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 60_000);
    await window.fetch(PERFORM_ACTION, { method: "POST", body: new TextEncoder().encode("secret a@b.co") });
    await window.fetch(PERFORM_ACTION, { method: "POST", body: new TextEncoder().encode("again") });
    const mine = warns.filter((w) => w.includes("SCRUM-452"));
    expect(mine).toHaveLength(1);
    expect(mine[0]).not.toContain("a@b.co");
    vi.restoreAllMocks();
  });
});

describe("pure parts", () => {
  it("only claude.ai is marked as a send the extension cannot rewrite", () => {
    expect(claudeAdapter.cannotRewriteSend).toBe(true);
    expect(chatgptAdapter.cannotRewriteSend).toBeUndefined();
  });

  it("blockWhenCannotRewrite turns ONLY a modify into a block, carrying the rules", () => {
    const modify = { kind: "modify" as const, text: "x [EMAIL]", rails: [RAIL] };
    expect(blockWhenCannotRewrite(modify, true)).toEqual({
      kind: "block",
      message: cannotMaskHereText([RAIL]),
      rails: [RAIL],
      bare: true,
    });
    expect(blockWhenCannotRewrite(modify, false)).toBe(modify);
    expect(blockWhenCannotRewrite(modify, undefined)).toBe(modify);
    const allow = { kind: "allow" as const, text: "x" };
    expect(blockWhenCannotRewrite(allow, true)).toBe(allow);
  });

  it("the banner is Hallmark's line with the rule name (BANNER_452.md)", () => {
    expect(cannotMaskHereText([RAIL])).toBe(
      "Message not sent (Input PII Check (EMAIL)). DNey Guard can't mask text on claude.ai yet, so it stopped this message instead. Remove that part and send again.",
    );
  });

  it("isUnobservedSendUrl matches PerformAction only", () => {
    expect(claudeAdapter.isUnobservedSendUrl!(PERFORM_ACTION)).toBe(true);
    expect(claudeAdapter.isUnobservedSendUrl!(PERFORM_ACTION + "?x=1")).toBe(true);
    expect(
      claudeAdapter.isUnobservedSendUrl!(
        "https://claude.ai/claudeai-rpc/anthropic.bard.api.v1alpha.ConversationService/StreamTimeline",
      ),
    ).toBe(false);
  });
});
