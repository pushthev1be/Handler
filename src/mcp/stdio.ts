// Stdio entry point for MCP hosts (Claude Desktop, Claude Code, etc).
// One process serves exactly one client, pinned by configuration, never by the model:
//   HANDLER_CLIENT=northwind HANDLER_ACTOR=jane@agency.example npx tsx src/mcp/stdio.ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { bootstrap, scopeFor } from "../runtime.js";
import { createHandlerMcpServer } from "./server.js";

const slug = process.env.HANDLER_CLIENT;
if (!slug) {
  console.error("HANDLER_CLIENT is required (e.g. northwind, halcyon, meridian)");
  process.exit(1);
}

const rt = await bootstrap();
const { scope } = await scopeFor(rt.db, slug, process.env.HANDLER_ACTOR ?? `mcp:${slug}`);
await createHandlerMcpServer({ ...rt, scope }).connect(new StdioServerTransport());
console.error(`handler MCP server ready for client "${slug}"`);
