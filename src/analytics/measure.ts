/**
 * ANALYST — mesure des actions publiées, à J+1 et J+7.
 *
 * C'est la moitié amont du différenciateur n°2. Sans elle, le produit est un générateur ;
 * avec elle, c'est un système qui apprend.
 *
 * ## Pourquoi deux mesures et pas une
 *
 * J+1 capte l'essentiel de l'engagement — sur X, un post fait 80 % de ses impressions dans
 * les vingt-quatre heures. J+7 capte ce que J+1 ne peut pas voir : les followers gagnés, qui
 * arrivent avec retard, et la queue longue d'un post qui a continué de circuler.
 *
 * Mesurer plus souvent coûterait des visites de page pour un gain nul ; mesurer une seule
 * fois confondrait « a bien marché » et « a bien démarré ».
 */
import type { Action, Outcome } from '@/db/schema'
import { DAY, type Clock } from '@/shared/time'

/** Décalages de mesure, en jours. Fermé : un troisième point n'apporterait rien. */
export const MEASUREMENT_OFFSETS = [1, 7] as const
export type MeasurementOffset = (typeof MEASUREMENT_OFFSETS)[number]

export interface MeasurementTarget {
  action: Action
  offset: MeasurementOffset
  /** Instant à partir duquel la mesure est due. */
  dueAtMs: number
}

/**
 * Sélectionne les mesures dues.
 *
 * Une action n'est mesurable que si elle a été **confirmée publiée** (MH-09) : mesurer une
 * action abandonnée renverrait les métriques d'un post qui n'existe pas, et la boucle
 * d'apprentissage s'entraînerait sur du bruit.
 */
export function selectDueMeasurements(
  actions: readonly Action[],
  existingOutcomes: readonly Outcome[],
  clock: Clock,
): MeasurementTarget[] {
  const now = clock.now()
  const done = new Set(existingOutcomes.map((o) => `${o.actionId}:${o.dayOffset}`))
  const targets: MeasurementTarget[] = []

  for (const action of actions) {
    if (action.outcome !== 'published' || action.publishedAtMs === null) continue
    if (action.id === undefined) continue

    for (const offset of MEASUREMENT_OFFSETS) {
      if (done.has(`${action.id}:${offset}`)) continue
      const dueAtMs = action.publishedAtMs + offset * DAY
      if (dueAtMs > now) continue
      targets.push({ action, offset, dueAtMs })
    }
  }

  // Les plus anciennes d'abord : une mesure en retard perd de la valeur, une mesure récente
  // peut attendre le prochain réveil.
  return targets.sort((a, b) => a.dueAtMs - b.dueAtMs)
}

/** Métriques relevées sur le post publié. `null` = non lisible, pas zéro. */
export interface MeasuredMetrics {
  impressions: number | null
  likes: number
  replies: number
  reposts: number
  profileClicks: number | null
}

export function toOutcome(
  target: MeasurementTarget,
  metrics: MeasuredMetrics,
  attributedFollows: number,
  clock: Clock,
): Omit<Outcome, 'id'> {
  return {
    actionId: target.action.id!,
    dayOffset: target.offset,
    checkedAtMs: clock.now(),
    impressions: metrics.impressions,
    likes: metrics.likes,
    replies: metrics.replies,
    reposts: metrics.reposts,
    profileClicks: metrics.profileClicks,
    attributedFollows,
  }
}

/**
 * Score d'engagement unifié.
 *
 * Les métriques brutes ne se comparent pas entre elles : un repost vaut plus qu'un like, et
 * une réponse vaut plus qu'un repost — elle demande un effort. La pondération rend les
 * patterns comparables, ce qui est tout l'objet de la Phase 5.
 *
 * Les impressions sont **exclues du score** et conservées séparément : X les masque
 * régulièrement, et une métrique qui disparaît la moitié du temps rendrait les patterns
 * incomparables entre les périodes où elle est visible et celles où elle ne l'est pas.
 */
export function engagementScore(outcome: {
  likes: number
  replies: number
  reposts: number
  attributedFollows: number
}): number {
  return (
    outcome.likes +
    2 * outcome.reposts +
    3 * outcome.replies +
    // Un follower gagné est l'objectif du produit : il pèse un ordre de grandeur au-dessus.
    20 * outcome.attributedFollows
  )
}

/** Vrai si la mesure est exploitable pour l'apprentissage. */
export function isUsableOutcome(outcome: Outcome): boolean {
  // Une mesure entièrement nulle est suspecte : soit le post a fait zéro, soit le parsing a
  // échoué. On ne peut pas distinguer, donc on l'exclut de l'apprentissage plutôt que
  // d'apprendre « cet angle fait zéro » sur une erreur de lecture.
  return (
    outcome.likes > 0 ||
    outcome.replies > 0 ||
    outcome.reposts > 0 ||
    (outcome.impressions !== null && outcome.impressions > 0)
  )
}
