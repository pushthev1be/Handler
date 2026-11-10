import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import pg from "pg";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface Queryable {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface Db extends Queryable {
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  exec(sql: string): Promise<void>;
  close(): Promise<void>;
}

/** A tenant-scoped session. clientId is fixed at construction and never comes from the model. */
export interface Scope {
  clientId: string;
  actor: string;
}

function pgliteDb(dataDir?: string): Db {
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pglite = new PGlite({ dataDir, extensions: { vector } });
  return {
    query: (sql, params) => pglite.query(sql, params) as never,
    transaction: (fn) => pglite.transaction((tx) => fn({ query: (s, p) => tx.query(s, p) as never })),
    exec: async (sql) => void (await pglite.exec(sql)),
    close: () => pglite.close(),
  };
}

function postgresDb(connectionString: string): Db {
  const pool = new pg.Pool({ connectionString });
  return {
    query: (sql, params) => pool.query(sql, params as unknown[]) as never,
    async transaction(fn) {
      const conn = await pool.connect();
      try {
        await conn.query("begin");
        const result = await fn({ query: (s, p) => conn.query(s, p as unknown[]) as never });
        await conn.query("commit");
        return result;
      } catch (err) {
        await conn.query("rollback");
        throw err;
      } finally {
        conn.release();
      }
    },
    exec: async (sql) => void (await pool.query(sql)),
    close: () => pool.end(),
  };
}

/**
 * DATABASE_URL set  -> Postgres/Supabase (migrations applied with `supabase db push`).
 * otherwise         -> embedded PGlite; data persists in PGLITE_DIR, or memory if unset.
 */
export async function openDb(opts: { url?: string; dataDir?: string; migrate?: boolean } = {}): Promise<Db> {
  const url = opts.url ?? process.env.DATABASE_URL;
  if (url) return postgresDb(url);
  const db = pgliteDb(opts.dataDir ?? process.env.PGLITE_DIR);
  if (opts.migrate ?? true) await migrate(db);
  return db;
}

/** Applies Supabase's built-in roles (PGlite only) and then every migration in order. */
export async function migrate(db: Db): Promise<void> {
  await db.exec(`create table if not exists public._migrations (name text primary key, applied_at timestamptz default now())`);
  await db.exec(readFileSync(path.join(root, "db", "supabase-roles.sql"), "utf8"));
  const dir = path.join(root, "supabase", "migrations");
  const applied = new Set(
    (await db.query<{ name: string }>("select name from public._migrations")).rows.map((r) => r.name),
  );
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    if (applied.has(file)) continue;
    await db.exec(readFileSync(path.join(dir, file), "utf8"));
    await db.query("insert into public._migrations (name) values ($1)", [file]);
  }
}

/**
 * Runs fn as the `authenticated` role with JWT claims for one client — the same mechanism
 * PostgREST uses on Supabase — so every query inside is filtered by row-level security.
 */
export function withScope<T>(db: Db, scope: Scope, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: scope.actor, role: "authenticated", app_metadata: { client_id: scope.clientId } });
  return db.transaction(async (tx) => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    return fn(tx);
  });
}

/**
 * Runs fn as `authenticated` with the company-wide ops claim and no client. RLS then allows
 * reading orders, audit and request logs across clients, and nothing else (migration 000005).
 */
export function withOps<T>(db: Db, actor: string, fn: (tx: Queryable) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({ sub: actor, role: "authenticated", app_metadata: { role: "ops" } });
  return db.transaction(async (tx) => {
    await tx.query("set local role authenticated");
    await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
    return fn(tx);
  });
}

export async function clientBySlug(db: Db, slug: string): Promise<{ id: string; slug: string; name: string }> {
  const { rows } = await db.query<{ id: string; slug: string; name: string }>(
    "select id, slug, name from public.clients where slug = $1",
    [slug],
  );
  if (!rows[0]) throw new Error(`unknown client: ${slug}`);
  return rows[0];
}

export const toVector = (v: number[]) => `[${v.join(",")}]`;
