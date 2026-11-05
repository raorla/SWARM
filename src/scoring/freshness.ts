/**
 * FRAÎCHEUR d'une opportunité.
 *
 * Sur X, la fenêtre utile d'une réponse est courte, et sa décroissance n'est pas linéaire :
 * une réponse à 5 minutes vaut presque autant qu'à 2 minutes, une réponse à 90 minutes ne
 * vaut presque plus rien. Un modèle linéaire surestimerait massivement le milieu de fenêtre.
 *
 * On utilise donc une **décroissance exponentielle**, calée pour que le facteur atteigne 0
 * au seuil d'âge maximal du pack — un post au-delà du seuil est écarté, pas simplement mal
 * noté.
 */

export interface FreshnessInput {
  postedAtMs: number
  nowMs: number
}

/**
 * Constante de demi-vie relative au seuil.
 *
 * 0,3 : à 30 % du seuil, la fraîcheur est tombée à moitié. Avec un seuil de 45 minutes
 * (pack memecoin), une réponse à 13 minutes vaut déjà deux fois moins qu'une réponse
 * immédiate — ce qui correspond au rythme réel de ces fils.
 */
export const HALF_LIFE_RATIO = 0.3

export function computeFreshness(input: FreshnessInput, maxAgeMinutes: number): number {
  const ageMs = input.nowMs - input.postedAtMs

  // Un post daté du futur est une anomalie d'horloge, pas une aubaine. On le traite comme
  // frais sans le récompenser : le noter au-dessus de 1 fausserait le classement.
  if (ageMs < 0) return 1

  const maxAgeMs = Math.max(1, maxAgeMinutes) * 60_000
  if (ageMs >= maxAgeMs) return 0

  const halfLifeMs = maxAgeMs * HALF_LIFE_RATIO
  const decayed = Math.pow(0.5, ageMs / halfLifeMs)

  // Ramené à zéro au seuil : sans cette correction, la décroissance laisserait une valeur
  // résiduelle juste avant le seuil, puis chuterait brutalement à zéro. Une discontinuité
  // dans le classement produit des inversions inexplicables entre deux posts d'âge voisin.
  const atThreshold = Math.pow(0.5, 1 / HALF_LIFE_RATIO)
  return Math.max(0, (decayed - atThreshold) / (1 - atThreshold))
}

/** Âge en minutes, pour l'affichage. */
export function ageMinutes(input: FreshnessInput): number {
  return Math.max(0, Math.round((input.nowMs - input.postedAtMs) / 60_000))
}

/**
 * Instant au-delà duquel l'opportunité est périmée.
 * Sert à purger la file sans recalculer tous les scores.
 */
export function expiresAtMs(postedAtMs: number, maxAgeMinutes: number): number {
  return postedAtMs + Math.max(1, maxAgeMinutes) * 60_000
}
