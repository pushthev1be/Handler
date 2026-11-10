import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withScope } from "../src/db.js";
import { searchMaterials } from "../src/materials.js";
import { fixture, type Fixture, type Slug } from "./fixtures.js";

let f: Fixture;
beforeAll(async () => (f = await fixture()));
afterAll(() => f.close());

const search = (slug: Slug, q: string, limit = 10) =>
  withScope(f.db, f.scopes[slug], (tx) => searchMaterials(tx, f.embedder, q, limit));

describe("compliant retrieval", () => {
  it("returns only the latest approved version", async () => {
    const hits = await search("northwind", "patient starter brochure");
    const brochure = hits.filter((h) => h.job_code === "NWT-ZEL-0101");
    expect(brochure).toHaveLength(1);
    expect(brochure[0].version).toBe(2);
    expect(brochure[0].excerpt).toContain("1-800-555-0199");
    expect(hits.some((h) => h.excerpt.includes("1-800-555-0101"))).toBe(false);
  });

  it("never returns expired material", async () => {
    const hits = await search("northwind", "copay savings card 2025 program");
    expect(hits.map((h) => h.job_code)).not.toContain("NWT-ZEL-0103");
  });

  it("never returns drafts", async () => {
    const hits = await search("northwind", "pen injection video card QR code");
    expect(hits.map((h) => h.job_code)).not.toContain("NWT-ZEL-0104");
  });

  it("a withdrawn latest version leaves nothing current, even though v1 was approved", async () => {
    const hits = await search("northwind", "travel kit insert flights cooler");
    expect(hits.map((h) => h.job_code)).not.toContain("NWT-ZEL-0105");
  });

  it("an exact job code for expired material returns nothing", async () => {
    const hits = await search("meridian", "MRX-CRD-3303");
    expect(hits.map((h) => h.job_code)).not.toContain("MRX-CRD-3303");
  });

  it("an exact job code for current material ranks first", async () => {
    const hits = await search("meridian", "need MRX-CRD-3304 please");
    expect(hits[0].job_code).toBe("MRX-CRD-3304");
  });

  it("another client's job code is invisible", async () => {
    const hits = await search("northwind", "HLC-OST-2202 Ostravel savings card");
    expect(hits.every((h) => h.job_code.startsWith("NWT-"))).toBe(true);
  });
});
