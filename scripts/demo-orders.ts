// Drafts sample orders through the MCP server (same path the model uses) so the
// approvals queue has something in it without a model API key.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { openDb } from "../src/db.js";
import { createHandlerMcpServer } from "../src/mcp/server.js";
import { bootstrap, scopeFor } from "../src/runtime.js";

const rt = await bootstrap({ db: await openDb({ dataDir: process.env.PGLITE_DIR ?? ".data/pglite" }) });
const shipTo = { name: "Dr Ana Ruiz", line1: "100 Main St", city: "Springfield", state: "IL", zip: "62701" };
for (const [slug, job_code, quantity] of [["northwind", "NWT-ZEL-0101", 50], ["northwind", "NWT-ZEL-0102", 20], ["meridian", "MRX-CRD-3301", 40]] as const) {
  const { scope } = await scopeFor(rt.db, slug, "assistant (demo)");
  const [c, s] = InMemoryTransport.createLinkedPair();
  await createHandlerMcpServer({ ...rt, scope }).connect(s);
  const mcp = new Client({ name: "demo", version: "0" });
  await mcp.connect(c);
  await mcp.callTool({ name: "search_materials", arguments: { query: job_code } });
  const r = await mcp.callTool({ name: "create_order", arguments: { job_code, quantity, ship_to: shipTo } });
  console.log(slug, job_code, r.isError ? "ERROR" : "drafted");
}
await rt.db.close();
