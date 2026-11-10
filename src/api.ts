import { Hono } from "hono";
import { z } from "zod";
import { runChat } from "./agent.js";
import { withOps, withScope } from "./db.js";
import { attentionQueue, clientHealth, lastEval, recentActivity } from "./ops.js";
import { decideOrder, listOrders, OrderError } from "./orders.js";
import { scopeFor, type Runtime } from "./runtime.js";

/**
 * DEMO IDENTITY: the UI's client switcher sends x-handler-client / x-handler-user headers.
 * In production these come from a verified Supabase JWT (app_metadata.client_id, sub);
 * everything downstream already consumes them as a Scope, so only this function changes.
 */
async function identify(rt: Runtime, headers: { client?: string; user?: string }) {
  if (!headers.client) throw new HttpError(401, "missing x-handler-client");
  return scopeFor(rt.db, headers.client, headers.user?.trim() || "anonymous");
}

class HttpError extends Error {
  constructor(public status: 400 | 401 | 404 | 409 | 503, message: string) {
    super(message);
  }
}

const chatBody = z.object({
  messages: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().min(1).max(8000) })).min(1).max(40),
});

const decisionBody = z.object({
  decision: z.enum(["approve", "reject"]),
  signer: z.string().trim().min(2).max(80),
  meaning: z.string().trim().min(3).max(120),
  reason: z.string().trim().max(500).optional(),
});

export function createApi(rt: Runtime) {
  const app = new Hono().basePath("/api");

  app.onError((err, c) => {
    if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
    if (err instanceof z.ZodError) return c.json({ error: err.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") }, 400);
    if (err instanceof OrderError || (err as { code?: string }).code === "23514") return c.json({ error: err.message }, 409);
    if (/unknown client/.test(err.message)) return c.json({ error: err.message }, 401);
    console.error(err);
    return c.json({ error: "internal error" }, 500);
  });

  const who = (c: { req: { header(name: string): string | undefined } }) =>
    identify(rt, { client: c.req.header("x-handler-client"), user: c.req.header("x-handler-user") });

  // Directory for the demo switcher only. Read as owner; exposes names, nothing tenant-internal.
  app.get("/clients", async (c) =>
    c.json((await rt.db.query("select slug, name from public.clients order by name")).rows),
  );

  app.post("/chat", async (c) => {
    if (!process.env.META_API_KEY) throw new HttpError(503, "META_API_KEY is not set on the server");
    const { client, scope } = await who(c);
    const { messages } = chatBody.parse(await c.req.json());
    return c.json(await runChat(rt, scope, client.name, messages));
  });

  app.get("/orders", async (c) => {
    const { scope } = await who(c);
    return c.json(await withScope(rt.db, scope, (tx) => listOrders(tx)));
  });

  app.post("/orders/:id/decision", async (c) => {
    const { scope } = await who(c);
    const body = decisionBody.parse(await c.req.json());
    return c.json(await decideOrder(rt.db, scope, rt.legacy, c.req.param("id"), body));
  });

  app.get("/audit", async (c) => {
    const { scope } = await who(c);
    return c.json(
      await withScope(rt.db, scope, async (tx) => ({
        broken_at: (await tx.query<{ b: string | null }>("select app.verify_audit_chain($1) as b", [scope.clientId])).rows[0].b,
        entries: (await tx.query(
          "select id, occurred_at, actor, action, entity, entity_id, details, hash from public.audit_log order by id desc limit 100",
        )).rows,
      })),
    );
  });

  app.get("/metrics", async (c) => {
    const { scope } = await who(c);
    return c.json(
      await withScope(rt.db, scope, async (tx) => ({
        summary: (await tx.query(
          `select count(*)::int as requests, coalesce(sum(cost_usd), 0)::float8 as cost_usd,
                  coalesce(sum(input_tokens + output_tokens), 0)::int as tokens,
                  coalesce(percentile_cont(0.5) within group (order by latency_ms), 0)::int as p50_ms,
                  coalesce(percentile_cont(0.95) within group (order by latency_ms), 0)::int as p95_ms
             from public.request_log`,
        )).rows[0],
        requests: (await tx.query(
          `select created_at, request_id, prompt_version, model, input_tokens, output_tokens, cost_usd::float8,
                  latency_ms, tool_calls, stop_reason
             from public.request_log order by id desc limit 50`,
        )).rows,
      })),
    );
  });

  // Company-wide operations view. Read-only and AI-free: no chat or MCP route accepts this identity.
  // DEMO IDENTITY (gap G1): in production, the ops role comes from the verified JWT's app_metadata.
  const ops = (c: { req: { header(name: string): string | undefined } }) => {
    if (c.req.header("x-handler-role") !== "ops") throw new HttpError(401, "ops role required");
    return c.req.header("x-handler-user")?.trim() || "anonymous";
  };

  app.get("/ops/overview", async (c) => {
    const actor = ops(c);
    return c.json({
      ...(await withOps(rt.db, actor, async (tx) => ({
        clients: await clientHealth(tx),
        queue: await attentionQueue(tx),
        activity: await recentActivity(tx),
      }))),
      eval: lastEval(),
    });
  });

  return app;
}
