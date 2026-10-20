import { ENV } from "./env";
import { getDb } from "../db";
import { appSettings } from "../../drizzle/schema.postgres";
import { inArray } from "drizzle-orm";
export type Role = "system" | "user" | "assistant" | "tool" | "function";

export type TextContent = {
  type: "text";
  text: string;
};

export type ImageContent = {
  type: "image_url";
  image_url: {
    url: string;
    detail?: "auto" | "low" | "high";
  };
};

export type FileContent = {
  type: "file_url";
  file_url: {
    url: string;
    mime_type?: "audio/mpeg" | "audio/wav" | "application/pdf" | "audio/mp4" | "video/mp4" ;
  };
};

export type MessageContent = string | TextContent | ImageContent | FileContent;

export type Message = {
  role: Role;
  content: MessageContent | MessageContent[];
  name?: string;
  tool_call_id?: string;
};

export type Tool = {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
};

export type ToolChoicePrimitive = "none" | "auto" | "required";
export type ToolChoiceByName = { name: string };
export type ToolChoiceExplicit = {
  type: "function";
  function: {
    name: string;
  };
};

export type ToolChoice =
  | ToolChoicePrimitive
  | ToolChoiceByName
  | ToolChoiceExplicit;

export type InvokeParams = {
  messages: Message[];
  tools?: Tool[];
  toolChoice?: ToolChoice;
  tool_choice?: ToolChoice;
  maxTokens?: number;
  max_tokens?: number;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
};

export type ToolCall = {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
};

export type InvokeResult = {
  id: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: Role;
      content: string | Array<TextContent | ImageContent | FileContent>;
      tool_calls?: ToolCall[];
    };
    finish_reason: string | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
};

export type JsonSchema = {
  name: string;
  schema: Record<string, unknown>;
  strict?: boolean;
};

export type OutputSchema = JsonSchema;

export type ResponseFormat =
  | { type: "text" }
  | { type: "json_object" }
  | { type: "json_schema"; json_schema: JsonSchema };

const ensureArray = (
  value: MessageContent | MessageContent[]
): MessageContent[] => (Array.isArray(value) ? value : [value]);

const normalizeContentPart = (
  part: MessageContent
): TextContent | ImageContent | FileContent => {
  if (typeof part === "string") {
    return { type: "text", text: part };
  }

  if (part.type === "text") {
    return part;
  }

  if (part.type === "image_url") {
    return part;
  }

  if (part.type === "file_url") {
    return part;
  }

  throw new Error("Unsupported message content part");
};

const normalizeMessage = (message: Message) => {
  const { role, name, tool_call_id } = message;

  if (role === "tool" || role === "function") {
    const content = ensureArray(message.content)
      .map(part => (typeof part === "string" ? part : JSON.stringify(part)))
      .join("\n");

    return {
      role,
      name,
      tool_call_id,
      content,
    };
  }

  const contentParts = ensureArray(message.content).map(normalizeContentPart);

  // If there's only text content, collapse to a single string for compatibility
  if (contentParts.length === 1 && contentParts[0].type === "text") {
    return {
      role,
      name,
      content: contentParts[0].text,
    };
  }

  return {
    role,
    name,
    content: contentParts,
  };
};

const normalizeToolChoice = (
  toolChoice: ToolChoice | undefined,
  tools: Tool[] | undefined
): "none" | "auto" | ToolChoiceExplicit | undefined => {
  if (!toolChoice) return undefined;

  if (toolChoice === "none" || toolChoice === "auto") {
    return toolChoice;
  }

  if (toolChoice === "required") {
    if (!tools || tools.length === 0) {
      throw new Error(
        "tool_choice 'required' was provided but no tools were configured"
      );
    }

    if (tools.length > 1) {
      throw new Error(
        "tool_choice 'required' needs a single tool or specify the tool name explicitly"
      );
    }

    return {
      type: "function",
      function: { name: tools[0].function.name },
    };
  }

  if ("name" in toolChoice) {
    return {
      type: "function",
      function: { name: toolChoice.name },
    };
  }

  return toolChoice;
};

interface ProviderConfig {
  id: string;
  url: string;
  key: string;
  model: string;
}

const OPENAI_MODEL_PREFERENCE = [
  "gpt-5.2",
  "gpt-5.1",
  "gpt-5",
  "gpt-4.1",
  "gpt-5-mini",
  "gpt-4.1-mini",
  "gpt-4o-mini",
] as const;
const MODEL_CACHE_MS = 6 * 60 * 60_000;
const DEFAULT_MAX_COMPLETION_TOKENS = 4_096;
const DEFAULT_OPENAI_REQUEST_TIMEOUT_MS = 120_000;
const MAX_OPENAI_REQUEST_TIMEOUT_MS = 300_000;
let modelCache: { keyFingerprint: string; model: string; expiresAt: number } | null = null;

/**
 * Most operator flows produce short, structured assessments. Keep the shared
 * fallback bounded so a caller that forgets to specify a budget cannot turn a
 * routine request into a 32K-token completion. Longer features can and do
 * pass an explicit positive integer.
 */
export function resolveMaxCompletionTokens(value?: number) {
  if (value == null) return DEFAULT_MAX_COMPLETION_TOKENS;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("maxTokens must be a positive integer");
  }
  return value;
}

/**
 * Keep an unavailable provider from holding an operator action indefinitely.
 * The ceiling preserves a deliberate long-running request without allowing an
 * accidental environment value to consume a request slot for hours.
 */
export function resolveOpenAIRequestTimeoutMs(value = process.env.OPENAI_REQUEST_TIMEOUT_MS) {
  const parsed = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(parsed) || parsed < 1_000) return DEFAULT_OPENAI_REQUEST_TIMEOUT_MS;
  return Math.min(parsed, MAX_OPENAI_REQUEST_TIMEOUT_MS);
}

