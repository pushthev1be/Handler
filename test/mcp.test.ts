import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createHandlerMcpServer } from "../src/mcp/server.js";
import { fixture, shipTo, type Fixture, type Slug } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => (f = await fixture()));
afterAll(() => f.close());

async function connect(slug: Slug) {
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createHandlerMcpServer({ ...f, scope: f.scopes[slug] }).connect(s);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(c);
  return client;
}

const text = (r: Awaited<ReturnType<Client["callTool"]>>) => (r.content as { text: string }[])[0].text;

describe("MCP server", () => {
  it("exposes exactly the three tools, none of which accept a client or tenant parameter", async () => {
    const { tools } = await (await connect("northwind")).listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["create_order", "order_status", "search_materials"]);
    const schemas = JSON.stringify(tools.map((t) => t.inputSchema));
    expect(schemas).not.toMatch(/client|tenant|account/i);
  });

  it("search_materials is scoped to the bound client", async () => {
    const mcp = await connect("halcyon");
    const r = await mcp.callTool({ name: "search_materials", arguments: { query: "savings card" } });
    const { results } = JSON.parse(text(r)) as { results: { job_code: string }[] };
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((x) => x.job_code.startsWith("HLC-"))).toBe(true);
  });

  it("create_order for another client's job code is an error, not an order", async () => {
    const mcp = await connect("halcyon");
    const r = await mcp.callTool({ name: "create_order", arguments: { job_code: "NWT-ZEL-0102", quantity: 1, ship_to: shipTo } });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/No material with job code/);
  });

  it("create_order returns a pending draft and order_status finds it", async () => {
    const mcp = await connect("meridian");
    const r = await mcp.callTool({ name: "create_order", arguments: { job_code: "MRX-CRD-3301", quantity: 40, ship_to: shipTo } });
    const { order } = JSON.parse(text(r)) as { order: { id: string; status: string; doc_version: number } };
    expect(order).toMatchObject({ status: "pending_approval", doc_version: 3 });

    const s = await mcp.callTool({ name: "order_status", arguments: { order_id: order.id } });
    expect(JSON.parse(text(s)).order.id).toBe(order.id);

    const other = await connect("northwind");
    const leak = await other.callTool({ name: "order_status", arguments: { order_id: order.id } });
    expect(leak.isError).toBe(true);
  });

  it("invalid tool input is rejected by schema validation", async () => {
    const mcp = await connect("meridian");
    const r = await mcp.callTool({ name: "create_order", arguments: { job_code: "MRX-CRD-3301", quantity: -1, ship_to: shipTo } });
    expect(r.isError).toBe(true);
  });
});
