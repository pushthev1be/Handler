import type { Queryable } from "./db.js";

export interface StockRow {
  job_code: string;
  title: string | null;
  location: string;
  on_hand: number;
  reserved: number;
  available: number;
  reorder_point: number;
  low_stock: boolean;
  /** false = the material is expired, withdrawn or superseded: stock exists but must not ship. */
  material_current: boolean;
  current_version: number | null;
  max_order_qty: number | null;
  /** Plain-language flag for the AI and UI, derived in SQL-visible fields only. */
  note?: string;
}

const COLS = `job_code, title, location, on_hand, reserved, available, reorder_point, low_stock,
  material_current, current_version, max_order_qty`;

function annotate(r: StockRow): StockRow {
  if (!r.material_current) return { ...r, note: "Material is not current (expired, withdrawn or superseded). Stock cannot be ordered and should be reviewed for quarantine or destruction." };
  if (r.available <= 0) return { ...r, note: "Out of stock." };
  if (r.low_stock) return { ...r, note: "Low stock: at or below the reorder point." };
  return r;
}

/** This client's stock (RLS-scoped), optionally for one job code. Run inside withScope. */
export async function checkInventory(tx: Queryable, jobCode?: string): Promise<StockRow[]> {
  const { rows } = jobCode
    ? await tx.query<StockRow>(`select ${COLS} from app.inventory_status where job_code = $1`, [jobCode.trim().toUpperCase()])
    : await tx.query<StockRow>(`select ${COLS} from app.inventory_status order by job_code`);
  return rows.map(annotate);
}

/** Atomically reserves stock for an approved order. False if there isn't enough. */
export async function reserveStock(tx: Queryable, orderId: string): Promise<boolean> {
  const { rows } = await tx.query<{ ok: boolean }>("select app.reserve_stock($1) as ok", [orderId]);
  return rows[0].ok;
}

export async function releaseStock(tx: Queryable, orderId: string): Promise<void> {
  await tx.query("select app.release_stock($1)", [orderId]);
}

export async function shipStock(tx: Queryable, orderId: string): Promise<void> {
  await tx.query("select app.ship_stock($1)", [orderId]);
}

export interface OpsStockAlert {
  client_slug: string;
  client_name: string;
  job_code: string;
  location: string;
  on_hand: number;
  available: number;
  reorder_point: number;
}

/** Company-wide low-stock list. Run inside withOps; reads stock only, never material content. */
export async function lowStockAlerts(tx: Queryable): Promise<OpsStockAlert[]> {
  const { rows } = await tx.query<OpsStockAlert>(
    `select c.slug as client_slug, c.name as client_name, i.job_code, i.location, i.on_hand,
            (i.on_hand - i.reserved) as available, i.reorder_point
       from public.inventory_items i join public.clients c on c.id = i.client_id
      where i.reorder_point > 0 and (i.on_hand - i.reserved) <= i.reorder_point
      order by (i.on_hand - i.reserved)::float / i.reorder_point, c.name, i.job_code`,
  );
  return rows;
}
