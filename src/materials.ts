import { toVector, type Queryable } from "./db.js";
import type { Embedder } from "./embed.js";

export interface MaterialHit {
  job_code: string;
  version: number;
  title: string;
  material_type: string;
  expires_at: string | null;
  max_order_qty: number;
  excerpt: string;
  score: number;
}

const JOB_CODE = /\b[A-Z]{3}-[A-Z]{3}-\d{4}\b/gi;

/**
 * Searches only app.current_materials, so drafts, expired, withdrawn and superseded versions
 * are unreachable here regardless of what the query says. tx must be a client-scoped
 * transaction (see withScope), so RLS limits results to that client.
 */
export async function searchMaterials(
  tx: Queryable,
  embedder: Embedder,
  query: string,
  limit = 5,
): Promise<MaterialHit[]> {
  const [qv] = await embedder.embed([query], "query");
  const exactCodes = [...new Set((query.match(JOB_CODE) ?? []).map((c) => c.toUpperCase()))];

  const { rows } = await tx.query<MaterialHit>(
    `with ranked as (
       select m.job_code, m.version, m.title, m.material_type, m.expires_at, m.max_order_qty,
              c.content as excerpt,
              case when m.job_code = any($4::text[]) then 1.0
                   else 1 - (c.embedding <=> $1::vector) end as score,
              row_number() over (partition by m.job_code
                                 order by c.embedding <=> $1::vector) as rn
         from public.chunks c
         join app.current_materials m on m.id = c.document_id
        where c.embedding_model = $2
     )
     select job_code, version, title, material_type, expires_at, max_order_qty, excerpt,
            round(score::numeric, 4)::float8 as score
       from ranked
      where rn = 1
      order by score desc
      limit $3`,
    [toVector(qv), embedder.model, limit, exactCodes],
  );
  return rows;
}

/** Explains why a job code is not orderable, without revealing anything outside the caller's tenant. */
export async function explainUnavailable(tx: Queryable, jobCode: string): Promise<string> {
  const { rows } = await tx.query<{ version: number; status: string; expires_at: string | null }>(
    `select version, status, expires_at from public.documents
      where job_code = $1 order by version desc limit 1`,
    [jobCode.toUpperCase()],
  );
  const d = rows[0];
  if (!d) return `No material with job code ${jobCode} exists for this client.`;
  if (d.status === "draft") return `${jobCode} v${d.version} is a draft and has not been approved.`;
  if (d.status === "withdrawn") return `${jobCode} v${d.version} was withdrawn by review and cannot be used.`;
  if (d.expires_at && new Date(d.expires_at) <= new Date()) return `${jobCode} v${d.version} expired on ${new Date(d.expires_at).toISOString().slice(0, 10)}.`;
  return `${jobCode} is not currently available.`;
}
