import { catalog, type SeedClient } from "../db/seed/catalog.js";
import { toVector, type Db } from "./db.js";
import type { Embedder } from "./embed.js";

const DAY = 86_400_000;

/** Splits on sentence boundaries into chunks of at most ~maxChars. */
export function chunkText(text: string, maxChars = 800): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  const chunks: string[] = [];
  let current = "";
  for (const s of sentences) {
    if (current && current.length + s.length > maxChars) {
      chunks.push(current.trim());
      current = "";
    }
    current += s;
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

/** Ingestion runs as the table owner (service role on Supabase): it is the only writer of materials. */
export async function seed(db: Db, embedder: Embedder, clients: SeedClient[] = catalog): Promise<void> {
  const now = Date.now();
  for (const c of clients) {
    const { rows } = await db.query<{ id: string }>(
      `insert into public.clients (slug, name, legacy_account) values ($1, $2, $3)
       on conflict (slug) do update set name = excluded.name returning id`,
      [c.slug, c.name, c.slug.slice(0, 3).toUpperCase() + "01"],
    );
    const clientId = rows[0].id;
    for (const d of c.docs) {
      const approvedAt = d.approved_days_ago == null ? null : new Date(now - d.approved_days_ago * DAY);
      const expiresAt = d.expires_in_days == null ? null : new Date(now + d.expires_in_days * DAY);
      const doc = await db.query<{ id: string }>(
        `insert into public.documents
           (client_id, job_code, version, title, material_type, status, approved_at, expires_at, max_order_qty, body)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         on conflict (client_id, job_code, version) do nothing returning id`,
        [clientId, d.job_code, d.version, d.title, d.material_type, d.status, approvedAt, expiresAt, d.max_order_qty ?? 250, d.body],
      );
      if (!doc.rows[0]) continue;
      const header = `${d.title} (${d.material_type}, ${c.product}).`;
      const pieces = chunkText(d.body).map((p) => `${header} ${p}`);
      const vectors = await embedder.embed(pieces, "document");
      for (const [i, content] of pieces.entries()) {
        await db.query(
          `insert into public.chunks (document_id, client_id, chunk_index, content, embedding, embedding_model)
           values ($1, $2, $3, $4, $5::vector, $6)`,
          [doc.rows[0].id, clientId, i, content, toVector(vectors[i]), embedder.model],
        );
      }
    }
  }
}
