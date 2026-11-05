/**
 * Poids de la formule EV — réglables par l'utilisateur (SPEC §1.4 : « formule visible et
 * réglable »).
 *
 * Les poids vivent dans le Niche Pack, pas dans le code : ce qui compte dans une niche ne
 * compte pas dans une autre. Ce module ne fait que valider et expliquer.
 */
import { EvWeightsSchema, type EvWeights } from '@/niches/pack.schema'
import type { ParseFailure } from '@/shared/zod-helpers'
import { parseAt } from '@/shared/zod-helpers'
import type { Result } from '@/shared/result'

/** Poids neutres : tous les facteurs comptent également. */
export const NEUTRAL_WEIGHTS: EvWeights = {
  reach: 1,
  nicheRelevance: 1,
  freshness: 1,
  saturationPenalty: 1,
  authorAffinity: 1,
}

export function parseWeights(input: unknown): Result<EvWeights, ParseFailure> {
  return parseAt('scoring:weights', EvWeightsSchema, input)
}

/**
 * Décrit en langue naturelle ce que les poids privilégient.
 *
 * Sert l'onglet Config : un utilisateur qui bouge cinq curseurs doit lire ce qu'il vient de
 * décider, pas seulement voir cinq chiffres.
 */
export function describeWeights(weights: EvWeights): string {
  const entries: [string, number][] = [
    ['portée', weights.reach],
    ['pertinence de niche', weights.nicheRelevance],
    ['fraîcheur', weights.freshness],
    ['place disponible', weights.saturationPenalty],
    ['affinité auteur', weights.authorAffinity],
  ]
  const total = entries.reduce((sum, [, w]) => sum + w, 0)
  if (total === 0) {
    return 'Aucun poids : tous les facteurs comptent également par défaut.'
  }

  const sorted = [...entries].sort((a, b) => b[1] - a[1])
  const top = sorted[0]!
  const bottom = sorted[sorted.length - 1]!

  if (top[1] === bottom[1]) return 'Tous les facteurs pèsent également.'
  return `Privilégie ${top[0]} (${((top[1] / total) * 100).toFixed(0)} %) ; ${bottom[0]} compte le moins (${((bottom[1] / total) * 100).toFixed(0)} %).`
}

/**
 * Détecte une configuration de poids qui rendrait le scoring inopérant.
 *
 * Un utilisateur qui met tout à zéro sauf un facteur ne fait pas du réglage fin, il désactive
 * la formule. Mieux vaut le lui dire que produire un classement dégénéré.
 */
export function diagnoseWeights(weights: EvWeights): string | null {
  const values = Object.values(weights)
  const nonZero = values.filter((v) => v > 0).length

  if (nonZero === 0) {
    return 'Tous les poids sont à zéro : la formule est désactivée, le classement sera arbitraire.'
  }
  if (nonZero === 1) {
    return 'Un seul facteur actif : le classement ignorera tout le reste. C’est un tri, pas un scoring.'
  }
  if (weights.nicheRelevance === 0) {
    return 'Pertinence de niche à zéro : des posts hors sujet remonteront dans la file.'
  }
  return null
}
