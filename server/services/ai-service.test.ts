import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ status: vi.fn(), invoke: vi.fn(), text: vi.fn() }));
vi.mock("../_core/llm", () => ({ getLLMModelStatus: mocks.status, invokeLLM: mocks.invoke, getLLMText: mocks.text }));
import { generateAIResponse, getAIConfig, getAvailableModels, setAIConfig, setAIModel, setAIProvider, testAIConnection } from "./ai-service";
const status = { provider: "codex-subscription", configured: true, available: true, model: "gpt-5.6-luna", managedBy: "local-bridge" };
beforeEach(() => { vi.clearAllMocks(); mocks.status.mockResolvedValue(status); mocks.invoke.mockResolvedValue({ model: status.model }); mocks.text.mockReturnValue("Connection successful"); });
afterEach(() => vi.restoreAllMocks());

describe("canonical subscription AI compatibility", () => {
  it("reports canonical configuration without performing inference or requiring an API key", async () => {
    expect(await getAIConfig()).toEqual(status);
    expect(await getAvailableModels()).toEqual([{ id: status.model, name: status.model }]);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("preserves configured versus unavailable status without claiming connected inference", async () => {
    mocks.status.mockResolvedValue({ ...status, configured: true, available: false });
    expect(await getAIConfig()).toMatchObject({ configured: true, available: false });
    expect(await testAIConnection()).toMatchObject({ success: false, provider: "codex-subscription", message: expect.stringContaining("No inference was requested") });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("fails a missing queue without any provider call", async () => {
    mocks.status.mockResolvedValue({ ...status, configured: false, available: false });
    expect(await testAIConnection()).toMatchObject({ success: false, provider: "codex-subscription", model: status.model,
      message: expect.stringContaining("No API key is required") });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("permits an explicit connection check using only mocked subscription inference", async () => {
    expect(await testAIConnection()).toEqual({ success: true, provider: "codex-subscription", model: status.model, message: "Connection successful" });
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith({ messages: [{ role: "user", content: "Reply with exactly: Connection successful" }], maxTokens: 256 });
  });
  it("does not mistake omitted availability for confirmed live acceptance", async () => {
    const { available: _available, ...configurationOnly } = status;
    mocks.status.mockResolvedValue(configurationOnly);
    expect(await getAIConfig()).not.toHaveProperty("available");
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("keeps provider/model/credential mutations disabled", () => {
    expect(setAIConfig).toThrow(/fixed Codex subscription policy/);
    expect(setAIProvider).toThrow(/Codex subscription/);
    expect(setAIModel).toThrow(/fixed/);
    expect(mocks.invoke).not.toHaveBeenCalled();
  });
  it("routes existing coaching through canonical inference and rejects empty output", async () => {
    await generateAIResponse("What should I do?", "Synthetic task context");
    expect(mocks.invoke).toHaveBeenCalledExactlyOnceWith({ messages: [expect.objectContaining({ role: "system" }),
      { role: "system", content: "CURRENT TASK CONTEXT:\nSynthetic task context" }, { role: "user", content: "What should I do?" }], maxTokens: 800 });
    mocks.text.mockReturnValue("");
    await expect(generateAIResponse("Question", "Context")).rejects.toThrow("The Codex subscription returned an empty response");
    await expect(testAIConnection()).rejects.toThrow("The Codex subscription returned an empty response");
  });
});
