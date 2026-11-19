// The manifest and the adapter registry must name the same sites. The ChatGPT
// adapter shipped registered but never injected (manifest matched claude.ai only),
// so ChatGPT prompts went out unguarded while the code said otherwise (Assay).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAPTERS, getAdapter } from "../src/content/adapters";

const manifest = JSON.parse(readFileSync(new URL("../manifest.json", import.meta.url), "utf8"));
const hostOf = (m: string) => new URL(m.replace("*://", "https://").replace("/*", "/")).hostname;

describe("manifest <-> adapter registry", () => {
  const scripts: { matches: string[]; js: string[]; world?: string }[] = manifest.content_scripts;

  it("every adapter's site is injected by BOTH content scripts (relay and page hook)", () => {
    for (const [i, adapter] of ADAPTERS.entries()) {
      for (const js of ["content/main.js", "content/page-hook.js"]) {
        const cs = scripts.find((s) => s.js.includes(js))!;
        const covered = cs.matches.map(hostOf).some((h) => getAdapter(h) === adapter);
        expect(covered, `${js} is not injected on the site of adapter #${i}`).toBe(true);
      }
    }
  });

  it("every injected site has an adapter and a host permission", () => {
    const perms = new Set(manifest.host_permissions.map(hostOf));
    for (const cs of scripts) {
      for (const m of cs.matches) {
        expect(getAdapter(hostOf(m)), `${m} has no adapter`).not.toBeNull();
        expect(perms.has(hostOf(m)), `${m} has no host permission`).toBe(true);
      }
    }
  });

  it("the page hook runs in the MAIN world on the same sites as the relay", () => {
    const relay = scripts.find((s) => s.js.includes("content/main.js"))!;
    const hook = scripts.find((s) => s.js.includes("content/page-hook.js"))!;
    expect(hook.world).toBe("MAIN");
    expect([...hook.matches].sort()).toEqual([...relay.matches].sort());
  });
});
