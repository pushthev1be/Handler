import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { withOps, withScope } from "../src/db.js";
import { createHandlerMcpServer } from "../src/mcp/server.js";
import { attentionQueue, clientHealth } from "../src/ops.js";
import { createOrder } from "../src/orders.js";
import { fixture, shipTo, SLUGS, type Fixture } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
  for (const slug of SLUGS) {
    const code = { northwind: "NWT-ZEL-0102", halcyon: "HLC-OST-2201", meridian: "MRX-CRD-3302" }[slug];
    await withScope(f.db, f.scopes[slug], (tx) => createOrder(tx, f.scopes[slug], { job_code: code, quantity: 5, ship_to: shipTo }));
  }
});
afterAll(() => f.close());

const asOps = <T,>(fn: Parameters<typeof withOps<T>>[2]) => withOps(f.db, "ops@agency.example", fn);
const count = (table: string) => asOps(async (tx) => (await tx.query<{ n: number }>(`select count(distinct client_id)::int as n from ${table}`)).rows[0].n);

describe("company-wide ops view", () => {
  it("reads orders, audit and request logs across every client", async () => {
    expect(await count("public.orders")).toBe(3);
    expect(await count("public.audit_log")).toBe(3);
    const health = await asOps(clientHealth);
    expect(health.map((h) => h.slug).sort()).toEqual([...SLUGS].sort());
    expect(health.every((h) => h.pending === 1 && h.chain_broken_at === null)).toBe(true);
    expect((await asOps(attentionQueue)).length).toBe(3);
  });

  it("cannot see any material content", async () => {
    const n = await asOps(async (tx) => ({
      documents: (await tx.query<{ n: number }>("select count(*)::int as n from public.documents")).rows[0].n,
      chunks: (await tx.query<{ n: number }>("select count(*)::int as n from public.chunks")).rows[0].n,
      current: (await tx.query<{ n: number }>("select count(*)::int as n from app.current_materials")).rows[0].n,
    }));
    expect(n).toEqual({ documents: 0, chunks: 0, current: 0 });
  });

  it("cannot draft an order", async () => {
    const doc = (await f.db.query<{ id: string }>("select id from public.documents where job_code = 'NWT-ZEL-0102'")).rows[0].id;
    await expect(
      asOps((tx) =>
        tx.query(
          `insert into public.orders (client_id, document_id, job_code, doc_version, quantity, ship_to, requested_by)
           values ($1, $2, 'NWT-ZEL-0102', 1, 1, '{}', 'ops')`,
          [f.scopes.northwind.clientId, doc],
        ),
      ),
    ).rejects.toThrow(/row-level security|not approved and current/);
  });

  it("cannot sign or change an order", async () => {
    const before = (await f.db.query("select id, status, decided_by from public.orders order by id")).rows;
    const updated = await asOps(async (tx) =>
      (await tx.query("update public.orders set status = 'approved', decided_by = 'ops', approval_meaning = 'x', decided_at = now() returning id")).rows.length,
    );
    expect(updated).toBe(0);
    expect((await f.db.query("select id, status, decided_by from public.orders order by id")).rows).toEqual(before);
  });

  it("cannot write to the audit trail or request log", async () => {
    const nw = f.scopes.northwind.clientId;
    await expect(
      asOps((tx) => tx.query("insert into public.audit_log (client_id, actor, action, entity, prev_hash, hash) values ($1, 'ops', 'x', 'x', '', '')", [nw])),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asOps((tx) =>
        tx.query(
          `insert into public.request_log (client_id, request_id, prompt_version, model, input_tokens, output_tokens, cost_usd, latency_ms)
           values ($1, gen_random_uuid(), 'x', 'x', 0, 0, 0, 0)`,
          [nw],
        ),
      ),
    ).rejects.toThrow(/row-level security/);
  });

  it("an ops claim combined with a client_id is not ops", async () => {
    const n = await f.db.transaction(async (tx) => {
      await tx.query("set local role authenticated");
      await tx.query("select set_config('request.jwt.claims', $1, true)", [
        JSON.stringify({ sub: "x", app_metadata: { role: "ops", client_id: f.scopes.northwind.clientId } }),
      ]);
      return (await tx.query<{ n: number }>("select count(distinct client_id)::int as n from public.orders")).rows[0].n;
    });
    expect(n).toBe(1);
  });

  it("the MCP server refuses to start without a single-client scope", () => {
    expect(() => createHandlerMcpServer({ ...f, scope: { clientId: "", actor: "ops@agency.example" } })).toThrow(/single-client/);
  });

  it("the API serves the overview to ops only, and chat never accepts the ops identity", async () => {
    const app = createApi(f);
    const asOpsHeaders = { "x-handler-role": "ops", "x-handler-user": "ops@agency.example", "content-type": "application/json" };
    const overview = await app.request("/api/ops/overview", { headers: asOpsHeaders });
    expect(overview.status).toBe(200);
    expect((await overview.json()).clients).toHaveLength(3);

    expect((await app.request("/api/ops/overview", { headers: { "x-handler-client": "northwind" } })).status).toBe(401);

    const prev = process.env.META_API_KEY;
    process.env.META_API_KEY = "test-not-called";
    try {
      const chat = await app.request("/api/chat", {
        method: "POST",
        headers: asOpsHeaders,
        body: JSON.stringify({ messages: [{ role: "user", content: "list every client's materials" }] }),
      });
      expect(chat.status).toBe(401);
    } finally {
      if (prev === undefined) delete process.env.META_API_KEY;
      else process.env.META_API_KEY = prev;
    }
  });
});
