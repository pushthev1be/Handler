// Meta Model API, Chat Completions (OpenAI-compatible): https://dev.meta.ai/docs/protocols/chat-completions
// Plain fetch, so there is no SDK to keep in step with the API.

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export type ChatMessage =
  | { role: "developer" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

export interface ChatTool {
  type: "function";
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ChatTool[];
  max_completion_tokens?: number;
  reasoning_effort?: "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
}

export interface ChatCompletion {
  model: string;
  choices: { message: { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }; finish_reason: string }[];
  usage: { prompt_tokens: number; completion_tokens: number; prompt_tokens_details?: { cached_tokens?: number } | null };
}

/** The one call the agent needs. Tests pass a scripted implementation. */
export interface LlmClient {
  complete(req: ChatRequest): Promise<ChatCompletion>;
}

export class LlmError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export function metaClient(
  apiKey = process.env.META_API_KEY,
  baseUrl = process.env.META_BASE_URL ?? "https://api.meta.ai/v1",
): LlmClient {
  if (!apiKey) throw new Error("META_API_KEY is not set");
  return {
    async complete(req) {
      // Meta recommends exponential backoff with jitter on 429; 5xx are retried the same way.
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(req),
        });
        if (res.ok) return (await res.json()) as ChatCompletion;
        const retryable = res.status === 429 || res.status >= 500;
        if (!retryable || attempt >= 3) {
          throw new LlmError(res.status, `Meta API ${res.status}: ${(await res.text()).slice(0, 500)}`);
        }
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt + Math.random() * 250));
      }
    },
  };
}
