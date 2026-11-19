// SCRUM-395 (Assay, publish-blocking): the API key lives in chrome.storage.LOCAL
// only. Sync is copied to the user's Google account, so no path writes api_key
// there, and a 0.2.0 key left in sync is moved to local and deleted from sync.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigState, migrateSyncKey } from "../src/lib/config";
import { saveSettings } from "../src/lib/settings-store";
import { installFakeChrome, removeFakeChrome } from "./helpers/onboarding-env";

afterEach(() => {
  removeFakeChrome();
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("Settings save: key -> local only; other settings -> sync", () => {
  it("a pasted key goes to local, never sync; the other settings go to sync", async () => {
    const fake = installFakeChrome();
    await saveSettings({ api_key: " asg_pasted ", fail_policy: "closed", input_mode: "monitor" });
    expect(fake.areas.local).toEqual({ api_key: "asg_pasted" });
    expect(fake.areas.sync).toEqual({ fail_policy: "closed", input_mode: "monitor" });
    expect((await loadConfigState()).config.api_key).toBe("asg_pasted");
  });

  it("clearing the key removes it from local AND sync", async () => {
    const fake = installFakeChrome({ local: { api_key: "asg_old", welcome_opened: true }, sync: { api_key: "asg_older", fail_policy: "open" } });
    await saveSettings({ api_key: "", fail_policy: "open" });
    expect(fake.areas.local).toEqual({ welcome_opened: true });
    expect(fake.areas.sync).toEqual({ fail_policy: "open" });
    expect((await loadConfigState()).config.api_key).toBe("");
  });
});

describe("migration of a 0.2.0 key out of sync", () => {
  it("moves the key to local, deletes it from sync, keeps the other settings; idempotent", async () => {
    const fake = installFakeChrome({ sync: { api_key: "asg_020", fail_policy: "closed" } });
    expect(await migrateSyncKey()).toBe("moved");
    expect(fake.areas.local).toEqual({ api_key: "asg_020" });
    expect(fake.areas.sync).toEqual({ fail_policy: "closed" });
    expect(await migrateSyncKey()).toBe("none");
    expect(fake.areas.local).toEqual({ api_key: "asg_020" });
  });

  it("an empty sync key is just removed", async () => {
    const fake = installFakeChrome({ sync: { api_key: "" } });
    expect(await migrateSyncKey()).toBe("cleared");
    expect(fake.areas).toMatchObject({ local: {}, sync: {} });
  });

  it("never loses the key: if writing local fails, the key stays in sync for the next run", async () => {
    const fake = installFakeChrome({ sync: { api_key: "asg_020" } });
    (fake.chrome as any).storage.local.set.mockRejectedValueOnce(new Error("quota"));
    expect(await migrateSyncKey()).toBe("failed");
    expect(fake.areas.sync).toEqual({ api_key: "asg_020" });
    expect(await migrateSyncKey()).toBe("moved");
    expect(fake.areas.local).toEqual({ api_key: "asg_020" });
    expect(fake.areas.sync).toEqual({});
  });

  it("a managed-policy key is untouched", async () => {
    const fake = installFakeChrome({ managed: { api_key: "school" }, sync: { api_key: "student-set" } });
    await migrateSyncKey();
    expect(fake.areas.managed).toEqual({ api_key: "school" });
    expect((await loadConfigState()).config.api_key).toBe("school");
    expect(fake.areas.sync).toEqual({});
  });

  it("every config read migrates first: an upgraded user's key is read, never 'missing'", async () => {
    const fake = installFakeChrome({ sync: { api_key: "asg_020" } });
    expect((await loadConfigState()).config.api_key).toBe("asg_020");
    expect(fake.areas.sync).toEqual({});
  });

  it.each([
    ["onInstalled (update)", "onInstalled", { reason: "update", previousVersion: "0.2.0" }],
    ["onStartup", "onStartup", undefined],
  ])("the service worker migrates on %s", async (_n, event, arg) => {
    const fake = installFakeChrome({ sync: { api_key: "asg_020", input_mode: "enforce" } });
    await import("../src/background");
    // module load is not the trigger under test: put the key back if anything moved it
    fake.areas.sync.api_key = "asg_020";
    delete fake.areas.local.api_key;
    const listeners = (fake.chrome as { _listeners: Record<string, ((a?: unknown) => unknown)[]> })._listeners;
    for (const l of listeners[event]) await l(arg);
    await new Promise((r) => setTimeout(r, 0));
    expect(fake.areas.local).toEqual({ api_key: "asg_020" });
    expect(fake.areas.sync).toEqual({ input_mode: "enforce" });
  });
});

describe("no source path writes api_key to sync", () => {
  const srcFiles = (dir: string): string[] =>
    readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? srcFiles(p) : p.endsWith(".ts") ? [p] : [];
    });
  const root = join(__dirname, "..");
  const files = srcFiles(join(root, "src"));

  it("the only sync write in the extension is settings-store's, and it strips the key", () => {
    const writers = files.filter((f) => /storage\.sync\.set\s*\(/.test(readFileSync(f, "utf8")));
    expect(writers.map((f) => f.slice(root.length + 1))).toEqual(["src/lib/settings-store.ts"]);
    const store = readFileSync(join(root, "src/lib/settings-store.ts"), "utf8");
    const calls = [...store.matchAll(/storage\.sync\.set\s*\(([^;]*)\);/g)].map((m) => m[1].trim());
    expect(calls).toEqual(["withoutKey(values)"]);
  });

  it("no file names api_key next to a sync write, and no sync area is aliased for writing", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/sync\.set\([^)]*api_key/);
      expect(src, f).not.toMatch(/=\s*chrome\.storage\.sync\s*;/);
    }
  });
});
