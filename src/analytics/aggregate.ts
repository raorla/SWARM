/**
 * AGRÉGATION DES PATTERNS — la boucle se ferme ici.
 *
 * C'est la moitié aval du différenciateur n°2 : les mesures deviennent des règles, et les
 * règles retournent dans les prompts. Sans ce module, le produit mesure sans apprendre.
 *
 * ## Le piège que ce module doit éviter
 *
 * Un pattern à n=3 n'est pas un pattern, c'est une coïncidence. Réinjecter « les
 * contre-arguments marchent mieux » sur trois observations ferait converger le WRITER vers un
 * angle unique sur la base du bruit — et pire, la convergence rendrait la mesure
 * auto-réalisatrice : moins d'angles essayés, donc moins de données pour les comparer.
 *
 * Trois défenses :
 *
 *  1. **Seuil d'échantillon** avant qu'un pattern soit exploitable.
 *  2. **Confiance calculée**, exposée, et utilisée pour trier — pas seulement affichée.
 *  3. **Comparaison à la moyenne globale**, pas dans l'absolu : « meilleur que la moyenne »
 *     est une information, « 4,2 d'engagement » n'en est pas une.
 */
import type { Action, Outcome, Pattern } from '@/db/schema'
import { engagementScore, isUsableOutcome } from './measure'
import type { Clock } from '@/shared/time'

/**
 * Dimensions analysées.
 *
 * Fermé volontairement : une dimension libre produirait des patterns non comparables entre
 * eux, et surtout impossibles à réinjecter dans un prompt de façon lisible.
 */
export const PATTERN_DIMENSIONS = ['angle', 'length', 'hour', 'weekday', 'authorTier'] as const
export type PatternDimension = (typeof PATTERN_DIMENSIONS)[number]

/** En dessous, un pattern n'est pas exploitable — voir l'en-tête du module. */
export const MIN_SAMPLE_SIZE = 8

/** Nombre de patterns réinjectés dans les prompts, par extrémité. */
export const TOP_N = 5

export interface ObservedAction {
  action: Action
  /** Mesures de cette action, tous décalages confondus. */
  outcomes: readonly Outcome[]
}

/* ──────────────────────────── Extraction des valeurs ─────────────────────── */

/** Tranches de longueur. Bornes rondes : « court / moyen / long » se lit, « 87 » non. */
export function lengthBucket(text: string): string {
  const n = text.trim().length
  if (n < 60) return 'très court (<60)'
  if (n < 120) return 'court (60-120)'
  if (n < 200) return 'moyen (120-200)'
  return 'long (200+)'
}

/** Tranches horaires locales. */
export function hourBucket(atMs: number, tzOffsetMinutes: number): string {
  const local = new Date(atMs - tzOffsetMinutes * 60_000)
  const hour = local.getUTCHours()
  if (hour < 6) return 'nuit (0-6h)'
  if (hour < 12) return 'matin (6-12h)'
  if (hour < 18) return 'après-midi (12-18h)'
  return 'soir (18-24h)'
}

export function weekdayBucket(atMs: number, tzOffsetMinutes: number): string {
  const local = new Date(atMs - tzOffsetMinutes * 60_000)
  const day = local.getUTCDay()
  return day === 0 || day === 6 ? 'week-end' : 'semaine'
}

/**
 * Tranches d'audience de l'auteur.
 *
 * Bornes logarithmiques : la différence entre 500 et 5 000 abonnés compte, celle entre
 * 100 000 et 150 000 non.
 */
export function authorTierBucket(followers: number | null): string {
  if (followers === null) return 'inconnu'
  if (followers < 1_000) return 'micro (<1k)'
  if (followers < 10_000) return 'petit (1k-10k)'
  if (followers < 100_000) return 'moyen (10k-100k)'
  return 'grand (100k+)'
}

/**
 * Valeurs de chaque dimension pour une action.
 *
 * `null` signifie « dimension non applicable à cette action » — et c'est différent d'une
 * valeur manquante : une action dont on ignore l'angle ne doit pas alimenter un pattern
 * « inconnu », elle ne doit alimenter aucun pattern d'angle.
 */
