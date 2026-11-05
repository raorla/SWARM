/**
 * CALIBRATION du seuil de veto.
 *
 * L'instrument compte plus que le résultat : sans lui, `0.6` reste un pari. Ce que ces tests
 * protègent :
 *
 *  1. **L'asymétrie du coût.** Publier une mauvaise réponse coûte de la crédibilité, et c'est
 *     irréversible ; en rater une bonne coûte une occasion. Un score symétrique traiterait la
 *     réputation comme aussi remplaçable qu'une opportunité manquée.
 *  2. **Le refus des seuils absurdes.** Un seuil qui rejette 98 % obtient un excellent score
 *     — il ne publie jamais d'erreur — et rend le produit inutile.
 *  3. **La détection d'une notation dégénérée.** Le mode de défaillance le plus courant d'un
 *     juge LLM n'est pas de se tromper, c'est de tout noter entre 0,7 et 0,8. Aucun seuil ne
 *     rattrape ça, et un balayage donnerait quand même une recommandation d'apparence
 *     sérieuse.
 */
import { describe, expect, it } from 'vitest'
import {
  ACCEPTABLE_REJECTION_RANGE,
  calibrate,
  detectFlatScoring,
  evaluateThreshold,
  formatReport,
  type LabelledSample,
} from '@/swarm/calibration/calibrate'
import {
  MEMECOIN_LABELLED_SET,
  describeLabelledSet,
} from '@/swarm/calibration/labelled-set.memecoin'
import type { CriticScore } from '@/swarm/schemas/critic.io'

function score(overall: number, reputationRisk = 0.1): CriticScore {
  return {
    index: 0,
    voiceAuthenticity: 0.7,
    valueAdded: 0.7,
    reputationRisk,
    redundancy: 0.1,
    attentionCost: 0.2,
    overall,
    note: '',
  }
}

function sample(
  id: string,
  shouldPass: boolean,
  overall: number,
  risk = 0.1,
): LabelledSample {
  return {
    id,
    text: `texte ${id}`,
    shouldPass,
    score: score(overall, risk),
    rationale: 'test',
  }
}

/** Notation bien séparée : les bons notés haut, les mauvais bas. */
const SEPARATED: LabelledSample[] = [
  sample('g1', true, 0.85),
  sample('g2', true, 0.8),
  sample('g3', true, 0.75),
  sample('b1', false, 0.35),
  sample('b2', false, 0.3),
  sample('b3', false, 0.25),
  sample('b4', false, 0.2),
]

