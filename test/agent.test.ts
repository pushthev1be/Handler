import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PROMPT_VERSION, runChat } from "../src/agent.js";
import { withScope } from "../src/db.js";
import type { ChatCompletion, ChatRequest, LlmClient } from "../src/llm.js";
import { fixture, type Fixture } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => (f = await fixture()));
afterAll(() => f.close());

/** Scripted stand-in for Meta's Chat Completions API. */
function scripted(responses: ChatCompletion[]) {
  const calls: ChatRequest[] = [];
  const client: LlmClient = {
    complete: async (req) => {
      calls.push(structuredClone(req));
      return responses.shift()!;
    },
  };
  return { client, calls };
}

const usage = { prompt_tokens: 1000, completion_tokens: 200 };
const toolCall = (id: string, name: string, args: string): ChatCompletion => ({
  model: "muse-spark-1.3", usage,
  choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: args } }] } }],
});
const answer = (text: string): ChatCompletion => ({
  model: "muse-spark-1.3", usage,
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: text } }],
});

describe("agent loop", () => {
  it("runs MCP tools, returns the answer and logs tokens, cost, latency and prompt version", async () => {
    const { client, calls } = scripted([
      toolCall("call_1", "search_materials", JSON.stringify({ query: "dosing guide" })),
      answer("Use the dosing guide [NWT-ZEL-0102 v1]."),
    ]);

    const scope = f.scopes.northwind;
    const result = await runChat(f, scope, "Northwind Therapeutics", [{ role: "user", content: "dosing guide?" }], client);

    expect(result.reply).toContain("NWT-ZEL-0102");
    expect(result.tool_calls[0].name).toBe("search_materials");
    expect(result.tool_calls[0].output).toContain("NWT-ZEL-0102");
    expect(calls[0].messages[0]).toMatchObject({ role: "developer" });
    expect(calls[0].messages[0].content).toContain("Northwind Therapeutics");
    expect(calls[0].tools!.map((t) => t.function.name)).toContain("create_order");
    // 2000 in × $1.25 + 400 out × $4.25 per MTok
    expect(result.metrics).toMatchObject({ prompt_version: PROMPT_VERSION, input_tokens: 2000, output_tokens: 400, cost_usd: 0.0042 });

    // Meta rejects history unless the assistant's tool_calls are replayed, followed by one tool message per call.
    const second = calls[1].messages;
    expect(second.at(-2)).toMatchObject({ role: "assistant", tool_calls: [{ id: "call_1" }] });
    expect(second.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_1" });

    const { rows } = await withScope(f.db, scope, (tx) =>
      tx.query<{ prompt_version: string; cost_usd: string; latency_ms: number }>(
        "select prompt_version, cost_usd, latency_ms from public.request_log where request_id = $1",
        [result.request_id],
      ),
    );
    expect(rows[0].prompt_version).toBe(PROMPT_VERSION);
    expect(Number(rows[0].cost_usd)).toBeCloseTo(0.0042);
    expect(rows[0].latency_ms).toBeGreaterThanOrEqual(0);
  });

  it("malformed tool arguments become a tool error, not a crash", async () => {
    const { client, calls } = scripted([toolCall("call_x", "search_materials", "{not json"), answer("Sorry, let me try again.")]);
    const result = await runChat(f, f.scopes.meridian, "Meridian Rx", [{ role: "user", content: "brochures" }], client);
    expect(result.tool_calls[0]).toMatchObject({ is_error: true, output: "Tool arguments were not valid JSON." });
    expect(calls[1].messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "call_x" });
  });

  it("a content-filter stop ends the turn with a safe reply and is still logged", async () => {
    const { client } = scripted([{ model: "muse-spark-1.3", usage, choices: [{ finish_reason: "content_filter", message: { role: "assistant", content: null } }] }]);
    const result = await runChat(f, f.scopes.halcyon, "Halcyon Biopharma", [{ role: "user", content: "..." }], client);
    expect(result.metrics.stop_reason).toBe("content_filter");
    expect(result.reply).toMatch(/can't help/);
  });
});
