// Eval suite. Deterministic sections always run (and gate CI); the agent section runs end to end
// against the Meta model when META_API_KEY is set, or is reported as skipped.
//   npm run eval            deterministic + agent (if key present)
//   npm run eval -- --no-llm
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MODEL, PROMPT_VERSION, runChat } from "../src/agent.js";
import { openDb, withScope, type Scope } from "../src/db.js";
import { startLegacyServer } from "../src/legacy/server.js";
import { searchMaterials, type MaterialHit } from "../src/materials.js";
import { bootstrap, scopeFor } from "../src/runtime.js";

interface Dataset {
  version: string;
  thresholds: { retrieval_top1: number; retrieval_top3: number; leaks: number; stale_results: number; agent_pass_rate: number };
  retrieval: { client: string; query: string; expect: string }[];
  leak_attacks: { client: string; query: string }[];
  stale: { client: string; query: string; forbidden: string[]; why: string }[];
  agent: {
    id: string; client: string; prompt: string; followups?: string[];
    must_cite?: string[]; must_contain?: string[]; must_contain_any?: string[]; must_not_contain?: string[];
    expect_orders?: number; cite_only_current?: boolean;
  }[];
}

const here = path.dirname(fileURLToPath(import.meta.url));
const data = JSON.parse(readFileSync(path.join(here, "dataset.json"), "utf8")) as Dataset;
const useLlm = !process.argv.includes("--no-llm") && Boolean(process.env.META_API_KEY);

const legacy = await startLegacyServer(0, { stepMs: 1000 });
const rt = await bootstrap({ db: await openDb({ url: "" }), legacyUrl: legacy.url });
const clients = (await rt.db.query<{ slug: string; name: string }>("select slug, name from public.clients")).rows;
const scopes = new Map<string, { scope: Scope; name: string }>();
for (const c of clients) scopes.set(c.slug, { scope: (await scopeFor(rt.db, c.slug, `eval@${c.slug}`)).scope, name: c.name });

// Ground truth, read as the owner (bypassing RLS): every client's current job codes, and every job code that exists.
const truth = (await rt.db.query<{ slug: string; job_code: string; version: number }>(
  "select c.slug, m.job_code, m.version from app.current_materials m join public.clients c on c.id = m.client_id",
)).rows;
const currentOf = (slug: string) => new Set(truth.filter((t) => t.slug === slug).map((t) => `${t.job_code} v${t.version}`));
const ownCodes = (slug: string) => new Set(truth.filter((t) => t.slug === slug).map((t) => t.job_code));
const allCodes = new Set((await rt.db.query<{ job_code: string }>("select distinct job_code from public.documents")).rows.map((r) => r.job_code));

const search = (slug: string, q: string, limit = 5) =>
  withScope(rt.db, scopes.get(slug)!.scope, (tx) => searchMaterials(tx, rt.embedder, q, limit));

const failures: string[] = [];

// 1. Retrieval accuracy
let top1 = 0;
let top3 = 0;
for (const c of data.retrieval) {
  const hits = await search(c.client, c.query, 3);
  if (hits[0]?.job_code === c.expect) top1++;
  if (hits.some((h) => h.job_code === c.expect)) top3++;
  else failures.push(`retrieval miss [${c.client}] "${c.query}" -> ${hits.map((h) => h.job_code).join(", ") || "nothing"} (expected ${c.expect})`);
}
const top1Rate = top1 / data.retrieval.length;
const top3Rate = top3 / data.retrieval.length;

// 2. Leak attempts: the curated attacks, plus every client's queries replayed under every other client
const leakQueries = [
  ...data.leak_attacks,
  ...data.retrieval.flatMap((r) => clients.filter((c) => c.slug !== r.client).map((c) => ({ client: c.slug, query: r.query }))),
];
let leaks = 0;
for (const a of leakQueries) {
  const own = ownCodes(a.client);
  const foreign = (await search(a.client, a.query, 10)).filter((h: MaterialHit) => !own.has(h.job_code));
  if (foreign.length) {
    leaks += foreign.length;
    failures.push(`LEAK [${a.client}] "${a.query}" -> ${foreign.map((h) => h.job_code).join(", ")}`);
  }
}

// 3. Stale material: superseded, expired, draft and withdrawn versions must never be returned
let stale = 0;
for (const s of data.stale) {
  const returned = (await search(s.client, s.query, 10)).map((h) => `${h.job_code} v${h.version}`);
  const bad = returned.filter((r) => s.forbidden.includes(r));
  if (bad.length) {
    stale += bad.length;
    failures.push(`STALE [${s.client}] "${s.query}" returned ${bad.join(", ")} (${s.why})`);
  }
}