describe('evaluateThreshold', () => {
  it('compte correctement la matrice de confusion', () => {
    const outcome = evaluateThreshold(SEPARATED, 0.6)
    expect(outcome.truePositives).toBe(3)
    expect(outcome.falsePositives).toBe(0)
    expect(outcome.trueNegatives).toBe(4)
    expect(outcome.falseNegatives).toBe(0)
    expect(outcome.precision).toBe(1)
    expect(outcome.recall).toBe(1)
  })

  it('applique le plafond de risque réputationnel, comme en production', () => {
    // Calibrer sur une règle différente de celle appliquée ne mesurerait rien.
    const risky = [sample('r1', true, 0.95, 0.8)]
    const outcome = evaluateThreshold(risky, 0.5)
    expect(outcome.truePositives).toBe(0)
    expect(outcome.falseNegatives).toBe(1)
  })

  it('un seuil à 0 publie tout', () => {
    const outcome = evaluateThreshold(SEPARATED, 0)
    expect(outcome.falsePositives).toBe(4)
    expect(outcome.rejectionRate).toBe(0)
  })

  it('un seuil à 1 ne publie rien', () => {
    const outcome = evaluateThreshold(SEPARATED, 1)
    expect(outcome.rejectionRate).toBe(1)
    // Précision de 1 par convention : on n'a publié aucune erreur. Le taux de rejet
    // disqualifiera ce seuil, pas la précision.
    expect(outcome.precision).toBe(1)
    expect(outcome.recall).toBe(0)
  })

  it('gère un échantillon vide sans NaN', () => {
    const outcome = evaluateThreshold([], 0.6)
    for (const value of Object.values(outcome)) {
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})

describe('asymétrie du coût', () => {
  it('un faux positif pèse plus qu’un faux négatif', () => {
    // La propriété centrale : publier une mauvaise réponse est irréversible.
    const oneFalsePositive = [sample('g', true, 0.9), sample('b', false, 0.9)]
    const oneFalseNegative = [sample('g', true, 0.1), sample('b', false, 0.1)]

    const fp = evaluateThreshold(oneFalsePositive, 0.5)
    const fn = evaluateThreshold(oneFalseNegative, 0.5)

    expect(fp.falsePositives).toBe(1)
    expect(fn.falseNegatives).toBe(1)
    // Même nombre d'erreurs, mais le faux positif est plus lourdement pénalisé.
    expect(fp.weightedScore).toBeLessThan(fn.weightedScore)
  })
})

describe('calibrate', () => {
  it('trouve le seuil qui sépare une notation propre', () => {
    const report = calibrate(SEPARATED)
    expect(report.recommended.falsePositives).toBe(0)
    expect(report.recommended.falseNegatives).toBe(0)
    expect(report.recommended.threshold).toBeGreaterThan(0.35)
    expect(report.recommended.threshold).toBeLessThanOrEqual(0.75)
  })

  it('REFUSE un seuil qui rejette presque tout', () => {
    // Un seuil à 0,95 obtiendrait un score de sélection excellent — il ne publie jamais
    // d'erreur — et rendrait le produit inutile.
    const report = calibrate(SEPARATED)
    expect(report.recommended.rejectionRate).toBeLessThanOrEqual(
      ACCEPTABLE_REJECTION_RANGE.max,
    )
    expect(report.recommended.rejectionRate).toBeGreaterThanOrEqual(
      ACCEPTABLE_REJECTION_RANGE.min,
    )
  })

  it('signale quand aucun seuil ne donne un taux exploitable', () => {
    // Tout noter pareil : aucun seuil ne sépare, et le rapport doit le dire au lieu de
    // recommander un chiffre d'apparence sérieuse.
    const flat = Array.from({ length: 10 }, (_, i) => sample(`s${i}`, i < 5, 0.75))
    const report = calibrate(flat)
    expect(report.verdict).toContain('revoir le prompt du CRITIC')
  })

  it('avertit sur un échantillon trop petit', () => {
    // Un seuil calibré sur douze exemples est un seuil deviné avec plus de cérémonie.
    const report = calibrate(SEPARATED)
    expect(report.verdict).toContain('indicatif seulement')
  })

  it('n’avertit pas sur un échantillon suffisant', () => {
    const big = Array.from({ length: 40 }, (_, i) =>
      sample(`s${i}`, i < 14, i < 14 ? 0.8 : 0.3),
    )
    expect(calibrate(big).verdict).not.toContain('indicatif seulement')
  })

  it('signale les faux positifs subsistants', () => {
    // Autant de mauvaises réponses publiables : l'utilisateur doit le savoir.
    const overlapping = [
      sample('g1', true, 0.7),
      sample('g2', true, 0.65),
      sample('b1', false, 0.68),
      sample('b2', false, 0.3),
      sample('b3', false, 0.25),
    ]
    const report = calibrate(overlapping)
    if (report.recommended.falsePositives > 0) {
      expect(report.verdict).toContain('faux positif')
    }
  })

  it('à score égal, prend le MILIEU du plateau et non son bord', () => {
    /**
     * Décision révisée par la calibration réelle du 2026-08-26.
     *
     * La version d'origine prenait le seuil le plus sévère du plateau, en se disant qu'à égalité
     * de score, le plus strict est le plus prudent. La mesure a montré le défaut : le plateau
     * allait de 0,30 à 0,55 à score identique, et le seuil immédiatement suivant — 0,60 —
     * faisait tomber le rappel de 83 % à 17 %. Recommander le bord, c'était recommander un
     * seuil collé à une falaise, qu'une simple dérive de notation du modèle suffit à franchir.
     *
     * Le milieu du plateau a le même score mesuré et la plus grande marge des deux côtés.
     */
    const wideGap = [
      sample('g1', true, 0.9),
      sample('g2', true, 0.9),
      sample('b1', false, 0.1),
      sample('b2', false, 0.1),
      sample('b3', false, 0.1),
    ]
    const report = calibrate(wideGap)

    // Tous les seuils de 0,15 à 0,90 séparent parfaitement cet échantillon. Le milieu est
    // attendu autour de 0,5, et surtout : ni à 0,15 ni à 0,90.
    expect(report.recommended.threshold).toBeGreaterThan(0.3)
    expect(report.recommended.threshold).toBeLessThan(0.75)
  })

  it('avertit quand le seuil retenu effondre le rappel', () => {
    // Un rappel effondré sans faux positif ne veut pas dire « le CRITIC est bon » : il veut
    // dire « le seuil refuse tout ». C'est le mode de défaillance que D-11 prévoyait pour un
    // compte de projet, et il doit être nommé dans le verdict.
    const allLow = [
      sample('g1', true, 0.2),
      sample('g2', true, 0.25),
      sample('b1', false, 0.05),
      sample('b2', false, 0.05),
      sample('b3', false, 0.1),
      sample('b4', false, 0.1),
    ]
    const report = calibrate(allLow)
    if (report.recommended.recall < 0.5) {
      expect(report.verdict).toContain('rappel')
    }
  })

  it('conserve le défaut sur un échantillon vide, en le disant', () => {
    const report = calibrate([])
    expect(report.sampleSize).toBe(0)
    expect(report.verdict).toContain('non mesuré')
  })
})

describe('detectFlatScoring', () => {
  it('détecte une notation qui ne discrimine pas', () => {
    const flat = Array.from({ length: 10 }, (_, i) => sample(`s${i}`, i < 5, 0.75))
    const result = detectFlatScoring(flat)
    expect(result.isFlat).toBe(true)
    expect(result.detail).toContain('revoir le prompt du CRITIC')
  })

  it('détecte une notation étalée mais NON corrélée aux étiquettes', () => {
    // Cas plus subtil : les notes couvrent 0,1 à 0,9 mais sans rapport avec la qualité.
    // Une simple mesure d'étendue conclurait à tort que tout va bien.
    const uncorrelated = [
      sample('g1', true, 0.2),
      sample('g2', true, 0.8),
      sample('b1', false, 0.9),
      sample('b2', false, 0.1),
    ]
    const result = detectFlatScoring(uncorrelated)
    expect(result.spread).toBeGreaterThan(0.5)
    expect(result.isFlat).toBe(true)
    expect(result.separation).toBeLessThan(0.1)
  })

  it('valide une notation discriminante', () => {
    const result = detectFlatScoring(SEPARATED)
    expect(result.isFlat).toBe(false)
    expect(result.separation).toBeGreaterThan(0.4)
  })

  it('reste prudent sur un échantillon minuscule', () => {
    expect(detectFlatScoring([sample('a', true, 0.8)]).detail).toContain('trop petit')
  })
})

describe('jeu étiqueté memecoin', () => {
  it('est majoritairement composé de rejets', () => {
    // Un jeu majoritairement bon ferait paraître excellent un seuil laxiste : la calibration
    // mesurerait la facilité de l'échantillon, pas le discernement du CRITIC.
    const positives = MEMECOIN_LABELLED_SET.filter((s) => s.shouldPass).length
    expect(positives / MEMECOIN_LABELLED_SET.length).toBeLessThan(0.5)
  })

  it('couvre les quatre familles de défaut attendues', () => {
    const categories = new Set(MEMECOIN_LABELLED_SET.map((s) => s.category))
    for (const expected of [
      'accord-reformule',
      'registre-assistant',
      'signal-de-prix',
      'affirmation-non-sourcee',
    ]) {
      expect(categories, expected).toContain(expected)
    }
  })

  it('chaque étiquette porte sa justification', () => {
    // Une étiquette sans justification ne peut pas être contestée, seulement subie.
    for (const s of MEMECOIN_LABELLED_SET) {
      expect(s.rationale.length, s.id).toBeGreaterThan(30)
      expect(s.context.length, s.id).toBeGreaterThan(10)
    }
  })

  it('les identifiants sont uniques', () => {
    const ids = MEMECOIN_LABELLED_SET.map((s) => s.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('inclut le registre promotionnel du compte pilote comme rejet (D-11)', () => {
    // « maximum potential », « from microcap to legendary » : la voix native du compte doit
    // être rejetée même si c'est « son style ».
    const pilot = MEMECOIN_LABELLED_SET.find((s) => s.text.includes('maximum potential'))
    expect(pilot).toBeDefined()
    expect(pilot?.shouldPass).toBe(false)
  })

  it('se décrit lisiblement', () => {
    const description = describeLabelledSet()
    expect(description).toContain('à publier')
    expect(description).toContain('signal-de-prix')
  })
})

describe('formatReport', () => {
  it('produit un rapport lisible avec le tableau de seuils', () => {
    const report = calibrate(SEPARATED)
    const text = formatReport(report, detectFlatScoring(SEPARATED))
    expect(text).toContain('Seuil recommandé')
    expect(text).toContain('| seuil |')
    // L'asymétrie est expliquée dans le rapport, pas seulement appliquée dans le code.
    expect(text).toContain('irréversible')
  })
})
