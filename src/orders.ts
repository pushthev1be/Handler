import { z } from "zod";
import { withScope, type Db, type Queryable, type Scope } from "./db.js";
import { LegacyError, type LegacyClient } from "./legacy/client.js";
import { explainUnavailable } from "./materials.js";

// No | or newlines anywhere: the legacy record format is pipe-delimited.
const safe = (max: number) => z.string().trim().min(1).max(max).regex(/^[^|\r\n]+$/, "must not contain | or line breaks");

export const shipToSchema = z.object({
  name: safe(60).describe("Recipient name or practice name"),
  line1: safe(60),
  line2: safe(60).optional(),
  city: safe(40),
  state: z.string().regex(/^[A-Z]{2}$/, "two-letter US state code"),
  zip: z.string().regex(/^\d{5}$/, "5-digit ZIP"),
});

export const createOrderInput = z.object({
  job_code: z.string().trim().toUpperCase().regex(/^[A-Z]{3}-[A-Z]{3}-\d{4}$/, "job code like ABC-DEF-1234"),
  quantity: z.number().int().min(1),
  ship_to: shipToSchema,
  notes: safe(500).optional(),
});

export type CreateOrderInput = z.infer<typeof createOrderInput>;

export interface Order {
  id: string;
  job_code: string;
  doc_version: number;
  quantity: number;
  ship_to: z.infer<typeof shipToSchema>;
  notes: string | null;
  status: "pending_approval" | "approved" | "submitted" | "rejected" | "failed";
  requested_by: string;
  decided_by: string | null;
  approval_meaning: string | null;
  approval_reason: string | null;
  decided_at: string | null;
  legacy_ref: string | null;
  created_at: string;
}

const ORDER_COLS = `id, job_code, doc_version, quantity, ship_to, notes, status, requested_by, decided_by,
  approval_meaning, approval_reason, decided_at, legacy_ref, created_at`;

export async function audit(
  tx: Queryable,
  scope: Scope,
  action: string,
  entity: string,
  entityId: string | null,
  details: Record<string, unknown>,
): Promise<void> {
  await tx.query(
    `insert into public.audit_log (client_id, actor, action, entity, entity_id, details, prev_hash, hash)
     values ($1, $2, $3, $4, $5, $6, '', '')`,
    [scope.clientId, scope.actor, action, entity, entityId, JSON.stringify(details)],
  );
}

export class OrderError extends Error {}

/** Drafts an order. It is never sent anywhere until a human approves it. */
export async function createOrder(tx: Queryable, scope: Scope, input: CreateOrderInput): Promise<Order> {
  input = { ...input, job_code: input.job_code.trim().toUpperCase() };
  const { rows: docs } = await tx.query<{ id: string; max_order_qty: number }>(
    `select id, max_order_qty from app.current_materials where job_code = $1`,
    [input.job_code],
  );
  if (!docs[0]) throw new OrderError(await explainUnavailable(tx, input.job_code));
  if (input.quantity > docs[0].max_order_qty) {
    throw new OrderError(`Quantity ${input.quantity} exceeds the per-order limit of ${docs[0].max_order_qty} for ${input.job_code}.`);
  }
  const { rows } = await tx.query<Order>(
    `insert into public.orders (client_id, document_id, job_code, doc_version, quantity, ship_to, notes, requested_by)
     values ($1, $2, $3, 0, $4, $5, $6, $7)
     returning ${ORDER_COLS}`,
    [scope.clientId, docs[0].id, input.job_code, input.quantity, JSON.stringify(input.ship_to), input.notes ?? null, scope.actor],
  );
  return rows[0];
}

export async function listOrders(tx: Queryable, limit = 50): Promise<Order[]> {
  const { rows } = await tx.query<Order>(`select ${ORDER_COLS} from public.orders order by created_at desc limit $1`, [limit]);
  return rows;
}

export async function getOrder(tx: Queryable, id: string): Promise<Order | null> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const { rows } = await tx.query<Order>(`select ${ORDER_COLS} from public.orders where id = $1`, [id]);
  return rows[0] ?? null;
}

/** Order plus live warehouse status. The legacy lookup only ever uses a ref read through RLS. */
export async function orderStatus(tx: Queryable, legacy: LegacyClient, id: string) {
  const order = await getOrder(tx, id);
  if (!order) return null;
  if (!order.legacy_ref) return { order, warehouse: null };
  try {
    return { order, warehouse: await legacy.getStatus(order.legacy_ref) };
  } catch (err) {
    return { order, warehouse: null, warehouse_error: (err as Error).message };
  }
}

export interface Decision {
  decision: "approve" | "reject";
  /** Printed name of the signer (21 CFR 11.50(a)(1)). */
  signer: string;
  /** Meaning of the signature, e.g. "Approved for fulfillment" (11.50(a)(3)). */
  meaning: string;
  reason?: string;
}

/**
 * Human approval. Signing (pending_approval -> approved) is committed before the legacy call,
 * so the signature is recorded even if the warehouse is down; the database re-checks that
 * the material is still approved and current at this moment.
 */
export async function decideOrder(db: Db, scope: Scope, legacy: LegacyClient, id: string, d: Decision): Promise<Order> {
  const signed = await withScope(db, scope, async (tx) => {
    const { rows } = await tx.query<Order>(
      `update public.orders
          set status = $2, decided_by = $3, approval_meaning = $4, approval_reason = $5, decided_at = now()
        where id = $1 and status = 'pending_approval'
        returning ${ORDER_COLS}`,
      [id, d.decision === "approve" ? "approved" : "rejected", d.signer, d.meaning, d.reason ?? null],
    );
    if (!rows[0]) throw new OrderError("Order not found or already decided.");
    return rows[0];
  });
  if (signed.status === "rejected") return signed;

  const account = await withScope(db, scope, async (tx) =>
    (await tx.query<{ legacy_account: string }>("select legacy_account from public.clients")).rows[0].legacy_account,
  );

  let ref: string | null = null;
  let failure: string | null = null;
  try {
    ref = await legacy.submitOrder({ account, ourRef: signed.id.slice(0, 18), item: signed.job_code, qty: signed.quantity, shipTo: signed.ship_to });
  } catch (err) {
    failure = err instanceof LegacyError ? err.message : `legacy unreachable: ${(err as Error).message}`;
  }

  return withScope(db, scope, async (tx) => {
    const { rows } = await tx.query<Order>(
      `update public.orders set status = $2, legacy_ref = $3 where id = $1 returning ${ORDER_COLS}`,
      [id, ref ? "submitted" : "failed", ref],
    );
    if (failure) await audit(tx, scope, "legacy.rejected", "order", id, { error: failure });
    return rows[0];
  });
}
