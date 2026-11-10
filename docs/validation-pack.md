# handler: Validation Pack

| | |
|---|---|
| System | handler 0.1.0: AI assistant for pharma materials fulfillment |
| Document | VP-001 rev A, 2026-11-09 |
| Approach | Risk-based, GAMP 5 (2nd ed.) Category 5 (custom application) |
| Regulatory scope | 21 CFR Part 11 (electronic records and signatures); EU GMP Annex 11 principles |
| Status | Demonstration system with fictional clients. Not released for GxP use; see §5 for open gaps. |

## 1. Intended use

Agency staff ask, in plain English, for a client's approved promotional or patient-support material, and draft fulfillment orders for it. The AI drafts; a named person approves; only approved orders reach the legacy warehouse system. The AI never gives medical advice and never ships anything on its own.

**GxP-relevant records:** orders (with e-signature), audit trail, request log. Materials are read-only inputs owned by each client's review process.

## 2. System boundary

```
React UI ─► API (scope from identity) ─► Agent loop ─► MCP client ═► MCP server (scope bound at construction)
                                                                        │ search_materials / create_order / order_status
                                                                        ▼
                                  Postgres (Supabase): RLS ▸ app.current_materials ▸ order rules ▸ hash-chained audit_log
                                                                        │ approved orders only
                                                                        ▼
                                                    Legacy order system (pipe-delimited, via adapter)
```

Controls sit **in the database**, below the model. The model can be wrong; the data it is able to reach and the records it is able to change are bounded regardless.

## 3. Requirements, risks and verification

Severity: **H**: patient/compliance impact or cross-client disclosure. **M**: incorrect fulfillment. Every row is verified automatically in CI on each commit (`npm test`, `npm run eval`).

| ID | Requirement | Risk if it fails | Sev | Control | Verified by |
|---|---|---|---|---|---|
| UR-01 | A user sees only their client's data | Cross-client disclosure | H | RLS on every tenant table (`FORCE`), tenant from JWT `app_metadata`; composite FKs `(id, client_id)`; no tool accepts a client parameter | `rls.test.ts` (9 cases), `mcp.test.ts` "no tenant parameter"; eval gate **Cross-client leaks = 0** over 45 attempts incl. prompt-injection and SQL-like strings |
| UR-02 | Only approved, current material is cited or ordered | Off-label / expired material distributed | H | `app.current_materials` view: approved, unexpired, latest approved-or-withdrawn version. Search reads only this view | `retrieval.test.ts` (superseded, expired, draft, withdrawn); eval gate **Stale results = 0** over 10 probes |
| UR-03 | Currency is re-checked when an order is approved | Material expires between drafting and approval | H | `enforce_order_rules` trigger re-queries the view on `pending_approval → approved` | `orders.test.ts` "re-checks currency at approval" |
| UR-04 | No order reaches the warehouse without a human signature | Unreviewed shipment | H | AI can only insert `pending_approval`; state machine trigger; legacy call only after a committed signature | `orders.test.ts` "blocks skipping approval"; agent eval "order left pending_approval" check |
| UR-05 | Signatures show printed name, date/time, meaning (11.50) and cannot be altered (11.70) | Repudiable approval | H | `decided_by`, `decided_at`, `approval_meaning`, `approval_reason`; trigger makes them immutable once signed | `orders.test.ts` "rewriting a signature"; `audit.test.ts` signer in trail |
| UR-06 | Secure, computer-generated, time-stamped audit trail that cannot be altered or deleted (11.10(e)) | Undetectable record changes | H | Append-only `audit_log`; UPDATE/DELETE/TRUNCATE rejected by trigger, not granted; per-client SHA-256 hash chain; order changes audited by DB trigger | `audit.test.ts`: lifecycle captured, mutation blocked even for owner, **tamper by superuser detected** |
| UR-07 | Answers are accurate and cite their source | Wrong material sent | M | Retrieval over approved set; prompt requires `[JOB-CODE vN]` citations; tool results treated as data | Eval gates **top-1 ≥ 85%, top-3 ≥ 95%**; agent eval: citations must be current and own-client |
| UR-08 | Orders respect per-material quantity limits | Over-shipment | M | `max_order_qty` enforced in app and trigger | `orders.test.ts` "quantity cap" |
| UR-09 | Legacy integration cannot be corrupted by input | Wrong item/address shipped | M | Zod rejects `|` and newlines; adapter double-checks; legacy is idempotent on our reference | `orders.test.ts` "corrupt the pipe-delimited record" |
| UR-11 | Company oversight across clients never widens what the AI, or any writer, can reach | Cross-client disclosure through the oversight path; unsigned changes | H | `ops` claim (no `client_id`) adds read-only policies on orders, audit and request logs only; no ops policy on documents or chunks; every write policy requires a client; MCP server refuses to start without a single-client scope; chat rejects the ops identity | `ops.test.ts` (8 cases): sees all clients' orders/audit/logs, sees **0** materials, cannot draft/sign/write audit, ops+client claim is not ops, MCP and chat refuse it. Mutation: adding ops policies on documents/chunks turns the test red |
| UR-10 | Each AI request is traceable to prompt version, model, tokens, cost, latency | Unexplained behaviour change | M | `request_log` row per request; `PROMPT_VERSION` = file + content hash | `agent.test.ts` "logs tokens, cost, latency and prompt version" |

