import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { api, listClients, opsOverview, type AuditEntry, type ChatResult, type Client, type MetricsResponse, type OpsOverview, type Order, type Turn } from "./api";

const ACCENTS: Record<string, string> = { northwind: "#2563eb", halcyon: "#0d9488", meridian: "#c2410c" };
const OPS_ACCENT = "#64748b";

type Message = Turn & { result?: ChatResult; error?: boolean };

export function App() {
  const [clients, setClients] = useState<Client[]>([]);
  const [client, setClient] = useState("");
  const [user, setUser] = useState("jordan@agency.example");
  const [tab, setTab] = useState<"orders" | "audit" | "metrics">("orders");
  const [view, setView] = useState<"account" | "ops">("account");
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    listClients().then((cs) => {
      setClients(cs);
      setClient((c) => c || cs[0]?.slug || "");
    });
  }, []);

  const http = useMemo(() => api(client, user), [client, user]);
  const current = clients.find((c) => c.slug === client);
  const bump = useCallback(() => setRefresh((n) => n + 1), []);

  return (
    <div className="app" style={{ ["--accent" as string]: view === "ops" ? OPS_ACCENT : ACCENTS[client] ?? "#4f46e5" }}>
      <header className="topbar">
        <div className="brand">
          <span className="logo">h</span>handler
        </div>
        <div className="segmented" role="tablist" aria-label="View">
          <button role="tab" aria-selected={view === "account"} className={view === "account" ? "active" : ""} onClick={() => setView("account")}>Account</button>
          <button role="tab" aria-selected={view === "ops"} className={view === "ops" ? "active" : ""} onClick={() => setView("ops")}>Operations</button>
        </div>
        {view === "account" && (
          <label className="field inline">
            <span>Client</span>
            <select value={client} onChange={(e) => setClient(e.target.value)}>
              {clients.map((c) => (
                <option key={c.slug} value={c.slug}>{c.name}</option>
              ))}
            </select>
          </label>
        )}
        <label className="field inline grow">
          <span>Signed in as</span>
          <input value={user} onChange={(e) => setUser(e.target.value)} />
        </label>
        {view === "account" ? (
          <span className="scope-badge" title="Every request runs under row-level security for this client only">
            Scoped to {current?.name ?? "…"}
          </span>
        ) : (
          <span className="scope-badge" title="Reads orders, audit and request logs across clients. Cannot see materials, use the AI, or sign.">
            All clients · read-only · no AI
          </span>
        )}
      </header>

      {view === "ops" && (
        <OpsView
          user={user}
          onOpen={(slug) => {
            setClient(slug);
            setTab("orders");
            setView("account");
          }}
        />
      )}

      {view === "account" && client && (
        <main className="layout">
          <Chat key={client} http={http} clientName={current?.name ?? client} onActivity={bump} />
          <section className="panel">
            <nav className="tabs">
              {(["orders", "audit", "metrics"] as const).map((t) => (
                <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
                  {{ orders: "Approvals", audit: "Audit trail", metrics: "Monitoring" }[t]}
                </button>
              ))}
            </nav>
            {tab === "orders" && <Orders key={client} http={http} user={user} refresh={refresh} onChange={bump} />}
            {tab === "audit" && <Audit key={client} http={http} refresh={refresh} />}
            {tab === "metrics" && <Monitoring key={client} http={http} refresh={refresh} />}
          </section>
        </main>
      )}
    </div>
  );
}

