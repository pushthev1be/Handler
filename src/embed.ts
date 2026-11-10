export const EMBED_DIMS = 512;

export interface Embedder {
  /** Stored on every chunk; search only compares vectors from the same model. */
  model: string;
  embed(texts: string[], kind: "query" | "document"): Promise<number[][]>;
}

const STOPWORDS = new Set(
  "a an and are as at be by can do for from have how i is it me my of on or our please show the to we what which with you your".split(" "),
);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t && !STOPWORDS.has(t))
    .map((t) => (t.length > 4 && t.endsWith("s") ? t.slice(0, -1) : t));
}

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic feature-hashing embedder (unigrams + bigrams). No network, no key, identical
 * output on every machine — this is what the eval suite and CI run against.
 */
export const hashEmbedder: Embedder = {
  model: "hash-512-v1",
  async embed(texts) {
    return texts.map((text) => {
      const v = new Array<number>(EMBED_DIMS).fill(0);
      const t = tokens(text);
      const feats = [...t, ...t.slice(1).map((w, i) => `${t[i]}_${w}`)];
      for (const f of feats) {
        const h = fnv1a(f);
        v[h % EMBED_DIMS] += h & 0x80000000 ? -1 : 1;
      }
      const norm = Math.hypot(...v) || 1;
      return v.map((x) => x / norm);
    });
  },
};

export function voyageEmbedder(apiKey: string, model = "voyage-3.5-lite"): Embedder {
  return {
    model: `${model}-${EMBED_DIMS}`,
    async embed(texts, kind) {
      const res = await fetch("https://api.voyageai.com/v1/embeddings", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ input: texts, model, input_type: kind, output_dimension: EMBED_DIMS }),
      });
      if (!res.ok) throw new Error(`voyage embeddings failed: ${res.status} ${await res.text()}`);
      const json = (await res.json()) as { data: { embedding: number[]; index: number }[] };
      return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
    },
  };
}

export function defaultEmbedder(): Embedder {
  const key = process.env.VOYAGE_API_KEY;
  return key ? voyageEmbedder(key) : hashEmbedder;
}