// 4. Agent end to end (Meta model + MCP + database)
const agentResults: { id: string; pass: boolean; problems: string[]; cost_usd: number; latency_ms: number }[] = [];
if (useLlm) {
  for (const c of data.agent) {
    const { scope, name } = scopes.get(c.client)!;
    const before = await withScope(rt.db, scope, (tx) => tx.query<{ n: number }>("select count(*)::int as n from public.orders"));
    // Optional follow-up turns (e.g. the user confirming an order the model read back to them).
    const history: { role: "user" | "assistant"; content: string }[] = [{ role: "user", content: c.prompt }];
    const replies: string[] = [];
    let cost = 0;
    let latency = 0;
    for (const next of [null, ...(c.followups ?? [])]) {
      if (next) history.push({ role: "user", content: next });
      const r = await runChat(rt, scope, name, history);
      cost += r.metrics.cost_usd;
      latency += r.metrics.latency_ms;
      replies.push(r.reply);
      history.push({ role: "assistant", content: r.reply });
    }
    const after = await withScope(rt.db, scope, (tx) =>
      tx.query<{ n: number; non_pending: number }>(
        "select count(*)::int as n, count(*) filter (where status <> 'pending_approval')::int as non_pending from public.orders",
      ),
    );
    const reply = replies.join("\n\n");
    const problems: string[] = [];
    const userText = history.filter((h) => h.role === "user").map((h) => h.content).join("\n");
    const cited = [...reply.matchAll(/(\[)?\b([A-Z]{3}-[A-Z]{3}-\d{4})(?:\s*v(\d+))?/g)];
    const current = currentOf(c.client);
    for (const [, bracket, code, v] of cited) {
      // Repeating a code the user typed (no version, not in citation brackets) is not citing it.
      if (!bracket && !v && userText.includes(code)) continue;
      if (!ownCodes(c.client).has(code)) problems.push(allCodes.has(code) ? `cited non-current or foreign ${code}` : `cited nonexistent ${code}`);
      else if (v && !current.has(`${code} v${v}`)) problems.push(`cited stale version ${code} v${v}`);
    }
    for (const code of c.must_cite ?? []) if (!reply.includes(code)) problems.push(`missing citation ${code}`);
    for (const s of c.must_contain ?? []) if (!reply.includes(s)) problems.push(`missing "${s}"`);
    if (c.must_contain_any && !c.must_contain_any.some((s) => reply.toLowerCase().includes(s.toLowerCase()))) problems.push(`missing any of ${c.must_contain_any.join("/")}`);
    for (const s of c.must_not_contain ?? []) if (reply.includes(s)) problems.push(`contains forbidden "${s}"`);
    const created = after.rows[0].n - before.rows[0].n;
    if (c.expect_orders != null && created !== c.expect_orders) problems.push(`created ${created} orders, expected ${c.expect_orders}`);
    if (after.rows[0].non_pending > 0) problems.push("an order left pending_approval without a human");
    agentResults.push({ id: c.id, pass: problems.length === 0, problems, cost_usd: cost, latency_ms: latency });
    if (problems.length) failures.push(`AGENT ${c.id}: ${problems.join("; ")}\n    reply: ${reply.replace(/\n/g, " ").slice(0, 300)}`);
  }
}
const agentPass = agentResults.filter((a) => a.pass).length;
const agentRate = agentResults.length ? agentPass / agentResults.length : null;

const t = data.thresholds;
const gates = [
  { name: "Retrieval top-1 accuracy", value: top1Rate, ok: top1Rate >= t.retrieval_top1, shown: `${(top1Rate * 100).toFixed(1)}% (${top1}/${data.retrieval.length})`, need: `>= ${t.retrieval_top1 * 100}%` },
  { name: "Retrieval top-3 accuracy", value: top3Rate, ok: top3Rate >= t.retrieval_top3, shown: `${(top3Rate * 100).toFixed(1)}% (${top3}/${data.retrieval.length})`, need: `>= ${t.retrieval_top3 * 100}%` },
  { name: "Cross-client leaks", value: leaks, ok: leaks <= t.leaks, shown: `${leaks} in ${leakQueries.length} attempts`, need: `${t.leaks}` },
  { name: "Stale/unapproved results", value: stale, ok: stale <= t.stale_results, shown: `${stale} in ${data.stale.length} probes`, need: `${t.stale_results}` },
  agentRate == null
    ? { name: "Agent end-to-end", value: null, ok: true, shown: "skipped (no META_API_KEY)", need: `>= ${t.agent_pass_rate * 100}%` }
    : { name: "Agent end-to-end", value: agentRate, ok: agentRate >= t.agent_pass_rate, shown: `${(agentRate * 100).toFixed(0)}% (${agentPass}/${agentResults.length})`, need: `>= ${t.agent_pass_rate * 100}%` },
];
const passed = gates.every((g) => g.ok);

const report = {
  dataset_version: data.version,
  ran_at: new Date().toISOString(),
  embedder: rt.embedder.model,
  model: useLlm ? MODEL : null,
  prompt_version: PROMPT_VERSION,
  passed,
  gates,
  agent: agentResults,
  failures,
};
mkdirSync(path.join(here, "results"), { recursive: true });
writeFileSync(path.join(here, "results", "latest.json"), JSON.stringify(report, null, 2));

const md = [
  `## handler evals: ${passed ? "PASS" : "FAIL"}`,
  `dataset \`${data.version}\` · embedder \`${report.embedder}\` · prompt \`${PROMPT_VERSION}\`${useLlm ? ` · model \`${MODEL}\`` : ""}`,
  "",
  "| Gate | Result | Threshold | |",
  "|---|---|---|---|",
  ...gates.map((g) => `| ${g.name} | ${g.shown} | ${g.need} | ${g.ok ? "✅" : "❌"} |`),
  ...(failures.length ? ["", "<details><summary>Failures</summary>", "", "```", ...failures, "```", "</details>"] : []),
].join("\n");
console.log(md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");

await rt.db.close();
await legacy.close();
process.exit(passed ? 0 : 1);
