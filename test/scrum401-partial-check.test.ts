// @vitest-environment jsdom
// SCRUM-401 (client): the server now says when a check was only PARTLY judged
// ("checked": "partial"). It used to look exactly like a clean pass. GK's SCRUM-391
// decision: personal (fail-open) installs send with a warning; fail-closed blocks.
// Runs the REAL main.ts and page-hook.ts in one jsdom page; the stub worker runs the
// REAL client check() against a fake server and records the badge and audit action
// the service worker would set, so the whole path is the production one.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_CONFIG } from "../src/lib/config";
import { FAIL_MESSAGES, KEY_REJECTED_MESSAGE, check } from "../src/lib/dney-client";
import { applyPartialPolicy, decideInput, sendBanner } from "../src/lib/enforce";
import { guardedCheck } from "../src/lib/guarded-check";
import {
  PARTIAL_BLOCK_MESSAGE,
  PARTIAL_MODIFY_SUFFIX,
  PARTIAL_ROW_LABEL,
  PARTIAL_SENT_MESSAGE,
  auditAction,
  badgeState,
  isPartial,
  uncheckedBannerText,
} from "../src/lib/status";
import type { AuditEvent, Config, Verdict } from "../src/lib/types";
import { renderStatus } from "../src/ui/popup-view";

vi.mock("../src/content/adapters", async (orig) => {
  const real = await orig<typeof import("../src/content/adapters")>();
  // The site-agnostic modify mechanism, exercised on a send the hook CAN rewrite
  // (claude.ai's legacy /completion). Real claude.ai now sends through a channel
  // it cannot rewrite, so there a mask BLOCKS instead (SCRUM-452,
  // test/scrum452-claude-mask-blocks.test.ts); these keep the mechanism covered.
  return { ...real, getAdapter: () => ({ ...real.claudeAdapter, cannotRewriteSend: false }) };
});

const COMPLETION = "https://claude.ai/api/organizations/abc-123/chat_conversations/def-456/completion";
const UNCHECKED_IDS = [
  "check_failed",
  "rails_degraded",
  "timed_out_blocked",
  "timed_out_unchecked",
  "input_rejected_blocked",
  "input_rejected_unchecked",
  "pattern_unchecked_blocked",
  "pattern_unchecked_passed",
  "other",
];

const P1 = "DNey only partly checked that message: some of your protections couldn't run, so it was sent WITHOUT being fully checked.";
const P2 = "Blocked: DNey could not fully check this message, and this organization uses a fail-closed policy.";
const P4 = "Blocked: this browser's DNey API key isn't working, and this organization uses a fail-closed policy. Ask your administrator for a new key.";
const P5 =
  "DNey modified your message (Input PII Check (EMAIL)). Some of your protections couldn't run, so it was sent WITHOUT being fully checked.";

// --- the fake DNey server (what POST /api/v1/check answers) ------------------
type ServerBody = Record<string, unknown>;
let serverFor: (text: string) => ServerBody;
const body = (action: string, text: string, over: ServerBody = {}): ServerBody => ({
  action,
  text,
  original_text: text,
  rails_triggered: [],
  latency_ms: 1,
  ...over,
});
const partial = (action: string, text: string, over: ServerBody = {}): ServerBody =>
  body(action, text, { checked: "partial", unchecked: ["pattern_unchecked_passed", "timed_out_unchecked"], ...over });
const fakeServer = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
  const { text } = JSON.parse(String(init?.body));
  return { ok: true, status: 200, json: async () => serverFor(text), headers: { get: () => null } } as unknown as Response;
});

// --- stub worker: the real check(), plus the badge + audit the worker records ---
let config: Config = { ...DEFAULT_CONFIG, api_key: "dk_test", fail_policy: "open" };
let checks: string[] = [];
let badges: string[] = [];
let audits: string[] = [];
const storageListeners: (() => void)[] = [];

// --- the page ----------------------------------------------------------------
let composerValue = "";
const pageFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({ ok: true }) as Response);
let btn: HTMLButtonElement;

