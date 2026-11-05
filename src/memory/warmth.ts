/**
 * Progression de familiarité — la lecture produit de `warmth`.
 *
 * `relationships.ts` calcule la familiarité ; ce module la traduit en décisions. La séparation
 * n'est pas cosmétique : la première est une mesure, la seconde une politique, et mélanger les
 * deux empêcherait de régler l'une sans toucher à l'autre.
 */
import { familiarityLevel, MAX_WARMTH, type FamiliarityLevel } from './relationships'
import type { Relationship } from '@/db/schema'
import { DAY, type Clock } from '@/shared/time'

/**
 * Délai minimum entre deux réponses au même compte, selon la familiarité.
 *
 * **Décroissant avec l'intimité, et c'est délibéré.** Répondre deux fois dans la journée à un
 * inconnu est du harcèlement ; le faire avec quelqu'un avec qui on échange régulièrement est
 * une conversation. Un délai uniforme traiterait les deux pareil et raterait précisément ce que
 * le CRM social apporte.
 */
const COOLDOWN_BY_LEVEL: Record<FamiliarityLevel, number> = {
  inconnu: 3 * DAY,
  croisé: 2 * DAY,
  connu: 1 * DAY,
  familier: 8 * 60 * 60_000,
  proche: 2 * 60 * 60_000,
}

export interface CooldownVerdict {
  allowed: boolean
  level: FamiliarityLevel
  requiredMs: number
  elapsedMs: number | null
  /** Instant à partir duquel une réponse redevient acceptable. */
  nextAllowedAtMs: number | null
  reason: string
}

export function checkCooldown(
  relationship: Relationship | null,
  clock: Clock,
): CooldownVerdict {
  const level = familiarityLevel(relationship)
  const required = COOLDOWN_BY_LEVEL[level]

  if (!relationship || relationship.lastInteractionMs === null) {
    return {
      allowed: true,
      level,
      requiredMs: required,
      elapsedMs: null,
      nextAllowedAtMs: null,
      reason: 'jamais interagi avec ce compte',
    }
  }

  const elapsed = clock.now() - relationship.lastInteractionMs
  const allowed = elapsed >= required

  return {
    allowed,
    level,
    requiredMs: required,
    elapsedMs: elapsed,
    nextAllowedAtMs: allowed ? null : relationship.lastInteractionMs + required,
    reason: allowed
      ? `dernière interaction il y a ${Math.round(elapsed / (60 * 60_000))} h`
      : `trop récent : ${Math.round(elapsed / (60 * 60_000))} h écoulées sur ${Math.round(required / (60 * 60_000))} h requises au niveau « ${level} »`,
  }
}

/**
 * Prochain palier de familiarité, et ce qu'il demande.
 *
 * Sert l'onglet Analytics : montrer qu'une relation progresse — ou stagne — est ce qui rend le
 * différenciateur n°3 visible. Un CRM social dont on ne voit pas l'effet ne se distingue pas
 * d'une absence de CRM social.
 */
export function progressToNextLevel(relationship: Relationship | null): {
  level: FamiliarityLevel
  next: FamiliarityLevel | null
  progressPct: number
  requirement: string
} {
  const level = familiarityLevel(relationship)
  const warmth = relationship?.warmth ?? 0

  const thresholds: [FamiliarityLevel, number][] = [
    ['croisé', 0],
    ['connu', 1],
    ['familier', 2.5],
    ['proche', 4],
  ]

  const nextEntry = thresholds.find(([, threshold]) => warmth < threshold)
  if (!nextEntry) {
    return {
      level,
      next: null,
      progressPct: 100,
      requirement: 'Niveau maximum atteint.',
    }
  }

  const [nextLevel, nextThreshold] = nextEntry
  const previousThreshold =
    [...thresholds].reverse().find(([, t]) => warmth >= t)?.[1] ?? 0
  const span = nextThreshold - previousThreshold
  const progressPct = span <= 0 ? 0 : Math.min(100, ((warmth - previousThreshold) / span) * 100)

  return {
    level,
    next: nextLevel,
    progressPct,
    // La formulation dit ce qui fait progresser : la réciprocité, pas l'insistance.
    requirement: `Passer à « ${nextLevel} » demande de la réciprocité — une réponse, un repost ou un abonnement de leur part. Répondre davantage ne suffit pas.`,
  }
}

/** Familiarité normalisée dans [0, 1], pour le scoring d'affinité. */
export function normalizedWarmth(relationship: Relationship | null): number {
  if (!relationship) return 0
  return Math.max(0, Math.min(1, relationship.warmth / MAX_WARMTH))
}