/** Renders [JOB-CODE vN] citations as badges. */
function withCitations(text: string): ReactNode[] {
  return text.split(/(\[[A-Z]{3}-[A-Z]{3}-\d{4}(?: v\d+)?\])/g).map((part, i) =>
    /^\[[A-Z]{3}-[A-Z]{3}-\d{4}/.test(part) ? <span key={i} className="cite">{part.slice(1, -1)}</span> : part,
  );
}

function Chat({ http, clientName, onActivity }: { http: ReturnType<typeof api>; clientName: string; onActivity: () => void }) {
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy]);

  async function send(e: FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    const next: Message[] = [...messages, { role: "user", content: text }];
    setMessages(next);
    setDraft("");
    setBusy(true);
    try {
      const result = await http.chat(next.filter((m) => !m.error).map(({ role, content }) => ({ role, content })));
      setMessages([...next, { role: "assistant", content: result.reply, result }]);
      onActivity();
    } catch (err) {
      setMessages([...next, { role: "assistant", content: (err as Error).message, error: true }]);
    } finally {
      setBusy(false);
    }
  }

  const examples = ["What patient brochures do we have?", "Is there a savings card I can order?", "Order 50 of the dosing guide to Dr Ana Ruiz, 100 Main St, Springfield IL 62701"];

  return (
    <section className="chat">
      <div className="messages">
        {messages.length === 0 && (
          <div className="empty">
            <h2>Ask about {clientName} materials</h2>
            <p>Answers cite only approved, current material. Conversations never carry over between clients.</p>
            <div className="examples">
              {examples.map((x) => (
                <button key={x} onClick={() => setDraft(x)}>{x}</button>
              ))}
            </div>
          </div>
        )}
        {messages.map((m, i) => (
          <div key={i} className={`msg ${m.role} ${m.error ? "error" : ""}`}>
            {m.result && m.result.tool_calls.length > 0 && (
              <div className="tools">
                {m.result.tool_calls.map((t, j) => (
                  <details key={j} className={t.is_error ? "tool err" : "tool"}>
                    <summary>{t.name}{t.is_error ? " (error)" : ""}</summary>
                    <pre>{JSON.stringify(t.input, null, 2)}</pre>
                    <pre>{t.output}</pre>
                  </details>
                ))}
              </div>
            )}
            <div className="bubble">{withCitations(m.content)}</div>
            {m.result && (
              <div className="meta">
                {m.result.metrics.model} · {m.result.metrics.prompt_version} · {m.result.metrics.input_tokens + m.result.metrics.output_tokens} tok · ${m.result.metrics.cost_usd.toFixed(4)} · {(m.result.metrics.latency_ms / 1000).toFixed(1)}s
              </div>
            )}
          </div>
        ))}
        {busy && <div className="msg assistant"><div className="bubble typing">Searching approved materials…</div></div>}
        <div ref={end} />
      </div>
      <form className="composer" onSubmit={send}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Ask for a material or place an order in plain English" />
        <button disabled={busy || !draft.trim()}>Send</button>
      </form>
    </section>
  );
}

const STATUS_LABEL: Record<Order["status"], string> = {
  pending_approval: "Awaiting approval", approved: "Approved", submitted: "Sent to warehouse", rejected: "Rejected", failed: "Warehouse rejected",
};

function Orders({ http, user, refresh, onChange }: { http: ReturnType<typeof api>; user: string; refresh: number; onChange: () => void }) {
  const [orders, setOrders] = useState<Order[]>([]);
  const [signing, setSigning] = useState<{ order: Order; decision: "approve" | "reject" } | null>(null);
  useEffect(() => void http.orders().then(setOrders), [http, refresh]);

  return (
    <div className="panel-body">
      {orders.length === 0 && <p className="muted">No orders yet. Ask the assistant to draft one.</p>}
      {orders.map((o) => (
        <article key={o.id} className={`order ${o.status}`}>
          <div className="order-head">
            <span className="cite">{o.job_code} v{o.doc_version}</span>
            <span className={`status ${o.status}`}>{STATUS_LABEL[o.status]}</span>
          </div>
          <div className="order-body">
            <strong>{o.quantity}</strong> to {o.ship_to.name}, {o.ship_to.line1}, {o.ship_to.city} {o.ship_to.state} {o.ship_to.zip}
            {o.notes && <div className="muted">{o.notes}</div>}
          </div>
          <div className="order-foot muted">
            Drafted by {o.requested_by} · {new Date(o.created_at).toLocaleString()}
            {o.decided_by && <> · {o.approval_meaning} by <strong>{o.decided_by}</strong> {new Date(o.decided_at!).toLocaleString()}</>}
            {o.legacy_ref && <> · warehouse ref {o.legacy_ref}</>}
          </div>
          {o.status === "pending_approval" && (
            <div className="actions">
              <button className="primary" onClick={() => setSigning({ order: o, decision: "approve" })}>Approve…</button>
              <button onClick={() => setSigning({ order: o, decision: "reject" })}>Reject…</button>
            </div>
          )}
        </article>
      ))}
      {signing && (
        <SignDialog
          {...signing}
          user={user}
          onClose={() => setSigning(null)}
          onSign={async (body) => {
            await http.decide(signing.order.id, body);
            setSigning(null);
            onChange();
          }}
        />
      )}
    </div>
  );
}

