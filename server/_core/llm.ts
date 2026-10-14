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

const getProviders = async (): Promise<ProviderConfig[]> => {
  const providers: ProviderConfig[] = [];
  let dbSettings = new Map<string, string>();
  
  try {
    const db = await getDb();
    if (db) {
      const keys = ['ai_provider', 'ai_model', 'ai_groq_key', 'ai_together_key', 'ai_openrouter_key', 'ai_ollama_url'];
      const settings = await db.select().from(appSettings).where(inArray(appSettings.key, keys));
      dbSettings = new Map(settings.map(s => [s.key, s.value]));
    }
  } catch (e) {
    console.error("[LLM] Failed to read settings from DB, falling back to ENV", e);
  }

  const selectedProvider = dbSettings.get('ai_provider');
  const selectedModel = dbSettings.get('ai_model');
  
  if (selectedProvider && selectedModel) {
    let key = '';
    let url = '';
    if (selectedProvider === 'groq') {
      key = dbSettings.get('ai_groq_key') || process.env.GROQ_API_KEY || '';
      url = 'https://api.groq.com/openai/v1/chat/completions';
    } else if (selectedProvider === 'together') {
      key = dbSettings.get('ai_together_key') || process.env.TOGETHER_API_KEY || '';
      url = 'https://api.together.xyz/v1/chat/completions';
    } else if (selectedProvider === 'openrouter') {
      key = dbSettings.get('ai_openrouter_key') || process.env.OPENROUTER_API_KEY || '';
      url = 'https://openrouter.ai/api/v1/chat/completions';
    } else if (selectedProvider === 'ollama') {
      key = 'ollama'; // No auth needed
      url = `${(dbSettings.get('ai_ollama_url') || 'http://localhost:11434').replace(/\/$/, '')}/v1/chat/completions`;
    }
    
    if (key) {
      providers.push({ id: selectedProvider, url, key, model: selectedModel });
    }
  }

  // Fallbacks
  const groqEnv = process.env.GROQ_API_KEY;
  if (groqEnv && !providers.find(p => p.id === 'groq')) {
    providers.push({ id: 'groq', url: 'https://api.groq.com/openai/v1/chat/completions', key: groqEnv, model: 'llama-3.3-70b-versatile' });
  }

  const forgeEnv = ENV.forgeApiKey;
  if (forgeEnv && !providers.find(p => p.id === 'forge')) {
    const forgeUrl = ENV.forgeApiUrl ? `${ENV.forgeApiUrl.replace(/\/$/, "")}/v1/chat/completions` : "https://forge.manus.im/v1/chat/completions";
    providers.push({ id: 'forge', url: forgeUrl, key: forgeEnv, model: 'gemini-2.5-flash' });
  }
  
  const openaiEnv = process.env.OPENAI_API_KEY;
  if (openaiEnv && !providers.find(p => p.id === 'openai')) {
    providers.push({ id: 'openai', url: 'https://api.openai.com/v1/chat/completions', key: openaiEnv, model: 'gpt-4o-mini' });
  }

  if (providers.length === 0) {
    throw new Error("No LLM API keys configured. Set GROQ_API_KEY, OPENAI_API_KEY, or use the Settings UI.");
  }
  return providers;
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

      const maxOut = params.maxTokens ?? params.max_tokens;
      if (provider.id === 'groq') {
        payload.max_tokens = Math.min(maxOut ?? 2048, 2048);
      } else {
        payload.max_tokens = maxOut ?? 32768;
        if (provider.id === 'forge') {
          (payload as any).thinking = { budget_tokens: 128 };
        }
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
      
      if (provider.key !== 'ollama') {
        headers.authorization = `Bearer ${provider.key}`;
      }

      // OpenRouter specific headers
      if (provider.id === 'openrouter') {
        headers['HTTP-Referer'] = 'http://localhost:3000';
        headers['X-Title'] = 'VA Dashboard';
      }

      const response = await fetch(provider.url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`${response.status} ${response.statusText} – ${errorText}`);
      }

      return (await response.json()) as InvokeResult;
      
    } catch (error: any) {
      console.warn(`[LLM] Provider '${provider.id}' failed: ${error.message}`);
      errors.push(`[${provider.id}] ${error.message}`);
      // Continue loop to try fallback provider
    }
  }

  throw new Error(`All LLM providers failed:\n${errors.join('\n')}`);
}
