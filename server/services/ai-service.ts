/**
 * Compatibility adapter for the Trello chatbot.
 *
 * All model work uses the application's fixed Codex subscription policy.
 * Authentication remains in the private host runner, never the dashboard database.
 */

import { getLLMText, getLLMModelStatus, invokeLLM } from "../_core/llm";

export type AIProvider = "codex-subscription";

const PM_SYSTEM_PROMPT = `You are a project-management coach embedded in a worker task system.

Help the worker complete the current task efficiently and professionally. Be direct, supportive, concise, and evidence-bound. Use only the supplied context. If the evidence is insufficient, say what is missing and ask one focused question. Never claim that an external action was completed unless the supplied context proves it.`;

export async function getAIConfig() {
  return getLLMModelStatus();
}

export async function getAvailableModels() {
  const status = await getLLMModelStatus();
  return status.model ? [{ id: status.model, name: status.model }] : [];
}

/** Runtime mutation is disabled: the subscription provider/model policy is fixed. */
export function setAIConfig(): never {
  throw new Error("AI uses the fixed Codex subscription policy. Authentication is managed by the private host runner, not the dashboard database.");
}

export function setAIProvider(): never {
  throw new Error("Codex subscription is the fixed model provider");
}

export function setAIModel(): never {
  throw new Error("Model selection is fixed by the Codex subscription policy");
}

export async function generateAIResponse(
  userMessage: string,
  context: string,
): Promise<string> {
  const result = await invokeLLM({
    messages: [
      { role: "system", content: PM_SYSTEM_PROMPT },
      { role: "system", content: `CURRENT TASK CONTEXT:\n${context}` },
      { role: "user", content: userMessage },
    ],
    maxTokens: 800,
  });
  const text = getLLMText(result);
  if (!text) throw new Error("The Codex subscription returned an empty response");
  return text;
}

export async function generateCheckInMessage(
  workerName: string,
  cardTitle: string,
  context: string,
  isOverdue: boolean,
): Promise<string> {
  const prompt = isOverdue
    ? `Draft a polite, direct check-in for ${workerName} about \"${cardTitle}\". Ask for concrete progress, the current blocker, and the next update time.`
    : `Draft a brief, supportive progress check-in for ${workerName} about \"${cardTitle}\".`;
  return generateAIResponse(prompt, context);
}

export async function generateQuestionResponse(question: string, context: string) {
  return generateAIResponse(question, context);
}

export async function generateStuckGuidance(stepDescription: string, context: string) {
  return generateAIResponse(
    `The worker is blocked on \"${stepDescription}\". Give the smallest executable next step, identify required evidence, and state when an owner decision is needed.`,
    context,
  );
}

export async function testAIConnection() {
  const status = await getLLMModelStatus();
  if (!status.configured || !status.model) {
    return { success: false, provider: status.provider, model: status.model,
      message: "The local Codex subscription queue is not configured. No API key is required; no inference was requested." };
  }
  if (status.available === false) return { success: false, provider: status.provider, model: status.model,
    message: "The local Codex subscription bridge is unavailable. No inference was requested." };

  const result = await invokeLLM({
    messages: [{ role: "user", content: "Reply with exactly: Connection successful" }],
    // The subscription turn budget includes its required answer/review envelope.
    maxTokens: 256,
  });
  const response = getLLMText(result);
  if (!response) throw new Error("The Codex subscription returned an empty response");
  return {
    success: true,
    provider: status.provider,
    model: result.model || status.model,
    message: response,
  };
}

export const AVAILABLE_MODELS = {} as const;

export default {
  getAIConfig,
  setAIConfig,
  setAIProvider,
  setAIModel,
  getAvailableModels,
  generateAIResponse,
  generateCheckInMessage,
  generateQuestionResponse,
  generateStuckGuidance,
  testAIConnection,
  AVAILABLE_MODELS,
};
