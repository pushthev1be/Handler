import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "../src/db.js";
import { createOrder } from "../src/orders.js";
import { fixture, shipTo, SLUGS, type Fixture } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
  // one order per client so every tenant table has rows
  for (const slug of SLUGS) {
    const code = { northwind: "NWT-ZEL-0102", halcyon: "HLC-OST-2201", meridian: "MRX-CRD-3302" }[slug];
    await withScope(f.db, f.scopes[slug], (tx) => createOrder(tx, f.scopes[slug], { job_code: code, quantity: 5, ship_to: shipTo }));
  }
});
afterAll(() => f.close());

const TENANT_TABLES = ["public.clients", "public.documents", "public.chunks", "public.orders", "public.audit_log", "public.inventory_items", "public.inventory_movements"];

describe("row-level security", () => {
  for (const slug of SLUGS) {
    it(`${slug} sees only its own rows in every tenant table`, async () => {
      const scope = f.scopes[slug];
      for (const table of TENANT_TABLES) {
        const col = table === "public.clients" ? "id" : "client_id";
        const { rows } = await withScope(f.db, scope, (tx) =>
          tx.query<{ foreign: number; own: number }>(
            `select count(*) filter (where ${col} <> $1)::int as foreign, count(*) filter (where ${col} = $1)::int as own from ${table}`,
            [scope.clientId],
          ),
        );
        expect(rows[0].foreign, `${table} leaked`).toBe(0);
        expect(rows[0].own, `${table} empty`).toBeGreaterThan(0);
      }
    });
  }

  it("a session with no client claim sees nothing", async () => {
    const counts = await f.db.transaction(async (tx) => {
      await tx.query("set local role authenticated");
      const out: number[] = [];
      for (const table of TENANT_TABLES) out.push((await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0].n);
      return out;
    });
    expect(counts).toEqual(TENANT_TABLES.map(() => 0));
  });

  it("anon role cannot read anything", async () => {
    await expect(
      f.db.transaction(async (tx) => {
        await tx.query("set local role anon");
        await tx.query("select * from public.documents");
      }),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot insert an order into another client's tenant", async () => {
    const nw = f.scopes.northwind;
    const halcyonDoc = (await f.db.query<{ id: string }>(
      "select id from public.documents where job_code = 'HLC-OST-2201'",
    )).rows[0].id;
    await expect(
      withScope(f.db, nw, (tx) =>
        tx.query(
          `insert into public.orders (client_id, document_id, job_code, doc_version, quantity, ship_to, requested_by)
           values ($1, $2, 'HLC-OST-2201', 1, 1, '{}', 'x')`,
          [f.scopes.halcyon.clientId, halcyonDoc],
        ),
      ),
    ).rejects.toThrow();
  });

  it("cannot order another client's material under its own client_id", async () => {
    const nw = f.scopes.northwind;
    const halcyonDoc = (await f.db.query<{ id: string }>(
      "select id from public.documents where job_code = 'HLC-OST-2201'",
    )).rows[0].id;
    await expect(
      withScope(f.db, nw, (tx) =>
        tx.query(
          `insert into public.orders (client_id, document_id, job_code, doc_version, quantity, ship_to, requested_by)
           values ($1, $2, 'HLC-OST-2201', 1, 1, '{}', 'x')`,
          [nw.clientId, halcyonDoc],
        ),
      ),
    ).rejects.toThrow(/not approved and current|foreign key/);
  });

  it("cannot modify materials, even its own", async () => {
    await expect(
      withScope(f.db, f.scopes.northwind, (tx) => tx.query("update public.documents set status = 'approved'")),
    ).rejects.toThrow(/permission denied/);
  });

  it("cannot move an order to another tenant", async () => {
    await expect(
      withScope(f.db, f.scopes.northwind, (tx) =>
        tx.query("update public.orders set client_id = $1", [f.scopes.halcyon.clientId]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  // Documents a known limitation (validation pack, risk R4): SET ROLE is checked against the
  // session user, so scoping protects against query bugs, not against arbitrary SQL. The model
  // has no SQL tool and every statement is parameterised; production connects as a login role
  // that is only a member of `authenticated` (as Supabase's `authenticator` is).
  it("KNOWN LIMITATION: a privileged session user can leave the scope with raw SQL", async () => {
    const n = await withScope(f.db, f.scopes.northwind, async (tx) => {
      await tx.query("set role postgres");
      return (await tx.query<{ n: number }>("select count(distinct client_id)::int as n from public.documents")).rows[0].n;
    });
    expect(n).toBe(3);
  });
});