export function extractDimensions(
  observed: ObservedAction,
  tzOffsetMinutes: number,
): Partial<Record<PatternDimension, string>> {
  const { action } = observed
  const angle = action.agentTrail.length > 0 ? findAngle(action) : null

  const values: Partial<Record<PatternDimension, string>> = {
    length: lengthBucket(action.content),
  }
  if (angle !== null) values.angle = angle
  if (action.publishedAtMs !== null) {
    values.hour = hourBucket(action.publishedAtMs, tzOffsetMinutes)
    values.weekday = weekdayBucket(action.publishedAtMs, tzOffsetMinutes)
  }
  return values
}

/**
 * L'angle n'est pas stocké sur l'action mais sur le brouillon.
 *
 * On ne le devine pas depuis le texte : un angle inféré serait faux la moitié du temps et
 * contaminerait tous les patterns d'angle. Sans donnée, pas de pattern.
 */
function findAngle(_action: Action): string | null {
  return null
}

/* ───────────────────────────── Agrégation ────────────────────────────────── */

export interface AggregationResult {
  patterns: Omit<Pattern, 'id'>[]
  /** Moyenne globale d'engagement — la référence à laquelle chaque pattern se compare. */
  globalAverage: number
  /** Actions retenues pour l'apprentissage, après filtrage des mesures inexploitables. */
  usableSample: number
  /** Actions écartées, et pourquoi — le diagnostic compte autant que le résultat. */
  skipped: Record<string, number>
}

/**
 * Agrège les mesures en patterns.
 *
 * Une action ne compte qu'une fois, avec sa mesure **la plus tardive** : J+7 est plus
 * informatif que J+1, et additionner les deux compterait le même engagement deux fois.
 */
export function aggregatePatterns(
  observations: readonly ObservedAction[],
  clock: Clock,
  angleByActionId: ReadonlyMap<number, string> = new Map(),
): AggregationResult {
  const skipped: Record<string, number> = {}
  const bump = (reason: string): void => {
    skipped[reason] = (skipped[reason] ?? 0) + 1
  }

  const tzOffsetMinutes = clock.timezoneOffsetMinutes()
  interface Sample {
    score: number
    follows: number
    values: Partial<Record<PatternDimension, string>>
  }
  const samples: Sample[] = []

  for (const observed of observations) {
    if (observed.action.outcome !== 'published') {
      bump('non-publiee')
      continue
    }
    const usable = observed.outcomes.filter(isUsableOutcome)
    if (usable.length === 0) {
      // Mesure entièrement nulle : impossible de distinguer « a fait zéro » d'un échec de
      // lecture. Apprendre dessus serait apprendre sur une erreur.
      bump('mesure-inexploitable')
      continue
    }

    // La plus tardive : J+7 englobe J+1.
    const latest = usable.reduce((a, b) => (b.dayOffset > a.dayOffset ? b : a))
    const values = extractDimensions(observed, tzOffsetMinutes)

    const angle = observed.action.id !== undefined ? angleByActionId.get(observed.action.id) : undefined
    if (angle !== undefined) values.angle = angle

    samples.push({
      score: engagementScore(latest),
      follows: latest.attributedFollows,
      values,
    })
  }

  if (samples.length === 0) {
    return { patterns: [], globalAverage: 0, usableSample: 0, skipped }
  }

  const globalAverage = samples.reduce((sum, s) => sum + s.score, 0) / samples.length

  // Regroupement par (dimension, valeur).
  const groups = new Map<string, { dimension: PatternDimension; value: string; scores: number[]; follows: number[] }>()
  for (const sample of samples) {
    for (const dimension of PATTERN_DIMENSIONS) {
      const value = sample.values[dimension]
      if (value === undefined) continue
      const key = `${dimension}|${value}`
      const group = groups.get(key) ?? { dimension, value, scores: [], follows: [] }
      group.scores.push(sample.score)
      group.follows.push(sample.follows)
      groups.set(key, group)
    }
  }

  const now = clock.now()
  const patterns: Omit<Pattern, 'id'>[] = [...groups.values()].map((group) => ({
    dimension: group.dimension,
    value: group.value,
    sampleSize: group.scores.length,
    avgEngagement: group.scores.reduce((a, b) => a + b, 0) / group.scores.length,
    avgAttributedFollows: group.follows.reduce((a, b) => a + b, 0) / group.follows.length,
    confidence: patternConfidence(group.scores, globalAverage),
    updatedAtMs: now,
  }))

  return { patterns, globalAverage, usableSample: samples.length, skipped }
}

