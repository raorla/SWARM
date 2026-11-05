/**
 * CALIBRATION du seuil de veto du CRITIC.
 *
 * Un CRITIC qui rejette 95 % ou 5 % est inutile, et c'est l'état par défaut d'un juge LLM
 * non calibré. `DEFAULT_VETO_THRESHOLD = 0.6` est un point de départ, pas une vérité : ce
 * module le remplace par une valeur **mesurée**.
 *
 * ## Comment on mesure sans vérité terrain absolue
 *
 * On constitue un jeu de réponses **étiquetées à la main** — « celle-là mérite d'être
 * publiée », « celle-là non » — puis on fait noter ce jeu par le CRITIC et on balaie les
 * seuils. Le meilleur seuil est celui qui maximise l'accord avec les étiquettes.
 *
 * ## Pourquoi l'asymétrie du coût compte
 *
 * Les deux erreurs ne coûtent pas la même chose :
 *
 *  - **Faux positif** (on publie une mauvaise réponse) : coûte de la crédibilité, et c'est
 *    irréversible — le post est vu.
 *  - **Faux négatif** (on rejette une bonne réponse) : coûte une occasion, et il y en aura
 *    d'autres demain.
 *
 * Le score de sélection pénalise donc les faux positifs plus lourdement. Optimiser une
 * exactitude symétrique reviendrait à traiter la réputation de l'utilisateur comme aussi
 * remplaçable qu'une opportunité manquée.
 */
import { MAX_REPUTATION_RISK, type CriticScore } from '../schemas/critic.io'

/** Une réponse étiquetée à la main, avec la note que le CRITIC lui a donnée. */
export interface LabelledSample {
  id: string
  text: string
  /** Vérité terrain : cette réponse mérite-t-elle d'être proposée ? */
  shouldPass: boolean
  /** Notation produite par le CRITIC sur cet échantillon. */
  score: CriticScore
  /** Pourquoi l'étiquette est celle-là — sert aux désaccords, et à la relecture humaine. */
  rationale: string
}

export interface ThresholdOutcome {
  threshold: number
  truePositives: number
  falsePositives: number
  trueNegatives: number
  falseNegatives: number
  rejectionRate: number
  /** Part des réponses publiées qui méritaient de l'être. */
  precision: number
  /** Part des bonnes réponses effectivement retenues. */
  recall: number
  /** Score de sélection, faux positifs pénalisés — voir l'en-tête du module. */
  weightedScore: number
}

export interface CalibrationReport {
  sampleSize: number
  positives: number
  negatives: number
  outcomes: ThresholdOutcome[]
  /** Seuil retenu. */
  recommended: ThresholdOutcome
  /** Diagnostic en langue naturelle, destiné au journal de calibration. */
  verdict: string
}

/**
 * Poids du faux positif relativement au faux négatif.
 *
 * 3 : publier une mauvaise réponse coûte environ trois fois plus qu'en rater une bonne.
 * Chiffre assumé et discutable — il est ici pour être discuté, pas caché dans une moyenne.
 */
export const FALSE_POSITIVE_WEIGHT = 3

/** Le seuil retenu doit garder un taux de rejet dans une plage exploitable. */
export const ACCEPTABLE_REJECTION_RANGE = { min: 0.15, max: 0.75 } as const

/**
 * Décide si un échantillon passerait à un seuil donné.
 *
 * Reproduit exactement la logique de `applyThreshold`, plafond de risque compris : calibrer
 * sur une règle différente de celle appliquée en production ne mesurerait rien.
 */
function passesAt(score: CriticScore, threshold: number): boolean {
  return score.overall >= threshold && score.reputationRisk <= MAX_REPUTATION_RISK
}

export function evaluateThreshold(
  samples: readonly LabelledSample[],
  threshold: number,
): ThresholdOutcome {
  let tp = 0
  let fp = 0
  let tn = 0
  let fn = 0

  for (const sample of samples) {
    const passes = passesAt(sample.score, threshold)
    if (passes && sample.shouldPass) tp += 1
    else if (passes && !sample.shouldPass) fp += 1
    else if (!passes && !sample.shouldPass) tn += 1
    else fn += 1
  }

  const published = tp + fp
  const actualPositives = tp + fn

  return {
    threshold,
    truePositives: tp,
    falsePositives: fp,
    trueNegatives: tn,
    falseNegatives: fn,
    rejectionRate: samples.length === 0 ? 0 : (tn + fn) / samples.length,
    // Précision de 1 quand rien n'est publié : arbitraire, mais cohérent — on n'a publié
    // aucune erreur. Le taux de rejet, lui, disqualifiera ce seuil.
    precision: published === 0 ? 1 : tp / published,
    recall: actualPositives === 0 ? 1 : tp / actualPositives,
    weightedScore:
      samples.length === 0
        ? 0
        : (tp + tn) / samples.length -
          (FALSE_POSITIVE_WEIGHT * fp + fn) /
            (samples.length * (FALSE_POSITIVE_WEIGHT + 1)),
  }
}

