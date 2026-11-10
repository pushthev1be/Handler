import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Queryable } from "./db.js";

const latestEval = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "evals", "results", "latest.json");

export interface ClientHealth {
  slug: string;
  name: string;
  pending: number;
  failed: number;
  submitted: number;
  requests: number;
  cost_usd: number;
  p95_ms: number;
  last_activity: string | null;
  chain_broken_at: string | null;
}

/** One row per client. Run inside withOps; under a client scope it returns only that client. */
export async function clientHealth(tx: Queryable): Promise<ClientHealth[]> {
  const { rows } = await tx.query<ClientHealth>(
    `select c.slug, c.name,
            coalesce(o.pending, 0) as pending, coalesce(o.failed, 0) as failed, coalesce(o.submitted, 0) as submitted,
            coalesce(r.requests, 0) as requests, coalesce(r.cost_usd, 0) as cost_usd, coalesce(r.p95_ms, 0) as p95_ms,
            a.last_activity, app.verify_audit_chain(c.id)::text as chain_broken_at
       from public.clients c
       left join lateral (
         select count(*) filter (where status = 'pending_approval')::int as pending,
                count(*) filter (where status = 'failed')::int as failed,
                count(*) filter (where status = 'submitted')::int as submitted
           from public.orders where client_id = c.id
       ) o on true
       left join lateral (
         select count(*)::int as requests, sum(cost_usd)::float8 as cost_usd,
                (percentile_cont(0.95) within group (order by latency_ms))::int as p95_ms
           from public.request_log where client_id = c.id
       ) r on true
       left join lateral (
         select max(occurred_at) as last_activity from public.audit_log where client_id = c.id
       ) a on true
      order by c.name`,
  );
  return rows;
}

/** Orders that need a person: awaiting approval or rejected by the warehouse, oldest first. */
export async function attentionQueue(tx: Queryable) {
  const { rows } = await tx.query(
    `select o.id, c.slug as client_slug, c.name as client_name, o.job_code, o.doc_version, o.quantity,
            o.ship_to, o.status, o.requested_by, o.created_at, o.decided_at
       from public.orders o join public.clients c on c.id = o.client_id
      where o.status in ('pending_approval', 'failed')
      order by o.created_at
      limit 100`,
  );
  return rows;
}

export async function recentActivity(tx: Queryable, limit = 30) {
  const { rows } = await tx.query(
    `select a.id, c.slug as client_slug, c.name as client_name, a.occurred_at, a.actor, a.action, a.entity, a.details
       from public.audit_log a join public.clients c on c.id = a.client_id
      order by a.occurred_at desc, a.id desc
      limit $1`,
    [limit],
  );
  return rows;
}

/** Summary of the last eval run on this machine, or null if none has been run. */
export function lastEval() {
  if (!existsSync(latestEval)) return null;
  const r = JSON.parse(readFileSync(latestEval, "utf8"));
  return {
    passed: r.passed as boolean,
    ran_at: r.ran_at as string,
    dataset_version: r.dataset_version as string,
    prompt_version: r.prompt_version as string,
    gates: (r.gates as { name: string; ok: boolean; shown: string }[]).map(({ name, ok, shown }) => ({ name, ok, shown })),
  };
}
