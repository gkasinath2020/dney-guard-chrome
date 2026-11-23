// SCRUM-398 (0.3.0): the store name changes, the permissions do NOT (no new
// permission warning on update, so no re-consent and a faster review).
// 0.3.1 and 0.3.2 (one store release, GK 15 Oct): version bump only; permissions still exactly 0.2.0/0.3.0's (the "scripting"
// re-inject in !34 is deliberately not in this release).
// 0.3.3 (SCRUM-441/442/443): version bump, permissions unchanged; the summary drops
// "before they're sent" (Assay/Hallmark 19 Oct: a signed-in paste can be prefetched).
// 0.3.4 = 0.3.3 (never submitted) + SCRUM-452 (on claude.ai a mask blocks instead);
// permissions unchanged.
// 0.3.5 (SCRUM-480): Sign out in the popup; summary from STORE_SEARCH_TUNE_1 change 1
// (Hallmark, cleared by Assay 26 Oct, Baton #194); permissions unchanged.
// 0.3.6 (SCRUM-565): a block because the safety checker was unavailable shows the
// server's text bare (no "blocked by policy"), popup row "Checker unavailable",
// badge tooltip; summary and permissions unchanged.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(join(__dirname, "..", "manifest.json"), "utf8"));

describe("manifest 0.3.6", () => {
  it("version and store display name (GK, 12 Oct), within Chrome's 75-character limit", () => {
    expect(manifest.version).toBe("0.3.6");
    expect(manifest.name).toBe("DNey Guard: AI guardrails for ChatGPT and Claude");
    expect(manifest.name.length).toBeLessThanOrEqual(75);
    expect(existsSync(join(__dirname, "..", "_locales"))).toBe(false); // no localized name to keep in step
  });

  it("permissions and host permissions are exactly 0.2.0's and 0.3.0's", () => {
    expect(manifest.permissions).toEqual(["storage"]);
    expect(manifest.host_permissions).toEqual(["https://claude.ai/*", "https://chatgpt.com/*", "https://api.dney.dev/*"]);
    expect(manifest.optional_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toBeUndefined();
    expect(manifest.externally_connectable).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
  });
});
