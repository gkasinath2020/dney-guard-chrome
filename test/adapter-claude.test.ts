import { describe, it, expect } from "vitest";
import { claudeAdapter } from "../src/content/adapter-claude";

describe("claude adapter — endpoint matching (probed live 2026-07-31)", () => {
  const real =
    "https://claude.ai/api/organizations/97e01e43-8a69-416d-af6d-c827a3e5ffa8/chat_conversations/b15126c5-6d3b-4df6-b316-d893d62ea42b/completion";

  it("matches the real completion URL", () => {
    expect(claudeAdapter.isCompletionUrl(real)).toBe(true);
    expect(claudeAdapter.isCompletionUrl(real + "?stream=true")).toBe(true);
  });

  it("does NOT match telemetry or other API calls (avoids §8 over-matching)", () => {
    expect(claudeAdapter.isCompletionUrl("https://claude.ai/api/event_logging/v2/batch")).toBe(false);
    expect(
      claudeAdapter.isCompletionUrl(
        "https://claude.ai/api/organizations/97e01e43-8a69-416d-af6d-c827a3e5ffa8/chat_conversations/b15126c5-6d3b-4df6-b316-d893d62ea42b/title",
      ),
    ).toBe(false);
    expect(claudeAdapter.isCompletionUrl("https://browser-intake-us5-datadoghq.com/api/v2/rum")).toBe(false);
  });
});

describe("claude adapter — prompt field", () => {
  it("extracts and rewrites body.prompt round-trip", () => {
    const body = { prompt: "hello", model: "opus", attachments: [] };
    expect(claudeAdapter.getPrompt(body)).toBe("hello");
    const rewritten = claudeAdapter.setPrompt(body, "[REDACTED]") as { prompt: string; model: string };
    expect(rewritten.prompt).toBe("[REDACTED]");
    expect(rewritten.model).toBe("opus"); // other fields preserved
  });

  it("returns null when there is no prompt string", () => {
    expect(claudeAdapter.getPrompt({ model: "x" })).toBeNull();
    expect(claudeAdapter.getPrompt(null)).toBeNull();
  });
});

describe("claude adapter — SSE grammar", () => {
  it("knows the delta + stop events", () => {
    expect(claudeAdapter.sse.deltaEvent).toBe("content_block_delta");
    expect(claudeAdapter.sse.stopEvent).toBe("message_stop");
    expect(claudeAdapter.sse.eventNames).toContain("message_start");
  });

  it("extracts text from a content_block_delta payload", () => {
    const data = { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "PONG" } };
    expect(claudeAdapter.sse.extractDelta(data)).toBe("PONG");
    expect(claudeAdapter.sse.extractDelta({ type: "message_stop" })).toBe("");
  });
});

describe("claude adapter — self-test", () => {
  it("reports composerFound based on the document", () => {
    const withComposer = {
      querySelector: (sel: string) =>
        sel.includes("ProseMirror") ? ({} as Element) : null,
    } as unknown as Document;
    const without = { querySelector: () => null } as unknown as Document;
    expect(claudeAdapter.selfTest(withComposer).composerFound).toBe(true);
    expect(claudeAdapter.selfTest(without).composerFound).toBe(false);
  });
});
