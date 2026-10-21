import { getCodexLlmStatus, invokeCodexLlm } from './codexLlm';

export type Role = 'system' | 'user' | 'assistant' | 'tool' | 'function';
export type TextContent = { type: 'text'; text: string };
export type ImageContent = { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };
export type FileContent = { type: 'file_url'; file_url: {
  url: string; mime_type?: 'audio/mpeg' | 'audio/wav' | 'application/pdf' | 'audio/mp4' | 'video/mp4';
} };
export type MessageContent = string | TextContent | ImageContent | FileContent;
export type Message = { role: Role; content: MessageContent | MessageContent[]; name?: string; tool_call_id?: string };
export type Tool = { type: 'function'; function: { name: string; description?: string; parameters?: Record<string, unknown> } };
export type ToolChoicePrimitive = 'none' | 'auto' | 'required';
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = { type: 'function'; function: { name: string } };
export type ToolChoice = ToolChoicePrimitive | ToolChoiceByName | ToolChoiceExplicit;
export type JsonSchema = { name: string; schema: Record<string, unknown>; strict?: boolean };
export type OutputSchema = JsonSchema;
export type ResponseFormat = { type: 'text' } | { type: 'json_object' } | { type: 'json_schema'; json_schema: JsonSchema };
export type InvokeParams = {
  signal?: AbortSignal;
  beforeDispatch?: () => Promise<void>;
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  /** Requested turn budget, checked against real CLI usage after generation; not a hard generation cap. */
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type InvokeResult = {
  id: string; created: number; model: string;
  choices: Array<{ index: number; message: { role: Role; content: string | Array<TextContent | ImageContent | FileContent>; tool_calls?: ToolCall[] }; finish_reason: string | null }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
};

export function resolveMaxCompletionTokens(value?: number) {
  if (value == null) return 4096;
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error('maxTokens must be a positive integer');
  return value;
}

// Retained for the manager's separately configured legacy API branch, not generic inference.
export function resolveOpenAIRequestTimeoutMs(value = process.env.OPENAI_REQUEST_TIMEOUT_MS) {
  const parsed = Number.parseInt(value ?? '',10);
  return !Number.isFinite(parsed) || parsed < 1000 ? 120_000 : Math.min(parsed,300_000);
}
export function selectPreferredOpenAIModel(modelIds: string[], explicit?: string | null) {
  const requested = explicit?.trim();
  if (requested) {
    if (modelIds.length > 0 && !modelIds.includes(requested)) throw new Error(`OPENAI_MODEL '${requested}' is not available to this API key`);
    return requested;
  }
  return ['gpt-5.2','gpt-5.1','gpt-5','gpt-4.1','gpt-5-mini','gpt-4.1-mini','gpt-4o-mini'].find(model => modelIds.includes(model))
    ?? modelIds.find(model => /^gpt-(?:5|4\.1)(?:$|-)/.test(model) && !/audio|realtime|search|transcribe|tts|image|codex/i.test(model)) ?? 'gpt-4o-mini';
}

export const getLLMModelStatus = getCodexLlmStatus;
/** Compatibility name only: status is truthfully subscription-backed and never performs API discovery. */
export const getOpenAIModelStatus = getLLMModelStatus;
export function getLLMText(result: InvokeResult): string {
  const content = result.choices[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : Array.isArray(content)
    ? content.filter((part): part is TextContent => part.type === 'text').map(part => part.text).join('\n').trim() : '';
}
export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  return invokeCodexLlm({ ...params,maxTokens: resolveMaxCompletionTokens(params.maxTokens ?? params.max_tokens) });
}
