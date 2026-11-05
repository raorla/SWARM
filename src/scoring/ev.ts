/**
 * SCORE D'OPPORTUNITÉ — différenciateur n°4.
 *
 * ```
 * EV = portée × pertinence_niche × fraîcheur × (1 / saturation) × affinité_auteur
 * ```
 *
 * La formule de la spec est un **produit**. C'est un choix fort et il faut en voir la
 * conséquence : un facteur nul annule tout. Un post hors niche à portée immense vaut zéro,
 * et c'est voulu — répondre à côté du sujet ne rapporte rien, quelle que soit l'audience.
 *
 * ## Ce que le produit implique, et comment on le corrige sans le trahir
 *
 * Un produit de cinq facteurs dans [0, 1] s'écrase vers zéro : cinq facteurs à 0,6 donnent
 * 0,078. Les scores deviennent alors indistinguables et le classement perd sa résolution
 * dans le bas de l'échelle, là où se trouve la majorité des posts.
 *
 * On applique donc une **moyenne géométrique pondérée** : la racine n-ième du produit des
 * facteurs élevés à leurs poids. Elle conserve la propriété essentielle du produit — un
 * facteur nul annule tout — tout en gardant un résultat à l'échelle des facteurs. Cinq
 * facteurs à 0,6 donnent 0,6, ce qui est la seule lecture intuitive.
 *
 * ## Pourquoi tout est décomposé
 *
 * La spec exige une formule « visible et réglable ». `ScoreBreakdown` conserve chaque facteur
 * *et* sa contribution au résultat, pour que l'onglet Flux puisse répondre à « pourquoi ce
 * post et pas l'autre » sans que l'utilisateur ait à refaire le calcul.
 */
import type { EvWeights, NichePack } from '@/niches/pack.schema'
import { computeFreshness, type FreshnessInput } from './freshness'
import { computeSaturation, type SaturationInput } from './saturation'

export interface EvFactors {
  /** Portée estimée, dans [0, 1]. */
  reach: number
  /** Pertinence de niche, dans [0, 1]. Vient du QUALIFIER, pas d'un calcul local. */
  nicheRelevance: number
  /** Fraîcheur, dans [0, 1]. */
  freshness: number
  /** Facteur de saturation **déjà inversé** : 1 = conversation vierge, 0 = saturée. */
  saturationInverse: number
  /** Affinité auteur, dans [0, 1]. */
  authorAffinity: number
}

export interface FactorContribution {
  name: keyof EvFactors
  value: number
  weight: number
  /** Part du score final imputable à ce facteur, dans [0, 1]. */
  share: number
  /** Explication en langue naturelle, affichée dans le décomposé du Flux. */
  reason: string
}

export interface ScoreBreakdown {
  ev: number
  factors: EvFactors
  contributions: FactorContribution[]
  /** Facteur qui a le plus tiré le score vers le bas — la réponse à « pourquoi si bas ? ». */
  limitingFactor: keyof EvFactors
  /** Renseigné si un facteur nul a annulé le score. */
  vetoedBy: keyof EvFactors | null
}

/** Sous ce seuil, un facteur est traité comme nul et annule le score. */
export const ZERO_EPSILON = 0.001

const FACTOR_KEYS: readonly (keyof EvFactors)[] = [
  'reach',
  'nicheRelevance',
  'freshness',
  'saturationInverse',
  'authorAffinity',
]

/** Correspondance facteur → poids configuré. `saturationPenalty` pilote l'inverse. */
function weightOf(weights: EvWeights, key: keyof EvFactors): number {
  switch (key) {
    case 'reach':
      return weights.reach
    case 'nicheRelevance':
      return weights.nicheRelevance
    case 'freshness':
      return weights.freshness
    case 'saturationInverse':
      return weights.saturationPenalty
    case 'authorAffinity':
      return weights.authorAffinity
  }
}

const clamp01 = (value: number): number =>
  Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0

/**
 * Calcule le score EV et son décomposé.
 *
 * Toujours défini : un facteur `NaN` est ramené à 0 plutôt que de propager un `NaN` dans le
 * classement, où il rendrait tout le tri instable sans qu'on sache pourquoi.
 */