export function selectPreferredOpenAIModel(modelIds: string[], explicit?: string | null) {
  const available = new Set(modelIds);
  const requested = explicit?.trim();
  if (requested) {
    if (modelIds.length > 0 && !available.has(requested)) {
      throw new Error(`OPENAI_MODEL '${requested}' is not available to this API key`);
    }
    return requested;
  }
  return OPENAI_MODEL_PREFERENCE.find((model) => available.has(model))
    ?? modelIds.find((model) => /^gpt-(?:5|4\.1)(?:$|-)/.test(model) && !/audio|realtime|search|transcribe|tts|image|codex/i.test(model))
    ?? "gpt-4o-mini";
}

async function resolveOpenAIModel(key: string) {
  const explicit = process.env.OPENAI_MODEL?.trim();
  const keyFingerprint = key.slice(-8);
  if (modelCache && modelCache.keyFingerprint === keyFingerprint && modelCache.expiresAt > Date.now()) {
    return explicit || modelCache.model;
  }
  try {
    const response = await fetch("https://api.openai.com/v1/models", {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`model catalog returned ${response.status}`);
    const payload = await response.json() as { data?: Array<{ id?: unknown }> };
    const modelIds = (payload.data ?? []).flatMap((entry) => typeof entry.id === "string" ? [entry.id] : []);
    const model = selectPreferredOpenAIModel(modelIds, explicit);
    modelCache = { keyFingerprint, model, expiresAt: Date.now() + MODEL_CACHE_MS };
    return model;
  } catch (error) {
    if (explicit) return explicit;
    console.warn("[LLM] OpenAI model discovery failed; using the compatibility fallback", {
      reason: error instanceof Error ? error.message : "unknown",
    });
    return "gpt-4o-mini";
  }
}

export async function getOpenAIModelStatus() {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) {
    return {
      configured: false,
      provider: "openai" as const,
      model: null,
      managedBy: "environment" as const,
    };
  }

  return {
    configured: true,
    provider: "openai" as const,
    model: await resolveOpenAIModel(key),
    managedBy: "environment" as const,
  };
}

export function getLLMText(result: InvokeResult): string {
  const content = result.choices[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .filter((part): part is TextContent => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim();
}

const getProviders = async (): Promise<ProviderConfig[]> => {
  const key = process.env.OPENAI_API_KEY?.trim();
  if (!key) throw new Error("OPENAI_API_KEY is required for AI operations");
  return [{
    id: "openai",
    url: "https://api.openai.com/v1/chat/completions",
    key,
    model: await resolveOpenAIModel(key),
  }];
};

const normalizeResponseFormat = ({
  responseFormat,
  response_format,
  outputSchema,
  output_schema,
}: {
  responseFormat?: ResponseFormat;
  response_format?: ResponseFormat;
  outputSchema?: OutputSchema;
  output_schema?: OutputSchema;
}):
  | { type: "json_schema"; json_schema: JsonSchema }
  | { type: "text" }
  | { type: "json_object" }
  | undefined => {
  const explicitFormat = responseFormat || response_format;
  if (explicitFormat) {
    if (
      explicitFormat.type === "json_schema" &&
      !explicitFormat.json_schema?.schema
    ) {
      throw new Error(
        "responseFormat json_schema requires a defined schema object"
      );
    }
    return explicitFormat;
  }

  const schema = outputSchema || output_schema;
  if (!schema) return undefined;

  if (!schema.name || !schema.schema) {
    throw new Error("outputSchema requires both name and schema");
  }

  return {
    type: "json_schema",
    json_schema: {
      name: schema.name,
      schema: schema.schema,
      ...(typeof schema.strict === "boolean" ? { strict: schema.strict } : {}),
    },
  };
};

export async function invokeLLM(params: InvokeParams): Promise<InvokeResult> {
  const providers = await getProviders();
  const errors: string[] = [];

  for (const provider of providers) {
    try {
      const {
        messages,
        tools,
        toolChoice,
        tool_choice,
        outputSchema,
        output_schema,
        responseFormat,
        response_format,
      } = params;

      const payload: Record<string, unknown> = {
        model: provider.model,
        messages: messages.map(normalizeMessage),
      };

      if (tools && tools.length > 0) {
        payload.tools = tools;
      }

      const normalizedToolChoice = normalizeToolChoice(
        toolChoice || tool_choice,
        tools
      );
      if (normalizedToolChoice) {
        payload.tool_choice = normalizedToolChoice;
      }

      const maxOut = resolveMaxCompletionTokens(params.maxTokens ?? params.max_tokens);
      if (/^(?:gpt-5|o\d)/.test(provider.model)) {
        payload.max_completion_tokens = maxOut;
      } else {
        payload.max_tokens = maxOut;
      }

      const normalizedResponseFormat = normalizeResponseFormat({
        responseFormat,
        response_format,
        outputSchema,
        output_schema,
      });

      if (normalizedResponseFormat) {
        payload.response_format = normalizedResponseFormat;
      }

      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      
      headers.authorization = `Bearer ${provider.key}`;

      const response = await fetch(provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(resolveOpenAIRequestTimeoutMs()),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status} ${response.statusText} – ${errorText}`);
      }

      return (await response.json()) as InvokeResult;
      
    } catch (error: any) {
      console.warn(`[LLM] Provider '${provider.id}' failed: ${error.message}`);
      errors.push(`[${provider.id}] ${error.message}`);
      // A single canonical provider avoids cross-provider data leakage and
      // inconsistent assessments. The error is surfaced after this attempt.
    }
  }

  throw new Error(`All LLM providers failed:\n${errors.join('\n')}`);
}
