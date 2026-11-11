import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "../src/db.js";
import { audit, createOrder, decideOrder } from "../src/orders.js";
import { fixture, shipTo, type Fixture } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => {
  f = await fixture();
  const s = f.scopes.northwind;
  const o = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "NWT-ZEL-0102", quantity: 3, ship_to: shipTo }));
  await decideOrder(f.db, s, f.legacy, o.id, { decision: "approve", signer: "Pat Lee", meaning: "Approved for fulfillment" });
  await withScope(f.db, s, (tx) => audit(tx, s, "materials.searched", "search", null, { query: "dosing" }));
});
afterAll(() => f.close());

const verify = (clientId: string) =>
  f.db.query<{ broken: string | null }>("select app.verify_audit_chain($1) as broken", [clientId]).then((r) => r.rows[0].broken);

describe("audit trail", () => {
  it("records order lifecycle automatically, with signer and meaning", async () => {
    const { rows } = await withScope(f.db, f.scopes.northwind, (tx) =>
      tx.query<{ action: string; actor: string; details: Record<string, unknown> }>(
        "select action, actor, details from public.audit_log where entity = 'order' order by id",
      ),
    );
    expect(rows.map((r) => r.action)).toEqual(["order.created", "order.approved", "inventory.reserved", "order.submitted"]);
    expect(rows[1].details).toMatchObject({ decided_by: "Pat Lee", approval_meaning: "Approved for fulfillment" });
    expect(rows[0].actor).toBe("tester@northwind");
  });

  it("hash chain verifies", async () => {
    expect(await verify(f.scopes.northwind.clientId)).toBeNull();
  });

  it("rejects UPDATE, DELETE and TRUNCATE, even for the table owner", async () => {
    await expect(f.db.query("update public.audit_log set actor = 'x'")).rejects.toThrow(/append-only/);
    await expect(f.db.query("delete from public.audit_log")).rejects.toThrow(/append-only/);
    await expect(f.db.query("truncate public.audit_log")).rejects.toThrow(/append-only/);
  });

  it("app users cannot write audit rows for another client", async () => {
    const nw = f.scopes.northwind;
    await expect(
      withScope(f.db, nw, (tx) => audit(tx, { ...nw, clientId: f.scopes.halcyon.clientId }, "forged", "x", null, {})),
    ).rejects.toThrow(/row-level security/);
  });

  it("detects tampering by a superuser who bypasses the triggers", async () => {
    const id = f.scopes.northwind.clientId;
    await f.db.exec("alter table public.audit_log disable trigger audit_log_no_update");
    const { rows } = await f.db.query<{ id: string }>(
      "update public.audit_log set details = details || '{\"quantity\": 3000}' where id = (select min(id) from public.audit_log where client_id = $1 and entity = 'order') returning id",
      [id],
    );
    await f.db.exec("alter table public.audit_log enable trigger audit_log_no_update");
    expect(String(await verify(id))).toBe(String(rows[0].id));
    // other clients' chains are unaffected
    expect(await verify(f.scopes.halcyon.clientId)).toBeNull();
  });
});
