/**
 * RÉINJECTION des patterns dans les prompts — le maillon qui ferme la boucle.
 *
 * SPEC §4.7 : « Réinjecte le top 5 et le flop 5 dans les prompts de STRATEGIST et WRITER à
 * chaque cycle ». C'est le point où la mesure change le comportement, et donc le seul endroit
 * où le différenciateur n°2 devient vérifiable.
 *
 * ## Deux règles qui décident si l'apprentissage aide ou nuit
 *
 *  1. **Ne rien affirmer sans données.** Sous le seuil d'échantillon, le bloc dit
 *     explicitement qu'il n'y a pas encore de signal. Un prompt qui affirme « les
 *     contre-arguments marchent mieux » sur trois observations ferait converger le WRITER sur
 *     du bruit — et la convergence rendrait la mesure auto-réalisatrice.
 *  2. **Décrire, pas commander.** « Les réponses courtes ont fait +40 % » laisse le modèle
 *     juger ; « écris court » lui retire l'arbitrage. Sur un signal corrélationnel et
 *     bruité, la première formulation est la seule honnête.
 */
import type { PatternDigest, RankedPattern } from './aggregate'
import { MIN_SAMPLE_SIZE } from './aggregate'

/** Libellés lisibles des dimensions, pour le prompt et l'UI. */
const DIMENSION_LABELS: Record<string, string> = {
  angle: 'angle',
  length: 'longueur',
  hour: 'moment de la journée',
  weekday: 'jour',
  authorTier: 'taille du compte',
}

/**
 * Bloc de patterns, destiné au préfixe **cachable** des prompts.
 *
 * Il ne change qu'après une agrégation — donc au plus une fois par cycle de mesure, pas à
 * chaque appel. C'est ce qui permet de le mettre en cache : le placer dans la partie variable
 * invaliderait le préfixe à chaque rédaction et tripleraient le coût d'entrée.
 */
export function buildPatternBlock(digest: PatternDigest): string {
  if (digest.insufficient) {
    return [
      '## Performances passées',
      '',
      `Pas encore de signal exploitable (${digest.sampleSize} réponses mesurées, il en faut au`,
      `moins ${MIN_SAMPLE_SIZE} par catégorie). N'infère rien de l'historique : écris ce qui te`,
      'semble juste, et le système apprendra de tes choix.',
    ].join('\n')
  }

  const lines = [
    '## Performances passées',
    '',
    `Mesuré sur ${digest.sampleSize} réponses publiées. Engagement moyen de référence :`,
    `${digest.globalAverage.toFixed(1)}.`,
    '',
    'Ces écarts sont **corrélationnels**, mesurés sur un échantillon modeste. Traite-les comme',
    'une indication, pas comme une consigne : si un angle mieux adapté au post contredit ces',
    'chiffres, suis le post.',
  ]

  if (digest.top.length > 0) {
    lines.push('', '### Ce qui a mieux marché', ...digest.top.map(describePattern))
  }
  if (digest.flop.length > 0) {
    lines.push('', '### Ce qui a moins bien marché', ...digest.flop.map(describePattern))
  }

  return lines.join('\n')
}

/**
 * Une ligne de pattern.
 *
 * La taille d'échantillon et la confiance sont **dans la ligne**, pas en note de bas de page :
 * un modèle qui lit « +40 % » sans voir « sur 9 observations » traitera le chiffre comme une
 * loi.
 */
function describePattern(pattern: RankedPattern): string {
  const label = DIMENSION_LABELS[pattern.dimension] ?? pattern.dimension
  const sign = pattern.liftPct >= 0 ? '+' : ''
  const strength =
    pattern.confidence > 0.6 ? 'signal net' : pattern.confidence > 0.35 ? 'tendance' : 'signal faible'
  return `- ${label} « ${pattern.value} » : ${sign}${pattern.liftPct.toFixed(0)} % (n=${pattern.sampleSize}, ${strength})`
}

/**
 * Empreinte du digest.
 *
 * Sert deux choses : détecter qu'un cycle d'apprentissage a **effectivement changé** les
 * prompts — le DoD de la Phase 5 — et invalider le cache de prompt au bon moment. Une
 * empreinte qui bougerait sans que le contenu change invaliderait le cache pour rien.
 */
export function digestFingerprint(digest: PatternDigest): string {
  if (digest.insufficient) return 'insufficient'
  const parts = [...digest.top, ...digest.flop].map(
    (p) => `${p.dimension}:${p.value}:${p.liftPct.toFixed(0)}`,
  )
  return parts.length === 0 ? 'empty' : parts.join('|')
}

/**
 * Le digest a-t-il changé le comportement ?
 *
 * C'est la question exacte du DoD de la Phase 5 : « les prompts changent démontrablement en
 * fonction des performances passées ». Comparer deux empreintes y répond par oui ou non,
 * ce qu'une inspection visuelle ne fait pas.
 */
export function hasLearned(
  before: PatternDigest,
  after: PatternDigest,
): { changed: boolean; from: string; to: string } {
  const from = digestFingerprint(before)
  const to = digestFingerprint(after)
  return { changed: from !== to, from, to }
}

/** Résumé pour l'onglet Analytics. */
export function describeDigest(digest: PatternDigest): string {
  if (digest.insufficient) {
    return `Pas encore de signal : ${digest.sampleSize} réponses mesurées, il en faut ${MIN_SAMPLE_SIZE} par catégorie.`
  }
  const best = digest.top[0]
  const worst = digest.flop[0]
  const parts: string[] = [`${digest.sampleSize} réponses mesurées`]
  if (best) {
    parts.push(
      `meilleur : ${DIMENSION_LABELS[best.dimension] ?? best.dimension} « ${best.value} » à +${best.liftPct.toFixed(0)} %`,
    )
  }
  if (worst) {
    parts.push(
      `pire : ${DIMENSION_LABELS[worst.dimension] ?? worst.dimension} « ${worst.value} » à ${worst.liftPct.toFixed(0)} %`,
    )
  }
  return parts.join(' · ')
}
