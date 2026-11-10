// One process for local dev: mock legacy system (:7070), API (:8787) and the Vite UI (:5173).
import { serve } from "@hono/node-server";
import { createServer } from "vite";
import { createApi } from "../src/api.js";
import { openDb } from "../src/db.js";
import { startLegacyServer } from "../src/legacy/server.js";
import { bootstrap } from "../src/runtime.js";

const legacy = await startLegacyServer(7070);
const db = await openDb({ dataDir: process.env.DATABASE_URL ? undefined : (process.env.PGLITE_DIR ?? ".data/pglite") });
const rt = await bootstrap({ db, legacyUrl: legacy.url });
serve({ fetch: createApi(rt).fetch, port: 8787 });
const vite = await createServer({ configFile: "web/vite.config.ts" });
await vite.listen();

console.log(`legacy order system  ${legacy.url}`);
console.log("api                  http://localhost:8787/api");
console.log(`ui                   http://localhost:${vite.config.server.port ?? 5173}`);
console.log(`embedder             ${rt.embedder.model}`);
if (!process.env.META_API_KEY) console.log("note: META_API_KEY not set, chat will return 503 (orders, audit and metrics still work)");
