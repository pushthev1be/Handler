import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { withScope, type Scope } from "./db.js";
import { createHandlerMcpServer } from "./mcp/server.js";
import { metaClient, type ChatMessage, type ChatTool, type LlmClient } from "./llm.js";
import { audit } from "./orders.js";
import { costUsd } from "./pricing.js";
import type { Runtime } from "./runtime.js";

export const MODEL = process.env.HANDLER_MODEL ?? "muse-spark-1.3";
const MAX_TURNS = 8;

const promptFile = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "prompts", "system.v1.md");
const PROMPT_TEMPLATE = readFileSync(promptFile, "utf8");
/** Logged with every request: the file name plus a content hash, so an edit without a bump is still visible. */
export const PROMPT_VERSION = `system.v1@${createHash("sha256").update(PROMPT_TEMPLATE).digest("hex").slice(0, 8)}`;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ToolCallLog {
  name: string;
  input: unknown;
  is_error: boolean;
  output: string;
}

export interface ChatResult {
  request_id: string;
  reply: string;
  tool_calls: ToolCallLog[];
  metrics: {
    prompt_version: string;
    model: string;
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens: number;
    cost_usd: number;
    latency_ms: number;
    stop_reason: string | null;
  };
}

export async function runChat(
  rt: Runtime,
  scope: Scope,
  clientName: string,
  history: ChatTurn[],
  llm: LlmClient = metaClient(),
): Promise<ChatResult> {
  const started = performance.now();
  const requestId = randomUUID();

  // The model reaches data only through MCP, exactly as an external MCP host would.
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const server = createHandlerMcpServer({ ...rt, scope });
  await server.connect(serverSide);
  const mcp = new Client({ name: "handler-agent", version: "0.1.0" });
  await mcp.connect(clientSide);

  try {
    const tools: ChatTool[] = (await mcp.listTools()).tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description ?? "", parameters: t.inputSchema as Record<string, unknown> },
    }));
    // Meta gives `developer` the highest instruction precedence and recommends it over `system`.
    const messages: ChatMessage[] = [
      { role: "developer", content: PROMPT_TEMPLATE.replaceAll("{{client_name}}", clientName) },
      ...history.map((t) => ({ role: t.role, content: t.content })),
    ];

    const toolCalls: ToolCallLog[] = [];
    const usage = { input_tokens: 0, output_tokens: 0, cached_tokens: 0 };
    let cost = 0;
    let reply = "";
    let stopReason: string | null = null;
    let servedBy = MODEL;

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await llm.complete({
        model: MODEL,
        messages,
        tools,
        max_completion_tokens: 16000,
        reasoning_effort: "medium",
      });
      const choice = response.choices[0];

      servedBy = response.model;
      stopReason = choice?.finish_reason ?? null;
      usage.input_tokens += response.usage.prompt_tokens;
      usage.output_tokens += response.usage.completion_tokens;
      usage.cached_tokens += response.usage.prompt_tokens_details?.cached_tokens ?? 0;
      cost += costUsd(response.model, response.usage);

      if (!choice || choice.finish_reason === "content_filter") {
        reply = "I can't help with that request. I can search this client's approved materials or draft an order.";
        break;
      }

      const calls = choice.message.tool_calls ?? [];
      // The full assistant message, tool_calls included, must be replayed or the API returns 400.
      messages.push({ role: "assistant", content: choice.message.content, ...(calls.length ? { tool_calls: calls } : {}) });

      if (choice.finish_reason !== "tool_calls" || calls.length === 0) {
        reply = choice.message.content?.trim() ?? "";
        break;
      }

      for (const call of calls) {
        let content: string;
        let isError: boolean;
        let input: unknown = call.function.arguments;
        try {
          // Arguments arrive as a JSON string and are not guaranteed to match the schema; MCP validates them.
          input = JSON.parse(call.function.arguments || "{}");
          const out = await mcp.callTool({ name: call.function.name, arguments: input as Record<string, unknown> });
          content = (out.content as { type: string; text?: string }[])
            .map((c) => (c.type === "text" ? c.text : `[${c.type}]`))
            .join("\n");
          isError = Boolean(out.isError);
        } catch (err) {
          content = err instanceof SyntaxError ? "Tool arguments were not valid JSON." : (err as Error).message;
          isError = true;
        }
        toolCalls.push({ name: call.function.name, input, is_error: isError, output: content });
        messages.push({ role: "tool", tool_call_id: call.id, content });
      }
    }

    if (!reply) reply = "I wasn't able to finish that request. Please try rephrasing it.";

    const metrics = {
      prompt_version: PROMPT_VERSION,
      model: servedBy,
      input_tokens: usage.input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_tokens: usage.cached_tokens,
      cost_usd: Number(cost.toFixed(6)),
      latency_ms: Math.round(performance.now() - started),
      stop_reason: stopReason,
    };

    await withScope(rt.db, scope, async (tx) => {
      await tx.query(
        `insert into public.request_log (client_id, request_id, prompt_version, model, input_tokens, output_tokens,
           cache_read_tokens, cost_usd, latency_ms, tool_calls, stop_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [scope.clientId, requestId, metrics.prompt_version, metrics.model, metrics.input_tokens, metrics.output_tokens,
          metrics.cache_read_tokens, metrics.cost_usd, metrics.latency_ms,
          JSON.stringify(toolCalls.map(({ name, is_error }) => ({ name, is_error }))), metrics.stop_reason],
      );
      await audit(tx, scope, "assistant.responded", "request", requestId, {
        prompt_version: metrics.prompt_version,
        model: metrics.model,
        tools: toolCalls.map((t) => t.name),
      });
    });

    return { request_id: requestId, reply, tool_calls: toolCalls, metrics };
  } finally {
    await mcp.close();
    await server.close();
  }
}
