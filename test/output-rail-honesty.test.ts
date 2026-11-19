// SCRUM-303: the extension does not check AI replies yet (Phase D). The UI must say
// so on every install, and this pins the claim to the code that decides it: if an
// adapter starts checking replies, OUTPUT_RAIL_AVAILABLE (and the UI) must change
// with it, and if the flag flips without an adapter doing the work, this fails.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OUTPUT_NOT_CHECKED, OUTPUT_RAIL_AVAILABLE } from "../src/lib/config";
import { ADAPTERS } from "../src/content/adapters";

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

describe("output rail honesty", () => {
  it("OUTPUT_RAIL_AVAILABLE matches the adapters exactly", () => {
    expect(ADAPTERS.length).toBeGreaterThan(0);
    expect(ADAPTERS.some((a) => a.sse.outputSupported)).toBe(OUTPUT_RAIL_AVAILABLE);
  });

  it("today no adapter checks replies, so nothing sends an output-direction check", () => {
    expect(OUTPUT_RAIL_AVAILABLE).toBe(false);
    for (const f of ["src/content/main.ts", "src/content/page-hook.ts"]) {
      expect(read(f)).not.toMatch(/requestCheck\(\s*["']output["']/);
    }
  });

  it("the popup and options page say replies are not checked, and show no output control", () => {
    expect(OUTPUT_NOT_CHECKED).toBe("AI replies: not checked yet");
    // The popup's views moved to popup-view.ts in 0.3.0 (SCRUM-395).
    const popup = read("src/ui/popup-view.ts");
    const options = read("src/ui/options.ts");
    expect(popup).toContain("OUTPUT_NOT_CHECKED");
    expect(options).toContain("OUTPUT_NOT_CHECKED");
    // the output select is skipped while the rail is unavailable, in render AND save
    expect(options.match(/f\.key === "output_mode" && !OUTPUT_RAIL_AVAILABLE/g)?.length).toBe(2);
  });
});