function pageSend(): void {
  void window
    .fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: composerValue }) })
    .catch(() => undefined);
}
const settle = async () => {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 0));
};
const sentPrompts = () => pageFetch.mock.calls.map((c) => JSON.parse(String(c[1]?.body)).prompt);
/** Every banner on the page except the transient "checking" spinner. */
const shown = () =>
  [...document.querySelectorAll(".dney-banner:not(.checking)")].map((b) => ({
    kind: b.className.replace("dney-banner ", ""),
    text: b.querySelector(".msg")?.textContent ?? "",
  }));

beforeAll(async () => {
  (globalThis as any).chrome = {
    runtime: {
      id: "ext-id", // a live context (a dead one has none: stale-tab-banner.test.ts)
      lastError: undefined,
      sendMessage(msg: any, cb?: (r: unknown) => void) {
        void (async () => {
          let resp: unknown;
          if (msg.type === "dney-check") {
            checks.push(msg.text);
            const v = await check({ config, direction: msg.direction, text: msg.text, fetchImpl: fakeServer });
            badges.push(badgeState(v));
            audits.push(auditAction(v));
            resp = v;
          } else if (msg.type === "dney-config") {
            resp = { config };
          } else if (msg.type === "dney-unchecked") {
            badges.push("degraded");
            audits.push("unchecked");
          }
          setTimeout(() => cb?.(resp), 0);
        })();
      },
    },
    storage: { onChanged: { addListener: (l: () => void) => storageListeners.push(l) } },
  };
  const composer = document.createElement("div");
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
  window.fetch = pageFetch as unknown as typeof fetch;
  await import("../src/content/page-hook");
  await import("../src/content/main");
  await settle();
});

beforeEach(() => {
  checks = [];
  badges = [];
  audits = [];
  pageFetch.mockClear();
  serverFor = (t) => body("allowed", t);
  document.getElementById("dney-guard-banners")?.replaceChildren();
});

async function userSends(text: string): Promise<void> {
  composerValue = text;
  btn.click();
  await settle();
}
/** A completion the page sends by itself: no DOM send, only the fetch hook sees it. */
async function programmaticSend(text: string): Promise<void> {
  await window.fetch(COMPLETION, { method: "POST", body: JSON.stringify({ prompt: text }) }).catch(() => undefined);
  await settle();
}
const neverShowsIds = () => {
  for (const b of shown()) for (const id of UNCHECKED_IDS) expect(b.text).not.toContain(id);
};

const SENDERS = [
  ["DOM send", userSends],
  ["fetch hook only", programmaticSend],
] as const;

// Order matters: the hook LATCHES "closed" once told, so the open cases run first.
describe.each(SENDERS)("fail-open install (%s)", (_name, send) => {
  it("partial + allowed -> sent, ONE banner = P1, badge degraded, audit 'partial'", async () => {
    serverFor = (t) => partial("allowed", t);
    await send("partly checked hello");
    expect(checks).toEqual(["partly checked hello"]);
    expect(sentPrompts()).toEqual(["partly checked hello"]);
    expect(shown()).toEqual([{ kind: "warn", text: P1 }]);
    expect(badges).toEqual(["degraded"]);
    expect(audits).toEqual(["partial"]);
    neverShowsIds();
  });

  it("partial + modified -> modified text sent, ONE banner = P5 exactly", async () => {
    serverFor = (t) =>
      partial("modified", "mail me at [EMAIL]", { original_text: t, rails_triggered: ["Input PII Check (EMAIL)"] });
    await send("mail me at a@b.co");
    expect(sentPrompts()).toEqual(["mail me at [EMAIL]"]);
    expect(shown()).toEqual([{ kind: "modify", text: P5 }]);
    expect(badges).toEqual(["degraded"]);
    expect(audits).toEqual(["partial"]);
    neverShowsIds();
  });

  it("partial + blocked -> ONE block banner, no P1", async () => {
    serverFor = () => partial("blocked", "Blocked for safety.", { unchecked: ["timed_out_blocked"] });
    await send("partial and blocked");
    expect(pageFetch).not.toHaveBeenCalled();
    const b = shown();
    expect(b).toHaveLength(1);
    expect(b[0].kind).toBe("block");
    expect(b[0].text).not.toContain(P1);
    expect(badges).toEqual(["blocking"]);
    expect(audits).toEqual(["blocked"]);
    neverShowsIds();
  });

  it("complete + modified -> the existing modified banner, unchanged", async () => {
    serverFor = (t) =>
      body("modified", "mail me at [EMAIL]", {
        original_text: t,
        rails_triggered: ["Input PII Check (EMAIL)"],
        checked: "complete",
        unchecked: [],
      });
    await send("mail me at c@d.co");
    expect(sentPrompts()).toEqual(["mail me at [EMAIL]"]);
    expect(shown()).toEqual([{ kind: "modify", text: "DNey modified your message (Input PII Check (EMAIL))." }]);
    expect(audits).toEqual(["modified"]);
  });

  it("a missing 'checked' field -> complete: sent, no banner, badge healthy, audit 'allowed'", async () => {
    serverFor = (t) => body("allowed", t);
    await send("older server");
    expect(sentPrompts()).toEqual(["older server"]);
    expect(shown()).toEqual([]);
    expect(badges).toEqual(["healthy"]);
    expect(audits).toEqual(["allowed"]);
  });
});

