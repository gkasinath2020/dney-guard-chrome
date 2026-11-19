import { describe, it, expect } from "vitest";
import { chatgptAdapter } from "../src/content/adapter-chatgpt";
import { getAdapter } from "../src/content/adapters";
import { claudeAdapter } from "../src/content/adapter-claude";

describe("chatgpt adapter — endpoint matching (probed live 2026-08-01)", () => {
  it("matches the conversation endpoints", () => {
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/backend-api/f/conversation")).toBe(true);
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/backend-api/conversation")).toBe(true);
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/backend-api/f/conversation?x=1")).toBe(true);
  });
  it("does not match other backend-api calls", () => {
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/backend-api/conversations")).toBe(false);
    expect(chatgptAdapter.isCompletionUrl("https://chatgpt.com/backend-api/models")).toBe(false);
  });
});

describe("chatgpt adapter — prompt at messages[last].content.parts[0]", () => {
  const body = () => ({
    action: "next",
    model: "gpt-5",
    messages: [
      { id: "1", author: { role: "user" }, content: { content_type: "text", parts: ["earlier"] } },
      { id: "2", author: { role: "user" }, content: { content_type: "text", parts: ["hello world"] } },
    ],
  });

  it("extracts the last message's text", () => {
    expect(chatgptAdapter.getPrompt(body())).toBe("hello world");
  });

  it("rewrites only the last message's parts[0], preserving the rest", () => {
    const out = chatgptAdapter.setPrompt(body(), "[REDACTED]") as any;
    expect(out.messages[1].content.parts[0]).toBe("[REDACTED]");
    expect(out.messages[0].content.parts[0]).toBe("earlier"); // earlier turn untouched
    expect(out.model).toBe("gpt-5"); // other fields preserved
    // original not mutated
    const original = body();
    chatgptAdapter.setPrompt(original, "x");
    expect(original.messages[1].content.parts[0]).toBe("hello world");
  });

  it("returns null for non-text content (voice/image/tool) -> passes through unchecked", () => {
    const b = { messages: [{ content: { content_type: "multimodal_text", parts: [{ image: "…" }] } }] };
    expect(chatgptAdapter.getPrompt(b)).toBeNull();
    expect(chatgptAdapter.getPrompt({ messages: [] })).toBeNull();
    expect(chatgptAdapter.getPrompt(null)).toBeNull();
  });
});

describe("chatgpt adapter — SSE (output rail deferred)", () => {
  it("is flagged unsupported for output", () => {
    expect(chatgptAdapter.sse.outputSupported).toBe(false);
    expect(claudeAdapter.sse.outputSupported).toBe(false);
  });
  it("extractDelta pulls text from an append op", () => {
    expect(
      chatgptAdapter.sse.extractDelta({ o: "append", p: "/message/content/parts/0", v: "tok" }),
    ).toBe("tok");
    expect(chatgptAdapter.sse.extractDelta({ o: "patch", p: "/message/status", v: "x" })).toBe("");
  });
});

describe("getAdapter — hostname routing", () => {
  it("selects by host", () => {
    expect(getAdapter("claude.ai")).toBe(claudeAdapter);
    expect(getAdapter("www.claude.ai")).toBe(claudeAdapter);
    expect(getAdapter("chatgpt.com")).toBe(chatgptAdapter);
    expect(getAdapter("example.com")).toBeNull();
  });
});
