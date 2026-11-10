export interface Client { slug: string; name: string }
export interface Turn { role: "user" | "assistant"; content: string }
export interface ToolCall { name: string; input: unknown; is_error: boolean; output: string }
export interface Metrics {
  prompt_version: string; model: string; input_tokens: number; output_tokens: number;
  cache_read_tokens: number; cost_usd: number; latency_ms: number; stop_reason: string | null;
}
export interface ChatResult { request_id: string; reply: string; tool_calls: ToolCall[]; metrics: Metrics }
export interface ShipTo { name: string; line1: string; line2?: string; city: string; state: string; zip: string }
export interface Order {
  id: string; job_code: string; doc_version: number; quantity: number; ship_to: ShipTo; notes: string | null;
  status: "pending_approval" | "approved" | "submitted" | "rejected" | "failed";
  requested_by: string; decided_by: string | null; approval_meaning: string | null; approval_reason: string | null;
  decided_at: string | null; legacy_ref: string | null; created_at: string;
}
export interface AuditEntry {
  id: string; occurred_at: string; actor: string; action: string; entity: string; entity_id: string | null;
  details: Record<string, unknown>; hash: string;
}
export interface MetricsResponse {
  summary: { requests: number; cost_usd: number; tokens: number; p50_ms: number; p95_ms: number };
  requests: (Metrics & { created_at: string; request_id: string; tool_calls: { name: string }[] })[];
}

export function api(client: string, user: string) {
  const call = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`/api${path}`, {
      ...init,
      headers: { "content-type": "application/json", "x-handler-client": client, "x-handler-user": user, ...init?.headers },
    });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? res.statusText);
    return body as T;
  };
  return {
    chat: (messages: Turn[]) => call<ChatResult>("/chat", { method: "POST", body: JSON.stringify({ messages }) }),
    orders: () => call<Order[]>("/orders"),
    decide: (id: string, body: { decision: "approve" | "reject"; signer: string; meaning: string; reason?: string }) =>
      call<Order>(`/orders/${id}/decision`, { method: "POST", body: JSON.stringify(body) }),
    audit: () => call<{ broken_at: string | null; entries: AuditEntry[] }>("/audit"),
    metrics: () => call<MetricsResponse>("/metrics"),
  };
}

export interface OpsOverview {
  clients: {
    slug: string; name: string; pending: number; failed: number; submitted: number; requests: number;
    cost_usd: number; p95_ms: number; last_activity: string | null; chain_broken_at: string | null;
  }[];
  queue: (Pick<Order, "id" | "job_code" | "doc_version" | "quantity" | "ship_to" | "status" | "requested_by" | "created_at">
    & { client_slug: string; client_name: string })[];
  activity: (Pick<AuditEntry, "id" | "occurred_at" | "actor" | "action" | "entity" | "details"> & { client_slug: string; client_name: string })[];
  eval: { passed: boolean; ran_at: string; dataset_version: string; prompt_version: string; gates: { name: string; ok: boolean; shown: string }[] } | null;
}

/** Company-wide, read-only. Sends the ops role and no client, so nothing tenant-scoped (or AI) can use it. */
export async function opsOverview(user: string): Promise<OpsOverview> {
  const res = await fetch("/api/ops/overview", { headers: { "x-handler-role": "ops", "x-handler-user": user } });
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? res.statusText);
  return body;
}

export const listClients =(): Promise<Client[]> => fetch("/api/clients").then((r) => r.json());
