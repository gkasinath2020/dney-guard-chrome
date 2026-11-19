// SCRUM-303 (Assay, real-browser e2e): a managed student install failed OPEN when
// the worker did not answer (sign-in pending): the relay answered null and the
// hook's decideInput(null) allowed. These pin the pure decisions AND that the
// content scripts actually use them.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bridgeFallback, nextHookFailPolicy } from "../src/lib/bridge-policy";
import { mergeConfig, DEFAULT_CONFIG } from "../src/lib/config";
import { decideInput } from "../src/lib/enforce";

const src = (p: string) => readFileSync(new URL(`../src/${p}`, import.meta.url), "utf8");

describe("bridgeFallback: the relay's answer when the worker did not answer", () => {
  it("a managed (closed) install gets a BLOCKED verdict, never null", () => {
    const v = bridgeFallback(mergeConfig({ enrolment_token: "dne_x" }, null), "42 Wallaby Street");
    expect(v).toMatchObject({ action: "blocked", failed: true });
    expect(v!.text).not.toContain("Wallaby");
    expect(decideInput("42 Wallaby Street", v, "open").kind).toBe("block"); // even a hook that thinks "open"
  });
  it("an open install keeps null: the text goes out and is badged unchecked", () => {
    expect(bridgeFallback(DEFAULT_CONFIG, "hi")).toBeNull();
  });
  it("config not loaded yet -> null (documented: every no-verdict path fires after a multi-second deadline)", () => {
    expect(bridgeFallback(null, "hi")).toBeNull();
  });
});

describe("nextHookFailPolicy: the MAIN world only ever tightens", () => {
  it("'closed' latches and nothing re-opens it", () => {
    let p: "open" | "closed" = "open";
    p = nextHookFailPolicy(p, "closed");
    expect(p).toBe("closed");
    for (const hostile of ["open", undefined, null, "", 0, {}, "OPEN"]) {
      expect(nextHookFailPolicy(p, hostile)).toBe("closed");
    }
  });
  it("starts open and ignores anything but 'closed'", () => {
    for (const x of ["open", undefined, "Closed", 1]) expect(nextHookFailPolicy("open", x)).toBe("open");
  });
});

describe("the content scripts use them (wiring pins)", () => {
  const relay = src("content/main.ts");
  const hook = src("content/page-hook.ts");

  it("the relay answers bridgeFallback(...) instead of null", () => {
    expect(relay).toMatch(/const verdict = got \?\? bridgeFallback\(cachedConfig, data\.text\)/);
  });
  it("the DOM send path decides with the loaded config's fail policy", () => {
    expect(relay).toMatch(
      /await configReady;\s*\n\s*if \(!cachedConfig\) await refreshDeadline\(\);[^\n]*[\s\S]{0,200}?decideInput\(text, verdict, cachedConfig\?\.fail_policy \?\? "open"\)/,
    );
  });
  it("the relay publishes the fail policy to the hook with the deadline", () => {
    expect(relay).toMatch(/failPolicy: cachedConfig\?\.fail_policy/);
  });
  it("the hook latches via nextHookFailPolicy and decides with it", () => {
    expect(hook).toMatch(/failPolicy = nextHookFailPolicy\(failPolicy, d\.failPolicy\)/);
    expect(hook).toMatch(/decideInput\(prompt, verdict, failPolicy\)/);
    expect(hook).toMatch(/let failPolicy: "open" \| "closed" = "open"/);
  });
});

describe("an unreadable completion request (Assay): closed blocks, open passes", () => {
  it("the decision", async () => {
    const { onUnreadableCompletion } = await import("../src/lib/bridge-policy");
    expect(onUnreadableCompletion("closed")).toBe("block");
    expect(onUnreadableCompletion("open")).toBe("pass");
  });

  const hook = src("content/page-hook.ts");
  it("a non-string body and a missing prompt are unreadable, not skipped", () => {
    expect(hook).toMatch(/if \(typeof body !== "string"\) throw new UnreadableCompletion/);
    expect(hook).toMatch(/if \(prompt === null\) throw new UnreadableCompletion/);
    // the old guard that silently skipped non-string bodies is gone
    expect(hook).not.toMatch(/typeof body === "string" && adapter\?\.isCompletionUrl/);
  });
  it("the catch-all blocks a completion on a closed install, and badges it on open", () => {
    expect(hook).toMatch(
      /if \(completion\) \{[\s\S]*onUnreadableCompletion\(failPolicy\) === "block"[\s\S]*throw new DOMException\("Blocked by DNey Guard", "AbortError"\)[\s\S]*reportUnchecked\("input"\)/,
    );
  });
});

describe("the hook does not decide an unreadable request on a guess (startup window)", () => {
  const hook = src("content/page-hook.ts");
  it("waits (bounded) for the relay's policy before deciding", () => {
    expect(hook).toMatch(/await policySettled\(\);[^\n]*\n\s*if \(onUnreadableCompletion\(failPolicy\) === "block"\)/);
    expect(hook).toMatch(/setTimeout\(resolve, POLICY_WAIT_MS\)/);
  });
  it("the relay re-publishes when a late config lands", () => {
    expect(src("content/main.ts")).toMatch(/void configReady\.then\(publishDeadline\)/);
  });
  it("content scripts never read chrome.storage themselves", () => {
    for (const f of ["content/main.ts", "content/page-hook.ts"]) {
      expect(src(f)).not.toMatch(/chrome\.storage\.(managed|sync|local)\.get|loadConfig\(/);
    }
  });
});

describe("requestConfigFromWorker always settles", () => {
  it("returns the config, or null on timeout / error / no answer", async () => {
    const { requestConfigFromWorker } = await import("../src/lib/bridge-policy");
    const cfg = mergeConfig({ enrolment_token: "dne_x" }, null);
    expect(await requestConfigFromWorker((_m, cb) => cb({ config: cfg }))).toEqual(cfg);
    expect(await requestConfigFromWorker(() => {}, 10)).toBeNull(); // never answers
    expect(await requestConfigFromWorker((_m, cb) => cb(null))).toBeNull();
    expect(await requestConfigFromWorker((_m, cb) => cb({ config: cfg }), 10, () => new Error("x"))).toBeNull();
    expect(
      await requestConfigFromWorker(() => {
        throw new Error("gone");
      }),
    ).toBeNull();
  });
});
