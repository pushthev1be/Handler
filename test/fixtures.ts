import { openDb, type Scope } from "../src/db.js";
import { hashEmbedder } from "../src/embed.js";
import { startLegacyServer, type LegacyOptions } from "../src/legacy/server.js";
import { bootstrap, scopeFor, type Runtime } from "../src/runtime.js";

export type Slug = "northwind" | "halcyon" | "meridian";
export const SLUGS: Slug[] = ["northwind", "halcyon", "meridian"];

export interface Fixture extends Runtime {
  scopes: Record<Slug, Scope>;
  close(): Promise<void>;
}

/** Fresh in-memory database with real migrations, seeded catalogue, and a live mock legacy server. */
export async function fixture(legacyOpts: LegacyOptions = {}): Promise<Fixture> {
  const legacy = await startLegacyServer(0, legacyOpts);
  const db = await openDb({ url: "", dataDir: undefined });
  const rt = await bootstrap({ db, embedder: hashEmbedder, legacyUrl: legacy.url });
  const scopes = {} as Record<Slug, Scope>;
  for (const slug of SLUGS) scopes[slug] = (await scopeFor(db, slug, `tester@${slug}`)).scope;
  return {
    ...rt,
    scopes,
    async close() {
      await db.close();
      await legacy.close();
    },
  };
}

export const shipTo = { name: "Dr Ana Ruiz", line1: "100 Main St", city: "Springfield", state: "IL", zip: "62701" };