function SignDialog({ order, decision, user, onClose, onSign }: {
  order: Order; decision: "approve" | "reject"; user: string; onClose: () => void;
  onSign: (b: { decision: "approve" | "reject"; signer: string; meaning: string; reason?: string }) => Promise<void>;
}) {
  const [signer, setSigner] = useState("");
  const [reason, setReason] = useState("");
  const [attest, setAttest] = useState(false);
  const [error, setError] = useState("");
  const meaning = decision === "approve" ? "Approved for fulfillment" : "Rejected for fulfillment";

  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        onClick={(e) => e.stopPropagation()}
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await onSign({ decision, signer, meaning, reason: reason || undefined });
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <h3>{decision === "approve" ? "Approve and send to warehouse" : "Reject order"}</h3>
        <p className="muted">
          {order.quantity} × {order.job_code} v{order.doc_version} to {order.ship_to.name}. Material currency is re-checked by the database when you sign.
        </p>
        <label className="field"><span>Printed name</span><input required value={signer} onChange={(e) => setSigner(e.target.value)} placeholder="Full name" /></label>
        <label className="field"><span>Meaning of signature</span><input value={meaning} readOnly /></label>
        <label className="field"><span>Reason {decision === "reject" ? "" : "(optional)"}</span><textarea required={decision === "reject"} value={reason} onChange={(e) => setReason(e.target.value)} /></label>
        <label className="check">
          <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} />
          I, signed in as {user}, intend this as my electronic signature.
        </label>
        {error && <p className="error-text">{error}</p>}
        <div className="actions">
          <button type="button" onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!attest || signer.trim().length < 2}>Sign</button>
        </div>
      </form>
    </div>
  );
}