export function computeEv(factors: EvFactors, weights: EvWeights): ScoreBreakdown {
  const safe: EvFactors = {
    reach: clamp01(factors.reach),
    nicheRelevance: clamp01(factors.nicheRelevance),
    freshness: clamp01(factors.freshness),
    saturationInverse: clamp01(factors.saturationInverse),
    authorAffinity: clamp01(factors.authorAffinity),
  }

  // Un facteur nul annule tout — la propriété du produit qu'on conserve délibérément.
  const vetoedBy = FACTOR_KEYS.find((key) => safe[key] < ZERO_EPSILON) ?? null

  const totalWeight = FACTOR_KEYS.reduce(
    (sum, key) => sum + Math.max(0, weightOf(weights, key)),
    0,
  )

  let ev: number
  if (vetoedBy !== null) {
    ev = 0
  } else if (totalWeight <= 0) {
    // Tous les poids à zéro : aucune préférence exprimée. On renvoie la moyenne simple
    // plutôt que zéro — l'utilisateur n'a pas dit « rien ne compte », il n'a rien dit.
    ev = FACTOR_KEYS.reduce((sum, key) => sum + safe[key], 0) / FACTOR_KEYS.length
  } else {
    // Moyenne géométrique pondérée : exp(Σ wᵢ·ln(xᵢ) / Σ wᵢ).
    const logSum = FACTOR_KEYS.reduce(
      (sum, key) => sum + Math.max(0, weightOf(weights, key)) * Math.log(safe[key]),
      0,
    )
    ev = Math.exp(logSum / totalWeight)
  }

  const contributions: FactorContribution[] = FACTOR_KEYS.map((key) => {
    const weight = Math.max(0, weightOf(weights, key))
    return {
      name: key,
      value: safe[key],
      weight,
      // Part du poids total : c'est l'influence *potentielle* du facteur, celle que
      // l'utilisateur règle. La valeur observée est fournie à côté.
      share: totalWeight <= 0 ? 1 / FACTOR_KEYS.length : weight / totalWeight,
      reason: explainFactor(key, safe[key]),
    }
  })

  // Le facteur limitant est celui dont le déficit pondéré est le plus fort : c'est la
  // réponse à « pourquoi ce score est-il si bas ? », qui n'est pas la même question que
  // « quel facteur est le plus faible ».
  const limitingFactor = FACTOR_KEYS.reduce((worst, key) => {
    const deficit = (1 - safe[key]) * Math.max(0, weightOf(weights, key))
    const worstDeficit = (1 - safe[worst]) * Math.max(0, weightOf(weights, worst))
    return deficit > worstDeficit ? key : worst
  }, FACTOR_KEYS[0]!)

  return { ev: clamp01(ev), factors: safe, contributions, limitingFactor, vetoedBy }
}

/* ──────────────────────────────── Portée ─────────────────────────────────── */

export interface ReachInput {
  /** Abonnés de l'auteur, ou `null` si inconnu — le fil ne l'expose pas. */
  authorFollowers: number | null
  likeCount: number | null
  repostCount: number | null
  replyCount: number | null
}

/**
 * Portée estimée.
 *
 * On ne connaît pas les impressions avant publication. Deux signaux imparfaits :
 *
 *  - **l'audience de l'auteur**, qui borne la portée potentielle ;
 *  - **l'engagement observé**, qui révèle la portée *réelle* — un post à 500 likes chez un
 *    compte de 2 000 abonnés a débordé de son audience, et c'est un meilleur signal que le
 *    nombre d'abonnés.
 *
 * L'engagement pèse donc davantage que les abonnés. Échelle logarithmique dans les deux cas :
 * la différence entre 100 et 1 000 abonnés compte plus que celle entre 100 000 et 101 000.
 */
export function computeReach(input: ReachInput): number {
  const engagement =
    (input.likeCount ?? 0) + 2 * (input.repostCount ?? 0) + (input.replyCount ?? 0)

  // log10 normalisé sur 10 000 : au-delà, on est dans le très viral et la distinction
  // n'apporte plus rien au classement.
  const engagementScore = Math.min(1, Math.log10(1 + engagement) / 4)

  if (input.authorFollowers === null) {
    // Sans nombre d'abonnés, l'engagement porte seul le signal. On ne devine pas une
    // audience : une valeur inventée ferait un classement confiant et faux.
    return engagementScore
  }

  const followerScore = Math.min(1, Math.log10(1 + input.authorFollowers) / 6)
  return clamp01(0.65 * engagementScore + 0.35 * followerScore)
}

/* ────────────────────────────── Affinité auteur ──────────────────────────── */

export interface AffinityInput {
  /** Familiarité 0–5 de la mémoire relationnelle, ou `null` si compte inconnu. */
  warmth: number | null
  /** Nombre d'interactions passées. */
  interactionCount: number
  /** Nombre de fois où ce compte a ignoré nos réponses. */
  ignoredCount: number
  /** Vrai si le compte est dans la watchlist du pack. */
  onWatchlist: boolean
  /** Instant de la dernière interaction, pour éviter de harceler. */
  lastInteractionMs: number | null
  nowMs: number
}