/**
 * Balaie les seuils et recommande le meilleur.
 *
 * Deux garde-fous sur la recommandation, parce qu'un score maximal peut désigner un seuil
 * absurde :
 *
 *  - **Taux de rejet dans une plage exploitable.** Un seuil qui rejette 98 % obtient un
 *    excellent score de sélection — il ne publie jamais d'erreur — et rend le produit
 *    inutile.
 *  - **À score égal, le seuil le plus élevé gagne.** L'égalité signifie que le jeu
 *    d'échantillons ne distingue pas les deux ; préférer le plus sévère est le choix prudent.
 */
export function calibrate(
  samples: readonly LabelledSample[],
  step = 0.05,
): CalibrationReport {
  const thresholds: number[] = []
  for (let t = 0; t <= 1.0001; t += step) thresholds.push(Math.round(t * 100) / 100)

  const outcomes = thresholds.map((t) => evaluateThreshold(samples, t))
  const positives = samples.filter((s) => s.shouldPass).length

  if (samples.length === 0) {
    return {
      sampleSize: 0,
      positives: 0,
      negatives: 0,
      outcomes,
      recommended: evaluateThreshold([], 0.6),
      verdict: 'aucun échantillon : le seuil par défaut est conservé, non mesuré',
    }
  }

  const exploitable = outcomes.filter(
    (o) =>
      o.rejectionRate >= ACCEPTABLE_REJECTION_RANGE.min &&
      o.rejectionRate <= ACCEPTABLE_REJECTION_RANGE.max,
  )

  const pool = exploitable.length > 0 ? exploitable : outcomes
  const recommended = pickFromPlateau(pool)

  return {
    sampleSize: samples.length,
    positives,
    negatives: samples.length - positives,
    outcomes,
    recommended,
    verdict: buildVerdict(samples.length, recommended, exploitable.length === 0),
  }
}

/**
 * Choisit le **milieu du plateau** de meilleur score, pas son bord.
 *
 * ## Pourquoi ce n'est pas un détail
 *
 * Plusieurs seuils donnent presque toujours exactement le même score : entre deux notes
 * observées, rien ne change. La première version prenait le **plus haut** seuil de ce plateau,
 * en se disant qu'un seuil sévère est prudent.
 *
 * La calibration réelle du 2026-08-26 a montré le problème. Le plateau allait de 0,30 à 0,55
 * avec un score identique de 0,931 ; le seuil suivant, 0,60, faisait tomber le rappel de 83 % à
 * **17 %** — cinq bonnes réponses sur six rejetées. Recommander 0,55, c'était donc recommander
 * un seuil collé à une falaise : la moindre dérive de notation du modèle, une mise à jour
 * amont, un prompt retouché, et le produit refuse tout.
 *
 * Le milieu du plateau a le même score mesuré et la plus grande marge des deux côtés. C'est le
 * choix robuste, et « robuste » est ici la seule qualité qui compte : un seuil se règle sur des
 * données qui bougeront.
 */
function pickFromPlateau(pool: readonly ThresholdOutcome[]): ThresholdOutcome {
  const best = pool.reduce((a, b) => (b.weightedScore > a.weightedScore ? b : a))

  // Tolérance : deux scores à 1e-9 près sont le même score. Comparer des flottants à l'égalité
  // stricte ferait dépendre le résultat de l'ordre des additions.
  const plateau = pool.filter((o) => Math.abs(o.weightedScore - best.weightedScore) < 1e-9)
  const middle = plateau[Math.floor((plateau.length - 1) / 2)]
  return middle ?? best
}