function Audit({ http, refresh }: { http: ReturnType<typeof api>; refresh: number }) {
  const [data, setData] = useState<{ broken_at: string | null; entries: AuditEntry[] } | null>(null);
  useEffect(() => void http.audit().then(setData), [http, refresh]);
  if (!data) return <div className="panel-body muted">Loading…</div>;
  return (
    <div className="panel-body">
      <div className={`chain ${data.broken_at ? "bad" : "ok"}`}>
        {data.broken_at ? `Hash chain broken at entry ${data.broken_at}` : `Hash chain verified · ${data.entries.length} most recent entries`}
      </div>
      <table className="grid">
        <thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Detail</th><th>Hash</th></tr></thead>
        <tbody>
          {data.entries.map((e) => (
            <tr key={e.id}>
              <td>{new Date(e.occurred_at).toLocaleTimeString()}</td>
              <td>{e.actor}</td>
              <td><code>{e.action}</code></td>
              <td className="detail">{summarise(e)}</td>
              <td><code title={e.hash}>{e.hash.slice(0, 8)}</code></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function summarise(e: AuditEntry): string {
  const d = e.details as Record<string, unknown>;
  if (e.action === "materials.searched") return `"${d.query}" → ${(d.results as string[]).join(", ") || "no results"}`;
  if (e.entity === "order") return `${d.quantity} × ${d.job_code} v${d.doc_version}${d.decided_by ? ` · ${d.decided_by}` : ""}${d.legacy_ref ? ` · ${d.legacy_ref}` : ""}`;
  if (e.action === "assistant.responded") return `${d.model} · ${d.prompt_version} · tools: ${(d.tools as string[]).join(", ") || "none"}`;
  return JSON.stringify(d);
}

function Monitoring({ http, refresh }: { http: ReturnType<typeof api>; refresh: number }) {
  const [data, setData] = useState<MetricsResponse | null>(null);
  useEffect(() => void http.metrics().then(setData), [http, refresh]);
  if (!data) return <div className="panel-body muted">Loading…</div>;
  const s = data.summary;
  return (
    <div className="panel-body">
      <div className="stats">
        <Stat label="Requests" value={String(s.requests)} />
        <Stat label="Total cost" value={`$${s.cost_usd.toFixed(4)}`} />
        <Stat label="Tokens" value={s.tokens.toLocaleString()} />
        <Stat label="p50 / p95" value={`${(s.p50_ms / 1000).toFixed(1)}s / ${(s.p95_ms / 1000).toFixed(1)}s`} />
      </div>
      <table className="grid">
        <thead><tr><th>When</th><th>Prompt</th><th>Model</th><th>In / out</th><th>Cost</th><th>Latency</th><th>Tools</th></tr></thead>
        <tbody>
          {data.requests.map((r) => (
            <tr key={r.request_id}>
              <td>{new Date(r.created_at).toLocaleTimeString()}</td>
              <td><code>{r.prompt_version}</code></td>
              <td>{r.model}</td>
              <td>{r.input_tokens} / {r.output_tokens}</td>
              <td>${r.cost_usd.toFixed(4)}</td>
              <td>{(r.latency_ms / 1000).toFixed(1)}s</td>
              <td>{r.tool_calls.map((t) => t.name).join(", ") || "none"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const age = (iso: string) => {
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 60 ? `${m}m` : m < 1440 ? `${Math.round(m / 60)}h` : `${Math.round(m / 1440)}d`;
};

/** Company-wide, read-only. Approvals still happen in each client's account view. */
function OpsView({ user, onOpen }: { user: string; onOpen: (slug: string) => void }) {
  const [data, setData] = useState<OpsOverview | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const load = () => opsOverview(user).then(setData, (e: Error) => setError(e.message));
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [user]);
  if (error) return <main className="ops"><p className="error-text">{error}</p></main>;
  if (!data) return <main className="ops muted">Loading…</main>;

  const totals = data.clients.reduce(
    (a, c) => ({ pending: a.pending + c.pending, failed: a.failed + c.failed, cost: a.cost + c.cost_usd, broken: a.broken + (c.chain_broken_at ? 1 : 0) }),
    { pending: 0, failed: 0, cost: 0, broken: 0 },
  );

  return (
    <main className="ops">
      <div className="stats">
        <Stat label="Awaiting approval" value={String(totals.pending)} />
        <Stat label="Warehouse rejected" value={String(totals.failed)} />
        <Stat label="Audit chains" value={totals.broken ? `${totals.broken} broken` : `${data.clients.length} verified`} />
        <Stat label="AI spend, all clients" value={`$${totals.cost.toFixed(4)}`} />
      </div>

      <section className="panel">
        <h3 className="panel-title">Clients</h3>
        <div className="table-wrap">
          <table className="grid">
            <thead><tr><th>Client</th><th>Awaiting</th><th>Failed</th><th>Sent</th><th>Audit chain</th><th>AI requests</th><th>Spend</th><th>p95</th><th>Last activity</th><th /></tr></thead>
            <tbody>
              {data.clients.map((c) => (
                <tr key={c.slug}>
                  <td><span className="dot" style={{ background: ACCENTS[c.slug] }} />{c.name}</td>
                  <td className={c.pending ? "warn" : ""}>{c.pending}</td>
                  <td className={c.failed ? "bad" : ""}>{c.failed}</td>
                  <td>{c.submitted}</td>
                  <td className={c.chain_broken_at ? "bad" : "ok"}>{c.chain_broken_at ? `Broken at ${c.chain_broken_at}` : "Verified"}</td>
                  <td>{c.requests}</td>
                  <td>${c.cost_usd.toFixed(4)}</td>
                  <td>{(c.p95_ms / 1000).toFixed(1)}s</td>
                  <td>{c.last_activity ? `${age(c.last_activity)} ago` : "never"}</td>
                  <td><button onClick={() => onOpen(c.slug)}>Open</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="ops-cols">
        <section className="panel">
          <h3 className="panel-title">Needs a person <span className="muted">· sign in the client's account view</span></h3>
          <div className="panel-body">
            {data.queue.length === 0 && <p className="muted">Nothing waiting.</p>}
            {data.queue.map((o) => (
              <article key={o.id} className={`order ${o.status}`}>
                <div className="order-head">
                  <span><span className="dot" style={{ background: ACCENTS[o.client_slug] }} />{o.client_name}</span>
                  <span className={`status ${o.status}`}>{STATUS_LABEL[o.status]} · {age(o.created_at)}</span>
                </div>
                <div className="order-body">
                  <span className="cite" style={{ ["--accent" as string]: ACCENTS[o.client_slug] }}>{o.job_code} v{o.doc_version}</span>{" "}
                  <strong>{o.quantity}</strong> to {o.ship_to.name}, {o.ship_to.city} {o.ship_to.state}
                </div>
                <div className="actions">
                  <span className="muted order-foot">Drafted by {o.requested_by}</span>
                  <button onClick={() => onOpen(o.client_slug)}>Open {o.client_name}</button>
                </div>
              </article>
            ))}
          </div>
        </section>

        <div className="ops-side">
          <section className="panel">
            <h3 className="panel-title">Last eval run</h3>
            <div className="panel-body">
              {!data.eval ? (
                <p className="muted">No eval results on this server. Run <code>npm run eval</code>.</p>
              ) : (
                <>
                  <div className={`chain ${data.eval.passed ? "ok" : "bad"}`}>
                    {data.eval.passed ? "All gates passed" : "Gates failing"} · {new Date(data.eval.ran_at).toLocaleString()}
                  </div>
                  <table className="grid">
                    <tbody>
                      {data.eval.gates.map((g) => (
                        <tr key={g.name}><td>{g.ok ? "✓" : "✗"} {g.name}</td><td>{g.shown}</td></tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="meta">dataset {data.eval.dataset_version} · {data.eval.prompt_version}</p>
                </>
              )}
            </div>
          </section>

          <section className="panel">
            <h3 className="panel-title">Recent activity</h3>
            <div className="panel-body">
              <table className="grid">
                <tbody>
                  {data.activity.map((e) => (
                    <tr key={`${e.client_slug}-${e.id}`}>
                      <td>{age(e.occurred_at)}</td>
                      <td><span className="dot" style={{ background: ACCENTS[e.client_slug] }} />{e.client_name}</td>
                      <td><code>{e.action}</code></td>
                      <td>{e.actor}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="stat"><span>{label}</span><strong>{value}</strong></div>;
}
