import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { withScope, type Db, type Scope } from "../db.js";
import type { Embedder } from "../embed.js";
import type { LegacyClient } from "../legacy/client.js";
import { searchMaterials } from "../materials.js";
import { audit, createOrder, createOrderInput, listOrders, OrderError, orderStatus } from "../orders.js";

export interface McpDeps {
  db: Db;
  embedder: Embedder;
  legacy: LegacyClient;
  /** Bound at construction. No tool takes a client parameter, so the model cannot pick a tenant. */
  scope: Scope;
}

const json = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }] });
const fail = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function createHandlerMcpServer({ db, embedder, legacy, scope }: McpDeps): McpServer {
  // The AI only ever runs inside one client. There is deliberately no ops/company-wide mode.
  if (!UUID.test(scope?.clientId ?? "")) throw new Error("MCP server requires a single-client scope");
  const server = new McpServer({ name: "handler", version: "0.1.0" });

  server.registerTool(
    "search_materials",
    {
      title: "Search approved materials",
      description:
        "Semantic search over this client's approved, current materials. Expired, draft, withdrawn and superseded versions are never returned. Each hit has the job code and version to cite.",
      inputSchema: {
        query: z.string().min(2).max(500).describe("What the user is looking for, in plain English or a job code"),
        limit: z.number().int().min(1).max(10).optional().describe("Max results, default 5"),
      },
    },
    async ({ query, limit }) =>
      withScope(db, scope, async (tx) => {
        const hits = await searchMaterials(tx, embedder, query, limit ?? 5);
        await audit(tx, scope, "materials.searched", "search", null, {
          query,
          results: hits.map((h) => `${h.job_code} v${h.version}`),
        });
        return json({ results: hits });
      }),
  );

  server.registerTool(
    "create_order",
    {
      title: "Draft a fulfillment order",
      description:
        "Creates a DRAFT order for one approved, current material. The order is NOT shipped: it waits in status pending_approval until a named person approves it in the Handler UI. Confirm job code, quantity and full ship-to address with the user before calling.",
      inputSchema: createOrderInput.shape,
    },
    async (input) => {
      try {
        const order = await withScope(db, scope, (tx) => createOrder(tx, scope, createOrderInput.parse(input)));
        return json({ order, next_step: "A human must approve this order in the Handler UI before it is sent to the warehouse." });
      } catch (err) {
        if (err instanceof OrderError || err instanceof z.ZodError) return fail(err.message);
        if ((err as { code?: string }).code === "23514") return fail((err as Error).message);
        throw err;
      }
    },
  );

  server.registerTool(
    "order_status",
    {
      title: "Order status",
      description:
        "Status of one order by id, including live warehouse status once submitted. Without an id, lists this client's most recent orders.",
      inputSchema: {
        order_id: z.string().optional().describe("Order id returned by create_order"),
      },
    },
    async ({ order_id }) =>
      withScope(db, scope, async (tx) => {
        if (!order_id) return json({ orders: await listOrders(tx, 10) });
        const status = await orderStatus(tx, legacy, order_id);
        return status ? json(status) : fail(`No order ${order_id} found for this client.`);
      }),
  );

  return server;
}
