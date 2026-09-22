/**
 * Compatibility adapter for the Trello chatbot.
 *
 * All model work is routed through the application's single OpenAI client.
 * Provider credentials and model selection are environment-managed and never
 * stored in the dashboard database.
 */

import { getLLMText, getOpenAIModelStatus, invokeLLM } from "../_core/llm";

export type AIProvider = "openai";

const PM_SYSTEM_PROMPT = `You are a project-management coach embedded in a worker task system.

Help the worker complete the current task efficiently and professionally. Be direct, supportive, concise, and evidence-bound. Use only the supplied context. If the evidence is insufficient, say what is missing and ask one focused question. Never claim that an external action was completed unless the supplied context proves it.`;

export async function getAIConfig() {
  return getOpenAIModelStatus();
}

export async function getAvailableModels() {
  const status = await getOpenAIModelStatus();
  return status.model ? [{ id: status.model, name: status.model }] : [];
}

/** Runtime mutation was intentionally removed: configuration is env-managed. */
export function setAIConfig(): never {
  throw new Error("AI configuration is managed through OPENAI_API_KEY and OPENAI_MODEL");
}

export function setAIProvider(): never {
  throw new Error("OpenAI is the only configured model provider");
}

export function setAIModel(): never {
  throw new Error("Model selection is managed through OPENAI_MODEL");
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
  if (!text) throw new Error("OpenAI returned an empty response");
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
  const status = await getOpenAIModelStatus();
  if (!status.configured || !status.model) {
    return { success: false, provider: "openai" as const, model: null, message: "OPENAI_API_KEY is not configured" };
  }

  const result = await invokeLLM({
    messages: [{ role: "user", content: "Reply with exactly: Connection successful" }],
    maxTokens: 16,
  });
  const response = getLLMText(result);
  if (!response) throw new Error("OpenAI returned an empty response");
  return {
    success: true,
    provider: "openai" as const,
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
