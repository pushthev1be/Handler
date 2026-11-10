// Mock of a legacy fulfillment system: pipe-delimited text over HTTP, its own account codes,
// no notion of our tenants. Stands in for the mainframe/AS400-style systems fulfillment
// houses actually run. Deliberately unfriendly; the adapter in ./client.ts translates.
//
//   POST /cgi-bin/ORDENT          HDR|<acct>|<our_ref>|<yyyymmdd>\nLIN|001|<item>|<qty>\nSHP|...\nEND
//     -> ACK|FUL0000001   or   NAK|<code>|<message>
//   GET  /cgi-bin/ORDSTS?ref=FUL0000001
//     -> STS|FUL0000001|RECEIVED|PICKING|SHIPPED|<yyyymmdd>|<tracking>   or   NAK|E04|NOT FOUND

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

interface LegacyOrder {
  ref: string;
  account: string;
  ourRef: string;
  item: string;
  qty: number;
  receivedAt: number;
}

export interface LegacyOptions {
  /** ms per status step (RECEIVED -> PICKING -> SHIPPED) */
  stepMs?: number;
  now?: () => number;
  /** Item codes the warehouse will reject as out of stock. */
  outOfStock?: string[];
}

export function createLegacyServer(opts: LegacyOptions = {}): Server {
  const stepMs = opts.stepMs ?? 20_000;
  const now = opts.now ?? Date.now;
  const outOfStock = new Set(opts.outOfStock ?? []);
  const byRef = new Map<string, LegacyOrder>();
  const byOurRef = new Map<string, string>();
  let seq = 0;

  const ymd = (t: number) => new Date(t).toISOString().slice(0, 10).replace(/-/g, "");

  return createServer((req, res) => {
    const reply = (status: number, body: string) => {
      res.writeHead(status, { "content-type": "text/plain; charset=latin1" });
      res.end(body);
    };
    const url = new URL(req.url ?? "/", "http://legacy");

    if (req.method === "GET" && url.pathname === "/cgi-bin/ORDSTS") {
      const o = byRef.get(url.searchParams.get("ref") ?? "");
      if (!o) return reply(200, "NAK|E04|NOT FOUND");
      const steps = Math.floor((now() - o.receivedAt) / stepMs);
      const status = ["RECEIVED", "PICKING", "SHIPPED"][Math.min(steps, 2)];
      const tracking = steps >= 2 ? `1Z${o.ref.slice(3)}${o.account}` : "";
      return reply(200, `STS|${o.ref}|${status}|${ymd(o.receivedAt + Math.min(steps, 2) * stepMs)}|${tracking}`);
    }

    if (req.method === "POST" && url.pathname === "/cgi-bin/ORDENT") {
      let body = "";
      req.setEncoding("latin1");
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const lines = body.split(/\r?\n/).filter(Boolean).map((l) => l.split("|"));
        const hdr = lines.find((l) => l[0] === "HDR");
        const lin = lines.filter((l) => l[0] === "LIN");
        const shp = lines.find((l) => l[0] === "SHP");
        if (!hdr || hdr.length !== 4 || !shp || lines.at(-1)?.[0] !== "END") return reply(200, "NAK|E01|BAD RECORD LAYOUT");
        if (lin.length !== 1 || lin[0].length !== 4) return reply(200, "NAK|E02|ONE LINE ITEM PER ORDER");
        const [, account, ourRef] = hdr;
        const [, , item, qtyText] = lin[0];
        const qty = Number(qtyText);
        if (!/^[A-Z]{3}\d{2}$/.test(account)) return reply(200, "NAK|E03|UNKNOWN ACCOUNT");
        if (!Number.isInteger(qty) || qty < 1 || qty > 9999) return reply(200, "NAK|E05|INVALID QTY");
        if (outOfStock.has(item)) return reply(200, "NAK|E09|ITEM OUT OF STOCK");
        // idempotent on our reference, so retries never double-ship
        const existing = byOurRef.get(ourRef);
        if (existing) return reply(200, `ACK|${existing}`);
        const ref = `FUL${String(++seq).padStart(7, "0")}`;
        byRef.set(ref, { ref, account, ourRef, item, qty, receivedAt: now() });
        byOurRef.set(ourRef, ref);
        reply(200, `ACK|${ref}`);
      });
      return;
    }

    reply(404, "NAK|E00|NO SUCH PROGRAM");
  });
}

export async function startLegacyServer(port = 0, opts: LegacyOptions = {}): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createLegacyServer(opts);
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
