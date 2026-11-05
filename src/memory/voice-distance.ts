/**
 * DISTANCE DE VOIX — le signal quotidien du travail sur le style.
 *
 * Le blind test (`docs/blind-test-protocol.md`) est la porte de la Phase 2, mais il demande
 * trois juges humains. Impraticable à chaque itération de prompt : sans métrique
 * automatique, on modifierait le WRITER sans savoir si le style s'améliore ou se dégrade.
 *
 * Cette métrique ne remplace pas le blind test — elle mesure la conformité de forme, pas
 * l'indiscernabilité. Elle évite d'itérer à l'aveugle entre deux portes.
 *
 * ## La subtilité qui fait tout le travail
 *
 * Une réponse de 12 mots ne se compare pas à un profil de posts de 40 mots sur la longueur
 * médiane. Noter cette dimension donnerait une distance élevée pour une réponse parfaitement
 * dans le style — et le CRITIC rejetterait les bonnes réponses courtes.
 *
 * Chaque dimension déclare donc si elle est **applicable** au texte évalué. Les
 * non-applicables sont **écartées du calcul**, pas notées à zéro : les compter comme
 * conformes serait aussi faux que les compter comme divergentes.
 */
import type { VoiceFormStats } from '@/db/schema'
import { computeFormStats, splitSentences, splitWords } from './voice-profile'
import type { OwnPost } from '@/db/schema'

export interface DimensionScore {
  name: string
  /** Écart normalisé dans [0, 1]. */
  distance: number
  weight: number
  applicable: boolean
  /** Pourquoi la dimension a été écartée, pour le diagnostic. */
  skippedReason?: string
}

export interface VoiceDistanceResult {
  /** Distance globale dans [0, 1]. 0 = conforme au profil. */
  distance: number
  /** Nombre de dimensions ayant réellement contribué. */
  dimensionsUsed: number
  breakdown: DimensionScore[]
  /**
   * Faible si trop peu de dimensions étaient applicables. Un score calculé sur deux
   * dimensions n'a pas le même sens qu'un score calculé sur dix, et le CRITIC doit pouvoir
   * en tenir compte au lieu de traiter les deux comme équivalents.
   */
  reliability: number
}

/**
 * Longueur en dessous de laquelle les dimensions de structure ne sont pas comparables.
 *
 * Une réponse d'une phrase n'a ni rythme de paragraphe ni cadence de phrases : la comparer
 * sur ces axes mesurerait sa brièveté, pas sa conformité de style.
 */
const SHORT_TEXT_CHARS = 80

/** Poids par défaut. Les dimensions les plus discriminantes pèsent le plus. */
export interface DistanceWeights {
  length: number
  sentences: number
  wordLength: number
  emoji: number
  punctuation: number
  capitalization: number
  lineBreaks: number
  hashtags: number
  allCaps: number
}

export const DEFAULT_WEIGHTS: DistanceWeights = {
  // La longueur et la ponctuation portent l'essentiel de la reconnaissabilité perçue.
  length: 2,
  sentences: 1.5,
  punctuation: 2,
  emoji: 2,
  capitalization: 1.5,
  lineBreaks: 1,
  wordLength: 0.5,
  hashtags: 1,
  allCaps: 0.5,
}

/** Écart relatif borné à 1 — évite qu'une dimension aberrante écrase toutes les autres. */
function relativeGap(actual: number, expected: number, tolerance = 1): number {
  if (expected === 0) return actual === 0 ? 0 : Math.min(1, actual / tolerance)
  return Math.min(1, Math.abs(actual - expected) / (expected * tolerance))
}

/** Écart sur un taux dans [0, 1] : la différence absolue est déjà normalisée. */
function rateGap(actual: boolean, expectedRate: number): number {
  // Un taux de 0,5 ne prédit rien : l'écart doit être nul quel que soit le texte, sinon on
  // pénaliserait les deux comportements que le profil montre à parts égales.
  const expected = expectedRate
  return actual ? 1 - expected : expected
}

