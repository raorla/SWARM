/**
 * VECTOR STORE — recherche de similarité locale.
 *
 * Recherche exhaustive, pas d'index approximatif. À l'échelle du produit — quelques milliers
 * de vecteurs de dimension 256 — une recherche linéaire prend moins d'une milliseconde, et un
 * index HNSW ajouterait une dépendance WASM, un coût de construction et un mode de défaillance
 * (index désynchronisé du corpus) pour un gain nul. `hnswlib-wasm` reste la porte de sortie si
 * le corpus dépasse 50 000 vecteurs, ce qui n'arrivera pas avec la purge de rétention (MH-13).
 */
import { cosineSimilarity, fromStorable, toStorable, type Embedder } from './embeddings'
import type { Embedding } from '@/db/schema'
import type { Clock } from '@/shared/time'

export interface SimilarityHit {
  refType: Embedding['refType']
  refId: string
  similarity: number
}

export interface VectorStoreBackend {
  all(refType?: Embedding['refType']): Promise<Embedding[]>
  put(embedding: Omit<Embedding, 'id'>): Promise<void>
  deleteByRef(refType: Embedding['refType'], refId: string): Promise<void>
  count(): Promise<number>
}

/** Backend en mémoire — tests et mode simulation. */
export function memoryVectorBackend(): VectorStoreBackend {
  const rows: Embedding[] = []
  return {
    all: async (refType) => (refType ? rows.filter((r) => r.refType === refType) : [...rows]),
    put: async (embedding) => {
      const index = rows.findIndex(
        (r) => r.refType === embedding.refType && r.refId === embedding.refId,
      )
      if (index >= 0) rows[index] = { ...embedding, ...(rows[index]!.id !== undefined ? { id: rows[index]!.id } : {}) }
      else rows.push({ ...embedding, id: rows.length + 1 })
    },
    deleteByRef: async (refType, refId) => {
      const index = rows.findIndex((r) => r.refType === refType && r.refId === refId)
      if (index >= 0) rows.splice(index, 1)
    },
    count: async () => rows.length,
  }
}

export class VectorStore {
  constructor(
    private readonly backend: VectorStoreBackend,
    private readonly embedder: Embedder,
    private readonly clock: Clock,
  ) {}

  /** Indexe un texte. Idempotent sur `(refType, refId)`. */
  async index(refType: Embedding['refType'], refId: string, text: string): Promise<void> {
    const vector = await this.embedder.embed(text)
    await this.backend.put({
      refType,
      refId,
      vector: toStorable(vector),
      createdAtMs: this.clock.now(),
    })
  }

  async indexMany(
    items: readonly { refType: Embedding['refType']; refId: string; text: string }[],
  ): Promise<{ indexed: number }> {
    for (const item of items) await this.index(item.refType, item.refId, item.text)
    return { indexed: items.length }
  }

  /**
   * Cherche les plus proches.
   *
   * `minSimilarity` filtre **avant** le tri : renvoyer les 5 plus proches d'un corpus sans
   * rapport donnerait cinq résultats non pertinents avec l'apparence d'un succès.
   */
  async search(
    text: string,
    options: { limit?: number; minSimilarity?: number; refType?: Embedding['refType'] } = {},
  ): Promise<SimilarityHit[]> {
    const query = await this.embedder.embed(text)
    const rows = await this.backend.all(options.refType)
    const minSimilarity = options.minSimilarity ?? 0

    return rows
      .map((row) => ({
        refType: row.refType,
        refId: row.refId,
        similarity: cosineSimilarity(query, fromStorable(row.vector)),
      }))
      .filter((hit) => hit.similarity >= minSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, options.limit ?? 5)
  }

  async remove(refType: Embedding['refType'], refId: string): Promise<void> {
    await this.backend.deleteByRef(refType, refId)
  }

  async size(): Promise<number> {
    return this.backend.count()
  }
}
