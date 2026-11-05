/**
 * ANTI-RÉPÉTITION SÉMANTIQUE — « on ne se répète jamais » (différenciateur n°3).
 *
 * ## Pourquoi c'est un module et non un test dans le CRITIC
 *
 * Le CRITIC juge une variante sur ce qu'il voit. Il ne peut pas savoir que l'utilisateur a
 * publié la même idée il y a trois semaines — cette information est dans le corpus, pas dans
 * le prompt. Détecter la redondance demande une recherche, donc un module.
 *
 * ## Le seuil, et pourquoi il est asymétrique
 *
 * Deux erreurs de coût très différent :
 *
 *  - **Faux positif** (on bloque une réponse qui n'était pas une répétition) : coûte une
 *    occasion, réversible, il y en aura d'autres.
 *  - **Faux négatif** (on publie la même chose deux fois) : coûte de la crédibilité auprès
 *    d'une audience qui l'a déjà lu, et c'est irréversible.
 *
 * Le seuil penche donc vers la prudence. Mais pas jusqu'à l'absurde : bloquer sur toute
 * similarité lexicale rendrait le produit muet dans une niche où l'on parle toujours des mêmes
 * dix sujets. D'où deux seuils distincts — un pour « c'est le même texte », un pour « c'est la
 * même idée ».
 */
import type { VectorStore, SimilarityHit } from './vector-store'

/** Au-delà : quasi-identique. Reformulation, pas nouvelle idée. */
export const NEAR_DUPLICATE_THRESHOLD = 0.82

/** Au-delà : même terrain. À signaler, pas à bloquer. */
export const SAME_GROUND_THRESHOLD = 0.62

export type RedundancyVerdict = 'unique' | 'same-ground' | 'near-duplicate'

export interface RedundancyCheck {
  verdict: RedundancyVerdict
  /** Similarité la plus haute trouvée. */
  topSimilarity: number
  /** Références les plus proches, les plus similaires d'abord. */
  closest: SimilarityHit[]
  /** Message destiné au CRITIC et à l'UI. */
  explanation: string
}

export interface CheckOptions {
  /** Type de référence à interroger. `ourPost` par défaut : nos propres publications. */
  refType?: 'ourPost' | 'action' | 'opportunity' | 'topic'
  /** Nombre de voisins remontés. */
  limit?: number
  nearDuplicateThreshold?: number
  sameGroundThreshold?: number
}

/**
 * Vérifie si un texte candidat répète quelque chose de déjà publié.
 *
 * Renvoie toujours un verdict exploitable, y compris sur un corpus vide : `unique` avec une
 * explication qui **dit que le corpus est vide**, plutôt qu'un `unique` silencieux qui
 * laisserait croire à une vérification réussie.
 */
export async function checkRedundancy(
  candidate: string,
  store: VectorStore,
  options: CheckOptions = {},
): Promise<RedundancyCheck> {
  const nearThreshold = options.nearDuplicateThreshold ?? NEAR_DUPLICATE_THRESHOLD
  const groundThreshold = options.sameGroundThreshold ?? SAME_GROUND_THRESHOLD

  const size = await store.size()
  if (size === 0) {
    return {
      verdict: 'unique',
      topSimilarity: 0,
      closest: [],
      explanation:
        'Aucun historique indexé : impossible de vérifier la redondance. Ce n’est pas une garantie d’originalité.',
    }
  }

  const hits = await store.search(candidate, {
    limit: options.limit ?? 3,
    minSimilarity: groundThreshold * 0.7,
    ...(options.refType !== undefined ? { refType: options.refType } : {}),
  })

  const top = hits[0]?.similarity ?? 0

  if (top >= nearThreshold) {
    return {
      verdict: 'near-duplicate',
      topSimilarity: top,
      closest: hits,
      explanation: `Quasi-identique à ${hits[0]!.refId} (${(top * 100).toFixed(0)} %). Publier deux fois la même chose use l’audience plus vite que se taire.`,
    }
  }

  if (top >= groundThreshold) {
    return {
      verdict: 'same-ground',
      topSimilarity: top,
      closest: hits,
      explanation: `Même terrain que ${hits[0]!.refId} (${(top * 100).toFixed(0)} %). Acceptable si l’angle diffère réellement — à vérifier, pas à bloquer.`,
    }
  }

  return {
    verdict: 'unique',
    topSimilarity: top,
    closest: hits,
    explanation:
      hits.length === 0
        ? 'Rien de proche dans l’historique.'
        : `Le plus proche est à ${(top * 100).toFixed(0)} %, sous le seuil de recouvrement.`,
  }
}

/**
 * Le verdict doit-il bloquer la publication ?
 *
 * Séparé du verdict lui-même parce que la décision est **politique** et le verdict
 * **factuel**. Mesurer la similarité et décider quoi en faire sont deux responsabilités, et
 * les mélanger empêcherait de rendre le seuil configurable sans toucher à la mesure.
 */
export function shouldBlock(check: RedundancyCheck): boolean {
  return check.verdict === 'near-duplicate'
}

/** Note à injecter dans le prompt du CRITIC. `null` si rien à signaler. */
export function redundancyNote(check: RedundancyCheck): string | null {
  if (check.verdict === 'unique') return null
  return check.explanation
}