export function computeVoiceDistance(
  text: string,
  profile: VoiceFormStats,
  weights: DistanceWeights = DEFAULT_WEIGHTS,
): VoiceDistanceResult {
  const trimmed = text.trim()
  const isShort = trimmed.length < SHORT_TEXT_CHARS
  const hasProfile = profile.sampleSize > 0

  const breakdown: DimensionScore[] = []

  const push = (
    name: string,
    weight: number,
    distance: number,
    applicable: boolean,
    skippedReason?: string,
  ): void => {
    breakdown.push({
      name,
      weight,
      distance,
      applicable,
      ...(skippedReason !== undefined ? { skippedReason } : {}),
    })
  }

  if (!hasProfile) {
    // Aucun profil : la distance n'est pas nulle, elle est *inconnue*. Renvoyer 0 ferait
    // croire au CRITIC que la réponse est parfaitement dans le style.
    return { distance: 0.5, dimensionsUsed: 0, breakdown, reliability: 0 }
  }

  /* ── Longueur ─────────────────────────────────────────────────────────── */
  // Comparée à l'intervalle [p10, p90] du profil, pas à la médiane : un profil de posts
  // longs tolère des réponses courtes si l'utilisateur en écrit aussi.
  const inRange =
    trimmed.length >= profile.p10Length && trimmed.length <= profile.p90Length
  const lengthDistance = inRange
    ? 0
    : trimmed.length < profile.p10Length
      ? relativeGap(trimmed.length, profile.p10Length)
      : relativeGap(trimmed.length, profile.p90Length)
  push('length', weights.length, lengthDistance, true)

  /* ── Cadence des phrases ──────────────────────────────────────────────── */
  if (isShort) {
    push(
      'sentences',
      weights.sentences,
      0,
      false,
      'texte trop court pour avoir une cadence',
    )
  } else {
    const sentences = splitSentences(trimmed).length
    push(
      'sentences',
      weights.sentences,
      relativeGap(sentences, profile.avgSentencesPerPost),
      true,
    )
  }

  /* ── Longueur des mots ────────────────────────────────────────────────── */
  const words = splitWords(trimmed)
  if (words.length < 5) {
    push('wordLength', weights.wordLength, 0, false, 'moins de 5 mots')
  } else {
    const avg = words.reduce((a, w) => a + w.length, 0) / words.length
    push(
      'wordLength',
      weights.wordLength,
      relativeGap(avg, profile.avgWordLength, 0.5),
      true,
    )
  }

  /* ── Emojis ───────────────────────────────────────────────────────────── */
  // Applicable même sur un texte court : l'absence ou la présence d'un emoji est un signal
  // binaire fort, indépendant de la longueur.
  const hasEmoji = /\p{Extended_Pictographic}/u.test(trimmed)
  push('emoji', weights.emoji, rateGap(hasEmoji, profile.emojiRate), true)

  /* ── Ponctuation ──────────────────────────────────────────────────────── */
  const punctuationGaps = [
    rateGap(trimmed.includes('!'), profile.exclamationRate),
    rateGap(trimmed.includes('?'), profile.questionRate),
    rateGap(trimmed.includes('…') || trimmed.includes('...'), profile.ellipsisRate),
    rateGap(trimmed.includes('—'), profile.emDashRate),
    rateGap(trimmed.includes(';'), profile.semicolonRate),
  ]
  push(
    'punctuation',
    weights.punctuation,
    punctuationGaps.reduce((a, b) => a + b, 0) / punctuationGaps.length,
    true,
  )

  /* ── Capitalisation initiale ──────────────────────────────────────────── */
  const startsUpper = /^\p{Lu}/u.test(trimmed)
  push(
    'capitalization',
    weights.capitalization,
    startsUpper ? 1 - profile.capitalizedStartRate : 1 - profile.lowercaseStartRate,
    true,
  )

  /* ── Retours à la ligne ───────────────────────────────────────────────── */
  if (isShort) {
    push(
      'lineBreaks',
      weights.lineBreaks,
      0,
      false,
      'texte trop court pour un rythme de lignes',
    )
  } else {
    push(
      'lineBreaks',
      weights.lineBreaks,
      rateGap(trimmed.includes('\n'), profile.lineBreakRate),
      true,
    )
  }

  /* ── Hashtags ─────────────────────────────────────────────────────────── */
  push(
    'hashtags',
    weights.hashtags,
    rateGap(/(?:^|\s)#\w/u.test(trimmed), profile.hashtagRate),
    true,
  )

  /* ── Capitales emphatiques ────────────────────────────────────────────── */
  if (words.length < 5) {
    push('allCaps', weights.allCaps, 0, false, 'moins de 5 mots')
  } else {
    const capsWords = words.filter(
      (w) => w.length > 2 && w === w.toUpperCase() && /\p{L}/u.test(w),
    )
    push(
      'allCaps',
      weights.allCaps,
      relativeGap(capsWords.length / words.length, profile.allCapsWordRate, 2),
      true,
    )
  }

  /* ── Agrégation ───────────────────────────────────────────────────────── */
  const used = breakdown.filter((d) => d.applicable)
  const totalWeight = used.reduce((a, d) => a + d.weight, 0)
  const distance =
    totalWeight === 0
      ? 0.5
      : used.reduce((a, d) => a + d.distance * d.weight, 0) / totalWeight

  const allWeight = Object.values(weights).reduce((a, b) => a + b, 0)

  return {
    distance,
    dimensionsUsed: used.length,
    breakdown,
    reliability: allWeight === 0 ? 0 : totalWeight / allWeight,
  }
}

/**
 * Distance entre un texte et un corpus de référence.
 * Utilitaire de test et de calibration : recalcule les statistiques du corpus à la volée.
 */
export function distanceFromCorpus(
  text: string,
  corpus: readonly OwnPost[],
): VoiceDistanceResult {
  return computeVoiceDistance(text, computeFormStats(corpus))
}

/** Étiquette lisible, affichée dans le Flux à côté de chaque variante. */
export function describeDistance(result: VoiceDistanceResult): string {
  if (result.reliability < 0.4) return 'voix : indéterminable'
  if (result.distance < 0.2) return 'voix : très proche'
  if (result.distance < 0.35) return 'voix : proche'
  if (result.distance < 0.55) return 'voix : approximative'
  return 'voix : éloignée'
}