**Evidence that the gates can fail:** removing the expiry filter from `app.current_materials` turned the stale gate red (4 violations). Replacing the `documents` and `chunks` policies with `using (true)` turned the leak gate red (240 leaked rows). Replacing only the `chunks` policy produced no leak, because the join through `documents` still enforced isolation. That confirms defence in depth.

## 4. Part 11 mapping (summary)

| Clause | How addressed |
|---|---|
| 11.10(a) validation | This pack; automated tests and eval gates in CI on every commit |
| 11.10(b) accurate copies | Audit and orders exposed read-only via API/UI; JSON export via API |
| 11.10(c) record protection | Postgres; append-only audit; no delete grants on GxP records |
| 11.10(d) limited access | Supabase Auth + RLS per client; least-privilege grants (`authenticated` cannot modify materials) |
| 11.10(e) audit trail | UR-06 |
| 11.10(f) operational checks | Order state machine and currency re-check enforced by triggers |
| 11.10(g) authority checks | Only a signed-in user can sign; *role-based approver authority is a gap (G3)* |
| 11.50 / 11.70 | UR-05; signature stored on the record it signs |
| 11.100 / 11.200 | *Gap: demo identity, no re-authentication at signing (G1, G2)* |

## 5. Known gaps and limitations (must close before GxP use)

| # | Gap | Proposed closure |
|---|---|---|
| G1 | **Demo identity.** The UI switcher sends client and user headers. | Replace `identify()` in `src/api.ts` with Supabase JWT verification. Tenant is taken from `app_metadata.client_id`, which only the service role can set. Nothing downstream changes. |
| G2 | **No re-authentication at signing** (11.200(a)(1)). | Require password or MFA re-entry in the signing dialog through Supabase reauthenticate before `decideOrder`. |
| G3 | **No approver role.** Any user of the client can sign. | Add `app_metadata.roles` and require `approver` in the `orders_update_own` policy. |
| G4 | **Ops reads are not audited.** The operations view reads across clients without writing an audit entry. Part 11 does not require read logging, but cross-client access may warrant it. | Log ops sessions to a separate company-level access log (not a client's chain). |
| R4 | **Role switching runs on a privileged connection.** `SET LOCAL ROLE authenticated` is checked against the session user, so it protects against query bugs, not arbitrary SQL. A test documents this (`rls.test.ts`, KNOWN LIMITATION). The model has no SQL tool and all SQL is parameterised. | In production, connect as a login role that is only a member of `authenticated` (as Supabase's `authenticator` is), or call PostgREST with the user's JWT. |
| R5 | **Superusers can disable triggers.** | The hash chain detects it (tested). Schedule `app.verify_audit_chain` daily and alert on a non-null result. Restrict superuser access through change control. |
| R6 | **LLM output is non-deterministic.** | Database controls (UR-01 to UR-06) do not depend on the model. Agent evals gate CI when `META_API_KEY` is configured. Pin model and prompt version in the release record. |
| R7 | **CI uses a hashing embedder.** | It is deterministic and needs no network. For production retrieval, set `VOYAGE_API_KEY` and re-run `npm run eval`; vectors are tagged with their model, so mixed vectors are never compared. |
| R8 | **Client content is sent to a third-party model provider** (Meta Model API, `muse-spark-1.3`, standard mode). Search results, including approved material text and ship-to names, leave the system on every chat turn. | Before GxP or production use: supplier assessment of Meta (data retention, training use, region, subprocessors) and a client data-processing agreement. Do not use the `-contributor` model IDs until their data terms are reviewed. `pricing.ts` deliberately omits them. |

## 6. Change control

A change to the prompt, model, embedder, migrations or eval dataset requires a passing CI run. The eval report (`evals/results/latest.json`) records dataset version, embedder, model and prompt hash, and is archived with the release. Thresholds live in `evals/dataset.json` and may only be lowered through a documented deviation.

**Change record, 2026-11-09:** model provider changed from Anthropic (`claude-opus-5-5`) to Meta (`muse-spark-1.3`). Eval dataset `2026-11-09.2`: `draft-order` now includes the user's confirmation turn (the `create_order` tool description requires the model to confirm before drafting), and the grader no longer counts a bare repeat of a job code the user typed as a citation. Bracketed or versioned citations, and any other client's codes, are still checked. Thresholds unchanged. Result: all gates pass, agent 6/6.
