/**
 * ATTRIBUTION des nouveaux abonnés aux réponses publiées.
 *
 * ## Ce que cette attribution est, et ce qu'elle n'est pas
 *
 * Elle est **corrélationnelle**, pas causale, et le produit doit le dire (voir
 * `docs/risks-and-limits.md`). On ne peut pas savoir pourquoi quelqu'un s'abonne. On peut
 * savoir qu'un abonnement est arrivé dans la fenêtre d'une réponse, et que cette réponse a
 * généré des clics profil.
 *
 * Utile comme **signal comparatif entre patterns** — cet angle attire plus que celui-là — pas
 * comme vérité sur un abonné précis. Traiter un signal comparatif comme une vérité
 * individuelle est l'erreur classique de ce genre de mesure, et elle produit des conclusions
 * confiantes et fausses.
 */
import { HOUR, type Clock } from '@/shared/time'
import type { Action } from '@/db/schema'

/** Fenêtre d'attribution. Au-delà, le lien temporel n'a plus de valeur explicative. */
export const ATTRIBUTION_WINDOW_MS = 48 * HOUR

export interface FollowerSample {
  atMs: number
  count: number
}

export interface AttributionInput {
  /** Relevés successifs du nombre d'abonnés, ordonnés. */
  followerSamples: readonly FollowerSample[]
  /** Actions publiées, avec leurs clics profil mesurés. */
  publishedActions: readonly { action: Action; profileClicks: number | null }[]
  clock: Clock
}

export interface AttributionResult {
  /** Abonnés gagnés par action, indexés par `actionId`. */
  byActionId: Map<number, number>
  /** Total attribué. */
  attributed: number
  /** Gain observé mais non attribuable — honnêteté du calcul. */
  unattributed: number
  /** Confiance dans [0, 1] : faible si peu de relevés ou beaucoup d'actions simultanées. */
  confidence: number
}

/**
 * Répartit le gain d'abonnés observé entre les actions de la fenêtre.
 *
 * La répartition est **proportionnelle aux clics profil**, qui sont le seul lien mesurable
 * entre une réponse et une visite de profil. À défaut de clics mesurés, on répartit
 * uniformément — et la confiance chute, parce qu'une répartition uniforme n'explique rien.
 */
export function attributeFollowers(input: AttributionInput): AttributionResult {
  const byActionId = new Map<number, number>()
  const samples = [...input.followerSamples].sort((a, b) => a.atMs - b.atMs)

  if (samples.length < 2) {
    // Un seul relevé ne donne aucune variation : rien à attribuer, et le dire est plus
    // honnête que de répartir zéro.
    return { byActionId, attributed: 0, unattributed: 0, confidence: 0 }
  }

  const first = samples[0]!
  const last = samples[samples.length - 1]!
  const totalGain = Math.max(0, last.count - first.count)

  if (totalGain === 0) {
    return { byActionId, attributed: 0, unattributed: 0, confidence: 1 }
  }

  // Actions publiées dans la fenêtre couverte par les relevés.
  const eligible = input.publishedActions.filter(
    ({ action }) =>
      action.id !== undefined &&
      action.publishedAtMs !== null &&
      action.publishedAtMs >= first.atMs - ATTRIBUTION_WINDOW_MS &&
      action.publishedAtMs <= last.atMs,
  )

  if (eligible.length === 0) {
    // Gain réel mais aucune action pour l'expliquer : croissance organique, ou effet d'un
    // post antérieur. Le compter comme non attribué est la seule réponse juste.
    return { byActionId, attributed: 0, unattributed: totalGain, confidence: 1 }
  }

  const totalClicks = eligible.reduce((sum, { profileClicks }) => sum + (profileClicks ?? 0), 0)
  const hasClickData = totalClicks > 0

  let attributed = 0
  for (const { action, profileClicks } of eligible) {
    const share = hasClickData
      ? (profileClicks ?? 0) / totalClicks
      : 1 / eligible.length
    // Arrondi au plus proche : un abonné est une unité, pas une fraction.
    const gain = Math.round(totalGain * share)
    if (gain > 0) {
      byActionId.set(action.id!, gain)
      attributed += gain
    }
  }

  return {
    byActionId,
    attributed,
    unattributed: Math.max(0, totalGain - attributed),
    // La confiance tombe sans données de clics — une répartition uniforme n'explique rien —
    // et tombe aussi quand beaucoup d'actions se disputent le même gain.
    confidence: computeConfidence(hasClickData, eligible.length, samples.length),
  }
}

function computeConfidence(
  hasClickData: boolean,
  actionCount: number,
  sampleCount: number,
): number {
  const clickFactor = hasClickData ? 1 : 0.3
  // Une action seule dans la fenêtre est bien plus attribuable que dix simultanées.
  const isolationFactor = 1 / Math.sqrt(actionCount)
  // Peu de relevés = fenêtre grossière.
  const samplingFactor = Math.min(1, sampleCount / 8)
  return Math.min(1, clickFactor * isolationFactor * samplingFactor)
}

/** Avertissement à afficher avec toute statistique d'attribution. */
export function attributionCaveat(result: AttributionResult): string | null {
  if (result.confidence >= 0.6) return null
  if (result.confidence === 0) {
    return 'Pas assez de relevés d’abonnés pour attribuer quoi que ce soit.'
  }
  return (
    `Attribution peu fiable (confiance ${(result.confidence * 100).toFixed(0)} %) : ` +
    'corrélation temporelle seulement, à lire comme un signal comparatif et non comme une cause.'
  )
}
