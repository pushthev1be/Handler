import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withOps, withScope } from "../src/db.js";
import { checkInventory, lowStockAlerts, reserveStock } from "../src/inventory.js";
import { createOrder, decideOrder, OrderError, orderStatus } from "../src/orders.js";
import { fixture, shipTo, type Fixture } from "./fixtures.js";

let f: Fixture;
let now = Date.now();
beforeAll(async () => (f = await fixture({ stepMs: 1000, now: () => now, outOfStock: ["MRX-CRD-3302"] })));
afterAll(() => f.close());

const sign = { signer: "Pat Lee", meaning: "Approved for fulfillment" };
const stockOf = async (slug: "northwind" | "halcyon" | "meridian", job: string) =>
  (await withScope(f.db, f.scopes[slug], (tx) => checkInventory(tx, job)))[0];
const draft = (slug: "northwind" | "halcyon" | "meridian", job_code: string, quantity: number) =>
  withScope(f.db, f.scopes[slug], (tx) => createOrder(tx, f.scopes[slug], { job_code, quantity, ship_to: shipTo }));

describe("inventory visibility", () => {
  it("each client sees only its own stock", async () => {
    for (const [slug, prefix] of [["northwind", "NWT-"], ["halcyon", "HLC-"], ["meridian", "MRX-"]] as const) {
      const rows = await withScope(f.db, f.scopes[slug], (tx) => checkInventory(tx));
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.job_code.startsWith(prefix))).toBe(true);
    }
  });

  it("another client's job code simply isn't there", async () => {
    expect(await withScope(f.db, f.scopes.halcyon, (tx) => checkInventory(tx, "NWT-ZEL-0101"))).toEqual([]);
  });

  it("flags stock of expired and withdrawn materials as not orderable, and low stock", async () => {
    expect(await stockOf("northwind", "NWT-ZEL-0103")).toMatchObject({ on_hand: 640, material_current: false });
    expect(await stockOf("northwind", "NWT-ZEL-0105")).toMatchObject({ material_current: false });
    expect(await stockOf("northwind", "NWT-ZEL-0102")).toMatchObject({ low_stock: true, material_current: true });
    expect((await stockOf("northwind", "NWT-ZEL-0103")).note).toMatch(/not current/);
  });

  it("the company sees low stock across clients but still no material content", async () => {
    const alerts = await withOps(f.db, "ops@agency", lowStockAlerts);
    expect(new Set(alerts.map((a) => a.client_slug)).size).toBeGreaterThan(1);
    const docs = await withOps(f.db, "ops@agency", (tx) => tx.query("select 1 from public.documents"));
    expect(docs.rows).toEqual([]);
  });
});