function buildVerdict(
  sampleSize: number,
  best: ThresholdOutcome,
  noExploitableRange: boolean,
): string {
  const parts = [
    `seuil ${best.threshold.toFixed(2)}`,
    `rejet ${(best.rejectionRate * 100).toFixed(0)} %`,
    `précision ${(best.precision * 100).toFixed(0)} %`,
    `rappel ${(best.recall * 100).toFixed(0)} %`,
  ]

  if (sampleSize < 20) {
    // Un seuil calibré sur douze exemples est un seuil deviné avec plus de cérémonie.
    parts.push(`⚠ échantillon de ${sampleSize} : indicatif seulement, viser 40+`)
  }
  if (noExploitableRange) {
    parts.push(
      '⚠ aucun seuil ne donne un taux de rejet exploitable — revoir le prompt du CRITIC',
    )
  }
  if (best.recall < 0.5 && best.falsePositives === 0) {
    // Un rappel effondré sans faux positif est le symptôme d'un seuil trop sévère : le CRITIC
    // ne se trompe pas, il refuse tout. C'est le mode de défaillance que D-11 prévoyait.
    parts.push(
      `⚠ rappel ${(best.recall * 100).toFixed(0)} % : le seuil rejette presque toutes les bonnes réponses`,
    )
  }
  if (best.falsePositives > 0) {
    parts.push(
      `${best.falsePositives} faux positif(s) subsistant(s) : autant de mauvaises réponses publiables`,
    )
  }
  return parts.join(' · ')
}

/**
 * Détecte une notation dégénérée.
 *
 * Le mode de défaillance le plus courant d'un juge LLM n'est pas de se tromper, c'est de
 * **ne pas discriminer** : tout noter entre 0,7 et 0,8. Aucun seuil ne rattrape ça, et un
 * balayage donnerait quand même une recommandation d'apparence sérieuse. On le détecte donc
 * explicitement, avant de faire confiance au seuil.
 */
export function detectFlatScoring(samples: readonly LabelledSample[]): {
  isFlat: boolean
  spread: number
  separation: number
  detail: string
} {
  if (samples.length < 3) {
    return {
      isFlat: false,
      spread: 0,
      separation: 0,
      detail: 'échantillon trop petit pour juger la discrimination',
    }
  }
  const scores = samples.map((s) => s.score.overall)
  const spread = Math.max(...scores) - Math.min(...scores)

  // L'écart entre les notes moyennes des bons et des mauvais compte plus que l'étendue
  // brute : une notation étalée mais non corrélée aux étiquettes est tout aussi inutile.
  const avg = (xs: readonly number[]): number =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
  const good = samples.filter((s) => s.shouldPass).map((s) => s.score.overall)
  const bad = samples.filter((s) => !s.shouldPass).map((s) => s.score.overall)
  const separation = good.length > 0 && bad.length > 0 ? avg(good) - avg(bad) : 0

  const isFlat = spread < 0.2 || separation < 0.1

  return {
    isFlat,
    spread,
    separation,
    detail: isFlat
      ? `notation peu discriminante : étendue ${spread.toFixed(2)}, séparation bons/mauvais ${separation.toFixed(2)} — revoir le prompt du CRITIC avant le seuil`
      : `notation discriminante : étendue ${spread.toFixed(2)}, séparation ${separation.toFixed(2)}`,
  }
}

/** Rapport formaté, destiné à `docs/critic-calibration-<date>.md`. */
export function formatReport(
  report: CalibrationReport,
  flat: ReturnType<typeof detectFlatScoring>,
): string {
  const rows = report.outcomes
    .filter((o) => o.threshold >= 0.3 && o.threshold <= 0.9)
    .map(
      (o) =>
        `| ${o.threshold.toFixed(2)} | ${(o.rejectionRate * 100).toFixed(0)} % | ${(o.precision * 100).toFixed(0)} % | ${(o.recall * 100).toFixed(0)} % | ${o.falsePositives} | ${o.falseNegatives} | ${o.weightedScore.toFixed(3)} |`,
    )
    .join('\n')

  return [
    '# Calibration du seuil de veto du CRITIC',
    '',
    `Échantillon : ${report.sampleSize} réponses étiquetées (${report.positives} à publier, ${report.negatives} à rejeter).`,
    '',
    `**Diagnostic de notation** : ${flat.detail}`,
    '',
    `**Seuil recommandé** : ${report.verdict}`,
    '',
    '| seuil | rejet | précision | rappel | faux + | faux − | score |',
    '|---|---|---|---|---|---|---|',
    rows,
    '',
    `Faux positifs pondérés ×${FALSE_POSITIVE_WEIGHT} : publier une mauvaise réponse coûte de`,
    'la crédibilité et c’est irréversible ; en rater une bonne coûte une occasion, et il y en',
    'aura d’autres demain.',
  ].join('\n')
}