describe("fail-closed install", () => {
  beforeAll(async () => {
    config = { ...config, fail_policy: "closed" };
    storageListeners.forEach((l) => l());
    await settle();
  });

  describe.each(SENDERS)("%s", (_name, send) => {
    it("partial + allowed -> NOT sent, one block banner containing P2", async () => {
      serverFor = (t) => partial("allowed", t);
      await send("closed partial allowed");
      expect(pageFetch).not.toHaveBeenCalled();
      const b = shown();
      expect(b).toHaveLength(1);
      expect(b[0].kind).toBe("block");
      expect(b[0].text).toBe(P2); // bare: not a policy match (Hallmark, 14 Oct)
      expect(b[0].text).not.toContain(P1);
      expect(badges).toEqual(["blocking"]);
      expect(audits).toEqual(["blocked"]);
      neverShowsIds();
    });

    it("partial + modified -> NOT sent, blocked with P2", async () => {
      serverFor = (t) =>
        partial("modified", "mail me at [EMAIL]", { original_text: t, rails_triggered: ["Input PII Check (EMAIL)"] });
      await send("closed mail me at a@b.co");
      expect(pageFetch).not.toHaveBeenCalled();
      const b = shown();
      expect(b).toHaveLength(1);
      expect(b[0].kind).toBe("block");
      expect(b[0].text).toBe(P2); // bare: not a policy match (Hallmark, 14 Oct)
      neverShowsIds();
    });

    it("complete + allowed -> sent, no banner", async () => {
      serverFor = (t) => body("allowed", t, { checked: "complete", unchecked: [] });
      await send("closed but complete");
      expect(sentPrompts()).toEqual(["closed but complete"]);
      expect(shown()).toEqual([]);
    });
  });
});

describe("pure rules", () => {
  const v = (over: Partial<Verdict>): Verdict => ({
    action: "allowed",
    text: "t",
    original_text: "t",
    rails_triggered: [],
    latency_ms: 0,
    failed: false,
    ...over,
  });

  it("a failed check is never partial: it keeps the 'could not check' banner, not P1", () => {
    const failed = v({ failed: true, checked: "partial" });
    expect(isPartial(failed)).toBe(false);
    const d = decideInput("t", failed, "open");
    expect(sendBanner(d, failed)).toEqual({ kind: "warn", text: uncheckedBannerText(failed) });
    expect(auditAction(failed)).toBe("error");
  });

  it("decideInput blocks a partial pass under closed by itself (not only via the worker)", () => {
    const pa = v({ checked: "partial", unchecked: ["check_failed"] });
    expect(decideInput("t", pa, "closed")).toEqual({ kind: "block", message: P2, rails: [], bare: true });
    expect(decideInput("t", pa, "open")).toEqual({ kind: "allow", text: "t" });
  });

  it("blocks for an incomplete check are shown bare; a policy block keeps its prefix", () => {
    // P2 with rails the server named: no "Message blocked by policy (…):" and no rails.
    const pa = v({ checked: "partial", unchecked: ["check_failed"], rails_triggered: ["Input PII Check (EMAIL)"] });
    expect(sendBanner(decideInput("t", pa, "closed"), applyPartialPolicy(pa, "closed"))?.text).toBe(P2);
    // A fail-safe block (check failed, closed): bare.
    const fs = v({ action: "blocked", text: FAIL_MESSAGES.unavailable, failed: true });
    expect(sendBanner(decideInput("t", fs, "closed"), fs)?.text).toBe(FAIL_MESSAGES.unavailable);
    // No verdict at all under closed: bare.
    const nv = decideInput("t", null, "closed");
    expect(nv.kind === "block" && nv.bare).toBe(true);
    expect(sendBanner(nv, null)?.text?.startsWith("Message blocked by policy")).toBe(false);
    // A real policy block keeps the prefix and rails.
    const pb = v({ action: "blocked", text: "Nope.", rails_triggered: ["Prompt Injection Detection"] });
    expect(sendBanner(decideInput("t", pb, "closed"), pb)?.text).toBe(
      "Message blocked by policy (Prompt Injection Detection): Nope.",
    );
  });

  it("a partial block stays the server's block under either policy", () => {
    const pb = v({ action: "blocked", text: "Nope.", checked: "partial" });
    expect(applyPartialPolicy(pb, "closed")).toBe(pb);
    expect(sendBanner(decideInput("t", pb, "open"), pb)).toEqual({
      kind: "block",
      text: "Message blocked by policy: Nope.",
    });
  });

  it("the strings are verbatim", () => {
    expect(PARTIAL_SENT_MESSAGE).toBe(P1);
    expect(PARTIAL_BLOCK_MESSAGE).toBe(P2);
    expect(PARTIAL_ROW_LABEL).toBe("Partly checked");
    expect(KEY_REJECTED_MESSAGE).toBe(P4);
    expect(PARTIAL_MODIFY_SUFFIX).toBe("Some of your protections couldn't run, so it was sent WITHOUT being fully checked.");
  });
});