describe("stock rules", () => {
  it("rejects a draft that exceeds available stock, with the real number", async () => {
    await expect(draft("northwind", "NWT-ZEL-0102", 90)).rejects.toThrow(/Only 85 .* available/);
    await expect(draft("northwind", "NWT-ZEL-0102", 90)).rejects.toBeInstanceOf(OrderError);
  });

  it("approval reserves, shipping decrements on-hand once, and the ledger explains it", async () => {
    const before = await stockOf("halcyon", "HLC-OST-2201");
    const o = await draft("halcyon", "HLC-OST-2201", 30);
    const done = await decideOrder(f.db, f.scopes.halcyon, f.legacy, o.id, { decision: "approve", ...sign });
    expect(done.status).toBe("submitted");
    expect(await stockOf("halcyon", "HLC-OST-2201")).toMatchObject({ on_hand: before.on_hand, reserved: before.reserved + 30 });

    now += 2500;
    for (let i = 0; i < 2; i++) await withScope(f.db, f.scopes.halcyon, (tx) => orderStatus(tx, f.legacy, o.id)); // idempotent
    expect(await stockOf("halcyon", "HLC-OST-2201")).toMatchObject({ on_hand: before.on_hand - 30, reserved: before.reserved });

    const { rows } = await withScope(f.db, f.scopes.halcyon, (tx) =>
      tx.query<{ kind: string }>("select kind from public.inventory_movements where order_id = $1 order by id", [o.id]),
    );
    expect(rows.map((r) => r.kind)).toEqual(["reserve", "ship"]);
  });

  it("a rejected order never touches stock", async () => {
    const before = await stockOf("halcyon", "HLC-OST-2202");
    const o = await draft("halcyon", "HLC-OST-2202", 100);
    await decideOrder(f.db, f.scopes.halcyon, f.legacy, o.id, { decision: "reject", ...sign, meaning: "Rejected" });
    expect(await stockOf("halcyon", "HLC-OST-2202")).toMatchObject({ on_hand: before.on_hand, reserved: before.reserved });
  });

  it("a warehouse rejection releases the reservation", async () => {
    const before = await stockOf("meridian", "MRX-CRD-3302");
    const o = await draft("meridian", "MRX-CRD-3302", 10);
    const done = await decideOrder(f.db, f.scopes.meridian, f.legacy, o.id, { decision: "approve", ...sign });
    expect(done.status).toBe("failed");
    expect(await stockOf("meridian", "MRX-CRD-3302")).toMatchObject({ reserved: before.reserved });
    const actions = (await withScope(f.db, f.scopes.meridian, (tx) =>
      tx.query<{ action: string }>("select action from public.audit_log where entity_id = $1 order by id", [o.id]),
    )).rows.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["inventory.reserved", "inventory.released", "legacy.rejected"]));
  });

  it("two drafts can't both claim the last units: the second approval fails and is audited", async () => {
    const a = await draft("meridian", "MRX-CRD-3304", 8);
    const b = await draft("meridian", "MRX-CRD-3304", 8); // both fit at draft time (12 available)
    const first = await decideOrder(f.db, f.scopes.meridian, f.legacy, a.id, { decision: "approve", ...sign });
    const second = await decideOrder(f.db, f.scopes.meridian, f.legacy, b.id, { decision: "approve", ...sign });
    expect(first.status).toBe("submitted");
    expect(second.status).toBe("failed");
    expect(await stockOf("meridian", "MRX-CRD-3304")).toMatchObject({ reserved: 8, available: 4 });
    const actions = (await withScope(f.db, f.scopes.meridian, (tx) =>
      tx.query<{ action: string }>("select action from public.audit_log where entity_id = $1", [b.id]),
    )).rows.map((r) => r.action);
    expect(actions).toContain("inventory.insufficient");
  });
});

describe("inventory security", () => {
  it("clients and the AI cannot write stock directly", async () => {
    const s = f.scopes.northwind;
    await expect(withScope(f.db, s, (tx) => tx.query("update public.inventory_items set on_hand = 999999"))).rejects.toThrow(/permission denied/);
    await expect(withScope(f.db, s, (tx) => tx.query("delete from public.inventory_items"))).rejects.toThrow(/permission denied/);
    await expect(
      withScope(f.db, s, (tx) => tx.query("insert into public.inventory_movements (client_id, item_id, kind, quantity, actor) select client_id, id, 'receipt', 5, 'x' from public.inventory_items limit 1")),
    ).rejects.toThrow(/permission denied/);
  });

  it("another client cannot reserve against, or even see, someone else's order", async () => {
    const o = await draft("northwind", "NWT-ZEL-0101", 5);
    await decideOrder(f.db, f.scopes.northwind, f.legacy, o.id, { decision: "reject", ...sign, meaning: "Rejected" });
    await expect(withScope(f.db, f.scopes.halcyon, (tx) => reserveStock(tx, o.id))).rejects.toThrow(/order not found/);
  });

  it("only an approved order can reserve stock", async () => {
    const o = await draft("northwind", "NWT-ZEL-0101", 5);
    await expect(withScope(f.db, f.scopes.northwind, (tx) => reserveStock(tx, o.id))).rejects.toThrow(/approved order/);
  });

  it("the ops role cannot move stock", async () => {
    const o = await draft("northwind", "NWT-ZEL-0101", 5);
    await expect(withOps(f.db, "ops@agency", (tx) => reserveStock(tx, o.id))).rejects.toThrow(/order not found/);
  });

  it("the movement ledger is append-only", async () => {
    await expect(f.db.query("update public.inventory_movements set quantity = 1")).rejects.toThrow(/append-only/);
  });
});
