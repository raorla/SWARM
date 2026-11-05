/**
 * Explication d'un score, pour le décomposé cliquable de l'onglet Flux (SPEC §6).
 *
 * L'exigence n'est pas cosmétique. Un score opaque ne se règle pas : l'utilisateur qui voit
 * passer un post qu'il aurait voulu traiter doit pouvoir lire *quel* facteur l'a écarté, et
 * corriger le poids correspondant. Sans ça, les curseurs de l'onglet Config sont décoratifs.
 */
import type { EvFactors, ScoreBreakdown } from './ev'

export const FACTOR_LABELS: Record<keyof EvFactors, string> = {
  reach: 'Portée',
  nicheRelevance: 'Pertinence de niche',
  freshness: 'Fraîcheur',
  saturationInverse: 'Place disponible',
  authorAffinity: 'Affinité auteur',
}

export interface ExplainedFactor {
  key: keyof EvFactors
  label: string
  /** Valeur du facteur, en pourcentage entier. */
  valuePct: number
  /** Poids configuré. */
  weight: number
  /** Part du poids total, en pourcentage entier. */
  sharePct: number
  reason: string
  /** Vrai si c'est ce facteur qui limite le plus le score. */
  isLimiting: boolean
  /** Vrai si c'est ce facteur qui a annulé le score. */
  isVeto: boolean
}

export interface ExplainedScore {
  evPct: number
  headline: string
  factors: ExplainedFactor[]
  /** Conseil de réglage, quand il y en a un d'utile à donner. */
  tuningHint: string | null
}

export function explainScore(breakdown: ScoreBreakdown): ExplainedScore {
  const factors: ExplainedFactor[] = breakdown.contributions.map((c) => ({
    key: c.name,
    label: FACTOR_LABELS[c.name],
    valuePct: Math.round(c.value * 100),
    weight: c.weight,
    sharePct: Math.round(c.share * 100),
    reason: c.reason,
    isLimiting: c.name === breakdown.limitingFactor,
    isVeto: c.name === breakdown.vetoedBy,
  }))

  return {
    evPct: Math.round(breakdown.ev * 100),
    headline: buildHeadline(breakdown),
    factors,
    tuningHint: buildTuningHint(breakdown),
  }
}

function buildHeadline(breakdown: ScoreBreakdown): string {
  if (breakdown.vetoedBy !== null) {
    const label = FACTOR_LABELS[breakdown.vetoedBy]
    return `Écarté par « ${label} » — un facteur nul annule le score, c’est voulu.`
  }
  const limiting = FACTOR_LABELS[breakdown.limitingFactor]
  const pct = Math.round(breakdown.ev * 100)
  if (pct >= 70) return `Score élevé (${pct} %). Frein principal : ${limiting}.`
  if (pct >= 40) return `Score moyen (${pct} %), tiré vers le bas par ${limiting}.`
  return `Score faible (${pct} %), essentiellement à cause de ${limiting}.`
}

/**
 * Conseil de réglage.
 *
 * Volontairement rare : un conseil affiché à chaque carte devient du bruit. On n'en donne un
 * que quand le facteur limitant est réglable et que le déficit est net.
 */
function buildTuningHint(breakdown: ScoreBreakdown): string | null {
  if (breakdown.vetoedBy !== null) {
    switch (breakdown.vetoedBy) {
      case 'authorAffinity':
        return 'Tu as interagi avec ce compte récemment. La période de refroidissement évite de devenir un reply guy.'
      case 'freshness':
        return 'Post trop vieux pour le seuil du pack. Augmente « âge maximum » si ta niche a des conversations lentes.'
      case 'saturationInverse':
        return 'Conversation saturée. Augmente « réponses maximum » si tu veux quand même y aller.'
      case 'nicheRelevance':
        return 'Jugé hors niche. Si c’est une erreur, enrichis les mots-clés du pack.'
      case 'reach':
        return null
    }
  }

  const limiting = breakdown.contributions.find(
    (c) => c.name === breakdown.limitingFactor,
  )
  if (!limiting || limiting.value > 0.4) return null

  switch (breakdown.limitingFactor) {
    case 'reach':
      return 'Baisse le poids de « portée » si tu préfères les petites conversations aux grandes.'
    case 'nicheRelevance':
      return 'Enrichis les mots-clés du pack si ce post te semble pertinent malgré la note.'
    case 'freshness':
      return 'Augmente « âge maximum » si tu réponds volontiers à des posts plus anciens.'
    case 'saturationInverse':
      return 'Augmente « réponses maximum » si être noyé ne te dérange pas.'
    case 'authorAffinity':
      return 'Ajoute ce compte à ta watchlist si tu veux le suivre de près.'
  }
}
