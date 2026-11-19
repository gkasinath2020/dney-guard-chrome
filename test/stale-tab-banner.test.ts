// A tab open across an extension update keeps running the OLD content script,
// whose extension context is dead. Its sends cannot be checked until the tab
// reloads, and the banner says exactly that (R1 sent / R2 blocked) INSTEAD of the
// generic "could not check": one banner per send. Runs the real content scripts
// in a jsdom page, then kills their context both ways Chrome does.
import { beforeAll, describe, expect, it } from "vitest";
import { buildContentScripts, COMPLETION_URL, fakeRuntime, makePage, settle, until } from "./helpers/page-env";
import { STALE_TAB_BLOCKED_TEXT, STALE_TAB_SENT_TEXT, uncheckedBannerText } from "../src/lib/status";
import { bannerText, decideStaleTab, staleTabBanner } from "../src/lib/enforce";

let scripts: { main: string; hook: string };
beforeAll(async () => {
  scripts = await buildContentScripts();
});

async function staleTab(prompt: string, how: "no-id" | "throws", opts: { failPolicy?: "open" | "closed"; noConfig?: boolean } = {}) {
  const page = makePage(prompt);
  const rt = fakeRuntime(opts);
  page.run(scripts.main, rt.chrome);
  page.run(scripts.hook);
  await settle(30); // the policy was heard while the context was alive
  rt.kill(how);
  return { page, rt };
}

describe("the copy", () => {
  it("R1 and R2 exactly", () => {
    expect(STALE_TAB_SENT_TEXT).toBe(
      "DNey Guard was just updated, so this tab can't reach it. Your message was sent WITHOUT being checked. Reload this tab to turn checking back on.",
    );
    expect(STALE_TAB_BLOCKED_TEXT).toBe(
      "Blocked: DNey Guard was just updated, so this tab can't reach it. Reload this tab, then send again.",
    );
  });

  it("R2 renders bare (no policy prefix); R1 is a warn banner", () => {
    const blocked = decideStaleTab("x", "closed");
    expect(blocked).toMatchObject({ kind: "block", bare: true, rails: [] });
    expect(bannerText(blocked)).toBe(STALE_TAB_BLOCKED_TEXT);
    expect(staleTabBanner(blocked)).toEqual({ kind: "block", text: STALE_TAB_BLOCKED_TEXT });
    for (const policy of ["open", undefined] as const) {
      const sent = decideStaleTab("x", policy);
      expect(sent).toEqual({ kind: "allow", text: "x" });
      expect(staleTabBanner(sent)).toEqual({ kind: "warn", text: STALE_TAB_SENT_TEXT });
    }
  });
});

for (const how of ["no-id", "throws"] as const) {
  describe(`stale tab, context invalidated (${how === "no-id" ? "chrome.runtime.id gone" : "sendMessage throws"})`, () => {
    it("fail-open: the message is sent, with R1 and only R1", async () => {
      const { page, rt } = await staleTab("hello", how, { failPolicy: "open" });
      page.button.click();
      expect(await until(() => page.network.length > 0)).toBe(true);
      await settle(100);
      expect(page.network).toEqual([{ prompt: "hello" }]);
      expect(page.banners()).toEqual([{ kind: "warn", text: STALE_TAB_SENT_TEXT }]);
      expect(rt.checks).toEqual([]);
    });

    it("fail-closed: the message is NOT sent, with R2 (bare) and only R2", async () => {
      const { page } = await staleTab("hello", how, { failPolicy: "closed" });
      page.button.click();
      expect(await until(() => page.banners().length > 0)).toBe(true);
      await settle(100);
      expect(page.banners()).toEqual([{ kind: "block", text: STALE_TAB_BLOCKED_TEXT }]);
      expect(page.banners()[0].text).not.toMatch(/blocked by policy/i);
      expect(page.pageSends).toBe(0);
      expect(page.network).toEqual([]);
    });

    it("policy never heard: behaves as fail-open (sent, R1)", async () => {
      const { page } = await staleTab("hello", how, { noConfig: true });
      page.button.click();
      expect(await until(() => page.network.length > 0)).toBe(true);
      await settle(100);
      expect(page.banners()).toEqual([{ kind: "warn", text: STALE_TAB_SENT_TEXT }]);
    });

    it("fetch-layer send (fail-open): answered at once with R1, not the generic banner", async () => {
      const { page } = await staleTab("", how, { failPolicy: "open" });
      const t0 = Date.now();
      await page.win.fetch(COMPLETION_URL, { method: "POST", body: JSON.stringify({ prompt: "direct" }) });
      expect(Date.now() - t0).toBeLessThan(1000); // not the bridge deadline
      await settle(100);
      expect(page.network).toEqual([{ prompt: "direct" }]);
      expect(page.banners()).toEqual([{ kind: "warn", text: STALE_TAB_SENT_TEXT }]);
    });

    it("fetch-layer send (fail-closed): rejected at once, with R2 bare and only R2", async () => {
      const { page } = await staleTab("", how, { failPolicy: "closed" });
      const t0 = Date.now();
      const err = await page.win
        .fetch(COMPLETION_URL, { method: "POST", body: JSON.stringify({ prompt: "direct" }) })
        .then(() => null, (e: Error) => e);
      expect(err?.name).toBe("AbortError");
      expect(Date.now() - t0).toBeLessThan(1000);
      await settle(100);
      expect(page.network).toEqual([]);
      expect(page.banners()).toEqual([{ kind: "block", text: STALE_TAB_BLOCKED_TEXT }]);
    });
  });
}

describe("a live tab is unchanged", () => {
  it("a worker that does not answer still gives the generic banner, not R1", async () => {
    const page = makePage("hello");
    const rt = fakeRuntime();
    const runtime = (rt.chrome as { runtime: { sendMessage: (m: { type: string }, cb?: (r: unknown) => void) => void } }).runtime;
    const real = runtime.sendMessage;
    runtime.sendMessage = (msg, cb) => {
      if (msg.type === "dney-check") setTimeout(() => cb?.(undefined), 1); // worker gave no verdict
      else real(msg, cb);
    };
    page.run(scripts.main, rt.chrome);
    page.run(scripts.hook);
    await settle(30);
    page.button.click();
    expect(await until(() => page.network.length > 0)).toBe(true);
    await settle(100);
    expect(page.banners()).toEqual([{ kind: "warn", text: uncheckedBannerText(null) }]);
  });
});
