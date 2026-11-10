// Adapter: translates our typed orders to the legacy record layout and back.
// The legacy system has no tenant concept, so this adapter is never called with a
// reference the caller did not first read from their own RLS-scoped orders table.

export interface ShipTo {
  name: string;
  line1: string;
  line2?: string;
  city: string;
  state: string;
  zip: string;
}

export type LegacyStatus = "RECEIVED" | "PICKING" | "SHIPPED";

export class LegacyError extends Error {
  constructor(public code: string, message: string) {
    super(`legacy ${code}: ${message}`);
  }
}

export interface LegacyClient {
  submitOrder(o: { account: string; ourRef: string; item: string; qty: number; shipTo: ShipTo }): Promise<string>;
  getStatus(ref: string): Promise<{ ref: string; status: LegacyStatus; date: string; tracking: string | null }>;
}

/** The record format is pipe-delimited; any field containing | or a newline would corrupt it. */
function field(v: string): string {
  if (/[|\r\n]/.test(v)) throw new LegacyError("LOCAL", "field contains a reserved character");
  return v.toUpperCase();
}

export function legacyClient(baseUrl: string, timeoutMs = 5_000): LegacyClient {
  const call = async (path: string, init?: RequestInit) => {
    const res = await fetch(baseUrl + path, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    const text = (await res.text()).trim();
    const parts = text.split("|");
    if (parts[0] === "NAK") throw new LegacyError(parts[1], parts[2] ?? "rejected");
    return parts;
  };

  return {
    async submitOrder({ account, ourRef, item, qty, shipTo }) {
      const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
      const body = [
        ["HDR", field(account), field(ourRef), today],
        ["LIN", "001", field(item), String(qty)],
        ["SHP", ...[shipTo.name, shipTo.line1, shipTo.line2 ?? "", shipTo.city, shipTo.state, shipTo.zip].map(field)],
        ["END"],
      ]
        .map((r) => r.join("|"))
        .join("\n");
      const [, ref] = await call("/cgi-bin/ORDENT", { method: "POST", body });
      return ref;
    },
    async getStatus(ref) {
      const [, r, status, date, tracking] = await call(`/cgi-bin/ORDSTS?ref=${encodeURIComponent(ref)}`);
      return {
        ref: r,
        status: status as LegacyStatus,
        date: `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`,
        tracking: tracking || null,
      };
    },
  };
}