describe("P4: HTTP 401 from /api/v1/check", () => {
  const res401 = vi.fn(
    async () => ({ ok: false, status: 401, json: async () => ({}), headers: { get: () => null } }) as unknown as Response,
  );
  const keyInstall = (fail_policy: "open" | "closed"): Config => ({ ...DEFAULT_CONFIG, api_key: "dk_x", fail_policy });

  it("API-key install, closed -> blocked with P4", async () => {
    const out = await check({ config: keyInstall("closed"), direction: "input", text: "hi", fetchImpl: res401 });
    expect(out).toMatchObject({ action: "blocked", failed: true, cause: "signed_out", text: P4 });
  });

  it("student mode, closed -> the student string, unchanged", async () => {
    const student: Config = { ...keyInstall("closed"), api_key: "", enrolment_token: "class-token" };
    const out = await guardedCheck(
      student,
      { direction: "input", text: "hi" },
      {
        credential: async () => ({ ok: true, credential: "stu_cred" }),
        check: (o) => check({ ...o, fetchImpl: res401 }),
      },
    );
    expect(out.text).toBe(FAIL_MESSAGES.signed_out);
    expect(out.action).toBe("blocked");
  });

  it("API-key install, open -> the existing 'could not check' behaviour (sent, warned)", async () => {
    const out = await check({ config: keyInstall("open"), direction: "input", text: "hi", fetchImpl: res401 });
    expect(out).toMatchObject({ action: "allowed", failed: true, text: "hi" });
    const d = decideInput("hi", out, "open");
    expect(d.kind).toBe("allow");
    expect(sendBanner(d, out)).toEqual({ kind: "warn", text: uncheckedBannerText(out) });
  });
});

describe("popup activity row", () => {
  it("action 'partial' is labelled 'Partly checked'", async () => {
    const root = document.createElement("div");
    const events: AuditEvent[] = [
      { ts: 1, direction: "input", action: "partial", rails: [], latency_ms: 12 },
      { ts: 2, direction: "input", action: "allowed", rails: [], latency_ms: 5 },
    ];
    renderStatus(root, { config: DEFAULT_CONFIG, managed: false, managedReadFailed: false } as any, {
      loadState: async () => ({}) as any,
      send: async (m: any) => (m.type === "dney-audit-recent" ? events : null),
      removeLocal: async () => undefined,
      openOptions: () => undefined,
      download: () => undefined,
    });
    await settle();
    const cells = [...root.querySelectorAll("#events tr td:nth-child(2)")];
    expect(cells.map((c) => c.textContent)).toEqual(["Partly checked", "allowed"]);
    expect(cells[0].className).toBe("a-partial");
  });
});