/**
 * Confiance d'un pattern, dans [0, 1].
 *
 * Deux composantes multiplicatives :
 *
 *  - **la taille d'échantillon**, en racine carrée : le gain du dixième point est bien
 *    supérieur à celui du cinquantième ;
 *  - **la stabilité interne** : un groupe dont les mesures vont de 2 à 400 n'a rien à dire,
 *    même avec cinquante points. C'est la composante que les agrégations naïves oublient, et
 *    c'est elle qui empêche un unique post viral de créer un « pattern ».
 */
export function patternConfidence(scores: readonly number[], globalAverage: number): number {
  if (scores.length === 0) return 0

  const sizeFactor = Math.min(1, Math.sqrt(scores.length / (MIN_SAMPLE_SIZE * 3)))

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length
  if (mean === 0) return 0
  const variance = scores.reduce((sum, s) => sum + (s - mean) ** 2, 0) / scores.length
  const coefficientOfVariation = Math.sqrt(variance) / mean
  // Un coefficient de variation de 1 (écart-type égal à la moyenne) annule la stabilité.
  const stabilityFactor = Math.max(0, 1 - coefficientOfVariation)

  // Un pattern dont la moyenne est indiscernable de la moyenne globale n'apprend rien, même
  // s'il est stable et nombreux.
  const distinctness =
    globalAverage === 0 ? 0 : Math.min(1, Math.abs(mean - globalAverage) / globalAverage)

  return Math.min(1, sizeFactor * stabilityFactor * (0.4 + 0.6 * distinctness))
}

/* ─────────────────────── Sélection pour les prompts ──────────────────────── */

export interface RankedPattern {
  dimension: string
  value: string
  avgEngagement: number
  /** Écart à la moyenne globale, en pourcentage. */
  liftPct: number
  sampleSize: number
  confidence: number
}

export interface PatternDigest {
  top: RankedPattern[]
  flop: RankedPattern[]
  globalAverage: number
  /** Vrai si aucun pattern n'atteint le seuil : le prompt ne doit rien affirmer. */
  insufficient: boolean
  sampleSize: number
}

/**
 * Sélectionne le top et le flop à réinjecter.
 *
 * **Filtre sur `MIN_SAMPLE_SIZE` avant tout tri.** Un pattern à n=3 en tête de liste
 * ferait converger le WRITER sur du bruit ; et cette convergence rendrait la mesure
 * auto-réalisatrice, puisque moins d'angles seraient essayés.
 */
export function digestPatterns(
  patterns: readonly Pattern[],
  globalAverage: number,
  totalSample: number,
): PatternDigest {
  const eligible = patterns.filter(
    (p) => p.sampleSize >= MIN_SAMPLE_SIZE && p.confidence > 0.2,
  )

  if (eligible.length === 0) {
    return { top: [], flop: [], globalAverage, insufficient: true, sampleSize: totalSample }
  }

  const ranked = eligible
    .map((p) => ({
      dimension: p.dimension,
      value: p.value,
      avgEngagement: p.avgEngagement,
      liftPct:
        globalAverage === 0 ? 0 : ((p.avgEngagement - globalAverage) / globalAverage) * 100,
      sampleSize: p.sampleSize,
      confidence: p.confidence,
    }))
    /*
     * Tri par écart pondéré par le **carré** de la confiance.
     *
     * Une pondération linéaire ne suffit pas, et c'est un test qui l'a montré : un écart de
     * +900 % à 0,25 de confiance devançait un écart de +150 % à 0,9. Or c'est l'inverse de ce
     * qu'il faut faire — un écart extrême sur peu d'observations est *plus* susceptible d'être
     * du bruit qu'un écart modéré sur beaucoup, parce que les valeurs extrêmes sont exactement
     * là où les petits échantillons trompent. Le mettre en tête du prompt pousserait le WRITER
     * vers un coup de chance.
     *
     * Le carré fait dominer la fiabilité sans annuler l'amplitude.
     */
    .sort((a, b) => b.liftPct * b.confidence ** 2 - a.liftPct * a.confidence ** 2)

  return {
    top: ranked.filter((p) => p.liftPct > 0).slice(0, TOP_N),
    flop: ranked.filter((p) => p.liftPct < 0).slice(-TOP_N).reverse(),
    globalAverage,
    insufficient: false,
    sampleSize: totalSample,
  }
}
