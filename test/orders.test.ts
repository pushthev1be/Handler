import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "../src/db.js";
import { createOrder, createOrderInput, decideOrder, orderStatus } from "../src/orders.js";
import { fixture, shipTo, type Fixture } from "./fixtures.js";

let f: Fixture;
let now = Date.now();
beforeAll(async () => (f = await fixture({ stepMs: 1000, now: () => now, outOfStock: ["MRX-CRD-3302"] })));
afterAll(() => f.close());

const sign = { signer: "Pat Lee", meaning: "Approved for fulfillment", reason: "Rep request" };

describe("orders", () => {
  it("draft -> human approval -> legacy submission -> warehouse status", async () => {
    const s = f.scopes.northwind;
    const order = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "nwt-zel-0101", quantity: 50, ship_to: shipTo }));
    expect(order.status).toBe("pending_approval");
    expect(order.doc_version).toBe(2);

    const submitted = await decideOrder(f.db, s, f.legacy, order.id, { decision: "approve", ...sign });
    expect(submitted.status).toBe("submitted");
    expect(submitted.legacy_ref).toMatch(/^FUL\d{7}$/);
    expect(submitted.decided_by).toBe("Pat Lee");

    now += 2500;
    const status = await withScope(f.db, s, (tx) => orderStatus(tx, f.legacy, order.id));
    expect(status?.warehouse?.status).toBe("SHIPPED");
    expect(status?.warehouse?.tracking).toBeTruthy();
  });

  it("rejection records the signer and never reaches the warehouse", async () => {
    const s = f.scopes.halcyon;
    const order = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "HLC-OST-2201", quantity: 10, ship_to: shipTo }));
    const rejected = await decideOrder(f.db, s, f.legacy, order.id, { decision: "reject", signer: "Pat Lee", meaning: "Rejected", reason: "Duplicate" });
    expect(rejected.status).toBe("rejected");
    expect(rejected.legacy_ref).toBeNull();
  });

  it("a warehouse rejection marks the order failed and is audited", async () => {
    const s = f.scopes.meridian;
    const order = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "MRX-CRD-3302", quantity: 5, ship_to: shipTo }));
    const failed = await decideOrder(f.db, s, f.legacy, order.id, { decision: "approve", ...sign });
    expect(failed.status).toBe("failed");
    const { rows } = await withScope(f.db, s, (tx) =>
      tx.query<{ details: { error: string } }>("select details from public.audit_log where action = 'legacy.rejected'"),
    );
    expect(rows[0].details.error).toMatch(/OUT OF STOCK/);
  });

  it("refuses expired, draft and withdrawn material with a reason", async () => {
    const s = f.scopes.northwind;
    const attempt = (job_code: string) => withScope(f.db, s, (tx) => createOrder(tx, s, { job_code, quantity: 1, ship_to: shipTo }));
    await expect(attempt("NWT-ZEL-0103")).rejects.toThrow(/expired/);
    await expect(attempt("NWT-ZEL-0104")).rejects.toThrow(/draft/);
    await expect(attempt("NWT-ZEL-0105")).rejects.toThrow(/withdrawn/);
  });

  it("enforces the per-material quantity cap", async () => {
    const s = f.scopes.meridian;
    await expect(
      withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "MRX-CRD-3304", quantity: 21, ship_to: shipTo })),
    ).rejects.toThrow(/limit of 20/);
  });

  it("re-checks currency at approval: material that expires after drafting cannot be approved", async () => {
    const s = f.scopes.halcyon;
    const order = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "HLC-OST-2202", quantity: 100, ship_to: shipTo }));
    await f.db.query("update public.documents set expires_at = now() - interval '1 minute' where job_code = 'HLC-OST-2202'");
    await expect(decideOrder(f.db, s, f.legacy, order.id, { decision: "approve", ...sign })).rejects.toThrow(/no longer approved/);
    await f.db.query("update public.documents set expires_at = now() + interval '300 days' where job_code = 'HLC-OST-2202'");
  });

  it("the database blocks skipping approval and rewriting a signature", async () => {
    const s = f.scopes.northwind;
    const order = await withScope(f.db, s, (tx) => createOrder(tx, s, { job_code: "NWT-ZEL-0102", quantity: 1, ship_to: shipTo }));
    await expect(
      withScope(f.db, s, (tx) => tx.query("update public.orders set status = 'submitted', decided_by = 'x', decided_at = now() where id = $1", [order.id])),
    ).rejects.toThrow(/illegal order transition/);

    await decideOrder(f.db, s, f.legacy, order.id, { decision: "approve", ...sign });
    await expect(
      withScope(f.db, s, (tx) => tx.query("update public.orders set decided_by = 'Someone Else' where id = $1", [order.id])),
    ).rejects.toThrow(/immutable/);
  });

  it("rejects ship-to fields that would corrupt the pipe-delimited legacy record", () => {
    const bad = createOrderInput.safeParse({ job_code: "NWT-ZEL-0102", quantity: 1, ship_to: { ...shipTo, line1: "1 Main|LIN|001|X|9999" } });
    expect(bad.success).toBe(false);
  });

  it("a client cannot read or approve another client's order", async () => {
    const owner = f.scopes.northwind;
    const order = await withScope(f.db, owner, (tx) => createOrder(tx, owner, { job_code: "NWT-ZEL-0102", quantity: 2, ship_to: shipTo }));
    const other = f.scopes.meridian;
    expect(await withScope(f.db, other, (tx) => orderStatus(tx, f.legacy, order.id))).toBeNull();
    await expect(decideOrder(f.db, other, f.legacy, order.id, { decision: "approve", ...sign })).rejects.toThrow(/not found/);
  });
});
