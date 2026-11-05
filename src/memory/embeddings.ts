/**
 * EMBEDDINGS LOCAUX — ADR 0002.
 *
 * Aucun appel API, jamais. Trois raisons qui pointent dans la même direction : le coût
 * récurrent est intenable à 1 €/jour ; envoyer chaque post lu à une API d'embedding ferait du
 * vector store le plus gros canal d'egress du produit ; et surtout, si le budget est épuisé,
 * la mémoire relationnelle doit **continuer à fonctionner** — un plafond atteint ne doit pas
 * rendre le système amnésique.
 *
 * ## Deux implémentations, une interface
 *
 * `HashingEmbedder` est écrit ici et fonctionne dès maintenant : projection de n-grammes de
 * caractères sur un espace de dimension fixe, façon *hashing trick*. Déterministe, instantané,
 * zéro dépendance, zéro octet à télécharger.
 *
 * `OnnxEmbedder` (Phase 6, à venir) chargera un modèle de phrases dans l'Offscreen Document.
 * Il capte la similarité sémantique — « liquidité verrouillée » et « LP lock » — que le
 * hachage ne peut pas voir.
 *
 * **Ce que le hachage sait et ne sait pas faire**, et il faut être clair : il détecte la
 * reformulation lexicale, pas la synonymie. C'est suffisant pour l'anti-répétition — on répète
 * généralement avec les mêmes mots — et insuffisant pour le regroupement thématique. La
 * distinction est testée, pas supposée.
 */

/** Dimension de l'espace. 256 : assez pour discriminer, assez petit pour IndexedDB. */
export const EMBEDDING_DIM = 256

export interface Embedder {
  readonly id: string
  readonly dim: number
  /** Vecteur **normalisé** — la similarité cosinus se réduit alors au produit scalaire. */
  embed(text: string): Promise<Float32Array>
}

/** Normalisation FNV-1a, 32 bits. */
function hash32(input: string, seed: number): number {
  let h = seed >>> 0
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Normalise avant projection.
 *
 * Sans diacritiques ni casse : « Liquidité » et « liquidite » doivent produire le même
 * vecteur, sinon l'anti-répétition passerait à côté d'une reformulation triviale.
 */
export function normalizeForEmbedding(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Embedder par hachage de n-grammes.
 *
 * Les n-grammes de **caractères** plutôt que de mots : ils résistent aux fautes de frappe, aux
 * accords et aux troncatures, qui sont la norme sur X. « holders » et « holder » partagent la
 * quasi-totalité de leurs trigrammes.
 */
export class HashingEmbedder implements Embedder {
  readonly id = 'hashing-v1'
  readonly dim = EMBEDDING_DIM

  constructor(private readonly ngramSizes: readonly number[] = [3, 4, 5]) {}

  async embed(text: string): Promise<Float32Array> {
    const normalized = normalizeForEmbedding(text)
    const vector = new Float32Array(this.dim)
    if (normalized.length === 0) return vector

    // Les mots entiers pèsent double : un trigramme est bruité, un mot porte du sens.
    for (const word of normalized.split(' ')) {
      if (word.length < 2) continue
      const index = hash32(word, 0x9e3779b9) % this.dim
      vector[index] = (vector[index] ?? 0) + 2
    }

    for (const size of this.ngramSizes) {
      for (let i = 0; i + size <= normalized.length; i++) {
        const gram = normalized.slice(i, i + size)
        if (gram.trim().length < size) continue
        const index = hash32(gram, size) % this.dim
        // Signe alterné par hachage : deux n-grammes différents tombant sur la même case
        // s'annulent en moyenne au lieu de s'additionner, ce qui limite le bruit de collision.
        const sign = hash32(gram, 0x517cc1b7) % 2 === 0 ? 1 : -1
        vector[index] = (vector[index] ?? 0) + sign
      }
    }

    return normalizeVector(vector)
  }
}

/** Normalise en place, puis renvoie. Un vecteur nul reste nul. */
export function normalizeVector(vector: Float32Array): Float32Array {
  let sumSquares = 0
  for (const value of vector) sumSquares += value * value
  if (sumSquares === 0) return vector
  const norm = Math.sqrt(sumSquares)
  for (let i = 0; i < vector.length; i++) vector[i] = (vector[i] ?? 0) / norm
  return vector
}

/**
 * Similarité cosinus.
 *
 * Les vecteurs étant normalisés, c'est un produit scalaire. On ne renormalise pas ici : le
 * faire masquerait un vecteur mal construit au lieu de le révéler.
 */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  if (a.length !== b.length) return 0
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += (a[i] ?? 0) * (b[i] ?? 0)
  // Le signe alterné du hachage peut produire des similarités négatives, qui n'ont pas de
  // sens ici : deux textes sans rapport valent 0, pas -0,3.
  return Math.max(0, Math.min(1, dot))
}

/** Sérialisation pour IndexedDB. `Float32Array` ne survit pas au clonage structuré de Dexie. */
export function toStorable(vector: Float32Array): number[] {
  return Array.from(vector)
}

export function fromStorable(values: readonly number[]): Float32Array {
  return new Float32Array(values)
}