/** En dessous de ce délai, réinteragir avec le même compte est du harcèlement. */
export const AFFINITY_COOLDOWN_MS = 20 * 60 * 60 * 1000

/**
 * Affinité auteur.
 *
 * Un compte inconnu n'est pas un mauvais compte : il vaut une valeur neutre, pas zéro. Un
 * produit qui ne parlerait qu'aux comptes déjà connus ne ferait jamais grandir un réseau.
 *
 * En revanche, un compte avec qui on vient d'interagir tombe à zéro pendant la période de
 * refroidissement — c'est ce facteur qui empêche le produit de devenir un reply guy sur
 * trois comptes.
 */
export function computeAuthorAffinity(input: AffinityInput): number {
  if (
    input.lastInteractionMs !== null &&
    input.nowMs - input.lastInteractionMs < AFFINITY_COOLDOWN_MS
  ) {
    // Facteur nul, donc score nul : le produit du EV s'annule et l'opportunité sort de la
    // file. C'est l'effet voulu, pas un effet de bord.
    return 0
  }

  if (input.onWatchlist) return 1

  if (input.warmth === null) {
    // Compte inconnu : neutre. Ni pénalisé, ni favorisé.
    return 0.5
  }

  const warmthScore = Math.min(1, input.warmth / 5)
  // Être ignoré est un signal fort et rapide : trois réponses ignorées suffisent à
  // désinvestir un compte.
  const ignorePenalty = Math.min(0.6, input.ignoredCount * 0.2)
  return clamp01(0.35 + 0.65 * warmthScore - ignorePenalty)
}

/* ─────────────────────────────── Explications ────────────────────────────── */

function explainFactor(key: keyof EvFactors, value: number): string {
  const pct = (value * 100).toFixed(0)
  switch (key) {
    case 'reach':
      return value > 0.6
        ? `portée large (${pct} %) — le post circule`
        : value > 0.3
          ? `portée moyenne (${pct} %)`
          : `portée faible (${pct} %) — peu de monde le verra`
    case 'nicheRelevance':
      return value > 0.7
        ? `en plein dans la niche (${pct} %)`
        : value > 0.4
          ? `en marge de la niche (${pct} %)`
          : `hors niche (${pct} %)`
    case 'freshness':
      return value > 0.7
        ? `frais (${pct} %) — la conversation est vivante`
        : value > 0.3
          ? `déjà entamé (${pct} %)`
          : `trop vieux (${pct} %) — répondre coûte sans rapporter`
    case 'saturationInverse':
      return value > 0.7
        ? `peu de réponses (${pct} %) — de la place pour être lu`
        : value > 0.3
          ? `conversation chargée (${pct} %)`
          : `saturé (${pct} %) — notre réponse serait noyée`
    case 'authorAffinity':
      return value < ZERO_EPSILON
        ? 'interaction trop récente avec ce compte'
        : value > 0.8
          ? `compte suivi de près (${pct} %)`
          : value > 0.4
            ? `relation à construire (${pct} %)`
            : `compte peu réceptif (${pct} %)`
  }
}

/** Phrase unique résumant le score, pour la carte du Flux. */
export function describeScore(breakdown: ScoreBreakdown): string {
  if (breakdown.vetoedBy !== null) {
    const contribution = breakdown.contributions.find(
      (c) => c.name === breakdown.vetoedBy,
    )
    return `Écarté : ${contribution?.reason ?? breakdown.vetoedBy}`
  }
  const limiting = breakdown.contributions.find(
    (c) => c.name === breakdown.limitingFactor,
  )
  return `EV ${(breakdown.ev * 100).toFixed(0)} % — limité par ${limiting?.reason ?? 'un facteur'}`
}

/* ────────────────────────── Assemblage de bout en bout ───────────────────── */

export interface ScoreOpportunityInput {
  reach: ReachInput
  /** Pertinence de niche, produite par le QUALIFIER. */
  nicheRelevance: number
  freshness: FreshnessInput
  saturation: SaturationInput
  affinity: AffinityInput
  pack: NichePack
}

/** Calcule le score complet d'une opportunité, décomposé compris. */
export function scoreOpportunity(input: ScoreOpportunityInput): ScoreBreakdown {
  return computeEv(
    {
      reach: computeReach(input.reach),
      nicheRelevance: input.nicheRelevance,
      freshness: computeFreshness(input.freshness, input.pack.thresholds.maxAgeMinutes),
      saturationInverse: computeSaturation(
        input.saturation,
        input.pack.thresholds.maxReplyCount,
      ),
      authorAffinity: computeAuthorAffinity(input.affinity),
    },
    input.pack.evWeights,
  )
}
