import { clientBySlug, openDb, type Db } from "./db.js";
import { defaultEmbedder, type Embedder } from "./embed.js";
import { legacyClient, type LegacyClient } from "./legacy/client.js";
import { seed, seedInventory } from "./seed.js";

export interface Runtime {
  db: Db;
  embedder: Embedder;
  legacy: LegacyClient;
}

/** Opens the database, seeds the fictional catalogue if empty, and wires the legacy adapter. */
export async function bootstrap(opts: { legacyUrl?: string; db?: Db; embedder?: Embedder } = {}): Promise<Runtime> {
  const db = opts.db ?? (await openDb());
  const embedder = opts.embedder ?? defaultEmbedder();
  const { rows } = await db.query<{ n: number }>(
    "select count(*)::int as n from public.chunks where embedding_model = $1",
    [embedder.model],
  );
  if (rows[0].n === 0) await seed(db, embedder);
  await seedInventory(db);
  const legacy = legacyClient(opts.legacyUrl ?? process.env.LEGACY_URL ?? "http://127.0.0.1:7070");
  return { db, embedder, legacy };
}

export async function scopeFor(db: Db, slug: string, actor: string) {
  const client = await clientBySlug(db, slug);
  return { client, scope: { clientId: client.id, actor } };
}
